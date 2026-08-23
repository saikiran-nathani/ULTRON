"""Browser-facing guards for a writable, unauthenticated, private-IP service.

Implements the controls from ADR-0003. The threat is not other machines on the
tailnet — it is any web page open in Safari, which can reach
`http://100.x.y.z:8730` exactly as easily as the dashboard can.

  C1  Host allowlist        → defeats DNS rebinding (the cross-origin *read*)
  C2  Origin check          → defeats CSRF (the cross-origin *write*)
  C3  Required X-Trainwatch  → forces a preflight we never answer
  C4  No CORS headers, ever → browser withholds bodies from other origins
  C5  nosniff + CSP + no framing
  C6  Optional bearer token

Written as **pure ASGI middleware, not BaseHTTPMiddleware**, deliberately:
BaseHTTPMiddleware wraps the response in a way that buffers streaming bodies,
which would break the SSE endpoint the dashboard lives on.
"""

from __future__ import annotations

import json
import logging
import shutil
import subprocess
from collections.abc import Awaitable, Callable, MutableMapping
from typing import Any

__all__ = ["GUARD_HEADER", "MUTATING_METHODS", "SecurityGuard", "resolve_allowed_hosts"]

log = logging.getLogger("trainwatch.security")

Scope = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[MutableMapping[str, Any]]]
Send = Callable[[MutableMapping[str, Any]], Awaitable[None]]

MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})
GUARD_HEADER = "x-trainwatch"

# Always trusted: a secure context by definition, and not reachable off-box.
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"})  # noqa: S104

# framer-motion writes inline styles, so style-src needs unsafe-inline; scripts
# do not, and that is where it matters. No remote origins at all: fonts are
# self-hosted precisely so this can stay tight.
CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob:; "
    "font-src 'self'; "
    "connect-src 'self'; "
    "media-src 'self' blob:; "
    "object-src 'none'; "
    "base-uri 'none'; "
    "form-action 'none'; "
    "frame-ancestors 'none'"
)

SECURITY_HEADERS: tuple[tuple[bytes, bytes], ...] = (
    (b"x-content-type-options", b"nosniff"),
    (b"x-frame-options", b"DENY"),
    (b"referrer-policy", b"no-referrer"),
    (b"cross-origin-opener-policy", b"same-origin"),
    (b"cross-origin-resource-policy", b"same-origin"),
    (b"permissions-policy", b"geolocation=(), microphone=(), camera=()"),
    (b"content-security-policy", CSP.encode()),
)


def _run(args: list[str], timeout: float = 3.0) -> str:
    try:
        p = subprocess.run(  # noqa: S603 - fixed argv, no shell
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def resolve_allowed_hosts(extra: str = "") -> set[str]:
    """Build the Host allowlist: localhost + this machine's tailnet identity.

    Auto-detected rather than configured, because a hand-maintained allowlist
    is one that is wrong the first time an address changes — and the failure
    mode of a wrong allowlist is "the dashboard mysteriously 421s".
    """
    hosts: set[str] = set(_LOCAL_HOSTS)

    if shutil.which("tailscale"):
        for ip in _run(["tailscale", "ip"]).splitlines():
            ip = ip.strip()
            if ip:
                # IPv6 literals appear bracketed in a Host header.
                hosts.add(ip)
                if ":" in ip:
                    hosts.add(f"[{ip}]")
        raw = _run(["tailscale", "status", "--json"])
        if raw:
            try:
                data = json.loads(raw)
                dns = str(data.get("Self", {}).get("DNSName", "")).rstrip(".")
                if dns:
                    hosts.add(dns.lower())
                    hosts.add(dns.split(".")[0].lower())  # bare MagicDNS short name
            except (json.JSONDecodeError, AttributeError):
                log.debug("could not parse tailscale status", exc_info=True)

    for h in extra.replace(",", " ").split():
        if h.strip():
            hosts.add(h.strip().lower())

    log.info("host allowlist: %s", ", ".join(sorted(hosts)))
    return hosts


class SecurityGuard:
    """ASGI middleware enforcing ADR-0003's controls."""

    def __init__(
        self,
        app: Any,
        *,
        allowed_hosts: set[str],
        token: str = "",
        require_guard_header: bool = True,
    ) -> None:
        self.app = app
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.token = token.strip()
        self.require_guard_header = require_guard_header
        self.rejected = 0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        method = scope.get("method", "GET").upper()
        path = scope.get("path", "/")

        # ── C1: Host allowlist. The only control that stops DNS rebinding. ──
        # An absent or unparseable Host is rejected rather than waved through.
        # A browser always sends one, so rebinding was already covered, but
        # `if host and ...` meant any non-browser client could skip C1 entirely
        # by omitting the header — and `_host_only` returns "" for a malformed
        # authority such as an unbracketed IPv6 literal.
        host = _host_only(headers.get("host", ""))
        if not host or host not in self.allowed_hosts:
            self.rejected += 1
            log.warning("rejected Host=%r for %s %s", host, method, path)
            await _deny(
                send,
                421,
                "unrecognised Host header",
                {
                    "got": host,
                    "allowed": sorted(self.allowed_hosts),
                    "why": (
                        "This blocks DNS-rebinding attacks (ADR-0003 C1). If you are "
                        "reaching the dashboard by a legitimate new name, add it to "
                        "TRAINWATCH_ALLOWED_HOSTS."
                    ),
                },
            )
            return

        origin = headers.get("origin", "")
        is_api = path.startswith("/api/") or path == "/healthz"
        mutating = method in MUTATING_METHODS

        # ── C2: Origin must be same-origin when present. ──
        # Browsers attach Origin to all cross-origin requests and to every
        # non-GET; JS cannot forge it. Absent Origin means a non-browser client
        # (curl, the CLI), which is not subject to CSRF.
        if origin and _host_only(_origin_host(origin)) not in self.allowed_hosts:
            self.rejected += 1
            log.warning("rejected Origin=%r for %s %s", origin, method, path)
            await _deny(send, 403, "cross-origin request refused", {"origin": origin})
            return

        if mutating and is_api:
            # ── C3: custom header forces a preflight we never answer. ──
            if self.require_guard_header and GUARD_HEADER not in headers:
                self.rejected += 1
                await _deny(
                    send,
                    403,
                    f"missing {GUARD_HEADER} header",
                    {"why": "Required on writes so browsers must preflight (ADR-0003 C3)."},
                )
                return

            # ── C6: optional shared token. ──
            if self.token:
                sent = headers.get("authorization", "")
                if not _token_matches(sent, self.token):
                    self.rejected += 1
                    await _deny(send, 401, "bad or missing bearer token")
                    return

        # Preflights are refused rather than answered: never emitting
        # Access-Control-Allow-* is what keeps other origins out (C4).
        if method == "OPTIONS" and origin:
            await _deny(send, 403, "CORS is not enabled on this service")
            return

        async def send_wrapper(message: MutableMapping[str, Any]) -> None:
            if message["type"] == "http.response.start":
                existing = {k.lower() for k, _ in message.get("headers", [])}
                message["headers"] = list(message.get("headers", [])) + [
                    (k, v) for k, v in SECURITY_HEADERS if k not in existing
                ]
            await send(message)

        await self.app(scope, receive, send_wrapper)


def _host_only(value: str) -> str:
    """Strip the port from a Host/authority, keeping IPv6 brackets intact."""
    v = value.strip().lower()
    if not v:
        return ""
    if v.startswith("["):  # [::1]:8730
        end = v.find("]")
        return v[: end + 1] if end != -1 else v
    return v.split(":", 1)[0]


def _origin_host(origin: str) -> str:
    """`https://host:port` → `host:port`; opaque origins → '' (rejected upstream)."""
    o = origin.strip()
    if o == "null":
        return "null"
    return o.split("://", 1)[1] if "://" in o else o


def _token_matches(authorization: str, expected: str) -> bool:
    import hmac

    scheme, _, value = authorization.partition(" ")
    if scheme.lower() != "bearer":
        return False
    return hmac.compare_digest(value.strip(), expected)


async def _deny(send: Send, status: int, detail: str, extra: dict[str, Any] | None = None) -> None:
    body = json.dumps({"error": detail, **(extra or {})}).encode()
    await send(
        {
            "type": "http.response.start",
            "status": status,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode()),
                *SECURITY_HEADERS,
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})
