"""HTTP enforcement of ADR-0004 C7/C8/C10/C12.

`test_auth.py` covers the auth core. This file covers the wiring: cookies,
CSRF, scopes, and where AuthGuard sits relative to ADR-0003's SecurityGuard.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from src.trainwatch import auth as auth_mod
from src.trainwatch.auth import Auth
from src.trainwatch.config import Config
from src.trainwatch.server.app import create_app
from src.trainwatch.server.auth_api import (
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SESSION_COOKIE_HOST,
)

PW = "correct horse battery staple"
GUARD = {"X-Trainwatch": "1"}


@pytest.fixture(autouse=True)
def cheap_kdf(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """scrypt at shipped cost is ~150 ms; these tests log in many times."""
    monkeypatch.setattr(auth_mod, "_N", 2**8)
    yield


@pytest.fixture
def open_client(cfg: Config) -> Iterator[TestClient]:
    """No accounts: the ADR-0003 posture, enforcement dormant."""
    with TestClient(create_app(cfg)) as c:
        yield c


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    """One owner account exists, so enforcement is live."""
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
    with TestClient(create_app(cfg)) as c:
        yield c


def _login(c: TestClient, password: str = PW) -> None:
    # GUARD is required: login is a POST to /api/, so ADR-0003's C3 guard
    # header applies to it exactly as it does to any other write. The SPA has
    # to send it too.
    resp = c.post(
        "/api/auth/login", json={"username": "sai", "password": password}, headers=GUARD
    )
    assert resp.status_code == 200, resp.text


def _csrf(c: TestClient) -> dict[str, str]:
    return {CSRF_HEADER: c.cookies[CSRF_COOKIE], **GUARD}


# ── self-activation ──────────────────────────────────────────────────────


def test_with_no_accounts_the_api_stays_open(open_client: TestClient) -> None:
    """A migration must not lock you out of a dashboard that worked yesterday."""
    assert open_client.get("/api/state").status_code == 200
    body = open_client.get("/api/auth/whoami").json()
    assert body == {"authenticated": False, "enforcing": False}


def test_creating_an_account_turns_enforcement_on(cfg: Config) -> None:
    with TestClient(create_app(cfg)) as c:
        assert c.get("/api/state").status_code == 200
        with Auth(cfg.db_path) as auth:
            auth.create_user("sai", PW)
        # Same app instance, no restart: the next request is already enforced.
        assert c.get("/api/state").status_code == 401
        assert c.get("/api/auth/whoami").json()["enforcing"] is True


def test_require_auth_forces_it_on_with_no_accounts(cfg: Config) -> None:
    forced = replace(cfg, require_auth=True)
    with TestClient(create_app(forced)) as c:
        assert c.get("/api/state").status_code == 401


# ── sessions over HTTP ───────────────────────────────────────────────────


def test_unauthenticated_api_is_refused(client: TestClient) -> None:
    resp = client.get("/api/state")
    assert resp.status_code == 401
    assert resp.json()["error"] == "authentication required"


def test_the_spa_shell_stays_public(client: TestClient) -> None:
    """The browser has to be able to load something that renders a login form."""
    assert client.get("/").status_code in {200, 503}  # 503 when no bundle is built


def test_login_then_read(client: TestClient) -> None:
    _login(client)
    assert client.get("/api/state").status_code == 200
    who = client.get("/api/auth/whoami").json()
    assert who["authenticated"] is True
    assert who["kind"] == "human"
    assert who["name"] == "sai"


def test_bad_credentials_are_indistinguishable(client: TestClient) -> None:
    wrong = client.post(
        "/api/auth/login", json={"username": "sai", "password": "nope"}, headers=GUARD
    )
    ghost = client.post(
        "/api/auth/login", json={"username": "ghost", "password": PW}, headers=GUARD
    )
    assert wrong.status_code == ghost.status_code == 401
    assert wrong.json() == ghost.json() == {"error": "invalid credentials"}


def test_login_rejects_a_malformed_body(client: TestClient) -> None:
    assert client.post(
        "/api/auth/login", content=b"not json", headers=GUARD
    ).status_code == 400
    assert client.post(
        "/api/auth/login", json={"username": "sai"}, headers=GUARD
    ).status_code == 400


def test_logout_revokes_server_side(client: TestClient) -> None:
    _login(client)
    headers = _csrf(client)
    assert client.post("/api/auth/logout", headers=headers).status_code == 200
    assert client.get("/api/state").status_code == 401


def test_rate_limit_returns_429_with_retry_after(client: TestClient) -> None:
    for _ in range(auth_mod.LOCKOUT_AFTER):
        assert client.post(
            "/api/auth/login",
            json={"username": "sai", "password": "nope"},
            headers=GUARD,
        ).status_code == 401
    resp = client.post(
        "/api/auth/login", json={"username": "sai", "password": PW}, headers=GUARD
    )
    assert resp.status_code == 429
    assert resp.headers["Retry-After"] == str(int(auth_mod.LOCKOUT_WINDOW))


# ── the Secure/__Host- cookie trap ───────────────────────────────────────


def test_localhost_gets_the_host_prefixed_secure_cookie(cfg: Config) -> None:
    """localhost is a secure context by fiat, so __Host- works there."""
    local = replace(cfg, allowed_hosts="localhost,testserver")
    with Auth(local.db_path) as auth:
        auth.create_user("sai", PW)
    with TestClient(create_app(local), base_url="http://localhost") as c:
        resp = c.post(
            "/api/auth/login", json={"username": "sai", "password": PW}, headers=GUARD
        )
        cookie = resp.headers["set-cookie"]
        assert SESSION_COOKIE_HOST in cookie
        assert "Secure" in cookie
        assert "HttpOnly" in cookie
        assert "samesite=lax" in cookie.lower()
        # __Host- is only honoured with Path=/ and no Domain attribute
        assert "Path=/" in cookie
        assert "Domain" not in cookie


def test_plain_http_to_a_non_local_host_drops_secure(client: TestClient) -> None:
    """The trap: a Secure cookie over http://100.x is silently discarded.

    TestClient's base_url is http://testserver, which is neither HTTPS nor
    localhost — the same shape as reaching this box on its tailnet IP. If the
    cookie went out `Secure` and `__Host-` prefixed here, login would return
    200, set nothing the browser keeps, and every later request would look
    unauthenticated with no error to explain it.
    """
    resp = client.post(
        "/api/auth/login", json={"username": "sai", "password": PW}, headers=GUARD
    )
    cookie = resp.headers["set-cookie"]
    assert SESSION_COOKIE in cookie
    assert SESSION_COOKIE_HOST not in cookie
    assert "Secure" not in cookie
    assert "HttpOnly" in cookie, "dropping Secure must not also drop HttpOnly"
    # and it actually works
    assert client.get("/api/state").status_code == 200


def test_the_csrf_cookie_is_readable_by_js(client: TestClient) -> None:
    """It has to be: the SPA echoes it into a header. That is the mechanism."""
    resp = client.post(
        "/api/auth/login", json={"username": "sai", "password": PW}, headers=GUARD
    )
    csrf = [c for c in resp.headers.get_list("set-cookie") if c.startswith(CSRF_COOKIE)]
    assert csrf, "no CSRF cookie was set"
    assert "HttpOnly" not in csrf[0]


# ── C12: CSRF ────────────────────────────────────────────────────────────


def test_a_write_without_the_csrf_header_is_refused(client: TestClient) -> None:
    _login(client)
    resp = client.post("/api/clip", json={"body": "hi"}, headers=GUARD)
    assert resp.status_code == 403
    assert "CSRF" in resp.json()["error"]


def test_a_write_with_a_mismatched_csrf_token_is_refused(client: TestClient) -> None:
    _login(client)
    resp = client.post(
        "/api/clip", json={"body": "hi"}, headers={CSRF_HEADER: "wrong", **GUARD}
    )
    assert resp.status_code == 403


def test_a_write_with_the_matching_token_succeeds(client: TestClient) -> None:
    _login(client)
    resp = client.post("/api/clip", json={"body": "hi"}, headers=_csrf(client))
    assert resp.status_code == 201, resp.text


def test_reads_need_no_csrf_token(client: TestClient) -> None:
    _login(client)
    assert client.get("/api/state").status_code == 200


# ── C10: machine tokens ──────────────────────────────────────────────────


def test_a_machine_token_reads_without_a_cookie(client: TestClient, cfg: Config) -> None:
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("ipad", {"read"})
    resp = client.get("/api/state", headers={"Authorization": f"Bearer {grant.secret}"})
    assert resp.status_code == 200


def test_a_machine_token_writes_without_a_csrf_token(client: TestClient, cfg: Config) -> None:
    """A bearer token is not sent automatically by a browser, so it is not a
    CSRF vector, and demanding the header would break every CLI client."""
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("cli", {"progress:write"})
    resp = client.post(
        "/api/clip",
        json={"body": "from the cli"},
        headers={"Authorization": f"Bearer {grant.secret}", **GUARD},
    )
    assert resp.status_code == 201, resp.text


def test_a_read_only_token_cannot_write(client: TestClient, cfg: Config) -> None:
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("ipad", {"read"})
    resp = client.post(
        "/api/clip",
        json={"body": "nope"},
        headers={"Authorization": f"Bearer {grant.secret}", **GUARD},
    )
    assert resp.status_code == 403
    assert resp.json()["error"] == "insufficient scope"


def test_a_write_only_token_cannot_read(client: TestClient, cfg: Config) -> None:
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("tuf", {"telemetry:write"})
    resp = client.get("/api/state", headers={"Authorization": f"Bearer {grant.secret}"})
    assert resp.status_code == 403


def test_a_revoked_token_stops_working(client: TestClient, cfg: Config) -> None:
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("ipad", {"read"})
        auth.revoke_token("ipad")
    resp = client.get("/api/state", headers={"Authorization": f"Bearer {grant.secret}"})
    assert resp.status_code == 401


def test_a_garbage_bearer_token_is_refused_not_crashed(client: TestClient) -> None:
    for bad in ("twk_nonsense", "twk_a_b", "Bearer", "twk_"):
        resp = client.get("/api/state", headers={"Authorization": f"Bearer {bad}"})
        assert resp.status_code == 401, bad


# ── middleware order ─────────────────────────────────────────────────────


def test_securityguard_runs_before_authguard(client: TestClient) -> None:
    """ADR-0003's Host allowlist must reject before AuthGuard touches the DB.

    Starlette's `add_middleware` inserts at position 0, so the *last* one
    registered is the outermost. `create_app` therefore registers AuthGuard
    first and SecurityGuard second — the reverse of reading order, and easy to
    break by moving a line. A bad Host must give 421, not 401: getting 401
    would mean an unauthenticated stranger on a rebound DNS name had already
    caused a database read.
    """
    resp = client.get("/api/state", headers={"Host": "evil.example.com"})
    assert resp.status_code == 421, f"expected the Host guard to win, got {resp.status_code}"


def test_a_bad_host_is_refused_even_when_authenticated(client: TestClient) -> None:
    _login(client)
    assert client.get("/api/state", headers={"Host": "evil.example.com"}).status_code == 421


def test_cross_origin_is_still_refused_after_login(client: TestClient) -> None:
    """C2 does not weaken because a session exists."""
    _login(client)
    resp = client.get("/api/state", headers={"Origin": "https://evil.example.com"})
    assert resp.status_code == 403


# ── the audit trail reaches the HTTP layer ───────────────────────────────


def test_http_logins_are_audited_and_the_chain_holds(client: TestClient, cfg: Config) -> None:
    client.post(
        "/api/auth/login", json={"username": "sai", "password": "nope"}, headers=GUARD
    )
    _login(client)
    with Auth(cfg.db_path) as auth:
        actions = [r["action"] for r in auth.audit(limit=50)]
        assert "login.fail" in actions
        assert "login.ok" in actions
        ok, why = auth.verify_chain()
        assert ok, why
