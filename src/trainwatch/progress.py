"""Seed the curriculum from YAML, and render it back out as Markdown.

Two directions, one invariant: **the database is the record and the Markdown is
a view.** `TUF/STATUS.md` failed because it was both at once — the only copy of
the state and the thing humans edited — so a partial edit left it internally
inconsistent with no way to tell which half was current.

`render_status()` output therefore carries a generated-file banner and is meant
to be overwritten, never edited. If it disagrees with reality, the fix is a
gate result, not a keystroke in the file.

PyYAML is imported inside `seed_from_yaml()` rather than at module scope, so
this module stays importable on a bare interpreter — see
`tests/test_zero_dependency_core.py` for why that matters.
"""

from __future__ import annotations

import datetime as dt
import logging
import time
from pathlib import Path
from typing import Any

from .curriculum import Curriculum, PhaseRow

__all__ = ["render_status", "seed_from_yaml"]

log = logging.getLogger("trainwatch.progress")

_MARK = {"done": "✅", "active": "🚧", "blocked": "⛔"}


def _epoch(value: Any, *, default: float | None = None) -> float:
    """Coerce a YAML date/datetime/ISO string to a unix timestamp.

    PyYAML resolves an unquoted `2026-08-23` to `datetime.date`, which has no
    time and no timezone. Dates are read as UTC midnight so a seeded row sorts
    against `time.time()` values without a surprise offset.
    """
    if value is None:
        if default is None:
            raise ValueError("a date is required here")
        return default
    if isinstance(value, dt.datetime):
        when = value if value.tzinfo else value.replace(tzinfo=dt.UTC)
        return when.timestamp()
    if isinstance(value, dt.date):
        return dt.datetime(value.year, value.month, value.day, tzinfo=dt.UTC).timestamp()
    if isinstance(value, int | float):
        return float(value)
    return dt.datetime.fromisoformat(str(value)).replace(tzinfo=dt.UTC).timestamp()


def seed_from_yaml(path: str | Path, cur: Curriculum) -> dict[str, int]:
    """Load declarations into the database. Idempotent; returns counts applied.

    Phases, gates and questions upsert by slug. Gate *results* are append-only
    evidence, so they are inserted only when an identical (timestamp, outcome)
    row is absent — re-running the seed must not manufacture a second passing
    result and make one measurement look like two.
    """
    # Imported here, not at module scope. `cli` is listed in CORE_MODULES and
    # has to import on a bare interpreter -- the training loop imports
    # src.train.monitor, and a monitoring library must never be why a six-hour
    # run fails to start. PyYAML is not a declared dependency of this project
    # (it appears only in requirements/mac.lock.txt, transitively), and seeding
    # is a maintenance action on the Mac, never something a trainer does.
    import yaml

    doc = yaml.safe_load(Path(path).read_text())
    counts = dict.fromkeys(("phases", "gates", "results", "decisions", "questions"), 0)

    for phase in doc.get("phases") or []:
        cur.upsert_phase(
            phase["slug"],
            phase["name"],
            int(phase["position"]),
            status=phase.get("declared", "blocked"),
            note=(phase.get("note") or "").strip(),
        )
        counts["phases"] += 1
        for gate in phase.get("gates") or []:
            cur.upsert_gate(
                phase["slug"],
                gate["slug"],
                gate["description"].strip(),
                verify_cmd=(gate.get("verify_cmd") or "").strip(),
            )
            counts["gates"] += 1
            for res in gate.get("results") or []:
                ts = _epoch(res.get("at"), default=time.time())
                known = {
                    (row["ts"], bool(row["passed"]))
                    for row in cur.gate_history(phase["slug"], gate["slug"])
                }
                if (ts, bool(res["passed"])) in known:
                    continue
                cur.record_gate(
                    phase["slug"],
                    gate["slug"],
                    passed=bool(res["passed"]),
                    evidence=(res.get("evidence") or "").strip(),
                    commit_sha=str(res.get("commit") or ""),
                    machine=str(res.get("machine") or ""),
                    ts=ts,
                )
                counts["results"] += 1

    # Two passes: `superseded_by` names a slug that may appear later in the file.
    ids: dict[str, int] = {}
    existing = {d["slug"]: d["id"] for d in cur.decisions(include_superseded=True)}
    for dec in doc.get("decisions") or []:
        slug = dec["slug"]
        if slug in existing:
            ids[slug] = existing[slug]
            continue
        ids[slug] = cur.add_decision(
            slug,
            dec["title"].strip(),
            body=(dec.get("body") or "").strip(),
            decided_at=_epoch(dec.get("at"), default=time.time()),
        )
        counts["decisions"] += 1
    for dec in doc.get("decisions") or []:
        target = dec.get("superseded_by")
        if not target:
            continue
        if target not in ids:
            raise KeyError(f"{dec['slug']} superseded_by unknown decision {target!r}")
        cur.supersede(ids[dec["slug"]], ids[target])

    for q in doc.get("questions") or []:
        cur.ask(q["slug"], q["question"].strip(), opened_at=_epoch(q.get("opened")))
        counts["questions"] += 1
        if q.get("status") == "closed":
            cur.answer(
                q["slug"],
                (q.get("resolution") or "").strip(),
                closed_at=_epoch(q.get("closed"), default=time.time()),
            )
    return counts


def _stamp(ts: float | None) -> str:
    if ts is None:
        return "—"
    return dt.datetime.fromtimestamp(ts, dt.UTC).strftime("%Y-%m-%d")


def _pipeline(phases: list[PhaseRow]) -> str:
    return " → ".join(f"{p.slug} {_MARK[p.derived]}" for p in phases)


def render_status(cur: Curriculum, *, now: float | None = None) -> str:
    """Render the whole curriculum as Markdown. Pure function of the database."""
    phases = cur.phases()
    drifted = {d.slug: d for d in cur.drift()}
    generated = _stamp(now if now is not None else time.time())

    out: list[str] = [
        "# STATUS — generated from the progress database",
        "",
        "<!-- GENERATED FILE. Do not edit. -->",
        "<!-- Regenerate: trainwatch curriculum --write TUF/STATUS.md -->",
        "",
        f"Generated **{generated}** from `var/trainwatch.db` (ADR-0004).",
        "",
        "Every status below is **derived from gate evidence**, not typed in. A phase is",
        "`done` only when every one of its gates has a passing result. An unmeasured gate",
        "reads as blocked, which is the behaviour the hand-written file lacked.",
        "",
        "## Pipeline",
        "",
        f"`{_pipeline(phases)}`",
        "",
    ]

    if drifted:
        out += [
            "## ⚠️ Drift — declared status disagrees with the evidence",
            "",
            "| Phase | Declared | Evidence supports | |",
            "|---|---|---|---|",
        ]
        for slug, d in drifted.items():
            flag = "**overclaimed**" if d.overclaimed else "understated"
            out.append(f"| `{slug}` | {d.declared} | **{d.derived}** | {flag} |")
        out += [
            "",
            "An overclaim is the dangerous direction: the record says a phase is further",
            "along than anything measured supports. That is exactly how the previous file",
            "came to assert results that had never been produced.",
            "",
        ]
    else:
        out += ["_No drift: every declared status matches its gate evidence._", ""]

    out += ["## Phases", ""]
    for p in phases:
        out += [f"### {_MARK[p.derived]} {p.name}", ""]
        if p.note:
            out += [f"> {p.note}", ""]
        if not p.gates:
            out += ["_No gates defined — nothing has been asserted about this phase._", ""]
            continue
        out += ["| Gate | Result | When | Where | Evidence |", "|---|---|---|---|---|"]
        for g in p.gates:
            mark = "—" if not g.ran else ("pass" if g.passed else "**FAIL**")
            ev = g.evidence.replace("\n", " ").replace("|", "\\|") or "—"
            out.append(
                f"| `{g.slug}` | {mark} | {_stamp(g.ts)} | {g.machine or '—'} | {ev} |"
            )
        out.append("")
        unrun = [g for g in p.gates if not g.ran]
        if unrun:
            out += ["Not yet measured — each is a command, not an opinion:", ""]
            out += [f"- `{g.slug}` → `{g.verify_cmd or 'no command recorded'}`" for g in unrun]
            out.append("")

    decisions = cur.decisions()
    superseded = [d for d in cur.decisions(include_superseded=True) if d["superseded_by"]]
    out += ["## Decisions in force", ""]
    for dec in decisions:
        out.append(
            f"- **{dec['slug']}** — {dec['title']}  ·  _{_stamp(dec['decided_at'])}_"
        )
        if dec["body"]:
            out.append(f"  <br>{dec['body']}")
    out.append("")
    if superseded:
        out += [
            "### Superseded — kept on purpose",
            "",
            "The useful record is not the current value but the chain that reached it.",
            "",
        ]
        by_id = {d["id"]: d for d in cur.decisions(include_superseded=True)}
        for dec in superseded:
            newer = by_id.get(dec["superseded_by"], {}).get("slug", "?")
            out.append(
                f"- ~~**{dec['slug']}** — {dec['title']}~~ → superseded by **{newer}**"
            )
        out.append("")

    open_q = cur.questions(status="open")
    closed_q = cur.questions(status="closed")
    out += ["## Open questions", ""]
    if open_q:
        for q in open_q:
            out.append(f"- **{q['slug']}** — {q['question']}  ·  _opened {_stamp(q['opened_at'])}_")
    else:
        out.append("_None open._")
    out.append("")
    if closed_q:
        out += ["### Closed", ""]
        for q in closed_q:
            out.append(f"- **{q['slug']}** — {q['question']}")
            if q["resolution"]:
                out.append(f"  <br>✅ {q['resolution']}  ·  _{_stamp(q['closed_at'])}_")
        out.append("")

    out += [
        "---",
        "",
        "> A results file with only successes is a marketing document.",
        "> **Write down what failed.**",
        "",
    ]
    return "\n".join(out)
