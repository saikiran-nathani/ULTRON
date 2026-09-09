"""Telemetry ingest — ADR-0004 phase D, receiving half.

`POST /api/telemetry` is the one route that writes training records, and it
exists because the hub moved to the Mac while training stayed on the TUF.

That crosses an invariant `test_server.py` has guarded since ADR-0003: no
route may accept a training-record write, because "the dashboard could falsify
a training record". The property is worth keeping; the mechanism it used --
having no write routes at all -- was a proxy that held only while the trainer
and the server shared a filesystem.

So the property is enforced directly instead: **this route refuses a
cookie-borne identity outright, owner included.** A `telemetry:write` machine
token is the only way in. A browser cannot obtain one by being logged in, so a
session -- however privileged -- still cannot write a metric. The owner's
wildcard scope deliberately does not open this door, which is why the check is
on `identity.kind` and not on scope alone.

Idempotence is the receiver's job, not the sender's
---------------------------------------------------
A shipper that loses its connection mid-post cannot know whether the batch
landed, so it must be free to send it again. Every write here is therefore
replay-safe: metrics upsert on `(run_id, key, step)` (migration 1), gpu and
events are `INSERT OR IGNORE` against unique keys (migration 4), and runs
upsert on id. Sending the same batch twice changes nothing.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from typing import Any

from fastapi import APIRouter, HTTPException, Request

from ..store import Store

__all__ = ["build_telemetry_router"]

log = logging.getLogger("trainwatch.server.telemetry")

# A cap, so one bad client cannot ask the server to hold an unbounded list in
# memory while it parses. The shipper batches well below this.
MAX_METRICS = 20_000
MAX_ROWS = 5_000


def build_telemetry_router(store_for: Callable[[], Store]) -> APIRouter:
    router = APIRouter(prefix="/api/telemetry", tags=["telemetry"])

    @router.post("", status_code=202)
    async def ingest(request: Request, payload: dict[str, Any]) -> dict[str, Any]:
        """Apply a replicated batch. Idempotent; safe to send twice.

        Wire format — metrics are positional on purpose:

            {"run":     {"id": ..., "name": ..., "meta": {...}},
             "metrics": [[step, wall, key, value], ...],
             "gpu":     [{...}, ...],
             "events":  [{...}, ...],
             "last_step": 123}

        `[[step, wall, key, value]]` rather than a list of objects because this
        is the high-volume field and the project's whole streaming design is
        built around a cellular link. The key names would otherwise be repeated
        once per scalar per step.
        """
        identity = (request.scope.get("state") or {}).get("identity")

        # The invariant, enforced where it can be read. AuthGuard has already
        # checked the telemetry:write scope; this is the separate and stricter
        # rule that a human session may never write a training record, no
        # matter what scopes it holds.
        if identity is not None and identity.kind == "human":
            raise HTTPException(
                403,
                "telemetry ingest requires a machine token; a browser session "
                "may not write training records",
            )

        run = payload.get("run") or {}
        run_id = str(run.get("id") or "").strip()
        if not run_id:
            raise HTTPException(422, "run.id is required")

        metrics = payload.get("metrics") or []
        gpu = payload.get("gpu") or []
        events = payload.get("events") or []
        if len(metrics) > MAX_METRICS:
            raise HTTPException(413, f"at most {MAX_METRICS} metric rows per batch")
        if len(gpu) > MAX_ROWS or len(events) > MAX_ROWS:
            raise HTTPException(413, f"at most {MAX_ROWS} gpu/event rows per batch")

        store = store_for()
        store.start_run(run_id, str(run.get("name") or run_id), run.get("meta") or {})

        # Group by step so the existing buffered path is reused rather than
        # reimplemented. Malformed rows are dropped with a count instead of
        # failing the batch: one bad scalar must not strand every good row
        # behind it forever, because the shipper would retry the same batch.
        by_step: dict[int, dict[str, float]] = {}
        dropped = 0
        for row in metrics:
            try:
                step, _wall, key, value = row
                by_step.setdefault(int(step), {})[str(key)] = float(value)
            except (TypeError, ValueError):
                dropped += 1
        for step, values in sorted(by_step.items()):
            store.log_metrics(run_id, step, values)

        # beat() before flush(), and this ordering is load-bearing: beat()
        # issues an UPDATE and does not commit -- it is written to be called
        # every step, with a later flush paying for the commit. Calling it
        # after the flush left last_step uncommitted, so the hub showed a live
        # run stuck at step 0 while metrics arrived normally, and the liveness
        # check read a progress counter that never moved.
        last_step = payload.get("last_step")
        if isinstance(last_step, int):
            store.beat(run_id, last_step)
        store.flush()

        if gpu:
            try:
                store.add_gpu_samples(gpu)
            except (TypeError, ValueError, KeyError):
                dropped += len(gpu)
                log.warning("dropped %d malformed gpu sample(s)", len(gpu))

        for event in events:
            try:
                store.add_event(
                    level=str(event.get("level") or "info"),
                    rule=str(event.get("rule") or "replicated"),
                    title=str(event.get("title") or ""),
                    body=str(event.get("body") or ""),
                    run_id=event.get("run_id") or run_id,
                    step=event.get("step"),
                    # Keep the sender's timestamp: it is half of the dedupe key.
                    ts=event.get("ts"),
                )
            except (TypeError, ValueError):
                dropped += 1

        if dropped:
            log.warning("batch for %s: dropped %d malformed row(s)", run_id, dropped)
        return {
            "ok": True,
            "run": run_id,
            "metrics": len(metrics) - dropped if dropped <= len(metrics) else 0,
            "gpu": len(gpu),
            "events": len(events),
            "dropped": dropped,
        }

    return router
