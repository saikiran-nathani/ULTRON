from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from src.trainwatch.config import Config
from src.trainwatch.hub import Hub
from src.trainwatch.store import Store


@pytest.fixture
def cfg(tmp_path: Path) -> Config:
    """A fully isolated config — no .env, no network, no shared state."""
    return Config(
        db_path=tmp_path / "trainwatch.db",
        heartbeat_path=tmp_path / "heartbeat",
        ntfy_topic="",  # notifications disabled unless a test opts in
        sinks=("store",),
        tensorboard_dir=tmp_path / "runs",
        heartbeat_timeout=900,
        blob_dir=tmp_path / "blobs",
        # TestClient sends Host: testserver, which ADR-0003's C1 guard would
        # otherwise (correctly) reject.
        allowed_hosts="testserver",
    )


@pytest.fixture
def store(cfg: Config) -> Iterator[Store]:
    s = Store(cfg.db_path, flush_interval=0.0)  # flush every call, deterministic
    yield s
    s.close()


@pytest.fixture
def hub(cfg: Config) -> Iterator[Hub]:
    h = Hub(cfg.db_path, cfg.blob_dir)
    yield h
    h.close()
