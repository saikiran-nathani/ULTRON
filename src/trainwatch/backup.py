"""Hot backup, verification and restore for the system-of-record database.

ADR-0004 control C13. Before that ADR the store held derived telemetry and had
no backups on purpose; it now holds curriculum progress, lineage and eval
results, none of which are reproducible by re-running.

Why `VACUUM INTO` rather than copying the file
----------------------------------------------
The database is in WAL mode and is written while the dashboard reads it. A
plain `cp` of `foo.db` captures the main file without the `-wal` sidecar, so a
snapshot taken mid-transaction can be torn: committed rows living only in the
WAL are lost, and the copy may not even open. `VACUUM INTO` runs inside a read
transaction and writes a single fully-checkpointed file, so the snapshot is
internally consistent at one instant with no locking of the writer.

It also compacts, which matters here because pruning telemetry leaves free
pages behind that a file copy would faithfully preserve.
"""

from __future__ import annotations

import logging
import shutil
import sqlite3
import time
from collections.abc import Iterable
from datetime import UTC, datetime
from pathlib import Path

__all__ = [
    "SNAP_GLOB",
    "integrity",
    "latest",
    "prune_snapshots",
    "restore",
    "snapshot",
    "snapshot_time",
]

log = logging.getLogger("trainwatch.backup")

SNAP_PREFIX = "snap-"
SNAP_SUFFIX = ".db"
SNAP_GLOB = f"{SNAP_PREFIX}*{SNAP_SUFFIX}"
_STAMP = "%Y%m%dT%H%M%SZ"

# WAL and shared-memory sidecars. A restore that leaves these in place lets
# SQLite replay a *stale* WAL over the file we just put back, silently undoing
# the restore. They must go.
_SIDECARS = ("-wal", "-shm")


def snapshot(db: Path, dest_dir: Path, *, now: float | None = None) -> Path:
    """Write a consistent snapshot of `db` into `dest_dir`, returning its path.

    Raises `FileExistsError` if a snapshot for this second already exists —
    `VACUUM INTO` refuses to overwrite, and so do we.
    """
    db = Path(db)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.fromtimestamp(now if now is not None else time.time(), UTC)
    out = dest_dir / f"{SNAP_PREFIX}{stamp.strftime(_STAMP)}{SNAP_SUFFIX}"
    if out.exists():
        raise FileExistsError(out)

    conn = sqlite3.connect(db, timeout=30.0)
    try:
        # Parameter binding is not allowed for VACUUM INTO's target, so the
        # path is interpolated. It is built from a strftime stamp above, never
        # from user input; the quote-doubling keeps that true if that changes.
        target = str(out).replace("'", "''")
        conn.execute(f"VACUUM INTO '{target}'")
    finally:
        conn.close()
    log.info("snapshot %s (%.1f KiB)", out.name, out.stat().st_size / 1024)
    return out


def integrity(db: Path) -> str:
    """`PRAGMA integrity_check` on `db`. Returns 'ok', or the first problem."""
    try:
        conn = sqlite3.connect(f"file:{Path(db)}?mode=ro", uri=True, timeout=30.0)
    except sqlite3.Error as exc:
        return f"cannot open: {exc}"
    try:
        rows = conn.execute("PRAGMA integrity_check").fetchall()
    except sqlite3.DatabaseError as exc:
        return f"unreadable: {exc}"
    finally:
        conn.close()
    return str(rows[0][0]) if rows else "no result"


def snapshot_time(path: Path) -> datetime | None:
    """Parse a snapshot's timestamp from its name, or None if it is not one."""
    name = Path(path).name
    if not (name.startswith(SNAP_PREFIX) and name.endswith(SNAP_SUFFIX)):
        return None
    core = name[len(SNAP_PREFIX) : -len(SNAP_SUFFIX)]
    try:
        return datetime.strptime(core, _STAMP).replace(tzinfo=UTC)
    except ValueError:
        return None


def latest(dest_dir: Path) -> Path | None:
    """The newest snapshot in `dest_dir`, by embedded timestamp."""
    dated = _dated(Path(dest_dir).glob(SNAP_GLOB))
    return dated[0][1] if dated else None


def prune_snapshots(
    dest_dir: Path, *, hourly: int = 24, daily: int = 30, now: float | None = None
) -> list[Path]:
    """Apply retention, returning what was deleted.

    Keeps the newest `hourly` snapshots outright, plus the newest snapshot of
    each of the most recent `daily` calendar days (UTC). A snapshot kept by
    either rule survives; everything else goes.

    Two rules rather than one because they answer different questions. The
    hourly window is "undo the last few hours" — the realistic case, a bad
    migration or a wrong bulk edit. The daily tail is "how did this look last
    month", which is what makes a lineage claim checkable after the fact.
    """
    dated = _dated(Path(dest_dir).glob(SNAP_GLOB))
    if not dated:
        return []
    _ = now  # retention is relative to the snapshots present, not wall clock

    keep = {path for _, path in dated[:hourly]}
    seen_days: dict[str, Path] = {}
    for when, path in dated:  # newest first, so the first per day is the newest
        seen_days.setdefault(when.strftime("%Y%m%d"), path)
    for day in sorted(seen_days, reverse=True)[:daily]:
        keep.add(seen_days[day])

    deleted = []
    for _, path in dated:
        if path not in keep:
            path.unlink()
            deleted.append(path)
    if deleted:
        log.info("pruned %d snapshot(s)", len(deleted))
    return deleted


def restore(snap: Path, target: Path) -> Path:
    """Put `snap` back at `target`. Returns where the previous file was moved.

    Deliberately non-destructive: a corrupt snapshot is refused before anything
    is touched, and an existing target is *moved aside*, never overwritten. A
    restore performed under pressure is exactly when you discover the snapshot
    was the broken one.
    """
    snap, target = Path(snap), Path(target)
    verdict = integrity(snap)
    if verdict != "ok":
        raise ValueError(f"refusing to restore: {snap.name} failed integrity_check: {verdict}")

    aside = target.with_suffix(target.suffix + f".pre-restore-{int(time.time())}")
    if target.exists():
        target.rename(aside)
    # Stale sidecars would let SQLite replay an old WAL over the restored file.
    for suffix in _SIDECARS:
        sidecar = Path(str(target) + suffix)
        if sidecar.exists():
            sidecar.unlink()
    shutil.copy2(snap, target)
    log.info("restored %s -> %s (previous file at %s)", snap.name, target, aside.name)
    return aside


def _dated(paths: Iterable[Path]) -> list[tuple[datetime, Path]]:
    """Snapshots with parseable names, newest first."""
    out = [(when, p) for p in paths if (when := snapshot_time(p)) is not None]
    return sorted(out, key=lambda pair: pair[0], reverse=True)
