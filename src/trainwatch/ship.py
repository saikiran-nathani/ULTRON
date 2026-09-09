"""Replicate local telemetry to a remote hub — ADR-0004 phase D, sending half.

ADR-0004 called for a fourth *sink*: something in the training loop that posts
metrics over the network. Implementing it, that is the wrong shape.

A sink would need its own spool to survive a network outage, which is a second
durable write path for rows the trainer already writes once. It would also put
a socket in the hot loop, where the failure mode is a stalled training step.

The trainer already writes every metric to a local SQLite file, and since
phase A that file is `synchronous=FULL`. **So the local store is the spool**,
and shipping is replication with a cursor: read rows above a watermark, post
them, advance the watermark. That gives four properties for free rather than as
features to build:

- **Store-and-forward** is the default. An outage is a cursor that stops
  moving; reconnecting catches up. Nothing the local store holds can be lost.
- **The training loop never waits on a socket.** Shipping happens on its own
  thread, reading a database, and can be stopped entirely without the trainer
  noticing.
- **A crash is survivable.** The cursor is on disk, so a later shipper -- even
  in a different process, days later -- resumes where this one stopped.
- **Replay is safe.** The cursor advances only after a batch is accepted, so a
  post whose response was lost gets sent again; the receiver's unique keys make
  that a no-op.

Zero third-party imports: `urllib.request` rather than `requests`. This module
is reachable from the training environment, which the zero-dependency test
exists to protect.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .store import connect, migrate

__all__ = ["ShipStats", "TelemetryShipper", "ship_once"]

log = logging.getLogger("trainwatch.ship")

# Rows per POST. Small enough that a failed batch is cheap to resend on a
# cellular link, large enough that a 6-hour run is not thousands of requests.
BATCH_ROWS = 2_000
POLL_INTERVAL = 5.0
TIMEOUT = 20.0

# Backoff on failure. Caps rather than growing without bound: an outage that
# lasts hours should still retry every couple of minutes, because the run it is
# following may be about to end.
BACKOFF_START = 2.0
BACKOFF_MAX = 120.0

_CURSORS = ("metrics", "gpu", "events")


@dataclass
class ShipStats:
    """What the shipper has done. Read from another thread; never mutated there."""

    batches: int = 0
    metrics: int = 0
    gpu: int = 0
    events: int = 0
    failures: int = 0
    last_error: str = ""
    last_success: float = 0.0
    backlog: dict[str, int] = field(default_factory=dict)

    @property
    def caught_up(self) -> bool:
        return not any(self.backlog.values())


def _cursor(db: Any, name: str) -> int:
    row = db.execute("SELECT last_rowid FROM ship_cursor WHERE name = ?", (name,)).fetchone()
    return int(row["last_rowid"]) if row else 0


def _advance(db: Any, name: str, rowid: int) -> None:
    db.execute(
        """INSERT INTO ship_cursor (name, last_rowid, updated) VALUES (?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET last_rowid = excluded.last_rowid,
                                          updated = excluded.updated""",
        (name, rowid, time.time()),
    )
    db.commit()


def _post(url: str, token: str, payload: dict[str, Any], *, timeout: float = TIMEOUT) -> None:
    """POST a batch, raising on anything that is not success.

    `X-Trainwatch` is required by ADR-0003 C3 on every write, including this
    one; omitting it is a 403 that looks like an auth problem.
    """
    body = json.dumps(payload).encode()
    request = urllib.request.Request(  # noqa: S310 - url comes from config, not input
        url.rstrip("/") + "/api/telemetry",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Trainwatch": "ship",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310
        if response.status not in (200, 201, 202):
            raise urllib.error.HTTPError(
                url, response.status, "unexpected status", response.headers, None
            )


def ship_once(
    db_path: str | Path,
    url: str,
    token: str,
    *,
    batch_rows: int = BATCH_ROWS,
    timeout: float = TIMEOUT,
) -> ShipStats:
    """Ship whatever is pending, once. Returns what moved.

    Separate from the thread so it can be called from a cron entry, from a
    test, or by hand after a run has already finished — catching up a backlog
    does not require the trainer to still be alive.
    """
    stats = ShipStats()
    db = connect(db_path)
    migrate(db)
    try:
        while True:
            batch, marks, counts = _collect(db, batch_rows)
            if batch is None:
                break
            _post(url, token, batch, timeout=timeout)
            # Only now: a batch whose response was lost must be resent, and the
            # receiver's unique keys make the duplicate a no-op. Advancing
            # first would silently drop rows on a timeout.
            for name, rowid in marks.items():
                _advance(db, name, rowid)
            stats.batches += 1
            stats.metrics += counts["metrics"]
            stats.gpu += counts["gpu"]
            stats.events += counts["events"]
            stats.last_success = time.time()
        stats.backlog = _backlog(db)
    finally:
        db.close()
    return stats


def _backlog(db: Any) -> dict[str, int]:
    out = {}
    for name in _CURSORS:
        row = db.execute(
            f"SELECT COUNT(*) AS n FROM {name} WHERE rowid > ?",  # noqa: S608 - fixed names
            (_cursor(db, name),),
        ).fetchone()
        out[name] = int(row["n"])
    return out


def _collect(
    db: Any, batch_rows: int
) -> tuple[dict[str, Any] | None, dict[str, int], dict[str, int]]:
    """Read one batch above the cursors. Returns (payload, new marks, counts).

    Metrics drive the batch: they are the volume, and a run's identity comes
    from them. gpu and events ride along, which keeps the request count down
    and means a quiet run still ships its GPU samples.
    """
    metric_cursor = _cursor(db, "metrics")
    rows = db.execute(
        """SELECT rowid, run_id, step, wall, key, value FROM metrics
            WHERE rowid > ? ORDER BY rowid LIMIT ?""",
        (metric_cursor, batch_rows),
    ).fetchall()

    gpu_cursor = _cursor(db, "gpu")
    gpu_rows = db.execute(
        "SELECT rowid, * FROM gpu WHERE rowid > ? ORDER BY rowid LIMIT ?",
        (gpu_cursor, batch_rows),
    ).fetchall()

    event_cursor = _cursor(db, "events")
    # `events.id` is INTEGER PRIMARY KEY, which in SQLite *is* the rowid
    # alias -- so `SELECT rowid, *` yields no column named "rowid" and
    # indexing one raises. Name it explicitly rather than relying on the
    # implicit column, which `gpu` (a plain rowid table) does have.
    event_rows = db.execute(
        """SELECT id AS rowid, run_id, ts, level, rule, title, body, step, notified
             FROM events WHERE id > ? ORDER BY id LIMIT ?""",
        (event_cursor, batch_rows),
    ).fetchall()

    if not rows and not gpu_rows and not event_rows:
        return None, {}, {}

    # Which run this batch belongs to. Metrics name it; failing that, fall back
    # to the latest run so a gpu-only batch still has somewhere to attach.
    run_id = rows[0]["run_id"] if rows else None
    if run_id is None:
        latest = db.execute(
            "SELECT id, name, meta FROM runs ORDER BY started_at DESC LIMIT 1"
        ).fetchone()
        if latest is None:
            # GPU samples with no run at all: nothing to attach them to, so
            # mark them shipped rather than retrying forever.
            marks = {}
            if gpu_rows:
                marks["gpu"] = int(gpu_rows[-1]["rowid"])
            if event_rows:
                marks["events"] = int(event_rows[-1]["rowid"])
            for name, rowid in marks.items():
                _advance(db, name, rowid)
            return None, {}, {}
        run_id = latest["id"]

    run = db.execute("SELECT id, name, meta FROM runs WHERE id = ?", (run_id,)).fetchone()
    payload: dict[str, Any] = {
        "run": {
            "id": run_id,
            "name": run["name"] if run else run_id,
            "meta": json.loads(run["meta"]) if run and run["meta"] else {},
        },
        "metrics": [[r["step"], r["wall"], r["key"], r["value"]] for r in rows],
        "gpu": [
            {k: g[k] for k in g.keys() if k != "rowid"}  # noqa: SIM118 - sqlite3.Row
            for g in gpu_rows
        ],
        "events": [
            {k: e[k] for k in e.keys() if k not in ("rowid", "id")}  # noqa: SIM118
            for e in event_rows
        ],
    }
    if rows:
        payload["last_step"] = max(int(r["step"]) for r in rows)

    marks = {}
    if rows:
        marks["metrics"] = int(rows[-1]["rowid"])
    if gpu_rows:
        marks["gpu"] = int(gpu_rows[-1]["rowid"])
    if event_rows:
        marks["events"] = int(event_rows[-1]["rowid"])
    counts = {"metrics": len(rows), "gpu": len(gpu_rows), "events": len(event_rows)}
    return payload, marks, counts


class TelemetryShipper:
    """Background replication. Start it once; it stops when told or on close."""

    def __init__(
        self,
        db_path: str | Path,
        url: str,
        token: str,
        *,
        interval: float = POLL_INTERVAL,
        batch_rows: int = BATCH_ROWS,
    ) -> None:
        self.db_path = Path(db_path)
        self.url = url
        self.token = token
        self.interval = interval
        self.batch_rows = batch_rows
        self.stats = ShipStats()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None:
            return
        # daemon=True on purpose: an unshipped backlog must not keep the
        # interpreter alive after training finishes. The cursor is on disk, so
        # the next run -- or `trainwatch ship --once` -- picks it up.
        self._thread = threading.Thread(target=self._loop, name="trainwatch-ship", daemon=True)
        self._thread.start()
        log.info("shipping telemetry to %s every %.0fs", self.url, self.interval)

    def stop(self, *, timeout: float = 10.0) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _loop(self) -> None:
        backoff = BACKOFF_START
        while not self._stop.is_set():
            try:
                moved = ship_once(
                    self.db_path, self.url, self.token, batch_rows=self.batch_rows
                )
                self.stats.batches += moved.batches
                self.stats.metrics += moved.metrics
                self.stats.gpu += moved.gpu
                self.stats.events += moved.events
                self.stats.backlog = moved.backlog
                if moved.batches:
                    self.stats.last_success = moved.last_success
                backoff = BACKOFF_START
                self.stats.last_error = ""
            except Exception as exc:  # noqa: BLE001 - shipping must never raise into training
                # Deliberately broad. This thread exists to make a run
                # observable; if it dies the run goes dark, which is the
                # failure it was built to prevent. Everything is retried,
                # because the cursor has not moved.
                self.stats.failures += 1
                self.stats.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("shipping failed (%s) — retrying in %.0fs", exc, backoff)
                self._stop.wait(backoff)
                backoff = min(backoff * 2, BACKOFF_MAX)
                continue
            self._stop.wait(self.interval)
