"""The alert people forget — proof of life.

Value-based rules cannot fire when nothing is running. A hang, an OOM kill, a
dead CUDA context and a tripped breaker all produce *no* error, because no code
is left to produce one. Only absence-of-progress catches those.

Two files are written side by side:

* ``<path>``       — the raw epoch seconds, nothing else. This keeps the source
  guide's shell one-liner working verbatim:
  ``[ $(( $(date +%s) - $(cat /tmp/heartbeat) )) -gt 900 ]``
* ``<path>.json``  — run id, step and timestamp, for the richer liveness check.

Both are written atomically (write-temp + ``os.replace``), so a reader can never
observe a half-written file and conclude the run is dead.
"""

from __future__ import annotations

import json
import logging
import os
import time
from pathlib import Path
from typing import Any

__all__ = ["write_heartbeat", "read_heartbeat", "heartbeat_age"]

log = logging.getLogger("trainwatch.heartbeat")


def write_heartbeat(path: str | os.PathLike[str], *, run_id: str = "", step: int = 0) -> None:
    """Record proof of life. Never raises — a full disk must not kill the run."""
    try:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        now = time.time()
        _atomic_write(p, f"{now:.3f}")
        _atomic_write(
            p.with_suffix(p.suffix + ".json"),
            json.dumps({"ts": now, "run_id": run_id, "step": step}),
        )
    except Exception:  # noqa: BLE001
        log.warning("could not write heartbeat to %s", path, exc_info=True)


def read_heartbeat(path: str | os.PathLike[str]) -> dict[str, Any] | None:
    """Read the heartbeat. Returns None if it has never been written."""
    p = Path(path)
    rich = p.with_suffix(p.suffix + ".json")
    if rich.is_file():
        try:
            data = json.loads(rich.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "ts" in data:
                return {
                    "ts": float(data["ts"]),
                    "run_id": str(data.get("run_id", "")),
                    "step": int(data.get("step", 0)),
                    "age": max(0.0, time.time() - float(data["ts"])),
                }
        except (json.JSONDecodeError, ValueError, OSError):
            log.debug("rich heartbeat unreadable, falling back to plain", exc_info=True)

    if p.is_file():
        try:
            ts = float(p.read_text(encoding="utf-8").strip())
            return {"ts": ts, "run_id": "", "step": 0, "age": max(0.0, time.time() - ts)}
        except (ValueError, OSError):
            log.debug("plain heartbeat unreadable", exc_info=True)
    return None


def heartbeat_age(path: str | os.PathLike[str]) -> float | None:
    """Seconds since the last heartbeat, or None if there has never been one."""
    hb = read_heartbeat(path)
    return None if hb is None else float(hb["age"])


def _atomic_write(path: Path, text: str) -> None:
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
