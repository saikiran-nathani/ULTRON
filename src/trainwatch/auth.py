"""Identity, sessions, machine tokens and a tamper-evident audit log.

ADR-0004 controls C7-C11. Tailscale stays the network boundary; this is
defence in depth *inside* it, and its primary job is attribution.

Five of the six actors that write to this database are machines — agent
sessions, the TUF trainer, the liveness cron, an iPad — so the useful question
is not "who is allowed in" (Tailscale answers that) but "what changed my
infrastructure, and when". Hence: one human identity with a revocable session,
service accounts holding scoped tokens, and an append-only hash-chained log
that every write passes through.

Why scrypt and not Argon2id
---------------------------
ADR-0004 specified Argon2id. `argon2-cffi` is not installed, and installing it
collides with a stronger constraint: `tests/test_zero_dependency_core.py`
asserts that the core imports on a bare interpreter, because the training loop
imports `src.train.monitor` and "a monitoring library must never be the reason
a six-hour run fails to start". `cli` is on that list.

`hashlib.scrypt` is stdlib, memory-hard, and listed by OWASP as an acceptable
alternative to Argon2id. At this threat model — single user, tailnet-only, no
public ingress, therefore no credential-stuffing surface — the marginal
security difference against properly parameterised scrypt is negligible, while
the operational difference of a compiled dependency in the training
environment is not.

Trip-wire that brings Argon2id back: public ingress, or more than one human.

The trap, since it fails opaquely
---------------------------------
`hashlib.scrypt` rejects OWASP-grade parameters under its default `maxmem`
(OpenSSL caps at 32 MB) with `[digital envelope routines] memory limit
exceeded`, which names neither scrypt nor the parameter at fault. `maxmem`
must be passed explicitly. Measured cost at the parameters below: ~150 ms.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .store import connect, migrate

__all__ = [
    "ActorKind",
    "Auth",
    "AuthError",
    "Identity",
    "LockedOutError",
    "TokenGrant",
    "hash_password",
    "verify_password",
]

log = logging.getLogger("trainwatch.auth")

ActorKind = Literal["human", "machine", "system"]

# OWASP Password Storage minimum for scrypt: N=2^17, r=8, p=1.
_N, _R, _P = 2**17, 8, 1
_SALT_BYTES = 16
_KEY_BYTES = 32

SESSION_IDLE = 12 * 3600.0
SESSION_ABSOLUTE = 30 * 86400.0

# Rate limiting. Deliberately per (username, ip): keying on ip alone lets one
# noisy device lock out the only account, and keying on username alone lets an
# attacker lock the owner out from anywhere.
LOCKOUT_AFTER = 5
LOCKOUT_WINDOW = 900.0

# How coarsely api_tokens.last_used is maintained. See Auth.token().
LAST_USED_RESOLUTION = 60.0

TOKEN_PREFIX = "twk"  # noqa: S105 - a public identifier prefix, not a secret
_GENESIS = "0" * 64


class AuthError(Exception):
    """Authentication failed. Deliberately says no more than that."""


class LockedOutError(AuthError):
    """Too many recent failures for this (username, ip)."""

    def __init__(self, retry_after: float) -> None:
        super().__init__("too many attempts")
        self.retry_after = retry_after


@dataclass(frozen=True)
class Identity:
    """Who is acting, resolved from a session cookie or a bearer token."""

    kind: ActorKind
    id: str
    name: str
    scopes: frozenset[str]

    def can(self, scope: str) -> bool:
        return "*" in self.scopes or scope in self.scopes


@dataclass(frozen=True)
class TokenGrant:
    """A freshly minted token. `secret` is the only time the plaintext exists."""

    id: str
    name: str
    secret: str
    scopes: frozenset[str]


# ── password hashing ─────────────────────────────────────────────────────


def hash_password(password: str) -> str:
    """Encode as `scrypt$N$r$p$salt$key`, all base64, parameters inline.

    Parameters are stored with the hash rather than read from module constants
    at verify time. Raising the cost later must not invalidate every existing
    password — an old hash has to stay verifiable with the parameters it was
    made with.
    """
    if not password:
        raise ValueError("empty password")
    salt = secrets.token_bytes(_SALT_BYTES)
    key = hashlib.scrypt(
        password.encode(), salt=salt, n=_N, r=_R, p=_P,
        maxmem=_maxmem(_N, _R), dklen=_KEY_BYTES,
    )
    salt_b64 = base64.b64encode(salt).decode()
    key_b64 = base64.b64encode(key).decode()
    return f"scrypt${_N}${_R}${_P}${salt_b64}${key_b64}"


def verify_password(password: str, encoded: str) -> bool:
    """Constant-time verify. False on any malformed hash rather than raising."""
    try:
        scheme, n_s, r_s, p_s, salt_b64, key_b64 = encoded.split("$")
        if scheme != "scrypt":
            return False
        n, r, p = int(n_s), int(r_s), int(p_s)
        salt = base64.b64decode(salt_b64)
        expected = base64.b64decode(key_b64)
    except (ValueError, TypeError):
        return False
    try:
        got = hashlib.scrypt(
            password.encode(), salt=salt, n=n, r=r, p=p,
            maxmem=_maxmem(n, r), dklen=len(expected),
        )
    except ValueError:
        return False
    return hmac.compare_digest(got, expected)


def _maxmem(n: int, r: int) -> int:
    """The `maxmem` scrypt needs for these parameters.

    Derived from `n` and `r` rather than kept as a constant, because the two
    must not be able to disagree. A constant computed from the default `_N`
    goes stale the moment `_N` is raised, and the failure is
    `ValueError: [digital envelope routines] memory limit exceeded`, which
    names neither scrypt nor the parameter at fault.

    128 * N * r is scrypt's working set. OpenSSL's default cap is 32 MB, well
    below the OWASP minimum, so this is never optional.
    """
    return 128 * n * r * 2


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()


class Auth:
    """Users, sessions, tokens and the audit chain, over the shared database."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._db = connect(self.path)
        migrate(self._db)

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Auth:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── activation ───────────────────────────────────────────────────────

    def has_identities(self) -> bool:
        """Whether anything has been enrolled, and enforcement should apply.

        Either a user or a machine token counts. Checking only `users` was a
        bug: a hub reached solely by the TUF's `telemetry:write` token -- which
        is the whole point of phase D -- would have had no user row and served
        every request unauthenticated, including the ingest route. Minting a
        token is an explicit request for authenticated access, so it activates
        enforcement exactly as creating an account does.
        """
        row = self._db.execute(
            """SELECT 1 WHERE EXISTS (SELECT 1 FROM users)
                          OR EXISTS (SELECT 1 FROM api_tokens
                                      WHERE revoked_at IS NULL)"""
        ).fetchone()
        return row is not None

    # ── users ────────────────────────────────────────────────────────────

    def create_user(
        self, username: str, password: str, *, role: str = "owner"
    ) -> int:
        if len(password) < 12:
            # Length is the only password rule here. Composition rules push
            # people toward Password1! and buy nothing against an offline
            # attack, which is the only attack this hash defends against.
            raise ValueError("password must be at least 12 characters")
        now = time.time()
        cur = self._db.execute(
            """INSERT INTO users (username, pw_hash, role, created_at, pw_changed_at)
                   VALUES (?, ?, ?, ?, ?)""",
            (username, hash_password(password), role, now, now),
        )
        self._db.commit()
        user_id = int(cur.lastrowid or 0)
        self.record("system", "auth", "user.create", target=username)
        return user_id

    def set_password(self, username: str, password: str) -> None:
        """Change a password and revoke every session it protected.

        Not revoking is the classic bug: the reason to change a password is
        usually that someone else may have had it, and a live session is a
        credential that outlives the one you just replaced.
        """
        if len(password) < 12:
            raise ValueError("password must be at least 12 characters")
        row = self._db.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        if row is None:
            raise KeyError(f"no such user: {username}")
        now = time.time()
        self._db.execute(
            "UPDATE users SET pw_hash = ?, pw_changed_at = ? WHERE id = ?",
            (hash_password(password), now, row["id"]),
        )
        self._db.execute(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            (now, row["id"]),
        )
        self._db.commit()
        self.record("system", "auth", "user.password", target=username)

    def disable_user(self, username: str) -> None:
        now = time.time()
        row = self._db.execute(
            "SELECT id FROM users WHERE username = ?", (username,)
        ).fetchone()
        if row is None:
            raise KeyError(f"no such user: {username}")
        self._db.execute("UPDATE users SET disabled_at = ? WHERE id = ?", (now, row["id"]))
        self._db.execute(
            "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
            (now, row["id"]),
        )
        self._db.commit()
        self.record("system", "auth", "user.disable", target=username)

    # ── login ────────────────────────────────────────────────────────────

    def _recent_failures(self, username: str, ip: str, now: float) -> int:
        row = self._db.execute(
            """SELECT COUNT(*) AS n FROM login_attempts
                WHERE username = ? AND ip = ? AND ok = 0 AND ts > ?""",
            (username, ip, now - LOCKOUT_WINDOW),
        ).fetchone()
        return int(row["n"])

    def login(self, username: str, password: str, *, ip: str = "", ua: str = "") -> str:
        """Verify credentials and open a session. Returns the cookie value.

        The returned string is the only time the session secret exists in
        plaintext; the table stores its SHA-256. Raises `AuthError` with the
        same message for an unknown user, a wrong password and a disabled
        account — anything more specific is a user-enumeration oracle.
        """
        now = time.time()
        if self._recent_failures(username, ip, now) >= LOCKOUT_AFTER:
            raise LockedOutError(retry_after=LOCKOUT_WINDOW)

        row = self._db.execute(
            "SELECT id, pw_hash, disabled_at FROM users WHERE username = ?", (username,)
        ).fetchone()

        # Hash even when the user does not exist, so a missing account is not
        # detectable by responding in 0.1 ms instead of 150 ms.
        stored = row["pw_hash"] if row else hash_password(secrets.token_urlsafe(16))
        ok = verify_password(password, stored) and row is not None
        if row is not None and row["disabled_at"] is not None:
            ok = False

        self._db.execute(
            "INSERT INTO login_attempts (username, ip, ts, ok) VALUES (?, ?, ?, ?)",
            (username, ip, now, 1 if ok else 0),
        )
        self._db.commit()

        if not ok:
            self.record("system", "auth", "login.fail", target=username, detail={"ip": ip})
            raise AuthError("invalid credentials")

        secret = secrets.token_urlsafe(32)
        self._db.execute(
            """INSERT INTO sessions (id, user_id, created_at, last_seen, expires_at, ip, ua)
                   VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (_sha256(secret), row["id"], now, now, now + SESSION_ABSOLUTE, ip, ua),
        )
        self._db.commit()
        self.record("human", username, "login.ok", detail={"ip": ip})
        return secret

    def session(self, cookie: str) -> Identity:
        """Resolve a cookie to an identity, or raise.

        Server-side, so `logout()` genuinely ends it. A JWT would need a
        denylist to do the same, which is this table with extra steps.
        """
        now = time.time()
        row = self._db.execute(
            """SELECT s.id, s.user_id, s.last_seen, s.expires_at, s.revoked_at,
                      u.username, u.role, u.disabled_at
                 FROM sessions s JOIN users u ON u.id = s.user_id
                WHERE s.id = ?""",
            (_sha256(cookie),),
        ).fetchone()
        if row is None:
            raise AuthError("no such session")
        if row["revoked_at"] is not None:
            raise AuthError("session revoked")
        if row["disabled_at"] is not None:
            raise AuthError("account disabled")
        if now > row["expires_at"]:
            raise AuthError("session expired")
        if now - row["last_seen"] > SESSION_IDLE:
            raise AuthError("session idle too long")

        self._db.execute("UPDATE sessions SET last_seen = ? WHERE id = ?", (now, row["id"]))
        self._db.commit()
        scopes = frozenset({"*"} if row["role"] == "owner" else {"read"})
        return Identity(kind="human", id=str(row["user_id"]), name=row["username"], scopes=scopes)

    def logout(self, cookie: str) -> None:
        self._db.execute(
            "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
            (time.time(), _sha256(cookie)),
        )
        self._db.commit()

    def prune_sessions(self, *, now: float | None = None) -> int:
        now = now if now is not None else time.time()
        cur = self._db.execute(
            "DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?",
            (now, now - SESSION_ABSOLUTE),
        )
        self._db.commit()
        return cur.rowcount

    # ── machine tokens ───────────────────────────────────────────────────

    def create_token(
        self, name: str, scopes: set[str] | frozenset[str], *, ttl: float | None = None
    ) -> TokenGrant:
        """Mint a scoped token. The plaintext is returned once and never stored.

        Format `twk_<id>_<secret>`: the id is a public lookup key, so
        verification is a primary-key hit rather than a scan that hashes every
        stored token in turn.
        """
        token_id = secrets.token_hex(8)
        secret = secrets.token_urlsafe(32)
        now = time.time()
        self._db.execute(
            """INSERT INTO api_tokens (id, name, secret_hash, scopes, created_at, expires_at)
                   VALUES (?, ?, ?, ?, ?, ?)""",
            (token_id, name, _sha256(secret), ",".join(sorted(scopes)), now,
             now + ttl if ttl else None),
        )
        self._db.commit()
        self.record("system", "auth", "token.create", target=name,
                    detail={"scopes": sorted(scopes)})
        return TokenGrant(
            id=token_id,
            name=name,
            secret=f"{TOKEN_PREFIX}_{token_id}_{secret}",
            scopes=frozenset(scopes),
        )

    def token(self, presented: str) -> Identity:
        now = time.time()
        try:
            prefix, token_id, secret = presented.split("_", 2)
        except ValueError as exc:
            raise AuthError("malformed token") from exc
        if prefix != TOKEN_PREFIX:
            raise AuthError("malformed token")

        row = self._db.execute(
            """SELECT name, secret_hash, scopes, expires_at, revoked_at, last_used
                 FROM api_tokens WHERE id = ?""",
            (token_id,),
        ).fetchone()
        if row is None:
            raise AuthError("unknown token")
        if not hmac.compare_digest(_sha256(secret), row["secret_hash"]):
            raise AuthError("unknown token")
        if row["revoked_at"] is not None:
            raise AuthError("token revoked")
        if row["expires_at"] is not None and now > row["expires_at"]:
            raise AuthError("token expired")

        # Throttled, and never fatal. Updating last_used on every request put a
        # write -- and therefore a write lock -- on the path of every read: a
        # dashboard poll and a telemetry batch would contend for it, and under
        # a burst of batches the hub raised "database is locked" while
        # authenticating a request it could otherwise have served.
        #
        # LAST_USED_RESOLUTION is all the precision this needs: the question it
        # answers is "is this token still in use", not "when exactly".
        stale = (row["last_used"] or 0.0) < now - LAST_USED_RESOLUTION
        if stale:
            try:
                self._db.execute(
                    "UPDATE api_tokens SET last_used = ? WHERE id = ?", (now, token_id)
                )
                self._db.commit()
            except sqlite3.OperationalError:
                # Bookkeeping must not turn a valid credential into a failure.
                log.debug("could not update last_used for token %s", token_id)
        return Identity(
            kind="machine",
            id=token_id,
            name=row["name"],
            scopes=frozenset(s for s in row["scopes"].split(",") if s),
        )

    def revoke_token(self, name: str) -> None:
        cur = self._db.execute(
            "UPDATE api_tokens SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
            (time.time(), name),
        )
        if cur.rowcount == 0:
            raise KeyError(f"no live token named {name!r}")
        self._db.commit()
        self.record("system", "auth", "token.revoke", target=name)

    def tokens(self) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._db.execute(
                """SELECT id, name, scopes, created_at, last_used, expires_at, revoked_at
                     FROM api_tokens ORDER BY created_at DESC"""
            ).fetchall()
        ]

    # ── audit chain ──────────────────────────────────────────────────────

    @staticmethod
    def _link(prev_hash: str, payload: dict[str, Any]) -> str:
        """Hash a row against its predecessor.

        `sort_keys` and a fixed separator matter: the chain is only checkable
        if the bytes hashed are reproducible from the stored row, so the JSON
        encoding has to be canonical rather than merely valid.
        """
        blob = json.dumps(payload, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(f"{prev_hash}{blob}".encode()).hexdigest()

    def record(
        self,
        actor_kind: ActorKind,
        actor_id: str,
        action: str,
        *,
        target: str = "",
        detail: dict[str, Any] | None = None,
        request_id: str = "",
        ts: float | None = None,
    ) -> str:
        """Append to the audit log, chaining onto the previous row's hash.

        Returns the new row's hash. Never raises on a normal path — an audit
        write that fails the operation it was recording would make logging the
        thing more dangerous than not logging it.
        """
        now = ts if ts is not None else time.time()
        detail_json = json.dumps(detail or {}, sort_keys=True, separators=(",", ":"))
        prev = self._db.execute(
            "SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1"
        ).fetchone()
        prev_hash = prev["hash"] if prev else _GENESIS
        payload = {
            "ts": now,
            "actor_kind": actor_kind,
            "actor_id": actor_id,
            "action": action,
            "target": target,
            "detail": detail_json,
            "request_id": request_id,
        }
        digest = self._link(prev_hash, payload)
        self._db.execute(
            """INSERT INTO audit_log
                   (ts, actor_kind, actor_id, action, target, detail,
                    request_id, prev_hash, hash)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (now, actor_kind, actor_id, action, target, detail_json,
             request_id, prev_hash, digest),
        )
        self._db.commit()
        return digest

    def verify_chain(self) -> tuple[bool, str]:
        """Recompute every link. Returns (ok, explanation).

        Catches deletion, reordering and in-place edits: each row commits to
        its predecessor, so altering row N invalidates every row after it.

        What it cannot catch is a rewrite of the *whole* tail by someone with
        write access, since they can recompute the chain. Making that
        impossible needs an append-only store or an off-box witness; what this
        buys is that casual tampering — a stray UPDATE, a deleted row, an edit
        to hide one action — cannot pass unnoticed.
        """
        prev_hash = _GENESIS
        rows = self._db.execute(
            """SELECT seq, ts, actor_kind, actor_id, action, target, detail,
                      request_id, prev_hash, hash
                 FROM audit_log ORDER BY seq"""
        ).fetchall()
        for row in rows:
            if row["prev_hash"] != prev_hash:
                return False, f"seq {row['seq']}: prev_hash does not match the chain"
            payload = {
                "ts": row["ts"],
                "actor_kind": row["actor_kind"],
                "actor_id": row["actor_id"],
                "action": row["action"],
                "target": row["target"],
                "detail": row["detail"],
                "request_id": row["request_id"],
            }
            if self._link(prev_hash, payload) != row["hash"]:
                return False, f"seq {row['seq']}: row contents do not match its hash"
            prev_hash = row["hash"]
        return True, f"{len(rows)} entries verified"

    def audit(self, *, limit: int = 100) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._db.execute(
                """SELECT seq, ts, actor_kind, actor_id, action, target, detail, request_id
                     FROM audit_log ORDER BY seq DESC LIMIT ?""",
                (limit,),
            ).fetchall()
        ]
