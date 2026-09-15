"""Sync over HTTP: the guards, the owner boundary, and the enrolment trap.

`test_sync.py` proves the record logic. This proves the parts that only exist
at the HTTP layer — and one of them, owner isolation, is the difference between
a personal app and a data breach.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterator
from dataclasses import replace

import pytest
from fastapi.testclient import TestClient

from src.trainwatch import auth as auth_mod
from src.trainwatch.auth import Auth
from src.trainwatch.config import Config
from urllib.parse import quote, unquote

from src.trainwatch.hlc import format_hlc
from src.trainwatch.server.app import create_app
from src.trainwatch.server.auth_api import CSRF_COOKIE, CSRF_HEADER
from src.trainwatch.sync import Sync

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


def _cookie_header(c: TestClient) -> str:
    return "; ".join(f"{k}={v}" for k, v in c.cookies.items())


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


def test_an_unidentifiable_change_is_422(client: TestClient) -> None:
    """Unprocessable, not unparseable — and distinguishable from a rejection.

    A rejected write is a normal 200 with a `rejected` list. A change that does
    not even say which record it is about is a client bug: there is nothing to
    report per-record, so the request is refused outright. Collapsing the two
    would make the client unable to tell "retry with the winner" from "this
    will never work".
    """
    csrf = _login(client)
    for broken in (
        {"id": "a", "hlc": "nonsense"},  # no collection
        {"collection": "journal", "hlc": "nonsense"},  # no id
        {"collection": "journal", "id": "   ", "hlc": "nonsense"},  # blank id
        "not an object",
    ):
        resp = client.post("/api/sync?device=dev-a", json={"changes": [broken]}, headers=csrf)
        assert resp.status_code == 422, f"{broken!r} was not refused: {resp.text}"


def test_a_bad_change_the_server_can_name_is_quarantined_not_a_422(client: TestClient) -> None:
    """The wedge, over HTTP.

    A 422 for the batch left the offending record in the client's dirty set, so
    every later push failed identically and the device stopped syncing for good.
    Naming the record instead lets the client drop it and carry on.
    """
    csrf = _login(client)
    resp = client.post(
        "/api/sync?device=dev-a",
        json={
            "changes": [
                {"collection": "journal", "id": "a", "hlc": "nonsense", "body": {}},
                {"collection": "journal", "id": "b", "hlc": format_hlc(T0, 1, "dev-a"), "body": {"v": 1}},
            ]
        },
        headers=csrf,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["accepted"] == ["journal/b"]
    assert [(q["collection"], q["id"]) for q in body["quarantined"]] == [("journal", "a")]
    assert "hlc" in body["quarantined"][0]["reason"].lower()
    # The reason is rendered in a UI, so it must not repeat the identity that
    # the fields beside it already carry.
    assert not body["quarantined"][0]["reason"].startswith("journal/a")


def test_quarantined_is_always_present(client: TestClient) -> None:
    """A key a client has to check for existence is a key it will forget."""
    csrf = _login(client)
    resp = client.post("/api/sync?device=dev-a", json={"changes": []}, headers=csrf)
    assert resp.json()["quarantined"] == []


def test_a_long_nested_key_survives_the_round_trip(client: TestClient) -> None:
    """Stage 3b's keys against the server's length caps.

    A nested record's key is `encodeURIComponent(parent):encodeURIComponent(
    child)`, and the roadmap seed derives ids from content. The longest key in
    a real default blob measures exactly 128 characters — which is what the id
    cap used to be. One more word in a phase title and that record could never
    be pushed, and the failure would have been a 422 that wedged the device.
    """
    csrf = _login(client)
    parent = "seed%3A0001%3Aphase%3Aship-the-flagship-start-the-baseline"
    child = "seed%3A0002%3Atask%3Aflagship-design-build-an-agentic-feature-into-ne"
    key = f"{parent}:{child}"
    assert len(key) == 128, f"the fixture no longer matches the measured worst case ({len(key)})"

    resp = client.post(
        "/api/sync?device=dev-a",
        json={
            "changes": [
                {"collection": "roadmap.phases.tasks", "id": key, "hlc": format_hlc(T0, 1, "dev-a"), "body": {"done": True}}
            ]
        },
        headers=csrf,
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["quarantined"] == []
    assert resp.json()["accepted"] == [f"roadmap.phases.tasks/{key}"]

    # And the conflict archive can be asked about it — a 128-cap on the route
    # would 422 here for exactly the records most likely to need it.
    #
    # The id travels as a QUERY parameter, because a path segment cannot carry
    # it. The key contains percent-escapes — that is what makes the separator
    # unambiguous — and this stack decodes the path before routing, so `%3A`
    # arrives as `:` no matter how many times the client escapes it. The server
    # would look up an id that exists nowhere and answer 200 with an empty
    # version list, which reads as "no conflict history" rather than as a bug.
    hist = client.get(
        "/api/sync/history", params={"collection": "roadmap.phases.tasks", "id": key}
    )
    assert hist.status_code == 200, hist.text
    assert hist.json()["id"] == key, "the id did not survive the round trip"
    assert [v["hlc"] for v in hist.json()["versions"]] == [format_hlc(T0, 1, "dev-a")]

    # Two ways to get this wrong, pinned so the distinction stays visible.
    #
    # Interpolating the key straight into the query string loses it: `%3A` is
    # itself an escape, so it decodes to `:`. That is a client bug with a
    # client fix — encode the value, which `params=` does.
    unencoded = client.get(f"/api/sync/history?collection=x&id={key}")
    assert unencoded.json()["id"] != key, "the key survived without being encoded"

    # A path segment has no such fix: this stack decodes the path an extra time
    # before routing, so even a correctly double-encoded key arrives mangled.
    # That is why the id is a query parameter and not the path it used to be.
    assert unquote(quote(key, safe="")) == key, "one decode of an encoded key is exact"
    assert unquote(unquote(quote(key, safe=""))) != key, "two decodes are not"


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
    versions = client.get(
        "/api/sync/history", params={"collection": "journal", "id": "x"}
    ).json()["versions"]
    by_outcome = {v["outcome"]: v["body"] for v in versions}
    assert by_outcome["accepted"] == {"v": "winner"}
    assert by_outcome["rejected"] == {"v": "loser"}, "the losing version was not recoverable"


def test_state_and_history_need_an_identity_too(client: TestClient) -> None:
    # Reads are guarded as well; otherwise the device list of an enrolled
    # instance would be readable by anything on the tailnet.
    assert client.get("/api/sync/state").status_code == 401
    assert (
        client.get("/api/sync/history", params={"collection": "journal", "id": "x"}).status_code
        == 401
    )


# ══ the live stream ══════════════════════════════════════════════════════


async def _open_stream(
    app: object, cookie_header: str, *, ticks: int = 1, path: str = "/api/sync/events"
) -> dict[str, object]:
    """Open the SSE stream against the real ASGI stack and report the outcome.

    Driving the app directly rather than using `TestClient.stream`, because the
    endpoint is an infinite generator by design and TestClient waits for the
    ASGI call to finish when the response context exits. It hangs forever —
    through `pytest-timeout`, which cannot interrupt it — and the first attempt
    at the equivalent hub test wedged the whole suite. See the same harness in
    `test_auth_client_contract.py`.

    `receive()` answers `http.disconnect` only after `ticks` body chunks have
    been emitted, so the generator runs a real loop iteration or two and the
    frames it produces can be inspected, then returns cleanly.

    The request carries a cookie and an Accept header and nothing else, because
    that is exactly what `new EventSource(...)` sends: no `X-Trainwatch`, no
    `X-CSRF-Token`, no `Authorization`. The API has no parameter for any of them.
    """
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.1"},
        "http_version": "1.1",
        "method": "GET",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "query_string": b"",
        "root_path": "",
        "headers": [(b"host", b"testserver"), (b"accept", b"text/event-stream")]
        + ([(b"cookie", cookie_header.encode())] if cookie_header else []),
        "client": ("127.0.0.1", 1234),
        "server": ("testserver", 80),
        "state": {},
    }
    result: dict[str, object] = {}
    chunks: list[bytes] = []
    done = asyncio.Event()

    async def receive() -> dict[str, str]:
        # Let the generator emit `ticks` frames, then behave like a client that
        # closed the tab.
        await done.wait()
        return {"type": "http.disconnect"}

    async def send(message: dict[str, object]) -> None:
        if message["type"] == "http.response.start":
            result["status"] = message["status"]
            result["headers"] = {
                k.decode(): v.decode()
                for k, v in message.get("headers", [])  # type: ignore[union-attr]
            }
        elif message["type"] == "http.response.body":
            body = message.get("body", b"")
            if body:
                chunks.append(body)  # type: ignore[arg-type]
            if len(chunks) >= ticks:
                done.set()

    # A ceiling, so a regression that reintroduces the hang fails rather than
    # stalling CI.
    await asyncio.wait_for(app(scope, receive, send), timeout=15)  # type: ignore[operator]
    result["frames"] = chunks
    result["body"] = b"".join(chunks)
    return result


def test_the_stream_opens_on_a_cookie_alone(client: TestClient) -> None:
    """`EventSource` cannot set request headers — not "does not by default".

    If the guard ever required a header on GETs, every device would stop
    learning about remote writes while still showing its own data, which reads
    as "nothing has changed on the other devices" rather than as a broken
    connection. Silence presented as agreement.
    """
    _login(client)
    result = asyncio.run(_open_stream(client.app, _cookie_header(client)))
    assert result["status"] == 200, f"stream refused: {result['body']!r}"
    headers = result["headers"]
    assert isinstance(headers, dict)
    assert headers["content-type"].startswith("text/event-stream")
    assert headers["x-accel-buffering"] == "no", "a buffering proxy makes 'live' mean 'in batches'"
    # The opening frame proves the route body ran rather than merely that the
    # guard allowed it — a 200 from a handler that emits nothing is a stream
    # the client waits on forever.
    assert b"retry:" in result["body"]  # type: ignore[operator]


def test_the_stream_is_refused_without_a_session(client: TestClient) -> None:
    """Cookie-only must not mean unguarded."""
    result = asyncio.run(_open_stream(client.app, ""))
    assert result["status"] == 401


def test_the_stream_reports_the_head_it_finds_on_connect(client: TestClient) -> None:
    """A client that connects AFTER a write must not wait for the next one.

    Emitting only on change would leave a device that reconnected at the wrong
    moment sitting on a stale cursor until someone else happened to edit
    something — which, on a personal app with one user, could be hours.
    """
    csrf = _login(client)
    client.post("/api/sync?device=dev-a", json={"changes": [change("x")]}, headers=csrf)

    result = asyncio.run(_open_stream(client.app, _cookie_header(client), ticks=2))
    body = result["body"]
    assert isinstance(body, bytes)
    assert b"event: sync" in body, f"no head frame in {body!r}"
    payload = json.loads(body.split(b"data: ")[1].split(b"\n")[0])
    assert payload == {"head": 1}, "the stream did not report the head that already existed"


def test_the_stream_reports_one_owner_head_to_that_owner_only(cfg: Config) -> None:
    """The stream is a notification, but `head` is still someone's data.

    A shared counter would tell one account how busy another one is, and — far
    worse — would wake every device on every account's write, so each would
    pull and find nothing. A stream that lies about whether you are behind is
    worse than no stream.
    """
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
        auth.create_user("other", PW, role="owner")

    with TestClient(create_app(cfg)) as a, TestClient(create_app(cfg)) as b:
        csrf_a = _login(a)
        b.post("/api/auth/login", json={"username": "other", "password": PW}, headers=GUARD)
        csrf_b = {CSRF_HEADER: b.cookies[CSRF_COOKIE], **GUARD}

        # Two writes by "other", none by "sai".
        b.post("/api/sync?device=dev-b", json={"changes": [change("p")]}, headers=csrf_b)
        b.post("/api/sync?device=dev-b", json={"changes": [change("q", 1)]}, headers=csrf_b)

        heads = {}
        for label, c in (("sai", a), ("other", b)):
            result = asyncio.run(_open_stream(c.app, _cookie_header(c), ticks=2))
            body = result["body"]
            assert isinstance(body, bytes)
            heads[label] = json.loads(body.split(b"data: ")[1].split(b"\n")[0])["head"]

        assert heads["other"] == 2
        assert heads["sai"] == 0, f"one owner's head leaked into another's stream: {heads}"
        assert csrf_a  # the login was real


def test_the_stream_refuses_the_enrolment_trap_before_streaming(open_client: TestClient) -> None:
    """No accounts enrolled: refuse with a 401, not a stream that dies.

    This is the state the hub is actually in — enforcement is dormant until the
    first user exists — so it is the live code path, not an edge case.

    `_owner` refuses here because there is no identity to attribute records to,
    and the refusal has to happen *before* the response starts. Resolved inside
    the generator instead, the exception fires after `http.response.start` has
    gone out: the browser sees a 200 `text/event-stream` that closes
    immediately, and `EventSource` reconnects on a timer against a server that
    will never let it in. A tight loop, forever, with no error anywhere.

    AuthGuard cannot cover this one. It rejects session-less requests, but here
    the guard is deliberately open — so the route is reached and `_owner` is
    the only thing standing between a device and an owner id of nobody.
    """
    result = asyncio.run(_open_stream(open_client.app, ""))
    assert result["status"] == 401, (
        f"expected a refusal before the stream opened, got {result['status']} "
        f"with body {result['body']!r}"
    )
    body = result["body"]
    assert isinstance(body, bytes)
    assert b"retry:" not in body, "the stream opened anyway — EventSource will loop on this"


# ══ the Stage 3 gate, over HTTP with two real devices ════════════════════
#
# `test_sync.py` proves these three scenarios against the `Sync` class. That is
# necessary and not sufficient: it calls Python methods in one process, so it
# cannot catch a cursor the HTTP layer forgets to thread through, a device
# identity taken from the wrong place, or a response field the client would
# need and the endpoint does not send. Every one of those is invisible below
# the HTTP boundary and fatal above it.
#
# The plan's gate is these three run on the phone. That still needs the phone —
# but nothing else here is a stand-in, so the shortfall is "not yet on real
# devices" rather than "not yet tested".


def _sync(
    c: TestClient, csrf: dict[str, str], device: str, *, since: int = 0, changes: list | None = None
) -> dict:
    resp = c.post(
        f"/api/sync?device={device}&since={since}",
        json={"changes": changes or []},
        headers=csrf,
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


def _two_devices(cfg: Config) -> Iterator[tuple[TestClient, dict, TestClient, dict]]:
    """Two TestClients over ONE database: two devices, one account.

    Separate clients rather than one client with two `device=` values, because
    a shared cookie jar would hide a server that attributed records to the
    session rather than to the device.
    """
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
    with TestClient(create_app(cfg)) as a, TestClient(create_app(cfg)) as b:
        yield a, _login(a), b, _login(b)


@pytest.fixture
def two_devices(cfg: Config) -> Iterator[tuple[TestClient, dict, TestClient, dict]]:
    yield from _two_devices(cfg)


def test_gate_aeroplane_mode_capture_arrives_exactly_once(two_devices) -> None:
    """Capture offline, reconnect, and the other device sees it once.

    "Exactly once" is the whole assertion. Twice is the failure people actually
    hit: the push succeeded, the response was lost to the tunnel closing, the
    client retried, and now there are two of everything — indistinguishable
    from two things someone meant to write.
    """
    a, csrf_a, b, csrf_b = two_devices

    # Three edits made with the radio off, pushed in one batch on reconnect.
    offline = [change("n1", 0), change("n2", 1), change("n3", 2)]
    first = _sync(a, csrf_a, "phone", changes=offline)
    assert sorted(first["accepted"]) == ["journal/n1", "journal/n2", "journal/n3"]

    # The response never arrived, so the client retries the identical batch.
    replay = _sync(a, csrf_a, "phone", changes=offline)
    assert sorted(replay["accepted"]) == ["journal/n1", "journal/n2", "journal/n3"], (
        "a replay must report accepted — a client told 'rejected' would keep "
        "the records dirty and retry them forever"
    )
    assert replay["head"] == first["head"], "the replay burned sequence numbers"

    # The other device pulls once and sees three records, not six.
    pulled = _sync(b, csrf_b, "laptop", since=0)
    ids = [r["id"] for r in pulled["records"]]
    assert sorted(ids) == ["n1", "n2", "n3"], f"expected each capture once, got {ids}"
    assert len(ids) == len(set(ids))


def test_gate_a_delete_survives_the_other_device_reconnecting(two_devices) -> None:
    """Delete on one device while the other is offline — it stays deleted.

    The failure is resurrection, and it is silent: the offline device still
    holds the record, and if it diffs against what the server has rather than
    against its own last-pushed state, the record looks like something the
    server is missing. So it pushes it back, and the deletion undoes itself.
    """
    a, csrf_a, b, csrf_b = two_devices

    _sync(a, csrf_a, "phone", changes=[change("doomed", 0, body={"v": 1})])
    caught_up = _sync(b, csrf_b, "laptop", since=0)
    assert [r["id"] for r in caught_up["records"]] == ["doomed"]
    cursor_b = caught_up["cursor"]

    # A deletes it. B is offline and does not know.
    tomb = {"collection": "journal", "id": "doomed", "hlc": format_hlc(T0, 5, "phone"), "deleted": True}
    _sync(a, csrf_a, "phone", changes=[tomb])

    # B reconnects. The tombstone must be DELIVERED, not merely "absent from a
    # list of live records" — a client that only ever receives live records can
    # never learn that something was removed.
    back = _sync(b, csrf_b, "laptop", since=cursor_b)
    assert [(r["id"], r["deleted"]) for r in back["records"]] == [("doomed", True)]

    # And B pushing its stale copy loses to the tombstone rather than
    # resurrecting it, because the tombstone's clock is higher.
    stale = _sync(
        b, csrf_b, "laptop", since=back["cursor"], changes=[change("doomed", 1, "laptop", {"v": 1})]
    )
    assert [r["id"] for r in stale["rejected"]] == ["doomed"]
    assert stale["rejected"][0]["winner"]["deleted"] is True, (
        "the rejection must carry the winner — a client told only 'you lost' "
        "cannot converge, and would push the same record on every sync"
    )

    # Third device, fresh: sees a tombstone and no live record.
    fresh = _sync(a, csrf_a, "ipad", since=0)
    live = [r for r in fresh["records"] if not r["deleted"]]
    assert live == [], f"the deleted record came back: {live}"


def test_gate_any_batch_in_any_order_gives_the_same_state(cfg: Config) -> None:
    """Two devices' batches, both interleavings, one final state.

    Without this the two devices both sync successfully and still disagree, and
    which one is right depends on the order packets happened to arrive.
    """
    batch_a = [change("x", 1, "phone", {"who": "phone"}), change("y", 2, "phone", {"v": 1})]
    batch_b = [change("x", 3, "laptop", {"who": "laptop"}), change("z", 4, "laptop", {"v": 2})]

    states = []
    for order in ((batch_a, "phone"), (batch_b, "laptop")), ((batch_b, "laptop"), (batch_a, "phone")):
        # A fresh database per ordering, so neither run can observe the other.
        fresh = replace(cfg, db_path=cfg.db_path.parent / f"order{len(states)}.db")
        with Auth(fresh.db_path) as auth:
            auth.create_user("sai", PW, role="owner")
        with TestClient(create_app(fresh)) as c:
            csrf = _login(c)
            for changes, device in order:
                _sync(c, csrf, device, changes=changes)
            final = _sync(c, csrf, "observer", since=0)
        states.append({r["id"]: (r["hlc"], r["body"], r["deleted"]) for r in final["records"]})

    assert states[0] == states[1], f"order changed the outcome:\n{states[0]}\n{states[1]}"
    # And the contested record went to the higher clock, not to whoever was last.
    assert states[0]["x"][1] == {"who": "laptop"}


def test_the_archive_names_the_device_that_overwrote_you(two_devices) -> None:
    """"Replaced by MacBook-Pro at 14:02" — the name is the load-bearing word.

    With only `device_id` the archive can say "replaced by mzr7x8abc12", which
    tells nobody which of their own machines did it. The point of the archive
    is to make an overwrite explicable, and an opaque id is not an explanation.
    """
    a, csrf_a, b, csrf_b = two_devices

    a.post(
        "/api/sync?device=phone&name=Realme%20GT%206&platform=android",
        json={"changes": [change("shared", 1, "phone", {"who": "phone"})]},
        headers=csrf_a,
    )
    b.post(
        "/api/sync?device=laptop&name=MacBook-Pro&platform=macos",
        json={"changes": [change("shared", 9, "laptop", {"who": "laptop"})]},
        headers=csrf_b,
    )

    versions = a.get(
        "/api/sync/history", params={"collection": "journal", "id": "shared"}
    ).json()["versions"]

    names = [v["device_name"] for v in versions]
    assert names == ["MacBook-Pro", "Realme GT 6"], f"newest first, named: {names}"
    # Both were stored — the phone's write simply lost its place to a higher
    # clock. `rejected` is for a push that never landed at all, and that
    # distinction is what tells the user whether their edit was overwritten or
    # never arrived.
    assert [v["outcome"] for v in versions] == ["accepted", "accepted"]
    # The winner has to be identifiable, or the list cannot say what is live.
    assert versions[0]["hlc"] > versions[1]["hlc"]


def test_the_archive_keeps_a_version_whose_device_row_is_gone(cfg: Config) -> None:
    """An append-only log must outlive the rest of the schema.

    `sync_log` is the only record of a version that lost. If the device join
    were an inner join, deleting a device row would silently remove every
    version it ever wrote — and the archive would answer "no history" for a
    record with plenty, which is the exact shape of absence-as-success.
    """
    with Auth(cfg.db_path) as auth:
        auth.create_user("sai", PW, role="owner")
    with TestClient(create_app(cfg)) as a:
        csrf_a = _login(a)
        a.post(
            "/api/sync?device=ghost&name=Old%20Phone",
            json={"changes": [change("kept", 1, "ghost", {"v": 1})]},
            headers=csrf_a,
        )

        # A device row vanishing is not something the app does today, which is
        # precisely why the join must not depend on it still being there.
        with Sync(cfg.db_path) as s:
            s._db.execute("DELETE FROM sync_devices WHERE id = 'ghost'")
            s._db.commit()

        versions = a.get(
            "/api/sync/history", params={"collection": "journal", "id": "kept"}
        ).json()["versions"]
    assert len(versions) == 1, "the version disappeared with its device row"
    assert versions[0]["device_name"] == "ghost", "the name must fall back to the id, not to empty"


def test_a_device_id_that_is_unsafe_in_a_url_is_refused_at_registration(client: TestClient) -> None:
    """The id has to be safe everywhere it travels, and one place is a path.

    `/api/sync/devices/{id}/retire` takes the id as a path segment, and a path
    is decoded before routing. So a device registered as `a%25b` could never be
    retired: the call would look up `a%b`, find nothing, and report success for
    a device it never touched.

    That is not a cosmetic failure. A device that cannot be retired pins the
    tombstone GC watermark — `min(last_pull_seq)` across non-retired devices —
    at its cursor forever, so the one control meant to release it would sit
    there doing nothing while the log grew without bound.

    Refusing at registration is the only place that fixes it for every
    downstream use at once.
    """
    csrf = _login(client)
    for bad in ("a%25b", "has space", "slash/es", "quote'd", "x" * 65):
        resp = client.post(
            f"/api/sync?device={quote(bad, safe='')}",
            json={"changes": []},
            headers=csrf,
        )
        assert resp.status_code == 422, f"{bad!r} was accepted as a device id: {resp.text}"

    # And the shapes the client actually mints still work — `deviceId()` in
    # clock.ts emits base36 with `_.:-` allowed, and uses the same string as
    # the HLC node, so the two charsets must not disagree.
    for good in ("mzr7x8abc12", "dev-a", "mac.book:1", "A_b.c-d:e"):
        resp = client.post(
            f"/api/sync?device={good}", json={"changes": []}, headers=csrf
        )
        assert resp.status_code == 200, f"{good!r} was refused: {resp.text}"
