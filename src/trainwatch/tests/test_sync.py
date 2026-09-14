"""The sync core: the three properties, the four rules, and the plan's gate.

Every failure mode here is silent. A broken rule does not raise, does not log,
and does not show up on the device you are debugging on — it shows up as a
record missing on one other device, weeks later, indistinguishable from having
forgotten to write it down.

So these tests are the correctness argument, not a regression net. They were
written against `hlc.py` and `sync.py` and then mutation-checked.
"""

from __future__ import annotations

import pytest

from src.trainwatch.config import Config
from src.trainwatch.hlc import HLC, MAX_DRIFT_MS, format_hlc, now_ms
from src.trainwatch.sync import MAX_BATCH, Change, Sync, SyncError

OWNER = 1
T0 = 1_789_344_000_000


@pytest.fixture
def sync(cfg: Config):
    with Sync(cfg.db_path) as s:
        yield s


def ch(collection: str, rid: str, hlc: str, body=None, deleted: bool = False) -> Change:
    return Change(collection, rid, hlc, deleted, None if deleted else (body or {"v": 1}))


def at(ms: int, counter: int = 0, node: str = "dev-a") -> str:
    return format_hlc(ms, counter, node)


# ══ the three properties ═════════════════════════════════════════════════
# The plan names these as the entire correctness argument in executable form,
# and says to write them before refining granularity rather than after.


def test_idempotence_applying_the_same_batch_twice_changes_nothing(sync: Sync) -> None:
    """A retried push is the normal case on a flaky link, not an edge case.

    If a replay counted as a new write it would bump `seq`, re-deliver the
    record to every other device, and generate unbounded traffic from a
    network that is merely unreliable.
    """
    sync.register(OWNER, "dev-a")
    batch = [ch("journal", "a", at(T0), {"v": 1}), ch("projects", "b", at(T0, 1), {"v": 2})]

    first = sync.push(OWNER, "dev-a", batch)
    head_after_first = sync.head(OWNER)
    before = sync.snapshot(OWNER)
    versions_before = sync.stats(OWNER)["versions"]

    second = sync.push(OWNER, "dev-a", batch)

    assert len(first.accepted) == 2

    # The property is "no state changed", not "the response was empty".
    assert sync.snapshot(OWNER) == before
    assert sync.head(OWNER) == head_after_first, "a replay burned sequence numbers"
    assert sync.stats(OWNER)["versions"] == versions_before, (
        "a replay wrote a row into the archive — which is what tells the user "
        "an edit was replaced, so it would be reporting an overwrite that "
        "never happened"
    )

    # And it is reported ACCEPTED, deliberately. The client retried because a
    # response was lost; the change is durable, so it must be told that and
    # clear its dirty flag. Reporting it rejected would make the client apply a
    # "winner" identical to what it already has, forever.
    assert sorted(second.accepted) == ["journal/a", "projects/b"]
    assert second.rejected == [], "a writer's own version is not a conflict"


def test_commutativity_two_batches_in_either_order_give_the_same_state(
    cfg: Config,
) -> None:
    """Two devices' writes, applied in both orders.

    Convergence means the final state cannot depend on which push the server
    happened to receive first — otherwise two devices that both sync
    successfully still disagree.
    """
    a = [ch("journal", "x", at(T0, 0, "dev-a"), {"from": "a"})]
    b = [ch("journal", "x", at(T0, 1, "dev-b"), {"from": "b"}),
         ch("projects", "y", at(T0, 0, "dev-b"), {"from": "b"})]

    def apply(order):
        path = cfg.db_path.with_name(f"order-{id(order)}.db")
        with Sync(path) as s:
            s.register(OWNER, "dev-a")
            s.register(OWNER, "dev-b")
            for device, batch in order:
                s.push(OWNER, device, batch)
            return s.snapshot(OWNER)

    ab = apply([("dev-a", a), ("dev-b", b)])
    ba = apply([("dev-b", b), ("dev-a", a)])

    assert ab == ba
    # And it converged on the higher HLC, not on whichever arrived last.
    assert ab["journal"]["x"] == {"from": "b"}


def test_round_trip_what_is_pushed_is_what_is_pulled(sync: Sync) -> None:
    sync.register(OWNER, "dev-a")
    bodies = {
        "journal": {"a": {"mood": 3, "nested": {"deep": [1, 2, 3]}}},
        "projects": {"b": {"name": "x", "tasks": []}},
    }
    sync.push(
        OWNER,
        "dev-a",
        [
            ch("journal", "a", at(T0), bodies["journal"]["a"]),
            ch("projects", "b", at(T0, 1), bodies["projects"]["b"]),
        ],
    )
    out = sync.pull(OWNER, "dev-b", 0)
    got = {}
    for r in out["records"]:
        got.setdefault(r["collection"], {})[r["id"]] = r["body"]
    assert got == bodies


# ══ rule 2: hlc decides who wins, seq decides what you still need ════════


def test_a_slow_clocked_device_is_still_delivered(sync: Sync) -> None:
    """THE bug this schema exists to prevent.

    A device six minutes behind writes a record. Another device has already
    pulled up to a point *later in wall-clock terms*. If the cursor were the
    HLC, that record sits "in the past", below the cursor, and is never
    delivered to that device again — not on the next sync, not on any sync.

    Because the cursor is a server-assigned `seq`, arrival order decides
    delivery and the record lands normally.
    """
    sync.register(OWNER, "fast")
    sync.register(OWNER, "slow")

    # The fast device writes "now" and another device pulls it.
    sync.push(OWNER, "fast", [ch("journal", "later", at(T0 + 600_000), {"who": "fast"})])
    first = sync.pull(OWNER, "reader", 0)
    cursor = first["cursor"]
    assert len(first["records"]) == 1

    # Now the slow device's write arrives, with an HLC well BELOW the cursor's
    # record in wall-clock terms.
    sync.push(OWNER, "slow", [ch("journal", "earlier", at(T0), {"who": "slow"})])

    nxt = sync.pull(OWNER, "reader", cursor)
    ids = [r["id"] for r in nxt["records"]]
    assert ids == ["earlier"], (
        "the slow device's record was not delivered — the cursor is ordering on "
        "the clock instead of on arrival"
    )


def test_paging_is_ordered_by_seq_even_when_the_clocks_disagree(sync: Sync) -> None:
    """Paging must follow arrival order, not clock order.

    Written because a mutation that changed `ORDER BY seq` to `ORDER BY hlc`
    passed every other test in this file. With the WHERE clause still on
    `seq`, delivery stayed complete and only the order within a page changed —
    which nothing was looking at.

    It matters as soon as there is more than one page. The cursor is taken from
    the LAST row of a page, so if rows are ordered by hlc while the cursor is a
    seq, the cursor jumps to an arbitrary point and every record whose seq
    falls below it is skipped. Permanently: the next pull starts above them.

    So the HLCs here descend while the seqs ascend — devices arriving in the
    opposite order to their clocks, which is exactly what a phone catching up
    after a flight looks like.
    """
    sync.register(OWNER, "dev-a")
    for i in range(6):
        # Descending clock, ascending arrival.
        sync.push(OWNER, "dev-a", [ch("journal", f"r{i}", at(T0 - i * 1000), {"i": i})])

    seen, cursor, pages = [], 0, 0
    while pages < 20:
        page = sync.pull(OWNER, "reader", cursor, limit=2)
        seen += [r["id"] for r in page["records"]]
        cursor = page["cursor"]
        pages += 1
        if not page["more"]:
            break

    assert sorted(seen) == sorted(f"r{i}" for i in range(6)), (
        f"paging skipped or duplicated records: {seen}"
    )
    assert len(seen) == len(set(seen)), f"a record was delivered twice: {seen}"
    # Arrival order, which is r0..r5 — the reverse of clock order.
    assert seen == [f"r{i}" for i in range(6)]


def test_seq_is_monotonic_and_never_reused_after_gc(sync: Sync) -> None:
    """A reused `seq` silently skips every client already past it."""
    sync.register(OWNER, "dev-a")
    sync.push(OWNER, "dev-a", [ch("journal", "a", at(T0))])
    sync.push(OWNER, "dev-a", [ch("journal", "a", at(T0, 1), deleted=True)])
    head = sync.head(OWNER)

    sync.retire(OWNER, "dev-a")  # so the tombstone becomes collectable
    assert sync.gc_tombstones(OWNER) == 1
    assert sync.head(OWNER) == head, "GC must not rewind the sequence"

    sync.push(OWNER, "dev-b", [ch("journal", "c", at(T0, 2))])
    seqs = [r["seq"] for r in sync.pull(OWNER, "dev-b", 0)["records"]]
    assert seqs == [head + 1], "a new record reused a collected sequence number"


def test_the_higher_hlc_wins_regardless_of_arrival_order(sync: Sync) -> None:
    sync.register(OWNER, "dev-a")
    sync.push(OWNER, "dev-a", [ch("journal", "x", at(T0, 5), {"v": "late"})])
    sync.push(OWNER, "dev-b", [ch("journal", "x", at(T0, 1), {"v": "early"})])
    assert sync.snapshot(OWNER)["journal"]["x"] == {"v": "late"}


# ══ rule 3: the push response returns the winner ═════════════════════════


def test_a_rejected_push_comes_back_with_the_version_that_beat_it(sync: Sync) -> None:
    """Without the winner, the loser cannot converge.

    A bare "rejected" (or worse, a bare 200) leaves the client holding a
    version the server does not have, with no pending write and no way to
    learn what it lost to. The divergence is permanent and nothing in the
    system can correct it, because only one party thinks there is a conflict.
    """
    sync.register(OWNER, "dev-a")
    sync.push(OWNER, "dev-a", [ch("journal", "x", at(T0, 9), {"v": "winner"})])

    result = sync.push(OWNER, "dev-b", [ch("journal", "x", at(T0, 2), {"v": "loser"})])

    assert result.accepted == []
    assert len(result.rejected) == 1
    rej = result.rejected[0]
    assert (rej.collection, rej.record_id) == ("journal", "x")
    assert rej.winner["body"] == {"v": "winner"}, "the winning BODY must come back, not just an id"
    assert rej.winner["hlc"] == at(T0, 9)
    assert rej.winner["seq"] >= 1


def test_a_losing_version_is_archived_not_discarded(sync: Sync) -> None:
    """The conflict archive. What makes it safe to live on this.

    At 38 KB, keeping every version costs nothing, and it turns "your edit was
    silently overwritten" into "replaced by dev-a at 14:02 — view / restore".
    """
    sync.register(OWNER, "dev-a")
    sync.push(OWNER, "dev-a", [ch("journal", "x", at(T0, 9), {"v": "winner"})])
    sync.push(OWNER, "dev-b", [ch("journal", "x", at(T0, 2), {"v": "loser"})])

    hist = sync.history(OWNER, "journal", "x")
    outcomes = {(h["outcome"], h["device_id"]): h["body"] for h in hist}
    assert outcomes[("accepted", "dev-a")] == {"v": "winner"}
    assert outcomes[("rejected", "dev-b")] == {"v": "loser"}, "the loser was not recoverable"


# ══ rule 4: tombstone GC, and retiring a device ══════════════════════════


def test_a_tombstone_survives_while_any_active_device_has_not_pulled_it(
    sync: Sync,
) -> None:
    """The delete must not un-happen.

    A device that has not synced since before the delete still holds the
    record. Collect the tombstone and its next push resurrects it, forever,
    with nothing to say the record was ever deleted.
    """
    sync.register(OWNER, "phone")
    sync.register(OWNER, "laptop")

    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0))])
    sync.pull(OWNER, "laptop", 0)
    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0, 1), deleted=True)])
    laptop_cursor = sync.pull(OWNER, "laptop", 1)["cursor"]
    assert laptop_cursor == 2

    # The phone has never pulled: watermark is pinned at 0.
    assert sync.gc_watermark(OWNER) == 0
    assert sync.gc_tombstones(OWNER) == 0, "collected a tombstone the phone still needs"

    # The phone reconnects and receives the tombstone.
    got = sync.pull(OWNER, "phone", 0)
    assert [(r["id"], r["deleted"]) for r in got["records"]] == [("x", True)]


def test_retiring_a_device_frees_the_watermark(sync: Sync) -> None:
    """Otherwise a phone replaced in 2027 pins every tombstone forever."""
    sync.register(OWNER, "old-phone")
    sync.register(OWNER, "laptop")
    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0))])
    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0, 1), deleted=True)])
    sync.pull(OWNER, "laptop", 2)

    assert sync.gc_watermark(OWNER) == 0  # old-phone pins it
    assert sync.retire(OWNER, "old-phone") is True
    assert sync.gc_watermark(OWNER) == 2
    assert sync.gc_tombstones(OWNER) == 1


def test_a_retired_device_that_syncs_again_is_un_retired(sync: Sync) -> None:
    """A device in use is not retired, whatever the table said.

    Leaving it retired would let its tombstones be collected out from under a
    device that is actively syncing.
    """
    sync.register(OWNER, "phone")
    sync.retire(OWNER, "phone")
    assert sync.device(OWNER, "phone").retired_at is not None
    sync.register(OWNER, "phone")
    assert sync.device(OWNER, "phone").retired_at is None


def test_retiring_an_already_retired_device_reports_no_change(sync: Sync) -> None:
    sync.register(OWNER, "phone")
    assert sync.retire(OWNER, "phone") is True
    assert sync.retire(OWNER, "phone") is False


# ══ the plan's gate ══════════════════════════════════════════════════════


def test_aeroplane_mode_capture_arrives_exactly_once(sync: Sync) -> None:
    """Capture offline, reconnect, and the record is present once.

    Modelled with a retry, because the realistic failure is not "the push did
    not happen" but "the push happened and the response was lost", so the
    client sends it again.
    """
    sync.register(OWNER, "phone")
    clock = HLC(node="phone")
    captured = ch("inbox", "note-1", clock.tick(T0), {"text": "thought on a plane"})

    sync.push(OWNER, "phone", [captured])
    sync.push(OWNER, "phone", [captured])  # response was lost; client retries

    records = sync.pull(OWNER, "laptop", 0)["records"]
    assert [r["id"] for r in records] == ["note-1"], "capture duplicated or vanished"
    assert sync.stats(OWNER)["records"] == 1


def test_delete_on_one_device_while_another_is_offline_stays_deleted(
    sync: Sync,
) -> None:
    """The resurrection bug, end to end.

    The offline device still holds the record. On reconnect it pulls the
    tombstone FIRST (push-then-pull in one trip), sees the delete is newer than
    its copy, and does not re-push. If it did re-push, the higher HLC of the
    tombstone still wins — which is the belt to the braces.
    """
    sync.register(OWNER, "laptop")
    sync.register(OWNER, "phone")

    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0, 0, "laptop"), {"v": 1})])
    phone_cursor = sync.pull(OWNER, "phone", 0)["cursor"]  # phone has the record

    # Laptop deletes it while the phone is offline.
    sync.push(OWNER, "laptop", [ch("journal", "x", at(T0, 1, "laptop"), deleted=True)])

    # Phone reconnects and stubbornly re-pushes its stale copy.
    out = sync.sync(
        OWNER,
        "phone",
        changes=[ch("journal", "x", at(T0, 0, "phone"), {"v": 1})],
        since_seq=phone_cursor,
    )

    assert len(out["rejected"]) == 1, "the stale re-push should have lost"
    assert out["rejected"][0]["winner"]["deleted"] is True
    assert "journal" not in sync.snapshot(OWNER), "the delete was undone"


def test_any_batch_in_any_order_gives_the_same_state(cfg: Config) -> None:
    """Order-independence over a larger, shuffled set."""
    import itertools
    import random

    rng = random.Random(3)
    changes = [
        ch("journal", f"r{i % 4}", at(T0, i, f"dev-{i % 3}"), {"i": i})
        for i in range(12)
    ]

    states = []
    for trial in range(6):
        shuffled = changes[:]
        rng.shuffle(shuffled)
        path = cfg.db_path.with_name(f"shuffle-{trial}.db")
        with Sync(path) as s:
            for i in range(3):
                s.register(OWNER, f"dev-{i}")
            # Arbitrary batch boundaries too, not just arbitrary order.
            for start in range(0, len(shuffled), 5):
                s.push(OWNER, "dev-0", shuffled[start : start + 5])
            states.append(s.snapshot(OWNER))

    for a, b in itertools.pairwise(states):
        assert a == b, "state depends on arrival order or batching"


# ══ validation and refusal ═══════════════════════════════════════════════


def test_a_clock_beyond_the_drift_ceiling_is_refused(sync: Sync) -> None:
    """One wrong clock would otherwise win every future conflict forever."""
    sync.register(OWNER, "dev-a")
    absurd = format_hlc(now_ms() + MAX_DRIFT_MS + 60_000, 0, "dev-a")
    with pytest.raises(SyncError, match="ahead of the server"):
        sync.push(OWNER, "dev-a", [ch("journal", "x", absurd)])
    assert sync.snapshot(OWNER) == {}


def test_a_refused_batch_applies_nothing(sync: Sync) -> None:
    """Atomicity. A half-applied push leaves the client unable to diff.

    Its next diff would be against a state neither side agrees on, and the
    disagreement would be invisible.
    """
    sync.register(OWNER, "dev-a")
    good = ch("journal", "ok", at(T0), {"v": 1})
    bad = ch("journal", "bad", format_hlc(now_ms() + MAX_DRIFT_MS + 60_000, 0, "dev-a"))
    with pytest.raises(SyncError):
        sync.push(OWNER, "dev-a", [good, bad])
    assert sync.snapshot(OWNER) == {}, "part of a refused batch was applied"
    assert sync.head(OWNER) == 0, "a refused batch burned a sequence number"


def test_an_oversized_body_is_refused(sync: Sync) -> None:
    sync.register(OWNER, "dev-a")
    huge = {"blob": "x" * (300 * 1024)}
    with pytest.raises(SyncError, match="exceeds"):
        sync.push(OWNER, "dev-a", [ch("journal", "x", at(T0), huge)])


def test_an_oversized_batch_is_refused(sync: Sync) -> None:
    sync.register(OWNER, "dev-a")
    too_many = [ch("journal", f"r{i}", at(T0, i % 90_000)) for i in range(MAX_BATCH + 1)]
    with pytest.raises(SyncError, match="exceeds"):
        sync.push(OWNER, "dev-a", too_many)


@pytest.mark.parametrize(
    "raw",
    [
        {"collection": "", "id": "a", "hlc": format_hlc(T0, 0, "d")},
        {"collection": "j", "id": "", "hlc": format_hlc(T0, 0, "d")},
        {"collection": "j", "id": "a", "hlc": "nonsense"},
        {"collection": "j", "id": "a"},  # no hlc
        {"collection": "j", "id": "a", "hlc": format_hlc(T0, 0, "d")},  # live, no body
        {"collection": "j", "id": "a", "hlc": format_hlc(T0, 0, "d"), "deleted": True, "body": {"v": 1}},
        "not-an-object",
    ],
)
def test_a_malformed_change_is_refused_at_the_boundary(raw) -> None:
    with pytest.raises(SyncError):
        Change.from_json(raw)


def test_a_well_formed_change_parses(sync: Sync) -> None:
    c = Change.from_json(
        {"collection": "journal", "id": "a", "hlc": format_hlc(T0, 0, "d"), "body": {"v": 1}}
    )
    assert (c.collection, c.record_id, c.deleted, c.body) == ("journal", "a", False, {"v": 1})
    t = Change.from_json(
        {"collection": "journal", "id": "a", "hlc": format_hlc(T0, 1, "d"), "deleted": True}
    )
    assert t.deleted is True and t.body is None


def test_two_versions_of_one_record_in_one_batch_resolve_internally(sync: Sync) -> None:
    """Edited twice while offline. The batch must not fight itself.

    Without local resolution the row is written twice, burning two sequence
    numbers on one record and re-delivering it needlessly.
    """
    sync.register(OWNER, "dev-a")
    result = sync.push(
        OWNER,
        "dev-a",
        [
            ch("journal", "x", at(T0, 0), {"v": "first"}),
            ch("journal", "x", at(T0, 1), {"v": "second"}),
        ],
    )
    assert result.accepted == ["journal/x"]
    assert sync.snapshot(OWNER)["journal"]["x"] == {"v": "second"}
    assert sync.head(OWNER) == 1, "one record consumed two sequence numbers"


def test_a_negative_cursor_is_refused(sync: Sync) -> None:
    with pytest.raises(SyncError):
        sync.pull(OWNER, "dev-a", -1)


# ══ paging and owner isolation ═══════════════════════════════════════════


def test_pull_pages_and_reports_more_explicitly(sync: Sync) -> None:
    """`more` is explicit rather than inferred from a full page.

    Inferring it from `len(records) == limit` is wrong exactly when the final
    page happens to be full, and the symptom is a client that stops one page
    early — missing records, no error.
    """
    sync.register(OWNER, "dev-a")
    sync.push(OWNER, "dev-a", [ch("journal", f"r{i}", at(T0, i)) for i in range(5)])

    page = sync.pull(OWNER, "dev-a", 0, limit=5)
    assert len(page["records"]) == 5
    assert page["more"] is False, "a full final page reported more work"

    page = sync.pull(OWNER, "dev-a", 0, limit=2)
    assert page["more"] is True
    seen = []
    cursor = 0
    while True:
        page = sync.pull(OWNER, "dev-a", cursor, limit=2)
        seen += [r["id"] for r in page["records"]]
        cursor = page["cursor"]
        if not page["more"]:
            break
    assert seen == [f"r{i}" for i in range(5)]


def test_owners_cannot_see_each_other(sync: Sync) -> None:
    """`owner_id` is in the primary key from the first migration that has one.

    There is one human today. This test is what keeps that true as a property
    rather than an accident of there being nobody else.
    """
    sync.register(1, "dev-a")
    sync.register(2, "dev-b")
    sync.push(1, "dev-a", [ch("journal", "mine", at(T0), {"owner": 1})])
    sync.push(2, "dev-b", [ch("journal", "theirs", at(T0, 1), {"owner": 2})])

    assert [r["id"] for r in sync.pull(1, "dev-a", 0)["records"]] == ["mine"]
    assert [r["id"] for r in sync.pull(2, "dev-b", 0)["records"]] == ["theirs"]
    # Same collection AND same record id must not collide across owners.
    sync.push(1, "dev-a", [ch("journal", "same", at(T0, 2), {"owner": 1})])
    sync.push(2, "dev-b", [ch("journal", "same", at(T0, 3), {"owner": 2})])
    assert sync.snapshot(1)["journal"]["same"] == {"owner": 1}
    assert sync.snapshot(2)["journal"]["same"] == {"owner": 2}


def test_sync_pushes_before_it_pulls(sync: Sync) -> None:
    """One round trip must be enough to converge.

    If it pulled first, a client's own write would only come back on the next
    exchange — and on a phone that syncs solely in the foreground, "the next
    exchange" may be tomorrow.
    """
    sync.register(OWNER, "dev-a")
    out = sync.sync(
        OWNER, "dev-a", changes=[ch("journal", "x", at(T0), {"v": 1})], since_seq=0
    )
    assert out["accepted"] == ["journal/x"]
    assert [r["id"] for r in out["records"]] == ["x"], "own write not reflected in the same trip"
