"""Layer 3 — the watchdog rules.

The source guide names three value rules (NaN loss, grad-norm ceiling, entropy
floor) and two things it calls out as important but leaves unimplemented:
`step_time` ("the canary for everything else") and `resid_rms/*` drift
("drift = instability incoming"). Both are implemented here, because both need
a *baseline* rather than a fixed threshold — you cannot know in advance what a
normal step time is for a given model on a given GPU at a given batch size.

Rules are pure: they take a step's values and return verdicts. Deduplication
and rate limiting live in the notifier, so a rule may fire freely.
"""

from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field
from typing import Literal

from .notify import Priority

__all__ = ["RollingBaseline", "RuleConfig", "RuleEngine", "Verdict"]

Level = Literal["info", "warn", "critical"]


@dataclass(frozen=True, slots=True)
class Verdict:
    """One rule firing on one step."""

    rule: str
    level: Level
    title: str
    body: str
    priority: Priority
    fatal: bool = False


@dataclass(slots=True)
class RuleConfig:
    grad_norm_ceil: float = 100.0
    entropy_floor: float = 0.15
    step_time_drift: float = 1.5
    resid_rms_drift: float = 3.0
    attn_logit_max: float = 60.0
    # Steps of baseline collection before drift rules can fire. Early steps are
    # noisy (warmup, compile, cudnn autotune) and would produce false alarms.
    warmup_steps: int = 60


class RollingBaseline:
    """A stable early baseline plus a rolling recent window.

    Drift = recent / baseline. Median rather than mean throughout: a single
    500ms checkpoint-write step should not move the baseline.
    """

    __slots__ = ("_baseline", "_baseline_samples", "_recent", "warmup", "window")

    def __init__(self, warmup: int = 60, window: int = 24) -> None:
        self.warmup = max(4, warmup)
        self.window = max(3, window)
        self._baseline_samples: list[float] = []
        self._baseline: float | None = None
        self._recent: deque[float] = deque(maxlen=self.window)

    def push(self, value: float) -> None:
        if not math.isfinite(value):
            return
        self._recent.append(value)
        if self._baseline is None:
            self._baseline_samples.append(value)
            if len(self._baseline_samples) >= self.warmup:
                # Discard the first quarter — that is warmup/compile noise.
                tail = self._baseline_samples[len(self._baseline_samples) // 4 :]
                self._baseline = statistics.median(tail)

    @property
    def baseline(self) -> float | None:
        return self._baseline

    @property
    def recent(self) -> float | None:
        if len(self._recent) < min(self.window, 3):
            return None
        return statistics.median(self._recent)

    @property
    def ratio(self) -> float | None:
        """recent / baseline, or None until both exist."""
        base, rec = self._baseline, self.recent
        if base is None or rec is None or base <= 0:
            return None
        return rec / base


@dataclass(slots=True)
class RuleEngine:
    """Evaluates every rule against a step's scalars."""

    config: RuleConfig = field(default_factory=RuleConfig)
    _step_time: RollingBaseline = field(init=False)
    _resid: RollingBaseline = field(init=False)
    _fired_once: set[str] = field(init=False, default_factory=set)

    def __post_init__(self) -> None:
        self._step_time = RollingBaseline(warmup=self.config.warmup_steps)
        self._resid = RollingBaseline(warmup=self.config.warmup_steps)

    # ── main entry point ─────────────────────────────────────────────────

    def check(self, step: int, values: dict[str, float]) -> list[Verdict]:
        """Return every verdict triggered by this step. Never raises."""
        verdicts: list[Verdict] = []
        try:
            verdicts.extend(self._check_finite(step, values))
            verdicts.extend(self._check_grad_norm(step, values))
            verdicts.extend(self._check_entropy(step, values))
            verdicts.extend(self._check_step_time(step, values))
            verdicts.extend(self._check_resid_rms(step, values))
            verdicts.extend(self._check_attn_logits(step, values))
        except Exception as exc:  # noqa: BLE001 - a bad rule must not kill the run
            verdicts.append(
                Verdict(
                    rule="engine_error",
                    level="warn",
                    title="watchdog rule error",
                    body=f"{type(exc).__name__}: {exc}",
                    priority="low",
                )
            )
        return verdicts

    # ── individual rules ─────────────────────────────────────────────────

    def _check_finite(self, step: int, values: dict[str, float]) -> list[Verdict]:
        """The one that costs you a night. Any non-finite scalar is terminal."""
        bad = [k for k, v in values.items() if not _finite(v)]
        if not bad:
            return []
        # Loss going non-finite is the headline; everything else is context.
        headline = "loss" if "loss" in bad else bad[0]
        others = [k for k in bad if k != headline]
        body = f"{headline} = NaN/inf @ step {step}"
        if others:
            body += f" (also: {', '.join(others[:5])})"
        return [
            Verdict(
                rule="nonfinite",
                level="critical",
                title="RUN DIVERGED",
                body=body,
                priority="urgent",
                fatal=True,
            )
        ]

    def _check_grad_norm(self, step: int, values: dict[str, float]) -> list[Verdict]:
        gn = values.get("grad_norm")
        if gn is None or not _finite(gn) or gn <= self.config.grad_norm_ceil:
            return []
        return [
            Verdict(
                rule="grad_norm",
                level="warn",
                title="Grad norm spike",
                body=f"grad_norm {gn:.1f} > ceiling {self.config.grad_norm_ceil:.0f} @ step {step}",
                priority="high",
            )
        ]

    def _check_entropy(self, step: int, values: dict[str, float]) -> list[Verdict]:
        ent = values.get("entropy")
        if ent is None or not _finite(ent) or ent >= self.config.entropy_floor:
            return []
        return [
            Verdict(
                rule="entropy",
                level="warn",
                title="Entropy collapse",
                body=f"entropy {ent:.3f} < floor {self.config.entropy_floor:.2f} @ step {step}",
                priority="high",
            )
        ]

    def _check_step_time(self, step: int, values: dict[str, float]) -> list[Verdict]:
        st = values.get("step_time")
        if st is None or not _finite(st):
            return []
        self._step_time.push(st)
        ratio = self._step_time.ratio
        if ratio is None or ratio < self.config.step_time_drift:
            return []
        base = self._step_time.baseline or 0.0
        return [
            Verdict(
                rule="step_time",
                level="warn",
                title="Step time drifting",
                body=(
                    f"step_time {_ms(st)} is {ratio:.2f}x the baseline "
                    f"{_ms(base)} @ step {step} — check GPU clock/temp before blaming code"
                ),
                priority="default",
            )
        ]

    def _check_resid_rms(self, step: int, values: dict[str, float]) -> list[Verdict]:
        """Per-layer activation scale. Drift here precedes the loss blowing up."""
        layers = {k: v for k, v in values.items() if k.startswith("resid_rms/") and _finite(v)}
        if not layers:
            return []
        peak_key, peak = max(layers.items(), key=lambda kv: kv[1])
        self._resid.push(peak)
        ratio = self._resid.ratio
        if ratio is None or ratio < self.config.resid_rms_drift:
            return []
        base = self._resid.baseline or 0.0
        return [
            Verdict(
                rule="resid_rms",
                level="warn",
                title="Activation scale drift",
                body=(
                    f"{peak_key} = {peak:.3f}, {ratio:.1f}x its baseline {base:.3f} "
                    f"@ step {step} — instability incoming"
                ),
                priority="high",
            )
        ]

    def _check_attn_logits(self, step: int, values: dict[str, float]) -> list[Verdict]:
        layers = {k: v for k, v in values.items() if k.startswith("attn_logit_max/") and _finite(v)}
        if not layers:
            return []
        peak_key, peak = max(layers.items(), key=lambda kv: kv[1])
        if peak <= self.config.attn_logit_max:
            return []
        return [
            Verdict(
                rule="attn_logit_max",
                level="warn",
                title="Attention logit spike",
                body=f"{peak_key} = {peak:.1f} > {self.config.attn_logit_max:.0f} @ step {step}",
                priority="high",
            )
        ]


def _finite(value: float | None) -> bool:
    return value is not None and isinstance(value, (int, float)) and math.isfinite(value)


def _ms(seconds: float) -> str:
    """Seconds → a duration that stays readable across six orders of magnitude.

    Naively formatting as `{s*1000:.0f}ms` turns every sub-millisecond step into
    "0ms", which makes the drift alert unreadable exactly on the fast synthetic
    runs people use to test their alerting.
    """
    ms = seconds * 1000
    if ms >= 1000:
        return f"{seconds:.2f}s"
    if ms >= 10:
        return f"{ms:.0f}ms"
    if ms >= 0.1:
        return f"{ms:.2f}ms"
    return f"{ms * 1000:.0f}µs"
