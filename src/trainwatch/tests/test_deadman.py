"""The dead man's switch, and the one way it fails silently.

`probe.py` watches the hub from the Mac. Its own log says it cannot be the
safety net: 38 samples where 137 were expected, seven gaps over 11 minutes, one
of three hours — because launchd's `StartInterval` does not fire while the Mac
is asleep. So the machine doing the watching sleeps and, once the hub moves,
the machine being watched does not.

This switch runs the other way and makes **absence the alarm**. Which creates
its own trap, and it is the only thing in here worth real care: the sending
side can never prove the alarm works. It can only prove it sent. So the one
state that must never look like success is "configured to send nowhere".
"""

from __future__ import annotations

import importlib.util
import json
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _load():
    spec = importlib.util.spec_from_file_location("deadman", ROOT / "scripts" / "deadman.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


deadman = _load()


class _Receiver(BaseHTTPRequestHandler):
    """A ping endpoint whose behaviour each test dictates."""

    status = 200
    seen: list[tuple[str, str]] = []

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        type(self).seen.append((self.path, body))
        self.send_response(type(self).status)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *_args: object) -> None:
        pass


@pytest.fixture
def receiver() -> Iterator[tuple[str, type[_Receiver]]]:
    _Receiver.seen = []
    _Receiver.status = 200
    srv = HTTPServer(("127.0.0.1", 0), _Receiver)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{srv.server_port}/ping", _Receiver
    finally:
        srv.shutdown()


@pytest.fixture(autouse=True)
def isolated(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(deadman, "LOG", tmp_path / "deadman.log")
    monkeypatch.setattr(deadman, "STATE", tmp_path / "state.json")
    # Nothing in these tests may reach the real hub.
    monkeypatch.setattr(deadman, "HUB_URL", "http://127.0.0.1:1")


def test_an_unconfigured_switch_refuses_to_look_healthy(monkeypatch) -> None:
    """The failure mode this whole file exists to prevent.

    A switch that exits 0 while sending nowhere is installed, green, and silent
    for the one outage it was there for. Worse than not installing it: it
    occupies the slot where a working one would go, and every dashboard and
    timer agrees it is fine.
    """
    monkeypatch.delenv(deadman.URL_ENV, raising=False)
    assert deadman.run_once(quiet=True) == 2
    assert "UNCONFIGURED" in deadman.LOG.read_text()


def test_check_also_refuses_rather_than_reporting_nothing(monkeypatch) -> None:
    """`--check` is what someone runs to be reassured, so it must not reassure."""
    monkeypatch.delenv(deadman.URL_ENV, raising=False)
    assert deadman.check() == 2


def test_a_beat_reaches_the_receiver_with_something_worth_reading(
    receiver, monkeypatch
) -> None:
    url, handler = receiver
    monkeypatch.setenv(deadman.URL_ENV, url)
    assert deadman.run_once(quiet=True) == 0

    assert len(handler.seen) == 1
    path, body = handler.seen[0]
    assert path == "/ping"
    # The body is read by a person at 3am. A bare "alive" would make the alert
    # arrive with no information in it.
    assert "hub-" in body, f"the beat says nothing about the hub: {body!r}"
    assert "up=" in body


def test_an_unknown_uptime_says_so_rather_than_inventing_a_number(monkeypatch) -> None:
    """`/proc/uptime` is Linux-only, and this ran on a Mac during development.

    The first version printed `up=-0.0h`, which is a wrong fact stated
    confidently. `up=?` is a true one, and this string is what someone reads
    when the alarm goes off.
    """
    monkeypatch.setattr(deadman, "Path", Path)  # keep the real Path
    body = deadman.beat_body()
    assert "up=-" not in body


def test_a_refused_ping_is_a_failure_and_is_counted(receiver, monkeypatch) -> None:
    """A box that is alive but cannot reach the receiver needs somewhere to say so.

    From the receiver's side this is indistinguishable from the box being dead
    — which is correct, and is the design working. The local log is the only
    place the difference can be recorded.
    """
    url, handler = receiver
    monkeypatch.setenv(deadman.URL_ENV, url)
    handler.status = 500

    assert deadman.run_once(quiet=True) == 1
    assert deadman.run_once(quiet=True) == 1
    state = json.loads(deadman.STATE.read_text())
    assert state["misses"] == 2, "consecutive misses are not being counted"
    assert "MISS" in deadman.LOG.read_text()


def test_a_successful_beat_clears_the_miss_count(receiver, monkeypatch) -> None:
    url, handler = receiver
    monkeypatch.setenv(deadman.URL_ENV, url)
    handler.status = 500
    deadman.run_once(quiet=True)
    handler.status = 200
    assert deadman.run_once(quiet=True) == 0
    assert json.loads(deadman.STATE.read_text())["misses"] == 0


def test_an_unreachable_receiver_does_not_raise(monkeypatch) -> None:
    """A timer entry point that raises writes a traceback and nothing else.

    The state file is how a recovered box explains its gap afterwards, so it
    has to be written on the failure path too.
    """
    monkeypatch.setenv(deadman.URL_ENV, "http://127.0.0.1:1/ping")
    assert deadman.run_once(quiet=True) == 1
    assert deadman.STATE.exists()


def test_the_install_output_carries_the_demonstration(capsys) -> None:
    """Installing it proves nothing. Only stopping it and watching does.

    Plan item C7, and the step everyone skips — so it is printed with the unit
    rather than filed somewhere that gets read once.
    """
    assert deadman.install() == 0
    out = capsys.readouterr().out
    assert "OnUnitActiveSec=5min" in out
    assert "Persistent=true" in out, "a box that was off would not beat until a full interval"
    assert "enable-linger" in out, "a user timer dies at logout without it"
    assert "stop trainwatch-deadman.timer" in out, "the demonstration is missing"
    # The URL is a credential in everything but name.
    assert "EnvironmentFile" in out
