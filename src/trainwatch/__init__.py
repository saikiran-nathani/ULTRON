"""trainwatch — remote training monitoring for a headless CUDA box, watched from an iPad.

Implements the four layers of `remote-training-monitoring.md`:

    Layer 0  Reach     scripts/tailscale-up.sh          (network, not code)
    Layer 1  Persist   scripts/train-session.sh         (tmux, not code)
    Layer 2  Emit      trainwatch.emit  · trainwatch.gpu
    Layer 3  Notify    trainwatch.notify · trainwatch.rules · trainwatch.heartbeat
    Layer 4  Client    trainwatch.server + the dashboard

Typical use — one object, one call per step:

    from trainwatch import TrainMonitor

    with TrainMonitor("run_042", meta={"model": "gpt-small"}) as tw:
        for step in range(total):
            loss = train_step()
            tw.log({"loss": loss, "grad_norm": gn, "lr": lr}, step=step)

The core imports nothing outside the standard library.
"""

from __future__ import annotations

from .config import Config, load_config
from .heartbeat import heartbeat_age, read_heartbeat, write_heartbeat
from .monitor import DivergenceError, TrainMonitor
from .notify import Notifier, NullNotifier
from .rules import RuleConfig, RuleEngine, Verdict
from .store import Store

__version__ = "0.1.0"

__all__ = [
    "Config",
    "DivergenceError",
    "Notifier",
    "NullNotifier",
    "RuleConfig",
    "RuleEngine",
    "Store",
    "TrainMonitor",
    "Verdict",
    "__version__",
    "heartbeat_age",
    "load_config",
    "read_heartbeat",
    "write_heartbeat",
]
