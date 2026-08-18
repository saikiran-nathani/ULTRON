# Brief — what this machine is doing and why

Read this first if you are a fresh session, a fresh day, or a fresh pair of eyes.

---

## The project

**ULTRON is a learning curriculum, not a product.** The goal is to acquire post-training engineering
skills on open-weight code models. Nobody is shipping this to users.

That framing decides a lot of arguments before they start:

- A model that taught you five failure modes **beat** one that scored two points higher and taught
  you nothing.
- Benchmark SOTA is not the objective. Understanding is.
- The measure of success in the GRPO phase is **not** the pass@1 number — it is whether you can find,
  explain, and fix two reward hacks.

**Domain: code** — chosen because tests give a free, objective verifier.
**Dev loop: Qwen2.5-Coder-0.5B** — where the pipeline gets built and every ablation runs.
**Ship target: Qwen2.5-Coder-1.5B**, served as Q4_K_M GGUF.
**Endpoint:** a 1.5B model running on-device via GGUF, in your editor, offline.

### Why two models

| | Dev loop — 0.5B | Ship — 1.5B |
|---|---|---|
| SFT run | **20–40 min** | 2–3 hours |
| GRPO on 4 GB | Comfortable — the deck's stated feasible size | Tight VRAM, ~3× slower generation |
| Baseline HumanEval+ | ~26 ± 2 | ~38 ± 2 |
| Serving footprint | ~300–400 MB Q4_K_M | **986 MB Q4_K_M · 1,394 MiB VRAM · 116 tok/s** (measured) |

**Build at 0.5B, ship at 1.5B.** Experiments per week is what determines how fast you learn, and a
2–3 hour SFT run costs you the ablation week that teaches the most. Once the recipe is settled,
re-run it at 1.5B **once** and quantize. This is Rule 3 — *prototype at 0.5B before anything else* —
applied deliberately rather than as a rule of thumb.

---

## The pipeline — do not reorder

```
sandbox → eval harness → baseline → data curation → SFT → RFT → DPO → GRPO → self-repair → merge → serve
```

| # | Phase | Machine | What you build | Done when |
|---|---|---|---|---|
| 1 | Setup | Both | Working environments, W&B, disk layout | Smoke tests pass on both machines |
| 2 | Model | Mac | Base model chosen, template verified | Model generates sane output from your template |
| 3 | Sandbox | Mac | Untrusted-code executor + adversarial suite | Survives infinite loop, fork bomb, network, escape |
| 4 | Eval | Mac | pass@k harness, baselines, held-out split | Reproducible score ± std, three seeds |
| 5 | Data | Mac | Curated, deduped, decontaminated corpus | Curated-10k beats raw-100k at equal compute |
| 6 | SFT | **TUF** | First fine-tuned model | Beats baseline across three seeds |
| 7 | RFT | Both | Rejection-sampled self-improvement | Beats SFT; you can explain why without RL |
| 8 | DPO | **TUF** | Preference-optimized model | Beats RFT; length tracked before/after |
| 9 | GRPO | **TUF** | RL with verifiable rewards | Beats DPO **and** two documented hacks with fixes |
| 10 | Repair | Both | Self-repair from tracebacks | First-attempt and after-repair reported separately |
| 11 | Merge | Mac | Merged checkpoint | Merged beats every individual checkpoint |
| 12 | Serve | Both | Quantized, on-device model | Runs in your editor, offline |

> **The order is not negotiable:** sandbox → eval harness → baseline → data → training.
> Skipping ahead costs weeks.

---

## Why the ruler comes before the gradient

- **You cannot improve what you cannot measure.** Obvious, and universally ignored. Everyone wants to
  train on day one. The people who build eval first finish faster.
- **Most "improvements" are measurement artifacts.** Prompt drift, seed noise, contamination, a
  changed extraction regex.
- **The verifier IS the reward function.** In the GRPO phase this exact sandbox code becomes your
  reward. Building it well now is building the RL infrastructure now.
- **It sets the honest baseline.** Every claim in `results/` is "better than X". If X is wrong, every
  claim is wrong.
- **It catches your bugs, not the model's.** Half of what an eval harness finds in month one is
  broken data plumbing, not model behavior.
- **It makes failure legible.** "It got worse" is useless. "pass@1 fell 3.2 ± 0.7 on held-out,
  concentrated in problems needing recursion" is actionable.

---

## Prerequisites — be honest

**You need these**

- Python: comfortable with classes, generators, context managers
- PyTorch: tensors, autograd, what `.backward()` does
- The transformer block, at least conceptually
- Git, virtualenv/conda, the shell
- Willingness to read tracebacks instead of guessing

**You do not need these**

- CUDA kernel programming
- Distributed training theory
- The math of attention derived from scratch
- A GPU cluster, or any rented compute
- Prior ML research experience

> If PyTorch autograd is genuinely unfamiliar, spend three days on it first. Everything downstream
> assumes you can read a training loop and know what a gradient is.

---

## Vocabulary — used from here on without further explanation

| Term | What it means in practice |
|---|---|
| **Base model** | Pretrained weights, no instruction tuning. Completes text; does not answer questions. |
| **Instruct model** | Base + post-training. Follows instructions, has a chat template, knows when to stop. |
| **SFT** | Supervised fine-tuning. Train on (prompt, ideal completion) pairs. Teaches format and task shape. |
| **PEFT** | Parameter-efficient fine-tuning. Train a small number of added parameters, freeze the rest. |
| **LoRA** | The dominant PEFT method. Learns two small matrices whose product approximates the weight update. |
| **QLoRA** | LoRA on top of a 4-bit quantized frozen base. ~20× memory reduction vs full fine-tuning. |
| **Adapter** | The trained LoRA weights, stored separately. Tens of MB, hot-swappable at serve time. |
| **Preference optimization** | Training on comparisons (A is better than B) rather than on a single target. |
| **DPO** | Direct Preference Optimization. Preference learning with no reward model and no rollouts. |
| **Reward model** | A model trained to score outputs. Needed for PPO; DPO removes the need for it. |
| **RLVR** | RL with Verifiable Rewards. The reward comes from a program (tests, checker), not a model. |
| **GRPO** | Group Relative Policy Optimization. Scores a group of rollouts against each other; no value model. |
| **Rollout** | One generated sample from the policy during RL. You will read thousands of these. |
| **Policy** | The model being trained, in RL terminology. |
| **Reference model** | A frozen copy of the starting model. KL divergence from it is penalized to prevent drift. |
| **KL penalty** | The leash. Stops the policy wandering into gibberish that happens to score well. |
| **pass@k** | Probability at least one of k sampled solutions passes the tests. The core code metric. |
| **Contamination** | Eval problems present in training data. Inflates scores without improving the model. |
| **Decontamination** | Removing them. Must be re-run on **every** data change, not once. |
| **Loss masking** | Computing loss only on completion tokens, not prompt tokens. The classic silent bug. |
| **Chat template** | The exact token format wrapping turns. Mismatch between train and eval silently destroys scores. |
| **Catastrophic forgetting** | Gaining the new task while losing general ability. Measure it or it happens invisibly. |
| **Reward hacking** | Model satisfies the reward function without doing the task. **Guaranteed, not hypothetical.** |
| **Distillation** | Training a small student on a large teacher's outputs. Your two machines make this free. |
| **Merging** | Averaging several fine-tuned checkpoints into one. Costs no GPU time, often free gains. |
| **Quantization** | Storing weights at lower precision. 4-bit is the practical floor for quality. |

---

## The core metric

**pass@k** is the probability that at least one of k sampled solutions passes all tests. It is *not*
a percentage of problems solved — it is an estimate of a probability, and how you estimate it matters.

```python
# The unbiased estimator (Chen et al., Codex paper)
# n = samples generated per problem (n >> k)
# c = number of those n that passed

def pass_at_k(n, c, k):
    if n - c < k:
        return 1.0
    return 1.0 - np.prod(
        1.0 - k / np.arange(n - c + 1, n + 1)
    )

# Then average pass_at_k over all problems.
```

- **Typical settings:** n = 20 or 50, then report pass@1, pass@5, pass@10 from the same generation
  run. One expensive generation, three metrics.
- **pass@1 with n=1 is not pass@1.** It is a single coin flip. This is why numbers jump around by
  4 points between runs.

| Pattern | Signature | Meaning |
|---|---|---|
| **The diversity trap** | pass@10 up, pass@1 flat | You made the model less certain, not more capable. Common after high-temperature RFT. |
| **The sharpening effect** | pass@1 up, pass@10 down | Probability concentrated on the best answer. Good for deployment, bad for search-based inference. |
| **Both up** | the real win | Genuine capability improvement. Rarer than you would like. |

---

## The baseline table you are measuring against

Approximate placeholders — **your measured table is the real one.**

| Model | HumanEval+ pass@1 | MBPP+ pass@1 | Role |
|---|---|---|---|
| Qwen2.5-Coder-0.5B-Instruct | ~26 ± 2 | ~40 ± 2 | **Dev-loop baseline.** Every ablation is measured against this. |
| Qwen2.5-Coder-1.5B-Instruct | ~38 ± 2 | ~52 ± 2 | **Ship-target baseline.** The final recipe is measured against this. |
| Qwen2.5-Coder-7B-Instruct | ~62 ± 2 | ~68 ± 2 | Teacher / ceiling. **Mac inference only.** |
| Qwen2.5-0.5B-Instruct (non-code) | ~12 ± 2 | ~22 ± 2 | Control. Isolates code-specific gains. |

- **You need two baselines, not one.** 0.5B is what ablations are judged against; 1.5B is what the
  shipped model is judged against. Never compare a 1.5B checkpoint to the 0.5B baseline — that gap is
  scale, not your work.
- **The control is the point** — it tells you how much of any gain is code-specific versus generic
  instruction-following.
- **The ceiling is the point** — if your 0.5B approaches 7B on your custom set, you have done
  something real.
- Write it down in `results/00-baseline.md` with the harness commit SHA, template name, seeds, and date.

> Published numbers and measured numbers disagreed by up to **6 points on identical weights** —
> different prompt, different stop tokens, different extraction. **Do not trust any number you did
> not reproduce yourself, including the ones in this table.**

---

## How to work on this machine

- **Depth over summary.** When reference material is requested, exhaustive beats concise.
- **Order by workflow**, not by taxonomy. Present things in the sequence they would actually be done.
- **State assumptions and proceed.** Don't stop to ask about things a careful engineer would decide.
- **Numbers, not adjectives.** "seq_len 512, batch 1, accum 16" beats "use a small batch size".
- **Flag the trap.** If a step has a silent failure mode, say so *at that step* — not in a summary.
- **Say when something won't work here.** "That needs 24 GB; it won't run on this box" is the useful
  answer. Don't hedge.

---

## Where the rest of it lives

The full **190-slide field guide** is at `docs/ULTRON-Field-Guide.pptx`, built from
`docs/sections/*.js`. Regenerate with `node build.js`; build one section with `node build.js 06`.
The topic manifest is `docs/OUTLINE.md`.

Everything in `TUF/` is distilled from that deck, filtered to what this machine needs.
