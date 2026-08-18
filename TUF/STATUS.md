# STATUS — living state of the project

**Update this at the end of every session.** It is the first thing the next session reads.

Last updated: **2026-08-18** · Updated by: TUF hardware session (08-17) + serving benchmark (08-18), merged on the Mac

---

## Where we actually are

**Week 1–2. The sandbox is built and green. Nothing has trained, by design.**

The pipeline gate we are standing on: `sandbox ✅ → eval harness (partial) → baseline (blocked)`.

| Path | State |
|---|---|
| `CLAUDE.md` | Present. Amended this session: pip/venv not conda, concrete `HF_HOME`. |
| `docs/` | 190-slide field guide + `OUTLINE.md` + `sections/*.js`. Unchanged. |
| `TUF/` | This pack. **Amended this session — see "Corrections to the pack" below.** |
| `src/sandbox/` | **Built.** `executor.py`, `_runner.py`, adversarial suite. **19/19 green.** |
| `src/eval/` | **Partial.** `pass_at_k.py` + `extract.py` built and self-checking. `harness.py` blocked on the environment. |
| `src/{data,train,serve}/` | Empty, structure committed |
| `configs/` `results/` `checkpoints/` `data/` `notebooks/` | Created, empty, committed |
| `requirements.txt` | **Written** — pip only, Python 3.14, verified against live indexes |

---

## TUF machine state — MEASURED, not assumed

Everything below was run on the hardware this session. ✅ = verified, ❌ = verified absent.

| Item | Expected by the pack | Measured | ✓ |
|---|---|---|---|
| Ubuntu 26.04 | Yes | Ubuntu 26.04 LTS, kernel 7.0.0-29-generic | ✅ |
| MOK enrolled, `nvidia-smi` works | RTX 3050, 4096 MiB | **RTX 3050 Laptop, 4096 MiB, driver 595.84** | ✅ |
| Both GPUs on the bus | 3050 + Renoir iGPU | `01:00.0` GA107M + `06:00.0` Renoir | ✅ |
| Display on the iGPU | `display_active: Disabled`, idle 5–20 MB | ⚠️ **`display_active: Enabled`, 79 MiB used** | ⚠️ |
| CPU / RAM | 8c/16t, 16 GB | 16 threads, **14 Gi usable** (iGPU reserves ~2 GB) | ✅ |
| Swap enlarged to 16 GB | 16 G | ❌ **4 G** (`/swap.img`), 1.5 G already in use | ❌ |
| 1 TB ext4 at `/data` by UUID | ext4, owned by `$USER` | ❌ **NTFS**, 577 G used, auto-mounted at `/run/media/killerx8143/Storage` | ❌ |
| `/data` exists | mounted | ❌ **does not exist** | ❌ |
| `HF_HOME=/data/hf` set before any download | `/data/hf` | ❌ **unset**, and absent from `~/.bashrc` | ❌ |
| Python env | conda `ultron`, py3.11 | ❌ no conda. **Only `python3.14` exists**; no `pip` module | ❌ |
| torch + CUDA → `(8, 6)` | Ampere sm_86 | ⏳ not installed yet | ⏳ |
| `python -m bitsandbytes` | passes | ⏳ not installed yet | ⏳ |
| `unsloth` imports | ok | ⏳ not installed yet | ⏳ |
| Docker + `hello-world` | ~50 ms/container | ❌ **not installed** | ❌ |
| llama.cpp CUDA build | `-ngl 99` offload, GGUF loads | ✅ **works** — 1.5B Q4_K_M at 116.4 tok/s, see serving benchmark | ✅ |
| W&B authenticated | one metric logged | ⏳ not installed yet | ⏳ |
| `tmux`, `nvtop`, `gcc`, `node` | present | ❌ **all missing** (minimal install) | ❌ |
| Lid-close suspend disabled | `HandleLidSwitch=ignore` | ⏳ unverified | ⏳ |
| SSH + `tuf.local` from the Mac | `ssh tuf` | ⏳ unverified | ⏳ |
| flash-attn (optional) | — | ❌ not installed (optional, defer) | — |
| `/data/baseline.txt` | captured | ⏳ blocked on `/data` | ⏳ |

### Corrections to the pack — made this session

1. 🛑 **The NVMe device names are reversed** from what `01-SETUP.md` Step 6 assumed.
   `nvme1n1` is the **512 GB Samsung Ubuntu root**; `nvme0n1` is the **1 TB Crucial data
   drive**. Step 6's `wipefs -a /dev/nvme1n1` **would have erased the OS.** The step is now
   marked with a stop block and the command flagged do-not-run. *Always match on SIZE and
   MODEL, never on device name.*
2. **`/data` resolves to a directory on the ext4 root**, not a mount of the 1 TB. The 1 TB is
   NTFS with 577 GB of existing data, and the HF cache needs symlinks (on NTFS
   `huggingface_hub` copies instead, doubling per-model disk use). Root has 391 GB free,
   which is ample — the 150–400 GB cache figure is Mac work.
3. **conda → pip/venv**, and **Python 3.11 → 3.14.** Ubuntu 26.04 ships *only* `python3.14`;
   3.11/3.12/3.13 are not in the archive. Verified 3.14 is fine for the whole stack: torch
   2.13 has cp314 wheels, `bitsandbytes` ships an ABI-agnostic `py3-none-manylinux` wheel,
   `unsloth` declares `<3.15`.
4. **`pip install torch`, not the cu128 index.** PyPI torch 2.13.0 pins `nvidia-cudnn-cu13`
   — it *is* the CUDA 13 build and matches the 595.84 driver. The cu128 index only has
   2.10.0 for cp314, i.e. the documented command installs an *older* torch here.
5. **`RLIMIT_NPROC` counts threads, not processes.** This box: 175 processes but **2069
   threads**. The field guide's example value of `nproc=64` makes *every* `fork()` fail with
   `BlockingIOError` — which is worse than useless, because the fork-bomb test goes green
   while proving nothing. `executor.py` now sizes it as measured-threads + headroom.

### ⚠️ Open: 79 MiB of VRAM held at idle

The pack predicts 5–20 MB with `display_active: Disabled`. We measure **79 MiB** with
`display_active: Enabled`. That is 2% of the budget, not a blocker, but it means something
is attached to the dGPU. Worth resolving before the first long run — check
`glxinfo | grep 'OpenGL renderer'` names the **AMD Renoir** (needs `mesa-utils`), and close
Chrome/PyCharm before training. Dropping to a TTY (Ctrl+Alt+F3) is the guaranteed floor.

### ⚠️ RAM pressure is real right now

`8.8 Gi used / 14 Gi total`, only **5.7 Gi available**, with 1.5 G already swapped — and swap
is 4 G, not the 16 G the runbook calls for. The pack is right that **16 GB system RAM bites
before VRAM does**. Enlarge swap before the first dataset job.

---

## Next actions, in order

**Blocked on you — these need `sudo`, which this session does not have.** Paste with a
leading `!` to run them in-session:

1. ☐ `sudo apt update && sudo apt install -y build-essential git curl wget htop tmux nvtop python3.14-venv python3-pip unzip pkg-config mesa-utils docker.io`
2. ☐ `sudo usermod -aG docker $USER` — then **log out and back in**, and `docker run --rm hello-world`
3. ☐ `sudo mkdir -p /data && sudo chown -R $USER:$USER /data && mkdir -p /data/hf /data/datasets`
4. ☐ Swap 4 G → 16 G:
   `sudo swapoff /swap.img && sudo fallocate -l 16G /swap.img && sudo chmod 600 /swap.img && sudo mkswap /swap.img && sudo swapon /swap.img`
5. ☐ Disable lid-suspend — `01-SETUP.md` Step 5. Costs a night on a GRPO run if skipped.

**Then, unblocked:**

6. ☐ `HF_HOME` into `~/.bashrc` **before any download** — `01-SETUP.md` Step 8
7. ☐ `python3.14 -m venv ~/venvs/ultron && source ~/venvs/ultron/bin/activate && pip install torch`
8. ☐ Confirm `torch.cuda.get_device_capability()` → `(8, 6)`, **then** `pip install -r requirements.txt`
9. ☐ Smoke tests: `python -m bitsandbytes` · `from unsloth import FastLanguageModel` · `wandb.init()` + one metric
10. ☐ Re-run the adversarial suite under the venv with pytest: `pytest src/sandbox/tests/ -v`
11. ☐ Capture `/data/baseline.txt` — `01-SETUP.md` Step 12
12. ☐ Write `src/eval/harness.py` around `evalplus`, wiring in the existing `pass_at_k` + `extract`
13. ☐ Produce `results/00-baseline.md` — one command, one number, **three seeds**, with the
    harness commit SHA, template name, and date
14. ☐ Only then download a training dataset

**Do not start SFT until 13 is done.** Everything after the baseline is "better than that
number"; if the number is wrong, every later claim is wrong.

### Consider: move the working copy off NTFS

The repo is at `/run/media/killerx8143/Storage/projects/ULTRON` — the NTFS volume. Git works
but degrades (NTFS presents a uniform fake permission mask, so mode bits do not round-trip).
Re-clone onto the ext4 root rather than copying. Sandbox temp dirs are unaffected; they
default to `/tmp`, which is ext4.

---

## Results log

Nothing measured on a model yet. No model has been loaded, let alone trained.

| Phase | Config | Data version | HumanEval+ pass@1 | Seeds | Date | Notes |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | No runs yet |

### Sandbox verification — the one thing that *is* measured

`python3.14 src/sandbox/tests/test_adversarial.py` → **19/19 pass** on 2026-08-17,
Python 3.14.4. All 12 cases from the trap index, plus 7 added.

| Case | Result |
|---|---|
| Infinite loop → timeout | ✅ killed in 2.1 s (CPU limit fires before wall clock) |
| `time.sleep(999)` → timeout | ✅ 4.0 s — wall clock catches what RLIMIT_CPU misses |
| Fork bomb → contained | ✅ and the host still runs a trivial job afterwards |
| Memory bomb → `MemoryError` | ✅ contained by `RLIMIT_AS`, host unaffected |
| **Orphan subprocess → `killpg`** | ✅ **and negative-control verified** (see below) |
| `sys.exit(0)` → not a pass | ✅ scored `error`; exit code really is 0 |
| Swallow-everything → still fails | ✅ incl. a solution raising `SystemExit` inside a test |
| Read the test file | ✅ all 5 candidate paths `FileNotFoundError`, attempt flagged |
| Network egress | ✅ flagged `net_attempt` (L1 detects; L2 prevents) |
| Filesystem escape | ✅ flagged — and confirmed L1 genuinely cannot *block* it |
| Disk fill → `RLIMIT_FSIZE` | ✅ capped |
| Env leak → `None` | ✅ `HF_TOKEN`, `WANDB_API_KEY`, `SSH_AUTH_SOCK`, `PYTHONPATH` all absent |
| Syntax error → fail fast | ✅ 0 ms, no process spawned |

**Two findings worth keeping:**

- **The orphan test is real, not decorative.** Negative control: replacing `killpg` with a
  plain `proc.kill()` (exactly how `subprocess.run(timeout=)` is broken) makes the test fail
  with `ORPHAN LEAK: pids [...] survived`. The pack's claim that this is the case that
  silently passes on hand-rolled sandboxes is correct.
- **A broken group-kill does not just leak — it deadlocks the harness.** The orphan inherits
  our stdout/stderr pipes, so the write end never closes, EOF never arrives, and an
  unbounded `communicate()` after the kill hangs *forever*. A solution can trigger this
  deliberately by calling `os.setsid()` to leave the group that `killpg` targets. Fixed with
  a bounded drain that abandons the pipes and sets a `group_escape` flag; case 05b covers it.
  **This is the mechanism behind "run hangs at a random step" in the trap index.**

**Known Level 1 residuals — these are why Level 2 is mandatory before the first unattended run:**

| Residual | Why L1 cannot fix it | L2 fix |
|---|---|---|
| Filesystem escape *writes* succeed | same uid as you | `--read-only` + `--tmpfs /work` |
| Network is flagged, not blocked | no way to drop sockets in-process | `--network none` |
| `os.setsid()` escapes `killpg` | the child can leave the group | container teardown |
| `RLIMIT_NPROC` is per-UID | coupled to your desktop's own threads | `--pids-limit` (per container) |
| Audit-hook flags are tamperable | `sys.modules['__main__']` is reachable | flags are evidence, not enforcement |

### Serving benchmark — MEASURED on the TUF, 2026-08-18

**Model: Qwen2.5-Coder-1.5B** — inferred from the artifact sizes (986 MB / 1.6 GB match 1.5B, not
0.5B). As of 2026-08-18 this is the **ship target**; 0.5B remains the dev-loop model. These numbers
describe the shipped artifact, not the iteration model — do not file them under 0.5B.

llama.cpp / GGUF, `-ngl 99`.

| Metric | Q4_K_M (986 MB) | Q8_0 (1.6 GB) | Q4 advantage |
|---|---|---|---|
| Decode, short prompt | **116.4 tok/s** | 91.2 tok/s | **+27.6%** |
| Decode, 5k prompt | 108.8 | 86.6 | +25.6% |
| Decode, 20k prompt | 84.5 | 70.3 | +20.2% |
| Prefill, 5k prompt | 4,326 tok/s | 4,496 tok/s | −3.9% |
| Prefill, 20k prompt | 2,934 | 2,949 | −0.5% (tie) |
| VRAM loaded | **1,394 MiB** | 2,024 MiB | **−630 MiB** |
| VRAM @ 32K context | **2,124 MiB** | 2,654 MiB | −530 MiB |
| CPU-only decode | 24.8 tok/s | 16.0 tok/s | **+55%** |

**Derived — effective memory bandwidth**

| Format | Bytes/token × tok/s | Effective BW | % of ~192 GB/s peak |
|---|---|---|---|
| Q4_K_M | 986 MB × 116.4 | ~115 GB/s | 60% |
| Q8_0 | 1,600 MB × 91.2 | ~146 GB/s | **76%** |

CPU-only lands at ~25 GB/s for both — roughly half of dual-channel DDR4-3200's ~51 GB/s theoretical.
The two agreeing within 5% is a good signal the measurements are clean.
**GPU speedup over CPU: 4.7× (Q4), 5.7× (Q8)** — modest, because this is a bandwidth-bound workload
on a bandwidth-modest card.

**Conclusions**

- **Ship Q4_K_M.** Faster decode, 630 MiB less VRAM, 55% faster CPU fallback. It loses prefill by an
  amount inside run-to-run noise. There is no axis where Q8_0's extra 630 MB buys anything measurable.
- **Decode is bandwidth-bound; prefill is compute-bound.** Quantization only helps decode. Q8_0's
  marginal prefill win is Q4_K's dequantization overhead showing up where weights are reused across
  many tokens.
- **Q8_0 is nearly bandwidth-saturated (76% of peak). Q4_K_M gives up ~16% of peak to dequant cost**
  — which is why the speedup is 1.28× rather than the 1.62× the file-size ratio predicts.
- **Quality was NOT measured.** These are speed and footprint only. See open question 5.

---

## Open questions / blockers

| # | Question | Status |
|---|---|---|
| 1 | Is the TUF's Wi-Fi genuinely dead, or disabled in BIOS? | **Open, not a blocker.** Not re-triaged this session; Ethernet is up and network works (PyPI reachable). |
| 2 | Did the 1 TB get reformatted to ext4, or is it still NTFS? | ✅ **CLOSED — still NTFS**, 577 G used. `HF_HOME` therefore goes on the ext4 root. |
| 3 | Real measured VRAM headroom vs the estimated tables | **Partially closed.** 4096 MiB total, **79 MiB held at idle** vs 5–20 MB predicted. Full reconciliation needs torch installed. |
| 4 | Why is `display_active: Enabled`? | **New.** 79 MiB on the dGPU. Check `glxinfo` names AMD Renoir. |
| 5 | Move the repo off NTFS to ext4? | **New, needs your call.** Git degrades on NTFS. |
| 6 | KV cache delta differs between quants: 730 MiB (Q4_K_M) vs 630 MiB (Q8_0) at 32K | **Open — anomaly.** KV cache is a function of architecture and context, not weight quantization. These deltas should match. Re-run with identical `--cache-type-k/v` and context flags before trusting either figure. |
| 7 | Quality of Q4_K_M vs Q8_0 — unmeasured | **Open.** Speed says ship Q4_K_M; nothing yet confirms the quality cost is inside noise. Run `harness.py` against the served endpoint, both quants, three seeds. This is the "eval the checkpoint, ship the quant" trap. |

---

## Decisions already made — do not relitigate

- **QLoRA only.** No full fine-tuning.
- **bf16 only.** Never fp16 on this card.
- **No rented GPUs / cloud compute.** Learning on owned hardware. Plan around 4 GB.
- **Qwen2.5-Coder-0.5B is the target.** 1.5B is the stretch, 7B+ is out of scope for training here.
- **The Mac owns data and eval. The TUF owns training.**
- **Pipeline order is fixed** and not up for discussion.
- **pip + venv, not conda.** Decided 2026-08-17. Python 3.14, the only interpreter Ubuntu 26.04 ships.

---

## How to update this file

At the end of a session, edit in place:

1. Bump the "Last updated" line and say which machine you were on
2. Tick verified boxes; add anything newly discovered about the hardware
3. Move completed items out of "Next actions" and add the next ones
4. Add any measured number to the results log **with its config and seeds**
5. Add blockers as you hit them; close them as you resolve them

> A results file with only successes is a marketing document. **Write down what failed.**
