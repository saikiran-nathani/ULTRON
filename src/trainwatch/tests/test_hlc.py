"""The clock's ordering, which every conflict resolution rests on.

If any property here is wrong, the sync layer silently keeps the wrong version
of a record, and nothing anywhere reports an error.
"""

from __future__ import annotations

import random

import pytest

from src.trainwatch.hlc import (
    HLC,
    MAX_DRIFT_MS,
    HLCError,
    format_hlc,
    parse,
    wins,
)

# 2026-09-14T00:00:00Z, so the tests never depend on the real clock.
T0 = 1_789_344_000_000


# ── format ───────────────────────────────────────────────────────────────


def test_the_wire_format_is_fixed_width_and_round_trips() -> None:
    s = format_hlc(T0, 7, "macbook")
    assert s == f"{T0:016d}-00007-macbook"
    assert parse(s) == (T0, 7, "macbook")


def test_lexicographic_order_equals_causal_order() -> None:
    """The property the whole design leans on.

    Fixed-width zero padding is what makes a plain string compare — in Python,
    in SQLite, in an index — the same as comparing (millis, counter). Drop the
    padding and "9" sorts above "10", so a write in millisecond 10 loses to one
    from millisecond 9.
    """
    readings = [
        format_hlc(T0, 0, "a"),
        format_hlc(T0, 1, "a"),
        format_hlc(T0, 10, "a"),  # would sort below counter 1 without padding
        format_hlc(T0 + 1, 0, "a"),
        format_hlc(T0 + 10, 0, "a"),
        format_hlc(T0 + 100, 0, "a"),
    ]
    assert sorted(readings) == readings
    assert sorted(readings, reverse=True) == readings[::-1]


def test_a_node_id_cannot_contain_a_separator_or_non_ascii() -> None:
    # A node id ends up inside a sort key, so anything that breaks the parse or
    # makes ordering locale-dependent has to be refused at construction.
    for bad in ("has space", "has-é", "", "x" * 65):
        with pytest.raises(HLCError):
            format_hlc(T0, 0, bad)


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "not-an-hlc",
        "1726315200000-00000-node",  # millis too short
        f"{T0:016d}-0-node",  # counter too short
        f"{T0:016d}-00000-",  # no node
        f"{T0:016d}_00000_node",  # wrong separator
        "--",
    ],
)
def test_parse_refuses_anything_that_is_not_exactly_an_hlc(bad: str) -> None:
    with pytest.raises(HLCError):
        parse(bad)


def test_parse_refuses_a_non_string() -> None:
    # A JSON body can carry a number here, and `12345 > "0001..."` raises in
    # Python 3 but a dict lookup returning None would compare as "smallest".
    with pytest.raises(HLCError):
        parse(12345)  # type: ignore[arg-type]


def test_counter_overflow_raises_rather_than_wrapping() -> None:
    with pytest.raises(HLCError, match="counter overflow"):
        format_hlc(T0, 100_000, "node")


# ── tick ─────────────────────────────────────────────────────────────────


def test_tick_advances_within_one_millisecond() -> None:
    c = HLC(node="a")
    a, b, d = c.tick(T0), c.tick(T0), c.tick(T0)
    assert a < b < d
    assert parse(b)[1] == 1  # counter carries it


def test_tick_resets_the_counter_when_time_moves() -> None:
    c = HLC(node="a")
    c.tick(T0)
    c.tick(T0)
    assert parse(c.tick(T0 + 1))[1] == 0


def test_tick_never_goes_backwards_when_the_wall_clock_does() -> None:
    """NTP correction, a timezone change, a VM resuming from a snapshot.

    A pure wall-clock stamp goes backwards here, and a write that goes
    backwards loses to a write it actually happened after.
    """
    c = HLC(node="a")
    first = c.tick(T0)
    jumped_back = c.tick(T0 - 60_000)  # clock steps back a minute
    assert jumped_back > first
    assert parse(jumped_back)[0] == T0  # holds the high-water millis


def test_a_long_random_walk_is_monotonic() -> None:
    """Any interleaving of ticks and observes, with a jittery clock."""
    rng = random.Random(20260914)
    c = HLC(node="a")
    peer = HLC(node="b")
    readings = []
    wall = T0
    for _ in range(2000):
        # Jitter, including backwards.
        wall += rng.randint(-50, 100)
        if rng.random() < 0.3:
            readings.append(c.observe(peer.tick(wall + rng.randint(-20, 20)), wall))
        else:
            readings.append(c.tick(wall))
    assert readings == sorted(readings), "a reading went backwards"
    assert len(set(readings)) == len(readings), "a reading repeated"


# ── observe ──────────────────────────────────────────────────────────────


def test_observe_moves_past_a_remote_reading() -> None:
    """Causality. Without this, a reply sorts before the thing it replies to."""
    ours = HLC(node="a")
    ours.tick(T0)
    remote = format_hlc(T0 + 5000, 3, "b")
    after = ours.observe(remote, wall_ms=T0)
    assert after > remote


def test_observe_breaks_a_tie_on_the_counter() -> None:
    ours = HLC(node="a")
    ours.tick(T0)
    ours.tick(T0)  # counter 1
    after = ours.observe(format_hlc(T0, 5, "b"), wall_ms=T0)
    assert parse(after) == (T0, 6, "a")


def test_observe_refuses_a_clock_beyond_the_drift_ceiling() -> None:
    """A device with a wildly wrong clock would otherwise win forever.

    Every record it writes beats every future write from every correct device,
    and there is no recovery except editing the database by hand. So the
    ceiling is a refusal, not a clamp — clamping would accept the write while
    misrepresenting when it happened.
    """
    ours = HLC(node="a")
    absurd = format_hlc(T0 + MAX_DRIFT_MS + 1, 0, "b")
    with pytest.raises(HLCError, match="ahead of ours"):
        ours.observe(absurd, wall_ms=T0)


def test_observe_accepts_a_clock_just_inside_the_ceiling() -> None:
    ours = HLC(node="a")
    ok = format_hlc(T0 + MAX_DRIFT_MS, 0, "b")
    assert ours.observe(ok, wall_ms=T0) > ok


def test_a_refused_observation_does_not_move_our_clock() -> None:
    # Otherwise the refusal is cosmetic: the poisoned value is already in.
    ours = HLC(node="a")
    before = ours.tick(T0)
    with pytest.raises(HLCError):
        ours.observe(format_hlc(T0 + MAX_DRIFT_MS + 1, 0, "b"), wall_ms=T0)
    assert ours.current() == before


# ── wins ─────────────────────────────────────────────────────────────────


def test_wins_is_strictly_greater_so_a_retried_push_is_a_no_op() -> None:
    """Re-pushing what the server already has must not count as a new write.

    A retried push is the normal case on a flaky link, not an edge case. If an
    equal HLC counted as a win, every retry would rewrite the record, bump its
    `seq`, and re-deliver it to every other device — an infinite amount of
    traffic generated by a network that is merely unreliable.
    """
    a = format_hlc(T0, 0, "a")
    assert wins(format_hlc(T0, 1, "a"), a) is True
    assert wins(a, a) is False
    assert wins(a, format_hlc(T0, 1, "a")) is False


def test_wins_breaks_a_cross_device_tie_deterministically() -> None:
    """Two devices, same millisecond, same counter.

    Rare but reachable, and both devices must reach the SAME answer or they
    diverge while each believing it converged. The node id decides, which is
    arbitrary and — crucially — identical on both sides.
    """
    a = format_hlc(T0, 0, "aaa")
    b = format_hlc(T0, 0, "bbb")
    assert wins(b, a) is True
    assert wins(a, b) is False
    assert wins(a, b) != wins(b, a)


def test_wins_raises_on_a_corrupt_reading_rather_than_losing_silently() -> None:
    good = format_hlc(T0, 0, "a")
    with pytest.raises(HLCError):
        wins("garbage", good)
    with pytest.raises(HLCError):
        wins(good, "garbage")
