"""TrainMonitor's contract with the training loop.

The overriding rule: monitoring must never be the reason a run fails. The one
deliberate exception is the divergence abort, which is what the guide asks for.
"""

from __future__ import annotations

import math
from dataclasses import replace
from typing import Any

import pytest

from src.trainwatch.config import Config
from src.trainwatch.emit import Emitter
from src.trainwatch.monitor import DivergenceError, TrainMonitor, _coerce
from src.trainwatch.notify import NullNotifier
from src.trainwatch.rules import RuleEngine
from src.trainwatch.store import Store


def monitor(cfg: Config, **kw: Any) -> TrainMonitor:
    return TrainMonitor("t", config=cfg, notifier=NullNotifier(), **kw)


# ── never break training ─────────────────────────────────────────────────


def test_a_broken_sink_does_not_break_the_loop(cfg: Config) -> None:
    class Exploding:
        name = "boom"

        def log(self, step: int, values: dict[str, float]) -> None:
            raise RuntimeError("sink is on fire")

        def close(self) -> None:
            raise RuntimeError("still on fire")

    tw = monitor(cfg)
    tw.emitter = Emitter([Exploding()])  # type: ignore[list-item]
    for i in range(10):
        tw.log({"loss": 1.0}, step=i)  # must not raise
    tw.finish()


def test_a_sink_that_keeps_failing_is_disabled_not_retried_forever(cfg: Config) -> None:
    calls = {"n": 0}

    class Flaky:
        name = "flaky"

        def log(self, step: int, values: dict[str, float]) -> None:
            calls["n"] += 1
            raise RuntimeError("nope")

        def close(self) -> None:
            pass

    e = Emitter([Flaky()])  # type: ignore[list-item]
    for i in range(50):
        e.log(i, {"loss": 1.0})
    assert calls["n"] == 3, "should give up after 3 consecutive failures"
    assert e.active == []


def test_store_sink_is_forced_on_even_if_config_omits_it(cfg: Config) -> None:
    """A typo in TRAINWATCH_SINKS must not produce a run the iPad cannot see."""
    tw = TrainMonitor("t", config=replace(cfg, sinks=("tpyo",)), notifier=NullNotifier())
    assert "store" in tw.emitter.active
    tw.finish()


def test_log_swallows_internal_errors(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> list[object]:
        raise OSError("rules exploded")

    # RuleEngine is a slots dataclass; patch the class, not the instance.
    monkeypatch.setattr(RuleEngine, "check", boom)
    tw = monitor(cfg)
    assert tw.log({"loss": 1.0}, step=0) == []
    tw.finish()


# ── the one deliberate exception ─────────────────────────────────────────


def test_nan_loss_aborts_the_run_by_default(cfg: Config) -> None:
    tw = monitor(cfg)
    tw.log({"loss": 1.0}, step=0)
    with pytest.raises(DivergenceError, match="NaN/inf"):
        tw.log({"loss": math.nan}, step=1)

    with Store(cfg.db_path) as s:
        run = s.run(tw.run_id)
        assert run is not None
        assert run["status"] == "failed"


def test_divergence_can_be_downgraded_to_an_alert(cfg: Config) -> None:
    tw = monitor(cfg, raise_on_diverge=False)
    verdicts = tw.log({"loss": math.nan}, step=1)
    assert [v.rule for v in verdicts] == ["nonfinite"]
    assert tw.notifier.sent == 1
    tw.finish()


def test_the_urgent_alert_is_flushed_before_the_exception_unwinds(cfg: Config) -> None:
    """`alert(); raise` is worthless if the process dies with the alert queued."""
    tw = monitor(cfg)
    with pytest.raises(DivergenceError):
        tw.log({"loss": math.inf}, step=0)
    msgs = tw.notifier.messages  # type: ignore[attr-defined]
    assert any(m.priority == "urgent" for m in msgs)


# ── context manager ──────────────────────────────────────────────────────


def test_clean_exit_marks_finished(cfg: Config) -> None:
    with monitor(cfg) as tw:
        tw.log({"loss": 1.0}, step=0)
        run_id = tw.run_id
    with Store(cfg.db_path) as s:
        assert s.run(run_id)["status"] == "finished"  # type: ignore[index]


def test_an_exception_marks_failed_and_pages_you(cfg: Config) -> None:
    """This is the catch that earns its keep: CUDA OOM, dataloader crashes,
    NCCL timeouts — failures that otherwise leave a dead pane and silence."""
    tw = monitor(cfg)
    with pytest.raises(RuntimeError), tw:
        raise RuntimeError("CUDA out of memory")

    with Store(cfg.db_path) as s:
        assert s.run(tw.run_id)["status"] == "failed"  # type: ignore[index]
    msg = tw.notifier.messages[-1]  # type: ignore[attr-defined]
    assert msg.priority == "urgent"
    assert "CUDA out of memory" in msg.body


def test_keyboard_interrupt_does_not_page_you(cfg: Config) -> None:
    """You stopped it on purpose. Paging yourself teaches you to ignore alerts."""
    tw = monitor(cfg)
    with pytest.raises(KeyboardInterrupt), tw:
        raise KeyboardInterrupt
    with Store(cfg.db_path) as s:
        assert s.run(tw.run_id)["status"] == "stopped"  # type: ignore[index]
    assert not any(m.priority == "urgent" for m in tw.notifier.messages)  # type: ignore[attr-defined]


def test_finish_is_idempotent(cfg: Config) -> None:
    tw = monitor(cfg)
    tw.finish()
    tw.finish()  # must not raise or double-alert


# ── step_time and value coercion ─────────────────────────────────────────


def test_step_time_is_measured_when_not_supplied(cfg: Config) -> None:
    tw = monitor(cfg)
    for i in range(4):
        tw.log({"loss": 1.0}, step=i)
    tw.store.flush()
    assert "step_time" in tw.store.metric_keys(tw.run_id)
    tw.finish()


def test_a_supplied_step_time_wins(cfg: Config) -> None:
    tw = monitor(cfg)
    tw.log({"loss": 1.0, "step_time": 0.5}, step=0)
    tw.log({"loss": 1.0, "step_time": 0.5}, step=1)
    tw.store.flush()
    assert tw.store.latest_values(tw.run_id, ["step_time"])["step_time"] == 0.5
    tw.finish()


class _FakeTensor:
    """Duck-types torch.Tensor / numpy scalar without importing either."""

    def __init__(self, v: float) -> None:
        self._v = v

    def item(self) -> float:
        return self._v


def test_coerce_unwraps_tensor_likes() -> None:
    assert _coerce({"loss": _FakeTensor(2.5)}) == {"loss": 2.5}


def test_coerce_drops_junk_rather_than_raising() -> None:
    """A stray string in a log dict is not worth killing a run over."""
    assert _coerce({"loss": 1.0, "note": "epoch 3", "obj": object()}) == {"loss": 1.0}


def test_coerce_preserves_nonfinite_so_the_rules_can_see_them() -> None:
    out = _coerce({"loss": float("nan")})
    assert math.isnan(out["loss"])
