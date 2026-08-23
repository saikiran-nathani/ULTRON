"""Layer 4 — the server that backs the iPad dashboard.

Imports FastAPI, so it lives behind the `server` extra and is never imported by
the training process. `from trainwatch.server.app import create_app`.
"""

from __future__ import annotations

__all__ = ["create_app"]


def __getattr__(name: str) -> object:  # pragma: no cover - thin lazy re-export
    if name == "create_app":
        from .app import create_app

        return create_app
    raise AttributeError(name)
