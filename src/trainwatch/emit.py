"""Layer 2a — Emit. One `log()` call fans out to every configured sink.

Sinks are chosen by config (`TRAINWATCH_SINKS=store,tensorboard,wandb`) and are
**independent**: a sink that raises is disabled after a few failures and the
others carry on. Losing W&B should never cost you the local store.

Slash-prefixed keys (`resid_rms/layer_3`) group automatically in both
TensorBoard and W&B, which is why the source guide insists on them.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from .store import Store

__all__ = ["Emitter", "Sink", "StoreSink", "TensorBoardSink", "WandbSink", "build_emitter"]

log = logging.getLogger("trainwatch.emit")

# A sink that fails this many times in a row is switched off for the run.
_MAX_CONSECUTIVE_FAILURES = 3


@runtime_checkable
class Sink(Protocol):
    name: str

    def log(self, step: int, values: dict[str, float]) -> None: ...
    def close(self) -> None: ...


class StoreSink:
    """The SQLite store — this is what the iPad dashboard reads."""

    name = "store"

    def __init__(self, store: Store, run_id: str) -> None:
        self._store = store
        self._run_id = run_id

    def log(self, step: int, values: dict[str, float]) -> None:
        self._store.log_metrics(self._run_id, step, values)
        self._store.beat(self._run_id, step)

    def close(self) -> None:
        self._store.flush()


class TensorBoardSink:
    """Local-first scalars. Serve with `trainwatch tensorboard` (binds 0.0.0.0)."""

    name = "tensorboard"

    def __init__(self, logdir: str | Path, run_name: str) -> None:
        self._writer = _open_summary_writer(Path(logdir) / run_name)

    def log(self, step: int, values: dict[str, float]) -> None:
        for key, value in values.items():
            self._writer.add_scalar(key, value, global_step=step)

    def close(self) -> None:
        try:
            self._writer.flush()
            self._writer.close()
        except Exception:
            log.debug("tensorboard writer close failed", exc_info=True)


class WandbSink:
    """W&B scalars. Assumes the caller has already run `wandb.init`, or inits here."""

    name = "wandb"

    def __init__(self, project: str, run_name: str, *, reuse_active: bool = True) -> None:
        import wandb

        self._wandb = wandb
        self._owns_run = False
        if reuse_active and wandb.run is not None:
            # The user already called wandb.init() — attach, don't hijack.
            return
        wandb.init(project=project, name=run_name)
        self._owns_run = True

    def log(self, step: int, values: dict[str, float]) -> None:
        self._wandb.log(values, step=step)

    def close(self) -> None:
        if self._owns_run:
            try:
                self._wandb.finish()
            except Exception:
                log.debug("wandb finish failed", exc_info=True)


class Emitter:
    """Fan-out over sinks with per-sink fault isolation."""

    def __init__(self, sinks: list[Sink]) -> None:
        self._sinks = sinks
        self._failures: dict[str, int] = {}
        self._disabled: set[str] = set()

    @property
    def active(self) -> list[str]:
        return [s.name for s in self._sinks if s.name not in self._disabled]

    def log(self, step: int, values: dict[str, float]) -> None:
        if not values:
            return
        for sink in self._sinks:
            if sink.name in self._disabled:
                continue
            try:
                sink.log(step, values)
                self._failures[sink.name] = 0
            except Exception:
                count = self._failures.get(sink.name, 0) + 1
                self._failures[sink.name] = count
                log.warning(
                    "emit sink %r failed (%d/%d)",
                    sink.name,
                    count,
                    _MAX_CONSECUTIVE_FAILURES,
                    exc_info=True,
                )
                if count >= _MAX_CONSECUTIVE_FAILURES:
                    self._disabled.add(sink.name)
                    log.error("emit sink %r disabled for this run", sink.name)

    def close(self) -> None:
        for sink in self._sinks:
            try:
                sink.close()
            except Exception:
                log.debug("closing sink %r failed", sink.name, exc_info=True)


def build_emitter(
    names: tuple[str, ...] | list[str],
    *,
    store: Store,
    run_id: str,
    run_name: str,
    tensorboard_dir: str | Path = "runs",
    wandb_project: str = "training-dynamics",
) -> Emitter:
    """Construct the sinks named in config, skipping any that cannot be built.

    A missing optional dependency degrades the system (one fewer dashboard); it
    must never prevent the run from starting.
    """
    sinks: list[Sink] = []
    for name in names:
        try:
            if name == "store":
                sinks.append(StoreSink(store, run_id))
            elif name in ("tensorboard", "tb"):
                sinks.append(TensorBoardSink(tensorboard_dir, run_name))
            elif name == "wandb":
                sinks.append(WandbSink(wandb_project, run_name))
            else:
                log.warning("unknown sink %r in TRAINWATCH_SINKS, ignoring", name)
        except Exception as exc:  # noqa: BLE001 - a missing extra degrades, never blocks
            log.error("could not initialise sink %r (%s) — continuing without it", name, exc)

    if not any(s.name == "store" for s in sinks):
        # The dashboard is the point; never let a typo in TRAINWATCH_SINKS
        # silently produce a run the iPad cannot see.
        log.warning("no 'store' sink configured — adding it so the dashboard has data")
        sinks.insert(0, StoreSink(store, run_id))
    return Emitter(sinks)


def _open_summary_writer(logdir: Path) -> Any:
    """torch's SummaryWriter if torch is present, else tensorboardX's."""
    logdir.mkdir(parents=True, exist_ok=True)
    try:
        from torch.utils.tensorboard import SummaryWriter
    except ImportError:
        # Standalone tensorboardX, for an env that has TensorBoard but not torch.
        # The ignore is for mypy >=2.0, which treats the two branches of an
        # import fallback as a redefinition; mypy 1.x accepted it. The pattern
        # is correct -- exactly one of the two names is ever bound.
        from tensorboardX import SummaryWriter  # type: ignore[no-redef]
    return SummaryWriter(log_dir=str(logdir))
