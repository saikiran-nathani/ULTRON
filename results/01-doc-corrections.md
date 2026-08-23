# Doc corrections — measured on the TUF, 2026-08-23

Everything below was measured on this box during the environment build and the capacity
sweeps. Each row is a place where a committed doc disagrees with the hardware. **This file
is the edit list**; the evidence lives in `results/00-hardware-capacity.md` and the two JSONs.

Nothing here has been applied to `CLAUDE.md` or `docs/BUILDING-ULTRON.md` yet — that edit is
deliberately left to a human, because several items interact with the unsloth arm that has
not run (see the bottom of this file).

---

## 1. `CLAUDE.md` §2 — the capacity table is wrong in both directions

**Hold this one until the unsloth arm runs.** Full detail in `00-hardware-capacity.md`.

The short version: what binds on this box is not model size, it is the fp32 logits tensor,
`vocab_size (151,936) x seq_len x batch x 4 B`. At 2,048 tokens per forward that single
tensor is 1.16 GiB. So the documented "comfortable" `0.5B @ 1024x2` **OOMs**, while the
documented "unsloth required" `1.5B @ 512x1` runs fine without it.

Working geometry today: **`seq_len 1024, batch 1, grad_accum 16`** — same effective batch as
the documented `1024x2x8`, and the highest throughput measured (1,391 tok/s).

---

## 2. `CLAUDE.md` §4 — three stale rows

| Row | Says | Should say |
|---|---|---|
| Eval harness + sandbox execution | **Mac** — "CPU-bound, and keeps the GPU free" | **TUF for bulk.** `BUILDING-ULTRON.md` Fix 3 measured that `RLIMIT_AS` is unsupported on Darwin and `RLIMIT_DATA` does not cap allocation there — a memory bomb runs until the wall clock kills it. Memory containment is **Linux-only**. Develop the harness on the Mac against trusted code; run it against model output here. That guide explicitly says "amend it". |
| Teacher generation | **14B** quantized | **32B** — superseded by Decision D1 in `BUILDING-ULTRON.md`, which supersedes slides 8, 25 and 61 |
| Data pipeline | "48 GB beats 16 GB" | "48 GB beats **14 Gi**" — see item 4 |

---

## 3. `CLAUDE.md` §5 — ship-target VRAM is ~100 MiB pessimistic

Line 109 reads `986 MB · 1,394 MiB VRAM · 116 tok/s, measured 2026-08-18`.

Re-measured 2026-08-23 on the same model and runtime: **1,297 MiB**, decode **115.0 tok/s**.
Decode reproduces within noise; the VRAM figure should come down. Also worth recording there:
the model holds **full offload to 32,768 context** (2,017 MiB at 32k), which is the number you
actually need to configure a server.

---

## 4. `CLAUDE.md` §7 and the Appendix C items — re-measured

### §7's OOM playbook is half right

Step 2 reads *"Lower `seq_len` (biggest lever; activations scale linearly with it)"*.

True, but incomplete on this stack. `seq_len` and `batch` **multiply** into the term that
dominates, so batch is exactly the same lever. Step 6 currently suggests `batch=1, raise
grad_accum` as a *late* step — on this box it belongs next to step 2, and it is free
(effective batch is preserved).

### Appendix C, re-measured

| Item | Doc assumption | Measured 2026-08-23 | Verdict |
|---|---|---|---|
| Display GPU | `Disabled`, 5–20 MiB idle | `Enabled`, **47 MiB** idle | Better than the 79 MiB `STATUS.md` recorded. Not worth chasing. |
| **Usable VRAM** | 4,096 MiB | **3,770 MiB** reported by torch | Not in any doc. Every headroom sum in §2 is ~326 MiB too generous. |
| Usable RAM | 16 GB | **14 Gi** confirmed (iGPU reserves ~2 GB) | Plan streaming against 14. |
| **Swap** | "enlarge it" | **still 4 G — and the capacity sweeps drove it to 2.8 G used** | Now urgent, not cosmetic. A 1.5B run plus a browser will hit the wall. |
| `/data` | reformat NTFS → ext4 | **done** — `/dev/nvme0n1p1 /data ext4`, by UUID, `nofail` | Closed. See `CLAUDE.md` §9. |

---

## 5. `docs/BUILDING-ULTRON.md` — two stale facts

**The adversarial suite has 23 tests, not 19.** All 23 pass on the TUF. Four references need
updating: lines 396, 400, 429, 557, 588 (`19 passed`, `19/19`, `17/18 on the Mac`).

**Step 7.3 documents an API that no longer exists.** `trl 0.24.0` has no
`DataCollatorForCompletionOnlyLM` — removed during the 0.2x line, verified against the
installed package and against the 1.10.0 wheel. Loss masking now goes through
`SFTConfig(assistant_only_loss=True)`, which needs a chat template carrying `{% generation %}`
markers.

The *warning* in Step 7.3 is still correct and still the most valuable paragraph in that
section — the ChatML tokenization hazard is real and the `labels != -100` decode check is
still how you prove masking works. Only the mechanism changed, not the trap.

---

## 6. What you can actually do today (no C compiler yet)

`sudo apt install -y build-essential tmux` has not been run. Triton JIT-compiles unsloth's
kernels at runtime, so unsloth imports fine and **`smoke_test.py` reports `ok unsloth`**, but
dies at the first training step. A green gate does not mean unsloth will train.

| Phase | Today | Why |
|---|---|---|
| 0 sandbox · 1 eval harness · 2 baseline · 3 data | ✅ | 23/23 adversarial; NF4 inference verified at 436 MiB |
| 4 SFT at 0.5B (the dev loop) | ✅ | plain peft+TRL measured; use `1024 x 1 x 16` |
| 5 RFT · 8 self-repair | ✅ | same path |
| **4 SFT at 1.5B — the ship run** | ❌ | §3 calls unsloth non-negotiable there |
| **6 DPO · 7 GRPO** | ⚠️ | the 4 GB headroom assumes unsloth even at 0.5B |
| 9–10 merge, quantize, serve | ✅ | ollama path measured end to end |

Phase 1 — the eval harness — is the real blocker, and it is pure Python. There is a long
runway before the compiler is what stands in the way.

---

## Re-run this before applying items 1 and 4

```bash
sudo apt install -y build-essential tmux
python scripts/bench_train.py --out results/train-tuf.json --steps 6 --unsloth
```

The sweep appends under a separate `runs.unsloth` key, so both backends land in one file.
**The prediction to test:** unsloth's fused cross-entropy never materializes the full fp32
logits tensor, so the two OOM rows should pass. If they do, that — not the speedup — is why
§3 calls unsloth non-negotiable, and §2's table was almost certainly derived with it. Rewrite
§2 from the unsloth column, and keep the peft+TRL column as the fallback geometry for when
you are debugging without it.
