"""Hybrid logical clocks — who wins, and nothing else.

A hybrid logical clock is a wall-clock millisecond plus a counter plus a node
id. It gives a **total order over writes** that respects causality and does not
require the clocks involved to agree, which matters because five devices
syncing through one server absolutely will not agree.

The one thing to understand before using this
---------------------------------------------
**An HLC decides who wins. It must never decide what you still need.**

Those are two different jobs and conflating them is a permanent, silent,
single-device data loss:

    client cursor ─────────────────────────────► 4812
                                                    │
      phone (clock 6 min slow) writes ──► hlc 13:58 │
      laptop already pulled up to ──────► hlc 14:04 │
                                                    │
      cursor on hlc → the phone's record is "in the past", is below the
                      cursor, and is NEVER delivered to that client again.
                      Not on the next sync. Not on any sync.

So the delivery cursor is a **server-assigned monotonic `seq`**, never an HLC.
The HLC appears only in comparisons between two versions of the same record.
See `sync.py`, which assigns `seq` on accept and uses `hlc` only to resolve.

Wire format
-----------
`0001726315200000-00000-macbook` — zero-padded millis, zero-padded counter,
node id. Fixed-width on purpose: **lexicographic comparison equals causal
comparison**, so SQLite can order these with a plain `<` and an index works
normally. A JSON object of three fields would need unpacking everywhere and
could not be indexed.

The counter is what makes two writes in the same millisecond orderable, and
what keeps the clock moving forward when the wall clock jumps backwards —
NTP correction, a timezone change, a VM resuming from a snapshot. A pure
wall-clock timestamp goes backwards there, and a write that goes backwards is
a write that loses to something it happened after.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

__all__ = ["HLC", "MAX_DRIFT_MS", "HLCError", "format_hlc", "now_ms", "parse"]

# Widths chosen so the format stays sortable past the year 9999 and past
# 65,535 writes in one millisecond. Changing either width breaks the ordering
# of every HLC already stored, so they are not tunable.
_MS_WIDTH = 16
_COUNT_WIDTH = 5

# A node id is part of a sort key, so it has to be ASCII and fixed-charset or
# ordering becomes locale-dependent.
_NODE_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,64}$")
_HLC_RE = re.compile(rf"^(\d{{{_MS_WIDTH}}})-(\d{{{_COUNT_WIDTH}}})-([A-Za-z0-9_.:-]{{1,64}})$")

# How far ahead of our own clock a remote HLC may be before we refuse it.
#
# Without a ceiling, one device with a badly wrong clock — a dead RTC battery,
# a manually set date in 2099 — poisons the whole dataset: every record it
# writes wins every future conflict forever, and no correct write can ever
# beat it again. There is no recovery short of editing the database.
#
# Ten minutes is generous for NTP-synced machines on one tailnet and small
# enough that the poisoning window is bounded.
MAX_DRIFT_MS = 10 * 60 * 1000


class HLCError(ValueError):
    """A malformed or implausible clock reading."""


def now_ms() -> int:
    """Wall clock in milliseconds.

    `time.time()` and not `monotonic()`: this value is compared across
    machines, and a monotonic clock is only meaningful within one process.
    The counter in the HLC is what covers the non-monotonicity.
    """
    return int(time.time() * 1000)


def format_hlc(millis: int, counter: int, node: str) -> str:
    if millis < 0 or counter < 0:
        raise HLCError(f"negative component: {millis=} {counter=}")
    if millis >= 10**_MS_WIDTH:
        raise HLCError(f"millis too large for the {_MS_WIDTH}-digit field: {millis}")
    if counter >= 10**_COUNT_WIDTH:
        # Not a plausible accident: 100,000 writes inside one millisecond.
        raise HLCError(f"counter overflow ({counter}) — more than 10^{_COUNT_WIDTH} writes in 1ms")
    if not _NODE_RE.match(node):
        raise HLCError(f"node id must match {_NODE_RE.pattern!r}, got {node!r}")
    return f"{millis:0{_MS_WIDTH}d}-{counter:0{_COUNT_WIDTH}d}-{node}"


def parse(value: str) -> tuple[int, int, str]:
    """Split a wire-format HLC, raising on anything that is not exactly one."""
    if not isinstance(value, str):
        raise HLCError(f"expected a string, got {type(value).__name__}")
    m = _HLC_RE.match(value)
    if not m:
        raise HLCError(f"not a valid HLC: {value!r}")
    return int(m.group(1)), int(m.group(2)), m.group(3)


@dataclass
class HLC:
    """A node's clock. Not thread-safe; give each writer its own.

    Two operations, and the distinction between them is the whole algorithm:

    * `tick()` — about to write locally.
    * `observe(remote)` — just received someone else's clock, so ours must
      move past it. Skipping this is what breaks causality: reply to a message
      stamped 14:04 while our clock says 13:58 and the reply sorts *before*
      the thing it replies to.
    """

    node: str
    millis: int = 0
    counter: int = 0

    def __post_init__(self) -> None:
        if not _NODE_RE.match(self.node):
            raise HLCError(f"node id must match {_NODE_RE.pattern!r}, got {self.node!r}")

    def tick(self, wall_ms: int | None = None) -> str:
        """Stamp a local write."""
        wall = now_ms() if wall_ms is None else wall_ms
        if wall > self.millis:
            # The normal path: time moved, so restart the counter.
            self.millis, self.counter = wall, 0
        else:
            # Same millisecond, or the wall clock went BACKWARDS. Either way
            # the counter carries us forward, because emitting a timestamp
            # lower than one we have already emitted would let a later write
            # lose to an earlier one.
            self.counter += 1
        return format_hlc(self.millis, self.counter, self.node)

    def observe(self, remote: str, wall_ms: int | None = None) -> str:
        """Advance past a clock we just saw, and return our new reading.

        Raises `HLCError` if the remote reading is further ahead than
        `MAX_DRIFT_MS` — see the note on that constant for why accepting it
        would be unrecoverable.
        """
        r_ms, r_count, _ = parse(remote)
        wall = now_ms() if wall_ms is None else wall_ms

        if r_ms > wall + MAX_DRIFT_MS:
            raise HLCError(
                f"remote clock is {(r_ms - wall) / 1000:.0f}s ahead of ours, past the "
                f"{MAX_DRIFT_MS / 1000:.0f}s ceiling. Refusing: accepting it would let "
                "this writer win every future conflict permanently."
            )

        high = max(wall, self.millis, r_ms)
        if high == self.millis == r_ms:
            self.counter = max(self.counter, r_count) + 1
        elif high == self.millis:
            self.counter += 1
        elif high == r_ms:
            self.counter = r_count + 1
        else:
            # The wall clock is ahead of both; nothing to preserve.
            self.counter = 0
        self.millis = high
        return format_hlc(self.millis, self.counter, self.node)

    def current(self) -> str:
        return format_hlc(self.millis, self.counter, self.node)


def wins(candidate: str, incumbent: str) -> bool:
    """Whether `candidate` should replace `incumbent`.

    Strictly greater, so re-pushing a record the server already has is a no-op
    rather than a rewrite. That is what makes a retried push idempotent, and a
    retried push is the normal case on a flaky link — not an edge case.

    Both arguments are validated: an unparseable HLC must raise rather than
    compare as "smaller than everything", which is what a bare string compare
    would do and would make a corrupt record lose silently forever.
    """
    parse(candidate)
    parse(incumbent)
    return candidate > incumbent
