"""The contract between the server's auth and the dashboard's client half.

`test_auth_http.py` proves the server behaves correctly. It cannot prove that
the SPA speaks the same protocol, and for a long time the SPA did not speak it
at all — `auth.py` (582 LOC) and `auth_api.py` (322) were complete while
`dashboard/src` contained no `csrf`, no `whoami`, no login form. Enforcement
is self-activating, so `trainwatch user add` — a correct, desirable action —
would have taken the dashboard dark on all five devices with the CLI as the
only way back.

Two distinct failure modes are covered here, and neither is visible to the
tests either side of the boundary:

**Drift.** The client hard-codes `"tw_csrf"` and `"X-CSRF-Token"` because a
browser has no way to discover them. Rename either constant in Python and
every server test still passes, while every write from the dashboard starts
returning 403 "CSRF token missing or mismatched" — a message that accurately
describes the symptom and says nothing about the cause. So these tests read
the TypeScript and compare, which is the only place the two halves can be
checked against each other.

**The EventSource limitation.** `EventSource` cannot set request headers. Not
"does not by default" — the API has no parameter for it. So SSE must
authenticate on the cookie alone, and if the guard ever required a header on
GETs the live dashboard would stop updating with no error in the UI, no error
in the log, and a run that appears frozen rather than unmonitored.
"""

from __future__ import annotations

import asyncio
import json
import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.trainwatch import auth as auth_mod
from src.trainwatch.auth import Auth
from src.trainwatch.config import Config
from src.trainwatch.security import GUARD_HEADER
from src.trainwatch.server.app import create_app
from src.trainwatch.server.auth_api import (
    _PUBLIC_EXACT,
    CSRF_COOKIE,
    CSRF_HEADER,
    SESSION_COOKIE,
    SESSION_COOKIE_HOST,
)

PW = "correct-horse-battery"
GUARD = {"X-Trainwatch": "1"}

# dashboard/src/ is committed in this repo, so this is a path and not a guess.
CLIENT = Path(__file__).resolve().parents[3] / "dashboard" / "src" / "lib" / "auth.ts"


@pytest.fixture(autouse=True)
def cheap_kdf(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """scrypt at shipped cost is ~150 ms; these tests log in repeatedly."""
    monkeypatch.setattr(auth_mod, "_N", 2**8)
    yield


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
    with TestClient(create_app(cfg)) as c:
        yield c


def _login(c: TestClient) -> None:
    resp = c.post("/api/auth/login", json={"username": "sai", "password": PW}, headers=GUARD)
    assert resp.status_code == 200, resp.text


@pytest.fixture
def client_source() -> str:
    assert CLIENT.exists(), (
        f"{CLIENT} is missing.\n"
        "The server's auth is self-activating: with no client half, creating a "
        "user takes the dashboard dark on every device. If the client was moved, "
        "update CLIENT in this test rather than deleting the test."
    )
    return CLIENT.read_text(encoding="utf-8")


def _ts_const(source: str, name: str) -> str:
    """Read `const NAME = "value";` out of the TypeScript.

    Deliberately a literal-only match. If someone computes the value at
    runtime this raises instead of quietly passing, because a computed cookie
    name is exactly the change this test exists to catch.
    """
    m = re.search(rf'^const {re.escape(name)} = "([^"]*)";', source, re.M)
    assert m is not None, (
        f"could not find `const {name} = \"...\";` in {CLIENT.name}.\n"
        "This test compares literals across the language boundary; if the "
        "declaration moved or became computed, that is the thing to look at."
    )
    return m.group(1)


# ── drift between the two halves ─────────────────────────────────────────


def test_the_client_and_server_agree_on_the_csrf_cookie_name(client_source: str) -> None:
    assert _ts_const(client_source, "CSRF_COOKIE") == CSRF_COOKIE


def test_the_client_and_server_agree_on_the_csrf_header_name(client_source: str) -> None:
    # The server lower-cases its constant because ASGI hands headers down
    # lower-cased; HTTP header names are case-insensitive, so compare that way
    # rather than forcing either side to change its natural spelling.
    assert _ts_const(client_source, "CSRF_HEADER").lower() == CSRF_HEADER.lower()


def test_the_client_sends_the_adr0003_guard_header_on_writes(client_source: str) -> None:
    """Without it a write is refused with 403 — including the login itself.

    This is the trap worth an hour: a 403 from `/api/auth/login` reads exactly
    like a rejected password, and the credentials are fine.
    """
    m = re.search(r"export function writeHeaders\b.*?\n}", client_source, re.S)
    assert m is not None, "writeHeaders() not found; it is what threads C3 and C12"
    body = m.group(0)
    assert GUARD_HEADER.lower() in body.lower(), (
        f"writeHeaders() does not set {GUARD_HEADER}. Every /api/ write, login "
        "included, is refused with 403 without it."
    )


def _strip_comments(ts: str) -> str:
    """Drop // and /* */ comments so assertions see code, not prose.

    Crude on purpose — it does not track string literals, so a `//` inside a
    string would be treated as a comment. That is acceptable here because the
    assertions below only ask whether an identifier is *absent*, and stripping
    too much can only make an absence claim easier to satisfy in a way that
    would then be caught by the positive assertions in the other tests.
    """
    ts = re.sub(r"/\*.*?\*/", "", ts, flags=re.S)
    return re.sub(r"//[^\n]*", "", ts)


def test_the_client_never_tries_to_read_the_session_cookie(client_source: str) -> None:
    """The session cookie is HttpOnly under both of its names, so JS cannot
    see it — and the correct client behaviour is to not try, and to ask
    `/api/auth/whoami` instead.

    Worth asserting because reading `document.cookie` for the session is a
    tempting shortcut that *cannot* work and fails silently: a live, valid
    session would read as "logged out", and the client would show a login form
    to someone who is already authenticated.
    """
    code = _strip_comments(client_source)
    for name in (SESSION_COOKIE_HOST, SESSION_COOKIE):
        assert name not in code, (
            f"{CLIENT.name} references the session cookie {name!r} in code. "
            "Both names are HttpOnly, so JS reads nothing and a valid session "
            "looks logged out. Use /api/auth/whoami."
        )
    # The honest probe must be present instead.
    assert "/api/auth/whoami" in code

    # document.cookie is legitimate for exactly one thing: the CSRF token,
    # which is deliberately not HttpOnly so it can be echoed in a header.
    for m in re.finditer(r"document\.cookie", code):
        window = code[max(0, m.start() - 400) : m.end() + 200]
        assert "CSRF_COOKIE" in window or CSRF_COOKIE in window, (
            "document.cookie is read somewhere that is not the CSRF token. "
            "That is the only cookie this app can legitimately read from JS."
        )


def test_the_client_resolves_all_three_boot_states(client_source: str) -> None:
    """authenticated · needs login · nothing enrolled and open on the tailnet.

    The third is the one that gets dropped, and dropping it means showing a
    login form on a box that has no accounts — a door with no key, in front of
    a room that was never locked.
    """
    assert "enforcing" in client_source, "the client ignores the `enforcing` flag"
    assert "authenticated" in client_source


def test_every_endpoint_the_client_calls_exists_on_the_server(
    client_source: str, client: TestClient
) -> None:
    """Catches a typo'd path, which otherwise 404s at runtime on a real device.

    A 404 from `/api/auth/whoami` would leave the client unable to resolve any
    boot state, and the shell would sit on "connecting" forever.
    """
    called = set(re.findall(r'"(/api/auth/[a-z]+)"', client_source))
    assert called, "the client calls no auth endpoints at all"

    # The OpenAPI schema rather than `app.routes`: this FastAPI represents an
    # included router as one opaque `_IncludedRouter` entry whose `path` is
    # None, so the flat route list does not contain /api/auth/* at all. A test
    # built on it would have reported every endpoint missing and been
    # "corrected" by weakening it. The schema is the public, stable view.
    served = set(client.app.openapi()["paths"])  # type: ignore[attr-defined]
    missing = sorted(p for p in called if p not in served)
    assert not missing, (
        f"the client calls paths the server does not serve: {missing}\n"
        f"served auth paths: {sorted(p for p in served if p.startswith('/api/auth'))}"
    )


def test_the_boot_probe_is_public_on_the_server() -> None:
    """`whoami` and `login` must answer rather than 401.

    If `whoami` were guarded it could never report "you are nobody", and the
    only way to learn you need to log in would be to have already logged in.
    """
    assert "/api/auth/whoami" in _PUBLIC_EXACT
    assert "/api/auth/login" in _PUBLIC_EXACT
    # Logout is deliberately NOT public: revoking a session requires holding it.
    assert "/api/auth/logout" not in _PUBLIC_EXACT


# ── the EventSource limitation ───────────────────────────────────────────


async def _open_sse(app: object, cookie_header: str) -> dict[str, object]:
    """Open /api/stream against the real ASGI stack and report the outcome.

    Driving the app directly instead of using `TestClient.stream`, because the
    SSE endpoint is an infinite generator by design and TestClient waits for
    the ASGI call to finish when the response context exits. It therefore
    hangs forever -- through `pytest-timeout`, which cannot interrupt it -- and
    the first attempt at this test wedged the whole suite.

    `receive()` answers `http.disconnect`, which is what a real client does
    when it goes away. `request.is_disconnected()` then returns True on the
    generator's first loop iteration and it returns cleanly, after having
    already emitted its opening `retry:` frame. So the full middleware chain
    runs -- SecurityGuard, then AuthGuard, then the route -- and the auth
    decision is observed without draining a stream that never ends.
    """
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": "/api/stream",
        "raw_path": b"/api/stream",
        "query_string": b"",
        "root_path": "",
        # Exactly what `new EventSource("/api/stream")` sends: a cookie and an
        # Accept header. No X-Trainwatch, no X-CSRF-Token, no Authorization --
        # EventSource has no API for setting any of them.
        "headers": [(b"host", b"testserver"), (b"accept", b"text/event-stream")]
        + ([(b"cookie", cookie_header.encode())] if cookie_header else []),
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }
    result: dict[str, object] = {}
    chunks: list[bytes] = []

    async def receive() -> dict[str, str]:
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            result["status"] = message["status"]
            result["headers"] = {
                k.decode(): v.decode()
                for k, v in message.get("headers", [])  # type: ignore[union-attr]
            }
        elif message["type"] == "http.response.body":
            chunks.append(message.get("body", b""))  # type: ignore[arg-type]

    # A ceiling, so a regression that reintroduces the hang fails the test
    # rather than stalling CI.
    await asyncio.wait_for(app(scope, receive, send), timeout=15)  # type: ignore[operator]
    result["body"] = b"".join(chunks)
    return result


def _cookie_header(c: TestClient) -> str:
    return "; ".join(f"{k}={v}" for k, v in c.cookies.items())


def test_sse_authenticates_on_the_cookie_alone(client: TestClient) -> None:
    """The live dashboard's stream must work with nothing but a cookie.

    `EventSource` cannot set request headers -- not "does not by default", the
    API has no parameter for it. So if the guard ever required a header on
    GETs, the dashboard would stop updating while showing its last snapshot:
    a run that looks healthy and static rather than unmonitored. Silence
    presented as health, which is the failure this project exists to remove.
    """
    _login(client)
    assert CSRF_COOKIE in client.cookies, "expected a CSRF cookie after login"

    result = asyncio.run(_open_sse(client.app, _cookie_header(client)))

    assert result["status"] == 200, (
        f"SSE refused with {result['status']}: {result['body']!r}. "
        "EventSource cannot send headers, so anything beyond a cookie is "
        "unreachable from the browser."
    )
    headers = result["headers"]
    assert isinstance(headers, dict)
    assert headers["content-type"].startswith("text/event-stream")
    # The opening frame proves the route body ran, not merely that the guard
    # allowed it -- a 200 from a handler that never emitted anything would be
    # a stream the client waits on forever.
    assert b"retry:" in result["body"]  # type: ignore[operator]


def test_sse_is_refused_without_a_session(client: TestClient) -> None:
    """The other half: cookie-only must not mean unguarded.

    Without this, "SSE works with just a cookie" would also be satisfied by an
    endpoint that never checks anything at all.
    """
    result = asyncio.run(_open_sse(client.app, ""))
    assert result["status"] == 401


def test_the_state_snapshot_and_the_stream_agree_on_auth(client: TestClient) -> None:
    """`useLiveState` fetches /api/state and opens /api/stream together.

    If the two disagreed, the screen would show real data behind a dead
    connection chip -- or, worse, a live chip over data that never arrived.
    """
    assert client.get("/api/state").status_code == 401
    assert asyncio.run(_open_sse(client.app, ""))["status"] == 401

    _login(client)
    assert client.get("/api/state").status_code == 200
    assert asyncio.run(_open_sse(client.app, _cookie_header(client)))["status"] == 200


def test_the_session_cookie_over_plain_http_is_not_secure_prefixed(
    client: TestClient,
) -> None:
    """The cookie name the client will actually meet on the tailnet.

    `http://100.69.221.23:8730` is not a secure context, so a `Secure` cookie
    is silently discarded there and `__Host-` is unusable. The server picks
    per request; this pins the plain-HTTP branch, because it is the one every
    phone and the iPad hit and the one a `__Host-`-only implementation would
    break with a 200 that sets nothing.
    """
    _login(client)
    assert SESSION_COOKIE in client.cookies
    assert SESSION_COOKIE_HOST not in client.cookies


# ── what the client is told on failure ───────────────────────────────────


def test_a_mid_session_401_is_distinguishable_from_a_csrf_403(client: TestClient) -> None:
    """The client routes these to different places, so they must differ.

    A 401 flips the shell to the login form. A 403 must not, because the
    session is fine and bouncing to login would throw away unsaved work over a
    stale token that a reload fixes.
    """
    _login(client)
    csrf = {CSRF_HEADER: client.cookies[CSRF_COOKIE], **GUARD}

    # PUT, not POST: /api/notes/{id} is an upsert, and POST there is a 405 --
    # which would look like a CSRF/auth problem in a test about CSRF and auth.
    good = client.put("/api/notes/contract", json={"body": "x"}, headers=csrf)
    assert good.status_code in {200, 201}, good.text

    stale = client.put(
        "/api/notes/contract",
        json={"body": "y"},
        headers={CSRF_HEADER: "not-the-token", **GUARD},
    )
    assert stale.status_code == 403
    assert "csrf" in json.dumps(stale.json()).lower(), (
        "the 403 body must say it was CSRF. The client uses this to tell the "
        "user to reload rather than to re-authenticate."
    )

    client.post("/api/auth/logout", headers=csrf)
    assert client.get("/api/state").status_code == 401


def test_the_rate_limit_carries_a_number_the_client_can_count_down(
    client: TestClient,
) -> None:
    """The login form disables itself for `retry_after` seconds.

    Without a number it would have to either guess or stay disabled forever,
    and the honest UI needs to say how long.
    """
    for _ in range(12):
        resp = client.post(
            "/api/auth/login", json={"username": "sai", "password": "wrong"}, headers=GUARD
        )
        if resp.status_code == 429:
            break
    else:  # pragma: no cover - the lockout is configured well below 12
        pytest.fail("never hit the rate limit; the client's cooldown path is dead code")

    body = resp.json()
    assert "retry_after" in body, "the client needs a number to count down from"
    assert isinstance(body["retry_after"], (int, float))
    assert body["retry_after"] > 0
    assert resp.headers["Retry-After"]
