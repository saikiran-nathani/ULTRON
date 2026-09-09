"""Backup, retention and restore — ADR-0004 control C13.

The Phase A gate lives here: `test_gate_crash_then_restore`. Until that passes
the store is not a system of record, it is a file we hope about.
"""

from __future__ import annotations

import sqlite3
import subprocess
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import pytest

from src.trainwatch.backup import (
    integrity,
    latest,
    prune_snapshots,
    restore,
    snapshot,
    snapshot_time,
)
from src.trainwatch.store import Store

REPO_ROOT = Path(__file__).resolve().parents[3]

_SIDECARS = ("-wal", "-shm")


def _count(db: Path) -> int:
    """Row count via a connection that is actually closed.

    A lingering connection keeps the WAL alive, and a live WAL shadows the main
    file -- see test_wal_shadows_a_corrupt_main_file. Leaking one here would
    make later corruption in a test invisible.
    """
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    try:
        return int(conn.execute("SELECT COUNT(*) FROM metrics").fetchone()[0])
    finally:
        conn.close()


def _hard_corrupt(db: Path) -> None:
    """Damage a database for real: drop the sidecars, then scribble on a page.

    Removing `-wal`/`-shm` first is not incidental. With them present SQLite
    reads pages out of the WAL and the main file can be complete garbage while
    every query still succeeds.

    The 100-byte header is preserved so this fails `integrity_check` as a
    structurally broken database, rather than being rejected earlier as "not a
    database" -- a weaker and less interesting assertion.
    """
    for suffix in _SIDECARS:
        side = Path(str(db) + suffix)
        if side.exists():
            side.unlink()
    raw = bytearray(db.read_bytes())
    raw[100:] = b"\xff" * (len(raw) - 100)
    db.write_bytes(bytes(raw))


def _seed(path: Path, *, runs: int = 2, steps: int = 30) -> int:
    """Write a known quantity of committed metrics. Returns the row count."""
    store = Store(path, flush_interval=0.0)
    for r in range(runs):
        store.start_run(f"r{r}", f"run-{r}")
        for step in range(steps):
            store.log_metrics(f"r{r}", step, {"loss": 1.0 / (step + 1), "lr": 2e-4})
            store.flush()
    total = store._db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
    store.close()
    return int(total)


# ── snapshot ─────────────────────────────────────────────────────────────


def test_snapshot_is_consistent_and_complete(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    rows = _seed(db)
    snap = snapshot(db, tmp_path / "snaps")

    assert snap.exists()
    assert integrity(snap) == "ok"
    got = sqlite3.connect(snap).execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
    assert got == rows


def test_snapshot_captures_committed_rows_while_a_writer_holds_the_db(tmp_path: Path) -> None:
    """The property a `cp` cannot promise: no tearing against a live writer.

    The writer stays open with uncommitted rows buffered when the snapshot is
    taken. The snapshot must contain every *committed* row and none of the
    buffered ones — a torn copy would show a partial transaction or fail to
    open at all.
    """
    db = tmp_path / "t.db"
    store = Store(db, flush_interval=1e9, batch_rows=10**9)  # never auto-flush
    store.start_run("r1", "live")
    for step in range(20):
        store.log_metrics("r1", step, {"loss": 0.5})
    store.flush()  # 20 rows committed
    committed = store._db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]

    for step in range(20, 40):  # buffered, deliberately not flushed
        store.log_metrics("r1", step, {"loss": 0.1})

    snap = snapshot(db, tmp_path / "snaps")
    store.close()

    assert integrity(snap) == "ok"
    got = sqlite3.connect(snap).execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
    assert got == committed == 20


def test_snapshot_refuses_to_overwrite(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    _seed(db, runs=1, steps=1)
    now = time.time()
    snapshot(db, tmp_path / "snaps", now=now)
    with pytest.raises(FileExistsError):
        snapshot(db, tmp_path / "snaps", now=now)


# ── integrity ────────────────────────────────────────────────────────────


def test_integrity_detects_a_mangled_file(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    _seed(db, runs=1, steps=5)
    _hard_corrupt(db)
    assert integrity(db) != "ok"


def test_integrity_on_a_missing_file_does_not_raise(tmp_path: Path) -> None:
    assert integrity(tmp_path / "nope.db") != "ok"


# ── retention ────────────────────────────────────────────────────────────


def _fake_snaps(dest: Path, stamps: list[str]) -> list[Path]:
    dest.mkdir(parents=True, exist_ok=True)
    out = []
    for s in stamps:
        p = dest / f"snap-{s}.db"
        p.write_bytes(b"x")
        out.append(p)
    return out


def test_prune_keeps_hourly_window_and_daily_tail(tmp_path: Path) -> None:
    dest = tmp_path / "snaps"
    # three per day across five days, newest day last
    stamps = [
        f"2026090{day}T{hour:02d}0000Z" for day in range(1, 6) for hour in (1, 12, 23)
    ]
    _fake_snaps(dest, stamps)
    assert len(list(dest.glob("snap-*.db"))) == 15

    prune_snapshots(dest, hourly=3, daily=2)
    kept = sorted(p.name for p in dest.glob("snap-*.db"))

    # hourly=3 keeps the three newest overall (all on day 05).
    # daily=2 keeps the newest of the two most recent days: 05 (already kept)
    # and 04 -> 23:00.
    assert kept == [
        "snap-20260904T230000Z.db",
        "snap-20260905T010000Z.db",
        "snap-20260905T120000Z.db",
        "snap-20260905T230000Z.db",
    ]


def test_prune_is_a_noop_on_an_empty_dir(tmp_path: Path) -> None:
    assert prune_snapshots(tmp_path / "empty") == []


def test_prune_ignores_unrelated_files(tmp_path: Path) -> None:
    dest = tmp_path / "snaps"
    _fake_snaps(dest, ["20260905T010000Z"])
    (dest / "notes.txt").write_text("keep me")
    (dest / "snap-garbage.db").write_bytes(b"x")  # unparseable stamp
    prune_snapshots(dest, hourly=0, daily=0)
    assert (dest / "notes.txt").exists()
    assert (dest / "snap-garbage.db").exists()  # not a snapshot, not ours to delete


def test_snapshot_time_and_latest(tmp_path: Path) -> None:
    dest = tmp_path / "snaps"
    _fake_snaps(dest, ["20260901T000000Z", "20260905T120000Z", "20260903T000000Z"])
    assert snapshot_time(dest / "snap-20260901T000000Z.db") == datetime(
        2026, 9, 1, tzinfo=UTC
    )
    assert snapshot_time(dest / "not-a-snap.db") is None
    got = latest(dest)
    assert got is not None and got.name == "snap-20260905T120000Z.db"


# ── restore ──────────────────────────────────────────────────────────────


def test_restore_refuses_a_corrupt_snapshot_and_leaves_the_target_alone(
    tmp_path: Path,
) -> None:
    db = tmp_path / "t.db"
    _seed(db, runs=1, steps=5)
    good = db.read_bytes()

    bad = tmp_path / "snap-20260905T120000Z.db"
    bad.write_bytes(b"SQLite format 3\x00" + b"\x00" * 900)

    with pytest.raises(ValueError, match="integrity_check"):
        restore(bad, db)
    assert db.read_bytes() == good, "target must be untouched when the snapshot is bad"


def test_restore_moves_the_previous_file_aside(tmp_path: Path) -> None:
    db = tmp_path / "t.db"
    _seed(db, runs=1, steps=5)
    snap = snapshot(db, tmp_path / "snaps")

    _seed(db, runs=1, steps=50)  # diverge
    aside = restore(snap, db)

    assert aside.exists(), "the pre-restore file must be preserved, never deleted"
    assert integrity(db) == "ok"


def test_restore_clears_stale_wal_sidecars(tmp_path: Path) -> None:
    """A stale `-wal` replayed over a restored file silently undoes the restore."""
    db = tmp_path / "t.db"
    rows = _seed(db, runs=1, steps=5)
    snap = snapshot(db, tmp_path / "snaps")

    # leave a bogus sidecar behind, as an interrupted process would
    Path(str(db) + "-wal").write_bytes(b"\x00" * 64)
    restore(snap, db)

    assert not Path(str(db) + "-wal").exists()
    got = sqlite3.connect(db).execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
    assert got == rows


# ── the Phase A gate ─────────────────────────────────────────────────────

_WRITER = """
import sys, time
sys.path.insert(0, {root!r})
from src.trainwatch.store import Store
store = Store({db!r}, flush_interval=0.0)
store.start_run("r1", "crash-me")
for step in range(10_000):
    store.log_metrics("r1", step, {{"loss": 1.0}})
    store.flush()
    if step == {mark}:
        print("MARK", flush=True)
    time.sleep(0.001)
"""


def test_gate_crash_then_restore(tmp_path: Path) -> None:
    """SIGKILL a writer mid-run, snapshot, restore, verify. The Phase A gate.

    Scope, stated precisely: this proves durability across *process* death and
    that the restore path works end to end. It does **not** prove power-loss
    durability — that is what `synchronous=FULL` addresses, and testing it
    needs the machine to actually lose power, which no unit test can do.
    """
    db = tmp_path / "t.db"
    mark = 40
    proc = subprocess.Popen(  # noqa: S603 - argv is literal; sys.executable is us
        [sys.executable, "-c", _WRITER.format(root=str(REPO_ROOT), db=str(db), mark=mark)],
        stdout=subprocess.PIPE,
        text=True,
    )
    try:
        assert proc.stdout is not None
        deadline = time.time() + 30
        while time.time() < deadline:
            line = proc.stdout.readline()
            if line.startswith("MARK"):
                break
        else:  # pragma: no cover - timing safety net
            pytest.fail("writer never reached the mark")
        time.sleep(0.2)  # let it write past the mark, so we kill mid-stream
        proc.kill()
    finally:
        proc.wait(timeout=10)

    assert proc.returncode != 0, "expected death by signal"

    # 1. the database survived the kill
    assert integrity(db) == "ok"
    survived = _count(db)
    assert survived > mark, "committed rows must outlive the process"

    # 2. a snapshot of the survivor is consistent
    snap = snapshot(db, tmp_path / "snaps")
    assert integrity(snap) == "ok"

    # 3. restore over a deliberately damaged live file
    _hard_corrupt(db)
    assert integrity(db) != "ok"
    restore(snap, db)

    # 4. clean, and no rows lost
    assert integrity(db) == "ok"
    restored = _count(db)
    assert restored == survived

    # 5. and it is still a working store, not just a readable file
    store = Store(db, flush_interval=0.0)
    store.log_metrics("r1", 99_999, {"loss": 0.0})
    store.flush()
    assert store._db.execute("PRAGMA foreign_keys").fetchone()[0] == 1
    store.close()


def test_wal_shadows_a_corrupt_main_file(tmp_path: Path) -> None:
    """Why `restore()` unlinks `-wal`/`-shm`, measured rather than assumed.

    While a connection is open, the WAL holds the authoritative pages. The main
    `.db` file can be overwritten with garbage and every query still succeeds,
    including `integrity_check`.

    Two consequences this pins down:

    - A restore that leaves stale sidecars in place does *nothing observable* --
      SQLite keeps serving the pre-restore pages out of the WAL. That is a
      silent, total failure of the one operation you cannot afford to get
      wrong, which is why `restore()` deletes them.
    - Never verify a backup by checking the live database. Verify the snapshot
      file, which `VACUUM INTO` writes fully checkpointed with no sidecars.
    """
    db = tmp_path / "t.db"
    store = Store(db, flush_interval=0.0)
    store.start_run("r1", "x")
    for step in range(50):
        store.log_metrics("r1", step, {"loss": 1.0})
        store.flush()

    lingering = sqlite3.connect(db)  # keeps the WAL from being checkpointed away
    try:
        assert Path(str(db) + "-wal").exists()
        db.write_bytes(b"\xde\xad\xbe\xef" * 64)  # main file: 256 bytes of garbage

        assert integrity(db) == "ok", "the WAL is authoritative while it exists"
        assert _count(db) == 50, "all rows still served, out of the WAL"
    finally:
        lingering.close()
        store.close()

    # And the sting in the tail: closing the last connection checkpoints the
    # WAL *over* the main file, so the garbage is not merely masked -- it is
    # overwritten with the real pages. The database repairs itself.
    #
    # This is the whole case for unlinking sidecars in restore(): a live WAL
    # does not just hide the file you put back, it will eventually write over
    # it with the pages you were trying to replace.
    assert integrity(db) == "ok", "close() checkpoints the WAL back over the damage"
    assert _count(db) == 50
