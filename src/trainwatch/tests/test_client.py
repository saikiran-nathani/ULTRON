"""The CLI's hub client. Small surface, but it is the Linux half of the bridge."""

from __future__ import annotations

import json
import urllib.error
from typing import Any

import pytest

from src.trainwatch.client import HubClient, HubError, _explain
from src.trainwatch.security import GUARD_HEADER


class _Fake:
    """Captures the outbound request and returns a canned response."""

    def __init__(self, body: bytes = b"{}", status: int = 200) -> None:
        self.requests: list[Any] = []
        self.body = body
        self.status = status

    def __call__(self, req: Any, timeout: float = 0) -> Any:
        self.requests.append(req)
        body, status = self.body, self.status

        class _Resp:
            def __enter__(self) -> Any:
                return self

            def __exit__(self, *_a: object) -> None:
                return None

            def read(self) -> bytes:
                return body

            @property
            def status(self) -> int:
                return status

        return _Resp()


@pytest.fixture
def fake(monkeypatch: pytest.MonkeyPatch) -> _Fake:
    f = _Fake()
    monkeypatch.setattr("src.trainwatch.client.urllib.request.urlopen", f)
    return f


def client() -> HubClient:
    return HubClient("http://hub:8730", device="asus")


# ── the guard contract ───────────────────────────────────────────────────


def test_every_request_carries_the_guard_header(fake: _Fake) -> None:
    """ADR-0003 C3 rejects writes without it. Sending it unconditionally is
    simpler than remembering which verbs need it."""
    client().push("hello")
    # urllib normalises header keys with capitalize(), not title().
    assert fake.requests[0].get_header(GUARD_HEADER.capitalize()) == "1"


def test_device_header_is_sent(fake: _Fake) -> None:
    client().push("hello")
    assert fake.requests[0].get_header("X-trainwatch-device") == "asus"


def test_token_is_sent_when_configured(fake: _Fake) -> None:
    HubClient("http://hub:8730", token="abc", device="asus").push("x")
    assert fake.requests[0].get_header("Authorization") == "Bearer abc"


def test_no_authorization_header_when_no_token(fake: _Fake) -> None:
    client().push("x")
    assert fake.requests[0].get_header("Authorization") is None


# ── payloads ─────────────────────────────────────────────────────────────


def test_push_sends_the_flags(fake: _Fake) -> None:
    client().push("secret text", secret=True, pinned=True)
    body = json.loads(fake.requests[0].data)
    assert body == {"body": "secret text", "secret": True, "pinned": True, "kind": "text"}


def test_upload_builds_a_valid_multipart_body(fake: _Fake, tmp_path: Any) -> None:
    """Hand-rolled because the core takes no third-party deps; if the boundary
    or CRLFs are wrong the server rejects it with an opaque 422."""
    f = tmp_path / "plot.png"
    f.write_bytes(b"\x89PNG\r\n\x1a\nbody")
    client().upload(f)
    req = fake.requests[0]
    ctype = req.get_header("Content-type")
    boundary = ctype.split("boundary=")[1]
    raw = req.data
    assert ctype.startswith("multipart/form-data")
    assert raw.startswith(f"--{boundary}\r\n".encode())
    assert raw.endswith(f"\r\n--{boundary}--\r\n".encode())
    assert b'name="file"; filename="plot.png"' in raw
    assert b"Content-Type: image/png" in raw
    assert b"\x89PNG" in raw


def test_note_ids_are_url_quoted(fake: _Fake) -> None:
    client().put_note("my notes/2026", "body")
    assert (
        "my%20notes/2026" in fake.requests[0].full_url
        or "my%20notes%2F2026" in fake.requests[0].full_url
    )


# ── responses + errors ───────────────────────────────────────────────────


def test_malformed_json_becomes_an_empty_object(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("src.trainwatch.client.urllib.request.urlopen", _Fake(b'"a string"'))
    assert client().latest() == {}


def test_unreachable_hub_explains_what_to_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(*_a: object, **_k: object) -> Any:
        raise urllib.error.URLError("Connection refused")

    monkeypatch.setattr("src.trainwatch.client.urllib.request.urlopen", boom)
    with pytest.raises(HubError, match="trainwatch serve"):
        client().latest()


@pytest.mark.parametrize(
    ("code", "needle"),
    [
        (421, "TRAINWATCH_ALLOWED_HOSTS"),
        (401, "TRAINWATCH_TOKEN"),
        (403, "origin/guard-header"),
        (413, "64 MB"),
        (500, "HTTP 500"),
    ],
)
def test_guard_refusals_are_translated_into_actions(code: int, needle: str) -> None:
    """A bare 421 from a DNS-rebinding guard looks exactly like a bug. The
    message has to name the fix."""
    assert needle in _explain(code, "detail", "http://hub/api/clip")
