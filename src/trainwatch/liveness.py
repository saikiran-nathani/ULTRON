"""The out-of-process liveness check — "alert on absence of progress".

This is the one check that must NOT live inside the training process, because
the failures it catches (hang, OOM kill, SIGKILL, dead CUDA context, tripped
breaker) are exactly the ones that leave no code running to report them. It runs
from cron; see `scripts/install-liveness-cron.sh`.

Three things the naive version in the guide gets wrong, all fixed here:

1. **It pages you forever after a clean finish.** A run that ended normally
   leaves a permanently-stale heartbeat, so `age > 900` stays true for all
   eternity. We gate on there being a run still marked `running`.
2. **It pages you every 10 minutes while the run is dead.** Once is enough; the
   run is not going to get less dead. Re-alerts are suppressed for `renotify`
   seconds and the run is marked `dead` so the dashboard agrees.
3. **It only reads the heartbeat file.** If the file is missing but the store
   shows recent step progress, the run is alive and the heartbeat path is
   misconfigured — a different problem, reported differently.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Any, Literal

from .config import Config, load_config
from .heartbeat import read_heartbeat
from .notify import Notifier
from .store import Store

__all__ = ["LivenessResult", "check_liveness"]

log = logging.getLogger("trainwatch.liveness")

Status = Literal["ok", "idle", "dead", "stale-heartbeat", "unknown"]

# Don't re-page about the same dead run more often than this.
_RENOTIFY_SECONDS = 3600.0


@dataclass(frozen=True, slots=True)
class LivenessResult:
    status: Status
    message: str
    run_id: str | None = None
    age: float | None = None
    notified: bool = False

    @property
    def healthy(self) -> bool:
        # "unknown" (no runs recorded yet) is healthy on purpose. This runs from
        # cron every 10 minutes, and a non-zero exit makes cron mail you — so
        # treating a fresh install as a failure means being paged every ten
        # minutes before you have trained anything, which is the fastest way to
        # teach yourself to ignore this alert.
        return self.status in ("ok", "idle", "unknown")

    @property
    def exit_code(self) -> int:
        return 0 if self.healthy else 1


def check_liveness(
    config: Config | None = None,
    *,
    notifier: Notifier | None = None,
    renotify: float = _RENOTIFY_SECONDS,
) -> LivenessResult:
    """Run one liveness check. Safe to call from cron every 10 minutes."""
    cfg = config or load_config()
    store = Store(cfg.db_path)
    try:
        return _check(cfg, store, notifier, renotify)
    finally:
        store.close()


def _check(cfg: Config, store: Store, notifier: Notifier | None, renotify: float) -> LivenessResult:
    run = store.latest_run()

    if run is None:
        return LivenessResult("unknown", "no runs recorded yet")

    if run["status"] != "running":
        # Finished, failed, stopped or already-marked-dead: nothing to watch.
        return LivenessResult(
            "idle",
            f"no active run (latest: {run['name']} · {run['status']})",
            run_id=str(run["id"]),
        )

    run_id = str(run["id"])
    now = time.time()

    # Take the most recent evidence of progress from either source. The store's
    # last_beat is updated every logged step; the file every `heartbeat_every`.
    candidates = [t for t in (run.get("last_beat"), _hb_ts(cfg)) if t]
    if not candidates:
        return LivenessResult(
            "stale-heartbeat",
            f"run {run['name']} is marked running but has never reported progress",
            run_id=run_id,
        )

    age = now - max(candidates)
    if age <= cfg.heartbeat_timeout:
        return LivenessResult(
            "ok",
            f"{run['name']} alive · step {run['last_step']} · {age:.0f}s since last beat",
            run_id=run_id,
            age=age,
        )

    # ── the run is dead ──────────────────────────────────────────────────
    message = (
        f"no heartbeat in {_human(age)} (limit {_human(cfg.heartbeat_timeout)}) — "
        f"{run['name']} stopped at step {run['last_step']}. Likely OOM kill, hang, "
        f"or the process was killed."
    )

    if _recently_notified(store, run_id, renotify):
        log.info("run %s still dead, already notified within %.0fs", run_id, renotify)
        store.finish_run(run_id, status="dead")
        return LivenessResult("dead", message, run_id=run_id, age=age, notified=False)

    n = notifier if notifier is not None else Notifier(cfg.ntfy_url, token=cfg.ntfy_token)
    notified = n.alert(
        message,
        title=f"{run['name']} may be DEAD",
        priority="urgent",
        rule="liveness",
    )
    n.close(timeout=8.0)

    store.add_event(
        run_id=run_id,
        level="critical",
        rule="liveness",
        title="No heartbeat",
        body=message,
        step=int(run["last_step"]),
        notified=notified,
    )
    # Mark it so the dashboard shows the truth and we stop re-checking a corpse.
    store.finish_run(run_id, status="dead")

    return LivenessResult("dead", message, run_id=run_id, age=age, notified=notified)


def _hb_ts(cfg: Config) -> float | None:
    hb = read_heartbeat(cfg.heartbeat_path)
    return None if hb is None else float(hb["ts"])


def _recently_notified(store: Store, run_id: str, window: float) -> bool:
    cutoff = time.time() - window
    return any(
        e["rule"] == "liveness" and e["ts"] >= cutoff for e in store.events(limit=50, run_id=run_id)
    )


def _human(seconds: float) -> str:
    seconds = float(seconds)
    if seconds < 90:
        return f"{seconds:.0f}s"
    if seconds < 5400:
        return f"{seconds / 60:.0f}min"
    return f"{seconds / 3600:.1f}h"


def summary(cfg: Config | None = None) -> dict[str, Any]:
    """Non-alerting snapshot for the dashboard's status header."""
    c = cfg or load_config()
    store = Store(c.db_path)
    try:
        run = store.latest_run()
        hb = read_heartbeat(c.heartbeat_path)
        age: float | None = None
        if run and run["status"] == "running":
            candidates = [t for t in (run.get("last_beat"), hb["ts"] if hb else None) if t]
            if candidates:
                age = time.time() - max(candidates)
        return {
            "run": run,
            "heartbeat_age": age,
            "heartbeat_timeout": c.heartbeat_timeout,
            "stale": age is not None and age > c.heartbeat_timeout,
        }
    finally:
        store.close()
