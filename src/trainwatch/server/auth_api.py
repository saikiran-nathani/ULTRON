"""HTTP enforcement for ADR-0004 controls C7, C8, C10 and C12.

Layered *under* `SecurityGuard`, not merged into it. ADR-0003's controls answer
"is this request allowed to reach the app at all" — Host allowlist, Origin,
preflight refusal — and they must run first, before anything touches the
database. This module answers the later question: "on whose authority".

Two behaviours worth knowing before reading the code.

Enforcement is self-activating
------------------------------
With no rows in `users`, every request is allowed through and the posture is
exactly ADR-0003's: open on the tailnet, Host- and Origin-bound. Create an
account and enforcement switches on for that and every later request.

The alternative — a config flag defaulting to on — would have broken a
dashboard that works today, on a machine whose owner had no account yet, with
`trainwatch user add` needing a TTY to reach. A migration that can lock you
out of the thing you use to notice problems is the wrong migration.
`TRAINWATCH_REQUIRE_AUTH=1` forces it on for anyone who wants the flag.

The `Secure` cookie trap
------------------------
`__Host-` is the strongest cookie prefix available: it pins a cookie to one
exact origin, and browsers reject it unless the cookie is `Secure`, `Path=/`
and carries no `Domain`. It is the right default over Tailscale Serve, which
is HTTPS.

But `http://100.69.221.23:8730` — how the iPad and the CLI reach this box — is
**not** a secure context, and a browser silently discards a `Secure` cookie
sent over it. Login would return 200, set nothing, and every later request
would look unauthenticated with no error anywhere. So the prefix and the flag
are chosen per request: `__Host-` + `Secure` on HTTPS or localhost, plain
`tw_session` otherwise.

Dropping `Secure` on a plain-HTTP tailnet request is not the compromise it
looks like: Tailscale is WireGuard, so the transport is already encrypted and
the header never crosses an untrusted link. It is recorded here rather than
left to be discovered.
"""

from __future__ import annotations

import json
import logging
import secrets
from collections.abc import Callable, MutableMapping
from http.cookies import CookieError, SimpleCookie
from typing import Any

from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse

from ..auth import Auth, AuthError, Identity, LockedOutError

__all__ = [
    "CSRF_COOKIE",
    "CSRF_HEADER",
    "SESSION_COOKIE",
    "SESSION_COOKIE_HOST",
    "AuthGuard",
    "build_auth_router",
]

log = logging.getLogger("trainwatch.server.auth")

SESSION_COOKIE = "tw_session"
SESSION_COOKIE_HOST = "__Host-tw_session"
CSRF_COOKIE = "tw_csrf"
CSRF_HEADER = "x-csrf-token"

# Paths reachable without an identity. The SPA shell is public so a browser can
# render a login form; every /api/ route below is not.
_PUBLIC_EXACT = frozenset({"/api/auth/login", "/api/auth/whoami", "/healthz"})

_WRITE_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})

# Scope names. A machine token holding only telemetry:write can post metrics
# and nothing else -- notably it cannot rewrite curriculum history.
SCOPE_READ = "read"
SCOPE_TELEMETRY = "telemetry:write"
SCOPE_PROGRESS = "progress:write"


def secure_context(scope: MutableMapping[str, Any], host: str) -> bool:
    """Whether a `Secure` cookie will actually be kept by the browser.

    True for HTTPS, and for localhost — which browsers treat as a secure
    context by fiat even over plain HTTP, so `__Host-` works there and is
    worth keeping in local development.
    """
    if scope.get("scheme") == "https":
        return True
    bare = host.split(":", 1)[0].strip("[]").lower()
    return bare in {"localhost", "127.0.0.1", "::1"}


def cookie_name(secure: bool) -> str:
    return SESSION_COOKIE_HOST if secure else SESSION_COOKIE


def _cookies(raw: str) -> dict[str, str]:
    """Parse a Cookie header, treating a malformed one as absent.

    A client that sends junk should get 401, not 500 -- an unhandled parse
    error here would turn a bad cookie into a server fault.
    """
    jar = SimpleCookie()
    try:
        jar.load(raw)
    except CookieError:
        return {}
    return {k: v.value for k, v in jar.items()}


def _deny(status: int, message: str, **extra: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": message, **extra})


class AuthGuard:
    """ASGI middleware resolving an identity, or refusing the request."""

    def __init__(
        self,
        app: Any,
        *,
        auth_factory: Callable[[], Auth],
        require: bool = False,
    ) -> None:
        self.app = app
        self._auth = auth_factory
        self.require = require
        self.refused = 0

    def _identity(self, headers: dict[str, str]) -> Identity | None:
        auth = self._auth()

        bearer = headers.get("authorization", "")
        if bearer.lower().startswith("bearer "):
            presented = bearer.split(" ", 1)[1].strip()
            # ADR-0003 C6's shared token is not a twk_ token. Leave anything
            # that is not ours alone, so the two schemes can coexist while C6
            # is still configured on someone's box.
            if presented.startswith("twk_"):
                try:
                    return auth.token(presented)
                except AuthError:
                    return None

        jar = _cookies(headers.get("cookie", ""))
        # Read both names regardless of this request's scheme: a session opened
        # over HTTPS and then used over http:// on the tailnet still presents
        # the __Host- cookie, and refusing it would log the iPad out whenever
        # it changed how it reached the box.
        cookie = jar.get(SESSION_COOKIE_HOST) or jar.get(SESSION_COOKIE)
        if cookie:
            try:
                return auth.session(cookie)
            except AuthError:
                return None
        return None

    def _enforcing(self) -> bool:
        return True if self.require else self._auth().has_identities()

    async def __call__(self, scope: Any, receive: Any, send: Any) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {
            k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]
        }
        method = scope.get("method", "GET").upper()
        path = scope.get("path", "/")
        # secure_context() matters when *setting* a cookie, which is the
        # router's job; the guard only reads them, and reads both names.
        identity = self._identity(headers)
        # Handed to the route layer either way, so /whoami can answer honestly
        # and a route can check a scope without re-parsing headers.
        scope["state"] = {**(scope.get("state") or {}), "identity": identity}

        if not path.startswith("/api/") or path in _PUBLIC_EXACT or not self._enforcing():
            await self.app(scope, receive, send)
            return

        if identity is None:
            self.refused += 1
            await _deny(401, "authentication required", why="No valid session or token.")(
                scope, receive, send
            )
            return

        if method in _WRITE_METHODS:
            # ── C12: double-submit CSRF, on top of C2/C3. ──
            # Only for cookie-borne identities: a machine token is not sent
            # automatically by a browser, so it is not a CSRF vector, and
            # requiring the header would break every non-browser client.
            if identity.kind == "human":
                jar = _cookies(headers.get("cookie", ""))
                sent = headers.get(CSRF_HEADER, "")
                expected = jar.get(CSRF_COOKIE, "")
                if not sent or not expected or not secrets.compare_digest(sent, expected):
                    self.refused += 1
                    await _deny(
                        403,
                        "CSRF token missing or mismatched",
                        why=f"Send the {CSRF_COOKIE} cookie value in {CSRF_HEADER}.",
                    )(scope, receive, send)
                    return

            needed = SCOPE_TELEMETRY if path.startswith("/api/telemetry") else SCOPE_PROGRESS
            if not identity.can(needed):
                self.refused += 1
                await _deny(
                    403, "insufficient scope", need=needed, have=sorted(identity.scopes)
                )(scope, receive, send)
                return

        elif not identity.can(SCOPE_READ):
            self.refused += 1
            await _deny(403, "insufficient scope", need=SCOPE_READ)(scope, receive, send)
            return

        await self.app(scope, receive, send)


def build_auth_router(auth_factory: Callable[[], Auth]) -> APIRouter:
    """Login, logout and whoami."""
    router = APIRouter(prefix="/api/auth", tags=["auth"])

    def _set_cookies(response: Response, request: Request, cookie: str) -> None:
        secure = secure_context(request.scope, request.headers.get("host", ""))
        response.set_cookie(
            cookie_name(secure),
            cookie,
            httponly=True,          # C7: unreadable from JS, so XSS cannot lift it
            secure=secure,          # see the module docstring on why this varies
            samesite="lax",         # strict would break following a link from an ntfy alert
            path="/",               # required by the __Host- prefix
            max_age=(30 * 86400),
        )
        # Readable by JS on purpose: the SPA has to echo it back in a header,
        # which is what makes it a CSRF defence rather than another cookie.
        response.set_cookie(
            CSRF_COOKIE,
            secrets.token_urlsafe(24),
            httponly=False,
            secure=secure,
            samesite="lax",
            path="/",
            max_age=(30 * 86400),
        )

    @router.post("/login")
    async def login(request: Request) -> Response:
        try:
            body = json.loads(await request.body() or b"{}")
        except json.JSONDecodeError:
            return _deny(400, "expected a JSON body")
        username = str(body.get("username", ""))
        password = str(body.get("password", ""))
        if not username or not password:
            return _deny(400, "username and password are required")

        client = request.client.host if request.client else ""
        try:
            cookie = auth_factory().login(
                username, password, ip=client, ua=request.headers.get("user-agent", "")
            )
        except LockedOutError as exc:
            return JSONResponse(
                status_code=429,
                content={"error": "too many attempts", "retry_after": exc.retry_after},
                headers={"Retry-After": str(int(exc.retry_after))},
            )
        except AuthError:
            # One message for unknown user, wrong password and disabled
            # account. Anything more specific is a user-enumeration oracle.
            return _deny(401, "invalid credentials")

        response = JSONResponse(content={"ok": True, "username": username})
        _set_cookies(response, request, cookie)
        return response

    @router.post("/logout")
    async def logout(request: Request) -> Response:
        jar = _cookies(request.headers.get("cookie", ""))
        cookie = jar.get(SESSION_COOKIE_HOST) or jar.get(SESSION_COOKIE)
        if cookie:
            auth_factory().logout(cookie)
        response = JSONResponse(content={"ok": True})
        # Delete both names: which one was set depends on how the session was
        # opened, and clearing only one leaves a live cookie behind.
        for name in (SESSION_COOKIE_HOST, SESSION_COOKIE, CSRF_COOKIE):
            response.delete_cookie(name, path="/")
        return response

    @router.get("/whoami")
    async def whoami(request: Request) -> Response:
        identity = (request.scope.get("state") or {}).get("identity")
        enforcing = auth_factory().has_identities()
        if identity is None:
            return JSONResponse(
                content={
                    "authenticated": False,
                    # So the SPA can tell "log in" apart from "this instance
                    # has nothing enrolled and is open on the tailnet".
                    "enforcing": enforcing,
                }
            )
        return JSONResponse(
            content={
                "authenticated": True,
                "kind": identity.kind,
                "name": identity.name,
                "scopes": sorted(identity.scopes),
                "enforcing": True,
            }
        )

    return router
