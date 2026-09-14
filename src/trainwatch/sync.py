"""Per-record sync: push, pull, and the four rules that make it correct.

Stage 3a of the one-interface plan. Records are opaque JSON keyed by
`(collection, record_id)` — this module never looks inside a body, which is
what lets the client's data model change without touching the server.

The design is settled by one number: **the whole dataset is ~38 KB.**
Bandwidth, storage and compute are free; the only scarce resource is
correctness. So nothing here is optimised, every version of every record is
kept forever, and a losing write is always recoverable.

The four rules
--------------
Each one is a silent data loss if broken, and none of them announce
themselves when they are.

1. **Diff against your own previous state, never against the server's.**
   Client-side, so not enforced here — but it shapes this API. `push` takes
   only what the client believes changed, and a client that compared itself to
   the server could not tell *deleted* from *never-seen* and would resurrect
   every deletion forever.

2. **`hlc` decides who wins; a server-assigned `seq` decides what you still
   need.** Two columns, two jobs, never interchangeable. `pull` filters on
   `seq`; conflicts resolve on `hlc`. Using the HLC as a cursor loses records
   written on slow-clocked devices permanently — see `hlc.py`.

3. **The push response returns the server's version of every rejected
   record.** Otherwise the loser clears its dirty flag believing it won,
   diverges permanently, and nothing in the system is capable of noticing:
   it is no longer a conflict, because only one party thinks there is
   anything to resolve.

4. **Never GC a tombstone above `min(last_pull_seq)` across non-retired
   devices** — and `retire()` exists because otherwise a replaced phone pins
   every tombstone forever.

What is deliberately NOT here
-----------------------------
Any merge cleverer than last-writer-wins on a whole record. Per-field merge
converges and is *wrong*: two devices editing one record offline produce a
result neither person entered, and it looks entirely normal. At this dataset
size, LWW plus a complete archive means a lost edit is one click from being
restored, which is a better trade than a merge nobody can audit.
"""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .hlc import MAX_DRIFT_MS, HLCError, now_ms, parse, wins
from .store import connect, migrate

__all__ = [
    "MAX_BATCH",
    "MAX_BODY_BYTES",
    "Change",
    "Device",
    "PushResult",
    "Rejection",
    "Sync",
    "SyncError",
]

# A record is a line in a personal dataset, not a file upload. 256 KB is ~6000x
# the average record here and still small enough that a runaway client cannot
# fill the disk before anyone notices.
MAX_BODY_BYTES = 256 * 1024

# One batch. Generous against a 38 KB dataset — the whole thing is a few
# hundred records — and it bounds the transaction so a pathological push
# cannot hold the write lock while the dashboard is trying to read.
MAX_BATCH = 2000

# Collections and ids come from a client and land in a primary key.
_MAX_NAME = 128


class SyncError(ValueError):
    """A malformed request. Never used for a rejected write — that is normal."""


@dataclass(frozen=True)
class Change:
    """One record version, as a client offers it."""

    collection: str
    record_id: str
    hlc: str
    deleted: bool = False
    body: Any = None

    @staticmethod
    def from_json(raw: Any) -> Change:
        if not isinstance(raw, dict):
            raise SyncError("each change must be an object")
        collection = _name(raw.get("collection"), "collection")
        record_id = _name(raw.get("id"), "id")
        hlc = raw.get("hlc")
        if not isinstance(hlc, str):
            # Explicit, rather than letting `parse` deal with it: a JSON body
            # can carry a number or null here, and the type checker is right
            # that this is the boundary where that stops being possible.
            raise SyncError(f"{collection}/{record_id}: hlc must be a string")
        try:
            parse(hlc)
        except HLCError as exc:
            raise SyncError(f"{collection}/{record_id}: {exc}") from exc
        deleted = bool(raw.get("deleted", False))
        body = raw.get("body")
        if deleted:
            # A tombstone with a body is ambiguous: is the record gone, or is
            # that its final state? Refuse rather than guess.
            if body not in (None, {}):
                raise SyncError(f"{collection}/{record_id}: a deleted change must have no body")
            body = None
        elif body is None:
            raise SyncError(f"{collection}/{record_id}: a live change needs a body")
        return Change(collection, record_id, hlc, deleted, body)


@dataclass(frozen=True)
class Rejection:
    """A pushed change that lost, together with the version that beat it.

    Rule 3. The `winner` is the entire point — a client told only "rejected"
    cannot converge, because it does not know what it lost to.
    """

    collection: str
    record_id: str
    winner: dict[str, Any]


@dataclass
class PushResult:
    accepted: list[str] = field(default_factory=list)
    rejected: list[Rejection] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {
            "accepted": self.accepted,
            "rejected": [
                {"collection": r.collection, "id": r.record_id, "winner": r.winner}
                for r in self.rejected
            ],
        }


@dataclass(frozen=True)
class Device:
    id: str
    name: str
    platform: str
    last_pull_seq: int
    first_seen: float
    last_seen: float
    retired_at: float | None

    def to_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "platform": self.platform,
            "last_pull_seq": self.last_pull_seq,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
            "retired": self.retired_at is not None,
        }


def _name(value: Any, what: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SyncError(f"{what} must be a non-empty string")
    if len(value) > _MAX_NAME:
        raise SyncError(f"{what} is longer than {_MAX_NAME} characters")
    if "\x00" in value:
        raise SyncError(f"{what} contains a null byte")
    return value


class Sync:
    """The record store, over the shared database."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._db = connect(self.path)
        # Same as Auth and Store: connect() sets the pragmas, the caller brings
        # the schema to head. Any of the three openers may reach a fresh file
        # first, so each migrates rather than assuming another already did.
        migrate(self._db)

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Sync:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── devices ──────────────────────────────────────────────────────────

    def register(
        self, owner_id: int, device_id: str, *, name: str = "", platform: str = ""
    ) -> Device:
        """Idempotent. Called on every sync, so it must be cheap and repeatable.

        Un-retires a device that comes back: a retired device that syncs again
        is a device in use, and leaving it retired would let its tombstones be
        collected out from under it.
        """
        device_id = _name(device_id, "device id")
        now = time.time()
        self._db.execute(
            """INSERT INTO sync_devices
                   (id, owner_id, name, platform, first_seen, last_seen)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT (owner_id, id) DO UPDATE SET
                   last_seen  = excluded.last_seen,
                   name       = CASE WHEN excluded.name != '' THEN excluded.name ELSE name END,
                   platform   = CASE WHEN excluded.platform != '' THEN excluded.platform ELSE platform END,
                   retired_at = NULL""",
            (device_id, owner_id, name[:_MAX_NAME], platform[:_MAX_NAME], now, now),
        )
        self._db.commit()
        got = self.device(owner_id, device_id)
        if got is None:  # pragma: no cover - the upsert above guarantees a row
            raise SyncError(f"device {device_id!r} vanished between insert and read")
        return got

    def device(self, owner_id: int, device_id: str) -> Device | None:
        row = self._db.execute(
            "SELECT * FROM sync_devices WHERE owner_id = ? AND id = ?",
            (owner_id, device_id),
        ).fetchone()
        return _device(row) if row else None

    def devices(self, owner_id: int, *, include_retired: bool = True) -> list[Device]:
        sql = "SELECT * FROM sync_devices WHERE owner_id = ?"
        if not include_retired:
            sql += " AND retired_at IS NULL"
        return [_device(r) for r in self._db.execute(sql + " ORDER BY first_seen", (owner_id,))]

    def retire(self, owner_id: int, device_id: str) -> bool:
        """Stop a device holding the tombstone-GC watermark down.

        Rule 4's other half. Without this, a phone replaced in 2027 has a
        `last_pull_seq` that never advances again, so `min()` across devices
        never advances, so no tombstone is ever collectable. The table grows
        forever because of a device that no longer exists.
        """
        cur = self._db.execute(
            "UPDATE sync_devices SET retired_at = ? WHERE owner_id = ? AND id = ? AND retired_at IS NULL",
            (time.time(), owner_id, device_id),
        )
        self._db.commit()
        return cur.rowcount > 0

    # ── the sequence ─────────────────────────────────────────────────────

    def _next_seq(self, owner_id: int, count: int) -> int:
        """Reserve `count` sequence numbers and return the first.

        A table rather than `MAX(seq) + 1` over `sync_records`. MAX() reuses a
        number once the row holding it is collected, and a reused `seq` is a
        record that silently skips every client whose cursor is already past
        it — which is rule 2's failure mode arriving by a different door.
        """
        self._db.execute(
            "INSERT INTO sync_seq (owner_id, next_seq) VALUES (?, 1) ON CONFLICT DO NOTHING",
            (owner_id,),
        )
        row = self._db.execute(
            "UPDATE sync_seq SET next_seq = next_seq + ? WHERE owner_id = ? RETURNING next_seq",
            (count, owner_id),
        ).fetchone()
        return int(row["next_seq"]) - count

    def head(self, owner_id: int) -> int:
        """The highest assigned `seq`. A fresh owner is 0."""
        row = self._db.execute(
            "SELECT next_seq FROM sync_seq WHERE owner_id = ?", (owner_id,)
        ).fetchone()
        return int(row["next_seq"]) - 1 if row else 0

    # ── push ─────────────────────────────────────────────────────────────

    def push(self, owner_id: int, device_id: str, changes: list[Change]) -> PushResult:
        """Apply a batch, resolving each record by HLC. One transaction.

        Atomic per batch on purpose: a partially-applied push leaves the client
        unable to tell which half landed, and its next diff would be computed
        against a state neither side agrees on.
        """
        if len(changes) > MAX_BATCH:
            raise SyncError(f"batch of {len(changes)} exceeds the {MAX_BATCH} limit")

        # Reject implausible clocks before touching anything. See MAX_DRIFT_MS:
        # one device with a wildly wrong clock would otherwise win every future
        # conflict, permanently, with no recovery but a hand-edited database.
        wall = now_ms()
        for ch in changes:
            millis, _, _ = parse(ch.hlc)
            if millis > wall + MAX_DRIFT_MS:
                raise SyncError(
                    f"{ch.collection}/{ch.record_id}: clock is "
                    f"{(millis - wall) / 1000:.0f}s ahead of the server, past the "
                    f"{MAX_DRIFT_MS / 1000:.0f}s ceiling"
                )
            if ch.body is not None:
                encoded = json.dumps(ch.body, separators=(",", ":"))
                if len(encoded.encode()) > MAX_BODY_BYTES:
                    raise SyncError(
                        f"{ch.collection}/{ch.record_id}: body exceeds {MAX_BODY_BYTES} bytes"
                    )

        # A single client may legitimately send two versions of one record in
        # one batch (edited twice while offline). Resolve locally first so the
        # batch cannot fight itself and burn two sequence numbers on one row.
        latest: dict[tuple[str, str], Change] = {}
        for ch in changes:
            key = (ch.collection, ch.record_id)
            prev = latest.get(key)
            if prev is None or wins(ch.hlc, prev.hlc):
                latest[key] = ch

        result = PushResult()
        now = time.time()

        try:
            self._db.execute("BEGIN IMMEDIATE")
            incumbents = {
                (r["collection"], r["record_id"]): r
                for r in self._db.execute(
                    "SELECT * FROM sync_records WHERE owner_id = ?", (owner_id,)
                )
                if (r["collection"], r["record_id"]) in latest
            }

            # Three outcomes, not two. The middle one matters:
            #
            #   hlc >  incumbent  → write it
            #   hlc == incumbent  → already durable: a replay by this same
            #                       writer. No write, no log entry, but report
            #                       it accepted so the client clears its dirty
            #                       flag and stops retrying.
            #   hlc <  incumbent  → rejected, with the winner (rule 3)
            #
            # An HLC carries its node id, so two devices cannot mint the same
            # one — an identical HLC on a record is therefore always the same
            # writer pushing again, which is the normal outcome of a lost
            # response rather than a conflict.
            #
            # Calling that "rejected" would be worse than noisy: it writes a
            # `rejected` row into the archive, and the archive is what tells
            # the user "your edit was replaced by another device". It would be
            # reporting an overwrite that never happened.
            winners, replays = [], []
            for key, ch in latest.items():
                incumbent = incumbents.get(key)
                if incumbent is None or wins(ch.hlc, incumbent["hlc"]):
                    winners.append(ch)
                elif ch.hlc == incumbent["hlc"]:
                    replays.append(ch)
            base = self._next_seq(owner_id, len(winners)) if winners else 0

            for offset, ch in enumerate(winners):
                seq = base + offset
                body = None if ch.deleted else json.dumps(ch.body, separators=(",", ":"))
                self._db.execute(
                    """INSERT INTO sync_records
                           (owner_id, collection, record_id, seq, hlc, deleted, body, device_id, updated)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                       ON CONFLICT (owner_id, collection, record_id) DO UPDATE SET
                           seq = excluded.seq, hlc = excluded.hlc,
                           deleted = excluded.deleted, body = excluded.body,
                           device_id = excluded.device_id, updated = excluded.updated""",
                    (
                        owner_id, ch.collection, ch.record_id, seq, ch.hlc,
                        int(ch.deleted), body, device_id, now,
                    ),
                )
                self._log(owner_id, ch, device_id, "accepted", now)
                result.accepted.append(f"{ch.collection}/{ch.record_id}")

            for ch in replays:
                result.accepted.append(f"{ch.collection}/{ch.record_id}")

            for key, ch in latest.items():
                incumbent = incumbents.get(key)
                if incumbent is not None and ch.hlc != incumbent["hlc"] and not wins(
                    ch.hlc, incumbent["hlc"]
                ):
                    # Rule 3: hand back the version that beat it, not just the
                    # fact that it lost. And archive the loser — rule 3's
                    # companion, and what makes "view / restore" possible.
                    self._log(owner_id, ch, device_id, "rejected", now)
                    result.rejected.append(
                        Rejection(ch.collection, ch.record_id, _row_to_json(incumbents[key]))
                    )

            if changes:
                self._db.execute(
                    "UPDATE sync_devices SET last_push_hlc = ?, last_seen = ? WHERE owner_id = ? AND id = ?",
                    (max(c.hlc for c in changes), now, owner_id, device_id),
                )
            self._db.commit()
        except Exception:
            self._db.rollback()
            raise

        return result

    def _log(self, owner_id: int, ch: Change, device_id: str, outcome: str, ts: float) -> None:
        self._db.execute(
            """INSERT INTO sync_log
                   (owner_id, collection, record_id, hlc, deleted, body, device_id, outcome, ts)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                owner_id, ch.collection, ch.record_id, ch.hlc, int(ch.deleted),
                None if ch.body is None else json.dumps(ch.body, separators=(",", ":")),
                device_id, outcome, ts,
            ),
        )

    # ── pull ─────────────────────────────────────────────────────────────

    def pull(
        self, owner_id: int, device_id: str, since_seq: int, *, limit: int = MAX_BATCH
    ) -> dict[str, Any]:
        """Everything above the cursor, in `seq` order.

        `seq`, never `hlc` — rule 2. Tombstones are included: a delete is a
        record to deliver, not an absence, and a client that only received
        live records could never learn that something was removed.

        `since_seq` comes from the CLIENT, and recording it as the device's
        `last_pull_seq` is how the server learns what that device definitely
        has. That direction matters: if the server advanced the cursor when it
        *sent* a batch, a response lost in transit would mark data as
        delivered that the client never received — and since this value gates
        tombstone GC, it would eventually collect a tombstone the client still
        needs.
        """
        if since_seq < 0:
            raise SyncError("since_seq cannot be negative")
        limit = max(1, min(int(limit), MAX_BATCH))

        rows = self._db.execute(
            """SELECT * FROM sync_records
                WHERE owner_id = ? AND seq > ?
                ORDER BY seq LIMIT ?""",
            (owner_id, since_seq, limit),
        ).fetchall()

        # Conservative: only what the client has proven it holds.
        self._db.execute(
            """UPDATE sync_devices SET last_pull_seq = MAX(last_pull_seq, ?), last_seen = ?
                WHERE owner_id = ? AND id = ?""",
            (since_seq, time.time(), owner_id, device_id),
        )
        self._db.commit()

        head = self.head(owner_id)
        cursor = rows[-1]["seq"] if rows else since_seq
        return {
            "records": [_row_to_json(r) for r in rows],
            "cursor": cursor,
            # The client keeps asking while this is true. Explicit, rather than
            # inferred from `len(records) == limit` — which is wrong exactly
            # when the last page happens to be full.
            "more": cursor < head,
            "head": head,
        }

    def sync(
        self,
        owner_id: int,
        device_id: str,
        *,
        changes: list[Change],
        since_seq: int,
        limit: int = MAX_BATCH,
    ) -> dict[str, Any]:
        """Push then pull, in one round trip.

        This order is not arbitrary. Pushing first means the pull reflects our
        own writes, so the client converges in one exchange instead of
        discovering its own changes on the next one. On a phone that syncs only
        in the foreground, one round trip versus two is the difference between
        converging and not.
        """
        pushed = self.push(owner_id, device_id, changes)
        pulled = self.pull(owner_id, device_id, since_seq, limit=limit)
        return {**pushed.to_json(), **pulled}

    # ── the archive ──────────────────────────────────────────────────────

    def history(
        self, owner_id: int, collection: str, record_id: str, *, limit: int = 50
    ) -> list[dict[str, Any]]:
        """Every version of one record, newest first, winners and losers.

        What makes "finance was replaced by MacBook-Pro at 14:02 — view /
        restore" answerable, and what makes it safe to live on slice-level
        granularity while 3b is still being built.
        """
        rows = self._db.execute(
            """SELECT * FROM sync_log
                WHERE owner_id = ? AND collection = ? AND record_id = ?
                ORDER BY id DESC LIMIT ?""",
            (owner_id, collection, record_id, max(1, int(limit))),
        )
        return [
            {
                "hlc": r["hlc"],
                "deleted": bool(r["deleted"]),
                "body": json.loads(r["body"]) if r["body"] else None,
                "device_id": r["device_id"],
                "outcome": r["outcome"],
                "ts": r["ts"],
            }
            for r in rows
        ]

    # ── tombstones ───────────────────────────────────────────────────────

    def gc_watermark(self, owner_id: int) -> int:
        """The highest `seq` below which a tombstone is safe to drop.

        `min(last_pull_seq)` across NON-RETIRED devices. Rule 4.

        Zero when any active device has never pulled: it holds records it has
        not reconciled, so nothing is collectable yet. Returning `head` in that
        case — the tempting simplification — would collect tombstones that
        device still needs and silently resurrect its deletions.
        """
        row = self._db.execute(
            """SELECT MIN(last_pull_seq) AS low, COUNT(*) AS n
                 FROM sync_devices WHERE owner_id = ? AND retired_at IS NULL""",
            (owner_id,),
        ).fetchone()
        if not row or not row["n"]:
            # No active devices: nothing can be waiting for a tombstone.
            return self.head(owner_id)
        return int(row["low"])

    def gc_tombstones(self, owner_id: int) -> int:
        """Drop tombstones every active device has already seen.

        The `sync_log` entry is kept regardless — the archive is append-only,
        and at this dataset size there is no reason to ever discard history.
        Only the live row goes.
        """
        watermark = self.gc_watermark(owner_id)
        cur = self._db.execute(
            "DELETE FROM sync_records WHERE owner_id = ? AND deleted = 1 AND seq <= ?",
            (owner_id, watermark),
        )
        self._db.commit()
        return cur.rowcount

    # ── introspection ────────────────────────────────────────────────────

    def snapshot(self, owner_id: int) -> dict[str, dict[str, Any]]:
        """Every live record, grouped by collection. For tests and debugging."""
        out: dict[str, dict[str, Any]] = {}
        for r in self._db.execute(
            "SELECT * FROM sync_records WHERE owner_id = ? AND deleted = 0 ORDER BY collection, record_id",
            (owner_id,),
        ):
            out.setdefault(r["collection"], {})[r["record_id"]] = json.loads(r["body"])
        return out

    def stats(self, owner_id: int) -> dict[str, Any]:
        live, tombs = self._db.execute(
            """SELECT COALESCE(SUM(deleted = 0), 0), COALESCE(SUM(deleted = 1), 0)
                 FROM sync_records WHERE owner_id = ?""",
            (owner_id,),
        ).fetchone()
        versions = self._db.execute(
            "SELECT COUNT(*) FROM sync_log WHERE owner_id = ?", (owner_id,)
        ).fetchone()[0]
        return {
            "records": int(live),
            "tombstones": int(tombs),
            "versions": int(versions),
            "head": self.head(owner_id),
            "devices": len(self.devices(owner_id, include_retired=False)),
            "gc_watermark": self.gc_watermark(owner_id),
        }


def _device(row: sqlite3.Row) -> Device:
    return Device(
        id=row["id"],
        name=row["name"],
        platform=row["platform"],
        last_pull_seq=int(row["last_pull_seq"]),
        first_seen=float(row["first_seen"]),
        last_seen=float(row["last_seen"]),
        retired_at=row["retired_at"],
    )


def _row_to_json(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "collection": row["collection"],
        "id": row["record_id"],
        "seq": int(row["seq"]),
        "hlc": row["hlc"],
        "deleted": bool(row["deleted"]),
        "body": json.loads(row["body"]) if row["body"] else None,
        "device_id": row["device_id"],
    }
