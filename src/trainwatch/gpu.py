"""Layer 2b — machine health, kept deliberately separate from training scalars.

The source guide's reason for the split is the one that matters: when step time
degrades you need to know whether it's the model or the machine. So this samples
temperature, clock and power *alongside* the metrics, and decodes the driver's
throttle bitmask — because "the change made it slower" and "the room got warmer"
look identical in a loss curve.

Runs inside the server process, not the trainer, so machine health is visible
between runs too.

WSL2 notes (this box is Windows):
  * `nvidia-smi` works through /usr/lib/wsl/lib passthrough, but several fields
    come back as `[N/A]` — notably power.draw and the enforced power limit on
    some laptop GPUs. Every field is parsed defensively.
  * `nvidia-smi dmon` (what the guide suggests interactively) is a streaming
    tool; for structured sampling `--query-gpu` is the portable choice.
"""

from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time
from typing import Any

from .store import Store

__all__ = ["THROTTLE_FLAGS", "GpuSampler", "nvidia_smi_available", "sample_gpus"]

log = logging.getLogger("trainwatch.gpu")

_QUERY_FIELDS = (
    "index",
    "name",
    "utilization.gpu",
    "memory.used",
    "memory.total",
    "temperature.gpu",
    "power.draw",
    "clocks.sm",
)

# Driver bitmask → human reason. The thermal/power ones are what explain a
# step-time regression that isn't your code.
THROTTLE_FLAGS: tuple[tuple[int, str], ...] = (
    (0x0000000000000004, "sw_power_cap"),
    (0x0000000000000008, "hw_slowdown"),
    (0x0000000000000020, "sw_thermal"),
    (0x0000000000000040, "hw_thermal"),
    (0x0000000000000080, "hw_power_brake"),
)

# Reasons that actually cost you throughput (gpu_idle and app-clock settings do not).
SIGNIFICANT_THROTTLES = frozenset(
    {"sw_power_cap", "hw_slowdown", "sw_thermal", "hw_thermal", "hw_power_brake"}
)


def nvidia_smi_available() -> bool:
    return shutil.which("nvidia-smi") is not None


def sample_gpus(timeout: float = 5.0) -> list[dict[str, Any]]:
    """One snapshot per visible GPU. Returns [] when nvidia-smi is unavailable."""
    if not nvidia_smi_available():
        return []

    rows = _query(list(_QUERY_FIELDS), timeout=timeout)
    if rows is None:
        return []

    throttles = _query_throttle(timeout=timeout)
    now = time.time()
    out: list[dict[str, Any]] = []
    for parts in rows:
        if len(parts) < len(_QUERY_FIELDS):
            continue
        idx = _as_int(parts[0], default=len(out))
        out.append(
            {
                "ts": now,
                "gpu_index": idx,
                "name": parts[1].strip(),
                "util": _as_float(parts[2]),
                "mem_used": _as_float(parts[3]),
                "mem_total": _as_float(parts[4]),
                "temp": _as_float(parts[5]),
                "power": _as_float(parts[6]),
                "clock_sm": _as_float(parts[7]),
                "throttle": throttles.get(idx, ""),
            }
        )
    return out


def _query(fields: list[str], *, timeout: float) -> list[list[str]] | None:
    cmd = [
        "nvidia-smi",
        f"--query-gpu={','.join(fields)}",
        "--format=csv,noheader,nounits",
    ]
    try:
        proc = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
            cmd, capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        log.warning("nvidia-smi query failed: %s", exc)
        return None
    if proc.returncode != 0:
        log.warning("nvidia-smi exited %d: %s", proc.returncode, proc.stderr.strip()[:200])
        return None
    return [line.split(",") for line in proc.stdout.strip().splitlines() if line.strip()]


def _query_throttle(*, timeout: float) -> dict[int, str]:
    """Decode active throttle reasons, tolerating the driver's field rename.

    The field was `clocks_throttle_reasons.active`; newer drivers renamed it to
    `clocks_event_reasons.active` and deprecated the old name. Try both.
    """
    for field in ("clocks_event_reasons.active", "clocks_throttle_reasons.active"):
        rows = _query(["index", field], timeout=timeout)
        if rows is None:
            continue
        out: dict[int, str] = {}
        for parts in rows:
            if len(parts) < 2:
                continue
            idx = _as_int(parts[0], default=0)
            out[idx] = _decode_throttle(parts[1])
        if out:
            return out
    return {}


def _decode_throttle(raw: str) -> str:
    raw = raw.strip()
    if not raw or raw.startswith("["):  # "[N/A]" / "[Not Supported]"
        return ""
    try:
        mask = int(raw, 16) if raw.lower().startswith("0x") else int(raw)
    except ValueError:
        return ""
    return ",".join(name for bit, name in THROTTLE_FLAGS if mask & bit)


def _as_float(raw: str) -> float | None:
    raw = raw.strip()
    if not raw or raw.startswith("[") or raw.lower() in ("n/a", "na"):
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _as_int(raw: str, *, default: int) -> int:
    value = _as_float(raw)
    return default if value is None else int(value)


class GpuSampler:
    """Background poller. Start once alongside the server; it is a daemon thread."""

    def __init__(self, store: Store, *, interval: float = 5.0) -> None:
        self.store = store
        self.interval = max(1.0, interval)
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.available = nvidia_smi_available()
        self.samples_written = 0
        self.last_error: str | None = None

    def start(self) -> None:
        if not self.available:
            log.warning(
                "nvidia-smi not found — machine-health panels will be empty. "
                "On WSL2 check that /usr/lib/wsl/lib is on PATH."
            )
            return
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._run, name="trainwatch-gpu", daemon=True)
        self._thread.start()
        log.info("gpu sampler started (every %.0fs)", self.interval)

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                samples = sample_gpus()
                if samples:
                    self.store.add_gpu_samples(samples)
                    self.samples_written += len(samples)
                    self.last_error = None
            except Exception as exc:
                self.last_error = f"{type(exc).__name__}: {exc}"
                log.warning("gpu sample failed: %s", exc, exc_info=True)
            self._stop.wait(self.interval)


def throttle_is_significant(throttle: str) -> bool:
    """True when the active reasons actually cost throughput."""
    return any(part in SIGNIFICANT_THROTTLES for part in throttle.split(",") if part)
