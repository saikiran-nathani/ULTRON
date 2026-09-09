"""Experiment lineage — ADR-0004 phase E.

The difference between "loss went down" and "loss went down, on this data, with
this config, at this commit, on this machine". The first is an anecdote; the
second is a result someone else can check, including you in three months.

`render_baseline()` is the phase E gate: `results/00-baseline.md` stops being a
file someone maintains and becomes a query. The distinction matters for the
same reason it mattered for `STATUS.md` — a number typed into Markdown has no
way to disagree with the run that produced it, so it drifts silently.

Aggregation is deliberately conservative
----------------------------------------
Scores are summarised as mean ± sample standard deviation across seeds, and a
single seed reports **no** standard deviation rather than 0.0. Writing 0.0
there would claim perfect reproducibility from one measurement, which is the
same error as a phase with no gates reading as done.
"""

from __future__ import annotations

import hashlib
import json
import logging
import statistics
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from .store import connect, migrate

__all__ = [
    "EvalGroup",
    "Lineage",
    "SubjectKind",
    "config_id",
    "render_baseline",
]

log = logging.getLogger("trainwatch.lineage")

SubjectKind = Literal["base", "checkpoint", "served"]


def config_id(body: str) -> str:
    """Content address for a config: SHA-256 of its text, normalised.

    Trailing whitespace and line endings are stripped per line so a config that
    survived a round trip through an editor is still the same config. Anything
    beyond that is left alone -- reordering YAML keys *is* a different file, and
    pretending otherwise would hide a real change behind a canonicaliser.
    """
    normalised = "\n".join(line.rstrip() for line in body.strip().splitlines())
    return hashlib.sha256(normalised.encode()).hexdigest()[:16]


@dataclass(frozen=True)
class EvalGroup:
    """Every seed for one (subject, harness, task set, k)."""

    subject_kind: str
    subject_id: str
    harness_sha: str
    task_set: str
    k: int
    scores: tuple[float, ...]
    seeds: tuple[int, ...]
    n_problems: int
    machine: str
    ran_at: float

    @property
    def mean(self) -> float:
        return statistics.fmean(self.scores)

    @property
    def stdev(self) -> float | None:
        """Sample stdev, or None from a single seed.

        None rather than 0.0: one measurement says nothing about variance, and
        printing 0.0 would assert perfect reproducibility from n=1.
        """
        return statistics.stdev(self.scores) if len(self.scores) > 1 else None

    @property
    def enough_seeds(self) -> bool:
        """Three is the project's floor for a reportable number."""
        return len(self.scores) >= 3

    def format_score(self) -> str:
        if self.stdev is None:
            return f"{self.mean * 100:.1f}%"
        return f"{self.mean * 100:.1f}% ± {self.stdev * 100:.1f}"


class Lineage:
    """Datasets, configs, checkpoints and eval results, over the shared file."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._db = connect(self.path)
        migrate(self._db)

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Lineage:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── datasets ─────────────────────────────────────────────────────────

    def record_dataset(
        self,
        dataset_id: str,
        name: str,
        *,
        n_examples: int | None = None,
        sha256: str = "",
        recipe: dict[str, Any] | None = None,
        parent_id: str | None = None,
        built_at: float | None = None,
    ) -> str:
        self._db.execute(
            """INSERT INTO datasets (id, name, n_examples, sha256, built_at, recipe, parent_id)
                   VALUES (?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name, n_examples = excluded.n_examples,
                   sha256 = excluded.sha256, recipe = excluded.recipe,
                   parent_id = excluded.parent_id""",
            (
                dataset_id, name, n_examples, sha256,
                built_at if built_at is not None else time.time(),
                json.dumps(recipe or {}, sort_keys=True), parent_id,
            ),
        )
        self._db.commit()
        return dataset_id

    def dataset_chain(self, dataset_id: str) -> list[dict[str, Any]]:
        """A dataset and its ancestors, newest first.

        Guards against a cycle rather than trusting the data: `parent_id` is a
        plain self-reference, and a cycle would otherwise hang the caller.
        """
        seen: set[str] = set()
        out: list[dict[str, Any]] = []
        current: str | None = dataset_id
        while current and current not in seen:
            seen.add(current)
            row = self._db.execute("SELECT * FROM datasets WHERE id = ?", (current,)).fetchone()
            if row is None:
                break
            out.append(dict(row))
            current = row["parent_id"]
        return out

    # ── configs ──────────────────────────────────────────────────────────

    def record_config(self, body: str, *, phase_id: int | None = None) -> str:
        """Store a config by content address. Returns its id."""
        cid = config_id(body)
        self._db.execute(
            """INSERT INTO configs (id, phase_id, body, created_at) VALUES (?, ?, ?, ?)
               ON CONFLICT(id) DO NOTHING""",
            (cid, phase_id, body, time.time()),
        )
        self._db.commit()
        return cid

    def config(self, cid: str) -> dict[str, Any] | None:
        row = self._db.execute("SELECT * FROM configs WHERE id = ?", (cid,)).fetchone()
        return dict(row) if row else None

    # ── runs ─────────────────────────────────────────────────────────────

    def attach_run(
        self,
        run_id: str,
        *,
        config_id_: str | None = None,
        dataset_id: str | None = None,
        phase_id: int | None = None,
        machine: str = "",
        commit_sha: str = "",
    ) -> None:
        """Link a run to what produced it. Only non-empty values overwrite.

        COALESCE rather than plain assignment so a later partial call cannot
        blank a field an earlier one filled -- the shipper and the trainer both
        know different halves of this.
        """
        self._db.execute(
            """UPDATE runs SET
                   config_id  = COALESCE(?, config_id),
                   dataset_id = COALESCE(?, dataset_id),
                   phase_id   = COALESCE(?, phase_id),
                   machine    = CASE WHEN ? <> '' THEN ? ELSE machine END,
                   commit_sha = CASE WHEN ? <> '' THEN ? ELSE commit_sha END
                 WHERE id = ?""",
            (config_id_, dataset_id, phase_id, machine, machine,
             commit_sha, commit_sha, run_id),
        )
        self._db.commit()

    # ── checkpoints ──────────────────────────────────────────────────────

    def record_checkpoint(
        self,
        checkpoint_id: str,
        run_id: str,
        step: int,
        *,
        path: str = "",
        sha256: str = "",
        size_bytes: int = 0,
        kind: str = "adapter",
    ) -> str:
        self._db.execute(
            """INSERT INTO checkpoints
                   (id, run_id, step, path, sha256, size_bytes, kind, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET
                   path = excluded.path, sha256 = excluded.sha256,
                   size_bytes = excluded.size_bytes, kind = excluded.kind""",
            (checkpoint_id, run_id, step, path, sha256, size_bytes, kind, time.time()),
        )
        self._db.commit()
        return checkpoint_id

    # ── evals ────────────────────────────────────────────────────────────

    def record_eval(
        self,
        *,
        subject_kind: SubjectKind,
        subject_id: str,
        harness_sha: str,
        task_set: str,
        k: int,
        seed: int,
        score: float,
        n_problems: int,
        machine: str = "",
        ran_at: float | None = None,
    ) -> None:
        """Record one seed's score.

        Upserts on the unique key: re-running a seed replaces its score rather
        than appending, because a second measurement of the same seed supersedes
        the first -- it does not corroborate it. Appending would let one seed
        run twice look like two seeds agreeing.
        """
        self._db.execute(
            """INSERT INTO evals (subject_kind, subject_id, harness_sha, task_set,
                                  k, seed, score, n_problems, ran_at, machine)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(subject_kind, subject_id, harness_sha, task_set, k, seed)
                   DO UPDATE SET score = excluded.score,
                                 n_problems = excluded.n_problems,
                                 ran_at = excluded.ran_at,
                                 machine = excluded.machine""",
            (subject_kind, subject_id, harness_sha, task_set, k, seed, score,
             n_problems, ran_at if ran_at is not None else time.time(), machine),
        )
        self._db.commit()

    def eval_groups(self, *, task_set: str | None = None) -> list[EvalGroup]:
        """Every eval, grouped across seeds."""
        sql = """SELECT subject_kind, subject_id, harness_sha, task_set, k,
                        GROUP_CONCAT(seed) AS seeds,
                        GROUP_CONCAT(score) AS scores,
                        MAX(n_problems) AS n_problems,
                        MAX(machine) AS machine,
                        MAX(ran_at) AS ran_at
                   FROM evals {where}
                  GROUP BY subject_kind, subject_id, harness_sha, task_set, k
                  ORDER BY ran_at DESC"""
        where = "WHERE task_set = ?" if task_set else ""
        params = (task_set,) if task_set else ()
        rows = self._db.execute(sql.format(where=where), params).fetchall()
        return [
            EvalGroup(
                subject_kind=r["subject_kind"],
                subject_id=r["subject_id"],
                harness_sha=r["harness_sha"],
                task_set=r["task_set"],
                k=r["k"],
                scores=tuple(float(x) for x in r["scores"].split(",")),
                seeds=tuple(int(x) for x in r["seeds"].split(",")),
                n_problems=int(r["n_problems"]),
                machine=r["machine"] or "",
                ran_at=float(r["ran_at"]),
            )
            for r in rows
        ]

    # ── provenance ───────────────────────────────────────────────────────

    def provenance(self, checkpoint_id: str) -> dict[str, Any] | None:
        """Everything known about how a checkpoint came to exist."""
        row = self._db.execute(
            """SELECT c.id, c.step, c.path, c.sha256, c.size_bytes, c.kind,
                      r.id AS run_id, r.name AS run_name, r.machine, r.commit_sha,
                      r.config_id, r.dataset_id, r.started_at, r.status
                 FROM checkpoints c JOIN runs r ON r.id = c.run_id
                WHERE c.id = ?""",
            (checkpoint_id,),
        ).fetchone()
        if row is None:
            return None
        out = dict(row)
        out["config"] = self.config(row["config_id"]) if row["config_id"] else None
        out["datasets"] = self.dataset_chain(row["dataset_id"]) if row["dataset_id"] else []
        out["evals"] = [
            g for g in self.eval_groups() if g.subject_id == checkpoint_id
        ]
        return out


def _stamp(ts: float) -> str:
    return datetime.fromtimestamp(ts, UTC).strftime("%Y-%m-%d")


def render_baseline(lin: Lineage, *, now: float | None = None) -> str:
    """Render `results/00-baseline.md` from the database. The phase E gate."""
    groups = lin.eval_groups()
    generated = _stamp(now if now is not None else time.time())

    out: list[str] = [
        "# Eval results — generated from the progress database",
        "",
        "<!-- GENERATED FILE. Do not edit. -->",
        "<!-- Regenerate: trainwatch lineage --baseline results/00-baseline.md -->",
        "",
        f"Generated **{generated}** from `var/trainwatch.db` (ADR-0004 phase E).",
        "",
    ]

    if not groups:
        out += [
            "_No evals recorded._",
            "",
            "This is the honest state, not a formatting failure: the eval harness driver",
            "(`src/eval/harness.py`) does not exist yet, so no score has been produced to",
            "record. Every number the rest of the pipeline would claim is measured by it.",
            "",
        ]
        return "\n".join(out)

    thin = [g for g in groups if not g.enough_seeds]
    out += [
        "| Subject | Task set | pass@k | Score | Seeds | n | Where | When |",
        "|---|---|---|---:|---:|---:|---|---|",
    ]
    for g in groups:
        flag = "" if g.enough_seeds else " ⚠️"
        out.append(
            f"| `{g.subject_id}` ({g.subject_kind}) | {g.task_set} | pass@{g.k} | "
            f"{g.format_score()}{flag} | {len(g.seeds)} | {g.n_problems} | "
            f"{g.machine or '—'} | {_stamp(g.ran_at)} |"
        )
    out.append("")

    if thin:
        out += [
            f"⚠️ **{len(thin)} result(s) come from fewer than three seeds** and are not",
            "reportable yet. A single seed also shows no ± — one measurement says nothing",
            "about variance, and printing ± 0.0 would claim reproducibility it has not",
            "earned.",
            "",
        ]

    out += [
        "## Harness versions",
        "",
        "A score is only comparable to another score from the same harness.",
        "",
    ]
    for sha in sorted({g.harness_sha for g in groups}):
        subjects = sorted({g.subject_id for g in groups if g.harness_sha == sha})
        out.append(f"- `{sha}` — {', '.join(subjects)}")
    out.append("")
    return "\n".join(out)
