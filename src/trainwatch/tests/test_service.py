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


# ══ the unit file against systemd's own schema ═══════════════════════════


def _sections(text: str) -> dict[str, list[str]]:
    """Group a unit file's keys by the section they appear in."""
    out: dict[str, list[str]] = {}
    section = ""
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("[") and line.endswith("]"):
            section = line[1:-1]
        elif "=" in line and not line.startswith("#"):
            out.setdefault(section, []).append(line.split("=", 1)[0])
    return out


# Where systemd actually reads each key. The rate-limit pair is the trap: both
# were [Service] options before v229 (2016) and are [Unit] options after, and
# the migration is silent — systemd logs "Unknown key name" once at load and
# then uses the default.
_SECTION_OF = {
    "Description": "Unit",
    "After": "Unit",
    "Wants": "Unit",
    "StartLimitBurst": "Unit",
    "StartLimitIntervalSec": "Unit",
    "Type": "Service",
    "WorkingDirectory": "Service",
    "ExecStart": "Service",
    "Restart": "Service",
    "RestartSec": "Service",
    "LimitNOFILE": "Service",
    "MemoryMax": "Service",
    "Environment": "Service",
    "WantedBy": "Install",
}


@pytest.mark.parametrize("name", sorted(service.UNITS))
def test_every_systemd_key_is_in_the_section_systemd_reads_it_from(name: str) -> None:
    """A key in the wrong section is ignored, and nothing says so.

    This started as a real defect: `StartLimitBurst` and
    `StartLimitIntervalSec` were emitted under `[Service]`, where they have not
    been read since systemd v229. The unit therefore inherited
    `DefaultStartLimitIntervalSec=10s`, and with `RestartSec=5` a crashing
    service gets about two restarts per window, never reaches a burst of five,
    and **restarts forever** — exactly the crash loop the setting was added to
    prevent.

    The generator had tests for its content and none for its schema, so the
    file read as configured while the protection did not exist. That is the
    same shape as a phase with no measurement reading as done.
    """
    text = service._systemd(service.UNITS[name], repo=Path("/repo"), env={"A": "b"})
    for section, keys in _sections(text).items():
        for key in keys:
            expected = _SECTION_OF.get(key)
            assert expected is not None, (
                f"{key} is not in this test's table — add it, with the section "
                f"systemd documents, rather than deleting the assertion"
            )
            assert section == expected, (
                f"[{section}] {key} is ignored by systemd; it belongs in [{expected}]"
            )


def test_the_restart_limit_is_not_left_to_systemds_default(name: str = "hub") -> None:
    """The default burst is also 5, so asserting the burst alone proves nothing.

    `systemctl show -p StartLimitBurst` returns 5 whether the unit sets it or
    not. Only the interval distinguishes a unit that configured the limit from
    one that inherited it — which is why the interval is the thing to assert,
    here and in the on-box gate.
    """
    text = service._systemd(service.UNITS[name], repo=Path("/repo"), env={})
    assert "StartLimitIntervalSec=300" in text
    assert "StartLimitBurst=5" in text
