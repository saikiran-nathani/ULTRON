"""ULTRON's binding to trainwatch.

trainwatch (`src/trainwatch/`) is the telemetry half of this project: SQLite
store, watchdog rules, ntfy alerts, and the iPad dashboard. It used to be a
nested git repo at `Monitoring/`, installed editable; it is now first-party
source. This module stays the only place ULTRON reaches into it, so the
coupling is still one import deep -- and the fallback below still matters,
because a broken TRAINWATCH_* var can fail at runtime even when the import
itself cannot.

Two things it adds on top of `TrainMonitor`:

1. **Degrade, never block.** trainwatch is optional at runtime. If it is not
   importable, or its config is broken, training still starts — you lose the
   dashboard, not the run. That mirrors trainwatch's own promise (its core has
   zero third-party dependencies for exactly this reason, asserted by
   src/trainwatch/tests/test_zero_dependency_core.py) and it matters more
   here, where a run is 20-40 minutes at 0.5B and hours at 1.5B.

2. **Phase-aware naming.** The pipeline is
   `sandbox -> eval -> baseline -> data -> SFT -> RFT -> DPO -> GRPO -> repair -> merge -> serve`
   and every phase from SFT on trains a model. Naming runs `<phase>-<model>-<tag>`
   keeps them sorted and comparable in the dashboard's run picker instead of
   being a wall of timestamps.

Plain loop::

    from src.train.monitor import ultron_monitor

    with ultron_monitor("sft", model="Qwen2.5-Coder-0.5B", tag="lr2e4") as tw:
        for step in range(total):
            tw.log({"loss": loss, "grad_norm": gn, "lr": lr}, step=step)

HF/TRL, which owns its own loop::

    with ultron_monitor("sft", model=..., meta={"config": "configs/sft-0.5b.yaml"}) as tw:
        trainer.add_callback(trainwatch_callback(tw))
        trainer.train()
"""

from __future__ import annotations

import logging
import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

log = logging.getLogger("ultron.monitor")

__all__ = ["HEADLINE_KEYS", "trainwatch_available", "trainwatch_callback", "ultron_monitor"]

# The scalars trainwatch's dashboard promotes to its hero row, in its order.
# Emitting these exact names is what makes the headline strip populate rather
# than show dashes; anything else still lands, just one level down.
HEADLINE_KEYS = ("loss", "grad_norm", "lr", "entropy", "step_time")


def trainwatch_available() -> bool:
    """True when the package imports. Cheap enough to call at start-up."""
    try:
        from src import trainwatch  # noqa: F401
    except Exception:
        return False
    return True


class _NullMonitor:
    """Stand-in with TrainMonitor's shape, for when trainwatch is unavailable.

    Deliberately not an exception, and not a warning per step: the run proceeds,
    instrumented to nowhere. A monitoring dependency that can abort a six-hour
    job has inverted its own purpose.
    """

    run_id = "unmonitored"
    run_name = "unmonitored"

    def log(self, values: dict[str, Any], step: int) -> list[Any]:
        return []

    def alert(self, message: str, **_: Any) -> bool:
        return False

    def finish(self, status: str = "finished", *, summary: str = "") -> None:
        return None

    def __enter__(self) -> _NullMonitor:
        return self

    def __exit__(self, *_exc: object) -> None:
        return None


@contextmanager
def ultron_monitor(
    phase: str,
    *,
    model: str,
    tag: str = "",
    meta: dict[str, Any] | None = None,
    db_path: str | os.PathLike[str] | None = None,
    raise_on_diverge: bool = True,
    enabled: bool = True,
) -> Iterator[Any]:
    """A TrainMonitor for one ULTRON phase, or a no-op when trainwatch is absent.

    Args:
        phase: pipeline stage — sft | rft | dpo | grpo | repair.
        model: the student being trained, e.g. "Qwen2.5-Coder-0.5B".
        tag: free-form discriminator for an ablation ("lr3e4", "seed1").
        meta: extra run metadata. Put the config filename here — a run whose
            config is not recorded is a run you cannot reproduce.
        db_path: override TRAINWATCH_DB. The trainer and `trainwatch serve` must
            point at the SAME file, and the server has to run on the machine
            doing the training.
        raise_on_diverge: abort on a non-finite scalar. On by default: a
            diverged run that keeps burning the GPU is the failure this exists
            to prevent.
        enabled: False skips instrumentation entirely (unit tests).
    """
    short = model.rsplit("/", 1)[-1]
    run_name = "-".join(p for p in (phase, short, tag) if p)

    if not enabled or not trainwatch_available():
        if enabled:
            log.warning(
                "trainwatch not importable — running unmonitored. It is "
                "first-party source at src/trainwatch/, so this means the "
                "process is not running from the repository root."
            )
        yield _NullMonitor()
        return

    from src.trainwatch import TrainMonitor, load_config

    try:
        if db_path is not None:
            # Set before load_config, so the .env fallback cannot win.
            os.environ["TRAINWATCH_DB"] = str(db_path)
        config = load_config()
        monitor = TrainMonitor(
            run_name,
            config=config,
            meta={"phase": phase, "model": model, **(meta or {})},
            raise_on_diverge=raise_on_diverge,
        )
    except Exception:
        # A broken TRAINWATCH_* var, an unwritable db path, a bad ntfy topic —
        # none of these are worth refusing to train over.
        log.exception("trainwatch failed to start — running unmonitored")
        yield _NullMonitor()
        return

    with monitor as tw:
        log.info("trainwatch run %s -> %s", tw.run_id, config.db_path)
        yield tw


def trainwatch_callback(
    monitor: Any,
    *,
    skip: tuple[str, ...] = ("total_flos", "epoch"),
) -> Any:
    """Build a `TrainerCallback` that forwards HF/TRL logs to trainwatch.

    A factory rather than a module-level class, because `transformers` has to be
    imported lazily: the sandbox and eval harness import this module too, and
    they run in environments with no training stack.

    TRL's SFTTrainer/DPOTrainer/GRPOTrainer own the loop, so there is no
    per-step hook to drop `tw.log()` into. `on_log` is the seam — the Trainer
    calls it on `logging_steps` cadence with whatever it just computed.

    Two translations happen here, next to the thing that causes them:

    * HF calls the rate ``learning_rate``; trainwatch's headline row wants
      ``lr``. The wrong name is the difference between a populated hero strip
      and a row of dashes.
    * HF prefixes eval metrics ``eval_``. Rewriting to ``eval/`` puts them in
      their own panel via trainwatch's slash-grouping instead of mixing them
      into the train scalars.
    """
    from transformers import TrainerCallback

    try:
        from src.trainwatch import DivergenceError as _Divergence
    except Exception:  # trainwatch absent -> monitor is the null object anyway

        class _Divergence(Exception):  # type: ignore[no-redef]
            pass

    skipped = set(skip)

    class _TrainwatchCallback(TrainerCallback):  # type: ignore[misc, valid-type]
        def on_log(
            self,
            args: Any = None,
            state: Any = None,
            control: Any = None,
            logs: dict[str, Any] | None = None,
            **_: Any,
        ) -> None:
            if not logs:
                return
            step = int(getattr(state, "global_step", 0) or 0)
            values: dict[str, Any] = {}
            for key, value in logs.items():
                if key in skipped or not isinstance(value, (int, float)):
                    continue
                if key == "learning_rate":
                    values["lr"] = value
                elif key.startswith("eval_"):
                    values[f"eval/{key[5:]}"] = value
                else:
                    values[key] = value
            if not values:
                return
            try:
                monitor.log(values, step=step)
            except _Divergence:
                # The one exception that must escape: it is how trainwatch
                # aborts a NaN run instead of letting it burn the GPU.
                raise
            except Exception:
                log.exception("trainwatch callback failed; training continues")

        def on_train_end(
            self, args: Any = None, state: Any = None, control: Any = None, **_: Any
        ) -> None:
            log.info("training ended at step %s", getattr(state, "global_step", "?"))

    return _TrainwatchCallback()
