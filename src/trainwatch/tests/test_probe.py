"""The off-box probe: it must be able to fail, and for the right reasons.

A monitor nobody has watched go red is a decoration with a green light
attached. These tests exist because the hub's real outage — alive, listening,
resetting every connection after exhausting its descriptors — is invisible to
every on-box check, and a probe that cannot distinguish "answered correctly"
from "answered" would have missed it too.

The notifier path is tested specifically. The first version of `_notify` called
`Config.load()` and `Notifier(cfg).send()`, neither of which exists; it failed
into the log on every alert. The alerting path had never been run, so
"notifications work" was an assumption. That is the same defect as the thing
being monitored.
"""

from __future__ import annotations

import importlib.util
import json
import socket
import threading
from collections.abc import Iterator
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _load_probe():
    """Import scripts/probe.py by path — it is a script, not a package member."""
    spec = importlib.util.spec_from_file_location("probe", ROOT / "scripts" / "probe.py")
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


probe = _load_probe()


class _Handler(BaseHTTPRequestHandler):
    """A hub stand-in whose behaviour each test dictates."""

    healthz_status = 200
    state_status = 200
    state_body: object = {"now": 1.0, "version": "0.1.0", "status": "healthy"}
    state_raw: bytes | None = None

    def log_message(self, *_args: object) -> None:
        pass  # keep pytest output clean

    def do_GET(self) -> None:
        if self.path == "/healthz":
            self.send_response(self.healthz_status)
            self.end_headers()
            self.wfile.write(b'{"ok":true}')
            return
        if self.path == "/api/state":
            self.send_response(self.state_status)
            self.end_headers()
            body = (
                self.state_raw
                if self.state_raw is not None
                else json.dumps(self.state_body).encode()
            )
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()


@pytest.fixture
def server() -> Iterator[tuple[str, type[_Handler]]]:
    """A live HTTP server on a free port, reset between tests."""

    class Handler(_Handler):
        healthz_status = 200
        state_status = 200
        state_body: object = {"now": 1.0, "version": "0.1.0", "status": "healthy"}
        state_raw: bytes | None = None

    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    httpd = HTTPServer(("127.0.0.1", port), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    try:
        yield f"http://127.0.0.1:{port}", Handler
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_a_healthy_hub_passes(server) -> None:
    base, _ = server
    ok, reason = probe.check(base)
    assert ok is True
    assert "healthy" in reason


def test_an_unreachable_hub_fails() -> None:
    """Nothing listening at all — the ordinary outage.

    No fixture: this needs a port with nothing behind it, which is the
    opposite of what the server fixture provides.
    """
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        dead = f"http://127.0.0.1:{s.getsockname()[1]}"
    ok, reason = probe.check(dead)
    assert ok is False
    assert "unreachable" in reason


def test_a_500_from_healthz_fails(server) -> None:
    base, handler = server
    handler.healthz_status = 500
    ok, reason = probe.check(base)
    assert ok is False
    assert "500" in reason


def test_a_200_that_is_not_json_fails(server) -> None:
    """"Up but answering wrongly" — the case a status-code check misses.

    A reverse proxy error page, a partially-initialised app, an HTML 200 from
    the wrong vhost. `/healthz` says 200 and the app is useless.
    """
    base, handler = server
    handler.state_raw = b"<html>it me, a proxy error page</html>"
    ok, reason = probe.check(base)
    assert ok is False
    assert "not JSON" in reason


def test_a_200_missing_required_fields_fails(server) -> None:
    """Valid JSON, wrong shape. Still broken, still must be caught."""
    base, handler = server
    handler.state_body = {"unexpected": True}
    ok, reason = probe.check(base)
    assert ok is False
    assert "missing" in reason


def test_a_401_from_state_counts_as_serving(server) -> None:
    """Auth is enforced and the probe has no session.

    That is correct behaviour and proves the app is serving, which is the only
    thing this layer claims to measure. Treating it as an outage would make
    the probe fire continuously the moment an account exists — and a monitor
    that cries wolf gets muted, which is worse than not having one.
    """
    base, handler = server
    handler.state_status = 401
    ok, reason = probe.check(base)
    assert ok is True
    assert "401" in reason


def test_the_failure_streak_and_recovery_are_tracked(server, tmp_path, monkeypatch) -> None:
    """Alert once per outage, not once per probe.

    An alert every five minutes for the duration of an outage trains you to
    ignore the channel.
    """
    base, handler = server
    monkeypatch.setattr(probe, "STATE", tmp_path / "state.json")
    monkeypatch.setattr(probe, "LOG", tmp_path / "probe.log")
    monkeypatch.setattr(probe, "_urls", lambda: [base])

    alerts: list[tuple[str, str]] = []
    monkeypatch.setattr(probe, "_notify", lambda t, b: alerts.append((t, b)) or True)

    assert probe.run_once(quiet=True) == 0
    assert alerts == []

    handler.healthz_status = 503
    for expected in range(1, probe.FAILURES_BEFORE_ALERT + 3):
        assert probe.run_once(quiet=True) == 1
        assert json.loads((tmp_path / "state.json").read_text())["failures"] == expected

    assert len(alerts) == 1, f"expected exactly one alert per outage, got {len(alerts)}"
    assert "not serving" in alerts[0][0]

    handler.healthz_status = 200
    assert probe.run_once(quiet=True) == 0
    assert json.loads((tmp_path / "state.json").read_text())["failures"] == 0
    assert len(alerts) == 2 and "recovered" in alerts[1][0]


def test_notify_uses_an_api_that_exists() -> None:
    """The bug that made the alerting path a no-op.

    `_notify` swallows every exception so a broken notifier cannot break the
    probe — which also means a typo in it is invisible. So the names it depends
    on are asserted here rather than trusted.
    """
    from src.trainwatch.config import load_config
    from src.trainwatch.notify import Notifier

    cfg = load_config()
    assert hasattr(cfg, "notify_enabled")
    assert hasattr(cfg, "ntfy_url")
    assert hasattr(cfg, "ntfy_token")
    assert callable(Notifier.alert)
    assert callable(Notifier.close)


def test_notify_returns_false_rather_than_raising_when_unconfigured(monkeypatch) -> None:
    """With no ntfy topic the probe must still work and still exit non-zero.

    A probe whose only output is a notification you have not set up is a probe
    that reports nothing.
    """
    monkeypatch.delenv("TRAINWATCH_NTFY_TOPIC", raising=False)
    assert probe._notify("t", "b") is False


def test_the_probe_url_is_overridable(monkeypatch) -> None:
    """So it can point at the TUF once the hub moves there."""
    monkeypatch.setenv("TRAINWATCH_PROBE_URL", "http://tuf:8730/")
    assert probe._urls() == ["http://tuf:8730"]


def test_a_blind_window_is_written_down_rather_than_skipped_over(
    server, tmp_path: Path, monkeypatch
) -> None:
    """A gap in the log must not read as a healthy stretch.

    Measured, not imagined: eleven hours of the real log holds 38 samples where
    137 were expected, with seven gaps over 11 minutes and one of three hours.
    launchd's `StartInterval` does not fire while the Mac is asleep and
    coalesces the misses into one catch-up run, so a closed lid is a blind
    monitor — and a log containing only the samples it managed to take shows
    that blindness as an unbroken line of `ok`.

    The hub was once dead for six hours while its supervisor reported it
    running. A monitor that cannot tell "fine" from "nobody was looking" would
    not have caught that either, which is the whole inversion this file exists
    to correct.
    """
    base, _handler = server
    monkeypatch.setattr(probe, "STATE", tmp_path / "state.json")
    monkeypatch.setattr(probe, "LOG", tmp_path / "probe.log")
    monkeypatch.setattr(probe, "_urls", lambda: [base])
    monkeypatch.setattr(probe, "_notify", lambda t, b: True)

    assert probe.run_once(quiet=True) == 0
    log = (tmp_path / "probe.log").read_text()
    assert "UNMONITORED" not in log, "the first run has nothing to compare against"

    # Rewind the recorded check by three hours: the Mac was asleep.
    state = json.loads((tmp_path / "state.json").read_text())
    assert "last_check" in state, "the probe does not record when it last ran"
    state["last_check"] = state["last_check"] - 3 * 60 * 60
    (tmp_path / "state.json").write_text(json.dumps(state))

    assert probe.run_once(quiet=True) == 0
    log = (tmp_path / "probe.log").read_text()
    assert "UNMONITORED for 180 min" in log, f"the blind window was not reported:\n{log}"
    assert "may have been down" in log

    # A normal interval says nothing — a line on every run would be noise, and
    # noise is how a channel gets muted.
    assert probe.run_once(quiet=True) == 0
    assert (tmp_path / "probe.log").read_text().count("UNMONITORED") == 1
