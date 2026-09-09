"""Curriculum progress as data — ADR-0004, phase C.

Replaces `TUF/STATUS.md`. That file was hand-maintained, and it failed in the
specific way hand-maintained state files fail: it was *partially* updated. The
`/data` rows were corrected on 2026-08-23 while the header, the decisions
table and the results log were not, so by 2026-09-08 it asserted Python 3.14 as
settled after that had been reversed to 3.12, and "nothing measured on a model
yet" against two committed benchmark sweeps. A file that looks current where it
is not is worse than one that is plainly stale.

The design conclusion drawn from that: **a phase's status is derived from its
gates, not typed in.** A declared status is a claim; a gate result is evidence.
Both are kept, and `drift()` reports where they disagree — because that
disagreement is precisely the failure being designed out, so it should be
visible rather than silently reconciled.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from .store import connect, migrate

__all__ = [
    "Curriculum",
    "Drift",
    "GateState",
    "PhaseRow",
    "Status",
]

Status = Literal["blocked", "active", "done"]
_ORDER: tuple[Status, ...] = ("blocked", "active", "done")


@dataclass(frozen=True)
class GateState:
    """A gate and its most recent result, if it has ever been run."""

    slug: str
    description: str
    verify_cmd: str
    passed: bool | None
    ts: float | None
    evidence: str
    commit_sha: str
    machine: str

    @property
    def ran(self) -> bool:
        return self.passed is not None


@dataclass(frozen=True)
class PhaseRow:
    slug: str
    name: str
    position: int
    declared: Status
    note: str
    gates: tuple[GateState, ...]

    @property
    def derived(self) -> Status:
        """Status implied by gate evidence alone.

        A phase with no gates defined is `blocked`: nothing has been asserted
        about it, and optimism is not evidence.
        """
        if not self.gates:
            return "blocked"
        passed = sum(1 for g in self.gates if g.passed)
        if passed == len(self.gates):
            return "done"
        return "active" if passed else "blocked"


@dataclass(frozen=True)
class Drift:
    """A phase whose declared status is not what its gates support."""

    slug: str
    declared: Status
    derived: Status

    @property
    def overclaimed(self) -> bool:
        """True when the claim runs ahead of the evidence — the dangerous way."""
        return _ORDER.index(self.declared) > _ORDER.index(self.derived)


class Curriculum:
    """Typed access to the curriculum tables. Same file as `Store` and `Hub`."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._db = connect(self.path)
        migrate(self._db)

    def close(self) -> None:
        self._db.close()

    def __enter__(self) -> Curriculum:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    # ── phases ───────────────────────────────────────────────────────────

    def upsert_phase(
        self,
        slug: str,
        name: str,
        position: int,
        *,
        status: Status = "blocked",
        note: str = "",
    ) -> None:
        """Define or update a phase.

        The `ord` column is UNIQUE, making CLAUDE.md's "do not reorder" a
        constraint. `position` is the Python name for it; `ord` is a builtin.
        Reordering therefore requires moving the conflicting row out of the way
        first — deliberately awkward, because reordering the pipeline is a
        decision, not a typo.
        """
        self._db.execute(
            """INSERT INTO phases (slug, name, ord, status, note) VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(slug) DO UPDATE SET
                   name = excluded.name, ord = excluded.ord,
                   status = excluded.status, note = excluded.note""",
            (slug, name, position, status, note),
        )
        self._db.commit()

    def declare(self, slug: str, status: Status) -> None:
        """Set a phase's *declared* status. Evidence still comes from gates."""
        cur = self._db.execute(
            "UPDATE phases SET status = ? WHERE slug = ?", (status, slug)
        )
        if cur.rowcount == 0:
            raise KeyError(f"no such phase: {slug}")
        self._db.commit()

    def phases(self) -> list[PhaseRow]:
        """Every phase in pipeline order, each with its gates and latest results."""
        rows = self._db.execute(
            "SELECT id, slug, name, ord, status, note FROM phases ORDER BY ord"
        ).fetchall()
        return [
            PhaseRow(
                slug=r["slug"],
                name=r["name"],
                position=r["ord"],
                declared=r["status"],
                note=r["note"],
                gates=tuple(self._gates_for(r["id"])),
            )
            for r in rows
        ]

    def phase(self, slug: str) -> PhaseRow:
        for row in self.phases():
            if row.slug == slug:
                return row
        raise KeyError(f"no such phase: {slug}")

    def _gates_for(self, phase_id: int) -> list[GateState]:
        # The correlated subquery picks the newest result per gate. A plain
        # join would fan out to every historical result and the caller would
        # silently see the first one the planner happened to emit.
        rows = self._db.execute(
            """
            SELECT g.slug, g.description, g.verify_cmd,
                   r.passed, r.ts, r.evidence, r.commit_sha, r.machine
              FROM gates g
              LEFT JOIN gate_results r
                     ON r.id = (SELECT id FROM gate_results
                                 WHERE gate_id = g.id
                                 ORDER BY ts DESC, id DESC LIMIT 1)
             WHERE g.phase_id = ?
             ORDER BY g.slug
            """,
            (phase_id,),
        ).fetchall()
        return [
            GateState(
                slug=r["slug"],
                description=r["description"],
                verify_cmd=r["verify_cmd"] or "",
                passed=None if r["passed"] is None else bool(r["passed"]),
                ts=r["ts"],
                evidence=r["evidence"] or "",
                commit_sha=r["commit_sha"] or "",
                machine=r["machine"] or "",
            )
            for r in rows
        ]

    # ── gates ────────────────────────────────────────────────────────────

    def upsert_gate(
        self, phase_slug: str, slug: str, description: str, *, verify_cmd: str = ""
    ) -> None:
        phase_id = self._phase_id(phase_slug)
        self._db.execute(
            """INSERT INTO gates (phase_id, slug, description, verify_cmd)
                   VALUES (?, ?, ?, ?)
               ON CONFLICT(phase_id, slug) DO UPDATE SET
                   description = excluded.description, verify_cmd = excluded.verify_cmd""",
            (phase_id, slug, description, verify_cmd),
        )
        self._db.commit()

    def record_gate(
        self,
        phase_slug: str,
        gate_slug: str,
        *,
        passed: bool,
        evidence: str = "",
        commit_sha: str = "",
        machine: str = "",
        ts: float | None = None,
    ) -> None:
        """Append a gate result. History is kept; nothing is overwritten.

        A gate that passed in August and fails today should show both, because
        "it used to work" is the single most useful fact when something breaks.
        """
        row = self._db.execute(
            "SELECT id FROM gates WHERE phase_id = ? AND slug = ?",
            (self._phase_id(phase_slug), gate_slug),
        ).fetchone()
        if row is None:
            raise KeyError(f"no such gate: {phase_slug}/{gate_slug}")
        self._db.execute(
            """INSERT INTO gate_results (gate_id, ts, passed, evidence, commit_sha, machine)
                   VALUES (?, ?, ?, ?, ?, ?)""",
            (row["id"], ts if ts is not None else time.time(),
             1 if passed else 0, evidence, commit_sha, machine),
        )
        self._db.commit()

    def gate_history(self, phase_slug: str, gate_slug: str) -> list[dict[str, Any]]:
        return [
            dict(r)
            for r in self._db.execute(
                """SELECT r.ts, r.passed, r.evidence, r.commit_sha, r.machine
                     FROM gate_results r JOIN gates g ON g.id = r.gate_id
                    WHERE g.phase_id = ? AND g.slug = ?
                    ORDER BY r.ts DESC, r.id DESC""",
                (self._phase_id(phase_slug), gate_slug),
            ).fetchall()
        ]

    def _phase_id(self, slug: str) -> int:
        row = self._db.execute("SELECT id FROM phases WHERE slug = ?", (slug,)).fetchone()
        if row is None:
            raise KeyError(f"no such phase: {slug}")
        return int(row["id"])

    # ── drift ────────────────────────────────────────────────────────────

    def drift(self) -> list[Drift]:
        """Phases whose declared status is not supported by their gates.

        The whole reason this module exists. An empty list means the record
        agrees with the evidence; a non-empty one names the rows that were
        about to mislead the next reader.
        """
        out = []
        for row in self.phases():
            if row.declared != row.derived:
                out.append(Drift(slug=row.slug, declared=row.declared, derived=row.derived))
        return out

    # ── decisions ────────────────────────────────────────────────────────

    def add_decision(
        self, slug: str, title: str, *, body: str = "", decided_at: float | None = None
    ) -> int:
        cur = self._db.execute(
            "INSERT INTO decisions (slug, title, body, decided_at) VALUES (?, ?, ?, ?)",
            (slug, title, body, decided_at if decided_at is not None else time.time()),
        )
        self._db.commit()
        return int(cur.lastrowid or 0)

    def supersede(self, old_id: int, new_id: int) -> None:
        """Point a decision at the one that replaced it.

        Decisions are never edited or deleted. `CLAUDE.md` still carries claims
        that were true when written; the useful record is not the latest value
        but the chain that got there.
        """
        if old_id == new_id:
            raise ValueError("a decision cannot supersede itself")
        cur = self._db.execute(
            "UPDATE decisions SET superseded_by = ? WHERE id = ?", (new_id, old_id)
        )
        if cur.rowcount == 0:
            raise KeyError(f"no such decision: {old_id}")
        self._db.commit()

    def decisions(self, *, include_superseded: bool = False) -> list[dict[str, Any]]:
        sql = """SELECT id, slug, title, body, decided_at, superseded_by
                   FROM decisions {where} ORDER BY decided_at DESC, id DESC"""
        where = "" if include_superseded else "WHERE superseded_by IS NULL"
        return [dict(r) for r in self._db.execute(sql.format(where=where)).fetchall()]

    # ── open questions ───────────────────────────────────────────────────

    def ask(self, slug: str, question: str, *, opened_at: float | None = None) -> None:
        self._db.execute(
            """INSERT INTO open_questions (slug, question, status, opened_at)
                   VALUES (?, ?, 'open', ?)
               ON CONFLICT(slug) DO UPDATE SET question = excluded.question""",
            (slug, question, opened_at if opened_at is not None else time.time()),
        )
        self._db.commit()

    def answer(self, slug: str, resolution: str, *, closed_at: float | None = None) -> None:
        """Close a question. The schema refuses a close without a timestamp."""
        cur = self._db.execute(
            """UPDATE open_questions
                  SET status = 'closed', resolution = ?, closed_at = ?
                WHERE slug = ?""",
            (resolution, closed_at if closed_at is not None else time.time(), slug),
        )
        if cur.rowcount == 0:
            raise KeyError(f"no such question: {slug}")
        self._db.commit()

    def questions(self, *, status: str | None = "open") -> list[dict[str, Any]]:
        if status is None:
            rows = self._db.execute(
                "SELECT * FROM open_questions ORDER BY status, slug"
            ).fetchall()
        else:
            rows = self._db.execute(
                "SELECT * FROM open_questions WHERE status = ? ORDER BY slug", (status,)
            ).fetchall()
        return [dict(r) for r in rows]
