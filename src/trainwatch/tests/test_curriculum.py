"""Curriculum progress — ADR-0004 phase C.

The Phase C gate is `test_gate_status_md_is_generated_not_written`. The rest of
this file exists to pin the one property that makes the whole thing worth
having: a status cannot be asserted, only earned.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest

from src.trainwatch.curriculum import Curriculum
from src.trainwatch.progress import render_status, seed_from_yaml

REPO_ROOT = Path(__file__).resolve().parents[3]
SEED = REPO_ROOT / "configs" / "curriculum.yaml"


@pytest.fixture
def cur(tmp_path: Path) -> Curriculum:
    c = Curriculum(tmp_path / "t.db")
    c.upsert_phase("alpha", "Phase A", 0)
    c.upsert_gate("alpha", "one", "first gate", verify_cmd="true")
    c.upsert_gate("alpha", "two", "second gate", verify_cmd="true")
    return c


# ── derived status is the whole point ────────────────────────────────────


def test_a_phase_with_no_gates_is_blocked_not_done(tmp_path: Path) -> None:
    """Absence of evidence must not read as success.

    This is the exact failure of the file this replaces: it claimed "nothing
    measured on a model yet" while also carrying phases marked complete.
    """
    with Curriculum(tmp_path / "t.db") as c:
        c.upsert_phase("empty", "Nothing asserted", 0, status="done")
        assert c.phase("empty").derived == "blocked"


def test_derived_status_tracks_gate_evidence(cur: Curriculum) -> None:
    assert cur.phase("alpha").derived == "blocked", "no results yet"

    cur.record_gate("alpha", "one", passed=True)
    assert cur.phase("alpha").derived == "active", "some but not all"

    cur.record_gate("alpha", "two", passed=True)
    assert cur.phase("alpha").derived == "done", "all gates passing"

    cur.record_gate("alpha", "two", passed=False)
    assert cur.phase("alpha").derived == "active", "a regression must un-do it"
    cur.close()


def test_only_the_latest_result_per_gate_counts(cur: Curriculum) -> None:
    """A gate that passed and then failed is failing, not both."""
    cur.record_gate("alpha", "one", passed=True, ts=100.0)
    cur.record_gate("alpha", "one", passed=False, ts=200.0)
    cur.record_gate("alpha", "two", passed=True, ts=100.0)

    gates = {g.slug: g for g in cur.phase("alpha").gates}
    assert gates["one"].passed is False
    assert gates["one"].ts == 200.0
    assert cur.phase("alpha").derived == "active"
    cur.close()


def test_history_is_append_only(cur: Curriculum) -> None:
    """'It used to work' is the most useful fact available when something breaks."""
    cur.record_gate("alpha", "one", passed=True, ts=100.0, evidence="august")
    cur.record_gate("alpha", "one", passed=False, ts=200.0, evidence="today")
    history = cur.gate_history("alpha", "one")
    assert [h["evidence"] for h in history] == ["today", "august"], "newest first"
    assert len(history) == 2, "nothing overwritten"
    cur.close()


def test_recording_against_an_unknown_gate_raises(cur: Curriculum) -> None:
    with pytest.raises(KeyError):
        cur.record_gate("alpha", "nope", passed=True)
    with pytest.raises(KeyError):
        cur.record_gate("nosuchphase", "one", passed=True)
    cur.close()


# ── drift ────────────────────────────────────────────────────────────────


def test_drift_reports_an_overclaim_in_the_dangerous_direction(cur: Curriculum) -> None:
    cur.declare("alpha", "done")
    drifted = cur.drift()
    assert len(drifted) == 1
    assert drifted[0].declared == "done"
    assert drifted[0].derived == "blocked"
    assert drifted[0].overclaimed is True
    cur.close()


def test_drift_distinguishes_understatement(cur: Curriculum) -> None:
    """Understating is untidy; overclaiming is what misleads the next reader."""
    cur.record_gate("alpha", "one", passed=True)
    cur.record_gate("alpha", "two", passed=True)
    cur.declare("alpha", "blocked")
    drifted = cur.drift()
    assert len(drifted) == 1
    assert drifted[0].overclaimed is False
    cur.close()


def test_no_drift_when_the_record_matches_the_evidence(cur: Curriculum) -> None:
    cur.record_gate("alpha", "one", passed=True)
    cur.record_gate("alpha", "two", passed=True)
    cur.declare("alpha", "done")
    assert cur.drift() == []
    cur.close()


def test_declaring_an_unknown_phase_raises(cur: Curriculum) -> None:
    with pytest.raises(KeyError):
        cur.declare("ghost", "done")
    cur.close()


# ── constraints, not conventions ─────────────────────────────────────────


def test_pipeline_order_is_a_constraint(cur: Curriculum) -> None:
    """CLAUDE.md says "do not reorder". The schema enforces it."""
    with pytest.raises(sqlite3.IntegrityError):
        cur.upsert_phase("beta", "Phase B", 0)  # ord 0 already taken
    cur.close()


def test_an_unknown_status_cannot_be_stored(cur: Curriculum) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        cur._db.execute("UPDATE phases SET status = 'finished' WHERE slug = 'alpha'")
    cur.close()


def test_a_gate_cannot_dangle_without_its_phase(cur: Curriculum) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        cur._db.execute(
            "INSERT INTO gates (phase_id, slug, description) VALUES (9999, 'x', 'y')"
        )
    cur.close()


def test_a_question_cannot_be_closed_without_saying_when(cur: Curriculum) -> None:
    """The precise shape of rot that made the old file untrustworthy."""
    with pytest.raises(sqlite3.IntegrityError):
        cur._db.execute(
            """INSERT INTO open_questions (slug, question, status, opened_at)
                   VALUES ('q', 'why?', 'closed', 1.0)"""
        )
    cur.close()


# ── decisions and questions ──────────────────────────────────────────────


def test_superseded_decisions_are_kept_and_hidden_by_default(cur: Curriculum) -> None:
    old = cur.add_decision("D-old", "Python 3.14", decided_at=100.0)
    new = cur.add_decision("D-new", "Python 3.12", decided_at=200.0)
    cur.supersede(old, new)

    live = [d["slug"] for d in cur.decisions()]
    assert live == ["D-new"], "a superseded decision is not in force"
    everything = [d["slug"] for d in cur.decisions(include_superseded=True)]
    assert set(everything) == {"D-old", "D-new"}, "but it is never deleted"
    cur.close()


def test_a_decision_cannot_supersede_itself(cur: Curriculum) -> None:
    one = cur.add_decision("D-1", "a thing")
    with pytest.raises(ValueError, match="itself"):
        cur.supersede(one, one)
    cur.close()


def test_questions_open_and_close(cur: Curriculum) -> None:
    cur.ask("OQ-1", "is the wifi dead?", opened_at=100.0)
    assert [q["slug"] for q in cur.questions(status="open")] == ["OQ-1"]

    cur.answer("OQ-1", "disabled in BIOS", closed_at=200.0)
    assert cur.questions(status="open") == []
    closed = cur.questions(status="closed")
    assert closed[0]["resolution"] == "disabled in BIOS"
    assert closed[0]["closed_at"] == 200.0
    with pytest.raises(KeyError):
        cur.answer("OQ-404", "nope")
    cur.close()


# ── the seed ─────────────────────────────────────────────────────────────


def test_the_real_seed_loads(tmp_path: Path) -> None:
    with Curriculum(tmp_path / "t.db") as c:
        counts = seed_from_yaml(SEED, c)
        assert counts["phases"] == 11, "the pipeline has 11 phases"
        assert counts["gates"] > 0
        assert counts["results"] > 0
        phases = c.phases()
        assert [p.position for p in phases] == list(range(11)), "contiguous, in order"
        assert phases[0].slug == "sandbox"
        assert phases[-1].slug == "serve"


def test_re_seeding_does_not_duplicate_evidence(tmp_path: Path) -> None:
    """One measurement must not become two because the seed ran twice."""
    with Curriculum(tmp_path / "t.db") as c:
        first = seed_from_yaml(SEED, c)
        again = seed_from_yaml(SEED, c)
        assert first["results"] > 0
        assert again["results"] == 0, "gate results are evidence, not declarations"
        assert again["decisions"] == 0


def test_the_shipped_seed_does_not_overclaim(tmp_path: Path) -> None:
    """The committed declarations must agree with the committed evidence.

    If this fails, `configs/curriculum.yaml` is claiming progress that nothing
    in the repository supports — which is the bug this whole slice exists to
    prevent, so it should fail the suite rather than render a warning.
    """
    with Curriculum(tmp_path / "t.db") as c:
        seed_from_yaml(SEED, c)
        overclaims = [d for d in c.drift() if d.overclaimed]
        assert overclaims == [], f"seed overclaims: {overclaims}"


# ── the Phase C gate ─────────────────────────────────────────────────────


def test_gate_status_md_is_generated_not_written(tmp_path: Path) -> None:
    """The Phase C gate: STATUS.md is a view of the database.

    Three things have to hold for that to be true rather than aspirational:
    the output must be reproducible from the same data, it must announce that
    it is generated, and it must reflect a change made in the database without
    anyone touching the text.
    """
    with Curriculum(tmp_path / "t.db") as c:
        seed_from_yaml(SEED, c)

        first = render_status(c, now=1_757_404_800.0)
        second = render_status(c, now=1_757_404_800.0)
        assert first == second, "same data and clock must give the same document"

        assert "GENERATED FILE. Do not edit." in first
        assert "trainwatch curriculum --write" in first, "must say how to regenerate"
        assert "derived from gate evidence" in first

        # every phase appears, in pipeline order
        for phase in c.phases():
            assert phase.name in first
        assert first.index("Phase 0") < first.index("Phase 10")

        # a clean seed reports no drift
        assert "No drift" in first

        # now record a regression and re-render: the document must change on
        # its own, with no edit to any file
        c.record_gate(
            "sandbox", "adversarial-suite", passed=False, evidence="broke today"
        )
        after = render_status(c, now=1_757_404_800.0)
        assert after != first
        assert "broke today" in after
        assert "**FAIL**" in after
        assert "Drift" in after, "sandbox is declared done; evidence now says otherwise"
        assert "overclaimed" in after
