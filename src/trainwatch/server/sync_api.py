"""HTTP for per-record sync: one round trip, plus the device list.

The guards are already middleware — `SecurityGuard` (ADR-0003: Host, Origin,
the `X-Trainwatch` header on writes) then `AuthGuard` (ADR-0004: identity,
CSRF, scope). Nothing here re-implements any of them, for the reason stated in
`hub_api.py`: a control you have to remember to apply per route is a control
that will be missing from the route you add in six months.

Two decisions in here are load-bearing.

**`owner_id` comes from the authenticated identity, never from the request.**
It is the partition key for everything in `sync_records`. Taking it from a body
field would mean any authenticated client could read and overwrite any other
owner's dataset by changing one integer.

**Sync requires an identity even when global enforcement is off**, which is the
one place this service deviates from ADR-0003's "open on the tailnet" posture,
and it is to avoid a trap that springs on success.

With no accounts enrolled, `AuthGuard` lets every request through and there is
no identity — so sync would have to invent an owner, say 0. Records would
accumulate under it, and then the day you ran `trainwatch user add` — a
correct, desirable action — your real `owner_id` would be 1 and **every synced
record would vanish from the app**. Not deleted; filed under an owner nobody
authenticates as. Refusing with a clear message costs one round trip on a box
with no accounts and removes a silent whole-dataset loss triggered by doing the
right thing.

Machine tokens are refused too. `api_tokens` has no `user_id` column, so a
token genuinely has no owner — it is the trainer posting telemetry, not a
person's device. Attributing personal records to it would be a guess.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Body, HTTPException, Path, Query, Request
from fastapi.responses import StreamingResponse

from ..auth import Identity
from ..sync import Change, Sync, SyncError

log = logging.getLogger("trainwatch.server.sync")

# Matching hub_api.py. One second is well inside "feels live" for a tick that
# reads a single integer, and 20s of silence is short enough that a proxy or a
# dozing phone does not decide the connection is dead.
STREAM_POLL = 1.0
STREAM_KEEPALIVE = 20.0

# Module scope, not inside the factory: `from __future__ import annotations`
# makes every annotation a string and FastAPI resolves those against module
# globals. See the same note in hub_api.py.
ChangesBody = Annotated[list[dict[str, Any]] | None, Body(embed=True)]


def _owner(request: Request) -> int:
    """The authenticated owner's id, or a refusal that explains itself."""
    identity: Identity | None = (request.scope.get("state") or {}).get("identity")

    if identity is None:
        raise HTTPException(
            status_code=401,
            detail={
                "error": "sync needs an account",
                "why": (
                    "Records are stored per owner, and with no account there is no "
                    "owner to file them under. Filing them under a placeholder would "
                    "hide every one of them the moment you create a real account."
                ),
                "fix": "trainwatch user add <name>",
            },
        )

    if identity.kind != "human":
        raise HTTPException(
            status_code=403,
            detail={
                "error": "sync is for human identities",
                "why": (
                    "A machine token has no owner — it is the trainer posting "
                    "telemetry, not somebody's device. Attributing personal records "
                    "to it would be a guess."
                ),
            },
        )

    try:
        return int(identity.id)
    except ValueError as exc:  # pragma: no cover - human ids are users.id
        raise HTTPException(status_code=500, detail="identity has no numeric owner id") from exc


def build_sync_router(sync_for: Callable[[], Sync]) -> APIRouter:
    """`sync_for()` returns a thread-local Sync, mirroring the Store pool."""
    router = APIRouter(prefix="/api/sync", tags=["sync"])

    @router.post("")
    async def do_sync(
        request: Request,
        device: Annotated[str, Query(min_length=1, max_length=128)],
        since: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=2000)] = 2000,
        changes: ChangesBody = None,
        name: Annotated[str, Query(max_length=128)] = "",
        platform: Annotated[str, Query(max_length=128)] = "",
    ) -> dict[str, Any]:
        """Push then pull, in that order. The whole client protocol.

        `since` is the client's own cursor and the client is authoritative for
        it: if this response is lost, the client never advanced and asks from
        the same place again. The server records it only to learn what that
        device definitely holds, which is what bounds tombstone GC.
        """
        owner = _owner(request)
        s = sync_for()

        try:
            parsed, unstorable = Change.parse_batch(changes or [])
        except SyncError as exc:
            # 422, not 400: the request was understood and is unprocessable.
            # Distinguishable from a rejected write, which is a normal 200.
            #
            # Only reached when nothing identifies the offending record, which
            # means a client bug rather than a data problem. Anything nameable
            # comes back in `quarantined` with a 200, so one unstorable record
            # cannot stop the device from syncing the rest — see Quarantine.
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        s.register(owner, device, name=name, platform=platform)

        try:
            result = s.sync(owner, device, changes=parsed, since_seq=since, limit=limit)
        except SyncError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        if unstorable:
            result["quarantined"] = [
                *result.get("quarantined", []),
                *({"collection": q.collection, "id": q.record_id, "reason": q.reason} for q in unstorable),
            ]

        if result["quarantined"]:
            # Louder than a rejection, because a rejection is the protocol
            # working and this is a record that will never sync until someone
            # changes the data.
            log.warning(
                "sync: device=%s quarantined=%s",
                device,
                [f"{q['collection']}/{q['id']}: {q['reason']}" for q in result["quarantined"]],
            )

        if result["rejected"]:
            # Worth a log line: a rejection is normal, but a burst of them is
            # a device with a wrong clock or a client that is not applying the
            # winners it is handed.
            log.info(
                "sync: device=%s accepted=%d rejected=%d",
                device,
                len(result["accepted"]),
                len(result["rejected"]),
            )
        return result

    @router.get("/state")
    async def state(request: Request) -> dict[str, Any]:
        """Devices and counts. What a "manage devices" screen renders."""
        owner = _owner(request)
        s = sync_for()
        return {
            "devices": [d.to_json() for d in s.devices(owner)],
            "stats": s.stats(owner),
        }

    @router.post("/devices/{device_id}/retire")
    async def retire(
        request: Request,
        device_id: Annotated[str, Path(min_length=1, max_length=128)],
    ) -> dict[str, Any]:
        """Retire a device so it stops holding the tombstone watermark down.

        Not a delete. The row stays, so the device's history remains readable
        and so a device that comes back is un-retired rather than re-created
        with a cursor of zero — which would make it pin the watermark at 0 all
        over again.
        """
        owner = _owner(request)
        changed = sync_for().retire(owner, device_id)
        return {"retired": changed, "device": device_id}

    @router.get("/history")
    async def history(
        request: Request,
        # Query parameters, not path segments, and that is not a style choice.
        #
        # A record id is opaque data now: Stage 3b keys a nested record as
        # `encodeURIComponent(parentId):encodeURIComponent(childId)`, so the id
        # genuinely contains percent-escapes. A path segment cannot carry them
        # — this stack decodes the path before routing, so `%3A` arrives as
        # `:` however many times the client escapes it, and the server then
        # looks up an id that exists nowhere. The reply is a 200 with an empty
        # version list, which reads as "this record has no conflict history"
        # rather than as a bug. A query parameter round-trips exactly.
        collection: Annotated[str, Query(min_length=1, max_length=128)],
        record_id: Annotated[str, Query(min_length=1, max_length=512, alias="id")],
        limit: Annotated[int, Query(ge=1, le=200)] = 50,
    ) -> dict[str, Any]:
        """Every version of one record, winners and losers.

        The conflict archive, over HTTP. This is what turns "your edit was
        silently overwritten" into "replaced by MacBook-Pro at 14:02 — view /
        restore", and it is why it is safe to live on slice-level granularity
        while per-record granularity is still being built.
        """
        owner = _owner(request)
        return {
            "collection": collection,
            "id": record_id,
            "versions": sync_for().history(owner, collection, record_id, limit=limit),
        }

    @router.get("/events")
    async def events(request: Request) -> StreamingResponse:
        """Tell devices that something moved. Never send them the records.

        The nudge carries one number — the owner's `seq` head — and nothing
        else. That restraint is the whole design, and it follows from rule 2:

        > `hlc` decides who wins, server-assigned `seq` decides what you still
        > need.

        A stream that pushed the records themselves would be a second delivery
        path with its own ordering, racing the pull. The client's cursor may
        only advance to a `seq` it has actually acknowledged, so a record
        arriving out of band would either be applied without moving the cursor
        (re-delivered forever on the next pull) or move the cursor past records
        it never received (lost forever, silently). Sending a number and
        letting the client pull keeps one ordered path to the data.

        It also means **the stream is an optimisation and never the source of
        truth.** A missed event costs latency, not correctness: the client is
        still on its own timer, and its cursor is still the server's. So there
        is no `Last-Event-ID` replay to get wrong, and a phone that spends the
        night with its radio off wakes up and pulls exactly as it would have.
        """
        # Resolved out here, before the response starts. Inside the generator a
        # 401 would arrive after `http.response.start` had already gone out —
        # the browser would see a 200 stream that closes immediately, and
        # `EventSource` would reconnect in a loop against a server that will
        # never let it in.
        owner = _owner(request)

        async def gen() -> AsyncIterator[bytes]:
            # Sent first, unconditionally: it proves the route body ran, and it
            # sets the browser's reconnect delay before anything can go wrong.
            yield b"retry: 3000\n\n"
            last = -1
            quiet = 0.0
            while True:
                if await request.is_disconnected():
                    return
                try:
                    # `sync_for()` resolved INSIDE the worker thread. Called on
                    # the event loop thread it would hand every concurrent
                    # stream that one thread's SQLite connection, serialising
                    # all of them on a single handle and defeating the pool.
                    # `check_same_thread=False` makes that fail silently rather
                    # than raise, which is how it survives review. See the same
                    # note in hub_api.py, where it was found the hard way.
                    head = await asyncio.to_thread(lambda: sync_for().head(owner))
                    if head != last:
                        # Fires on the first tick too, not only on a change: a
                        # client that connects *after* a write must not have to
                        # wait for the next one to learn it is behind.
                        last = head
                        yield f"event: sync\ndata: {json.dumps({'head': head})}\n\n".encode()
                        quiet = 0.0
                    else:
                        quiet += STREAM_POLL
                        if quiet >= STREAM_KEEPALIVE:
                            quiet = 0.0
                            yield b": keepalive\n\n"
                except Exception:
                    # One bad tick must not tear down a live connection.
                    log.exception("sync stream tick failed")
                    yield b": error\n\n"
                await asyncio.sleep(STREAM_POLL)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                # nginx and friends buffer streaming responses by default,
                # which turns a live push into a push that arrives in batches
                # whenever the buffer fills.
                "X-Accel-Buffering": "no",
            },
        )

    return router
