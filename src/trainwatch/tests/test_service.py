"""Service units — the thing that stops the hub dying with its shell."""

from __future__ import annotations

from pathlib import Path

import pytest

from src.trainwatch import service


def test_both_units_exist() -> None:
    assert set(service.UNITS) == {"hub", "ship"}


def test_launchd_uses_the_venv_interpreter(tmp_path: Path) -> None:
    """A service does not inherit an activated venv.

    `python3` would resolve to the system interpreter and the unit would die
    on ModuleNotFoundError, so the absolute path is not a nicety.
    """
    text = service.render("hub", repo=tmp_path, system="Darwin")
    assert "<string>serve</string>" in text
    assert ".venv/bin/python" in text or "python" in text
    assert "/" in text.split("<string>")[2], "interpreter must be an absolute path"


def test_launchd_survives_a_space_in_the_path() -> None:
    """The Mac checkout lives under "MacBook Pro"."""
    repo = Path("/Users/x/MacBook Pro/ULTRON")
    text = service.render("hub", repo=repo, system="Darwin")
    assert f"<string>{repo}</string>" in text


def test_systemd_quotes_paths(tmp_path: Path) -> None:
    """systemd splits ExecStart on whitespace; a plist does not."""
    text = service.render("ship", repo=Path("/home/x/my repo"), system="Linux")
    exec_line = next(ln for ln in text.splitlines() if ln.startswith("ExecStart="))
    assert exec_line.count('"') >= 2, f"interpreter not quoted: {exec_line}"
    assert 'WorkingDirectory="/home/x/my repo"' in text


def test_env_is_carried_into_the_unit(tmp_path: Path) -> None:
    """TRAINWATCH_TOKEN is the difference between shipping and a silent 401."""
    env = {"TRAINWATCH_TOKEN": "twk_a_b", "TRAINWATCH_HUB": "http://h:8730"}
    plist = service.render("ship", repo=tmp_path, env=env, system="Darwin")
    assert "twk_a_b" in plist
    assert "<key>TRAINWATCH_HUB</key>" in plist

    unit = service.render("ship", repo=tmp_path, env=env, system="Linux")
    assert 'Environment="TRAINWATCH_TOKEN=twk_a_b"' in unit


def test_no_env_block_when_there_is_no_env(tmp_path: Path) -> None:
    plist = service.render("hub", repo=tmp_path, env={}, system="Darwin")
    assert "EnvironmentVariables" not in plist


def test_restart_on_crash_but_not_on_clean_exit(tmp_path: Path) -> None:
    plist = service.render("hub", repo=tmp_path, system="Darwin")
    assert "<key>SuccessfulExit</key><false/>" in plist
    unit = service.render("hub", repo=tmp_path, system="Linux")
    assert "Restart=on-failure" in unit


def test_unknown_unit_raises(tmp_path: Path) -> None:
    with pytest.raises(KeyError, match="unknown unit"):
        service.render("nope", repo=tmp_path)


def test_unit_paths_are_per_platform() -> None:
    assert service.unit_path("hub", system="Darwin").name == "com.trainwatch.hub.plist"
    assert service.unit_path("hub", system="Linux").name == "trainwatch-hub.service"


def test_load_command_is_platform_correct() -> None:
    mac = service.load_command("hub", system="Darwin")
    assert mac[0] == "launchctl" and "bootstrap" in mac
    linux = service.load_command("ship", system="Linux")
    assert linux[:3] == ["systemctl", "--user", "enable"]
