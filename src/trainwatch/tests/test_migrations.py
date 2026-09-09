"""Schema migrations tracked in `PRAGMA user_version` — ADR-0004.

The interesting cases are not "does a fresh database get the schema" but
"does an old one get there safely, and exactly once".
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

from src.trainwatch.store import _MIGRATIONS, Store

HEAD = _MIGRATIONS[-1][0]


def _indexes(db: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in db.execute(f"PRAGMA index_list({table})")]


def _legacy_v0(path: Path, rows: list[tuple[str, int, float, str, float]]) -> None:
    """A database as it existed before ADR-0004: no unique index, no version."""
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE metrics (run_id TEXT NOT NULL, step INTEGER NOT NULL,
            wall REAL NOT NULL, key TEXT NOT NULL, value REAL NOT NULL);
        CREATE INDEX idx_metrics_lookup ON metrics (run_id, key, step);
        """
    )
    conn.executemany("INSERT INTO metrics VALUES (?,?,?,?,?)", rows)
    conn.commit()
    assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
    conn.close()


# ── the list itself ──────────────────────────────────────────────────────


def test_migration_versions_are_unique_and_ordered() -> None:
    """Renumbering a shipped migration would strand databases in the wild.

    A database records the version it reached. If entry 2 is renumbered to 3,
    every database already at 2 silently skips the new 2 forever.
    """
    versions = [v for v, _, _ in _MIGRATIONS]
    assert versions == sorted(versions), "migrations must be in ascending order"
    assert len(versions) == len(set(versions)), "duplicate migration version"
    assert versions[0] == 1, "versions start at 1; 0 means 'never migrated'"
    assert versions == list(range(1, len(versions) + 1)), "no gaps"


def test_migration_names_are_present() -> None:
    for version, name, apply in _MIGRATIONS:
        assert name.strip(), f"migration {version} has no name"
        assert callable(apply)


# ── fresh ────────────────────────────────────────────────────────────────


def test_a_fresh_database_lands_at_head(tmp_path: Path) -> None:
    store = Store(tmp_path / "fresh.db")
    try:
        assert store._db.execute("PRAGMA user_version").fetchone()[0] == HEAD
        assert "ux_metrics_run_key_step" in _indexes(store._db, "metrics")
    finally:
        store.close()


def test_reopening_does_not_re_run_migrations(tmp_path: Path) -> None:
    path = tmp_path / "fresh.db"
    Store(path).close()
    store = Store(path)
    try:
        assert store._db.execute("PRAGMA user_version").fetchone()[0] == HEAD
    finally:
        store.close()


# ── upgrade from v0 ──────────────────────────────────────────────────────


def test_legacy_database_is_migrated_and_deduped(tmp_path: Path) -> None:
    path = tmp_path / "legacy.db"
    _legacy_v0(
        path,
        [
            ("r", 1, 1.0, "loss", 9.0),  # older duplicate
            ("r", 1, 2.0, "loss", 8.0),  # newest for (r, loss, 1) -> wins
            ("r", 2, 3.0, "loss", 7.0),
        ],
    )
    store = Store(path)
    try:
        assert store._db.execute("PRAGMA user_version").fetchone()[0] == HEAD
        rows = store._db.execute("SELECT step, value FROM metrics ORDER BY step").fetchall()
        assert [tuple(r) for r in rows] == [(1, 8.0), (2, 7.0)]
        idx = _indexes(store._db, "metrics")
        assert "ux_metrics_run_key_step" in idx
        assert "idx_metrics_lookup" not in idx, "redundant index should be dropped"
    finally:
        store.close()


def test_legacy_database_with_no_duplicates_keeps_every_row(tmp_path: Path) -> None:
    path = tmp_path / "clean.db"
    _legacy_v0(path, [("r", step, float(step), "loss", 1.0) for step in range(20)])
    store = Store(path)
    try:
        assert store._db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0] == 20
    finally:
        store.close()


def test_migrated_database_enforces_idempotent_replay(tmp_path: Path) -> None:
    """The point of the migration: a replayed batch must not double-insert."""
    path = tmp_path / "legacy.db"
    _legacy_v0(path, [("r", 1, 1.0, "loss", 5.0)])
    store = Store(path, flush_interval=0.0)
    try:
        for _ in range(3):
            store.log_metrics("r", 1, {"loss": 2.0})
            store.flush()
        rows = store._db.execute("SELECT COUNT(*) FROM metrics").fetchone()[0]
        assert rows == 1, f"replay inserted {rows} rows; upsert is not working"
        assert store._db.execute("SELECT value FROM metrics").fetchone()[0] == 2.0
    finally:
        store.close()
