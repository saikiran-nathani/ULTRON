"""The watchdog. These rules are the reason the system exists."""

from __future__ import annotations

import math

import pytest

from src.trainwatch.rules import RollingBaseline, RuleConfig, RuleEngine


def engine(**kw: float) -> RuleEngine:
    return RuleEngine(RuleConfig(warmup_steps=8, **kw))  # type: ignore[arg-type]


# ── the one that costs you a night ───────────────────────────────────────


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf")])
def test_nonfinite_loss_is_fatal_and_urgent(bad: float) -> None:
    verdicts = engine().check(42, {"loss": bad})
    assert len(verdicts) == 1
    v = verdicts[0]
    assert v.rule == "nonfinite"
    assert v.fatal is True
    assert v.priority == "urgent"
    assert "42" in v.body


def test_nonfinite_names_loss_first_even_when_other_keys_also_blew_up() -> None:
    (v,) = engine().check(7, {"grad_norm": float("nan"), "loss": float("nan")})
    assert v.body.startswith("loss = NaN/inf")
    assert "grad_norm" in v.body


def test_finite_values_produce_nothing() -> None:
    assert engine().check(1, {"loss": 2.5, "grad_norm": 1.0, "lr": 3e-4}) == []


# ── threshold rules ──────────────────────────────────────────────────────


def test_grad_norm_ceiling() -> None:
    e = engine(grad_norm_ceil=100.0)
    assert e.check(1, {"grad_norm": 99.9}) == []
    (v,) = e.check(2, {"grad_norm": 100.1})
    assert v.rule == "grad_norm"
    assert v.priority == "high"
    assert not v.fatal


def test_entropy_floor_detects_collapse() -> None:
    e = engine(entropy_floor=0.15)
    assert e.check(1, {"entropy": 0.16}) == []
    (v,) = e.check(2, {"entropy": 0.02})
    assert v.rule == "entropy"


def test_attn_logit_spike_reports_the_worst_layer() -> None:
    e = engine(attn_logit_max=60.0)
    (v,) = e.check(3, {"attn_logit_max/layer_0": 12.0, "attn_logit_max/layer_4": 91.0})
    assert "layer_4" in v.body
    assert "91" in v.body


# ── baseline-relative rules ──────────────────────────────────────────────


def test_step_time_needs_a_baseline_before_it_can_fire() -> None:
    """A cold rule must not alert during warmup — that is a false-alarm factory."""
    e = engine(step_time_drift=1.5)
    # Even an enormous value can't fire before the baseline exists.
    assert e.check(0, {"step_time": 99.0}) == []


def test_step_time_fires_once_drifted_past_its_own_baseline() -> None:
    e = engine(step_time_drift=1.5)
    for i in range(40):
        assert e.check(i, {"step_time": 0.100}) == []
    fired = []
    for i in range(40, 80):
        fired += e.check(i, {"step_time": 0.400})
    assert fired, "4x slower than baseline should trip the canary"
    assert fired[0].rule == "step_time"
    assert "GPU clock" in fired[0].body


def test_step_time_message_survives_sub_millisecond_steps() -> None:
    """Formatting `0.00002s` as `{s*1000:.0f}ms` renders '0ms' and is useless."""
    e = engine(step_time_drift=1.5)
    for i in range(40):
        e.check(i, {"step_time": 0.00002})
    fired = []
    for i in range(40, 80):
        fired += e.check(i, {"step_time": 0.0002})
    assert fired
    body = fired[0].body
    # Both magnitudes must render as something you can act on, not "0ms".
    assert " 0ms" not in body
    assert "0.20ms" in body  # the current step
    assert "20µs" in body  # the baseline it is being compared against


def test_resid_rms_drift_uses_the_peak_layer() -> None:
    e = engine(resid_rms_drift=3.0)
    for i in range(40):
        e.check(i, {"resid_rms/layer_0": 1.0, "resid_rms/layer_1": 1.1})
    fired = []
    for i in range(40, 80):
        fired += e.check(i, {"resid_rms/layer_0": 1.0, "resid_rms/layer_1": 9.0})
    assert fired
    assert fired[0].rule == "resid_rms"
    assert "layer_1" in fired[0].body


def test_a_broken_rule_cannot_kill_the_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """A bug in one rule must degrade to a warning, never propagate into the loop."""

    def boom(*_a: object, **_k: object) -> list[object]:
        raise ValueError("rule exploded")

    # RuleEngine is a slots dataclass, so patch the class, not the instance.
    monkeypatch.setattr(RuleEngine, "_check_grad_norm", boom)
    verdicts = engine().check(1, {"loss": 1.0})
    assert [v.rule for v in verdicts] == ["engine_error"]
    assert "ValueError" in verdicts[0].body


# ── the baseline primitive ───────────────────────────────────────────────


def test_rolling_baseline_ignores_warmup_noise() -> None:
    """The first quarter of samples is compile/autotune noise and is discarded."""
    b = RollingBaseline(warmup=8, window=4)
    for v in [10.0, 10.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0]:
        b.push(v)
    assert b.baseline == pytest.approx(1.0)


def test_rolling_baseline_is_median_not_mean() -> None:
    b = RollingBaseline(warmup=8, window=8)
    for v in [1.0] * 7 + [1000.0]:
        b.push(v)
    assert b.baseline == pytest.approx(1.0)  # a mean would be ~125


def test_rolling_baseline_ratio_is_none_until_ready() -> None:
    b = RollingBaseline(warmup=8, window=4)
    assert b.ratio is None
    b.push(1.0)
    assert b.ratio is None


def test_rolling_baseline_skips_nonfinite() -> None:
    b = RollingBaseline(warmup=4, window=4)
    for v in [1.0, math.nan, 1.0, math.inf, 1.0, 1.0]:
        b.push(v)
    assert b.baseline is not None
    assert math.isfinite(b.baseline)
