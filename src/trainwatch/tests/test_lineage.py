"""Experiment lineage — ADR-0004 phase E.

The Phase E gate is `test_gate_baseline_is_a_query_not_a_file`.

Most of the rest guards against a specific failure: a result that looks more
solid than it is. One seed run twice must not read as two seeds agreeing, and
a single measurement must not report a standard deviation.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator
from pathlib import Path

import pytest

from src.trainwatch.lineage import Lineage, config_id, render_baseline
from src.trainwatch.store import Store

CFG = """
model: Qwen/Qwen2.5-Coder-0.5B-Instruct
seq_len: 1024
batch: 1
grad_accum: 16
"""


@pytest.fixture
def lin(tmp_path: Path) -> Iterator[Lineage]:
    with Lineage(tmp_path / "t.db") as lineage:
        yield lineage


def _eval(lin: Lineage, seed: int, score: float, *, subject: str = "ckpt-1") -> None:
    lin.record_eval(
        subject_kind="checkpoint",
        subject_id=subject,
        harness_sha="abc1234",
        task_set="humaneval+",
        k=1,
        seed=seed,
        score=score,
        n_problems=164,
        machine="tuf",
    )


# ── content-addressed configs ────────────────────────────────────────────


def test_the_same_config_is_the_same_id() -> None:
    assert config_id(CFG) == config_id(CFG)


def test_trailing_whitespace_does_not_change_the_id() -> None:
    """A round trip through an editor must not fork the lineage."""
    mangled = "\n".join(line + "   " for line in CFG.splitlines())
    assert config_id(CFG) == config_id(mangled)


def test_a_real_change_changes_the_id() -> None:
    assert config_id(CFG) != config_id(CFG.replace("seq_len: 1024", "seq_len: 2048"))


def test_recording_a_config_twice_stores_it_once(lin: Lineage) -> None:
    first = lin.record_config(CFG)
    second = lin.record_config(CFG)
    assert first == second
    assert lin._db.execute("SELECT COUNT(*) FROM configs").fetchone()[0] == 1
    assert lin.config(first) is not None


# ── datasets ─────────────────────────────────────────────────────────────


def test_dataset_chain_walks_ancestors(lin: Lineage) -> None:
    lin.record_dataset("raw", "the-stack raw", n_examples=100_000)
    lin.record_dataset("dedup", "deduped", n_examples=42_000, parent_id="raw")
    lin.record_dataset("clean", "decontaminated", n_examples=10_000, parent_id="dedup")

    chain = [d["id"] for d in lin.dataset_chain("clean")]
    assert chain == ["clean", "dedup", "raw"]


def test_dataset_chain_survives_a_cycle(lin: Lineage) -> None:
    """parent_id is a plain self-reference; a cycle must not hang the caller."""
    lin.record_dataset("a", "a")
    lin.record_dataset("b", "b", parent_id="a")
    lin._db.execute("UPDATE datasets SET parent_id = 'b' WHERE id = 'a'")
    lin._db.commit()
    chain = [d["id"] for d in lin.dataset_chain("b")]
    assert chain == ["b", "a"], "must stop rather than loop"


def test_an_unknown_dataset_gives_an_empty_chain(lin: Lineage) -> None:
    assert lin.dataset_chain("nope") == []


# ── evals: the part that stops a result overclaiming ─────────────────────


def test_three_seeds_aggregate(lin: Lineage) -> None:
    for seed, score in ((1, 0.30), (2, 0.34), (3, 0.32)):
        _eval(lin, seed, score)
    group = lin.eval_groups()[0]
    assert group.seeds == (1, 2, 3)
    assert group.mean == pytest.approx(0.32)
    assert group.stdev == pytest.approx(0.02)
    assert group.enough_seeds


def test_one_seed_reports_no_stdev(lin: Lineage) -> None:
    """0.0 would claim perfect reproducibility from a single measurement."""
    _eval(lin, 1, 0.31)
    group = lin.eval_groups()[0]
    assert group.stdev is None
    assert not group.enough_seeds
    assert "±" not in group.format_score()


def test_rerunning_a_seed_replaces_it(lin: Lineage) -> None:
    """A second measurement of one seed supersedes; it does not corroborate."""
    _eval(lin, 1, 0.30)
    _eval(lin, 1, 0.40)
    group = lin.eval_groups()[0]
    assert group.seeds == (1,), "one seed run twice is still one seed"
    assert group.mean == pytest.approx(0.40)
    assert lin._db.execute("SELECT COUNT(*) FROM evals").fetchone()[0] == 1


def test_the_unique_key_spans_harness_and_task_set(lin: Lineage) -> None:
    """The same seed on a different harness is a different measurement."""
    _eval(lin, 1, 0.30)
    lin.record_eval(
        subject_kind="checkpoint", subject_id="ckpt-1", harness_sha="def5678",
        task_set="humaneval+", k=1, seed=1, score=0.35, n_problems=164,
    )
    assert len(lin.eval_groups()) == 2


def test_an_impossible_score_is_refused(lin: Lineage) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        _eval(lin, 1, 1.5)
    with pytest.raises(sqlite3.IntegrityError):
        _eval(lin, 2, -0.1)


def test_an_unknown_subject_kind_is_refused(lin: Lineage) -> None:
    with pytest.raises(sqlite3.IntegrityError):
        lin.record_eval(
            subject_kind="vibes",  # type: ignore[arg-type]
            subject_id="x", harness_sha="a", task_set="t", k=1, seed=1,
            score=0.5, n_problems=1,
        )


def test_zero_problems_is_refused(lin: Lineage) -> None:
    """A score over an empty task set is not a score."""
    with pytest.raises(sqlite3.IntegrityError):
        lin.record_eval(
            subject_kind="base", subject_id="x", harness_sha="a", task_set="t",
            k=1, seed=1, score=0.5, n_problems=0,
        )


# ── provenance ───────────────────────────────────────────────────────────


def test_provenance_assembles_the_whole_chain(tmp_path: Path) -> None:
    store = Store(tmp_path / "t.db", flush_interval=0.0)
    store.start_run("run-1", "sft-0.5b")
    store.close()

    with Lineage(tmp_path / "t.db") as lin:
        cid = lin.record_config(CFG)
        lin.record_dataset("raw", "raw")
        lin.record_dataset("clean", "curated", n_examples=10_000, parent_id="raw")
        lin.attach_run(
            "run-1", config_id_=cid, dataset_id="clean",
            machine="tuf", commit_sha="deadbee",
        )
        lin.record_checkpoint("ckpt-1", "run-1", 500, path="/data/runs/a", kind="adapter")
        _eval(lin, 1, 0.31)

        prov = lin.provenance("ckpt-1")
        assert prov is not None
        assert prov["run_id"] == "run-1"
        assert prov["machine"] == "tuf"
        assert prov["commit_sha"] == "deadbee"
        assert prov["config"]["id"] == cid
        assert [d["id"] for d in prov["datasets"]] == ["clean", "raw"]
        assert len(prov["evals"]) == 1


def test_attach_run_does_not_blank_what_it_omits(tmp_path: Path) -> None:
    """The trainer and the shipper each know half of this."""
    store = Store(tmp_path / "t.db", flush_interval=0.0)
    store.start_run("run-1", "x")
    store.close()
    with Lineage(tmp_path / "t.db") as lin:
        lin.attach_run("run-1", machine="tuf", commit_sha="abc")
        lin.attach_run("run-1", dataset_id=None, machine="")  # a later partial call
        row = lin._db.execute(
            "SELECT machine, commit_sha FROM runs WHERE id = 'run-1'"
        ).fetchone()
        assert row["machine"] == "tuf"
        assert row["commit_sha"] == "abc"


def test_provenance_of_an_unknown_checkpoint_is_none(lin: Lineage) -> None:
    assert lin.provenance("nope") is None


def test_a_checkpoint_needs_a_real_run(lin: Lineage) -> None:
    """The foreign key is enforced now, which it was not before phase A."""
    with pytest.raises(sqlite3.IntegrityError):
        lin.record_checkpoint("ckpt-1", "no-such-run", 1)


# ── the Phase E gate ─────────────────────────────────────────────────────


def test_gate_baseline_is_a_query_not_a_file(tmp_path: Path) -> None:
    """The Phase E gate: results/00-baseline.md is rendered from the database.

    Three properties, matching the STATUS.md gate in phase C: reproducible from
    the same data, self-describing as generated, and it changes when the data
    changes without anyone editing text.

    The empty case is asserted first and on purpose. Right now there are no
    evals, because the harness driver does not exist — and the report has to
    say that plainly rather than render an empty table that reads like a clean
    result.
    """
    with Lineage(tmp_path / "t.db") as lin:
        empty = render_baseline(lin, now=1_757_404_800.0)
        assert "No evals recorded" in empty
        assert "does not exist yet" in empty, "must explain why, not just show nothing"
        assert "GENERATED FILE" in empty

        for seed, score in ((1, 0.30), (2, 0.34), (3, 0.32)):
            _eval(lin, seed, score)

        first = render_baseline(lin, now=1_757_404_800.0)
        second = render_baseline(lin, now=1_757_404_800.0)
        assert first == second, "same data and clock must give the same document"
        assert first != empty, "the document must follow the data"

        assert "32.0% ± 2.0" in first
        assert "pass@1" in first
        assert "humaneval+" in first
        assert "abc1234" in first, "the harness sha must be reported"
        assert "⚠️" not in first, "three seeds is enough; no warning expected"

        # a two-seed result must be flagged rather than quietly averaged
        lin.record_eval(
            subject_kind="base", subject_id="qwen0.5b", harness_sha="abc1234",
            task_set="humaneval+", k=1, seed=1, score=0.20, n_problems=164,
        )
        thin = render_baseline(lin, now=1_757_404_800.0)
        assert "⚠️" in thin
        assert "fewer than three seeds" in thin
