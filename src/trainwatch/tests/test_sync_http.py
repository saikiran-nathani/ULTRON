"""Sync over HTTP: the guards, the owner boundary, and the enrolment trap.

`test_sync.py` proves the record logic. This proves the parts that only exist
at the HTTP layer — and one of them, owner isolation, is the difference between
a personal app and a data breach.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.trainwatch import auth as auth_mod
from src.trainwatch.auth import Auth
from src.trainwatch.config import Config
from src.trainwatch.hlc import format_hlc
from src.trainwatch.server.app import create_app
from src.trainwatch.server.auth_api import CSRF_COOKIE, CSRF_HEADER

PW = "correct-horse-battery"
GUARD = {"X-Trainwatch": "1"}
T0 = 1_789_344_000_000


@pytest.fixture(autouse=True)
def cheap_kdf(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    monkeypatch.setattr(auth_mod, "_N", 2**8)
    yield


@pytest.fixture
def open_client(cfg: Config) -> Iterator[TestClient]:
    """No accounts enrolled: the ADR-0003 posture, enforcement dormant."""
    with TestClient(create_app(cfg)) as c:
        yield c


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
    with TestClient(create_app(cfg)) as c:
        yield c


def _login(c: TestClient, user: str = "sai") -> dict[str, str]:
    resp = c.post("/api/auth/login", json={"username": user, "password": PW}, headers=GUARD)
    assert resp.status_code == 200, resp.text
    return {CSRF_HEADER: c.cookies[CSRF_COOKIE], **GUARD}


def change(rid: str, counter: int = 0, node: str = "dev-a", body=None) -> dict:
    return {
        "collection": "journal",
        "id": rid,
        "hlc": format_hlc(T0, counter, node),
        "body": body or {"v": rid},
    }


# ══ the enrolment trap ═══════════════════════════════════════════════════


def test_sync_refuses_when_no_account_exists_and_says_why(open_client: TestClient) -> None:
    """The one place sync deviates from "open on the tailnet", deliberately.

    With no accounts, AuthGuard lets everything through and there is no
    identity — so sync would have to invent an owner. Records would accumulate
    under it, and then `trainwatch user add` would give the real owner a
    different id and **every synced record would vanish from the app**. Not
    deleted; filed under an owner nobody authenticates as.

    A trap that springs on doing the right thing. So it refuses, and the
    refusal names the fix.
    """
    resp = open_client.post("/api/sync?device=dev-a", json={"changes": []}, headers=GUARD)
    assert resp.status_code == 401
    detail = resp.json()["detail"]
    assert detail["error"] == "sync needs an account"
    assert "trainwatch user add" in detail["fix"]


def test_the_rest_of_the_api_stays_open_with_no_accounts(open_client: TestClient) -> None:
    """The deviation is scoped to sync and nothing else."""
    assert open_client.get("/api/state").status_code == 200
    assert open_client.get("/api/hub").status_code == 200


# ══ the guards ═══════════════════════════════════════════════════════════


def test_unauthenticated_sync_is_refused(client: TestClient) -> None:
    assert client.post("/api/sync?device=dev-a", json={"changes": []}, headers=GUARD).status_code == 401


def test_sync_without_the_guard_header_is_refused(client: TestClient) -> None:
    """ADR-0003 C3 applies to sync like any other write.

    The 403 reads like an auth failure and is not — the same trap the login
    form hit. Asserted here so the client's own error handling has something
    to be right about.
    """
    _login(client)
    resp = client.post("/api/sync?device=dev-a", json={"changes": []})
    assert resp.status_code == 403
    assert "x-trainwatch" in resp.text.lower()


def test_sync_without_the_csrf_token_is_refused(client: TestClient) -> None:
    _login(client)
    resp = client.post("/api/sync?device=dev-a", json={"changes": []}, headers=GUARD)
    assert resp.status_code == 403
    assert "csrf" in resp.text.lower()


def test_a_machine_token_cannot_sync(client: TestClient, cfg: Config) -> None:
    """`api_tokens` has no user_id, so a token genuinely has no owner.

    It is the trainer posting telemetry, not somebody's device. Attributing
    personal records to it would be a guess, and a guess that silently mixes
    two datasets.
    """
    with Auth(cfg.db_path) as auth:
        grant = auth.create_token("trainer", scopes={"*"})
    resp = client.post(
        "/api/sync?device=dev-a",
        json={"changes": []},
        headers={"Authorization": f"Bearer {grant.secret}", **GUARD},
    )
    assert resp.status_code == 403
    assert "human" in resp.text.lower()


# ══ the round trip ═══════════════════════════════════════════════════════


def test_push_then_pull_in_one_request(client: TestClient) -> None:
    csrf = _login(client)
    resp = client.post(
        "/api/sync?device=dev-a&since=0",
        json={"changes": [change("a"), change("b", 1)]},
        headers=csrf,
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert sorted(body["accepted"]) == ["journal/a", "journal/b"]
    assert body["rejected"] == []
    # Our own writes come back in the same trip — one exchange converges.
    assert sorted(r["id"] for r in body["records"]) == ["a", "b"]
    assert body["cursor"] == 2
    assert body["more"] is False


def test_a_second_device_pulls_what_the_first_pushed(client: TestClient) -> None:
    csrf = _login(client)
    client.post("/api/sync?device=phone", json={"changes": [change("a")]}, headers=csrf)
    resp = client.post("/api/sync?device=laptop&since=0", json={"changes": []}, headers=csrf)
    assert [r["id"] for r in resp.json()["records"]] == ["a"]


def test_a_conflict_returns_the_winner_over_http(client: TestClient) -> None:
    csrf = _login(client)
    client.post(
        "/api/sync?device=phone",
        json={"changes": [change("x", 9, "phone", {"v": "winner"})]},
        headers=csrf,
    )
    resp = client.post(
        "/api/sync?device=laptop",
        json={"changes": [change("x", 2, "laptop", {"v": "loser"})]},
        headers=csrf,
    )
    body = resp.json()
    assert body["accepted"] == []
    assert len(body["rejected"]) == 1
    assert body["rejected"][0]["winner"]["body"] == {"v": "winner"}


def test_a_malformed_change_is_422_not_400(client: TestClient) -> None:
    """Unprocessable, not unparseable — and distinguishable from a rejection.

    A rejected write is a normal 200 with a `rejected` list. A malformed one is
    a client bug. Collapsing the two would make the client unable to tell
    "retry with the winner" from "this will never work".
    """
    csrf = _login(client)
    resp = client.post(
        "/api/sync?device=dev-a",
        json={"changes": [{"collection": "journal", "id": "a", "hlc": "nonsense", "body": {}}]},
        headers=csrf,
    )
    assert resp.status_code == 422
    assert "hlc" in resp.text.lower()


def test_an_empty_push_is_a_valid_pull(client: TestClient) -> None:
    """The common case on a phone: nothing to send, catch me up."""
    csrf = _login(client)
    client.post("/api/sync?device=laptop", json={"changes": [change("a")]}, headers=csrf)
    resp = client.post("/api/sync?device=phone&since=0", json={"changes": []}, headers=csrf)
    assert resp.status_code == 200
    assert [r["id"] for r in resp.json()["records"]] == ["a"]


# ══ the owner boundary ═══════════════════════════════════════════════════


def test_one_owner_cannot_see_or_overwrite_another(client: TestClient, cfg: Config) -> None:
    """`owner_id` comes from the identity, never from the request.

    It is the partition key for every record. If it could be set from a body
    field or a query parameter, any authenticated client could read and
    overwrite any other owner's entire dataset by changing one integer.

    There is one human today. This test is what keeps the boundary a property
    rather than an accident of there being nobody else.
    """
    with Auth(cfg.db_path) as auth:
        auth.create_user("other", PW, role="owner")

    a = _login(client, "sai")
    client.post(
        "/api/sync?device=sai-phone",
        json={"changes": [change("shared-id", 0, "sai-phone", {"owner": "sai"})]},
        headers=a,
    )
    client.post("/api/auth/logout", headers=a)

    b = _login(client, "other")
    resp = client.post("/api/sync?device=other-phone&since=0", json={"changes": []}, headers=b)
    assert resp.json()["records"] == [], "one owner pulled another's records"

    # Same collection AND same record id must not collide.
    client.post(
        "/api/sync?device=other-phone",
        json={"changes": [change("shared-id", 0, "other-phone", {"owner": "other"})]},
        headers=b,
    )
    mine = client.post("/api/sync?device=other-phone&since=0", json={"changes": []}, headers=b)
    assert [r["body"] for r in mine.json()["records"]] == [{"owner": "other"}]

    client.post("/api/auth/logout", headers=b)
    a = _login(client, "sai")
    theirs = client.post("/api/sync?device=sai-phone&since=0", json={"changes": []}, headers=a)
    assert [r["body"] for r in theirs.json()["records"]] == [{"owner": "sai"}], (
        "another owner's push overwrote this owner's record"
    )


# ══ devices and the archive ══════════════════════════════════════════════


def test_state_lists_devices_and_counts(client: TestClient) -> None:
    csrf = _login(client)
    client.post(
        "/api/sync?device=phone&name=iPhone&platform=ios",
        json={"changes": [change("a")]},
        headers=csrf,
    )
    body = client.get("/api/sync/state").json()
    phone = next(d for d in body["devices"] if d["id"] == "phone")
    assert (phone["name"], phone["platform"], phone["retired"]) == ("iPhone", "ios", False)
    assert body["stats"]["records"] == 1


def test_retiring_a_device_is_reported_and_is_idempotent(client: TestClient) -> None:
    csrf = _login(client)
    client.post("/api/sync?device=old", json={"changes": []}, headers=csrf)

    first = client.post("/api/sync/devices/old/retire", headers=csrf)
    assert first.status_code == 200
    assert first.json()["retired"] is True

    again = client.post("/api/sync/devices/old/retire", headers=csrf)
    assert again.json()["retired"] is False, "a second retire should report no change"

    assert next(d for d in client.get("/api/sync/state").json()["devices"] if d["id"] == "old")[
        "retired"
    ]


def test_history_returns_winners_and_losers(client: TestClient) -> None:
    """The conflict archive over HTTP — what "view / restore" renders."""
    csrf = _login(client)
    client.post(
        "/api/sync?device=phone",
        json={"changes": [change("x", 9, "phone", {"v": "winner"})]},
        headers=csrf,
    )
    client.post(
        "/api/sync?device=laptop",
        json={"changes": [change("x", 2, "laptop", {"v": "loser"})]},
        headers=csrf,
    )
    versions = client.get("/api/sync/history/journal/x").json()["versions"]
    by_outcome = {v["outcome"]: v["body"] for v in versions}
    assert by_outcome["accepted"] == {"v": "winner"}
    assert by_outcome["rejected"] == {"v": "loser"}, "the losing version was not recoverable"


def test_state_and_history_need_an_identity_too(client: TestClient) -> None:
    # Reads are guarded as well; otherwise the device list of an enrolled
    # instance would be readable by anything on the tailnet.
    assert client.get("/api/sync/state").status_code == 401
    assert client.get("/api/sync/history/journal/x").status_code == 401
