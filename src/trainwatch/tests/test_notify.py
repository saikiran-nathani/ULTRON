"""The notifier's contract: never raise, never block, never flood.

ADR-0002 bumps this path toward L3 because it is the only component whose
failure is *silent* — everything else fails loudly or is visibly blank.
"""

from __future__ import annotations

import threading
import time
import urllib.error
from typing import Any

import pytest

from src.trainwatch.notify import Notifier, NullNotifier


class _Recorder:
    """Stand-in for urllib.request.urlopen."""

    def __init__(self, *, fail_times: int = 0, status: int = 200) -> None:
        self.calls: list[Any] = []
        self.fail_times = fail_times
        self.status = status
        self.lock = threading.Lock()

    def __call__(self, req: Any, timeout: float = 0) -> Any:
        with self.lock:
            self.calls.append(req)
            if self.fail_times > 0:
                self.fail_times -= 1
                raise urllib.error.URLError("simulated network failure")
        status = self.status

        class _Resp:
            def __enter__(self) -> Any:
                return self

            def __exit__(self, *_a: object) -> None:
                return None

        resp = _Resp()
        resp.status = status  # type: ignore[attr-defined]
        return resp


@pytest.fixture
def urlopen(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    rec = _Recorder()
    monkeypatch.setattr("src.trainwatch.notify.urllib.request.urlopen", rec)
    return rec


# ── rule 1: never raise ──────────────────────────────────────────────────


def test_network_failure_never_propagates(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(fail_times=99)
    monkeypatch.setattr("src.trainwatch.notify.urllib.request.urlopen", rec)
    n = Notifier("https://example.invalid/topic", retries=1, timeout=0.1)
    assert n.alert("boom") is True  # accepted into the queue
    n.close(timeout=5)
    assert n.failed == 1
    assert n.sent == 0


def test_alert_swallows_unexpected_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    n = Notifier("https://example.invalid/t")
    monkeypatch.setattr(n, "_allow", lambda *_a, **_k: (_ for _ in ()).throw(RuntimeError("x")))
    assert n.alert("still fine") is False  # returns, does not raise


def test_disabled_notifier_is_a_no_op() -> None:
    n = Notifier("")
    assert n.enabled is False
    assert n.alert("nothing") is False


# ── rule 2: never block ──────────────────────────────────────────────────


def test_alert_returns_immediately_even_when_the_network_hangs(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A synchronous 5s timeout inline would be a 5s stall on every alert."""

    def slow(*_a: object, **_k: object) -> Any:
        time.sleep(2.0)
        raise urllib.error.URLError("slow")

    monkeypatch.setattr("src.trainwatch.notify.urllib.request.urlopen", slow)
    n = Notifier("https://example.invalid/t", retries=0)

    start = time.monotonic()
    n.alert("urgent thing", priority="urgent")
    elapsed = time.monotonic() - start

    assert elapsed < 0.25, f"alert() blocked the caller for {elapsed:.2f}s"
    n.close(timeout=0.1)


# ── rule 3: never flood ──────────────────────────────────────────────────


def test_repeated_rule_is_deduped_by_cooldown(urlopen: _Recorder) -> None:
    n = Notifier("https://x/t", cooldown=60.0)
    accepted = [n.alert(f"spike {i}", rule="grad_norm") for i in range(500)]
    n.close(timeout=5)
    assert accepted.count(True) == 1
    assert n.suppressed == 499
    assert len(urlopen.calls) == 1


def test_different_rules_are_not_deduped_against_each_other(urlopen: _Recorder) -> None:
    n = Notifier("https://x/t", cooldown=60.0)
    assert n.alert("a", rule="grad_norm") is True
    assert n.alert("b", rule="entropy") is True
    n.close(timeout=5)
    assert len(urlopen.calls) == 2


def test_urgent_bypasses_cooldown_but_not_the_burst_cap(urlopen: _Recorder) -> None:
    """A thousand urgent alerts is a broken alerter, not a thousand emergencies."""
    n = Notifier("https://x/t", cooldown=60.0, burst=5)
    results = [n.alert("diverged", rule="nonfinite", priority="urgent") for _ in range(20)]
    n.close(timeout=5)
    assert results.count(True) == 5
    assert len(urlopen.calls) == 5


def test_cooldown_expires(urlopen: _Recorder) -> None:
    n = Notifier("https://x/t", cooldown=0.05)
    assert n.alert("first", rule="r") is True
    assert n.alert("second", rule="r") is False
    time.sleep(0.08)
    assert n.alert("third", rule="r") is True
    n.close(timeout=5)


# ── delivery details ─────────────────────────────────────────────────────


def test_retries_then_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    rec = _Recorder(fail_times=2)
    monkeypatch.setattr("src.trainwatch.notify.urllib.request.urlopen", rec)
    n = Notifier("https://x/t", retries=2, timeout=0.1)
    n.alert("eventually")
    n.close(timeout=10)
    assert n.sent == 1
    assert len(rec.calls) == 3


def test_headers_are_latin1_safe(urlopen: _Recorder) -> None:
    """A non-ASCII Title raises UnicodeEncodeError inside http.client."""
    n = Notifier("https://x/t")
    n.alert("body", title="run 🔥 diverged")
    n.close(timeout=5)
    req = urlopen.calls[0]
    req.get_header("Title").encode("latin-1")  # must not raise


def test_body_carries_utf8(urlopen: _Recorder) -> None:
    n = Notifier("https://x/t")
    n.alert("loss ≈ 3.2 · µs")
    n.close(timeout=5)
    assert "≈".encode() in urlopen.calls[0].data


def test_bearer_token_is_sent_when_configured(urlopen: _Recorder) -> None:
    n = Notifier("https://x/t", token="secret-token")
    n.alert("hi")
    n.close(timeout=5)
    assert urlopen.calls[0].get_header("Authorization") == "Bearer secret-token"


# ── the test double ──────────────────────────────────────────────────────


def test_null_notifier_records_and_still_rate_limits() -> None:
    n = NullNotifier()
    assert n.enabled is True
    for _ in range(10):
        n.alert("x", rule="same")
    assert len(n.messages) == 1
