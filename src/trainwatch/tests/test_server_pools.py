"""The connection pools must not outlive the threads they served.

Written after the hub died in production with `OSError: [Errno 24] Too many
open files` — 245 of its 269 descriptors pointing at `trainwatch.db`, after
6h30m of uptime. The process kept running and kept listening; it simply could
not allocate a descriptor for an accepted socket, so every request was reset.
launchd reported it healthy the whole time.

The cause was ownership, not concurrency: each pool held a `list` of every
connection it had ever created, so a connection whose worker thread had been
retired could never be collected. Each SQLite connection is three file
descriptors, and a supervised job's `maxfiles` is 256.
"""

from __future__ import annotations

import gc
import threading

from src.trainwatch.config import Config
from src.trainwatch.server.app import AuthPool, HubPool, StorePool, SyncPool


def _churn(pool, attr: str, n: int = 12) -> None:
    """Open a connection on `n` short-lived threads, as the server does."""
    def work() -> None:
        pool.get()

    for _ in range(n):
        t = threading.Thread(target=work)
        t.start()
        t.join()


def test_a_pool_releases_connections_from_retired_threads(cfg: Config) -> None:
    """The property. A list here is a descriptor leak with a ~6 hour fuse."""
    pool = StorePool(cfg.db_path)
    _churn(pool, "store")

    # The threads are gone, so their thread-local slots are gone, so the pool's
    # weak references are the only thing left — and weak references do not keep
    # an object alive.
    gc.collect()
    live = len(list(pool._all))

    assert live <= 1, (
        f"{live} connections still retained after 12 threads exited. As a list "
        "this was 12, and in production it reached ~80 before the process ran "
        "out of file descriptors."
    )
    pool.close_all()


def test_every_pool_holds_weak_references(cfg: Config) -> None:
    """All four, because the leak was copy-pasted into each.

    Checked as a property of each pool rather than by grepping for `WeakSet`:
    the next pool someone adds by copying one of these should fail this.
    """
    import weakref

    for factory in (StorePool, AuthPool, HubPool, SyncPool):
        pool = (
            factory(cfg.db_path, cfg.blob_dir)
            if factory is HubPool
            else factory(cfg.db_path)
        )
        assert isinstance(pool._all, weakref.WeakSet), (
            f"{factory.__name__}._all is a {type(pool._all).__name__}; a strong "
            "container pins every connection its threads ever opened"
        )
        pool.close_all()


def test_the_same_thread_reuses_one_connection(cfg: Config) -> None:
    """The pool's actual job, which the fix must not break.

    A pool that handed out a new connection per call would fix the leak by
    making it worse.
    """
    pool = StorePool(cfg.db_path)
    assert pool.get() is pool.get() is pool.get()
    pool.close_all()


def test_close_all_survives_a_partially_collected_pool(cfg: Config) -> None:
    """Shutdown is exactly when objects are being collected.

    Iterating a WeakSet while its members are being finalised raises
    RuntimeError, which at shutdown would turn a clean stop into a traceback —
    and on a supervised service, a traceback on stop is indistinguishable from
    a crash.
    """
    pool = StorePool(cfg.db_path)
    pool.get()
    _churn(pool, "store", n=5)
    gc.collect()
    pool.close_all()  # must not raise
    pool.close_all()  # and must be safe twice
