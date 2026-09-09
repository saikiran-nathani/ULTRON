"""SQLite store — the bus between the training process and the dashboard.

WAL mode gives us one writer + many readers across processes with no daemon,
which is exactly the shape of this system (see ADR-0001).

Write-path rule: this code runs *inside the training loop*. Metric rows are
buffered in memory and flushed with a single `executemany` at most every
`flush_interval` seconds, so the steady-state cost per step is a list append.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import time
from collections.abc import Callable, Iterable, Iterator, Sequence
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
-- No index here: migration 1 creates a UNIQUE one on the same three
-- columns, which serves every query this used to. Declaring it in both
-- places meant SCHEMA silently recreated on each open what the migration
-- had dropped once, so the file's indexes depended on how many times it
-- had been opened.

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
log = logging.getLogger("trainwatch.store")


def connect(path: str | Path) -> sqlite3.Connection:
    """Open the system-of-record database with the pragmas ADR-0004 requires.

    One factory because there are three openers -- Store, Hub and Curriculum --
    all pointed at the same file by `cfg.db_path`. They previously each carried
    their own copy of this block, which is precisely how `foreign_keys` came to
    be set in neither: a pragma added in one place is invisible to the others.

    Migrations run here too, so the schema is at head no matter which class
    opened the file first.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=15.0, check_same_thread=False)
    db.row_factory = sqlite3.Row
    # WAL: readers never block the writer, which is what lets the dashboard
    # poll a database the training loop is actively writing to.
    db.execute("PRAGMA journal_mode=WAL")
    # FULL, not NORMAL: ADR-0004 made this file the system of record. Under
    # WAL, NORMAL can lose the last committed transactions on power loss -- it
    # will not corrupt the file, but "committed" stops meaning committed. The
    # fsync amortises over a batched flush rather than landing per metric.
    db.execute("PRAGMA synchronous=FULL")
    # Off by default in SQLite, and scoped to the connection. Without it every
    # foreign key below is silently unenforced and nothing raises.
    db.execute("PRAGMA foreign_keys=ON")
    db.execute("PRAGMA busy_timeout=15000")
    return db


def _table_exists(db: sqlite3.Connection, name: str) -> bool:
    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def migrate(db: sqlite3.Connection) -> int:
    """Apply pending migrations, tracked in `PRAGMA user_version`. Returns head.

    ADR-0004 specified Alembic. It is not used, and the reason is worth
    recording: Alembic earns its keep through `--autogenerate`, which diffs
    SQLAlchemy models against the live schema. The same ADR rules out an ORM,
    so there are no models to diff and Alembic reduces to ordered hand-written
    SQL plus a dependency and an `env.py`. `user_version` is SQLite's own
    answer to the same question and costs neither.

    The base tables are created here, before any step runs. That is not
    tidiness -- it closes a hole that a guard alone could not.

    Migration 1 adds a unique index to `metrics` and previously skipped when
    that table was absent, since Auth or Curriculum may reach a fresh file
    before Store does. But skipping still bumped `user_version`, so when Store
    later created `metrics` the migration was already recorded as applied and
    the index was never built. `flush()` then failed with "ON CONFLICT clause
    does not match any PRIMARY KEY or UNIQUE constraint" -- a guard that turned
    a crash into silent schema corruption, which is the worse trade.

    Ensuring the schema first means every step sees the tables it targets, so
    no step ever has cause to no-op. Steps stay individually re-runnable
    because DDL in Python's sqlite3 does not reliably participate in a
    transaction: a step that raises leaves `user_version` unbumped and is
    retried on the next open.
    """
    db.executescript(SCHEMA)
    version = int(db.execute("PRAGMA user_version").fetchone()[0])
    for target, name, apply in _MIGRATIONS:
        if version >= target:
            continue
        log.info("migrating store to v%d (%s)", target, name)
        apply(db)
        # PRAGMA does not accept bound parameters. `target` is an int from the
        # module-level tuple below, never from input.
        db.execute(f"PRAGMA user_version = {int(target)}")
        db.commit()
        version = target
    return version


def _m001_metrics_unique(db: sqlite3.Connection) -> None:
    """Unique (run_id, key, step) so a replayed spool is idempotent.

    The TUF sink buffers to a local file when the network drops and replays on
    reconnect. Replay is only safe if it cannot double-insert, which needs this
    constraint plus the upsert in `flush()`.

    A database written before this index existed may already hold duplicates,
    and `CREATE UNIQUE INDEX` fails outright on those -- so dedupe first,
    keeping the newest row per key.
    """
    # migrate() creates the base schema before any step, so this is
    # defensive only -- see the note there about why it must not be the only
    # thing standing between a fresh file and a missing index.
    if not _table_exists(db, "metrics"):
        return
    db.execute(
        """DELETE FROM metrics WHERE rowid NOT IN (
               SELECT MAX(rowid) FROM metrics GROUP BY run_id, key, step)"""
    )
    db.execute(
        """CREATE UNIQUE INDEX IF NOT EXISTS ux_metrics_run_key_step
               ON metrics (run_id, key, step)"""
    )
    # idx_metrics_lookup covered the same three columns in the same order, so
    # the unique index serves every query it served. Keeping both means
    # maintaining two B-trees per insert to satisfy one lookup.
    db.execute("DROP INDEX IF EXISTS idx_metrics_lookup")


def _m002_curriculum(db: sqlite3.Connection) -> None:
    """Curriculum progress tables — ADR-0004.

    Replaces `TUF/STATUS.md`, which was hand-maintained, partially updated, and
    by the time anyone noticed was asserting a reversed Python version and
    "nothing measured yet" against two committed benchmark sweeps.

    The constraints are the point. A document cannot refuse to contradict
    itself; a schema can:

    - `phases.ord UNIQUE` makes CLAUDE.md's "do not reorder" enforceable rather
      than advisory.
    - `status` CHECKs make an unknown state unrepresentable instead of a typo
      that reads fine.
    - `open_questions` CHECK ties `closed_at` to `status`, so a question cannot
      be closed without recording when -- the exact shape of rot that made the
      old file untrustworthy.
    - `gates.verify_cmd` carries the command that proves the gate, so a result
      is evidence rather than an assertion.

    New tables live only here, never in SCHEMA. Two declarations of the same
    table drift, and the copy that loses is the one nobody reads.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS phases (
            id     INTEGER PRIMARY KEY,
            slug   TEXT NOT NULL UNIQUE,
            name   TEXT NOT NULL,
            ord    INTEGER NOT NULL UNIQUE,
            status TEXT NOT NULL DEFAULT 'blocked'
                       CHECK (status IN ('blocked', 'active', 'done')),
            note   TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS gates (
            id          INTEGER PRIMARY KEY,
            phase_id    INTEGER NOT NULL REFERENCES phases (id) ON DELETE CASCADE,
            slug        TEXT NOT NULL,
            description TEXT NOT NULL,
            verify_cmd  TEXT NOT NULL DEFAULT '',
            UNIQUE (phase_id, slug)
        );

        CREATE TABLE IF NOT EXISTS gate_results (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            gate_id    INTEGER NOT NULL REFERENCES gates (id) ON DELETE CASCADE,
            ts         REAL NOT NULL,
            passed     INTEGER NOT NULL CHECK (passed IN (0, 1)),
            evidence   TEXT NOT NULL DEFAULT '',
            commit_sha TEXT NOT NULL DEFAULT '',
            machine    TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_gate_results ON gate_results (gate_id, ts DESC);

        CREATE TABLE IF NOT EXISTS decisions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            slug          TEXT NOT NULL,
            title         TEXT NOT NULL,
            body          TEXT NOT NULL DEFAULT '',
            decided_at    REAL NOT NULL,
            superseded_by INTEGER REFERENCES decisions (id) ON DELETE SET NULL,
            UNIQUE (slug, decided_at)
        );

        CREATE TABLE IF NOT EXISTS open_questions (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            slug       TEXT NOT NULL UNIQUE,
            question   TEXT NOT NULL,
            status     TEXT NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'closed')),
            opened_at  REAL NOT NULL,
            closed_at  REAL,
            resolution TEXT NOT NULL DEFAULT '',
            CHECK ((status = 'closed') = (closed_at IS NOT NULL))
        );
        """
    )


def _m003_auth(db: sqlite3.Connection) -> None:
    """Identity, sessions, machine tokens and the audit chain — ADR-0004.

    Tailscale remains the network boundary. This is defence in depth *inside*
    it, and its main job is attribution rather than exclusion: of the six
    actors that write here -- one person, agent sessions, the TUF trainer, the
    liveness cron, an iPad -- five are machines. The question the schema has to
    answer is "what changed my infrastructure, and when", not "who is allowed
    in". Tailscale already answers the second.

    Secrets are stored hashed, never in plaintext:

    - `sessions.id` is the SHA-256 of the cookie value.
    - `api_tokens.secret_hash` is the SHA-256 of the token secret. SHA-256 is
      correct there and a KDF would be theatre: a 256-bit random secret has no
      dictionary to attack, so stretching it buys nothing and costs latency on
      every request a trainer makes.
    - `users.pw_hash` is scrypt, which *does* need stretching because a
      password is low-entropy and chosen by a human.

    A leak of this file therefore yields nothing replayable.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS users (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            username      TEXT NOT NULL UNIQUE,
            pw_hash       TEXT NOT NULL,
            role          TEXT NOT NULL DEFAULT 'viewer'
                              CHECK (role IN ('owner', 'viewer')),
            created_at    REAL NOT NULL,
            pw_changed_at REAL NOT NULL,
            disabled_at   REAL
        );

        CREATE TABLE IF NOT EXISTS sessions (
            id         TEXT PRIMARY KEY,
            user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
            created_at REAL NOT NULL,
            last_seen  REAL NOT NULL,
            expires_at REAL NOT NULL,
            ip         TEXT NOT NULL DEFAULT '',
            ua         TEXT NOT NULL DEFAULT '',
            revoked_at REAL
        );
        CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);

        CREATE TABLE IF NOT EXISTS api_tokens (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL UNIQUE,
            secret_hash TEXT NOT NULL,
            scopes      TEXT NOT NULL DEFAULT '',
            created_at  REAL NOT NULL,
            last_used   REAL,
            expires_at  REAL,
            revoked_at  REAL
        );

        CREATE TABLE IF NOT EXISTS login_attempts (
            id       INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT NOT NULL,
            ip       TEXT NOT NULL DEFAULT '',
            ts       REAL NOT NULL,
            ok       INTEGER NOT NULL CHECK (ok IN (0, 1))
        );
        CREATE INDEX IF NOT EXISTS idx_login_attempts
            ON login_attempts (username, ts DESC);

        CREATE TABLE IF NOT EXISTS audit_log (
            seq        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts         REAL NOT NULL,
            actor_kind TEXT NOT NULL
                           CHECK (actor_kind IN ('human', 'machine', 'system')),
            actor_id   TEXT NOT NULL,
            action     TEXT NOT NULL,
            target     TEXT NOT NULL DEFAULT '',
            detail     TEXT NOT NULL DEFAULT '{}',
            request_id TEXT NOT NULL DEFAULT '',
            prev_hash  TEXT NOT NULL,
            hash       TEXT NOT NULL UNIQUE
        );
        CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log (ts DESC);
        """
    )


def _m004_replication(db: sqlite3.Connection) -> None:
    """Cursors and dedupe keys for replicating telemetry to a remote hub.

    ADR-0004 phase D. The ADR called for a fourth *sink* -- something in the
    training loop that posts over the network. That is the wrong shape here.
    A sink needs its own spool to be durable, which is a second write path for
    the same rows, and it puts a socket in the hot loop.

    The trainer already writes every metric to a local SQLite file, and as of
    phase A that file is `synchronous=FULL`. So the local store *is* the spool,
    and shipping is replication with a cursor: read rows above the mark, post
    them, advance. Store-and-forward is then not a feature to build but the
    default behaviour -- a network outage is a cursor that stops moving, and
    reconnecting catches up. Nothing the local store holds can be lost, and the
    training loop never waits on a socket.

    `ship_cursor` lives on the sender. The unique indexes matter on the
    receiver, where a replayed batch must not double-insert:

    - `metrics` already has one from migration 1, and `flush()` upserts.
    - `gpu` gets (ts, gpu_index): the sampler reads every GPU at one timestamp,
      so that pair is the natural key.
    - `events` gets (run_id, ts, rule). Caveat worth stating: SQLite treats
      NULLs as distinct, so events with no run_id are not deduped by it.
      Those come from the liveness check rather than a run, they are rare, and
      a duplicate alert is visibly harmless -- unlike a duplicated metric,
      which silently doubles a chart.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS ship_cursor (
            name       TEXT PRIMARY KEY,
            last_rowid INTEGER NOT NULL DEFAULT 0,
            updated    REAL NOT NULL DEFAULT 0
        );
        """
    )

    if _table_exists(db, "gpu"):
        names = {row[1] for row in db.execute("PRAGMA index_list(gpu)")}
        if "ux_gpu_ts_index" not in names:
            db.execute(
                """DELETE FROM gpu WHERE rowid NOT IN (
                       SELECT MAX(rowid) FROM gpu GROUP BY ts, gpu_index)"""
            )
            db.execute(
                "CREATE UNIQUE INDEX ux_gpu_ts_index ON gpu (ts, gpu_index)"
            )

    if _table_exists(db, "events"):
        names = {row[1] for row in db.execute("PRAGMA index_list(events)")}
        if "ux_events_dedupe" not in names:
            db.execute(
                """DELETE FROM events WHERE rowid NOT IN (
                       SELECT MAX(rowid) FROM events
                        GROUP BY COALESCE(run_id, ''), ts, rule)"""
            )
            db.execute(
                "CREATE UNIQUE INDEX ux_events_dedupe ON events (run_id, ts, rule)"
            )


def _m005_lineage(db: sqlite3.Connection) -> None:
    """Experiment lineage — ADR-0004 phase E.

    The difference between "loss went down" and "loss went down, on this data,
    with this config, at this commit, on this machine". Without it a result is
    an anecdote: reproducible only by whoever still remembers what they ran.

    Two constraints carry most of the weight.

    `configs.id` is the SHA-256 of the canonical YAML, so an identical config
    is the same row no matter who recorded it, and a config that differs by one
    character is visibly a different row rather than an edit.

    `evals` is UNIQUE on (subject, harness, task_set, k, seed). That makes
    "three seeds" enforceable instead of aspirational: the same seed cannot be
    recorded twice and counted as two, which is the easiest way to make a
    result look more solid than it is. Re-running one seed updates it rather
    than appending, because a second measurement of the same seed replaces the
    first -- it does not corroborate it.
    """
    db.executescript(
        """
        CREATE TABLE IF NOT EXISTS datasets (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            n_examples  INTEGER,
            sha256      TEXT NOT NULL DEFAULT '',
            built_at    REAL NOT NULL,
            recipe      TEXT NOT NULL DEFAULT '{}',
            parent_id   TEXT REFERENCES datasets (id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS configs (
            id         TEXT PRIMARY KEY,
            phase_id   INTEGER REFERENCES phases (id) ON DELETE SET NULL,
            body       TEXT NOT NULL,
            created_at REAL NOT NULL
        );

        CREATE TABLE IF NOT EXISTS checkpoints (
            id         TEXT PRIMARY KEY,
            run_id     TEXT NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
            step       INTEGER NOT NULL,
            path       TEXT NOT NULL DEFAULT '',
            sha256     TEXT NOT NULL DEFAULT '',
            size_bytes INTEGER NOT NULL DEFAULT 0,
            kind       TEXT NOT NULL DEFAULT 'adapter'
                           CHECK (kind IN ('adapter', 'merged', 'gguf')),
            created_at REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_checkpoints_run ON checkpoints (run_id, step);

        CREATE TABLE IF NOT EXISTS evals (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            subject_kind TEXT NOT NULL
                             CHECK (subject_kind IN ('base', 'checkpoint', 'served')),
            subject_id   TEXT NOT NULL,
            harness_sha  TEXT NOT NULL,
            task_set     TEXT NOT NULL,
            k            INTEGER NOT NULL CHECK (k >= 1),
            seed         INTEGER NOT NULL,
            score        REAL NOT NULL CHECK (score >= 0.0 AND score <= 1.0),
            n_problems   INTEGER NOT NULL CHECK (n_problems > 0),
            ran_at       REAL NOT NULL,
            machine      TEXT NOT NULL DEFAULT '',
            UNIQUE (subject_kind, subject_id, harness_sha, task_set, k, seed)
        );
        CREATE INDEX IF NOT EXISTS idx_evals_subject
            ON evals (subject_kind, subject_id, task_set, k);
        """
    )

    # ALTER TABLE ADD COLUMN is the only shape SQLite offers, and it must not
    # be re-attempted: a second add raises "duplicate column name" and would
    # leave user_version unbumped, so the migration would retry forever.
    # A REFERENCES column added this way must default to NULL, which these do.
    if _table_exists(db, "runs"):
        have = {row[1] for row in db.execute("PRAGMA table_info(runs)")}
        additions = (
            ("config_id", "TEXT REFERENCES configs (id) ON DELETE SET NULL"),
            ("dataset_id", "TEXT REFERENCES datasets (id) ON DELETE SET NULL"),
            ("phase_id", "INTEGER REFERENCES phases (id) ON DELETE SET NULL"),
            ("machine", "TEXT NOT NULL DEFAULT ''"),
            ("commit_sha", "TEXT NOT NULL DEFAULT ''"),
        )
        for column, spec in additions:
            if column not in have:
                db.execute(f"ALTER TABLE runs ADD COLUMN {column} {spec}")


# (user_version, name, apply). Append only; never renumber or edit a shipped
# entry -- a database in the wild has already recorded that it ran.
_MIGRATIONS: tuple[tuple[int, str, Callable[[sqlite3.Connection], None]], ...] = (
    (1, "metrics unique index", _m001_metrics_unique),
    (2, "curriculum progress tables", _m002_curriculum),
    (3, "identity, sessions, tokens, audit chain", _m003_auth),
    (4, "replication cursors and dedupe keys", _m004_replication),
    (5, "experiment lineage", _m005_lineage),
)


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
        self.flush_interval = flush_interval
        self.batch_rows = batch_rows

        self._db = connect(self.path)
        # migrate() applies SCHEMA before any step, so the base tables and
        # every migration land in one place and in one order.
        migrate(self._db)
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
        # Upsert, not INSERT: makes a replayed spool idempotent. See _migrate.
        self._db.executemany(
            """INSERT INTO metrics (run_id, step, wall, key, value)
                   VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(run_id, key, step) DO UPDATE SET
                   wall = excluded.wall, value = excluded.value""",
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
        ts: float | None = None,
    ) -> int:
        """Record an event. `ts` defaults to now.

        `ts` is settable because a replicated event has to keep the timestamp
        it was created with. Migration 4's dedupe key is (run_id, ts, rule);
        re-stamping on arrival would give a replayed event a fresh key and
        defeat the deduplication it depends on.
        """
        cur = self._db.execute(
            """INSERT OR IGNORE INTO events
                   (run_id, ts, level, rule, title, body, step, notified)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (run_id, ts if ts is not None else time.time(),
             level, rule, title, body, step, int(notified)),
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
            """INSERT OR IGNORE INTO gpu
                   (ts, gpu_index, name, util, mem_used, mem_total, temp, power, clock_sm, throttle)
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
