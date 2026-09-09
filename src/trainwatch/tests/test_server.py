"""The read-only API the dashboard consumes."""

from __future__ import annotations

import time
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from src.trainwatch.config import Config
from src.trainwatch.server.app import create_app
from src.trainwatch.store import Store


@pytest.fixture
def seeded(cfg: Config) -> Config:
    with Store(cfg.db_path, flush_interval=0.0) as s:
        s.start_run("r1", "run_042", meta={"model": "gpt"})
        for i in range(300):
            s.log_metrics(
                "r1",
                i,
                {
                    "loss": 3.0 / (i + 1),
                    "grad_norm": 5.0,
                    "resid_rms/layer_0": 1.0,
                    "resid_rms/layer_1": 1.2,
                    "attn_logit_max/layer_0": 11.0,
                },
            )
            s.beat("r1", i)  # StoreSink does this per step in real use
        s.flush()
        s.add_event(run_id="r1", level="warn", rule="grad_norm", title="Spike", body="b", step=9)
        s.add_gpu_samples(
            [{"ts": time.time(), "gpu_index": 0, "name": "RTX 4070", "temp": 88, "util": 99}]
        )
    return cfg


@pytest.fixture
def client(seeded: Config) -> Iterator[TestClient]:
    with TestClient(create_app(seeded)) as c:
        yield c


def test_healthz(client: TestClient) -> None:
    assert client.get("/healthz").json()["ok"] is True


def test_state_is_one_round_trip_for_the_whole_screen(client: TestClient) -> None:
    s = client.get("/api/state").json()
    assert s["run"]["name"] == "run_042"
    assert s["headline"]["grad_norm"] == 5.0
    assert s["heartbeat"]["age"] >= 0
    assert s["events"][0]["rule"] == "grad_norm"
    assert s["gpu"][0]["name"] == "RTX 4070"
    assert "notify" in s


def test_groups_are_derived_from_slash_prefixes(client: TestClient) -> None:
    """This is the payoff for the guide's structured-key rule: per-layer panels
    lay themselves out with no configuration."""
    g = client.get("/api/runs/r1/groups").json()
    assert set(g) == {"scalars", "resid_rms", "attn_logit_max"}
    assert g["resid_rms"] == ["resid_rms/layer_0", "resid_rms/layer_1"]


def test_series_respects_the_point_budget(client: TestClient) -> None:
    r = client.get("/api/runs/r1/series", params={"keys": "loss", "points": 50}).json()
    assert len(r["series"]["loss"]) <= 51


def test_series_caps_the_number_of_keys(client: TestClient) -> None:
    keys = ",".join(f"k{i}" for i in range(200))
    r = client.get("/api/runs/r1/series", params={"keys": keys}).json()
    assert len(r["series"]) <= 64


def test_unknown_run_is_404_not_500(client: TestClient) -> None:
    assert client.get("/api/runs/nope").status_code == 404
    assert client.get("/api/runs/nope/series", params={"keys": "loss"}).status_code == 404


def test_query_bounds_are_enforced(client: TestClient) -> None:
    assert (
        client.get("/api/runs/r1/series", params={"keys": "loss", "points": 99999}).status_code
        == 422
    )
    assert client.get("/api/events", params={"limit": 0}).status_code == 422


def test_throttle_is_surfaced_as_a_verdict(cfg: Config) -> None:
    with Store(cfg.db_path, flush_interval=0.0) as s:
        s.start_run("r1", "r")
        s.beat("r1", 1)
        s._db.commit()
        s.add_gpu_samples(
            [{"ts": time.time(), "gpu_index": 0, "temp": 90, "throttle": "hw_thermal"}]
        )
    with TestClient(create_app(cfg)) as c:
        state = c.get("/api/state").json()
    assert state["throttled"] is True
    assert state["status"] == "throttled"


def test_idle_gpu_reasons_are_not_treated_as_throttling(cfg: Config) -> None:
    """gpu_idle and app-clock settings are in the same bitmask but cost nothing."""
    with Store(cfg.db_path, flush_interval=0.0) as s:
        s.start_run("r1", "r")
        s.beat("r1", 1)
        s._db.commit()
        s.add_gpu_samples([{"ts": time.time(), "gpu_index": 0, "temp": 40, "throttle": ""}])
    with TestClient(create_app(cfg)) as c:
        state = c.get("/api/state").json()
    assert state["throttled"] is False
    assert state["status"] == "healthy"


def test_a_stale_heartbeat_shows_as_stale_not_healthy(cfg: Config) -> None:
    with Store(cfg.db_path, flush_interval=0.0) as s:
        s.start_run("r1", "r")
        s.beat("r1", 1, ts=time.time() - 10_000)
        s._db.commit()
    with TestClient(create_app(cfg)) as c:
        assert c.get("/api/state").json()["status"] == "stale"


def test_empty_database_does_not_explode(cfg: Config) -> None:
    with TestClient(create_app(cfg)) as c:
        s = c.get("/api/state").json()
    assert s["run"] is None
    assert s["status"] == "no-run"
    assert s["events"] == []


def test_training_telemetry_stays_read_only(client: TestClient) -> None:
    """ADR-0003 made the *hub* writable; the training half must not follow.

    The original invariant was "the whole API is GET-only". That became false
    on purpose when the hub gained writes, so it narrowed rather than
    disappeared. ADR-0004 narrows it a second time, and it is worth being
    precise about what is actually being protected.

    The property is: **a browser session must not be able to falsify a
    training record.** "No write routes at all" was a proxy for that, and it
    held while the trainer and the server shared a filesystem.

    Two kinds of route are now exempt, for different reasons:

    - `/api/auth/*` writes sessions and login attempts. It touches no run,
      metric, event or GPU row, so it cannot falsify a training record.
    - `/api/telemetry` *does* write training records, because the hub moved to
      the Mac and the trainer is on the TUF, so ingest has to cross the
      network. It is exempt from the route-shape check and covered instead by
      `test_telemetry_refuses_a_browser_session`, which tests the real
      property directly: the route requires a machine token and refuses a
      cookie-borne identity outright, owner included.

    Testing the property beats testing the proxy. Everything else stays
    read-only.
    """
    schema = client.get("/api/openapi.json").json()
    offenders = [
        f"{method.upper()} {path}"
        for path, ops in schema["paths"].items()
        for method in ops
        if method in ("post", "put", "patch", "delete") and not _may_write(path)
    ]
    assert offenders == [], f"training routes must stay read-only: {offenders}"


def _is_hub_path(path: str) -> bool:
    return path.startswith(
        ("/api/clip", "/api/clips", "/api/files", "/api/links", "/api/notes", "/api/hub")
    )


def _may_write(path: str) -> bool:
    """Routes allowed to accept a mutation. See the invariant's docstring."""
    return _is_hub_path(path) or path.startswith(("/api/auth", "/api/telemetry"))


def test_the_hub_half_does_have_writes(client: TestClient) -> None:
    """The complement of the above — if this ever goes empty, the hub broke."""
    schema = client.get("/api/openapi.json").json()
    writes = [
        f"{m.upper()} {p}"
        for p, ops in schema["paths"].items()
        for m in ops
        if m in ("post", "put", "delete") and _is_hub_path(p)
    ]
    assert len(writes) >= 10, writes


def test_notify_disabled_is_reported_to_the_client(client: TestClient) -> None:
    assert client.get("/api/state").json()["notify"]["enabled"] is False
