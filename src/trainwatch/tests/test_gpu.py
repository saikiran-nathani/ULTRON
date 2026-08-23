"""nvidia-smi parsing.

This is the WSL2 blast radius: several fields come back as `[N/A]` through
passthrough, and the throttle-reason field was renamed between driver
generations. Getting either wrong shows as an empty Machine screen or, worse,
a confident wrong reading.
"""

from __future__ import annotations

import subprocess
from typing import Any

import pytest

from src.trainwatch import gpu as gpumod
from src.trainwatch.gpu import _decode_throttle, sample_gpus, throttle_is_significant

GOOD = "0, NVIDIA GeForce RTX 4070 Laptop GPU, 97, 7100, 8188, 84, 103.5, 2295"
# What a laptop GPU under WSL2 actually returns for power and clocks.
WSL_NA = "0, NVIDIA GeForce RTX 4070 Laptop GPU, 97, 7100, 8188, [N/A], [N/A], [Not Supported]"


def fake_run(stdout: str, *, returncode: int = 0) -> Any:
    def _run(cmd: list[str], **_kw: Any) -> subprocess.CompletedProcess[str]:
        # The throttle query is a second call with a different field list.
        if any("clocks" in c and "reasons" in c for c in cmd):
            return subprocess.CompletedProcess(cmd, 0, "0, 0x0000000000000000\n", "")
        return subprocess.CompletedProcess(cmd, returncode, stdout, "err")

    return _run


@pytest.fixture(autouse=True)
def _pretend_nvidia_smi_exists(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpumod.shutil, "which", lambda _n: "/usr/lib/wsl/lib/nvidia-smi")


def test_parses_a_healthy_sample(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpumod.subprocess, "run", fake_run(GOOD))
    (s,) = sample_gpus()
    assert s["gpu_index"] == 0
    assert s["name"] == "NVIDIA GeForce RTX 4070 Laptop GPU"
    assert s["util"] == 97
    assert s["temp"] == 84
    assert s["power"] == pytest.approx(103.5)
    assert s["clock_sm"] == 2295
    assert s["throttle"] == ""


def test_na_fields_become_none_not_zero(monkeypatch: pytest.MonkeyPatch) -> None:
    """Coercing `[N/A]` to 0 would draw a power trace flat at zero and a
    temperature of 0 °C — a confident wrong reading is worse than a gap."""
    monkeypatch.setattr(gpumod.subprocess, "run", fake_run(WSL_NA))
    (s,) = sample_gpus()
    assert s["temp"] is None
    assert s["power"] is None
    assert s["clock_sm"] is None
    assert s["util"] == 97  # the fields that do work still work


def test_multi_gpu(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        gpumod.subprocess, "run", fake_run(GOOD + "\n" + GOOD.replace("0, NVIDIA", "1, NVIDIA", 1))
    )
    samples = sample_gpus()
    assert [s["gpu_index"] for s in samples] == [0, 1]


def test_nonzero_exit_yields_no_samples(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpumod.subprocess, "run", fake_run("", returncode=9))
    assert sample_gpus() == []


def test_a_timeout_is_not_an_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    def _boom(cmd: list[str], **_kw: Any) -> Any:
        raise subprocess.TimeoutExpired(cmd, 5)

    monkeypatch.setattr(gpumod.subprocess, "run", _boom)
    assert sample_gpus() == []


def test_missing_nvidia_smi_yields_no_samples(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(gpumod.shutil, "which", lambda _n: None)
    assert sample_gpus() == []


def test_falls_back_to_the_old_throttle_field_name(monkeypatch: pytest.MonkeyPatch) -> None:
    """Newer drivers renamed clocks_throttle_reasons → clocks_event_reasons."""
    seen: list[str] = []

    def _run(cmd: list[str], **_kw: Any) -> subprocess.CompletedProcess[str]:
        query = next(c for c in cmd if c.startswith("--query-gpu="))
        seen.append(query)
        if "clocks_event_reasons" in query:
            return subprocess.CompletedProcess(cmd, 6, "", "Field not supported")
        if "clocks_throttle_reasons" in query:
            return subprocess.CompletedProcess(cmd, 0, "0, 0x0000000000000040\n", "")
        return subprocess.CompletedProcess(cmd, 0, GOOD, "")

    monkeypatch.setattr(gpumod.subprocess, "run", _run)
    (s,) = sample_gpus()
    assert s["throttle"] == "hw_thermal"
    assert any("clocks_event_reasons" in q for q in seen), "should try the new name first"


# ── the bitmask ──────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("0x0000000000000000", ""),
        ("0x0000000000000001", ""),  # GpuIdle — real, but costs nothing
        ("0x0000000000000004", "sw_power_cap"),
        ("0x0000000000000040", "hw_thermal"),
        ("0x0000000000000060", "sw_thermal,hw_thermal"),
        ("[N/A]", ""),
        ("[Not Supported]", ""),
        ("", ""),
        ("garbage", ""),
    ],
)
def test_decode_throttle(raw: str, expected: str) -> None:
    assert _decode_throttle(raw) == expected


@pytest.mark.parametrize(
    ("throttle", "significant"),
    [
        ("", False),
        ("hw_thermal", True),
        ("sw_power_cap", True),
        ("sw_thermal,hw_thermal", True),
    ],
)
def test_throttle_significance(throttle: str, significant: bool) -> None:
    assert throttle_is_significant(throttle) is significant
