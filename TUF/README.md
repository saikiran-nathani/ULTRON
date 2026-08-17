# TUF — handoff pack

Everything the Asus TUF A17 needs to take over ULTRON work, distilled from the 190-slide field
guide in `docs/` and filtered to what this machine actually does.

**If you are a fresh session on the TUF, read [STATUS.md](STATUS.md) first, then [00-BRIEF.md](00-BRIEF.md).**

---

## The sixty-second orientation

- **This box is the CUDA machine.** RTX 3050, **4 GB VRAM**, 16 GB system RAM, Ryzen 7 4800H, Ubuntu 26.04.
- **All GPU training happens here.** Data curation, teacher generation, eval, and merging happen on the Mac.
- **ULTRON is a learning curriculum, not a product.** Understanding beats benchmark numbers.
- **Target model: Qwen2.5-Coder-0.5B.** 1.5B is the stretch. **7B+ does not train here.**
- **The two ceilings:** 16 GB system RAM bites first (dataset loading); 4 GB VRAM caps model size.
- **Non-negotiable:** bf16 never fp16 · QLoRA never full FT · gradient checkpointing on ·
  `paged_adamw_8bit` · `HF_HOME=/data/hf` before any download.

```
sandbox → eval harness → baseline → data curation → SFT → RFT → DPO → GRPO → self-repair → merge → serve
```

**The order is not negotiable.** Skipping ahead costs weeks.

---

## The documents

| # | File | What it answers |
|---|---|---|
| — | **[STATUS.md](STATUS.md)** | **Where are we right now? What is next?** Living state — update every session. |
| 00 | [00-BRIEF.md](00-BRIEF.md) | What is this project, why does it exist, what does the vocabulary mean, what number are we beating? |
| 01 | [01-SETUP.md](01-SETUP.md) | Bare Ubuntu → working training box. Twelve ordered steps, MOK through baseline capture. |
| 02 | [02-CAPACITY.md](02-CAPACITY.md) | What fits on 4 GB? Memory math, dependency matrix, disk strategy, smoke tests. |
| 03 | [03-HANDOFF.md](03-HANDOFF.md) | TUF ⇄ Mac: who does what, SSH/tmux, rsync rules, repo structure, config discipline. |
| 04 | [04-WORK-QUEUE.md](04-WORK-QUEUE.md) | What to do, in order. 12-week schedule, phase gates, compute budget, experiment discipline. |
| 05 | [05-CONFIGS.md](05-CONFIGS.md) | Every training number. SFT / RFT / DPO / GRPO configs, LRs, memory tables, reward design. |
| 06 | [06-DEBUG.md](06-DEBUG.md) | It broke. Five playbooks: OOM, NaN, slow, garbage output, eval won't move. |
| 07 | [07-TRAPS.md](07-TRAPS.md) | The 51-row trap index and the 20-row false-positive index. Read before each phase. |

---

## Reading order

**First time on this machine:**
`STATUS.md` → `00-BRIEF.md` → `01-SETUP.md` → `02-CAPACITY.md`

**Starting a work session:**
`STATUS.md` → `04-WORK-QUEUE.md` → the relevant section of `05-CONFIGS.md`

**Before running any new phase:**
the phase's section in `05-CONFIGS.md`, then its rows in `07-TRAPS.md`

**When something breaks:**
`06-DEBUG.md`

**When a number looks too good:**
`07-TRAPS.md` Part 2 — the false-positive index

---

## The rules that come up most

1. **Build the ruler first.** Sandbox and eval before any gradient step.
2. **Data beats hyperparameters.** Every time, by a wide margin.
3. **Three seeds or it did not happen.** Most reported improvements are noise.
4. **`grad_norm` is the early-warning system.** It rises before the loss does.
5. **Checkpoint on `eval_pass_at_1`, never on `eval_loss`.** They diverge after ~epoch 1.5.
6. **Read your samples.** Every failure mode is invisible in aggregate metrics and obvious in twenty rollouts.
7. **Every reward term is an attack surface.** Build the detection before the run.
8. **Commit the config before running.** A config written after the fact is a memory, not a record.
9. **Close the browser before training.** A few tabs is 400–800 MB — 10–20% of the budget.
10. **tmux, always.** Otherwise closing the Mac kills the run.

---

## Provenance

These documents are distilled from `docs/ULTRON-Field-Guide.pptx` (190 slides), whose source is
`docs/sections/*.js` and whose topic manifest is `docs/OUTLINE.md`. Rebuild the deck with
`node build.js` from inside `docs/`.

Where the field guide gives a number, it is reproduced here **verbatim** — the numbers have not been
rounded, re-derived, or re-estimated. Numbers in the deck marked as approximate placeholders (notably
the baseline pass@1 table) are still approximate here; **replace them with your measured values** and
note the change in [STATUS.md](STATUS.md).

The field guide is designed to become a lab notebook. So is this pack.
