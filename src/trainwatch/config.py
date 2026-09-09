"""Configuration, loaded from the environment (12-factor) with a .env fallback.

Deliberately dependency-free: a hand-rolled 8-line .env reader beats adding
python-dotenv to an environment that also has to hold PyTorch and CUDA.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

__all__ = ["Config", "load_config", "load_dotenv"]

DEFAULT_SINKS = ("store",)


def load_dotenv(path: str | os.PathLike[str] = ".env") -> None:
    """Populate os.environ from a .env file. Real env vars always win."""
    p = Path(path)
    if not p.is_file():
        return
    for raw in p.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        value = value.strip().strip("'\"")
        # Never clobber something the shell (or systemd, or the CI runner) set.
        os.environ.setdefault(key, value)


def _env_str(key: str, default: str) -> str:
    value = os.environ.get(key, "").strip()
    return value or default


def _env_float(key: str, default: float) -> float:
    raw = os.environ.get(key, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_int(key: str, default: int) -> int:
    return int(_env_float(key, float(default)))


def _env_bool(key: str, default: bool) -> bool:
    """Truthy strings only. "0" and "false" must not read as True.

    `bool(os.environ["X"])` is True for the string "0", which is how a flag
    someone deliberately turned off ends up on.
    """
    raw = os.environ.get(key, "").strip().lower()
    if not raw:
        return default
    return raw in {"1", "true", "yes", "on"}


@dataclass(frozen=True, slots=True)
class Config:
    """Everything the system reads from the environment, resolved once."""

    # storage
    db_path: Path = Path("var/trainwatch.db")
    heartbeat_path: Path = Path("var/heartbeat")
    # Telemetry older than this is dropped by the server's hourly reaper. The
    # hub has always expired its own rows; metrics did not, so the only thing
    # bounding the database was remembering to run `trainwatch prune`.
    # 0 disables automatic pruning and restores the manual-only behaviour.
    keep_days: float = 30.0

    # notify
    ntfy_topic: str = ""
    ntfy_server: str = "https://ntfy.sh"
    ntfy_token: str = ""

    # emit
    sinks: tuple[str, ...] = field(default=DEFAULT_SINKS)
    tensorboard_dir: Path = Path("runs")
    wandb_project: str = "training-dynamics"

    # server
    host: str = "0.0.0.0"  # noqa: S104 - bound by the tailnet + ADR-0003's Host allowlist
    port: int = 8730

    # hub (shared clipboard / files / notes)
    blob_dir: Path = Path("var/blobs")
    # Extra Host header values to accept. localhost and this machine's tailnet
    # identity are auto-detected; this is for anything else (ADR-0003 C1).
    allowed_hosts: str = ""
    # Optional bearer token on writes. Empty = open on the tailnet (ADR-0003 C6).
    token: str = ""
    # ADR-0004 C7/C8. Off by default and self-activating: enforcement turns on
    # as soon as a user row exists, so an instance with no account keeps
    # working exactly as ADR-0003 left it. Set this to force it on regardless.
    require_auth: bool = False
    # Explicit hub base URL for client machines; empty = localhost:port.
    _hub: str = ""

    # watchdog thresholds
    grad_norm_ceil: float = 100.0
    entropy_floor: float = 0.15
    step_time_drift: float = 1.5
    heartbeat_timeout: int = 900

    @property
    def hub_url(self) -> str:
        """Base URL the CLI talks to. Defaults to the local server.

        Set TRAINWATCH_HUB on a machine that is a *client* of the hub — e.g.
        the Asus talking to a hub hosted on the MacBook.
        """
        return self._hub or f"http://127.0.0.1:{self.port}"

    @property
    def ntfy_url(self) -> str:
        """Full POST target, or '' when notifications are not configured."""
        if not self.ntfy_topic:
            return ""
        return f"{self.ntfy_server.rstrip('/')}/{self.ntfy_topic.lstrip('/')}"

    @property
    def notify_enabled(self) -> bool:
        return bool(self.ntfy_topic) and "CHANGE-ME" not in self.ntfy_topic


def load_config(dotenv: str | os.PathLike[str] | None = ".env") -> Config:
    """Read config from the environment, loading .env first if present."""
    if dotenv is not None:
        load_dotenv(dotenv)

    raw_sinks = _env_str("TRAINWATCH_SINKS", ",".join(DEFAULT_SINKS))
    sinks = tuple(s.strip().lower() for s in raw_sinks.split(",") if s.strip())

    return Config(
        db_path=Path(_env_str("TRAINWATCH_DB", "var/trainwatch.db")),
        heartbeat_path=Path(_env_str("TRAINWATCH_HEARTBEAT", "var/heartbeat")),
        keep_days=_env_float("TRAINWATCH_KEEP_DAYS", 30.0),
        ntfy_topic=_env_str("TRAINWATCH_NTFY_TOPIC", ""),
        ntfy_server=_env_str("TRAINWATCH_NTFY_SERVER", "https://ntfy.sh"),
        ntfy_token=_env_str("TRAINWATCH_NTFY_TOKEN", ""),
        sinks=sinks or DEFAULT_SINKS,
        tensorboard_dir=Path(_env_str("TRAINWATCH_TENSORBOARD_DIR", "runs")),
        wandb_project=_env_str("WANDB_PROJECT", "training-dynamics"),
        host=_env_str("TRAINWATCH_HOST", "0.0.0.0"),  # noqa: S104 - see above
        port=_env_int("TRAINWATCH_PORT", 8730),
        blob_dir=Path(_env_str("TRAINWATCH_BLOB_DIR", "var/blobs")),
        allowed_hosts=_env_str("TRAINWATCH_ALLOWED_HOSTS", ""),
        token=_env_str("TRAINWATCH_TOKEN", ""),
        require_auth=_env_bool("TRAINWATCH_REQUIRE_AUTH", False),
        _hub=_env_str("TRAINWATCH_HUB", ""),
        grad_norm_ceil=_env_float("TRAINWATCH_GRAD_NORM_CEIL", 100.0),
        entropy_floor=_env_float("TRAINWATCH_ENTROPY_FLOOR", 0.15),
        step_time_drift=_env_float("TRAINWATCH_STEP_TIME_DRIFT", 1.5),
        heartbeat_timeout=_env_int("TRAINWATCH_HEARTBEAT_TIMEOUT", 900),
    )
