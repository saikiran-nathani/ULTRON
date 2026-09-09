# STATUS — generated from the progress database

<!-- GENERATED FILE. Do not edit. -->
<!-- Regenerate: trainwatch curriculum --write TUF/STATUS.md -->

Generated **2026-09-09** from `var/trainwatch.db` (ADR-0004).

Every status below is **derived from gate evidence**, not typed in. A phase is
`done` only when every one of its gates has a passing result. An unmeasured gate
reads as blocked, which is the behaviour the hand-written file lacked.

## Pipeline

`sandbox ✅ → eval-harness 🚧 → baseline ⛔ → data 🚧 → sft ⛔ → rft ⛔ → dpo ⛔ → grpo ⛔ → self-repair ⛔ → merge ⛔ → serve 🚧`

_No drift: every declared status matches its gate evidence._

## Phases

### ✅ Phase 0 — Sandbox

> Level 1: subprocess + setrlimit + setsid/killpg, dual wall/CPU timeouts, env allowlist, scoring from a report file rather than an exit code. Level 2 (containers) is still required before the first unattended run.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `adversarial-suite` | pass | 2026-08-23 | tuf | 23/23 on the TUF, per results/01-doc-corrections.md. Note the count: BUILDING-ULTRON.md still says 19 in four places. |
| `orphan-negative-control` | pass | 2026-08-17 | tuf | ORPHAN LEAK: pids [...] survived — negative control confirmed |

### 🚧 Phase 1 — Eval harness

> THE CURRENT BLOCKER, and it is pure Python — no GPU, no compiler, no sudo. Every number the rest of the pipeline claims is measured by this.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `extract-verified` | pass | 2026-09-08 | mac | extract.py reviewed; the ordering bug where extract_code(truncate_at_stops(text)) decapitates a fenced block is fixed by clean_completion(). |
| `harness-driver-exists` | — | — | — | — |
| `pass-at-k-verified` | pass | 2026-09-08 | mac | Verified exhaustively over 22,960 (n,c,k) cases against exact combinatorics. The naive independence estimator errs by ~4 points. |

Not yet measured — each is a command, not an opinion:

- `harness-driver-exists` → `python -m src.eval.harness --help`

### ⛔ Phase 2 — Baseline

> Blocked on Phase 1. Three seeds, recorded with the harness commit SHA and the template name. Everything after this is "better than that number"; if the number is wrong every later claim is wrong.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `baseline-recorded` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `baseline-recorded` → `python -m src.trainwatch.cli lineage --check`

### 🚧 Phase 3 — Data curation

> Partially built. Tokenizer and chat-template checks landed; download, dedup, decontaminate and synth do not exist yet. Runs on the Mac — 48 GB against the TUF's 14 GiB usable.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `decontaminated` | — | — | — | — |
| `lengths-measured` | pass | 2026-08-22 | mac | src/data/measure_lengths.py, committed in 1183581 |
| `template-verified` | pass | 2026-08-22 | mac | src/data/verify_template.py, committed in 1183581 |

Not yet measured — each is a command, not an opinion:

- `decontaminated` → `python -m src.data.decontaminate --report`

### ⛔ Phase 4 — SFT

> Geometry is settled by measurement: seq_len 1024, batch 1, grad_accum 16. NOT 1024x2x8 — that OOMs. The binding constraint is the fp32 logits tensor (vocab 151,936 x tokens_per_forward x 4 B), not model size.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `loss-masking-verified` | — | — | — | — |
| `sft-beats-baseline` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `loss-masking-verified` → `python -m src.train.sft --dry-run --show-labels`
- `sft-beats-baseline` → `python -m src.eval.harness --checkpoint <path> --seeds 3`

### ⛔ Phase 5 — RFT

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `teacher-generation` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `teacher-generation` → `python -m src.teacher.generate --count 10000`

### ⛔ Phase 6 — DPO

> Preference pairs come free from execution results — passed vs failed.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `pairs-built` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `pairs-built` → `python -m src.data.pairs --from-runs`

### ⛔ Phase 7 — GRPO

> Needs ExecResult.fraction as a dense reward, and the reward-hacking gallery as a live defence. 4 GB headroom here assumes unsloth even at 0.5B, which is not yet measured.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `reward-hacking-guarded` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `reward-hacking-guarded` → `python -m pytest src/sandbox/tests/test_adversarial.py -k hacking`

### ⛔ Phase 8 — Self-repair

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `traceback-to-fix` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `traceback-to-fix` → `python -m src.eval.harness --repair-rounds 1`

### ⛔ Phase 9 — Merge and quantize

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `gguf-exported` | — | — | — | — |

Not yet measured — each is a command, not an opinion:

- `gguf-exported` → `ls -la /data/models/*.gguf`

### 🚧 Phase 10 — Serve

> Measured ahead of the training phases because the benchmark runs against stock models. Ship target reproduces: 115.0 tok/s vs 116.4 in August.

| Gate | Result | When | Where | Evidence |
|---|---|---|---|---|
| `quant-quality-measured` | — | — | — | — |
| `serving-measured` | pass | 2026-08-23 | tuf | results/serving-tuf.json. 1.5B Q4_K_M at 1,297 MiB / 115.0 tok/s, full offload to 32k. 3B is a 16k model — at 32k it partially offloads to 0.814 and collapses to 10.6 tok/s on a 20k prompt, with no error. |

Not yet measured — each is a command, not an opinion:

- `quant-quality-measured` → `python -m src.eval.harness --served qwen2.5-coder:1.5b --seeds 3`

## Decisions in force

- **D-store-is-record** — The store is the system of record (ADR-0004)  ·  _2026-09-09_
  <br>Fires ADR-0002's trip-wire. Brings backups, migrations and app-level auth inside the tailnet. See docs/adr/0004-progress-system-of-record.md.
- **D-teacher-32b** — Teacher is Qwen2.5-Coder-32B 4-bit via ollama on the Mac  ·  _2026-09-08_
  <br>Measured 83.3% pass@1 at ~7.5 s/generation. Supersedes slides 8, 25, 61. A 9B reasoning model scored 33.3% only because it returns an empty `response` with the chain of thought in a separate `thinking` field — corrected to 76.7% vs 83.3%, not significant at n=60.
- **D-ship-q4km** — Ship Q4_K_M, not Q8_0  ·  _2026-08-23_
  <br>Q8_0 costs 23% of decode (115.0 -> 89.0 tok/s) for 630 MiB and buys nothing measurable. Prefill rises slightly at Q8, which is the expected shape: prefill is compute-bound and dequantizing Q4 is overhead.
- **D-python-3.12** — uv + Python 3.12, venv at the repo root  ·  _2026-08-22_
  <br>Verified by building it: torch 2.11.0+cu128, transformers 4.57.6, trl 0.24.0, peft 0.20.0, bitsandbytes 0.50.1, unsloth 2026.8.19.
- **D-student-0.5b** — 0.5B for the dev loop, 1.5B as the ship target  ·  _2026-08-17_
  <br>Build at 0.5B for loop speed (20-40 min per SFT run); re-run the settled recipe at 1.5B once. Do not iterate at 1.5B — SFT there is 2-3 hours.
- **D-owned-hardware** — No rented GPUs or cloud compute  ·  _2026-08-17_
  <br>The point is to acquire the skills on hardware that is owned. Plan around 4 GB. This also rules out managed databases.
- **D-bf16-only** — bf16 always, never fp16  ·  _2026-08-17_
  <br>Ampere (sm_86) supports bf16 natively. fp16 NaNs on step 1 on this card.
- **D-qlora-only** — QLoRA only, never full fine-tuning  ·  _2026-08-17_
  <br>4 GB VRAM. Not a preference — full fine-tuning does not fit.

### Superseded — kept on purpose

The useful record is not the current value but the chain that reached it.

- ~~**D-teacher-14b** — Teacher is a 14B quantized model on the Mac~~ → superseded by **D-teacher-32b**
- ~~**D-python-3.14** — Python 3.14, the only interpreter Ubuntu 26.04 ships~~ → superseded by **D-python-3.12**

## Open questions

- **OQ-1** — Is the TUF's Wi-Fi genuinely dead, or disabled in BIOS?  ·  _opened 2026-08-17_
- **OQ-6** — Why does the KV cache delta differ between quants at 32k — 730 MiB for Q4_K_M versus 630 MiB for Q8_0?  ·  _opened 2026-08-18_
- **OQ-7** — What does Q4_K_M cost in QUALITY versus Q8_0?  ·  _opened 2026-08-18_
- **OQ-8** — Does unsloth's fused cross-entropy let the two OOM geometries pass by never materializing the fp32 logits tensor?  ·  _opened 2026-08-23_
- **OQ-9** — Does synchronous=FULL measurably cost throughput at the batched write volume this project produces?  ·  _opened 2026-09-09_

### Closed

- **OQ-2** — Did the 1 TB get reformatted to ext4, or is it still NTFS?
  <br>✅ ext4, 916 G at /data, by UUID in /etc/fstab with nofail. The NTFS dirty bit dropped the volume on every reboot. HF_HOME=/data/hf now lands on the 1 TB as designed.  ·  _2026-08-23_
- **OQ-3** — What is the real measured VRAM headroom versus the estimated tables?
  <br>✅ 3,770 MiB usable, not 4,096 — the display reserves the rest. Every headroom sum written against 4,096 is ~326 MiB too generous.  ·  _2026-08-23_
- **OQ-4** — Why is display_active Enabled, holding VRAM at idle?
  <br>✅ 47 MiB at idle, better than the 79 MiB first recorded. Not worth chasing. Dropping to a TTY is the guaranteed floor; headless boot removes it.  ·  _2026-08-23_

---

> A results file with only successes is a marketing document.
> **Write down what failed.**
