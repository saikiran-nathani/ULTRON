"""Write endpoints for the device hub: clipboard, files, links, notes, presence.

Every route here mutates state, which is why ADR-0003 exists. The guards live
in `trainwatch.security` as middleware rather than being repeated per route —
a control you have to remember to apply to each new endpoint is a control that
will be missing from the endpoint you add in six months.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import AsyncIterator, Callable
from typing import Annotated, Any

from fastapi import APIRouter, Body, File, Header, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from ..hub import Hub, device_kind_from_ua, guess_mime, looks_secret

log = logging.getLogger("trainwatch.server.hub")

# 64 MB. Large enough for a screenshot, a PDF or a checkpoint config; small
# enough that a mis-drop cannot fill the disk before you notice.
MAX_UPLOAD_BYTES = 64 * 1024 * 1024

# Types safe to render inline. SVG is deliberately absent: it is an XML document
# that can carry <script>, so serving it inline would hand an uploader script
# execution on the dashboard's own origin (ADR-0003 T3).
INLINE_MIME = frozenset(
    {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/heic"}
)

STREAM_POLL = 1.0
STREAM_KEEPALIVE = 20.0

# Module scope is load-bearing, not style. `from __future__ import annotations`
# makes every annotation a string, and FastAPI resolves those against the
# module's globals via get_type_hints. Defined inside build_hub_router() this
# name is invisible there, the Header() marker is silently discarded, and every
# write is attributed to "unknown" — with no error raised anywhere to tell you.
DeviceHeader = Annotated[str | None, Header(alias="X-Trainwatch-Device")]


def device_of(request: Request, name: str | None) -> str:
    """The calling device's label. Client-supplied, UA-derived as a fallback."""
    if name:
        return name.strip()[:48]
    return device_kind_from_ua(request.headers.get("user-agent", ""))


def build_hub_router(hub_for: Callable[[], Hub]) -> APIRouter:
    """`hub_for()` returns a thread-local Hub, mirroring the Store pool."""
    router = APIRouter(prefix="/api", tags=["hub"])

    def _touch(request: Request, device: str) -> None:
        hub_for().seen(
            device,
            kind=device_kind_from_ua(request.headers.get("user-agent", "")),
            user_agent=request.headers.get("user-agent", ""),
            address=request.client.host if request.client else "",
        )

    # ── snapshot ─────────────────────────────────────────────────────────

    def _snapshot(hub: Hub, device: str = "") -> dict[str, Any]:
        return {
            "revision": hub.revision(),
            "clips": hub.clips(limit=60),
            "files": hub.files(limit=60),
            "links": hub.links(limit=40, device=device),
            "notes": hub.notes(),
            "devices": hub.devices(),
            "stats": hub.stats(),
            "limits": {"max_upload": MAX_UPLOAD_BYTES},
        }

    @router.get("/hub")
    def get_hub(request: Request, x_device: DeviceHeader = None) -> dict[str, Any]:
        device = device_of(request, x_device)
        _touch(request, device)
        return _snapshot(hub_for(), device)

    @router.get("/hub/stream")
    async def hub_stream(request: Request, x_device: DeviceHeader = None) -> StreamingResponse:
        """Push only when the revision moves; keepalive otherwise.

        A clipboard has to feel instant, but re-sending the list every 2s would
        cost real cellular data for an idle tab. So: poll a single integer,
        ship a payload only when it changes.
        """
        device = device_of(request, x_device)

        async def gen() -> AsyncIterator[bytes]:
            yield b"retry: 3000\n\n"
            last_rev = -1
            last_beat = 0.0
            while True:
                if await request.is_disconnected():
                    return
                try:
                    # Resolve the thread-local Hub *inside* the worker thread.
                    # hub_for() called out here would run on the event loop
                    # thread, so every concurrent SSE client would be handed
                    # that one thread's connection — serialising all of them on
                    # a single sqlite handle and defeating the pool entirely.
                    # check_same_thread=False means this fails silently rather
                    # than raising, which is why it survived review.
                    rev = await asyncio.to_thread(lambda: hub_for().revision())
                    if rev != last_rev:
                        payload = await asyncio.to_thread(lambda: _snapshot(hub_for(), device))
                        last_rev = rev
                        yield f"event: hub\ndata: {json.dumps(payload, default=str)}\n\n".encode()
                        last_beat = 0.0
                    else:
                        last_beat += STREAM_POLL
                        if last_beat >= STREAM_KEEPALIVE:
                            last_beat = 0.0
                            yield b": keepalive\n\n"
                except Exception:
                    # One bad tick must not tear down a client's live connection.
                    log.exception("hub stream tick failed")
                    yield b": error\n\n"
                await asyncio.sleep(STREAM_POLL)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # ── clipboard ────────────────────────────────────────────────────────

    @router.post("/clip", status_code=201)
    def post_clip(
        request: Request,
        payload: Annotated[dict[str, Any], Body()],
        x_device: DeviceHeader = None,
    ) -> dict[str, Any]:
        body = str(payload.get("body") or "")
        if not body.strip():
            raise HTTPException(422, "empty clip")
        device = device_of(request, x_device)
        _touch(request, device)
        try:
            clip = hub_for().add_clip(
                body,
                kind="link" if payload.get("kind") == "link" else "text",
                device=device,
                secret=bool(payload.get("secret")),
                pinned=bool(payload.get("pinned")),
                ttl=_opt_float(payload.get("ttl")),
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
        return clip

    @router.get("/clip/latest")
    def get_latest(request: Request, x_device: DeviceHeader = None) -> dict[str, Any]:
        _touch(request, device_of(request, x_device))
        return hub_for().latest_clip() or {}

    @router.get("/clip/{clip_id}/body", response_class=Response)
    def get_clip_body(clip_id: int) -> Response:
        """Full text, including for secrets — the only route that reveals one.

        Served as text/plain so `curl .../body | pbcopy` works, and marked
        no-store so a revealed secret is not left in a disk cache.
        """
        body = hub_for().clip_body(clip_id)
        if body is None:
            raise HTTPException(404, "no such clip (or it expired)")
        return Response(
            content=body,
            media_type="text/plain; charset=utf-8",
            headers={"Cache-Control": "no-store"},
        )

    @router.post("/clip/{clip_id}/pin")
    def pin_clip(clip_id: int, pinned: bool = Query(default=True)) -> dict[str, Any]:
        if not hub_for().pin_clip(clip_id, pinned):
            raise HTTPException(404, "no such clip")
        return {"id": clip_id, "pinned": pinned}

    @router.delete("/clip/{clip_id}", status_code=204)
    def delete_clip(clip_id: int) -> Response:
        if not hub_for().delete_clip(clip_id):
            raise HTTPException(404, "no such clip")
        return Response(status_code=204)

    @router.post("/clips/clear")
    def clear_clips(keep_pinned: bool = Query(default=True)) -> dict[str, int]:
        return {"deleted": hub_for().clear_clips(keep_pinned=keep_pinned)}

    @router.post("/clips/inspect")
    def inspect_clip(payload: Annotated[dict[str, Any], Body()]) -> dict[str, bool]:
        """Does this text look like a credential? Advisory, for the UI's nudge.

        Runs server-side so the pattern list has one home, and returns only a
        boolean — the text is neither stored nor logged.
        """
        return {"looks_secret": looks_secret(str(payload.get("body") or ""))}

    # ── files ────────────────────────────────────────────────────────────

    @router.post("/files", status_code=201)
    async def upload_file(
        request: Request,
        file: Annotated[UploadFile, File()],
        x_device: DeviceHeader = None,
    ) -> dict[str, Any]:
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > MAX_UPLOAD_BYTES * 1.1:
            raise HTTPException(413, f"upload exceeds {MAX_UPLOAD_BYTES} bytes")

        # Stream chunks straight to disk under a reserved id, aborting past the
        # cap rather than trusting content-length (which a client may lie
        # about). Buffering into a list and then b"".join()-ing it held the
        # whole body in memory twice — a 128 MB peak per concurrent upload, on
        # a box that is simultaneously training.
        hub = hub_for()
        file_id = hub.new_blob_id()
        target = hub.blob_target(file_id)
        total = 0
        try:
            with target.open("wb") as out:
                while chunk := await file.read(1024 * 256):
                    total += len(chunk)
                    if total > MAX_UPLOAD_BYTES:
                        raise HTTPException(413, f"upload exceeds {MAX_UPLOAD_BYTES} bytes")
                    out.write(chunk)
            if total == 0:
                raise HTTPException(422, "empty upload")
        except BaseException:
            # Never leave a partial blob behind: it has no DB row, so nothing
            # would ever expire it and the reaper cannot see it.
            target.unlink(missing_ok=True)
            raise

        name = file.filename or "untitled"
        device = device_of(request, x_device)
        mime = file.content_type or guess_mime(name)

        # This is the only async route that touches the database. Every other
        # hub route is `def`, so FastAPI runs it in the threadpool; here the
        # writes would land on the event loop and stall every other client.
        def _commit_upload() -> dict[str, Any]:
            _touch(request, device)
            return hub_for().register_file(file_id, name, total, mime=mime, device=device)

        return await asyncio.to_thread(_commit_upload)

    @router.get("/files/{file_id}/raw")
    def download_file(file_id: str, download: bool = Query(default=False)) -> FileResponse:
        hub = hub_for()
        meta = hub.file(file_id)
        path = hub.file_path(file_id)
        if meta is None or path is None:
            raise HTTPException(404, "no such file (or it expired)")

        mime = str(meta["mime"])
        inline = (not download) and mime in INLINE_MIME
        # Anything not on the inline allowlist is forced to download, so an
        # uploaded .html or .svg can never execute on this origin.
        disposition = "inline" if inline else "attachment"
        return FileResponse(
            path,
            media_type=mime if inline else "application/octet-stream",
            headers={
                "Content-Disposition": f'{disposition}; filename="{_ascii_name(meta["name"])}"',
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "private, max-age=300",
            },
        )

    @router.post("/files/{file_id}/pin")
    def pin_file(file_id: str, pinned: bool = Query(default=True)) -> dict[str, Any]:
        if not hub_for().pin_file(file_id, pinned):
            raise HTTPException(404, "no such file")
        return {"id": file_id, "pinned": pinned}

    @router.delete("/files/{file_id}", status_code=204)
    def delete_file(file_id: str) -> Response:
        if not hub_for().delete_file(file_id):
            raise HTTPException(404, "no such file")
        return Response(status_code=204)

    # ── links ────────────────────────────────────────────────────────────

    @router.post("/links", status_code=201)
    def post_link(
        request: Request,
        payload: Annotated[dict[str, Any], Body()],
        x_device: DeviceHeader = None,
    ) -> dict[str, Any]:
        device = device_of(request, x_device)
        _touch(request, device)
        try:
            return hub_for().add_link(
                str(payload.get("url") or ""),
                title=str(payload.get("title") or "")[:300],
                target=str(payload.get("target") or "")[:48],
                device=device,
            )
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc

    @router.post("/links/{link_id}/opened")
    def open_link(link_id: int) -> dict[str, Any]:
        return {"id": link_id, "opened": hub_for().mark_link_opened(link_id)}

    @router.delete("/links/{link_id}", status_code=204)
    def delete_link(link_id: int) -> Response:
        if not hub_for().delete_link(link_id):
            raise HTTPException(404, "no such link")
        return Response(status_code=204)

    # ── notes ────────────────────────────────────────────────────────────

    @router.put("/notes/{note_id}")
    def put_note(
        request: Request,
        note_id: str,
        payload: Annotated[dict[str, Any], Body()],
        x_device: DeviceHeader = None,
    ) -> dict[str, Any]:
        device = device_of(request, x_device)
        _touch(request, device)
        return hub_for().put_note(
            note_id,
            title=str(payload.get("title") or "")[:200],
            body=str(payload.get("body") or ""),
            device=device,
        )

    @router.get("/notes/{note_id}")
    def get_note(note_id: str) -> dict[str, Any]:
        note = hub_for().note(note_id)
        if note is None:
            raise HTTPException(404, "no such note")
        return note

    @router.delete("/notes/{note_id}", status_code=204)
    def delete_note(note_id: str) -> Response:
        if not hub_for().delete_note(note_id):
            raise HTTPException(404, "no such note")
        return Response(status_code=204)

    # ── maintenance ──────────────────────────────────────────────────────

    @router.post("/hub/purge")
    def purge() -> JSONResponse:
        return JSONResponse(hub_for().purge_expired())

    return router


def _opt_float(value: Any) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _ascii_name(name: str) -> str:
    """Content-Disposition is a latin-1 header; an emoji filename breaks it."""
    return str(name).encode("ascii", "replace").decode("ascii").replace('"', "_")
