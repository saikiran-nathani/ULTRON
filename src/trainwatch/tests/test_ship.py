"""Telemetry replication — ADR-0004 phase D.

The Phase D gate is `test_gate_network_drops_mid_run_no_gaps_no_duplicates`.
Until that passes the sink is not done, because an outage that silently punches
a hole in a training history defeats the reason the hub moved to the Mac.

The receiver is a real FastAPI app behind a real HTTP server on a real socket,
not a stub. The failure this is guarding against lives in the interaction
between a cursor, a socket and a unique index; a fake transport would test the
cursor arithmetic and miss the point.
"""

from __future__ import annotations

import sqlite3
import threading
from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest
import uvicorn

from src.trainwatch.auth import Auth
from src.trainwatch.config import Config
from src.trainwatch.server.app import create_app
from src.trainwatch.ship import ShipStats, TelemetryShipper, ship_once
from src.trainwatch.store import Store


@pytest.fixture
def sender(tmp_path: Path) -> Iterator[Store]:
    """The TUF's local store: what the trainer writes to."""
    store = Store(tmp_path / "sender.db", flush_interval=0.0)
    yield store
    store.close()


class _Hub:
    """The Mac's hub, on a real port."""

    def __init__(self, cfg: Config, port: int = 0) -> None:
        self.cfg = cfg
        self.server = uvicorn.Server(
            uvicorn.Config(create_app(cfg), host="127.0.0.1", port=port, log_level="error")
        )
        self._thread = threading.Thread(target=self.server.run, daemon=True)

    def start(self) -> str:
        self._thread.start()
        deadline = threading.Event()
        while not self.server.started:
            if not self._thread.is_alive():
                raise RuntimeError("hub failed to start")
            deadline.wait(0.02)
        port = self.server.servers[0].sockets[0].getsockname()[1]
        return f"http://127.0.0.1:{port}"

    def stop(self) -> None:
        self.server.should_exit = True
        self._thread.join(timeout=10)


@pytest.fixture
def hub(tmp_path: Path) -> Iterator[tuple[str, Config]]:
    cfg = replace(
        Config(
            db_path=tmp_path / "hub.db",
            heartbeat_path=tmp_path / "hb",
            ntfy_topic="",
            sinks=("store",),
            tensorboard_dir=tmp_path / "runs",
            blob_dir=tmp_path / "blobs",
        ),
        allowed_hosts="127.0.0.1,localhost",
    )
    server = _Hub(cfg)
    url = server.start()
    yield url, cfg
    server.stop()


@pytest.fixture
def token(hub: tuple[str, Config]) -> str:
    _, cfg = hub
    with Auth(cfg.db_path) as auth:
        return auth.create_token("tuf-trainer", {"telemetry:write"}).secret


def _write(store: Store, run: str, steps: range) -> None:
    store.start_run(run, f"run-{run}")
    for step in steps:
        store.log_metrics(run, step, {"loss": 1.0 / (step + 1), "lr": 2e-4})
        store.flush()


def _hub_rows(cfg: Config, run: str) -> list[tuple[int, str, float]]:
    conn = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True)
    try:
        return [
            (int(r[0]), str(r[1]), float(r[2]))
            for r in conn.execute(
                "SELECT step, key, value FROM metrics WHERE run_id = ? ORDER BY step, key",
                (run,),
            )
        ]
    finally:
        conn.close()


# ── the happy path ───────────────────────────────────────────────────────


def test_metrics_reach_the_hub(sender: Store, hub: tuple[str, Config], token: str) -> None:
    url, cfg = hub
    _write(sender, "r1", range(10))

    stats = ship_once(sender.path, url, token)
    assert stats.metrics == 20, "10 steps x 2 keys"
    assert stats.caught_up

    rows = _hub_rows(cfg, "r1")
    assert len(rows) == 20
    assert rows[0] == (0, "loss", 1.0)


def test_last_step_reaches_the_hub(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    """beat() does not commit; a flush must follow it, or progress stays at 0.

    A run stuck at step 0 while its metrics arrive normally is the shape of
    this bug, and the liveness check reads the same counter.
    """
    url, cfg = hub
    _write(sender, "r1", range(25))
    ship_once(sender.path, url, token)

    conn = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True)
    try:
        last_step = conn.execute("SELECT last_step FROM runs WHERE id = 'r1'").fetchone()[0]
    finally:
        conn.close()
    assert last_step == 24, f"progress did not land: last_step={last_step}"


def test_the_run_row_is_created_on_the_hub(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    url, cfg = hub
    sender.start_run("r1", "my-sft-run", meta={"model": "qwen0.5b"})
    _write(sender, "r1", range(3))
    ship_once(sender.path, url, token)

    conn = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True)
    try:
        row = conn.execute("SELECT name, meta FROM runs WHERE id = 'r1'").fetchone()
    finally:
        conn.close()
    assert row is not None
    assert "qwen0.5b" in row[1]


def test_shipping_twice_moves_nothing_the_second_time(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    url, cfg = hub
    _write(sender, "r1", range(10))
    first = ship_once(sender.path, url, token)
    second = ship_once(sender.path, url, token)
    assert first.metrics == 20
    assert second.metrics == 0, "the cursor must not re-send shipped rows"
    assert len(_hub_rows(cfg, "r1")) == 20


def test_a_big_backlog_ships_in_batches(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    url, cfg = hub
    _write(sender, "r1", range(60))
    stats = ship_once(sender.path, url, token, batch_rows=25)
    assert stats.batches >= 4, f"expected several batches, got {stats.batches}"
    assert stats.metrics == 120
    assert len(_hub_rows(cfg, "r1")) == 120


def test_gpu_samples_ride_along(sender: Store, hub: tuple[str, Config], token: str) -> None:
    url, cfg = hub
    _write(sender, "r1", range(3))
    sender.add_gpu_samples(
        [{"ts": 1000.0 + i, "gpu_index": 0, "name": "RTX 3050", "mem_used": 1400.0}
         for i in range(5)]
    )
    stats = ship_once(sender.path, url, token)
    assert stats.gpu == 5

    conn = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True)
    try:
        assert conn.execute("SELECT COUNT(*) FROM gpu").fetchone()[0] == 5
    finally:
        conn.close()


def test_events_keep_their_timestamp(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    """The dedupe key is (run_id, ts, rule); re-stamping on arrival breaks it."""
    url, cfg = hub
    _write(sender, "r1", range(2))
    sender.add_event(
        run_id="r1", level="warn", rule="grad_norm", title="spike", ts=12345.0
    )
    ship_once(sender.path, url, token)

    conn = sqlite3.connect(f"file:{cfg.db_path}?mode=ro", uri=True)
    try:
        row = conn.execute("SELECT ts, rule FROM events").fetchone()
    finally:
        conn.close()
    assert row == (12345.0, "grad_norm")


# ── authorisation ────────────────────────────────────────────────────────


def test_ingest_refuses_a_token_without_the_scope(
    sender: Store, hub: tuple[str, Config]
) -> None:
    url, cfg = hub
    with Auth(cfg.db_path) as auth:
        weak = auth.create_token("read-only", {"read"}).secret
    _write(sender, "r1", range(3))
    with pytest.raises(Exception, match="403"):
        ship_once(sender.path, url, weak)


def test_ingest_refuses_an_unauthenticated_post(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    """`token` is requested so an account exists and enforcement is live."""
    _ = token
    url, _cfg = hub
    _write(sender, "r1", range(3))
    with pytest.raises(Exception, match="401"):
        ship_once(sender.path, url, "twk_bogus_token")


def test_nothing_ships_when_the_cursor_is_current(
    sender: Store, hub: tuple[str, Config], token: str
) -> None:
    url, _cfg = hub
    stats = ship_once(sender.path, url, token)
    assert stats.batches == 0
    assert stats.caught_up


# ── the Phase D gate ─────────────────────────────────────────────────────


def test_gate_network_drops_mid_run_no_gaps_no_duplicates(
    sender: Store, tmp_path: Path
) -> None:
    """The Phase D gate: pull the cable mid-run, reconnect, verify.

    Staged as the real failure, not a mocked one. The hub is stopped while the
    trainer keeps writing, then started again on the same port with the same
    database — which is what an Ethernet cable coming out looks like from the
    shipper's side.

    Two assertions, and both matter:

    - **No gaps.** Every metric written during the outage is present
      afterwards. This is the property that makes the local store a spool.
    - **No duplicates.** The batch in flight when the connection died is sent
      again, so the receiver must absorb it. A duplicated metric row would
      silently double a chart, which is worse than a gap because it looks
      plausible.
    """
    cfg = replace(
        Config(
            db_path=tmp_path / "hub.db",
            heartbeat_path=tmp_path / "hb",
            ntfy_topic="",
            sinks=("store",),
            tensorboard_dir=tmp_path / "runs",
            blob_dir=tmp_path / "blobs",
        ),
        allowed_hosts="127.0.0.1,localhost",
    )
    with Auth(cfg.db_path) as auth:
        secret = auth.create_token("tuf-trainer", {"telemetry:write"}).secret

    # ── phase 1: connected. Ship the first 20 steps. ──
    hub = _Hub(cfg)
    url = hub.start()
    _write(sender, "r1", range(20))
    first = ship_once(sender.path, url, secret)
    assert first.metrics == 40
    port = url.rsplit(":", 1)[1]

    # ── phase 2: the cable comes out. Training continues. ──
    hub.stop()
    _write(sender, "r1", range(20, 50))
    with pytest.raises(Exception):  # noqa: B017 - any transport failure will do
        ship_once(sender.path, url, secret)

    # the cursor must NOT have advanced past what was actually accepted
    cursor_db = sqlite3.connect(sender.path)
    try:
        mark = cursor_db.execute(
            "SELECT last_rowid FROM ship_cursor WHERE name = 'metrics'"
        ).fetchone()[0]
    finally:
        cursor_db.close()
    assert mark == 40, f"cursor moved during an outage: {mark}"

    # ── phase 3: the cable goes back in, on the same port and database. ──
    again = _Hub(cfg, port=int(port))
    again.start()
    try:
        _write(sender, "r1", range(50, 60))
        caught_up = ship_once(sender.path, url, secret)
        assert caught_up.metrics == 80, "40 written during the outage + 40 after"

        rows = _hub_rows(cfg, "r1")

        # no duplicates
        assert len(rows) == len(set(rows)) == 120, f"expected 120 unique rows, got {len(rows)}"

        # no gaps: every step 0..59, both keys
        steps = {step for step, _key, _value in rows}
        assert steps == set(range(60)), f"missing steps: {sorted(set(range(60)) - steps)}"
        for step in range(60):
            keys = {k for s, k, _v in rows if s == step}
            assert keys == {"loss", "lr"}, f"step {step} has {keys}"

        # and the values are the ones the trainer wrote, not defaults
        losses = {step: value for step, key, value in rows if key == "loss"}
        assert losses[0] == 1.0
        assert losses[59] == pytest.approx(1.0 / 60)
    finally:
        again.stop()


def test_the_shipper_thread_survives_an_unreachable_hub(sender: Store) -> None:
    """It must retry, not die: a dead shipper means the run goes dark."""
    _write(sender, "r1", range(5))
    shipper = TelemetryShipper(
        sender.path, "http://127.0.0.1:1", "twk_x_y", interval=0.05
    )
    shipper.start()
    try:
        deadline = threading.Event()
        for _ in range(60):
            if shipper.stats.failures >= 2:
                break
            deadline.wait(0.05)
        assert shipper.stats.failures >= 2, "should have retried at least twice"
        assert shipper.stats.last_error, "the error should be visible, not swallowed"
    finally:
        shipper.stop()


def test_stats_report_a_backlog(sender: Store, hub: tuple[str, Config], token: str) -> None:
    url, _cfg = hub
    _write(sender, "r1", range(5))
    before = ShipStats(backlog={"metrics": 10})
    assert not before.caught_up
    after = ship_once(sender.path, url, token)
    assert after.caught_up
    assert after.backlog == {"metrics": 0, "gpu": 0, "events": 0}
