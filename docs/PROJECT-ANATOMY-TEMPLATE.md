# Project anatomy — a reusable template

A one-page diagram that answers *"what is this project and what does it do"* for
someone who has never seen it — including you, in six months.

It is **not** a UML class diagram. Class diagrams describe types; this describes a
**system**: who drives it, how you reach it, what protects it, what the code is, what it
remembers, what it runs on, and how far along it is. Those seven questions are the same
for every project, which is what makes it a template.

Rendered example: ULTRON. Source of the facts in it: `git log`, the test suite, the ADRs.

---

## The seven bands

Fill top to bottom. Each band is one horizontal row of boxes.

| # | Band | The question it answers | ULTRON's answer |
|---|---|---|---|
| 1 | **Actors** | Who or what initiates work? | You, agent sessions, the TUF trainer, a cron |
| 2 | **Surfaces** | How is it reached? | CLI (16 commands), HTTP API + SPA |
| 3 | **Guards** | What must a request survive first? | SecurityGuard C1–C6, then AuthGuard C7–C12 |
| 4 | **Core** | What is the code, grouped by job? | monitoring · record · domain |
| 5 | **State** | What does it remember, and how safely? | one SQLite file, WAL + `synchronous=FULL` |
| 6 | **Substrate** | What does it physically run on? | Mac 48 GB ↔ Tailscale ↔ TUF 4 GB |
| 7 | **Pipeline** | What is the ordered domain flow, and where are you? | 11 phases, one done, two active |

**Bands 3 and 7 are the ones people skip, and they carry the most information.**

A project with no Guards band has no trust boundary, which is worth seeing on a page. And
Band 7 is the only band that changes week to week — it is the difference between a diagram
that documents architecture and one that reports *status*.

### Band 7 has one rule

**Status marks must come from evidence, not from memory.** ULTRON derives them from
`gate_results` rows, so a phase reads `done` only when every gate has a passing result and
an unmeasured gate reads `blocked`. Before that, the hand-maintained `STATUS.md` had drifted
into asserting a reversed Python version and "nothing measured yet" against two committed
benchmark sweeps.

If your project has no gate table, the cheap substitute is a **command per phase**: write the
command that proves the phase, run it, and mark from the exit code. A mark you typed is a
guess with a tick next to it.

---

## Gathering the facts

Run this in a project root. It is the input to the diagram, and it is deliberately
mechanical — the point is that the diagram reports the repository rather than your
recollection of it.

```bash
echo "── size ──"
find . -name "*.py" -o -name "*.ts" -o -name "*.tsx" | grep -vE "node_modules|/\.?venv/|/build/|/dist/" | wc -l
echo "── entry points (band 2) ──"
grep -rln "argparse\|click\|typer\|FastAPI\|Flask\|express\|__main__" --include="*.py" --include="*.ts" . 2>/dev/null | grep -vE "node_modules|venv" | head
echo "── persistence (band 5) ──"
grep -rlnE "CREATE TABLE|sqlalchemy|prisma|mongoose|redis|\.parquet|\.csv" --include="*.py" --include="*.ts" --include="*.sql" . 2>/dev/null | grep -vE "node_modules|venv" | head
echo "── trust boundary (band 3) ──"
grep -rlnE "auth|token|login|CORS|middleware|@requires|permission" --include="*.py" --include="*.ts" . 2>/dev/null | grep -vE "node_modules|venv|test" | head
echo "── external services (band 6) ──"
grep -rhoE "https?://[a-zA-Z0-9./_-]+|localhost:[0-9]+" --include="*.py" --include="*.ts" --include="*.env.example" . 2>/dev/null | sort -u | head
echo "── decisions worth a band caption ──"
ls docs/adr/ ADR* 2>/dev/null; sed -n '1,15p' README.md 2>/dev/null
```

**What the survey cannot tell you** is Band 7 — the ordered flow and how far along it is.
That comes from a human, and it is the part worth the most.

---

## Layout arithmetic

The rendering rules that make it fit, learned by getting them wrong:

- `viewBox="0 0 680 H"` — **680 is load-bearing.** With `width="100%"` any other width
  rescales every font. Narrow content gets centred, not a narrower viewBox.
- Safe area `x=40..640`. Height `H = (bottom-most element) + 40`.
- **Two font sizes only.** 14px for titles (`class="th"`), 12px for subtitles (`class="ts"`).
- **Box width from the longest line:** `w = max(title_chars × 8, subtitle_chars × 7) + 24`.
  Check every box. Overflow is the most common failure.
- Row of *n* boxes: `n × w + (n−1) × gap ≤ 600`.
- `stroke-width="0.5"`, `rx="8"`.
- **Colour encodes category, never sequence.** Three or four ramps, each meaning one thing.
  ULTRON: gray = structural (actors, hardware), purple = code, coral = trust boundary,
  teal = persistent state. Apply `c-{ramp}` to the `<g>` that directly holds the shapes —
  nest it and children render black.

Box internals at `h=48`: title baseline `y+22`, subtitle `y+38`.

---

## Skeleton

Replace the bracketed parts. Band captions carry the *insight*; box labels carry the *fact*.

```
<text class="th" x="40" y="40">[PROJECT] — [what it is in eight words]</text>
<text class="ts" x="40" y="58">[the constraint or goal that explains every later choice]</text>

<text class="ts" x="40" y="88">ACTORS — [what is notable about who drives it]</text>
[up to 4 boxes: x=40,194,348,502  w=138  h=44]

<text class="ts" x="40" y="172">SURFACES — how you reach it</text>
[2 boxes: x=40,348  w=292  h=48]

<text class="ts" x="40" y="260">GUARDS — [the order, if order matters]</text>
[2 boxes: x=40,348  w=292  h=48]        ← omit the band if there is no boundary, and say so

<text class="ts" x="40" y="348">CORE — [module count, and the quality gate that holds]</text>
[3 boxes: x=40,245,450  w=190  h=84 — title + 3 lines]

<text class="ts" x="40" y="472">STATE — [what losing it would cost]</text>
[4 boxes: x=40,192,344,496  w=136  h=48]
<text class="ts" x="40" y="548">[durability settings, in one line]</text>

<text class="ts" x="40" y="578">SUBSTRATE — [why the split is what it is]</text>
[3 boxes: x=40 w=235 | x=290 w=100 (the link) | x=405 w=235]

<text class="ts" x="40" y="666">PIPELINE — [ordering rule].  ✓ done   ● active   ○ blocked</text>
[1 box: x=40 w=600 h=58, two lines of phases]
```

`H = 774` for the full seven bands. Drop a band and subtract its height plus 30.

---

## Two failure modes

**The diagram that flatters.** Every box present, every phase ticked, nothing marked
blocked. It is the same failure as a results file with only successes. If Band 7 has no
`○`, either the project is finished or the diagram is wrong.

**The diagram that decays.** Regenerate it from the survey rather than editing the SVG,
and cite where each number came from in the band caption. A number with no source is the
first thing to go stale, and the last thing anyone notices.
