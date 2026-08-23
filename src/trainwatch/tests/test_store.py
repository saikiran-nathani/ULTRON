"""The SQLite bus: buffering, downsampling, and cross-process concurrency."""

from __future__ import annotations

import math
import time
from pathlib import Path

import pytest

from src.trainwatch.store import Store


def test_run_lifecycle(store: Store) -> None:
    store.start_run("r1", "my-run", meta={"model": "gpt"})
    run = store.run("r1")
    assert run is not None
    assert run["status"] == "running"
    assert run["meta"] == {"model": "gpt"}

    store.finish_run("r1", "finished")
    run = store.run("r1")
    assert run is not None
    assert run["status"] == "finished"
    assert run["ended_at"] is not None


def test_watermark_is_stable_when_nothing_changes(store: Store) -> None:
    """The SSE stream skips a push when this does not move, so a false
    positive here restores the every-2s full-snapshot behaviour it replaced."""
    store.start_run("r1", "run")
    first = store.watermark()
    assert store.watermark() == first
    assert store.watermark() == first


def _write_metric(s: Store) -> None:
    s.log_metrics("r1", 1, {"loss": 0.5})
    s.flush()


def _write_event(s: Store) -> None:
    s.add_event(run_id="r1", level="warn", rule="r", title="t")


def _write_gpu(s: Store) -> None:
    s.add_gpu_samples([{"gpu_index": 0, "temp": 60.0}])


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(_write_metric, id="metric"),
        pytest.param(_write_event, id="event"),
        pytest.param(_write_gpu, id="gpu-sample"),
        pytest.param(lambda s: s.beat("r1", 42), id="heartbeat-step"),
        pytest.param(lambda s: s.finish_run("r1", "failed"), id="run-status"),
        pytest.param(lambda s: s.start_run("r2", "second"), id="new-run"),
    ],
)
def test_watermark_moves_on_every_kind_of_write(store: Store, mutate) -> None:
    """Each of these changes what the snapshot would contain.

    `beat` and `finish_run` are the ones worth having: they UPDATE a row in
    place, so MAX(rowid) alone would miss them and a finished run would keep
    rendering as running until the 15s forced refresh caught up.
    """
    store.start_run("r1", "run")
    before = store.watermark()
    mutate(store)
    assert store.watermark() != before


def test_latest_run_prefers_a_live_run_over_a_newer_finished_one(store: Store) -> None:
    """The dashboard should open on what is running, not on what started last."""
    store.start_run("old", "still-going")
    time.sleep(0.01)
    store.start_run("new", "already-done")
    store.finish_run("new", "finished")

    latest = store.latest_run()
    assert latest is not None
    assert latest["id"] == "old"


def test_metrics_buffer_then_flush(tmp_path: Path) -> None:
    s = Store(tmp_path / "t.db", flush_interval=999, batch_rows=999)
    s.start_run("r", "r")
    s.log_metrics("r", 0, {"loss": 1.0})
    assert s.series("r", ["loss"])["loss"] == []  # still buffered
    s.flush()
    assert len(s.series("r", ["loss"])["loss"]) == 1
    s.close()


def test_buffer_auto_flushes_on_size(tmp_path: Path) -> None:
    s = Store(tmp_path / "t.db", flush_interval=999, batch_rows=10)
    s.start_run("r", "r")
    for i in range(20):
        s.log_metrics("r", i, {"loss": float(i)})
    assert len(s.series("r", ["loss"])["loss"]) >= 10
    s.close()


def test_nonfinite_metrics_are_not_stored(store: Store) -> None:
    """NaN silently becomes NULL in SQLite and then poisons AVG() in bucketing."""
    store.start_run("r", "r")
    store.log_metrics("r", 0, {"loss": 1.0, "bad": math.nan, "worse": math.inf})
    store.flush()
    assert store.metric_keys("r") == ["loss"]


def test_series_downsamples_to_the_requested_budget(store: Store) -> None:
    store.start_run("r", "r")
    for i in range(5000):
        store.log_metrics("r", i, {"loss": float(i)})
    store.flush()

    pts = store.series("r", ["loss"], points=100)["loss"]
    assert 50 <= len(pts) <= 101, f"got {len(pts)} points for a budget of 100"
    steps = [p[0] for p in pts]
    assert steps == sorted(steps), "x-axis must stay monotonic after bucketing"


def test_series_returns_everything_when_under_budget(store: Store) -> None:
    store.start_run("r", "r")
    for i in range(10):
        store.log_metrics("r", i, {"loss": float(i)})
    store.flush()
    assert len(store.series("r", ["loss"], points=240)["loss"]) == 10


def test_series_for_an_unknown_key_is_empty_not_an_error(store: Store) -> None:
    store.start_run("r", "r")
    assert store.series("r", ["nope"]) == {"nope": []}


def test_latest_values_picks_the_max_step_per_key(store: Store) -> None:
    store.start_run("r", "r")
    store.log_metrics("r", 0, {"loss": 9.0, "lr": 1e-3})
    store.log_metrics("r", 9, {"loss": 1.0})  # lr not logged again
    store.flush()
    assert store.latest_values("r", ["loss", "lr"]) == {"loss": 1.0, "lr": 1e-3}


def test_events_round_trip(store: Store) -> None:
    store.start_run("r", "r")
    store.add_event(run_id="r", level="warn", rule="grad_norm", title="t", body="b", step=5)
    (e,) = store.events()
    assert e["rule"] == "grad_norm"
    assert e["step"] == 5
    assert e["notified"] == 0


def test_gpu_latest_returns_one_row_per_device(store: Store) -> None:
    now = time.time()
    store.add_gpu_samples(
        [
            {"ts": now - 10, "gpu_index": 0, "temp": 50},
            {"ts": now, "gpu_index": 0, "temp": 80},
            {"ts": now, "gpu_index": 1, "temp": 60},
        ]
    )
    latest = store.gpu_latest()
    assert [g["gpu_index"] for g in latest] == [0, 1]
    assert latest[0]["temp"] == 80


def test_two_connections_see_each_others_writes(tmp_path: Path) -> None:
    """WAL is what lets the server read a database the trainer is writing."""
    writer = Store(tmp_path / "t.db", flush_interval=0.0)
    reader = Store(tmp_path / "t.db")

    writer.start_run("r", "r")
    writer.log_metrics("r", 0, {"loss": 1.0})
    writer.flush()

    assert reader.run("r") is not None
    assert len(reader.series("r", ["loss"])["loss"]) == 1

    writer.close()
    reader.close()


def test_prune_drops_old_finished_runs_metrics_but_keeps_the_run(store: Store) -> None:
    store.start_run("old", "old")
    store.log_metrics("old", 0, {"loss": 1.0})
    store.flush()
    store.finish_run("old", "finished")
    # Backdate the run past the cutoff.
    store._db.execute("UPDATE runs SET ended_at = ? WHERE id = 'old'", (time.time() - 86400 * 90,))
    store._db.commit()

    store.prune(keep_days=30)
    assert store.run("old") is not None, "run history should survive a prune"
    assert store.series("old", ["loss"])["loss"] == []


def test_store_is_a_context_manager(tmp_path: Path) -> None:
    with Store(tmp_path / "t.db") as s:
        s.start_run("r", "r")
        s.log_metrics("r", 0, {"loss": 1.0})
    # closing flushed the buffer
    with Store(tmp_path / "t.db") as s:
        assert len(s.series("r", ["loss"])["loss"]) == 1


@pytest.mark.parametrize("value", ["not a number", None, object()])
def test_junk_metric_values_are_dropped_not_raised(store: Store, value: object) -> None:
    store.start_run("r", "r")
    store.log_metrics("r", 0, {"loss": 1.0, "junk": value})  # type: ignore[dict-item]
    store.flush()
    assert store.metric_keys("r") == ["loss"]
