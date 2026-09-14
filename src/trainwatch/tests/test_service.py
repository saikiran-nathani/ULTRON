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


def test_the_env_block_always_exists_because_path_is_always_set(tmp_path: Path) -> None:
    """Previously asserted the opposite: no env means no block.

    That premise is now deliberately false. PATH is always injected, because a
    supervised service inherits almost nothing and an absent PATH is invisible
    until some shelled-out binary quietly cannot be found.
    """
    plist = service.render("hub", repo=tmp_path, env={}, system="Darwin")
    assert "EnvironmentVariables" in plist
    assert "<key>PATH</key>" in plist


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


def test_units_carry_a_path_that_includes_usr_local_bin(tmp_path: Path) -> None:
    """launchd gives an agent PATH=/usr/bin:/bin:/usr/sbin:/sbin and nothing else.

    tailscale lives in /usr/local/bin, so without this the Host allowlist
    silently collapsed to localhost and the dashboard answered 421 to its own
    URL — a failure that reads like DNS, not like a missing PATH.
    """
    for system in ("Darwin", "Linux"):
        text = service.render("hub", repo=tmp_path, system=system)
        assert "/usr/local/bin" in text, system
        assert "/opt/homebrew/bin" in text, f"Apple Silicon brew missing ({system})"


def test_an_explicit_path_overrides_the_default(tmp_path: Path) -> None:
    text = service.render("hub", repo=tmp_path, env={"PATH": "/custom"}, system="Linux")
    assert 'Environment="PATH=/custom"' in text


def test_units_raise_the_file_descriptor_ceiling(tmp_path: Path) -> None:
    """A supervised job's maxfiles is 256, not the shell's 1,048,576.

    Same class as the PATH test above: a unit inherits almost nothing, and
    what it does inherit is the restrictive version. The hub exhausted 256
    descriptors after 6h30m and spent the rest of the day accepting
    connections it could not answer, with launchd reporting it healthy the
    whole time.
    """
    plist = service.render("hub", repo=tmp_path, system="Darwin")
    assert "<key>NumberOfFiles</key>" in plist
    assert "SoftResourceLimits" in plist and "HardResourceLimits" in plist

    unit = service.render("hub", repo=tmp_path, system="Linux")
    assert f"LimitNOFILE={service._MAX_FILES}" in unit

    assert service._MAX_FILES > 256, "the ceiling must actually be raised"
