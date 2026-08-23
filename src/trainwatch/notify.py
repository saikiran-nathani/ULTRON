"""Layer 3 — Notify. Push alerts to ntfy (and optionally W&B).

Three hard rules, because this code runs inside a training loop:

1. **It never raises.** Every failure path is swallowed and logged. The source
   guide puts this in a bare `except: pass`; we keep the behaviour and add a log
   line so a silently-broken alerter is still discoverable.
2. **It never blocks.** `alert()` hands off to a daemon worker thread and
   returns in microseconds. A 5-second HTTP timeout inline in the loop would be
   a 5-second stall on every alert.
3. **It never floods.** A diverging run can trip a rule on every one of a
   thousand consecutive steps. Per-rule cooldown plus a global token bucket mean
   your phone buzzes once, not a thousand times.

Because the worker is a daemon thread, an `atexit` hook drains the queue — so
the classic `alert(...); raise RuntimeError(...)` sequence still delivers.
"""

from __future__ import annotations

import atexit
import contextlib
import logging
import queue
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any, Literal

__all__ = ["Notifier", "NullNotifier", "Priority"]

log = logging.getLogger("trainwatch.notify")

Priority = Literal["min", "low", "default", "high", "urgent"]

_PRIORITY_TAGS: dict[str, str] = {
    "urgent": "rotating_light",
    "high": "warning",
    "default": "bell",
    "low": "information_source",
    "min": "information_source",
}

# Alerts that bypass the per-rule cooldown: they are terminal and rare.
_BYPASS_COOLDOWN: frozenset[str] = frozenset({"urgent"})


@dataclass(slots=True)
class _Message:
    body: str
    title: str
    priority: Priority
    tags: str


class Notifier:
    """Fire-and-forget alert sender.

    Args:
        url: full ntfy topic URL, e.g. ``https://ntfy.sh/my-secret-topic``.
             Empty disables sending (everything becomes a no-op + debug log).
        token: bearer token for a self-hosted ntfy that requires auth.
        cooldown: seconds a given rule stays muted after firing.
        burst: max alerts sent in any 60s window, across all rules.
        timeout: per-request HTTP timeout, seconds.
    """

    def __init__(
        self,
        url: str,
        *,
        token: str = "",
        cooldown: float = 120.0,
        burst: int = 12,
        timeout: float = 5.0,
        retries: int = 2,
    ) -> None:
        self.url = url.strip()
        self.token = token.strip()
        self.cooldown = cooldown
        self.burst = burst
        self.timeout = timeout
        self.retries = retries

        self.sent = 0
        self.failed = 0
        self.suppressed = 0

        self._last_fired: dict[str, float] = {}
        self._window: list[float] = []
        self._lock = threading.Lock()
        self._q: queue.Queue[_Message | None] = queue.Queue(maxsize=256)
        self._worker: threading.Thread | None = None
        self._closed = False

    # ── public API ───────────────────────────────────────────────────────

    @property
    def enabled(self) -> bool:
        return bool(self.url)

    def alert(
        self,
        body: str,
        *,
        title: str = "trainwatch",
        priority: Priority = "default",
        rule: str | None = None,
        tags: str | None = None,
    ) -> bool:
        """Queue an alert. Returns True if accepted, False if suppressed/disabled.

        Never raises. `rule` is the dedupe key — pass a stable identifier like
        ``"grad_norm"`` so repeated trips of the same rule collapse.
        """
        try:
            if not self.enabled or self._closed:
                log.debug("notify disabled, dropping alert: %s", title)
                return False
            if not self._allow(rule or title, priority):
                self.suppressed += 1
                return False

            msg = _Message(
                body=body,
                title=title,
                priority=priority,
                tags=tags or _PRIORITY_TAGS.get(priority, "bell"),
            )
            self._ensure_worker()
            try:
                self._q.put_nowait(msg)
            except queue.Full:
                # Better to drop one alert than to block a training step.
                self.suppressed += 1
                log.warning("notify queue full, dropped alert: %s", title)
                return False
            return True
        except Exception:
            log.exception("notify.alert failed unexpectedly")
            return False

    def flush(self, timeout: float = 10.0) -> None:
        """Block until queued alerts are sent (or timeout). Safe to call anytime."""
        if self._worker is None:
            return
        deadline = time.monotonic() + timeout
        while not self._q.empty() and time.monotonic() < deadline:
            time.sleep(0.02)

    def close(self, timeout: float = 10.0) -> None:
        """Drain and stop the worker."""
        if self._closed:
            return
        self.flush(timeout)
        self._closed = True
        if self._worker is not None:
            # A full queue means the worker is already busy and will drain;
            # the join below bounds how long we wait either way.
            with contextlib.suppress(queue.Full):
                self._q.put_nowait(None)
            self._worker.join(timeout=2.0)
            self._worker = None

    # ── rate limiting ────────────────────────────────────────────────────

    def _allow(self, rule: str, priority: Priority) -> bool:
        now = time.monotonic()
        with self._lock:
            # Global burst cap always applies — even to urgent. A thousand
            # urgent alerts is a broken alerter, not a thousand emergencies.
            self._window = [t for t in self._window if now - t < 60.0]
            if len(self._window) >= self.burst:
                log.warning("notify burst cap hit (%d/60s), suppressing %s", self.burst, rule)
                return False

            if priority not in _BYPASS_COOLDOWN:
                last = self._last_fired.get(rule)
                if last is not None and (now - last) < self.cooldown:
                    log.debug("rule %s in cooldown, suppressing", rule)
                    return False

            self._last_fired[rule] = now
            self._window.append(now)
            return True

    # ── worker ───────────────────────────────────────────────────────────

    def _ensure_worker(self) -> None:
        if self._worker is not None and self._worker.is_alive():
            return
        self._worker = threading.Thread(target=self._run, name="trainwatch-notify", daemon=True)
        self._worker.start()
        atexit.register(self.close)

    def _run(self) -> None:
        while True:
            try:
                msg = self._q.get(timeout=30.0)
            except queue.Empty:
                continue
            if msg is None:
                return
            try:
                self._send(msg)
            except Exception:
                log.exception("notify worker: send failed")
            finally:
                self._q.task_done()

    def _send(self, msg: _Message) -> None:
        headers = {
            "Title": _ascii_header(msg.title),
            "Priority": msg.priority,
            "Tags": msg.tags,
            "Content-Type": "text/plain; charset=utf-8",
        }
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"

        payload = msg.body.encode("utf-8")
        backoff = 0.5
        for attempt in range(self.retries + 1):
            req = urllib.request.Request(  # noqa: S310 - operator-configured https topic URL
                self.url, data=payload, headers=headers, method="POST"
            )
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as resp:  # noqa: S310
                    if 200 <= resp.status < 300:
                        self.sent += 1
                        return
                    log.warning("ntfy returned HTTP %s", resp.status)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                log.warning(
                    "ntfy POST failed (attempt %d/%d): %s", attempt + 1, self.retries + 1, exc
                )
            if attempt < self.retries:
                time.sleep(backoff)
                backoff *= 2
        self.failed += 1

    # ── introspection (used by `trainwatch doctor`) ──────────────────────

    def stats(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "sent": self.sent,
            "failed": self.failed,
            "suppressed": self.suppressed,
            "queued": self._q.qsize(),
        }


class NullNotifier(Notifier):
    """A notifier that accepts everything and sends nothing. For tests and demos."""

    def __init__(self) -> None:
        super().__init__("")
        self.messages: list[_Message] = []

    def alert(
        self,
        body: str,
        *,
        title: str = "trainwatch",
        priority: Priority = "default",
        rule: str | None = None,
        tags: str | None = None,
    ) -> bool:
        if not self._allow(rule or title, priority):
            self.suppressed += 1
            return False
        self.messages.append(_Message(body=body, title=title, priority=priority, tags=tags or ""))
        self.sent += 1
        return True

    @property
    def enabled(self) -> bool:
        return True


def _ascii_header(text: str) -> str:
    """ntfy headers must be latin-1 safe; emoji in a Title kills the request."""
    return text.encode("ascii", "replace").decode("ascii")
