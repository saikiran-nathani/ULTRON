"""Generate the service unit that keeps trainwatch running.

The hub has died three times in this project's life for the same reason: it was
started in a shell, and the shell went away. A dashboard whose purpose is to
tell you when a six-hour run breaks cannot itself depend on a terminal staying
open.

Two units, one per machine, because the halves fail differently:

- **hub** (`trainwatch serve`) on the Mac. If it dies, `tailscale serve` keeps
  answering and proxies to nothing, so the symptom is a 502 rather than a
  refused connection — which reads like a broken tunnel and sends you looking
  in the wrong place.
- **ship** (`trainwatch ship`) on the TUF. If it dies, training carries on and
  the local store keeps every row; the dashboard just stops advancing. That is
  the more dangerous failure, because nothing looks broken.

This module only *writes* the unit and prints the command to load it. Loading
it is a persistent change to how the machine boots, so that stays an explicit
act by whoever owns the machine.
"""

from __future__ import annotations

import os
import platform
import shutil
import sys
from dataclasses import dataclass
from pathlib import Path

__all__ = ["UNITS", "Unit", "render", "unit_path"]

LABEL = "com.trainwatch"


@dataclass(frozen=True)
class Unit:
    name: str
    args: tuple[str, ...]
    description: str


UNITS: dict[str, Unit] = {
    "hub": Unit(
        name="hub",
        args=("serve",),
        description="trainwatch dashboard and hub",
    ),
    "ship": Unit(
        name="ship",
        args=("ship",),
        description="replicate local telemetry to the hub",
    ),
}


def _python() -> str:
    """The interpreter to run under.

    `sys.executable` on purpose, not `python3`: a service does not inherit the
    shell that had the venv activated, so a bare name resolves to the system
    interpreter and the unit dies on `ModuleNotFoundError: fastapi`.
    """
    return sys.executable


def unit_path(name: str, *, system: str | None = None) -> Path:
    system = system or platform.system()
    if system == "Darwin":
        return Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.{name}.plist"
    return Path.home() / ".config" / "systemd" / "user" / f"trainwatch-{name}.service"


def render(
    name: str,
    *,
    repo: Path,
    env: dict[str, str] | None = None,
    system: str | None = None,
) -> str:
    """Render the unit file for `name` on this platform."""
    if name not in UNITS:
        raise KeyError(f"unknown unit {name!r}; choose from {sorted(UNITS)}")
    unit = UNITS[name]
    system = system or platform.system()
    env = dict(env or {})
    return (
        _launchd(unit, repo=repo, env=env)
        if system == "Darwin"
        else _systemd(unit, repo=repo, env=env)
    )


def _launchd(unit: Unit, *, repo: Path, env: dict[str, str]) -> str:
    args = "".join(
        f"\n        <string>{a}</string>"
        for a in (_python(), "-m", "src.trainwatch.cli", *unit.args)
    )
    environment = "".join(
        f"\n        <key>{k}</key><string>{v}</string>" for k, v in sorted(env.items())
    )
    env_block = (
        f"\n    <key>EnvironmentVariables</key>\n    <dict>{environment}\n    </dict>"
        if env
        else ""
    )
    # KeepAlive with SuccessfulExit=false: restart on a crash, but do not fight
    # a clean `trainwatch ship --once`-style exit. RunAtLoad so it comes up at
    # login without anyone remembering to start it.
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>{LABEL}.{unit.name}</string>
    <key>ProgramArguments</key>
    <array>{args}
    </array>
    <key>WorkingDirectory</key><string>{repo}</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key><false/>
    </dict>
    <key>StandardOutPath</key><string>{repo}/var/{unit.name}.log</string>
    <key>StandardErrorPath</key><string>{repo}/var/{unit.name}.log</string>
    <key>ProcessType</key><string>Background</string>{env_block}
</dict>
</plist>
"""


def _systemd(unit: Unit, *, repo: Path, env: dict[str, str]) -> str:
    # systemd splits ExecStart on whitespace, so the interpreter path must be
    # quoted. A plist does not need this (it is XML with one arg per element),
    # and the Mac checkout lives under "MacBook Pro" -- a space that would
    # break the Linux unit while the macOS one looked fine.
    argv = " ".join([f'"{_python()}"', "-m", "src.trainwatch.cli", *unit.args])
    environment = "".join(f'\nEnvironment="{k}={v}"' for k, v in sorted(env.items()))
    # `WantedBy=default.target` is a *user* unit, which needs
    # `loginctl enable-linger` to survive logout -- the same requirement the
    # curriculum's headless-boot step already imposes.
    return f"""[Unit]
Description={unit.description}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory="{repo}"
ExecStart={argv}
Restart=on-failure
RestartSec=5{environment}

[Install]
WantedBy=default.target
"""


def load_command(name: str, *, system: str | None = None) -> list[str]:
    """The command that actually starts it. Printed, never run from here."""
    system = system or platform.system()
    path = unit_path(name, system=system)
    if system == "Darwin":
        uid = os.getuid()
        return ["launchctl", "bootstrap", f"gui/{uid}", str(path)]
    return ["systemctl", "--user", "enable", "--now", f"trainwatch-{name}.service"]


def available(system: str | None = None) -> bool:
    """Whether this platform's service manager is present."""
    system = system or platform.system()
    return shutil.which("launchctl" if system == "Darwin" else "systemctl") is not None
