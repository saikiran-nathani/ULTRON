"""The device hub — shared clipboard, file drop, pushed links, notes, presence.

This is the half of the system that makes the Asus a first-class member of an
otherwise Apple-only ecosystem. Universal Clipboard and AirDrop cover
Mac<->iPad<->iPhone already and cover them better (they are OS-level, with no
page to open); what neither can do is include a Linux box. So the design centre
of gravity is the Linux<->Apple leg, plus the two things Apple gives you no
answer for at all: **history** and **durability**.

Storage lives in the same SQLite file as the training telemetry (ADR-0001's
"one file, WAL, no daemon"), but in its own tables behind its own class, because
"what my GPU is doing" and "what I last copied" are unrelated concerns that
merely share a disk.

Security-relevant behaviour is concentrated here on purpose — see ADR-0003:
  * `secret` entries are redacted on the way out, excluded from search, and
    never written to a log line.
  * everything expires; pinning is the only way to opt out.
  * bodies are never logged, at any level.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

__all__ = ["REDACTED", "ClipKind", "Hub", "looks_secret"]

log = logging.getLogger("trainwatch.hub")

ClipKind = Literal["text", "link"]

REDACTED = "•" * 12  # bullets; never the real body

# Defaults, all overridable per call.
CLIP_TTL = 7 * 86400.0
FILE_TTL = 7 * 86400.0
SECRET_TTL = 900.0  # 15 min — a secret you have not used is a secret you do not need
MAX_CLIP_BYTES = 1_000_000  # 1 MB of text is a generous paste
PREVIEW_CHARS = 220

SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         REAL    NOT NULL,
    kind       TEXT    NOT NULL DEFAULT 'text',
    body       TEXT    NOT NULL,
    preview    TEXT    NOT NULL DEFAULT '',
    bytes      INTEGER NOT NULL DEFAULT 0,
    device     TEXT    NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    secret     INTEGER NOT NULL DEFAULT 0,
    digest     TEXT    NOT NULL DEFAULT '',
    expires_at REAL
);
CREATE INDEX IF NOT EXISTS idx_clips_ts ON clips (ts DESC);
CREATE INDEX IF NOT EXISTS idx_clips_digest ON clips (digest);

CREATE TABLE IF NOT EXISTS files (
    id         TEXT    PRIMARY KEY,
    ts         REAL    NOT NULL,
    name       TEXT    NOT NULL,
    size       INTEGER NOT NULL DEFAULT 0,
    mime       TEXT    NOT NULL DEFAULT 'application/octet-stream',
    device     TEXT    NOT NULL DEFAULT '',
    pinned     INTEGER NOT NULL DEFAULT 0,
    expires_at REAL
);
CREATE INDEX IF NOT EXISTS idx_files_ts ON files (ts DESC);

CREATE TABLE IF NOT EXISTS links (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    ts        REAL    NOT NULL,
    url       TEXT    NOT NULL,
    title     TEXT    NOT NULL DEFAULT '',
    target    TEXT    NOT NULL DEFAULT '',
    device    TEXT    NOT NULL DEFAULT '',
    opened_at REAL
);
CREATE INDEX IF NOT EXISTS idx_links_ts ON links (ts DESC);

CREATE TABLE IF NOT EXISTS notes (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL DEFAULT '',
    body       TEXT NOT NULL DEFAULT '',
    updated_at REAL NOT NULL,
    device     TEXT NOT NULL DEFAULT ''
);

-- A single monotonic counter bumped on every write. The SSE stream reads
-- this (one indexed row) and only ships a payload when it actually changed,
-- so an idle dashboard on cellular costs a few bytes a second instead of
-- re-sending the whole clipboard list on a timer.
CREATE TABLE IF NOT EXISTS hub_meta (
    key   TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO hub_meta (key, value) VALUES ('revision', 0);

CREATE TABLE IF NOT EXISTS devices (
    name       TEXT PRIMARY KEY,
    kind       TEXT NOT NULL DEFAULT 'unknown',
    last_seen  REAL NOT NULL,
    user_agent TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT ''
);
"""

# Heuristics for "this looks like a credential". Used only to *suggest* the
# secret flag in the UI — never to silently change behaviour, because a wrong
# guess either way is worse than asking.
_SECRET_PATTERNS = (
    re.compile(r"\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}"),  # provider keys
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{20,}"),  # GitHub tokens
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),  # AWS key id
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}"),  # Slack
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),  # PEM
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),  # JWT
    # No leading \b: an env-var name like WANDB_API_KEY has a word character
    # before "API", so a boundary assertion there never fires.
    re.compile(r"(?i)[\w.-]*(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*\S{8,}"),
    re.compile(r"(?i)\btskey-[A-Za-z0-9-]{10,}"),  # Tailscale auth key
    # This project's own ntfy topic. A public ntfy topic is readable by anyone
    # who knows the string, so it is a credential even though it looks like a
    # name. Matched by shape, not keyword, so it cannot fire on prose.
    re.compile(r"\btrainwatch-[A-Za-z0-9_-]{16,}"),
)


def looks_secret(text: str) -> bool:
    """True when the text pattern-matches a credential. Advisory only."""
    head = text[:4000]
    return any(p.search(head) for p in _SECRET_PATTERNS)


@dataclass(frozen=True, slots=True)
class Device:
    name: str
    kind: str
    last_seen: float


class Hub:
    """Shared-state store for the device hub. One connection per thread."""

    def __init__(self, db_path: str | Path, blob_dir: str | Path | None = None) -> None:
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.blob_dir = Path(blob_dir) if blob_dir else self.path.parent / "blobs"
        self.blob_dir.mkdir(parents=True, exist_ok=True)

        self._db = sqlite3.connect(self.path, timeout=15.0, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA journal_mode=WAL")
        # ADR-0004: notes and pinned clips are durable state now, not scratch.
        self._db.execute("PRAGMA synchronous=FULL")
        # Per-connection, and off by default. HubPool builds one Hub per worker
        # thread, so this is the right place for it.
        self._db.execute("PRAGMA foreign_keys=ON")
        self._db.execute("PRAGMA busy_timeout=15000")
        self._db.executescript(SCHEMA)
        self._db.commit()

    def close(self) -> None:
        self._db.close()

    def _commit(self, *, bump: bool = True) -> None:
        """Commit, bumping the change counter unless told not to.

        `bump=False` exists for writes that are not *content* changes — chiefly
        presence pings. Every GET of the snapshot records a last_seen, so if
        those bumped the revision then each device's poll would push a full
        snapshot to every other device, and the counter would be doing the
        opposite of its job.
        """
        if bump:
            self._db.execute("UPDATE hub_meta SET value = value + 1 WHERE key = 'revision'")
        self._db.commit()

    def revision(self) -> int:
        """Cheap monotonic change token. Lets the stream avoid pointless pushes."""
        row = self._db.execute("SELECT value FROM hub_meta WHERE key = 'revision'").fetchone()
        return int(row[0]) if row else 0

    def __enter__(self) -> Hub:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── clipboard ────────────────────────────────────────────────────────

    def add_clip(
        self,
        body: str,
        *,
        kind: ClipKind = "text",
        device: str = "",
        secret: bool = False,
        pinned: bool = False,
        ttl: float | None = None,
    ) -> dict[str, Any]:
        """Store a clip. Re-copying the most recent clip is a no-op, not a dupe."""
        if not body:
            raise ValueError("empty clip")
        if len(body.encode("utf-8")) > MAX_CLIP_BYTES:
            raise ValueError(f"clip exceeds {MAX_CLIP_BYTES} bytes")

        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()[:32]

        # Copying the same thing twice (very common — you re-copy to be sure)
        # should refresh the existing entry rather than fill the history with
        # identical rows.
        existing = self._db.execute("SELECT * FROM clips ORDER BY ts DESC LIMIT 1").fetchone()
        if existing is not None and existing["digest"] == digest:
            self._db.execute(
                "UPDATE clips SET ts = ?, device = ?, expires_at = ? WHERE id = ?",
                (
                    time.time(),
                    device or existing["device"],
                    self._expiry(secret, pinned, ttl),
                    existing["id"],
                ),
            )
            self._commit()
            return self._clip_row(
                self._db.execute("SELECT * FROM clips WHERE id = ?", (existing["id"],)).fetchone()
            )

        now = time.time()
        cur = self._db.execute(
            """INSERT INTO clips (ts, kind, body, preview, bytes, device, pinned, secret, digest, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                now,
                kind,
                body,
                "" if secret else body[:PREVIEW_CHARS],
                len(body.encode("utf-8")),
                device,
                int(pinned),
                int(secret),
                digest,
                self._expiry(secret, pinned, ttl),
            ),
        )
        self._commit()
        # Note the absence of the body in this log line. Deliberate.
        log.info(
            "clip stored id=%s bytes=%d secret=%s from=%s",
            cur.lastrowid,
            len(body),
            secret,
            device or "?",
        )
        return self._clip_row(
            self._db.execute("SELECT * FROM clips WHERE id = ?", (cur.lastrowid,)).fetchone()
        )

    @staticmethod
    def _expiry(secret: bool, pinned: bool, ttl: float | None) -> float | None:
        if pinned:
            return None  # pinning is the only way to opt out of expiry
        if ttl is not None:
            return time.time() + ttl
        return time.time() + (SECRET_TTL if secret else CLIP_TTL)

    def clips(self, *, limit: int = 100, query: str = "") -> list[dict[str, Any]]:
        """Recent clips, newest first, pinned always included."""
        now = time.time()
        if query:
            # Secrets are excluded from search: matching on a redacted entry
            # would leak its contents one character at a time.
            cur = self._db.execute(
                """SELECT * FROM clips
                   WHERE secret = 0 AND body LIKE ? ESCAPE '\\'
                     AND (expires_at IS NULL OR expires_at > ?)
                   ORDER BY pinned DESC, ts DESC LIMIT ?""",
                (f"%{_escape_like(query)}%", now, limit),
            )
        else:
            cur = self._db.execute(
                """SELECT * FROM clips
                   WHERE expires_at IS NULL OR expires_at > ?
                   ORDER BY pinned DESC, ts DESC LIMIT ?""",
                (now, limit),
            )
        return [self._clip_row(r) for r in cur.fetchall()]

    def clip_body(self, clip_id: int) -> str | None:
        """The full body, including for secrets. The only path that returns one."""
        row = self._db.execute(
            "SELECT body, expires_at FROM clips WHERE id = ?", (clip_id,)
        ).fetchone()
        if row is None:
            return None
        if row["expires_at"] is not None and row["expires_at"] <= time.time():
            return None
        return str(row["body"])

    def latest_clip(self) -> dict[str, Any] | None:
        rows = self.clips(limit=1)
        return rows[0] if rows else None

    def pin_clip(self, clip_id: int, pinned: bool) -> bool:
        cur = self._db.execute(
            "UPDATE clips SET pinned = ?, expires_at = ? WHERE id = ?",
            (int(pinned), None if pinned else time.time() + CLIP_TTL, clip_id),
        )
        self._commit()
        return (cur.rowcount or 0) > 0

    def delete_clip(self, clip_id: int) -> bool:
        cur = self._db.execute("DELETE FROM clips WHERE id = ?", (clip_id,))
        self._commit()
        return (cur.rowcount or 0) > 0

    def clear_clips(self, *, keep_pinned: bool = True) -> int:
        # Two literal statements rather than a concatenation — nothing to
        # reason about, and it keeps the query strings greppable.
        cur = self._db.execute(
            "DELETE FROM clips WHERE pinned = 0" if keep_pinned else "DELETE FROM clips"
        )
        self._commit()
        return cur.rowcount or 0

    @staticmethod
    def _clip_row(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        is_secret = bool(d.pop("secret", 0))
        # The body never leaves this method for a secret entry. Callers that
        # genuinely need it must go through clip_body() with an explicit id.
        d["secret"] = is_secret
        d["pinned"] = bool(d["pinned"])
        d["body"] = REDACTED if is_secret else d["body"]
        d["preview"] = REDACTED if is_secret else d["preview"]
        d.pop("digest", None)
        return d

    # ── files ────────────────────────────────────────────────────────────

    def new_blob_id(self) -> str:
        """Reserve an on-disk name. Generated, never the client's — no path
        traversal surface, no '..' handling to get wrong, no collisions."""
        return secrets.token_urlsafe(16)

    def blob_target(self, file_id: str) -> Path:
        """Where a reserved id lives on disk, for streaming a body into."""
        return self.blob_dir / file_id

    def register_file(
        self,
        file_id: str,
        name: str,
        size: int,
        *,
        mime: str = "",
        device: str = "",
        ttl: float | None = None,
    ) -> dict[str, Any]:
        """Record a blob already written to disk by `blob_target(file_id)`.

        Split out from add_file so an upload can stream straight to disk
        instead of being held in memory: the route used to accumulate every
        chunk in a list and then b"".join() it, so a 64 MB cap meant a 128 MB
        peak per concurrent upload on a box that is also training.
        """
        return self._insert_file(file_id, name, size, mime=mime, device=device, ttl=ttl)

    def add_file(
        self, name: str, data: bytes, *, mime: str = "", device: str = "", ttl: float | None = None
    ) -> dict[str, Any]:
        """Persist a blob from bytes already in memory.

        Retained for the CLI and tests, where the payload is small and already
        materialised. The server route streams instead — see register_file.
        """
        file_id = self.new_blob_id()
        self.blob_target(file_id).write_bytes(data)
        return self._insert_file(file_id, name, len(data), mime=mime, device=device, ttl=ttl)

    def _insert_file(
        self,
        file_id: str,
        name: str,
        size: int,
        *,
        mime: str = "",
        device: str = "",
        ttl: float | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        self._db.execute(
            """INSERT INTO files (id, ts, name, size, mime, device, expires_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (
                file_id,
                now,
                _safe_display_name(name),
                size,
                mime or "application/octet-stream",
                device,
                None if ttl == 0 else now + (ttl if ttl else FILE_TTL),
            ),
        )
        self._commit()
        log.info("file stored id=%s bytes=%d from=%s", file_id, size, device or "?")
        # Read the row we just inserted directly, not via file(), which filters
        # on expiry — otherwise creating something with a short TTL hands the
        # caller back an empty dict and no way to reference it.
        row = self._db.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        return self._file_row(row)

    def files(self, *, limit: int = 100) -> list[dict[str, Any]]:
        cur = self._db.execute(
            """SELECT * FROM files WHERE expires_at IS NULL OR expires_at > ?
               ORDER BY pinned DESC, ts DESC LIMIT ?""",
            (time.time(), limit),
        )
        return [self._file_row(r) for r in cur.fetchall()]

    def file(self, file_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM files WHERE id = ?", (file_id,)).fetchone()
        if row is None:
            return None
        if row["expires_at"] is not None and row["expires_at"] <= time.time():
            return None
        return self._file_row(row)

    def file_path(self, file_id: str) -> Path | None:
        """Resolved on-disk path, or None. Guards against a crafted id."""
        meta = self.file(file_id)
        if meta is None:
            return None
        p = (self.blob_dir / file_id).resolve()
        # Defence in depth: ids are generated, but never trust that at the
        # filesystem boundary.
        if not p.is_file() or self.blob_dir.resolve() not in p.parents:
            return None
        return p

    def delete_file(self, file_id: str) -> bool:
        # Resolve through file_path() rather than joining the id onto blob_dir
        # directly. The route regex already refuses a slash so this is not
        # currently reachable, but an unlink() that skips the containment check
        # two functions above is exactly the inconsistency that becomes a bug
        # the first time this is called from somewhere else.
        p = self.file_path(file_id)
        cur = self._db.execute("DELETE FROM files WHERE id = ?", (file_id,))
        self._commit()
        if p is not None:
            p.unlink(missing_ok=True)
        return (cur.rowcount or 0) > 0

    def pin_file(self, file_id: str, pinned: bool) -> bool:
        cur = self._db.execute(
            "UPDATE files SET pinned = ?, expires_at = ? WHERE id = ?",
            (int(pinned), None if pinned else time.time() + FILE_TTL, file_id),
        )
        self._commit()
        return (cur.rowcount or 0) > 0

    @staticmethod
    def _file_row(row: sqlite3.Row) -> dict[str, Any]:
        d = dict(row)
        d["pinned"] = bool(d["pinned"])
        d["is_image"] = str(d.get("mime", "")).startswith("image/")
        return d

    # ── links ────────────────────────────────────────────────────────────

    def add_link(
        self, url: str, *, title: str = "", target: str = "", device: str = ""
    ) -> dict[str, Any]:
        if not _is_web_url(url):
            raise ValueError("only http(s) URLs can be pushed")
        cur = self._db.execute(
            "INSERT INTO links (ts, url, title, target, device) VALUES (?, ?, ?, ?, ?)",
            (time.time(), url, title, target, device),
        )
        self._commit()
        return dict(
            self._db.execute("SELECT * FROM links WHERE id = ?", (cur.lastrowid,)).fetchone()
        )

    def links(
        self, *, limit: int = 60, unread_only: bool = False, device: str = ""
    ) -> list[dict[str, Any]]:
        sql = "SELECT * FROM links WHERE 1=1"
        args: list[Any] = []
        if unread_only:
            sql += " AND opened_at IS NULL"
        if device:
            # A link is for you if it names you, or names nobody (broadcast).
            sql += " AND (target = '' OR target = ?)"
            args.append(device)
        sql += " ORDER BY ts DESC LIMIT ?"
        args.append(limit)
        # Only fixed literal fragments are concatenated above; every value the
        # caller supplied is bound as a parameter in `args`.
        return [dict(r) for r in self._db.execute(sql, args).fetchall()]

    def mark_link_opened(self, link_id: int) -> bool:
        cur = self._db.execute(
            "UPDATE links SET opened_at = ? WHERE id = ? AND opened_at IS NULL",
            (time.time(), link_id),
        )
        self._commit()
        return (cur.rowcount or 0) > 0

    def delete_link(self, link_id: int) -> bool:
        cur = self._db.execute("DELETE FROM links WHERE id = ?", (link_id,))
        self._commit()
        return (cur.rowcount or 0) > 0

    # ── notes ────────────────────────────────────────────────────────────

    def put_note(
        self, note_id: str, *, title: str = "", body: str = "", device: str = ""
    ) -> dict[str, Any]:
        slug = _slug(note_id)
        self._db.execute(
            """INSERT INTO notes (id, title, body, updated_at, device) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                 title=excluded.title, body=excluded.body,
                 updated_at=excluded.updated_at, device=excluded.device""",
            (slug, title, body, time.time(), device),
        )
        self._commit()
        return self.note(slug) or {}

    def note(self, note_id: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM notes WHERE id = ?", (_slug(note_id),)).fetchone()
        return dict(row) if row else None

    def notes(self) -> list[dict[str, Any]]:
        cur = self._db.execute("SELECT * FROM notes ORDER BY updated_at DESC")
        return [dict(r) for r in cur.fetchall()]

    def delete_note(self, note_id: str) -> bool:
        cur = self._db.execute("DELETE FROM notes WHERE id = ?", (_slug(note_id),))
        self._commit()
        return (cur.rowcount or 0) > 0

    # ── device presence ──────────────────────────────────────────────────

    def seen(self, name: str, *, kind: str = "", user_agent: str = "", address: str = "") -> None:
        """Record a presence ping.

        Bumps the revision only when the device is new or was offline. Every
        snapshot GET records a last_seen, so if a moving timestamp bumped the
        counter then each device's poll would push a full snapshot to every
        other device — the counter doing precisely the opposite of its job.
        """
        if not name:
            return
        prior = self._db.execute("SELECT last_seen FROM devices WHERE name = ?", (name,)).fetchone()
        newly_present = prior is None or (time.time() - float(prior[0])) > 120.0
        self._db.execute(
            """INSERT INTO devices (name, kind, last_seen, user_agent, address)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(name) DO UPDATE SET
                 last_seen=excluded.last_seen,
                 kind=CASE WHEN excluded.kind != '' THEN excluded.kind ELSE devices.kind END,
                 user_agent=excluded.user_agent, address=excluded.address""",
            (name, kind or "unknown", time.time(), user_agent[:200], address),
        )
        self._commit(bump=newly_present)

    def devices(self, *, online_window: float = 120.0) -> list[dict[str, Any]]:
        now = time.time()
        cur = self._db.execute("SELECT * FROM devices ORDER BY last_seen DESC")
        out = []
        for r in cur.fetchall():
            d = dict(r)
            d["age"] = now - float(d["last_seen"])
            d["online"] = d["age"] <= online_window
            out.append(d)
        return out

    # ── maintenance ──────────────────────────────────────────────────────

    def purge_expired(self) -> dict[str, int]:
        """Drop everything past its TTL, including orphaned blobs on disk."""
        now = time.time()
        counts: dict[str, int] = {}

        stale = [
            str(r["id"])
            for r in self._db.execute(
                "SELECT id FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,)
            ).fetchall()
        ]
        for fid in stale:
            (self.blob_dir / fid).unlink(missing_ok=True)
        counts["files"] = len(stale)
        self._db.execute(
            "DELETE FROM files WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,)
        )

        cur = self._db.execute(
            "DELETE FROM clips WHERE expires_at IS NOT NULL AND expires_at <= ?", (now,)
        )
        counts["clips"] = cur.rowcount or 0
        self._commit()

        # Blobs with no row (an interrupted upload) would otherwise leak disk
        # forever, invisibly.
        known = {str(r["id"]) for r in self._db.execute("SELECT id FROM files").fetchall()}
        orphans = 0
        for p in self.blob_dir.iterdir():
            if p.is_file() and p.name not in known:
                p.unlink(missing_ok=True)
                orphans += 1
        counts["orphan_blobs"] = orphans
        return counts

    def stats(self) -> dict[str, Any]:
        def one(q: str) -> int:
            return int(self._db.execute(q).fetchone()[0])

        return {
            "clips": one("SELECT COUNT(*) FROM clips"),
            "pinned": one("SELECT COUNT(*) FROM clips WHERE pinned = 1"),
            "secrets": one("SELECT COUNT(*) FROM clips WHERE secret = 1"),
            "files": one("SELECT COUNT(*) FROM files"),
            "bytes": one("SELECT COALESCE(SUM(size),0) FROM files"),
            "links": one("SELECT COUNT(*) FROM links"),
            "unread_links": one("SELECT COUNT(*) FROM links WHERE opened_at IS NULL"),
            "notes": one("SELECT COUNT(*) FROM notes"),
        }


# ── helpers ──────────────────────────────────────────────────────────────


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _slug(s: str) -> str:
    out = re.sub(r"[^a-z0-9_-]+", "-", s.strip().lower()).strip("-")
    return out[:64] or "scratch"


def _safe_display_name(name: str) -> str:
    """Keep a readable name without letting it near the filesystem."""
    base = Path(name).name  # strip any directory component the client sent
    base = re.sub(r"[\x00-\x1f]", "", base)
    return base[:180] or "untitled"


def _is_web_url(url: str) -> bool:
    """http/https only. Blocks file://, javascript:, data: and friends."""
    return bool(re.match(r"^https?://[^\s]+$", url.strip(), re.I))


def device_kind_from_ua(ua: str) -> str:
    """Best-effort platform label from a User-Agent, for the presence list."""
    u = ua.lower()
    if "ipad" in u:
        return "ipad"
    if "iphone" in u:
        return "iphone"
    if "mac os" in u or "macintosh" in u:
        return "macos"
    if "linux" in u or "x11" in u:
        return "linux"
    if "windows" in u:
        return "windows"
    return "unknown"


def guess_mime(name: str, fallback: str = "application/octet-stream") -> str:
    import mimetypes

    return mimetypes.guess_type(name)[0] or fallback


def dumps(obj: Any) -> str:
    return json.dumps(obj, default=str)
