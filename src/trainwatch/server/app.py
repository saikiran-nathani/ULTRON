"""JSON API + static host for the dashboard.

Two halves that share a SQLite file and nothing else:

  * **Training telemetry** — read-only. The trainer writes, this only reads.
  * **The device hub** — read/write. Shared clipboard, files, links, notes.

The hub's write endpoints are why `trainwatch.security` exists. This service
was read-only by design until ADR-0003; adding writes to an unauthenticated
private-IP port makes *the browser* the threat model, not the tailnet, because
any page open in Safari can reach `http://100.x.y.z:8730` as easily as the
dashboard can. Read ADR-0003 before adding an endpoint here.

Connection handling: SQLite connections are not safely shared across threads,
and FastAPI runs sync work in a threadpool, so every worker thread gets its own
`Store`/`Hub` via thread-local storage. Opening a SQLite connection is ~100µs,
so this costs nothing and removes a whole class of `ProgrammingError`.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import shutil
import socket
import subprocess
import threading
import time
import weakref
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .. import __version__
from ..auth import Auth
from ..config import Config, load_config
from ..gpu import GpuSampler, throttle_is_significant
from ..heartbeat import read_heartbeat
from ..hub import Hub
from ..security import SecurityGuard, resolve_allowed_hosts
from ..store import Store
from ..sync import Sync
from .auth_api import AuthGuard, build_auth_router
from .hub_api import build_hub_router
from .sync_api import build_sync_router
from .telemetry_api import build_telemetry_router

log = logging.getLogger("trainwatch.server")

STATIC_DIR = Path(__file__).parent / "static"

# The scalars the dashboard's hero row always wants, in display order.
HEADLINE_KEYS = ("loss", "grad_norm", "lr", "entropy", "step_time")

# Cap on how many series one request may ask for. The client chunks around it;
# anything over is reported back in `dropped` rather than vanishing.
MAX_SERIES_KEYS = 64

# How often the SSE stream checks for changes.
STREAM_INTERVAL = 2.0

# Force a full snapshot at least this often even when nothing in the database
# has moved. Heartbeat age and the "stale" verdict derived from it advance with
# wall-clock time, not with writes, so a purely change-gated stream would show
# a run that died five minutes ago as healthy. 15s keeps that honest while
# still cutting an idle tab from 30 pushes a minute to 4.
STREAM_MAX_IDLE = 15.0


class StorePool:
    """One SQLite connection per thread.

    `_all` is a WeakSet, and that is a bug fix rather than a style choice.

    It was a list, so it held a strong reference to every connection ever
    created. Worker threads are not permanent — anyio retires idle ones — so
    each new thread opened a fresh connection that could then never be
    collected, because the list still pointed at it. Each SQLite connection is
    three file descriptors (db, -wal, -shm).

    The hub died after 6h30m with `OSError: [Errno 24] Too many open files`,
    245 of its 269 descriptors pointing at `trainwatch.db`. It kept running and
    kept listening; it just could not allocate a descriptor for an accepted
    socket, so every request was reset. launchd reported it healthy throughout,
    and a heartbeat would have too — "up but serving nothing" is invisible to
    anything that only asks whether the process exists.

    Two things made it land when it did rather than in a year:

    * a supervised job's `maxfiles` is **256**, not the 1,048,576 an
      interactive shell gets. Another instance of "a supervised unit inherits
      almost nothing" — this time the resource limits.
    * nothing was watching from outside.

    With a WeakSet, a retired thread's `threading.local` slot is the last
    reference; it drops, the object is collected, and sqlite3 closes the files
    in its deallocator. `close_all()` still closes whatever is alive at
    shutdown, which is all it was ever for.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._all: weakref.WeakSet[Store] = weakref.WeakSet()
        self._lock = threading.Lock()

    def get(self) -> Store:
        store: Store | None = getattr(self._local, "store", None)
        if store is None:
            store = Store(self._path)
            self._local.store = store
            with self._lock:
                self._all.add(store)
        return store

    def close_all(self) -> None:
        with self._lock:
            # list() first: iterating a WeakSet while objects are being collected
            # raises RuntimeError, and shutdown is exactly when that happens.
            for store in list(self._all):
                try:
                    store.close()
                except Exception:
                    log.debug("closing pooled store failed", exc_info=True)
            self._all.clear()


class AuthPool:
    """One Auth (and therefore one SQLite connection) per worker thread.

    `_all` is a WeakSet for the reason spelled out on `StorePool`: as a list it
    leaked a connection per retired worker thread until the process ran out of
    file descriptors.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._all: weakref.WeakSet[Auth] = weakref.WeakSet()
        self._lock = threading.Lock()

    def get(self) -> Auth:
        auth: Auth | None = getattr(self._local, "auth", None)
        if auth is None:
            auth = Auth(self._path)
            self._local.auth = auth
            with self._lock:
                self._all.add(auth)
        return auth

    def close_all(self) -> None:
        with self._lock:
            # list() first: iterating a WeakSet while objects are being collected
            # raises RuntimeError, and shutdown is exactly when that happens.
            for auth in list(self._all):
                try:
                    auth.close()
                except Exception:
                    log.debug("closing pooled auth failed", exc_info=True)
            self._all.clear()


class SyncPool:
    """One Sync (and therefore one SQLite connection) per worker thread.

    `_all` is a WeakSet for the reason spelled out on `StorePool`: as a list it
    leaked a connection per retired worker thread until the process ran out of
    file descriptors.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._local = threading.local()
        self._all: weakref.WeakSet[Sync] = weakref.WeakSet()
        self._lock = threading.Lock()

    def get(self) -> Sync:
        sync: Sync | None = getattr(self._local, "sync", None)
        if sync is None:
            sync = Sync(self._path)
            self._local.sync = sync
            with self._lock:
                self._all.add(sync)
        return sync

    def close_all(self) -> None:
        with self._lock:
            # list() first: iterating a WeakSet while objects are being collected
            # raises RuntimeError, and shutdown is exactly when that happens.
            for sync in list(self._all):
                try:
                    sync.close()
                except Exception:
                    log.debug("closing pooled sync failed", exc_info=True)
            self._all.clear()


class HubPool:
    """One Hub (and therefore one SQLite connection) per worker thread.

    `_all` is a WeakSet for the reason spelled out on `StorePool`: as a list it
    leaked a connection per retired worker thread until the process ran out of
    file descriptors.
    """

    def __init__(self, path: Path, blob_dir: Path) -> None:
        self._path = path
        self._blob_dir = blob_dir
        self._local = threading.local()
        self._all: weakref.WeakSet[Hub] = weakref.WeakSet()
        self._lock = threading.Lock()

    def get(self) -> Hub:
        hub: Hub | None = getattr(self._local, "hub", None)
        if hub is None:
            hub = Hub(self._path, self._blob_dir)
            self._local.hub = hub
            with self._lock:
                self._all.add(hub)
        return hub

    def close_all(self) -> None:
        with self._lock:
            # list() first: iterating a WeakSet while objects are being collected
            # raises RuntimeError, and shutdown is exactly when that happens.
            for hub in list(self._all):
                try:
                    hub.close()
                except Exception:
                    # A hub we cannot close is not worth failing shutdown over.
                    log.debug("closing pooled hub failed", exc_info=True)
            self._all.clear()


def create_app(config: Config | None = None) -> FastAPI:
    cfg = config or load_config()
    pool = StorePool(cfg.db_path)
    hub_pool = HubPool(cfg.db_path, cfg.blob_dir)
    auth_pool = AuthPool(cfg.db_path)
    sync_pool = SyncPool(cfg.db_path)
    sampler = GpuSampler(Store(cfg.db_path), interval=5.0)
    allowed_hosts = resolve_allowed_hosts(cfg.allowed_hosts)

    @asynccontextmanager
    async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
        sampler.start()

        # Signalled instead of cancelled. asyncio.to_thread hands work to a
        # thread that cannot be interrupted: cancelling the task unblocks the
        # coroutine while the worker keeps running its query, and close_all()
        # then frees the sqlite connection underneath it. That is a
        # use-after-free, and on CPython it segfaults inside the statement
        # cache rather than raising anything catchable.
        stopping = asyncio.Event()

        async def reaper() -> None:
            # TTLs are only real if something actually enforces them. Hourly is
            # plenty: expiry is already honoured on read, this just reclaims disk.
            while True:
                # Wait FIRST. A short-lived app — which is every test — should
                # never start DB work it then has to be shut down around.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stopping.wait(), timeout=3600)
                if stopping.is_set():
                    return
                try:
                    # get() inside the lambda so the pool lookup happens on the
                    # worker thread, not the event loop's.
                    counts = await asyncio.to_thread(lambda: hub_pool.get().purge_expired())
                    if any(counts.values()):
                        log.info("purged expired hub items: %s", counts)
                    # Telemetry needs a reaper too. Without this, `prune` is
                    # reachable only by remembering to run the CLI, so metrics
                    # grow without bound — a 100k-step run is ~500k rows, and
                    # the GPU sampler alone adds ~17k rows a day.
                    if cfg.keep_days > 0:
                        dropped = await asyncio.to_thread(
                            lambda: pool.get().prune(keep_days=cfg.keep_days)
                        )
                        if dropped:
                            log.info(
                                "pruned %d telemetry rows older than %.0fd",
                                dropped,
                                cfg.keep_days,
                            )
                except Exception:
                    # The reaper must never die: it is the only thing enforcing TTLs.
                    log.exception("purge failed")

        reaper_task = asyncio.create_task(reaper())
        log.info(
            "trainwatch server ready · db=%s · hub writes %s",
            cfg.db_path,
            "token-protected" if cfg.token else "open on the tailnet",
        )
        try:
            yield
        finally:
            # Let the reaper finish any in-flight query before the connections
            # it is using are closed. Bounded, because a hung query must not
            # wedge shutdown for ever.
            stopping.set()
            with contextlib.suppress(TimeoutError, asyncio.CancelledError):
                await asyncio.wait_for(asyncio.shield(reaper_task), timeout=15)
            sampler.stop()
            pool.close_all()
            hub_pool.close_all()
            auth_pool.close_all()
            sync_pool.close_all()

    app = FastAPI(
        title="trainwatch",
        version=__version__,
        summary="Remote training monitoring + a private device hub.",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
    )

    # ── middleware order is load-bearing ────────────────────────────────
    # Starlette's add_middleware inserts at position 0, so the LAST one added
    # is the OUTERMOST. SecurityGuard has to be outermost: ADR-0003's Host
    # allowlist is what stops DNS rebinding, and it must reject a request
    # before AuthGuard opens a database connection on its behalf. So AuthGuard
    # is registered first and SecurityGuard second. test_auth_http asserts the
    # resulting precedence rather than trusting this comment.
    #
    # ADR-0004 C7/C8/C10/C12. Self-activating: a no-op until a user exists.
    app.add_middleware(
        AuthGuard,
        auth_factory=auth_pool.get,
        require=cfg.require_auth,
    )

    # The dashboard is writable now, so the browser is the threat model — not
    # the tailnet. See ADR-0003; this one line is what closes DNS rebinding.
    app.add_middleware(
        SecurityGuard,
        allowed_hosts=allowed_hosts,
        token=cfg.token,
    )

    app.include_router(build_auth_router(auth_pool.get))
    app.include_router(build_telemetry_router(pool.get))

    # ── snapshot assembly ────────────────────────────────────────────────

    def _snapshot(run_id: str | None = None) -> dict[str, Any]:
        """Everything the dashboard's main screen needs, in one query pass."""
        store = pool.get()
        run = store.run(run_id) if run_id else store.latest_run()
        now = time.time()

        payload: dict[str, Any] = {
            "now": now,
            "version": __version__,
            "run": run,
            "runs": store.runs(limit=25),
            "events": store.events(limit=40),
            "gpu": store.gpu_latest(),
            "heartbeat": None,
            "status": "no-run",
            # Whether layer 3 is actually armed. Without this the dashboard
            # cannot tell "the rate limiter deduped a repeat" (healthy) from
            # "no ntfy topic is configured, nothing has ever reached your
            # phone" (the failure the guide lists last, and the easiest to
            # not notice, because its symptom is silence).
            "notify": {
                "enabled": cfg.notify_enabled,
                "server": cfg.ntfy_server if cfg.notify_enabled else "",
            },
        }

        hb = read_heartbeat(cfg.heartbeat_path)
        beat_ts = max(
            [t for t in (hb["ts"] if hb else None, run.get("last_beat") if run else None) if t],
            default=None,
        )
        if beat_ts is not None:
            payload["heartbeat"] = {
                "ts": beat_ts,
                "age": max(0.0, now - beat_ts),
                "timeout": cfg.heartbeat_timeout,
            }

        if run:
            keys = store.metric_keys(str(run["id"]))
            payload["metric_keys"] = keys
            payload["headline"] = store.latest_values(
                str(run["id"]), [k for k in HEADLINE_KEYS if k in keys]
            )
            payload["status"] = _verdict(run, payload["heartbeat"], payload["gpu"])
        else:
            payload["metric_keys"] = []
            payload["headline"] = {}

        payload["throttled"] = any(
            throttle_is_significant(str(g.get("throttle") or "")) for g in payload["gpu"]
        )
        return payload

    def _verdict(
        run: dict[str, Any], heartbeat: dict[str, Any] | None, gpus: list[dict[str, Any]]
    ) -> str:
        """The single word at the top of the screen. Worst state wins."""
        status = str(run["status"])
        if status in ("failed", "dead"):
            return status
        if status != "running":
            return "finished" if status == "finished" else status
        if heartbeat and heartbeat["age"] > cfg.heartbeat_timeout:
            return "stale"
        if any(throttle_is_significant(str(g.get("throttle") or "")) for g in gpus):
            return "throttled"
        return "healthy"

    # ── API ──────────────────────────────────────────────────────────────

    @app.get("/healthz")
    def healthz() -> dict[str, Any]:
        return {"ok": True, "version": __version__, "db": str(cfg.db_path)}

    @app.get("/api/state")
    def api_state(run_id: str | None = Query(default=None)) -> dict[str, Any]:
        return _snapshot(run_id)

    @app.get("/api/runs")
    def api_runs(limit: int = Query(default=50, ge=1, le=500)) -> list[dict[str, Any]]:
        return pool.get().runs(limit=limit)

    @app.get("/api/runs/{run_id}")
    def api_run(run_id: str) -> dict[str, Any]:
        run = pool.get().run(run_id)
        if run is None:
            raise HTTPException(status_code=404, detail=f"no run {run_id!r}")
        run["metric_keys"] = pool.get().metric_keys(run_id)
        return run

    @app.get("/api/runs/{run_id}/series")
    def api_series(
        run_id: str,
        keys: str = Query(description="comma-separated metric keys"),
        points: int = Query(default=240, ge=8, le=2000),
        since_step: int = Query(default=-1),
    ) -> dict[str, Any]:
        store = pool.get()
        if store.run(run_id) is None:
            raise HTTPException(status_code=404, detail=f"no run {run_id!r}")
        requested = [k.strip() for k in keys.split(",") if k.strip()]
        wanted = requested[:MAX_SERIES_KEYS]
        return {
            "run_id": run_id,
            "points": points,
            "series": store.series(run_id, wanted, points=points, since_step=since_step),
            # Report what was cut. Silently returning fewer series than asked
            # for makes a truncated key indistinguishable from one that logged
            # nothing — and because metric_keys sorts lexicographically
            # (layer_1, layer_10, layer_2 …) the casualties look like an
            # arbitrary scatter rather than a clean tail.
            "dropped": requested[MAX_SERIES_KEYS:],
            "max_keys": MAX_SERIES_KEYS,
        }

    @app.get("/api/runs/{run_id}/groups")
    def api_groups(run_id: str) -> dict[str, list[str]]:
        """Metric keys bucketed by slash-prefix — `resid_rms/*`, `attn_logit_max/*`…

        This is why the source guide insists on structured keys: the grouping is
        derivable, so per-layer series lay themselves out without configuration.
        """
        groups: dict[str, list[str]] = {}
        for key in pool.get().metric_keys(run_id):
            prefix, _, _ = key.partition("/")
            groups.setdefault(prefix if _ else "scalars", []).append(key)
        return groups

    @app.get("/api/events")
    def api_events(
        limit: int = Query(default=100, ge=1, le=1000),
        run_id: str | None = Query(default=None),
    ) -> list[dict[str, Any]]:
        return pool.get().events(limit=limit, run_id=run_id)

    @app.get("/api/gpu")
    def api_gpu(
        seconds: float = Query(default=1800, ge=60, le=86400),
        points: int = Query(default=180, ge=8, le=1000),
    ) -> dict[str, Any]:
        store = pool.get()
        return {
            "latest": store.gpu_latest(),
            "history": store.gpu_history(seconds=seconds, points=points),
        }

    @app.get("/api/system")
    def api_system() -> dict[str, Any]:
        """Box-level context: tmux sessions, tailnet address, uptime."""
        return {
            "hostname": _short_hostname(),
            "tmux": _tmux_sessions(),
            "tailscale": _tailscale_ips(),
            "wsl": _is_wsl(),
            "heartbeat_path": str(cfg.heartbeat_path),
            "db_size": cfg.db_path.stat().st_size if cfg.db_path.exists() else 0,
            "security": {
                "allowed_hosts": sorted(allowed_hosts),
                "token_required": bool(cfg.token),
                "guard_rejections": getattr(app.state, "guard_rejections", 0),
            },
            "hub": hub_pool.get().stats(),
            "gpu_sampler": {
                "available": sampler.available,
                "samples": sampler.samples_written,
                "error": sampler.last_error,
            },
        }

    @app.get("/api/stream")
    async def api_stream(request: Request, run_id: str | None = None) -> StreamingResponse:
        """Server-sent events. The iPad reconnects automatically after sleep."""

        async def gen() -> AsyncIterator[bytes]:
            # Tell EventSource to back off to 5s between reconnects.
            yield b"retry: 5000\n\n"
            last_mark: tuple[int, ...] | None = None
            since_push = 0.0
            while True:
                if await request.is_disconnected():
                    return
                try:
                    # Poll a cheap change token and ship the payload only when
                    # it moves — the same trick /api/hub/stream already uses.
                    # An idle tab drops from 30 full snapshots a minute to 4.
                    mark = await asyncio.to_thread(lambda: pool.get().watermark())
                    stale = since_push >= STREAM_MAX_IDLE

                    if mark != last_mark or stale:
                        payload = await asyncio.to_thread(_snapshot, run_id)
                        last_mark = mark
                        since_push = 0.0
                        yield (
                            f"event: state\ndata: {json.dumps(payload, default=str)}\n\n"
                        ).encode()
                    else:
                        # The forced push above is not just a keepalive. Part of
                        # the snapshot is time-derived: heartbeat age, and the
                        # "stale" verdict computed from it. Those change while
                        # the database does *not* — a run going silent is
                        # precisely the case where nothing new is written — so
                        # pure change-gating would leave a dead run displayed as
                        # healthy forever.
                        since_push += STREAM_INTERVAL
                        yield b": keepalive\n\n"
                except Exception:
                    log.exception("stream tick failed")
                    yield b": error\n\n"
                await asyncio.sleep(STREAM_INTERVAL)

        return StreamingResponse(
            gen(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    # Registered before the SPA catch-all below: route order decides, and
    # `/{full_path:path}` would otherwise match every /api/... write.
    app.include_router(build_hub_router(hub_pool.get))
    app.include_router(build_sync_router(sync_pool.get))

    # ── static dashboard ─────────────────────────────────────────────────

    index = STATIC_DIR / "index.html"
    if index.is_file():
        app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

        @app.get("/manifest.webmanifest", include_in_schema=False)
        def manifest() -> FileResponse:
            return FileResponse(STATIC_DIR / "manifest.webmanifest")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str) -> FileResponse:
            # Any non-API path serves the SPA shell; client-side routing does
            # the rest. Static files that exist are served directly.
            candidate = (STATIC_DIR / full_path).resolve()
            if full_path and candidate.is_file() and candidate.is_relative_to(STATIC_DIR.resolve()):
                return FileResponse(candidate)
            return FileResponse(index)
    else:

        @app.get("/", include_in_schema=False)
        def no_bundle() -> JSONResponse:
            return JSONResponse(
                status_code=503,
                content={
                    "error": "dashboard bundle not built",
                    "fix": "cd dashboard && npm ci && npm run build",
                    "api": "/api/docs",
                },
            )

    return app


# ── box introspection ────────────────────────────────────────────────────


def _cmd(args: list[str], timeout: float = 3.0) -> str:
    try:
        p = subprocess.run(  # noqa: S603 - fixed argv, no shell
            args, capture_output=True, text=True, timeout=timeout, check=False
        )
        return p.stdout.strip() if p.returncode == 0 else ""
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _tmux_sessions() -> list[dict[str, Any]]:
    if shutil.which("tmux") is None:
        return []
    fmt = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}"
    out = _cmd(["tmux", "list-sessions", "-F", fmt])
    sessions: list[dict[str, Any]] = []
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 4:
            continue
        sessions.append(
            {
                "name": parts[0],
                "windows": _int(parts[1]),
                "attached": _int(parts[2]) > 0,
                "created": _int(parts[3]),
            }
        )
    return sessions


def _short_hostname() -> str:
    """A name you recognise, not a DHCP FQDN.

    socket.gethostname() on a home network returns things like
    "mac.hsd1.nh.comcast.net", which is noise in the sidebar. The Tailscale
    machine name is how you actually refer to the box, so prefer it.
    """
    raw = _cmd(["tailscale", "status", "--json"])
    if raw:
        try:
            dns = str(json.loads(raw).get("Self", {}).get("DNSName", "")).rstrip(".")
            if dns:
                return dns.split(".")[0]
        except (ValueError, AttributeError):
            pass
    return socket.gethostname().split(".")[0]


def _tailscale_ips() -> list[str]:
    if shutil.which("tailscale") is None:
        return []
    return [ln.strip() for ln in _cmd(["tailscale", "ip", "-4"]).splitlines() if ln.strip()]


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text(encoding="utf-8").lower()
    except OSError:
        return False


def _int(raw: str) -> int:
    try:
        return int(raw.strip())
    except ValueError:
        return 0
