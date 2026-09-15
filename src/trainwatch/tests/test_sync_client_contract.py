"""The contract between the sync server and the dashboard's sync client.

`test_sync_http.py` proves the server behaves. It cannot prove the client
speaks the same protocol, and the two halves are in different languages in
different directories with no compiler between them.

The failure this catches is a path that exists in TypeScript and not in Python.
It does not fail at build time, it does not fail in either test suite, and it
does not fail on this machine — it fails as a 404 on a phone, presenting as
"sync is quiet" rather than as an error, because a client that cannot reach the
endpoint has nothing to report. Same reasoning as
`test_auth_client_contract.py`, one subsystem along.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.trainwatch.config import Config
from src.trainwatch.server.app import create_app

CLIENT_DIR = Path(__file__).resolve().parents[3] / "dashboard" / "src"

# `/api/sync/devices/<some id>/retire` in the client is one route with a path
# parameter on the server. Anything that is not a further path segment is the
# id, whatever the client happened to interpolate.
_RETIRE = re.compile(r"^/api/sync/devices/[^/]+/retire$")


@pytest.fixture
def client(cfg: Config) -> Iterator[TestClient]:
    with TestClient(create_app(cfg)) as c:
        yield c


def _sources() -> Iterator[str]:
    for pattern in ("*.ts", "*.tsx"):
        for f in CLIENT_DIR.rglob(pattern):
            yield f.read_text("utf-8")


def _normalise(raw: str) -> str:
    path = raw.split("?")[0].rstrip("/")
    return "/api/sync/devices/{device_id}/retire" if _RETIRE.match(path) else path


def _called_paths() -> set[str]:
    """Every `/api/sync...` path the dashboard builds.

    Two passes, because one is not enough. A plain literal scan found
    `"/api/sync"` and missed `/api/sync/state` entirely: the client keeps
    `const BASE = "/api/sync"` and assembles the rest as `` `${BASE}/state` ``.
    The only occurrences of the full string were in the client's *own* test
    file — so the contract was being checked against the client's expectations
    rather than against the client, and both could have drifted together.

    So the second pass resolves single-constant bases. It deliberately does not
    try to evaluate TypeScript: anything more indirect than `${CONST}/suffix`
    is out of reach here, and the honest mitigation for that is the assertion
    in `test_the_dashboard_has_a_sync_client_at_all` that the two paths which
    make sync exist are actually named somewhere.
    """
    found: set[str] = set()
    for src in _sources():
        for raw in re.findall(r"""["'`](/api/sync[^"'`$]*)["'`]""", src):
            found.add(_normalise(raw))

        # `const NAME = "/api/sync...";` then `` `${NAME}/suffix` ``
        bases = dict(re.findall(r"""const\s+(\w+)\s*=\s*["'](/api/sync[^"']*)["']""", src))
        for name, base in bases.items():
            for suffix in re.findall(r"`\$\{" + name + r"\}([^`]*)`", src):
                # Drop interpolations inside the suffix — `${encodeURIComponent(
                # deviceId)}` is a path parameter, and the retire normaliser
                # turns whatever it was into the server's `{device_id}`.
                cleaned = re.sub(r"\$\{[^}]*\}", "x", suffix)
                found.add(_normalise(base + cleaned))
    return found


def test_the_dashboard_has_a_sync_client_at_all(client: TestClient) -> None:
    """The vacuity check, and it is not hypothetical.

    An earlier version of this file passed while `dashboard/src` contained no
    sync client whatsoever — the server half was complete and nothing called
    it. A contract test that is satisfied by the absence of one side is worse
    than no test: it reports agreement between a protocol and nothing.
    """
    assert CLIENT_DIR.is_dir(), f"{CLIENT_DIR} is missing — update CLIENT_DIR rather than the test"
    called = _called_paths()
    assert called, "the dashboard calls no /api/sync endpoint at all"
    # The round trip and the live stream are the two that make sync exist.
    assert "/api/sync" in called, "nothing pushes or pulls"
    assert "/api/sync/events" in called, "nothing subscribes to the live stream"


def test_every_sync_endpoint_the_client_calls_exists_on_the_server(client: TestClient) -> None:
    # The OpenAPI schema rather than `app.routes`: this FastAPI represents an
    # included router as one opaque `_IncludedRouter` whose `path` is None, so
    # the flat route list does not contain /api/sync/* at all. A test built on
    # it reports every endpoint missing and invites being weakened until it
    # passes.
    served = set(client.app.openapi()["paths"])  # type: ignore[attr-defined]
    missing = sorted(p for p in _called_paths() if p not in served)
    assert not missing, (
        f"the client calls paths the server does not serve: {missing}\n"
        f"served: {sorted(p for p in served if p.startswith('/api/sync'))}"
    )


def test_the_client_does_not_put_a_record_id_in_a_url_path(client: TestClient) -> None:
    """A record id is opaque data and contains percent-escapes.

    Stage 3b keys a nested record as
    `encodeURIComponent(parent):encodeURIComponent(child)`, so the id really
    does contain `%3A`. A path segment cannot carry it: this stack decodes the
    path before routing, so the server looks up an id that exists nowhere and
    answers 200 with an empty list — which reads as "this record has no
    conflict history" rather than as a bug.

    So `/api/sync/history` takes the id as a query parameter, and the server
    must not grow a path-shaped variant for it later. This asserts the absence.
    """
    served = [p for p in client.app.openapi()["paths"] if p.startswith("/api/sync/history")]  # type: ignore[attr-defined]
    assert served == ["/api/sync/history"], (
        f"a path-parameter history route appeared: {served}. A record id cannot "
        "survive a path segment — see the query-parameter note in sync_api.py."
    )
