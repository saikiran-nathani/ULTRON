"""`TrainMonitor` — the one object you put in your training loop.

    from trainwatch import TrainMonitor

    with TrainMonitor("run_042") as tw:
        for step in range(steps):
            ...
            tw.log({"loss": loss.item(), "grad_norm": gn, "lr": lr}, step=step)

That single call does all four layers' worth of work for you: writes the
scalars to every configured sink, evaluates the watchdog rules, emits the
heartbeat, and pushes an alert when something is wrong.

Design constraints, in priority order:
  1. Never raise from monitoring code. The only exception this class raises on
     purpose is the divergence abort (see `raise_on_diverge`), which is the
     behaviour the source guide asks for explicitly.
  2. Never block. The notifier is asynchronous; the store batches.
  3. Never require anything. With no .env, no ntfy topic and no GPU, this still
     works — it just does less.
"""

from __future__ import annotations

import logging
import time
import traceback
from pathlib import Path
from types import TracebackType
from typing import Any

from .config import Config, load_config
from .emit import Emitter, build_emitter
from .heartbeat import write_heartbeat
from .notify import Notifier, Priority
from .rules import RuleConfig, RuleEngine, Verdict
from .store import Store

__all__ = ["TrainMonitor"]

log = logging.getLogger("trainwatch")


class DivergenceError(RuntimeError):
    """Raised when a non-finite scalar is logged and `raise_on_diverge` is set."""


class TrainMonitor:
    """Instrumentation for one training run."""

    def __init__(
        self,
        run_name: str | None = None,
        *,
        config: Config | None = None,
        meta: dict[str, Any] | None = None,
        heartbeat_every: int = 25,
        auto_step_time: bool = True,
        raise_on_diverge: bool = True,
        rule_config: RuleConfig | None = None,
        notifier: Notifier | None = None,
    ) -> None:
        """
        Args:
            run_name: human label. Defaults to a timestamp.
            config: resolved `Config`; loaded from env/.env when omitted.
            meta: arbitrary JSON-able run metadata (model, batch size, commit).
            heartbeat_every: write proof-of-life every N steps.
            auto_step_time: derive `step_time` from wall clock between `log()`
                calls when the caller does not supply it. Makes the source
                guide's "canary for everything else" free.
            raise_on_diverge: abort the run on a NaN/inf scalar. This is the
                guide's own `raise RuntimeError("loss diverged")`, on by default
                because a diverged run that keeps burning GPU is the failure
                this whole system exists to prevent. Set False to only alert.
            notifier: inject a custom/None notifier (tests, or a second channel).
        """
        self.config = config or load_config()
        self.run_name = run_name or time.strftime("run_%Y%m%d_%H%M%S")
        self.run_id = f"{self.run_name}-{int(time.time())}"
        self.heartbeat_every = max(1, heartbeat_every)
        self.auto_step_time = auto_step_time
        self.raise_on_diverge = raise_on_diverge

        self.store = Store(self.config.db_path)
        self.store.start_run(self.run_id, self.run_name, meta=meta)

        self.notifier = notifier if notifier is not None else self._build_notifier()
        self.rules = RuleEngine(rule_config or self._rule_config_from(self.config))
        self.emitter: Emitter = build_emitter(
            self.config.sinks,
            store=self.store,
            run_id=self.run_id,
            run_name=self.run_name,
            tensorboard_dir=self.config.tensorboard_dir,
            wandb_project=self.config.wandb_project,
        )

        self._last_log_wall: float | None = None
        self._steps_logged = 0
        self._closed = False

        log.info(
            "trainwatch run %s started · sinks=%s · notify=%s",
            self.run_id,
            ",".join(self.emitter.active),
            "on" if self.notifier.enabled else "off",
        )
        write_heartbeat(self.config.heartbeat_path, run_id=self.run_id, step=0)

    # ── the call you make every step ─────────────────────────────────────

    def log(self, values: dict[str, Any], step: int) -> list[Verdict]:
        """Record a step. Returns the verdicts that fired (usually empty).

        Raises `DivergenceError` only when a non-finite value is seen and
        `raise_on_diverge` is True.
        """
        fatal: Verdict | None = None
        try:
            clean = _coerce(values)
            if self.auto_step_time and "step_time" not in clean:
                now = time.perf_counter()
                if self._last_log_wall is not None:
                    clean["step_time"] = now - self._last_log_wall
                self._last_log_wall = now

            verdicts = self.rules.check(step, clean)
            self.emitter.log(step, clean)
            self._steps_logged += 1

            if step % self.heartbeat_every == 0:
                write_heartbeat(self.config.heartbeat_path, run_id=self.run_id, step=step)

            for v in verdicts:
                self._dispatch(v, step)
                if v.fatal:
                    fatal = v
        except DivergenceError:
            raise
        except Exception:
            log.exception("trainwatch.log failed; training continues")
            return []

        if fatal is not None and self.raise_on_diverge:
            # Give the urgent alert a moment to leave the box before we unwind.
            self.notifier.flush(timeout=5.0)
            self.finish(status="failed")
            raise DivergenceError(fatal.body)
        return verdicts

    # ── manual alerting ──────────────────────────────────────────────────

    def alert(
        self, message: str, *, title: str | None = None, priority: Priority = "default"
    ) -> bool:
        """Send an ad-hoc alert (e.g. 'epoch 3 done, val acc 0.81')."""
        full_title = title or self.run_name
        row = self.store.run(self.run_id)
        notified = self.notifier.alert(message, title=full_title, priority=priority, rule="manual")
        self.store.add_event(
            run_id=self.run_id,
            level="info",
            rule="manual",
            title=full_title,
            body=message,
            step=int(row["last_step"]) if row else None,
            notified=notified,
        )
        return notified

    # ── lifecycle ────────────────────────────────────────────────────────

    def finish(self, status: str = "finished", *, summary: str = "") -> None:
        """Close sinks, mark the run done, and send a completion alert."""
        if self._closed:
            return
        self._closed = True
        try:
            self.emitter.close()
            self.store.finish_run(self.run_id, status=status)
            write_heartbeat(self.config.heartbeat_path, run_id=self.run_id, step=self._steps_logged)

            if status == "finished":
                body = summary or f"{self._steps_logged} steps logged"
                self.notifier.alert(
                    body,
                    title=f"{self.run_name} finished",
                    priority="default",
                    rule="run_finished",
                )
            elif status == "failed":
                self.notifier.alert(
                    summary or "run ended in failure",
                    title=f"{self.run_name} FAILED",
                    priority="urgent",
                    rule="run_failed",
                )
        except Exception:
            log.exception("trainwatch.finish encountered an error")
        finally:
            self.notifier.close(timeout=8.0)
            self.store.close()
            log.info("trainwatch run %s closed (%s)", self.run_id, status)

    def __enter__(self) -> TrainMonitor:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        if exc_type is None:
            self.finish("finished")
            return

        if isinstance(exc, KeyboardInterrupt):
            # You stopped it on purpose; don't page yourself about it.
            self.finish("stopped", summary="interrupted from the keyboard")
            return

        # This is the catch that earns its keep: CUDA OOM, dataloader crashes,
        # NCCL timeouts — the failures that otherwise leave you a dead tmux pane
        # and no notification.
        where = ""
        if tb is not None:
            frame = traceback.extract_tb(tb)[-1]
            where = f" at {Path(frame.filename).name}:{frame.lineno}"
        self.finish("failed", summary=f"{exc_type.__name__}: {exc}{where}")

    # ── internals ────────────────────────────────────────────────────────

    def _dispatch(self, v: Verdict, step: int) -> None:
        """Persist a verdict as an event and push it to the phone."""
        notified = self.notifier.alert(
            v.body,
            title=f"{self.run_name} · {v.title}",
            priority=v.priority,
            rule=v.rule,
        )
        self.store.add_event(
            run_id=self.run_id,
            level=v.level,
            rule=v.rule,
            title=v.title,
            body=v.body,
            step=step,
            notified=notified,
        )
        log.warning("[%s] %s — %s", v.level, v.title, v.body)

    def _build_notifier(self) -> Notifier:
        if not self.config.notify_enabled:
            log.warning(
                "TRAINWATCH_NTFY_TOPIC is unset — alerts will be recorded in the "
                "dashboard but NOT pushed to your phone. This is layer 3 of 4; "
                "see .env.example."
            )
        return Notifier(self.config.ntfy_url, token=self.config.ntfy_token)

    @staticmethod
    def _rule_config_from(cfg: Config) -> RuleConfig:
        return RuleConfig(
            grad_norm_ceil=cfg.grad_norm_ceil,
            entropy_floor=cfg.entropy_floor,
            step_time_drift=cfg.step_time_drift,
        )


def _coerce(values: dict[str, Any]) -> dict[str, float]:
    """Turn whatever the training loop passed into plain floats.

    Accepts torch tensors, numpy scalars and python numbers without importing
    torch or numpy — `.item()` is duck-typed. Non-numeric values are dropped
    rather than raising, because a stray string in a log dict is not worth
    killing a run over. NaN/inf are preserved so the rules engine can see them.
    """
    out: dict[str, float] = {}
    for key, raw in values.items():
        value = raw
        item = getattr(value, "item", None)
        if callable(item):
            try:
                value = item()
            except Exception:
                # e.g. someone logged a whole tensor rather than a reduction.
                # Skip the key, but say so — a metric silently missing from the
                # dashboard is a confusing way to find out.
                log.debug("could not call .item() on metric %r; skipping", key, exc_info=True)
                continue
        try:
            out[str(key)] = float(value)
        except (TypeError, ValueError):
            log.debug("dropping non-numeric metric %r=%r", key, raw)
    return out
