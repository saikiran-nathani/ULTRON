# Building ULTRON — the implementation walkthrough

You have the field guide (`docs/ULTRON-Field-Guide.pptx`) for **why**, and the `TUF/` pack for
**what numbers to use**. This document is the missing third thing: **what to type, in what order,
and how to tell whether it worked.**

Read it like a new-hire onboarding doc. Work top to bottom. Do not skip ahead — every phase gate
exists because skipping it silently corrupts every number after it.

---


## Contents

- [Part 1 — Reconcile the repository](#part-1--reconcile-the-repository)
    - [Step 1.1 — See the divergence for yourself](#step-11--see-the-divergence-for-yourself)
    - [Step 1.2 — Move the untracked `.gitignore` aside](#step-12--move-the-untracked-gitignore-aside)
    - [Step 1.3 — Fast-forward](#step-13--fast-forward)
    - [Step 1.4 — Reconcile the two ignore files](#step-14--reconcile-the-two-ignore-files)
    - [Step 1.5 — Resolve the duplicate dependency specs](#step-15--resolve-the-duplicate-dependency-specs)
    - [Step 1.6 — Stop tracking `.DS_Store`](#step-16--stop-tracking-dsstore)
    - [Step 1.7 — Commit and push](#step-17--commit-and-push)
- [Part 2 — Environment on both machines](#part-2--environment-on-both-machines)
    - [Step 2.1 — Install uv (both machines)](#step-21--install-uv-both-machines)
    - [Step 2.2 — Mac environment](#step-22--mac-environment)
    - [Step 2.3 — TUF environment](#step-23--tuf-environment)
    - [Step 2.4 — The gate](#step-24--the-gate)
- [Part 3 — Phase 0: the sandbox (already built — verify and extend)](#part-3--phase-0-the-sandbox-already-built--verify-and-extend)
    - [Step 3.1 — Read the contract before using it](#step-31--read-the-contract-before-using-it)
    - [Step 3.2 — Run the adversarial suite](#step-32--run-the-adversarial-suite)
    - [Step 3.3 — Know the one platform difference](#step-33--know-the-one-platform-difference)
    - [Step 3.4 — Smoke-test it by hand](#step-34--smoke-test-it-by-hand)
- [Part 4 — Phase 1: the eval harness (THE CURRENT BLOCKER)](#part-4--phase-1-the-eval-harness-the-current-blocker)
    - [Step 4.1 — Create `src/eval/tasks.py`](#step-41--create-srcevaltaskspy)
    - [Step 4.2 — Create `src/eval/generate.py`](#step-42--create-srcevalgeneratepy)
    - [Step 4.3 — Create `src/eval/harness.py`](#step-43--create-srcevalharnesspy)
    - [Step 4.4 — Understand the trap this encodes](#step-44--understand-the-trap-this-encodes)
    - [Step 4.5 — Build a small dev task file](#step-45--build-a-small-dev-task-file)
    - [Step 4.6 — Run it](#step-46--run-it)
- [Part 5 — Phase 2: the baseline](#part-5--phase-2-the-baseline)
    - [Step 5.1 — Freeze the test split now](#step-51--freeze-the-test-split-now)
    - [Step 5.2 — Baseline the student, three seeds](#step-52--baseline-the-student-three-seeds)
    - [Step 5.3 — Write the results file by hand](#step-53--write-the-results-file-by-hand)
- [Part 6 — Phase 3: the data pipeline](#part-6--phase-3-the-data-pipeline)
    - [Step 6.1 — `src/data/download.py`](#step-61--srcdatadownloadpy)
    - [Step 6.2 — `src/data/filter.py` — cheapest filters first](#step-62--srcdatafilterpy--cheapest-filters-first)
    - [Step 6.3 — `src/data/decontaminate.py` — run this before EVERY training run](#step-63--srcdatadecontaminatepy--run-this-before-every-training-run)
    - [Step 6.4 — `src/data/dedup.py`](#step-64--srcdatadeduppy)
    - [Step 6.5 — The ablation that justifies the phase](#step-65--the-ablation-that-justifies-the-phase)
- [Part 7 — Phase 4: SFT](#part-7--phase-4-sft)
    - [Step 7.1 — Write `configs/sft-0.5b.yaml` FIRST](#step-71--write-configssft-05byaml-first)
    - [Step 7.2 — Write `src/train/sft.py`](#step-72--write-srctrainsftpy)
- [and in the environment, before you launch:](#and-in-the-environment-before-you-launch)
- [PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True](#pytorchcudaallocconfexpandablesegmentstrue)
    - [Step 7.3 — ⚠️ Loss masking — the bug that silently wastes a week](#step-73---loss-masking--the-bug-that-silently-wastes-a-week)
    - [Step 7.4 — The ten-step canary](#step-74--the-ten-step-canary)
    - [Step 7.5 — Full run, then evaluate](#step-75--full-run-then-evaluate)
    - [Step 7.6 — When the eval will not move](#step-76--when-the-eval-will-not-move)
- [Part 8 — Phase 5: rejection sampling / RFT](#part-8--phase-5-rejection-sampling--rft)
    - [Step 8.1 — `src/teacher/generate.py`](#step-81--srcteachergeneratepy)
    - [Step 8.2 — The loop](#step-82--the-loop)
    - [Step 8.3 — ⚠️ Difficulty collapse — the failure that kills round 2](#step-83---difficulty-collapse--the-failure-that-kills-round-2)
- [Part 9 — Phase 6: DPO](#part-9--phase-6-dpo)
    - [Step 9.1 — Build pairs from what you already have](#step-91--build-pairs-from-what-you-already-have)
    - [Step 9.2 — Track verbosity on every run](#step-92--track-verbosity-on-every-run)
- [Part 10 — Phase 7: GRPO / RLVR](#part-10--phase-7-grpo--rlvr)
    - [Step 10.1 — The reward function is `ExecResult.fraction`](#step-101--the-reward-function-is-execresultfraction)
    - [Step 10.2 — Wire the flags into the penalty](#step-102--wire-the-flags-into-the-penalty)
    - [Step 10.3 — Read your rollouts. Every run.](#step-103--read-your-rollouts-every-run)
- [Part 11 — Phase 8: self-repair](#part-11--phase-8-self-repair)
- [Part 12 — Phases 9–10: merge, quantize, serve](#part-12--phases-910-merge-quantize-serve)
- [Appendix A — Daily working rhythm](#appendix-a--daily-working-rhythm)
- [Appendix B — Where to look when it breaks](#appendix-b--where-to-look-when-it-breaks)
- [Appendix C — Corrections to `TUF/STATUS.md` worth acting on](#appendix-c--corrections-to-tufstatusmd-worth-acting-on)

---

## How the four document sets relate

Keep these straight or you will duplicate work or, worse, follow stale numbers.

| Document | Answers | When you open it |
|---|---|---|
| `docs/ULTRON-Field-Guide.pptx` (191 slides) | **Why** each technique works, and the traps | Before starting a phase, to understand it |
| `TUF/05-CONFIGS.md` (774 lines) | **Every training number** — LRs, batch, rank, reward design | When filling in a config. Do not re-derive these. |
| `TUF/06-DEBUG.md` · `07-TRAPS.md` | **It broke** — five playbooks, trap index | When something fails |
| `TUF/01-SETUP.md` · `docs/WINDOWS-TO-UBUNTU.md` | **Machine setup**, Ubuntu → training box | Once, per machine |
| `TUF/STATUS.md` | **Where the project actually is right now** | First thing each session. Update it last thing. |
| **This file** | **Which file to write next, and its code** | Continuously, while building |

**Rule:** this document never restates a hyperparameter. It tells you which file to create and
points at `TUF/05-CONFIGS.md` for the values. One source of truth per fact.

---

## The five laws

1. **The sandbox and the eval harness come before any training code.** They are the ruler. A
   bent ruler makes every subsequent measurement a lie.
2. **Decontaminate before every run**, not once at the start.
3. **One variable per experiment.** Every run gets a committed config file. A config that is not
   committed did not happen.
4. **Three seeds minimum** before you believe an improvement. 164 problems is high variance.
5. **Read your rollouts.** Reward hacking is invisible in aggregate metrics and obvious in twenty
   samples.

## The pipeline order — not negotiable

```
sandbox → eval harness → baseline → data curation → SFT → RFT → DPO → GRPO → self-repair → merge → serve
```

## Which machine does what

| Work | Machine | Why |
|---|---|---|
| Writing code, data pipeline, dedup, decontamination | **Mac** | RAM-bound; 48 GB beats 14 GB |
| Teacher generation (32B) | **Mac** | 4 GB cannot hold a 32B model |
| Eval harness, bulk sandbox execution | **Either** — Mac to iterate, TUF for bulk | TUF has 8 cores and cheap containers |
| **All QLoRA training, all RL** | **TUF** | Only CUDA box |
| Merging, quantization | **Mac** | CPU work |

---

# Part 1 — Reconcile the repository

**Goal:** one trunk containing all existing work, so "which version is real" never costs you an hour.

**Why:** your checked-out `master` is **7 commits behind `integration/tuf-merge`**, which already
contains ~1,700 lines of working, tested Python. Building on `master` would mean rewriting a
sandbox that already passes 19 adversarial tests.

### Step 1.1 — See the divergence for yourself

```bash
cd "/Users/sai_kiran/MacBook Pro/Projects/PycharmProjects/ULTRON"
```

```bash
git fetch origin && git rev-list --left-right --count master...origin/integration/tuf-merge
```

**Expected:** `0	7` — zero commits unique to master, seven on the integration branch. Because
master is 0 ahead, this is a **fast-forward**: no merge conflicts are possible.

### Step 1.2 — Move the untracked `.gitignore` aside

**Why:** your working tree has an untracked `.gitignore`, and the incoming branch tracks a
different one at the same path. Git refuses to clobber untracked files. This is the *only*
thing blocking the merge — verified by dry run.

```bash
mv .gitignore .gitignore.mac-local
```

### Step 1.3 — Fast-forward

```bash
git merge origin/integration/tuf-merge
```

**Expected:** `Updating e2f851d..382014a` followed by ~30 `create mode` lines.

**If it fails** with "untracked working tree files would be overwritten": something else
collides. Read the filenames it lists, move each aside, retry. Do not use `-f`.

### Step 1.4 — Reconcile the two ignore files

You now have `.gitignore` (from the branch) and `.gitignore.mac-local` (yours). They differ in
useful ways: yours has the model-weights block and the comment explaining why `data/**/*.jsonl`
is scoped; the branch's has `requirements.lock.txt` and the `.gitkeep` negation patterns.

```bash
diff .gitignore.mac-local .gitignore
```

Merge by hand into a single `.gitignore` keeping **both** sets of rules, then:

```bash
rm .gitignore.mac-local && git add .gitignore
```

### Step 1.5 — Resolve the duplicate dependency specs

After the merge you have **both** `requirements/` (your 5-file split, with a resolved Mac
lockfile) and `requirements.txt` (the TUF branch's single file). They disagree: the split
prescribes `pip install torch --index-url .../cu128`, the single file argues against it.

**Decision: keep `requirements/`, delete `requirements.txt`.** The split is strictly better —
it separates machine-agnostic deps from CUDA-only and Metal-only, and prevents a bulk
`pip install -r` from clobbering the CUDA torch wheel.

```bash
git rm requirements.txt
```

### Step 1.6 — Stop tracking `.DS_Store`

Both were committed in `init`, before the `.gitignore` existed.

```bash
git rm --cached .DS_Store docs/.DS_Store
```

### Step 1.7 — Commit and push

```bash
git add -A && git commit -m "Merge integration/tuf-merge; unify gitignore and dependency specs"
```

```bash
git push origin master
```

**Done when:** `git status` is clean, `ls src/sandbox/executor.py src/eval/pass_at_k.py`
succeeds, and `git rev-list --count master...origin/integration/tuf-merge` prints `0`.

---

# Part 2 — Environment on both machines

**Goal:** both machines pass `scripts/smoke_test.py`.

**Why:** every phantom bug you will chase for the next three months starts here. Two hours now
saves two days later.

**Standard:** `uv` + venv + **Python 3.12** on both machines. Not conda — the `requirements/`
split assumes pip. Not 3.14 — bitsandbytes and unsloth may have no wheels for it, forcing source
builds on the machine least able to afford them.

> `CLAUDE.md` §9 still says conda + 3.11. It is stale; this document supersedes it. Fix §9 when
> you next touch that file.

### Step 2.1 — Install uv (both machines)

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

### Step 2.2 — Mac environment

```bash
cd "/Users/sai_kiran/MacBook Pro/Projects/PycharmProjects/ULTRON" && uv venv --python 3.12 .venv && source .venv/bin/activate
```

```bash
uv pip install -r requirements/mac.txt
```

### Step 2.3 — TUF environment

Torch first and alone, so nothing clobbers the CUDA wheel:

```bash
uv venv --python 3.12 .venv && source .venv/bin/activate
```

```bash
uv pip install torch --index-url https://download.pytorch.org/whl/cu128
```

```bash
python -c "import torch; print(torch.__version__, torch.version.cuda, torch.cuda.get_device_capability())"
```

**Expected:** `(8, 6)` — Ampere `sm_86`. That is what tells you bf16, TF32 and FA2 are available.

**Only then** the rest — `requirements/cuda.txt` deliberately omits torch:

```bash
uv pip install -r requirements/cuda.txt
```

### Step 2.4 — The gate

```bash
python scripts/smoke_test.py
```

This script already exists and detects which machine it is on. On the Mac it asserts CUDA is
**absent** and MLX works; on the TUF it asserts `torch.cuda.is_available()`, bf16 support,
bitsandbytes and unsloth.

**Done when:** exit code 0 on both machines. Do not proceed on a partial pass.

**If bitsandbytes fails:** `python -m bitsandbytes` prints a real diagnostic. Almost always a
version mismatch against torch's CUDA build — reinstall bitsandbytes *after* torch, never before.

---

# Part 3 — Phase 0: the sandbox (already built — verify and extend)

**Goal:** understand the trust boundary you already own, prove it still holds, and add the
reward-hacking flags GRPO will need.

**Why:** `src/sandbox/executor.py` is the most reused file in this project. It is your test
runner in Phase 1, your filter in Phase 5, your **reward function** in Phase 7, and your
traceback source in Phase 8. Everything downstream reads its result schema.

### Step 3.1 — Read the contract before using it

```bash
sed -n '1,120p' src/sandbox/executor.py
```

The API you will call everywhere:

```python
from src.sandbox.executor import run, ExecResult

result = run(code, tests, wall_s=15, cpu_s=10, mem_mb=512, fsize_mb=16)
```

`tests` is a **list of independent snippets**, each scored separately. Each is exec'd with the
solution module's namespace in scope, so a snippet can call the solution's functions directly.
A bare string counts as one test.

The result schema, and why each field exists:

| Field | Used by |
|---|---|
| `status` — `pass\|fail\|timeout\|error\|crash` | everything |
| `passed` / `total` / **`fraction`** | **Phase 7 GRPO — this is your dense reward** |
| `traceback` | **Phase 8 self-repair — this is the model's input** |
| `flags` — `read_test_file`, `net_attempt`, `syntax_error` | **Phase 7 reward-hacking detection** |
| `wall_ms` / `cpu_ms` | throughput budgeting |

Two design decisions worth internalising, because you will be tempted to undo both:

- **`ast.parse` runs before spawning anything.** ~0.1 ms rejects a meaningful fraction of
  generations instead of paying ~50 ms for a process that cannot run.
- **Scoring reads a JSON report, never the exit status.** A generated `sys.exit(0)` must not be
  able to fake a pass. This is the single most important line in the file.

### Step 3.2 — Run the adversarial suite

```bash
python -m pytest src/sandbox/tests/test_adversarial.py -v
```

**Expected:** 19 passed. Fork bomb, memory bomb, orphan subprocess, process-group escape,
`SystemExit` swallowing, reading the test file, network egress, filesystem escape, disk fill,
env scrubbing, traceback capture.

**Done when:** 19/19 green on the machine you will actually run bulk execution on.

### Step 3.3 — Know the one platform difference

`current_user_threads()` reads `/proc`, which does not exist on macOS — it falls back to `4096`.
So `RLIMIT_NPROC` is accurate on the TUF and approximate on the Mac. Fine for development;
worth remembering if a fork-bomb test behaves differently across machines.

### Step 3.4 — Smoke-test it by hand

```bash
python -c "
from src.sandbox.executor import run
r = run('def add(a,b): return a+b', ['assert add(1,2)==3', 'assert add(0,0)==0', 'assert add(1,1)==9'])
print(r.status, r.passed, '/', r.total, 'fraction=', r.fraction, r.flags)
"
```

**Expected:** `fail 2 / 3 fraction= 0.666... []` — note it reports a *fraction*, not a boolean.
That gradient is what makes GRPO learnable.

**Done when:** you can explain why `fraction` matters more than `ok` for Phase 7.

---

# Part 3.5 — Audit the inherited code before you trust it ⚠️

**Goal:** verify the code you did not write, and apply four fixes it needs.

**Why:** `TUF/STATUS.md` reports "19/19 green" — true, **on Linux**. Run the same suite on the
Mac and you get **1 passed, 17 failed**. Three further defects are invisible to the existing
suite. The executor becomes your GRPO reward function, so each of these silently corrupts every
number downstream.

Everything below was measured, not inferred.

### What is verified CORRECT — trust these

| Component | Verification |
|---|---|
| `src/eval/pass_at_k.py` | Checked exhaustively for all `n<=40` and every `(c,k)` — **22,960 cases, all match exact combinatorics**. Monte Carlo (200k trials) agrees to 4 decimals. `mean_std` matches `statistics.stdev` exactly. Correctly raises when `k>n` rather than silently reporting a smaller k. |
| `src/eval/extract.py` | Handles clean fences, prose-wrapped, multi-block (prefers last), unfenced, unterminated, empty, and syntactically-broken output. Distinguishes `ok` / `ok_unfenced` / `ok_unterminated_fence` / `extract_fail`. |
| `executor.py` design | Dual timeouts, `setsid`+`killpg`, env allowlist, scoring from the report and never the exit code, `ast.parse` fast-fail. All sound. |

### Fix 1 — Add the missing `__init__.py`

`src/` itself is not a package, so `from src.eval.pass_at_k import ...` raises
`ModuleNotFoundError`. Every import in this guide depends on it:

```bash
touch src/__init__.py src/data/__init__.py src/train/__init__.py
```

### Fix 2 — `RLIMIT_AS` is unsupported on macOS ⚠️

**Symptom:** every single `run()` on the Mac fails with
`subprocess.SubprocessError: Exception occurred in preexec_fn`. Measured: **17 of 18 tests fail**.

**Cause:** Darwin raises `ValueError: current limit exceeds maximum limit` for `RLIMIT_AS`.
Every other limit (CPU, NPROC, FSIZE, CORE) works fine.

In `src/sandbox/executor.py`, in `_limits()`, replace the bare `RLIMIT_AS` call with:

```python
try:
    resource.setrlimit(resource.RLIMIT_AS, (mem_mb << 20, mem_mb << 20))
except (ValueError, OSError):
    # macOS/Darwin does not support RLIMIT_AS -- it raises
    # "current limit exceeds maximum limit". RLIMIT_DATA is the nearest
    # equivalent there; on Linux this except branch never fires.
    try:
        resource.setrlimit(resource.RLIMIT_DATA, (mem_mb << 20, mem_mb << 20))
    except (ValueError, OSError):
        pass
```

**Result: 17 of 18 pass.** The remaining failure is Fix 3.

### Fix 3 — Memory containment does not work on macOS at all

Even with the fallback, `RLIMIT_DATA` does not cap allocation the way `RLIMIT_AS` does on Linux.
A memory bomb is **not** contained — it runs until the wall clock kills it, allocating the whole
time. Measured: `x = [0] * 10**10` with `mem_mb=256` ran a full 15 s and returned
`status="timeout"`, not `error`.

There is no clean userspace fix. Accept the limitation and **route consequences accordingly**:

> **Run untrusted bulk execution on the TUF, not the Mac.** On Linux you get real memory
> containment; on macOS you get wall-clock containment only. This contradicts `CLAUDE.md` §4,
> which assigns "eval harness + sandbox execution" to the Mac — amend it. Use the Mac to
> *develop* the harness against trusted code, and the TUF to *run* it against model output.

### Fix 4 — `fs_read_outside_cwd` fires on EVERY failing solution ⚠️

**The most damaging of the four, because it silently poisons the GRPO reward.**

Measured, before the fix:

| Solution | Flags raised |
|---|---|
| Correct | `[]` |
| **Plainly wrong, does no I/O** | **`['fs_read_outside_cwd']`** |
| **Raises `ValueError`, does no I/O** | **`['fs_read_outside_cwd']`** |

**Cause:** `traceback.format_exc()` opens source files to render frames, and the audit hook is
still armed when it runs. So the flag fires on ~100% of failures and is useless as a hacking
signal. Part 10 tells you to penalise flags hard — with this bug you would penalise every
failure twice, teaching the model that failing a test is a filesystem crime.

In `src/sandbox/_runner.py`, disarm **before** formatting:

```python
except BaseException:
    # Disarm FIRST: traceback.format_exc() opens source files to render frames,
    # which would otherwise raise a spurious fs_read_outside_cwd on every
    # ordinary test failure and poison the GRPO reward.
    _STATE["armed"] = False
    tracebacks.append(f"[test {i}] " + traceback.format_exc(limit=6))
```

### Fix 5 — The `__eq__` reward hack defeats the sandbox completely ⚠️⚠️

**Measured, before the fix:** `status="pass"`, `fraction=1.0`, **flags empty**.

```python
class Always:
    def __eq__(self, other): return True
def solve(*a, **k): return Always()
```

Every assertion of the form `assert f(x) == expected` is now true **for any return value**. The
solution scores a perfect 1.0 having implemented nothing. A `list` subclass overriding `__eq__`
works identically. This is not in the adversarial suite, and it is among the first things a GRPO
policy discovers.

In `src/sandbox/_runner.py`, before the final `_write`:

```python
# A solution that defines __eq__/__ne__ can make `assert f(x) == expected` true for
# ANY return value. It scores 1.0 while learning nothing, and it is the first thing
# a GRPO policy discovers. Flag it; the reward function must penalise it.
for _obj in ns.values():
    if isinstance(_obj, type) and ("__eq__" in vars(_obj) or "__ne__" in vars(_obj)):
        _flag("eq_override")
        break
```

**In Part 10, treat `eq_override` as a hard zero, not a small penalty.** A solution carrying it
has not solved anything.

### Verify the fixes

```bash
python -m pytest src/sandbox/tests/test_adversarial.py -q --deselect src/sandbox/tests/test_adversarial.py::test_fork_bomb_is_contained
```

**Expected on the Mac:** 17 passed, 1 failed (the memory bomb — Fix 3, unavoidable here).
**Expected on the TUF:** 19 passed. Run the full suite there, including the fork bomb.

> ⚠️ **Do not run the fork-bomb test on the Mac.** It sizes `nproc` from
> `current_user_threads()`, which reads `/proc` — absent on macOS, so it falls back to **4096**
> and would permit ~4,100 forked processes. Linux only.

Then confirm the flag behaviour directly:

```bash
python -c "
import sys; sys.path.insert(0,'.')
from src.sandbox.executor import run
T=['assert solve(1)==2','assert solve(2)==4']
for name, code in [('correct','def solve(x): return x*2'),('wrong','def solve(x): return x*3'),('eq-hack','class A:
    def __eq__(s,o): return True
def solve(x): return A()')]:
    r=run(code,T,wall_s=8,cpu_s=4,mem_mb=256); print(f'{name:<8} {r.status:<6} {r.fraction:.2f} {r.flags}')
"
```

**Expected:** `correct pass 1.00 []` · `wrong fail 0.00 []` · `eq-hack pass 1.00 ['eq_override']`

### Known, accepted, not fixed

**Cross-test state leakage.** The runner copies the solution namespace with `dict(ns)` — a
*shallow* copy — so a module-level mutable is shared across tests. Measured: a solution
accumulating into a module-level list scored `fraction=0.667` by answering differently on each
call. It cannot fake a pass, so it is a correctness wart rather than a security hole. Deep-copying
the namespace per test would be correct but costs real time on millions of executions. Left as is
— be aware it exists if a dense reward ever looks strange.

**Done when:** 17/18 on the Mac, 19/19 on the TUF, and the three-line flag check above prints
exactly the expected output.

---

# Part 4 — Phase 1: the eval harness (THE CURRENT BLOCKER)

**Goal:** one command that produces a reproducible pass@1 ± std across three seeds.

**Why:** `TUF/STATUS.md` records this as the gate the project is standing on. The primitives
(`pass_at_k.py`, `extract.py`) are built and self-checking. **Nothing calls them.** Until this
exists you cannot produce a baseline, and without a baseline every later number is meaningless.

### Step 4.1 — Create `src/eval/tasks.py`

**Goal:** load problems in one shape, so the harness never branches on where a problem came from.

**Why the strictness below:** a silently skipped malformed line changes your denominator, which
changes your score, and you will never notice. Fail loudly instead.

```python
"""Task loading. One shape for every problem source."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class Task:
    task_id: str
    prompt: str                       # what the model sees
    tests: list[str]                  # independent snippets -> dense reward
    entry_point: str = ""             # function name, for extraction checks
    split: str = "dev"                # dev | test -- test is opened ONCE
    meta: dict = field(default_factory=dict)


def load_jsonl(path: str | Path) -> list[Task]:
    tasks: list[Task] = []
    with open(path) as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError as exc:
                raise ValueError(f"{path}:{lineno} invalid JSON: {exc}") from exc
            missing = {"task_id", "prompt", "tests"} - d.keys()
            if missing:
                raise ValueError(f"{path}:{lineno} missing keys: {sorted(missing)}")
            if not isinstance(d["tests"], list) or not d["tests"]:
                raise ValueError(f"{path}:{lineno} 'tests' must be a non-empty list")
            tasks.append(Task(**d))
    if not tasks:
        raise ValueError(f"{path} contained no tasks")
    return tasks


def split(tasks: list[Task], which: str) -> list[Task]:
    return [t for t in tasks if t.split == which]
```

### Step 4.2 — Create `src/eval/generate.py`

**Goal:** one generation interface, two backends — HF transformers (the student, on the TUF) and
ollama (the 32B teacher, on the Mac).

**Why one interface:** the harness must not care which backend produced a completion. You will
swap backends constantly — base model, adapter, merged model, teacher — and the harness code
should never change.

⚠️ **The reasoning-model trap, measured this session.** `qwen3.5:9b` returns an **empty**
`response` field with its chain-of-thought in a separate `thinking` field. With a 700-token
budget it exhausted the whole budget mid-thought and returned nothing — producing a fake 33%
pass@1 that was really "how often did it finish thinking." Always pass `think=False` and
**always count truncations**. An uninstrumented harness will lie to you.

```python
"""Generation backends. The harness never learns which one it is talking to."""
from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass


@dataclass
class Completion:
    text: str
    n_tokens: int = 0
    truncated: bool = False           # done_reason == "length" -- MUST be tracked


class OllamaBackend:
    """For the 32B teacher on the Mac."""

    def __init__(self, model: str, host: str = "http://localhost:11434", think: bool | None = False):
        self.model, self.host, self.think = model, host, think

    def generate(self, prompt: str, *, max_tokens: int = 900, temperature: float = 0.2,
                 seed: int | None = None) -> Completion:
        payload = {
            "model": self.model, "prompt": prompt, "stream": False,
            "options": {"num_predict": max_tokens, "temperature": temperature,
                        "num_ctx": 8192, **({"seed": seed} if seed is not None else {})},
        }
        if self.think is not None:
            payload["think"] = self.think          # reasoning models: OFF for generation
        req = urllib.request.Request(
            f"{self.host}/api/generate", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=1800) as r:
            d = json.loads(r.read())
        return Completion(
            text=d.get("response", ""),
            n_tokens=d.get("eval_count", 0),
            truncated=d.get("done_reason") == "length",
        )


class HFBackend:
    """For the student on the TUF. Loads once, generates many."""

    def __init__(self, model_id: str, adapter: str | None = None, load_in_4bit: bool = True):
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer

        self.tok = AutoTokenizer.from_pretrained(model_id)
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        kwargs = {"dtype": torch.bfloat16, "device_map": "auto"}   # bf16 ALWAYS, never fp16
        if load_in_4bit:
            from transformers import BitsAndBytesConfig
            kwargs["quantization_config"] = BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True)
        self.model = AutoModelForCausalLM.from_pretrained(model_id, **kwargs)
        if adapter:
            from peft import PeftModel
            self.model = PeftModel.from_pretrained(self.model, adapter)
        self.model.eval()

    def generate(self, prompt: str, *, max_tokens: int = 900, temperature: float = 0.2,
                 seed: int | None = None) -> Completion:
        import torch
        if seed is not None:
            torch.manual_seed(seed)
        ids = self.tok(prompt, return_tensors="pt").to(self.model.device)
        n_in = ids["input_ids"].shape[-1]
        with torch.no_grad():
            out = self.model.generate(
                **ids, max_new_tokens=max_tokens, do_sample=temperature > 0,
                temperature=temperature if temperature > 0 else None,
                top_p=0.95, pad_token_id=self.tok.pad_token_id)
        new = out[0][n_in:]
        return Completion(
            text=self.tok.decode(new, skip_special_tokens=True),
            n_tokens=len(new),
            truncated=len(new) >= max_tokens,
        )
```

### Step 4.3 — Create `src/eval/harness.py`

**Goal:** tasks + backend → `pass@k` with per-seed standard deviation, plus the diagnostic
counters that tell you whether the number is trustworthy.

**Why the counters matter more than the score:** a pass@1 of 40% means nothing until you know
whether 30% of generations failed to *extract*. That is a prompt-format bug, not a capability
measurement, and it is the single most common way an eval lies.

```python
"""The driver. Ties tasks + backend + extraction + sandbox + pass@k together."""
from __future__ import annotations

import json
from collections import Counter
from dataclasses import dataclass, field, asdict
from pathlib import Path

from src.eval.extract import extract_code, truncate_at_stops
from src.eval.pass_at_k import pass_at_k_over_problems, mean_std, format_score
from src.eval.tasks import Task
from src.sandbox.executor import run as sandbox_run


@dataclass
class EvalReport:
    model: str
    n_tasks: int
    n_samples: int
    seeds: list[int]
    pass_at_1: float = 0.0
    pass_at_1_std: float = 0.0
    pass_at_k: dict[int, float] = field(default_factory=dict)
    extraction_failures: int = 0        # prompt/format bug, NOT capability
    truncations: int = 0                # max_tokens too low
    sandbox_status: dict = field(default_factory=dict)
    flagged: dict = field(default_factory=dict)   # reward-hacking signals
    per_task: list = field(default_factory=list)

    def summary(self) -> str:
        return (f"{self.model}: pass@1 {self.pass_at_1:.1%} +/- {self.pass_at_1_std:.1%} "
                f"| extract-fail {self.extraction_failures} | trunc {self.truncations}")


def evaluate(tasks: list[Task], backend, *, n_samples: int = 1, seeds=(0, 1, 2),
             temperature: float = 0.2, max_tokens: int = 900, ks=(1,),
             wall_s: int = 15, mem_mb: int = 512) -> EvalReport:
    rep = EvalReport(model=getattr(backend, "model", backend.__class__.__name__),
                     n_tasks=len(tasks), n_samples=n_samples, seeds=list(seeds))
    status_counter, flag_counter = Counter(), Counter()
    per_seed_scores = []

    for seed in seeds:
        counts = []                                  # (n, c) per task, for unbiased pass@k
        for t in tasks:
            n_correct = 0
            for s in range(n_samples):
                comp = backend.generate(t.prompt, max_tokens=max_tokens,
                                        temperature=temperature, seed=seed * 1000 + s)
                if comp.truncated:
                    rep.truncations += 1
                ext = extract_code(truncate_at_stops(comp.text), prefer="last")
                # extract.py returns ok | ok_unfenced | ok_unterminated_fence | extract_fail.
                # All three "ok*" statuses are valid extractions -- only reject failures.
                if not ext.status.startswith("ok") or not ext.code.strip():
                    rep.extraction_failures += 1
                    status_counter["extract_fail"] += 1
                    continue
                res = sandbox_run(ext.code, t.tests, wall_s=wall_s, mem_mb=mem_mb)
                status_counter[res.status] += 1
                for f in res.flags:
                    flag_counter[f] += 1
                if res.status == "pass":
                    n_correct += 1
                rep.per_task.append({"seed": seed, "task_id": t.task_id,
                                     "status": res.status, "fraction": res.fraction,
                                     "flags": res.flags})
            counts.append((n_samples, n_correct))
        per_seed_scores.append(pass_at_k_over_problems(counts, 1))
        if n_samples > 1:
            for k in ks:
                if k <= n_samples:
                    rep.pass_at_k.setdefault(k, []).append(
                        pass_at_k_over_problems(counts, k))

    rep.pass_at_1, rep.pass_at_1_std = mean_std(per_seed_scores)
    rep.pass_at_k = {k: sum(v) / len(v) for k, v in rep.pass_at_k.items()} if rep.pass_at_k else {}
    rep.sandbox_status, rep.flagged = dict(status_counter), dict(flag_counter)
    return rep


def write_report(rep: EvalReport, path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(asdict(rep), indent=2))
```

### Step 4.4 — Understand the trap this encodes

The unbiased estimator in `pass_at_k.py` is `1 - C(n-c, k) / C(n, k)`. The tempting shortcut —
"probability at least one of k passed, assuming independence" — is **wrong**, and not by a
rounding error. Verified numerically:

| n=20, c=6, k=5 | Value |
|---|---|
| Naive `1-(1-c/n)^k` | 0.8319 |
| Correct unbiased estimator | **0.8709** |

Four points, always in the optimistic direction. Use the library function; never hand-roll it.

### Step 4.5 — Build a small dev task file

Write ~20 problems to `data/tasks/dev.jsonl`, one JSON object per line. Fields, with the
prompt shown expanded for readability (in the file it is a single JSON string with `\n`
escapes, and it should contain a fenced code block giving the function signature):

| Field | Value |
|---|---|
| `task_id` | `"merge_intervals"` |
| `prompt` | `"Merge overlapping intervals. Intervals touching at a point DO merge.\n\nComplete this function. Output ONLY a Python code block.\n\n<fence>python\ndef merge_intervals(intervals):\n<fence>"` |
| `tests` | `["assert merge_intervals([[1,3],[2,6]]) == [[1,6]]", "assert merge_intervals([]) == []"]` |
| `entry_point` | `"merge_intervals"` |
| `split` | `"dev"` |

Replace `<fence>` with three backticks. Keep each assertion as its own list element — that is
what makes `ExecResult.fraction` a dense reward rather than a boolean.

Validate the file before you trust it:

```bash
python -c "from src.eval.tasks import load_jsonl; ts=load_jsonl('data/tasks/dev.jsonl'); print(len(ts),'tasks,',sum(len(t.tests) for t in ts),'assertions')"
```

**Write your own problems rather than importing HumanEval.** Both your teacher and student have
likely memorised the public benchmarks, which compresses the measured gap between models and
tells you nothing about capability. Make each spec carry a detail that punishes skimming —
tie-breaks resolved alphabetically, "return the original if the encoding isn't shorter",
first-occurrence indices. That is exactly where a weaker model degrades.

### Step 4.6 — Run it

```bash
python -c "
from src.eval.tasks import load_jsonl
from src.eval.generate import OllamaBackend
from src.eval.harness import evaluate, write_report
tasks = load_jsonl('data/tasks/dev.jsonl')
rep = evaluate(tasks, OllamaBackend('qwen2.5-coder:32b'), n_samples=1, seeds=(0,1,2))
print(rep.summary()); write_report(rep, 'results/teacher-dev.json')
"
```

**Expected:** a pass@1 with a real std, `extract-fail 0`, `trunc 0`.

**If `extract-fail` > 5%:** your prompt is not eliciting a fenced code block. Fix the prompt,
not the extractor. **If `trunc` > 0:** raise `max_tokens`. **If both are 0 but the score looks
absurd:** print three raw completions and read them before touching anything else.

**Done when:** the same command run twice gives the same number, and `results/` has the JSON.

---

# Part 5 — Phase 2: the baseline

**Goal:** `results/00-baseline.md` — the number every later phase is measured against.

**Why:** without it, "the model improved" is an opinion.

### Step 5.1 — Freeze the test split now

Split your tasks `dev` / `test` and **do not look at `test` again** until the very end. Every
time you tune against a set, you burn a little of its ability to tell you the truth. `dev` is
for iteration; `test` is opened once.

### Step 5.2 — Baseline the student, three seeds

```bash
python -c "
from src.eval.tasks import load_jsonl, split
from src.eval.generate import HFBackend
from src.eval.harness import evaluate, write_report
tasks = split(load_jsonl('data/tasks/dev.jsonl'), 'dev')
rep = evaluate(tasks, HFBackend('Qwen/Qwen2.5-Coder-0.5B-Instruct'), n_samples=5, seeds=(0,1,2), ks=(1,5))
print(rep.summary()); write_report(rep, 'results/00-baseline.json')
"
```

### Step 5.3 — Write the results file by hand

Create `results/00-baseline.md` recording: model id and revision, task file and its git SHA,
n_samples, seeds, temperature, max_tokens, pass@1 ± std, pass@5, extraction failures,
truncations, and the date. **Every number in this project must be regenerable from a config
plus a data version tag.**

**Done when:** you can hand `results/00-baseline.md` to someone and they can reproduce it.

> How big a delta counts as real? See `TUF/07-TRAPS.md` — "how big must a delta be to mean
> anything". With ~160 problems, differences under ~4 points are noise.

---

# Part 6 — Phase 3: the data pipeline

**Goal:** `data/processed/sft-v1.jsonl` — ~10k curated examples with a written provenance chain.

**Why this phase dominates:** the field guide's headline ablation is that **10k curated beats
100k raw at equal compute**. This is the highest-leverage phase in the project and the one most
people skip.

**Machine: Mac.** Every step here is RAM-bound. Do not attempt it on 14 GB.

### Step 6.1 — `src/data/download.py`

Stream, never bulk-load. `load_dataset(..., streaming=True)` and write JSONL incrementally.
A non-streaming load of a large corpus is the fastest way to get a process killed.

### Step 6.2 — `src/data/filter.py` — cheapest filters first

Order matters: each stage should be cheaper than the one after it.

```python
"""Quality filters, cheapest first. Each stage feeds the next."""
from __future__ import annotations
import ast, re


def parses(code: str) -> bool:
    """~0.1 ms. Rejects a surprising fraction of scraped 'code'."""
    try:
        ast.parse(code)
        return True
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return False


def length_ok(text: str, lo: int = 40, hi: int = 6000) -> bool:
    return lo <= len(text) <= hi


def has_solution_body(code: str) -> bool:
    """Rejects stubs: a def whose body is only pass/.../docstring."""
    try:
        tree = ast.parse(code)
    except SyntaxError:
        return False
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            body = [n for n in node.body if not isinstance(n, ast.Expr)
                    or not isinstance(getattr(n, "value", None), ast.Constant)]
            if body and not all(isinstance(n, ast.Pass) for n in body):
                return True
    return False


BOILERPLATE = re.compile(r"(TODO|FIXME|your code here|NotImplementedError)", re.I)


def clean(record: dict) -> bool:
    code = record.get("completion", "")
    return (length_ok(code) and parses(code) and has_solution_body(code)
            and not BOILERPLATE.search(code))
```

### Step 6.3 — `src/data/decontaminate.py` — run this before EVERY training run

**Why "every":** contamination is not a one-time cleanup. Every time you add a data source,
regenerate synthetic data, or change your eval set, the overlap changes. Re-run it.

Standard approach: 13-gram overlap against **every** eval task's prompt and tests. Any training
example sharing a 13-gram with any eval item is dropped. `datasketch` is already in
`requirements/base.txt`.

Log how many examples you dropped and why, into `results/`. A decontamination pass that drops
zero examples is a decontamination pass that is not working.

### Step 6.4 — `src/data/dedup.py`

Three tiers, cheapest first: exact hash → MinHash/LSH near-duplicate (`datasketch`, threshold
~0.8) → optionally semantic. Near-duplicate inflation is what makes a 100k dataset behave like
a 20k one.

### Step 6.5 — The ablation that justifies the phase

Train two SFT runs at **equal compute**: curated-10k vs raw-100k-subsampled-to-equal-steps.
Record both in `results/02-data.md`. This is the experiment that teaches you the lesson properly,
and you only have to run it once.

**Done when:** `results/02-data.md` shows the curated set winning, and you can state the drop
counts at every filter stage.

---

# Part 7 — Phase 4: SFT

**Goal:** an adapter that beats baseline on three seeds.

**Numbers:** every hyperparameter is in **`TUF/05-CONFIGS.md` → "`sft.py` — the full config"**.
Do not re-derive them here.

**Machine: TUF.**

### Step 7.1 — Write `configs/sft-0.5b.yaml` FIRST

**Why first:** the config is the lab notebook. A run whose config is not committed did not
happen. `OUTLINE.md` promises this discipline and the repo currently has *zero* config files —
you are closing that gap.

Minimum fields: `model_id`, `dataset`, `seq_len`, `per_device_batch`, `grad_accum`,
`learning_rate`, `epochs`, `lora_r`, `lora_alpha`, `lora_dropout`, `target_modules`, `seed`,
`output_dir`. Commit it before you launch.

### Step 7.2 — Write `src/train/sft.py`

Non-negotiables on this box, all from `CLAUDE.md` §3:

```python
bf16 = True                        # NEVER fp16 -- NaNs on step 1
gradient_checkpointing = True
optim = "paged_adamw_8bit"
# and in the environment, before you launch:
#   PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

Starting geometry for 0.5B: `seq_len 1024`, `per_device_batch 2`, `grad_accum 8`.

### Step 7.3 — ⚠️ Loss masking — the bug that silently wastes a week

You must train on the **completion only**, not the prompt. TRL's
`DataCollatorForCompletionOnlyLM` needs a response template — and the template must tokenize
**identically in context** as it does standalone. For Qwen's ChatML this is a real hazard:

| String | Token ids |
|---|---|
| `<\|im_start\|>assistant` | `[151644, 77091]` |
| `\n<\|im_start\|>assistant` | `[198, 151644, 77091]` |
| `<\|im_start\|>assistant\n` | `[151644, 77091, 198]` |

A leading newline changes the id sequence, the collator finds no match, **no masking is applied**,
and the model trains on prompts as if they were answers. Loss looks fine. Eval never moves.

**Verify masking directly — do not assume:**

```python
batch = next(iter(trainer.get_train_dataloader()))
labels = batch["labels"][0]
print("masked:", (labels == -100).sum().item(), "/", labels.numel())
print(tokenizer.decode([t for t in batch["input_ids"][0][labels != -100]]))
```

The decoded text must be **only the answer**. If you see the question, masking is broken.

### Step 7.4 — The ten-step canary

Before any long run:

```bash
PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True python src/train/sft.py --config configs/sft-0.5b.yaml --max-steps 10
```

Proves the whole chain — data → tokenizer → model → optimizer → backward → save — in two
minutes instead of discovering a bug at hour three.

Also assert you are actually on the GPU:

```python
assert next(model.parameters()).device.type == "cuda"
model.print_trainable_parameters()   # must NOT be 0.00%
```

### Step 7.5 — Full run, then evaluate

Launch under tmux so a closed laptop lid does not kill it:

```bash
ssh tuf -t 'tmux new -A -s train'
```

Then evaluate the adapter with the Part 4 harness by passing `adapter=` to `HFBackend`, three
seeds, and write `results/03-sft.md`.

**Done when:** beats `results/00-baseline.md` by more than noise on three seeds, **and you can
name the hyperparameter responsible.**

### Step 7.6 — When the eval will not move

Check in this order — hyperparameters are the *last* thing to suspect:

1. `model.print_trainable_parameters()` — is it 0.00%?
2. Optimizer step count — is `grad_accum` actually being applied?
3. Decode a batch and inspect labels — is loss masking on? (Step 7.3)
4. Diff the train-time chat template against the eval-time one — character by character
5. Only now: learning rate, epochs, rank

Full playbook: `TUF/06-DEBUG.md` §6.

---

# Part 8 — Phase 5: rejection sampling / RFT

**Goal:** self-improvement with no RL machinery — generate N, execute, keep what passes, SFT on it.

### Step 8.1 — `src/teacher/generate.py`

The teacher is **Qwen2.5-Coder-32B 4-bit via ollama on the Mac**, measured this session at
**83.3% pass@1** and **7.5 s/generation** → roughly **21 hours for a 10k corpus**. Budget one
overnight run, not an afternoon.

Reuse `OllamaBackend` from Step 4.2 — it already sets `think=False` and tracks truncation.
Add: resumable checkpointing (write JSONL incrementally, skip completed `task_id`s on restart),
and a `--limit` flag so you can test on 20 before committing to 10,000.

⚠️ **Do not add concurrency without checking the server.** Your Ollama.app runs `llama-server`
with `-np 1`, so parallel requests serialise — measured 1.02× at concurrency 8. To actually get
parallelism you must restart the server with `OLLAMA_NUM_PARALLEL=4`.

### Step 8.2 — The loop

Generate N samples per problem at temperature 0.8 → execute each through `sandbox.run` →
keep only `status == "pass"` → dedup the survivors → SFT on them.

### Step 8.3 — ⚠️ Difficulty collapse — the failure that kills round 2

Only easy problems produce passing samples, so your filtered set is all easy, so round 2 trains
on easier data than round 1 and the model gets *worse* at hard problems while the aggregate
score holds steady.

**Detect it:** bucket problems by difficulty and log pass rate per bucket every round. If the
hard-bucket count is shrinking, you are collapsing. See `TUF/05-CONFIGS.md` → "Difficulty
collapse".

**Done when:** beats Phase 4, and you can explain why this works without any RL.

---

# Part 9 — Phase 6: DPO

**Goal:** preference pairs for free, straight out of execution results.

### Step 9.1 — Build pairs from what you already have

For each problem, a sample that passed is `chosen`, one that failed is `rejected`. No human
labelling, no reward model. This is the payoff for choosing code as the domain.

⚠️ **Pair within a problem, never across problems.** Cross-problem pairs teach style, not
correctness.

### Step 9.2 — Track verbosity on every run

DPO has a well-known length bias — it will learn "longer is better" if you let it. Log mean
completion length before and after. If it grew more than ~20%, suspect the bias before you
believe the score.

Config and beta guidance: `TUF/05-CONFIGS.md` → "Beta — the leash".

**Done when:** beats RFT on pass@1 with verbosity tracked and reported.

---

# Part 10 — Phase 7: GRPO / RLVR

**Goal:** the phase the whole curriculum was built for.

**Prerequisite:** the sandbox must run **on the TUF**, because the reward function executes
inside the training loop. This is why Ubuntu mattered — the POSIX APIs in `executor.py`
(`setsid`, `killpg`, `setrlimit`) are native there.

### Step 10.1 — The reward function is `ExecResult.fraction`

Use the **dense** signal, not a boolean. `passed/total` gives the model a gradient to climb;
pass/fail gives it a cliff. This single choice is the highest-leverage decision in the phase
(`TUF/05-CONFIGS.md` → "Dense vs binary reward").

Composite shape: correctness fraction, minus penalties for `flags`, minus a small length term.

### Step 10.2 — Wire the flags into the penalty

`ExecResult.flags` already carries `read_test_file` and `net_attempt`. Penalise them **hard** —
a model that reads the test file scores 1.0 while learning nothing.

### Step 10.3 — Read your rollouts. Every run.

Twenty samples, by eye, every single run. The reward-hacking gallery in `TUF/05-CONFIGS.md`
lists what to look for: `sys.exit(0)`, bare `except:`, hardcoded outputs matching test cases,
`assert True`, timeout-catching. Aggregate metrics will not show you any of it.

**The false positive that defines this phase:** reward climbing while eval drops. If you see it,
you are not training — you are being gamed.

**Done when:** beats DPO **and** you have two documented reward-hacking incidents with fixes.

---

# Part 11 — Phase 8: self-repair

**Goal:** turn failure into training signal.

`ExecResult.traceback` exists for exactly this. Loop: generate → execute → on failure, feed the
traceback back with the code and ask for a fix → execute again → train on successful repairs.

**Report first-attempt pass@1 and after-one-repair pass@1 as separate numbers.** Merging them
flatters the model and hides whether repair is actually working.

---

# Part 12 — Phases 9–10: merge, quantize, serve

**Machine: Mac.** All CPU work.

1. **Merge** — `mergekit` is already in `requirements/mac.txt`. SLERP/TIES/DARE sweeps cost no
   GPU-hours, so sweep widely. Never store merged models; they are a pure function of
   adapter + base.
2. **Quantize** — adapter → merged → GGUF → `Q4_K_M`. This is where `Q4_K_M` correctly belongs:
   an *inference* format, not a training one.
3. **Serve and benchmark** — `src/serve/bench_serving.py` already exists and separates prefill
   from decode using ollama's nanosecond counters. Reuse it; do not write another.

**Reference numbers measured on your hardware this session** (1.5B Q4_K_M, identical model both
machines):

| | TUF (RTX 3050) | Mac (M5 Pro) |
|---|---|---|
| Decode, short prompt | 116.4 tok/s | 188.8 tok/s |
| Decode, ~20k prompt | 84.5 tok/s | 132.0 tok/s |

**Done when:** a quality/speed Pareto on your own eval, and the `test` split — untouched until
now — opened exactly once for the final number.

---

# Appendix A — Daily working rhythm

| When | What | Where |
|---|---|---|
| Before bed | Kick off teacher generation or a long training run, under tmux | Mac generates · TUF trains |
| Morning | Check W&B in the browser; pull adapters back | Mac |
| Midday | Curate, filter, build the next dataset version | Mac |
| Afternoon | Launch the next training run | TUF |
| Evening | **Read twenty rollouts.** Update `TUF/STATUS.md`. | Either |

Never leave one machine idle waiting on the other — that is the whole point of having two.

```bash
ssh tuf -t 'tmux new -A -s train'
```

```bash
rsync -avz --partial --progress ~/ULTRON/data/processed/ tuf:/data/datasets/
```

```bash
rsync -avz --partial --progress tuf:/data/runs/ ~/ULTRON/results/runs/
```

**Never rsync `.venv` or `.git` between machines.** Code moves by git; environments are
recreated from `requirements/`.

---

# Appendix B — Where to look when it breaks

| Symptom | Go to |
|---|---|
| CUDA OOM | `TUF/06-DEBUG.md` §1, then `CLAUDE.md` §7 — lower `seq_len` first, it is the biggest lever |
| Process killed during data load | `TUF/06-DEBUG.md` §2 — non-streaming load on 14 GB. Use `streaming=True` or move it to the Mac |
| NaN loss | fp16. Switch to bf16. If already bf16, LR is too high — `grad_norm` climbs before the loss breaks |
| Training 20× slow | Assert the device. Then thermal throttling. Then dataloader workers |
| Eval will not move | Step 7.6 above — in that order |
| Reward up, eval down | Reward hacking. Read rollouts. `TUF/05-CONFIGS.md` gallery |
| Eval score suspiciously high | Contamination. Re-run decontamination; check `extraction_failures` |

---

# Appendix C — Corrections to `TUF/STATUS.md` worth acting on

The TUF session measured three things that differ from what the docs assume. Fix them before
training, because each silently changes your numbers:

| Item | Documented assumption | Measured on the TUF | Action |
|---|---|---|---|
| Display GPU | `display_active: Disabled`, 5–20 MiB idle | **`Enabled`, 79 MiB used** | Confirm the desktop renders on the Renoir iGPU (`glxinfo \| grep "OpenGL renderer"`). 79 MiB is still far better than Windows' 500–1000 MB, but it is not the ideal case the memory tables assume. |
| Swap | 16 G | **4 G**, 1.5 G already in use | Enlarge it. On 14 Gi usable RAM this is what turns an OOM-kill into a slowdown. |
| `/data` | ext4, mounted by UUID at `/data` | **NTFS** at `/run/media/.../Storage` | Reformat to ext4 and mount at `/data`. On NTFS the HF cache cannot use symlinks and silently doubles disk usage per model; conda/pip hardlinks break too. `docs/WINDOWS-TO-UBUNTU.md` Step 6 covers this. |
| Usable RAM | 16 GB | **14 Gi** (iGPU reserves ~2 GB) | Plan dataset streaming against 14, not 16. |

**Also stale, lower priority:** `CLAUDE.md` §9 prescribes conda + Python 3.11 (this guide uses
uv + 3.12); `OUTLINE.md` and `CLAUDE.md` say 190 slides where the built deck has 191; the deck's
compute-budget table says 6–12 h for teacher generation against ~21 h measured.
