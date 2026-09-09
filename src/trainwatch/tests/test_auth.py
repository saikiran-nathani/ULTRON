"""Identity, sessions, tokens and the audit chain — ADR-0004 phase B.

The Phase B gate is `test_gate_auth_holds_under_the_four_attacks`.

Most tests run with scrypt turned down via the `cheap_kdf` fixture: at shipped
parameters every login costs ~150 ms, and a suite that takes a minute is a
suite that stops being run. `test_shipped_kdf_parameters_meet_owasp` asserts
the real values, so the cost cannot be quietly lowered in production.
"""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.trainwatch import auth as auth_mod
from src.trainwatch.auth import (
    Auth,
    AuthError,
    LockedOutError,
    hash_password,
    verify_password,
)

PW = "correct horse battery staple"


@pytest.fixture
def cheap_kdf(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Turn scrypt down to keep the suite fast. Never used in production."""
    monkeypatch.setattr(auth_mod, "_N", 2**8)
    yield


@pytest.fixture
def a(tmp_path: Path, cheap_kdf: None) -> Iterator[Auth]:
    with Auth(tmp_path / "t.db") as auth:
        auth.create_user("sai", PW, role="owner")
        yield auth


# ── password hashing ─────────────────────────────────────────────────────


def test_shipped_kdf_parameters_meet_owasp() -> None:
    """OWASP minimum for scrypt is N=2^17, r=8, p=1. Do not lower these."""
    assert auth_mod._N >= 2**17
    assert auth_mod._R >= 8
    assert auth_mod._P >= 1
    # 128*N*r exceeds OpenSSL's 32 MB default cap, so maxmem must cover it or
    # every hash raises. See the module docstring.
    assert auth_mod._maxmem(auth_mod._N, auth_mod._R) >= 128 * auth_mod._N * auth_mod._R


def test_hash_is_salted(cheap_kdf: None) -> None:
    assert hash_password(PW) != hash_password(PW), "two hashes of one password must differ"


def test_verify_round_trips(cheap_kdf: None) -> None:
    encoded = hash_password(PW)
    assert verify_password(PW, encoded)
    assert not verify_password(PW + "x", encoded)


def test_verify_rejects_junk_without_raising(cheap_kdf: None) -> None:
    for junk in ("", "nonsense", "scrypt$bad", "bcrypt$1$2$3$4$5", "scrypt$a$b$c$d$e"):
        assert verify_password(PW, junk) is False


def test_parameters_travel_with_the_hash(
    cheap_kdf: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An old hash must stay verifiable after the cost is raised."""
    old = hash_password(PW)
    assert old.startswith("scrypt$256$")
    # simulate a later, more expensive default. maxmem has to follow N on its
    # own -- if it does not, this raises instead of asserting.
    monkeypatch.setattr(auth_mod, "_N", 2**9)
    assert verify_password(PW, old), "raising the cost must not lock anyone out"
    assert hash_password(PW).startswith("scrypt$512$")


def test_short_passwords_are_refused(a: Auth) -> None:
    with pytest.raises(ValueError, match="12 characters"):
        a.create_user("bob", "short")
    with pytest.raises(ValueError, match="12 characters"):
        a.set_password("sai", "short")


# ── sessions ─────────────────────────────────────────────────────────────


def test_login_then_resolve(a: Auth) -> None:
    cookie = a.login("sai", PW, ip="100.1.1.1")
    who = a.session(cookie)
    assert who.kind == "human"
    assert who.name == "sai"
    assert who.can("anything"), "owner holds the wildcard scope"


def test_the_cookie_is_not_stored(a: Auth) -> None:
    """A database leak must not yield a replayable session."""
    cookie = a.login("sai", PW)
    stored = [r[0] for r in a._db.execute("SELECT id FROM sessions")]
    assert cookie not in stored
    assert len(stored) == 1 and len(stored[0]) == 64, "sha256 hex"


def test_logout_actually_revokes(a: Auth) -> None:
    """The reason sessions are server-side rather than a JWT."""
    cookie = a.login("sai", PW)
    a.logout(cookie)
    with pytest.raises(AuthError, match="revoked"):
        a.session(cookie)


def test_unknown_session_is_refused(a: Auth) -> None:
    with pytest.raises(AuthError):
        a.session("not-a-real-cookie")


def test_absolute_expiry_is_enforced(a: Auth, monkeypatch: pytest.MonkeyPatch) -> None:
    cookie = a.login("sai", PW)
    a._db.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
    a._db.commit()
    with pytest.raises(AuthError, match="expired"):
        a.session(cookie)


def test_idle_timeout_is_enforced(a: Auth) -> None:
    cookie = a.login("sai", PW)
    a._db.execute("UPDATE sessions SET last_seen = ?", (time.time() - auth_mod.SESSION_IDLE - 1,))
    a._db.commit()
    with pytest.raises(AuthError, match="idle"):
        a.session(cookie)


def test_changing_a_password_kills_live_sessions(a: Auth) -> None:
    """Changing a password usually means someone else may have had it."""
    cookie = a.login("sai", PW)
    a.set_password("sai", "a completely different passphrase")
    with pytest.raises(AuthError, match="revoked"):
        a.session(cookie)


def test_disabling_an_account_kills_live_sessions(a: Auth) -> None:
    cookie = a.login("sai", PW)
    a.disable_user("sai")
    with pytest.raises(AuthError):
        a.session(cookie)
    with pytest.raises(AuthError):
        a.login("sai", PW)


def test_prune_removes_expired_sessions(a: Auth) -> None:
    a.login("sai", PW)
    a._db.execute("UPDATE sessions SET expires_at = ?", (time.time() - 1,))
    a._db.commit()
    assert a.prune_sessions() == 1


# ── machine tokens ───────────────────────────────────────────────────────


def test_token_round_trips_with_scopes(a: Auth) -> None:
    grant = a.create_token("tuf-trainer", {"telemetry:write"})
    who = a.token(grant.secret)
    assert who.kind == "machine"
    assert who.name == "tuf-trainer"
    assert who.can("telemetry:write")
    assert not who.can("progress:write"), "a machine token is not a wildcard"


def test_the_token_secret_is_not_stored(a: Auth) -> None:
    grant = a.create_token("tuf-trainer", {"read"})
    stored = [r[0] for r in a._db.execute("SELECT secret_hash FROM api_tokens")]
    assert grant.secret not in stored
    assert not any(grant.secret.rsplit("_", 1)[-1] in s for s in stored)


def test_malformed_and_unknown_tokens_are_refused(a: Auth) -> None:
    for bad in ("", "nope", "twk_only-two-parts", "xxx_abc_def"):
        with pytest.raises(AuthError):
            a.token(bad)


def test_a_token_with_the_right_id_but_wrong_secret_is_refused(a: Auth) -> None:
    grant = a.create_token("t", {"read"})
    token_id = grant.secret.split("_")[1]
    with pytest.raises(AuthError, match="unknown token"):
        a.token(f"twk_{token_id}_wrong-secret")


def test_revoking_a_token_takes_effect(a: Auth) -> None:
    grant = a.create_token("tuf-trainer", {"read"})
    a.revoke_token("tuf-trainer")
    with pytest.raises(AuthError, match="revoked"):
        a.token(grant.secret)
    with pytest.raises(KeyError):
        a.revoke_token("tuf-trainer")  # already revoked


def test_an_expired_token_is_refused(a: Auth) -> None:
    grant = a.create_token("short-lived", {"read"}, ttl=-1.0)
    with pytest.raises(AuthError, match="expired"):
        a.token(grant.secret)


def test_last_used_is_recorded(a: Auth) -> None:
    """So a token nobody uses can be found and revoked."""
    grant = a.create_token("t", {"read"})
    assert a.tokens()[0]["last_used"] is None
    a.token(grant.secret)
    assert a.tokens()[0]["last_used"] is not None


def test_token_names_are_unique(a: Auth) -> None:
    a.create_token("dup", {"read"})
    with pytest.raises(sqlite3.IntegrityError):
        a.create_token("dup", {"read"})


# ── rate limiting ────────────────────────────────────────────────────────


def test_lockout_fires_and_is_scoped_to_the_ip(a: Auth) -> None:
    for _ in range(auth_mod.LOCKOUT_AFTER):
        with pytest.raises(AuthError):
            a.login("sai", "wrong", ip="9.9.9.9")

    with pytest.raises(LockedOutError) as caught:
        a.login("sai", PW, ip="9.9.9.9")  # correct password, still locked
    assert caught.value.retry_after == auth_mod.LOCKOUT_WINDOW

    # A different device must not be collateral damage — otherwise anyone on
    # the tailnet can lock the only account out from anywhere.
    assert a.login("sai", PW, ip="100.1.1.1")


def test_failures_outside_the_window_do_not_count(a: Auth) -> None:
    old = time.time() - auth_mod.LOCKOUT_WINDOW - 60
    for _ in range(20):
        a._db.execute(
            "INSERT INTO login_attempts (username, ip, ts, ok) VALUES (?, ?, ?, 0)",
            ("sai", "9.9.9.9", old),
        )
    a._db.commit()
    assert a.login("sai", PW, ip="9.9.9.9"), "stale failures must age out"


def test_an_unknown_user_fails_the_same_way(a: Auth) -> None:
    """No user-enumeration oracle: same exception, same message."""
    with pytest.raises(AuthError) as missing:
        a.login("ghost", PW)
    with pytest.raises(AuthError) as wrong:
        a.login("sai", "wrong")
    assert str(missing.value) == str(wrong.value) == "invalid credentials"


# ── audit chain ──────────────────────────────────────────────────────────


def test_every_auth_event_is_recorded(a: Auth) -> None:
    a.login("sai", PW)
    actions = {row["action"] for row in a.audit()}
    assert {"user.create", "login.ok"} <= actions


def test_chain_verifies_when_untouched(a: Auth) -> None:
    a.login("sai", PW)
    a.create_token("t", {"read"})
    ok, why = a.verify_chain()
    assert ok, why


def test_chain_detects_an_edited_row(a: Auth) -> None:
    """Relabelling a failed login as successful must not pass unnoticed."""
    with pytest.raises(AuthError):
        a.login("sai", "wrong")
    a._db.execute("UPDATE audit_log SET action = 'login.ok' WHERE action = 'login.fail'")
    a._db.commit()
    ok, why = a.verify_chain()
    assert not ok
    assert "do not match its hash" in why


def test_chain_detects_a_deleted_row(a: Auth) -> None:
    a.login("sai", PW)
    a.create_token("t", {"read"})
    seqs = [r["seq"] for r in a.audit()]
    a._db.execute("DELETE FROM audit_log WHERE seq = ?", (seqs[len(seqs) // 2],))
    a._db.commit()
    ok, why = a.verify_chain()
    assert not ok
    assert "prev_hash" in why


def test_chain_detects_a_reordered_row(a: Auth) -> None:
    a.login("sai", PW)
    a.create_token("t", {"read"})
    rows = a._db.execute("SELECT seq, action FROM audit_log ORDER BY seq").fetchall()
    first, second = rows[0], rows[1]
    a._db.execute("UPDATE audit_log SET action = ? WHERE seq = ?", (second["action"], first["seq"]))
    a._db.execute("UPDATE audit_log SET action = ? WHERE seq = ?", (first["action"], second["seq"]))
    a._db.commit()
    ok, _ = a.verify_chain()
    assert not ok


def test_an_empty_chain_verifies(tmp_path: Path, cheap_kdf: None) -> None:
    with Auth(tmp_path / "t.db") as fresh:
        ok, why = fresh.verify_chain()
        assert ok
        assert "0 entries" in why


def test_detail_is_canonical_json_so_the_chain_is_checkable(a: Auth) -> None:
    """Key order must not change the bytes hashed, or verification is luck."""
    a.record("system", "x", "test", detail={"b": 2, "a": 1})
    ok, why = a.verify_chain()
    assert ok, why
    assert a.audit()[0]["detail"] == '{"a":1,"b":2}'


# ── the Phase B gate ─────────────────────────────────────────────────────


def test_gate_auth_holds_under_the_four_attacks(tmp_path: Path, cheap_kdf: None) -> None:
    """The Phase B gate: revocation works, the limiter fires, tampering shows.

    One test rather than four so it reads as a single claim about the system:
    an attacker with a stolen cookie, a guessed password, a leaked token, or
    write access to the log gets nowhere useful.
    """
    with Auth(tmp_path / "t.db") as auth:
        auth.create_user("sai", PW, role="owner")

        # 1. a stolen cookie dies the moment it is revoked
        stolen = auth.login("sai", PW, ip="100.1.1.1")
        assert auth.session(stolen).name == "sai"
        auth.logout(stolen)
        with pytest.raises(AuthError):
            auth.session(stolen)

        # 2. guessing is throttled, and the throttle does not lock out the
        #    legitimate device
        for _ in range(auth_mod.LOCKOUT_AFTER):
            with pytest.raises(AuthError):
                auth.login("sai", "guess", ip="6.6.6.6")
        with pytest.raises(LockedOutError):
            auth.login("sai", PW, ip="6.6.6.6")
        assert auth.session(auth.login("sai", PW, ip="100.1.1.1")).name == "sai"

        # 3. a leaked machine token is scoped, and revocable
        grant = auth.create_token("tuf-trainer", {"telemetry:write"})
        who = auth.token(grant.secret)
        assert who.can("telemetry:write")
        assert not who.can("progress:write"), "must not be able to rewrite history"
        auth.revoke_token("tuf-trainer")
        with pytest.raises(AuthError):
            auth.token(grant.secret)

        # 4. neither secret is recoverable from the database
        rows = auth._db.execute("SELECT id FROM sessions").fetchall()
        assert all(r["id"] != stolen for r in rows)
        hashes = [r["secret_hash"] for r in auth._db.execute("SELECT secret_hash FROM api_tokens")]
        assert grant.secret not in hashes

        # and every one of those events is on the record, tamper-evident
        ok, why = auth.verify_chain()
        assert ok, why
        actions = {r["action"] for r in auth.audit(limit=200)}
        assert {"user.create", "login.ok", "login.fail", "token.create", "token.revoke"} <= actions

        auth._db.execute("DELETE FROM audit_log WHERE action = 'login.fail'")
        auth._db.commit()
        ok, why = auth.verify_chain()
        assert not ok, "deleting the failures must not pass verification"
