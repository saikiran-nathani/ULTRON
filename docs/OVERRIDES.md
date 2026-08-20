# ULTRON — Overrides to the Field Guide

Decisions made **after** the 190-slide deck was built (`docs/ULTRON-Field-Guide.pptx`).

**Precedence:** the field guide is the authority for everything not listed here.
Where this file and the deck disagree, **this file wins** — the deck predates it.

Each entry cites the slides it supersedes so the two read as one spec.

---

## OV-001 — Teacher model: 32B, not 14B/7B

| | |
|---|---|
| **Supersedes** | Slide 8 (distillation rig), Slide 25 (“Your teacher”) — both say 14B<br>Slide 61 (Phase 4 baseline table) — says `Qwen2.5-Coder-7B-Instruct` |
| **New value** | `Qwen2.5-Coder-32B-Instruct`, 4-bit |
| **Runtime** | Mac only, inference only — `mlx-community/Qwen2.5-Coder-32B-Instruct-4bit` |
| **Status** | Active |

This also resolves an internal inconsistency in the deck: the teacher was named as 14B
on slides 8 and 25 but as 7B on slide 61. Both are superseded.

### Constraints that still hold

- **Instruct variant, not base.** The slide 8 rig requires the teacher to follow a
  generation prompt and return N candidate solutions.
- **Slide 32: “Confirm the teacher shares a tokenizer family with the student.”**
  Still satisfied — 32B is the same Qwen2.5-Coder family as the 0.5B student.
- **License:** Apache 2.0, consistent with slide 24 (“Apache 2.0 (3B differs)”).

### Memory footprint — fits 48 GB

```
Q4_K_M weights                              ~20 GB
KV cache @  8k  (64 layers, 8 KV heads×128)  ~2 GB
KV cache @ 32k                               ~8 GB
                                           --------
worst case                                  ~28 GB   of 48 GB
```

Inside the ~36 GB default macOS GPU allocation cap.

### Throughput consequence — this is the part that changes plans

Decode is bandwidth-bound, so tok/s scales roughly with model size:

| Teacher | 4-bit size | Single-stream (est.) | vs 14B |
|---|---|---|---|
| 14B (old) | ~9 GB | ~20–25 tok/s | 1× |
| **32B (new)** | **~20 GB** | **~8–12 tok/s** | **~2.2× slower** |

> **Estimates, not measurements.** Derived from bandwidth ÷ model size at ~65%
> efficiency. Measure on the Mac and replace these numbers.

Teacher generation budget at ~300 tokens/candidate:

| Problems | N candidates | Tokens | @ ~50 tok/s batched |
|---|---|---|---|
| 10,000 | 8 | 24M | ~5.5 days — infeasible |
| **2,000** | **4** | **2.4M** | **~13 h — overnight, workable** |

**Plan Phase 7 around a single overnight run, not iterative regeneration.**

Two mitigations:
- **Batch on the Mac.** MLX batched generation amortizes the weight read across the
  batch — that is where the 4–5× in the table comes from. Prefer `mlx-lm` over
  `llama.cpp` for this job.
- **Higher yield offsets part of the cost.** The slide 8 rig discards everything the
  verifier rejects. 32B produces verified-correct candidates at a higher rate, so per
  *accepted* sample the gap is closer to 1.5× than 2.2×.

---

## Confirmations — not changes

Listed so they are not mistaken for open questions.

| Item | Value | Deck reference |
|---|---|---|
| Student | `Qwen2.5-Coder-0.5B-Instruct` | Slides 26, 32, 61 — unchanged |
| Stretch student | `Qwen2.5-Coder-1.5B` | Slide 25 — unchanged |
| Verifier | sandbox + tests, not a model | Slide 8 — unchanged |

Slide 26 remains the governing rationale for starting from Instruct: a working baseline
on day one, and base-vs-Instruct deferred to a Phase 6 ablation.

---

## Open items

| # | Item | Detail |
|---|---|---|
| OQ-1 | FIM scope | Slide 30: *“FIM is out of scope for this curriculum.”* The serving benchmark on TUF measured a 32-token FIM completion (562 ms Q4). Either that was exploratory or the endpoint definition has drifted. Decide before freezing `eval_final` — a FIM regression check cannot be reconstructed after the baseline is lost. |

---

## Changelog

| Date | Entry | Change |
|---|---|---|
| 2026-08-20 | OV-001 | Teacher 14B/7B → 32B-Instruct 4-bit |
