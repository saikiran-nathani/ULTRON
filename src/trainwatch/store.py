"""SQLite store — the bus between the training process and the dashboard.

WAL mode gives us one writer + many readers across processes with no daemon,
which is exactly the shape of this system (see ADR-0001).

Write-path rule: this code runs *inside the training loop*. Metric rows are
buffered in memory and flushed with a single `executemany` at most every
`flush_interval` seconds, so the steady-state cost per step is a list append.
"""

from __future__ import annotations

import json
import sqlite3
import time
from collections.abc import Iterable, Iterator, Sequence
from pathlib import Path
from typing import Any

__all__ = ["EventRow", "RunRow", "Store"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    started_at  REAL NOT NULL,
    ended_at    REAL,
    status      TEXT NOT NULL DEFAULT 'running',
    last_step   INTEGER NOT NULL DEFAULT 0,
    last_beat   REAL,
    meta        TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS metrics (
    run_id  TEXT NOT NULL,
    step    INTEGER NOT NULL,
    wall    REAL NOT NULL,
    key     TEXT NOT NULL,
    value   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_metrics_lookup ON metrics (run_id, key, step);

CREATE TABLE IF NOT EXISTS events (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id   TEXT,
    ts       REAL NOT NULL,
    level    TEXT NOT NULL,
    rule     TEXT NOT NULL,
    title    TEXT NOT NULL,
    body     TEXT NOT NULL DEFAULT '',
    step     INTEGER,
    notified INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts DESC);

CREATE TABLE IF NOT EXISTS gpu (
    ts        REAL NOT NULL,
    gpu_index INTEGER NOT NULL,
    name      TEXT NOT NULL DEFAULT '',
    util      REAL,
    mem_used  REAL,
    mem_total REAL,
    temp      REAL,
    power     REAL,
    clock_sm  REAL,
    throttle  TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_gpu_ts ON gpu (ts DESC);
"""

RunRow = dict[str, Any]
EventRow = dict[str, Any]

# Rows buffered before an automatic flush, and the max age of the buffer.
_BATCH_ROWS = 512
_FLUSH_INTERVAL = 2.0


class Store:
    """Thin, typed wrapper over the SQLite file. Safe to open in many processes."""

    def __init__(
        self,
        path: str | Path,
        *,
        flush_interval: float = _FLUSH_INTERVAL,
        batch_rows: int = _BATCH_ROWS,
    ) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.flush_interval = flush_interval
        self.batch_rows = batch_rows

        self._db = sqlite3.connect(self.path, timeout=15.0, check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        # WAL: readers never block the writer, which is what lets the dashboard
        # poll a database the training loop is actively writing to.
        self._db.execute("PRAGMA journal_mode=WAL")
        # NORMAL trades a fsync-per-commit for a fsync-per-checkpoint. On a crash
        # we can lose the last commits; for telemetry that is the right trade.
        self._db.execute("PRAGMA synchronous=NORMAL")
        self._db.execute("PRAGMA busy_timeout=15000")
        self._db.executescript(SCHEMA)
        self._db.commit()

        self._buf: list[tuple[str, int, float, str, float]] = []
        self._last_flush = time.time()

    # ── lifecycle ────────────────────────────────────────────────────────

    def close(self) -> None:
        self.flush()
        self._db.close()

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── change detection ─────────────────────────────────────────────────

    def watermark(self) -> tuple[int, ...]:
        """Cheap monotonic change token, mirroring `Hub.revision()`.

        The SSE stream used to re-send a full snapshot every 2s whether or not
        anything had moved — ~8 queries plus 25 runs and 40 events serialised,
        30 times a minute, per connected tab. On the cellular link this whole
        project is designed around, that is tens of MB an hour for a screen
        showing an idle run.

        `metrics`, `events` and `gpu` are rowid tables, so MAX(rowid) is an
        O(1) rightmost-leaf lookup rather than a scan. The `runs` aggregates
        are a scan of a table with tens of rows, and they exist because a run
        transitioning to finished/failed mutates a row in place — the rowid
        does not move, so rowid alone would miss it.
        """
        row = self._db.execute(
            """SELECT (SELECT COALESCE(MAX(rowid), 0)      FROM metrics),
                      (SELECT COALESCE(MAX(rowid), 0)      FROM events),
                      (SELECT COALESCE(MAX(rowid), 0)      FROM gpu),
                      (SELECT COUNT(*)                     FROM runs),
                      (SELECT COALESCE(MAX(last_step), 0)  FROM runs),
                      (SELECT CAST(COALESCE(MAX(last_beat), 0) AS INTEGER) FROM runs),
                      (SELECT COUNT(*) FROM runs WHERE status = 'running')"""
        ).fetchone()
        # Aggregates always yield exactly one row; the guard matches the
        # codebase's fetchone() idiom and keeps mypy --strict happy.
        return tuple(int(v) for v in row) if row else ()

    # ── runs ─────────────────────────────────────────────────────────────

    def start_run(self, run_id: str, name: str, meta: dict[str, Any] | None = None) -> None:
        self._db.execute(
            """INSERT INTO runs (id, name, started_at, status, meta) VALUES (?, ?, ?, 'running', ?)
               ON CONFLICT(id) DO UPDATE SET name=excluded.name, status='running', ended_at=NULL""",
            (run_id, name, time.time(), json.dumps(meta or {})),
        )
        self._db.commit()

    def finish_run(self, run_id: str, status: str = "finished") -> None:
        self.flush()
        self._db.execute(
            "UPDATE runs SET ended_at = ?, status = ? WHERE id = ?",
            (time.time(), status, run_id),
        )
        self._db.commit()

    def beat(self, run_id: str, step: int, ts: float | None = None) -> None:
        """Record progress. Cheap enough to call every step."""
        self._db.execute(
            "UPDATE runs SET last_beat = ?, last_step = ? WHERE id = ?",
            (ts if ts is not None else time.time(), step, run_id),
        )

    def runs(self, limit: int = 50) -> list[RunRow]:
        cur = self._db.execute(
            "SELECT * FROM runs ORDER BY started_at DESC LIMIT ?",
            (limit,),
        )
        return [self._run_row(r) for r in cur.fetchall()]

    def run(self, run_id: str) -> RunRow | None:
        cur = self._db.execute("SELECT * FROM runs WHERE id = ?", (run_id,))
        row = cur.fetchone()
        return self._run_row(row) if row else None

    def latest_run(self) -> RunRow | None:
        """The run the dashboard should open on: the newest live one, else newest."""
        cur = self._db.execute(
            """SELECT * FROM runs
               ORDER BY (status = 'running') DESC, started_at DESC LIMIT 1"""
        )
        row = cur.fetchone()
        return self._run_row(row) if row else None

    @staticmethod
    def _run_row(row: sqlite3.Row) -> RunRow:
        d = dict(row)
        try:
            d["meta"] = json.loads(d.get("meta") or "{}")
        except json.JSONDecodeError:
            d["meta"] = {}
        return d

    # ── metrics ──────────────────────────────────────────────────────────

    def log_metrics(self, run_id: str, step: int, values: dict[str, float]) -> None:
        """Buffer a step's scalars. Flushes on size or age, never on every call."""
        wall = time.time()
        self._buf.extend(
            (run_id, step, wall, key, float(value))
            for key, value in values.items()
            if _is_finite_number(value)
        )
        if len(self._buf) >= self.batch_rows or (wall - self._last_flush) >= self.flush_interval:
            self.flush()

    def flush(self) -> None:
        if not self._buf:
            self._db.commit()
            self._last_flush = time.time()
            return
        rows, self._buf = self._buf, []
        self._db.executemany(
            "INSERT INTO metrics (run_id, step, wall, key, value) VALUES (?, ?, ?, ?, ?)",
            rows,
        )
        self._db.commit()
        self._last_flush = time.time()

    def metric_keys(self, run_id: str) -> list[str]:
        cur = self._db.execute(
            "SELECT DISTINCT key FROM metrics WHERE run_id = ? ORDER BY key", (run_id,)
        )
        return [r[0] for r in cur.fetchall()]

    def series(
        self,
        run_id: str,
        keys: Sequence[str],
        *,
        points: int = 240,
        since_step: int = -1,
    ) -> dict[str, list[list[float]]]:
        """Downsampled [[step, value], ...] per key.

        Buckets in SQL so a 500k-row run still answers in milliseconds and the
        iPad never receives more points than a sparkline can draw.
        """
        if not keys:
            return {}
        out: dict[str, list[list[float]]] = {}
        for key in keys:
            span = self._db.execute(
                "SELECT MIN(step), MAX(step), COUNT(*) FROM metrics WHERE run_id = ? AND key = ? AND step > ?",
                (run_id, key, since_step),
            ).fetchone()
            lo, hi, count = span[0], span[1], span[2]
            if not count:
                out[key] = []
                continue

            if count <= points:
                cur = self._db.execute(
                    "SELECT step, value FROM metrics WHERE run_id = ? AND key = ? AND step > ? ORDER BY step",
                    (run_id, key, since_step),
                )
                out[key] = [[float(s), float(v)] for s, v in cur.fetchall()]
                continue

            # Bucket by step range; average within a bucket, report the bucket's
            # last step so the x-axis stays monotonic.
            width = max(1.0, (hi - lo + 1) / points)
            cur = self._db.execute(
                """SELECT MAX(step) AS step, AVG(value) AS value
                   FROM metrics
                   WHERE run_id = ? AND key = ? AND step > ?
                   GROUP BY CAST((step - ?) / ? AS INTEGER)
                   ORDER BY step""",
                (run_id, key, since_step, lo, width),
            )
            out[key] = [[float(s), float(v)] for s, v in cur.fetchall()]
        return out

    def latest_values(self, run_id: str, keys: Sequence[str]) -> dict[str, float]:
        """Most recent value per key — the numbers on the dashboard's hero row."""
        if not keys:
            return {}
        # The only thing interpolated is a run of '?' placeholders whose length
        # comes from len(keys); every key itself is bound as a parameter below.
        placeholders = ",".join("?" * len(keys))
        cur = self._db.execute(
            f"""SELECT key, value FROM metrics
                WHERE run_id = ? AND key IN ({placeholders})
                  AND step = (SELECT MAX(step) FROM metrics m2
                              WHERE m2.run_id = metrics.run_id AND m2.key = metrics.key)""",  # noqa: S608
            (run_id, *keys),
        )
        return {k: float(v) for k, v in cur.fetchall()}

    # ── events ───────────────────────────────────────────────────────────

    def add_event(
        self,
        *,
        run_id: str | None,
        level: str,
        rule: str,
        title: str,
        body: str = "",
        step: int | None = None,
        notified: bool = False,
    ) -> int:
        cur = self._db.execute(
            """INSERT INTO events (run_id, ts, level, rule, title, body, step, notified)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, time.time(), level, rule, title, body, step, int(notified)),
        )
        self._db.commit()
        return int(cur.lastrowid or 0)

    def events(self, *, limit: int = 100, run_id: str | None = None) -> list[EventRow]:
        if run_id:
            cur = self._db.execute(
                "SELECT * FROM events WHERE run_id = ? ORDER BY ts DESC LIMIT ?", (run_id, limit)
            )
        else:
            cur = self._db.execute("SELECT * FROM events ORDER BY ts DESC LIMIT ?", (limit,))
        return [dict(r) for r in cur.fetchall()]

    # ── gpu ──────────────────────────────────────────────────────────────

    def add_gpu_samples(self, samples: Iterable[dict[str, Any]]) -> None:
        rows = [
            (
                s.get("ts", time.time()),
                s.get("gpu_index", 0),
                s.get("name", ""),
                s.get("util"),
                s.get("mem_used"),
                s.get("mem_total"),
                s.get("temp"),
                s.get("power"),
                s.get("clock_sm"),
                s.get("throttle", ""),
            )
            for s in samples
        ]
        if not rows:
            return
        self._db.executemany(
            """INSERT INTO gpu (ts, gpu_index, name, util, mem_used, mem_total, temp, power, clock_sm, throttle)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            rows,
        )
        self._db.commit()

    def gpu_latest(self) -> list[dict[str, Any]]:
        cur = self._db.execute(
            """SELECT g.* FROM gpu g
               JOIN (SELECT gpu_index, MAX(ts) AS ts FROM gpu GROUP BY gpu_index) m
                 ON g.gpu_index = m.gpu_index AND g.ts = m.ts
               ORDER BY g.gpu_index"""
        )
        return [dict(r) for r in cur.fetchall()]

    def gpu_history(self, *, seconds: float = 1800, points: int = 180) -> list[dict[str, Any]]:
        cutoff = time.time() - seconds
        width = max(1.0, seconds / points)
        cur = self._db.execute(
            """SELECT gpu_index,
                      MAX(ts)        AS ts,
                      AVG(util)      AS util,
                      AVG(temp)      AS temp,
                      AVG(power)     AS power,
                      AVG(clock_sm)  AS clock_sm,
                      AVG(mem_used)  AS mem_used
               FROM gpu WHERE ts >= ?
               GROUP BY gpu_index, CAST(ts / ? AS INTEGER)
               ORDER BY ts""",
            (cutoff, width),
        )
        return [dict(r) for r in cur.fetchall()]

    # ── maintenance ──────────────────────────────────────────────────────

    def prune(self, *, keep_days: float = 30.0) -> int:
        """Drop telemetry older than keep_days. Runs are kept; their rows go."""
        cutoff = time.time() - keep_days * 86400
        cur = self._db.execute("DELETE FROM gpu WHERE ts < ?", (cutoff,))
        deleted = cur.rowcount or 0
        cur = self._db.execute(
            """DELETE FROM metrics WHERE run_id IN
               (SELECT id FROM runs WHERE ended_at IS NOT NULL AND ended_at < ?)""",
            (cutoff,),
        )
        deleted += cur.rowcount or 0
        self._db.commit()
        self._db.execute("VACUUM")
        return deleted


def _is_finite_number(value: Any) -> bool:
    """True for real, finite floats. NaN/inf are *events*, not data points.

    Storing NaN in SQLite silently becomes NULL and then poisons AVG() in the
    bucketing query, so they are filtered here and surfaced by the rules engine.
    """
    try:
        f = float(value)
    except (TypeError, ValueError):
        return False
    return f == f and f not in (float("inf"), float("-inf"))


def iter_rows(cur: sqlite3.Cursor) -> Iterator[dict[str, Any]]:
    for row in cur:
        yield dict(row)
