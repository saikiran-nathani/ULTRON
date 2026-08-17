# Training Configs — every number the TUF needs

Concrete, runnable configs per phase. All numbers assume **Ubuntu in hybrid mode** (display on the
integrated Radeon), so the 3050 has ~3.95 GB usable.

**Constant across every config:**

```
bf16=True · gradient_checkpointing=True · optim='paged_adamw_8bit'
per_device_train_batch_size=1 · seed=0 · report_to='wandb'
```

---

## Cross-phase quick reference

### Learning rates — the number people get wrong

| Phase | LR | Relative to SFT | Symptom if you use SFT's LR |
|---|---|---|---|
| SFT (LoRA/QLoRA) | **2e-4** (range 1e-4 – 3e-4) | 1× | — |
| RFT | Same as SFT — exactly the SFT recipe | 1× | — |
| DPO | **5e-6** (range 5e-7 – 5e-6) | **40× lower** | destroys the model in ~50 steps |
| GRPO | **1e-6** (range 1e-6 – 5e-6) | **200× lower** | policy collapses within ~50 steps |

> LoRA needs a learning rate roughly **10× higher than full fine-tuning.** Copying an LR from a
> full-FT tutorial is the classic "LoRA doesn't work" bug.

Full reference, all settings:

| Setting | Typical LR | Too high | Too low |
|---|---|---|---|
| Full fine-tune | 1e-5 – 5e-5 | Loss spikes, then NaN | Barely moves off baseline |
| LoRA / QLoRA | **1e-4 – 3e-4** | Loss oscillates; output degrades into repetition | Loss falls slowly, model unchanged |
| Embeddings (if targeted) | 1e-5 – 5e-5 | Vocabulary collapse | No effect |
| DPO | 5e-7 – 5e-6 | Reference drift, gibberish | Preference margin never separates |
| GRPO | 1e-6 – 5e-6 | Policy collapse within ~50 steps | Reward flat for hours |

- **Schedule:** cosine with warmup. Warmup 3–5% of total steps, then decay to ~10% of peak.
- **Sweep in multiples of 3:** `1e-4, 3e-4, 1e-3`. Sweeping 2e-4 vs 2.5e-4 is measuring noise.
- **Verify the schedule is real.** Log LR every step. A scheduler stuck flat at peak is common and invisible.

### Batch / accumulation

| Phase | batch | grad_accum | Effective |
|---|---|---|---|
| SFT | 1 | 16 | 16 |
| DPO | 1 | 16 | 16 |
| GRPO | 1 | 8 | 8 (× `num_generations=8` samples/prompt) |

```
effective_batch = per_device_batch × gradient_accumulation_steps × num_devices

# Your 4GB reality:
per_device_batch = 1        # VRAM-bound
gradient_accumulation = 16  # free, costs only time
effective_batch = 16        # <- what actually matters
```

| Regime | Value | Consequence |
|---|---|---|
| Small | eff = 1–4 | Noisy gradients, unstable loss, poor quality. Almost always accidental misconfiguration. |
| **Good** | **eff = 16–64** | The sweet spot for SFT on 5k–100k examples. |
| Large | eff = 128+ | Smoother, but on a 10k dataset that is only ~80 optimizer steps per epoch. Too few to learn much. |

### Sequence lengths

| Phase | Setting | Value |
|---|---|---|
| SFT (Unsloth load) | `max_seq_length` | 1024 |
| SFT (SFTConfig) | `max_seq_length` | 1024 — **from YOUR p95, not a guess** |
| DPO | `max_length` / `max_prompt_length` | 1024 / 512 |
| GRPO | `max_prompt_length` / `max_completion_length` | 384 / 384 — **short, VRAM-bound** |

### Eval / checkpoint cadence

| Phase | eval_steps | Checkpointing | Selection metric |
|---|---|---|---|
| SFT | 100 | `load_best_model_at_end=True` | `eval_pass_at_1` — **never `eval_loss`** |
| DPO | 50 | — | held-out pass@1 (best often at step 80 of 400) |
| GRPO | — | `save_steps=25`, `logging_steps=1` | reward + held-out pass@1 on the same axis |

---

## THE MEMORY MATH — 4 GB, line by line

| Component | Formula | 0.5B QLoRA | 1.5B QLoRA |
|---|---|---|---|
| Base weights (NF4) | ~0.55 bytes/param | 0.28 GB | 0.83 GB |
| LoRA adapter (bf16) | 2 bytes/trainable | 0.01 GB | 0.03 GB |
| Gradients (adapter only) | 2 bytes/trainable | 0.01 GB | 0.03 GB |
| Optimizer state (8-bit Adam) | 2 bytes/trainable | 0.01 GB | 0.03 GB |
| Activations (seq 512, batch 1) | scales with seq × batch | 0.35 GB | 0.75 GB |
| CUDA context + fragmentation | fixed overhead | 0.50 GB | 0.50 GB |
| Desktop compositor | 0 on Linux — was 0.5–1.0 on Windows | 0.00 GB | 0.00 GB |
| **TOTAL** | | **~1.2 GB** | **~2.2 GB** |
| Headroom of the 3.95 GB usable | | **2.75 GB — raise batch** | **1.75 GB — raise seq_len** |

> **Activations dominate and they scale with `seq_len × batch_size`.**
> Cut sequence length before you cut model size.

Three levers:

- **Gradient checkpointing** — trades ~30% speed for a large activation reduction. Turn it on the moment you hit OOM.
- **Flash Attention 2** — attention memory from O(n²) to O(n). Free win on Ampere. Compile it once.
- **Unsloth** — halves the budget again via fused kernels. **Non-optional at 1.5B.**

### Full FT vs LoRA vs QLoRA

| | Full fine-tune | LoRA | QLoRA |
|---|---|---|---|
| Trainable params | 100% | 0.1–2% | 0.1–2% |
| Memory for 0.5B | ~8 GB | ~1.5 GB | ~0.6 GB |
| Memory for 1.5B | ~24 GB | ~4.5 GB | ~1.6 GB |
| Memory for 7B | ~112 GB | ~20 GB | ~6 GB |
| **Runs on your 4GB card** | **No** | **0.5B only** | **Both, comfortably** |
| Quality ceiling | Highest | ~98% of full FT | ~97% of full FT |
| Artifact size | Full model (GB) | Adapter (MB) | Adapter (MB) |

**Use QLoRA. All of it.** On this hardware there is no decision to make.

---

# PHASE: SFT

**Duration: one to two weeks.** Run time: 20–40 min at 0.5B, 2–3 hours at 1.5B.

## The recipe

- QLoRA, **r=16, alpha=32**, target **all-linear**, **bf16**
- **LR 2e-4** with cosine schedule and **3% warmup**
- **Effective batch 16** via batch 1 × accumulation 16
- `seq_len` from your data's **p95**, not a round number
- **1–3 epochs**; evaluate **every 100 steps**, not every epoch
- Checkpoint on **`eval_pass_at_1`**, never on `eval_loss`
- Verify masking by decoding a batch; verify trainable % is non-zero
- Run a general benchmark each checkpoint to catch forgetting

## LoRA rank

| r | Params (0.5B, all-linear) | Capacity | Use when |
|---|---|---|---|
| 4 | ~1.5 M | Very constrained | Tiny datasets (< 1k), style-only adaptation |
| 8 | ~3 M | Light | Small datasets, quick experiments |
| **16** | **~6 M** | **Balanced — the default** | **Most tasks. Start here.** |
| 32 | ~12 M | Generous | Larger datasets (50k+), bigger distribution shift |
| 64 | ~24 M | High | Substantial behavior change; watch for overfitting |
| 128+ | ~48 M+ | Approaching full FT | Rarely justified. Usually a sign the problem is elsewhere. |

> **The rule:** < 5k examples → r=8. 5k–50k → r=16. 50k+ → r=32. Then ablate around your start point.

Higher rank is not "better" — it is **more capacity**. More capacity on a small dataset means
faster memorization, not better generalization. **Ablate rank AFTER the data is clean.**

## Alpha and the scaling trap

```
W' = W + (alpha / r) * B @ A

# r=16, alpha=32  ->  scale 2.0    <- common default
# r=16, alpha=16  ->  scale 1.0    <- conservative
# r=64, alpha=16  ->  scale 0.25   <- update barely applied!

# THE TRAP: raising r while keeping alpha fixed
# SHRINKS the effective update. People raise rank,
# see no improvement, and conclude rank does not matter.
```

| Convention | Value | Effect |
|---|---|---|
| **The convention** | `alpha = 2r` | Keeps scale at 2.0 as you vary rank, so a rank sweep actually measures rank |
| The alternative | `alpha = r` | Scale 1.0. Also fine. What matters is **consistency** across a sweep |
| rsLoRA | `alpha/sqrt(r)` | Keeps scale sane at high rank. Worth enabling for r ≥ 64 |
| alpha ↔ LR | — | Doubling alpha ≈ doubling the adapter's LR. **Do not tune both at once** |

## Target modules

| Target set | Modules | Effect |
|---|---|---|
| Attention only (original paper) | `q_proj, v_proj` | Works, but leaves capability on the table |
| Full attention | `q, k, v, o_proj` | Better; still misses the MLP where most parameters live |
| **all-linear (recommended)** | `q,k,v,o + gate,up,down_proj` | **Consistently best in practice. The default you want.** |
| + embeddings / lm_head | above + `embed_tokens, lm_head` | Only if you added tokens to the vocabulary |

```python
peft_config = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,
                        target_modules='all-linear', task_type='CAUSAL_LM')
model = get_peft_model(model, peft_config)
model.print_trainable_parameters()   # ALWAYS. Expect ~0.5-2%. If 0.0%, you targeted nothing.
```

> **A typo in `target_modules` silently trains nothing at all and looks like a normal run.**

## QLoRA — the three tricks that fit 1.5B on 4 GB

1. **NF4** — 4-bit NormalFloat, information-theoretically optimal for normally-distributed values.
   Dequantized on the fly during the forward pass. ~8× smaller than fp32.
2. **Double quantization** — the quantization constants are themselves quantized. Another ~0.4 bits
   per parameter. Meaningful when you are 200 MB from an OOM.
3. **Paged optimizers** — optimizer state lives in unified memory and pages to CPU RAM under
   pressure. Turns a hard OOM crash into a slowdown. **On 4 GB this is what makes long runs survivable.**

```python
bnb_config = BitsAndBytesConfig(
    load_in_4bit=True, bnb_4bit_quant_type='nf4',
    bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)
# compute_dtype is NOT the storage dtype — weights stored 4-bit, computed in bf16
```

## Unsloth — 2× throughput, 50–70% less VRAM

No accuracy loss; it is an implementation optimization, not an approximation. Replaces hot paths
(attention, MLP, RoPE, cross-entropy) with hand-written Triton kernels and a manual backward pass.

> It is the difference between 1.5B being trainable on this card and not.
> At 0.5B it means **twice as many experiments per day.**

```python
from unsloth import FastLanguageModel
model, tok = FastLanguageModel.from_pretrained(
    'unsloth/Qwen2.5-Coder-0.5B-Instruct', max_seq_length=1024,
    load_in_4bit=True, dtype=None)                    # dtype=None -> auto bf16
model = FastLanguageModel.get_peft_model(
    model, r=16, lora_alpha=32, lora_dropout=0.0,     # 0.0 is Unsloth's fast path
    target_modules=['q_proj','k_proj','v_proj','o_proj',
                    'gate_proj','up_proj','down_proj'],
    use_gradient_checkpointing='unsloth')             # their own, more efficient variant
```

## `sft.py` — the full config

```python
from trl import SFTTrainer, SFTConfig
from trl import DataCollatorForCompletionOnlyLM

# THE CRITICAL LINE — this string must match your template EXACTLY
collator = DataCollatorForCompletionOnlyLM(
    response_template='<|im_start|>assistant\n', tokenizer=tok)

cfg = SFTConfig(
    output_dir='ckpt/06-sft-r16-lr2e4',
    per_device_train_batch_size=1,
    gradient_accumulation_steps=16,      # effective batch = 16
    num_train_epochs=2,
    learning_rate=2e-4,                  # 10x a full-FT LR
    lr_scheduler_type='cosine', warmup_ratio=0.03,
    bf16=True, gradient_checkpointing=True,
    optim='paged_adamw_8bit',
    max_seq_length=1024,                 # from YOUR p95, not a guess
    logging_steps=10,
    eval_strategy='steps', eval_steps=100,          # mid-epoch eval
    load_best_model_at_end=True,                    # pick on EVAL
    metric_for_best_model='eval_pass_at_1',         # not eval_loss!
    seed=0, report_to='wandb',
)
trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds,
                     data_collator=collator, peft_config=peft_config)
```

> **`response_template` must match your chat template byte for byte.**
> A mismatch means NO masking is applied and **nothing warns you.**

## Sequence length, packing, truncation

| Padding (default) | Packing |
|---|---|
| Each example padded to `seq_len` | Multiple examples concatenated into one sequence |
| Simple, obviously correct | Near-zero wasted compute — **often 2–3× throughput** |
| Wastes compute on padding tokens | Needs correct position ids and attention masking |
| Short-example datasets can be **60% padding** | Naive packing lets examples attend across boundaries |
| Attention mask prevents cross-contamination | TRL supports it; **verify the mask, do not assume** |

- **Choose `seq_len` from the p95.** Truncating 5% is fine; truncating 25% silently destroys your data.
- **Truncation is invisible** — no warning is emitted. Log the truncation rate every run.
- **Packing changes the batch math** — with packing, "batch size 1" may be six examples.

## Epochs — where loss and capability diverge

| Epoch | Train loss (norm.) | Held-out pass@1 (norm.) |
|---|---|---|
| 0 | 1.00 | 0.70 |
| 0.5 | 0.71 | 0.86 |
| 1 | 0.58 | 0.95 |
| **1.5** | 0.47 | **1.00 ← peak** |
| 2 | 0.39 | 0.99 |
| 2.5 | 0.31 | 0.96 |
| 3 | 0.25 | 0.93 |
| 4 | 0.15 | 0.88 |
| 5 | 0.08 | 0.82 |

- **1–3 epochs for SFT.** Beyond three, you are memorizing.
- **Checkpoint on EVAL, never on loss.** They diverge after roughly epoch 1.5. Saving on best-loss
  ships your worst useful model.
- **Evaluate mid-epoch.** On a 10k dataset one epoch is few steps.
- **Keep every checkpoint.** Adapters are tens of MB. You will want them for merging.

## Catastrophic forgetting

- **Mix in general data: 5–15%.** Costs about half a point of code performance, recovers most general ability.
- Lower rank / fewer epochs — less capacity and less exposure means less overwriting.
- Merge with the base later — recovers general ability at some task cost. A genuine dial.
- **Run a general benchmark on every checkpoint.** Without it, forgetting is invisible until a user complains.

## SFT traps

- Full-FT learning rate (2e-5) on LoRA — 10× too low, looks like "LoRA doesn't work"
- Loss over prompt tokens — the silent bug that costs a week
- `response_template` not matching the chat template — masking silently disabled
- Raising rank while holding alpha fixed — shrinks the update, hides the effect
- Saving on best loss — ships your most memorized checkpoint
- `seq_len` guessed — silently truncates a quarter of your data
- Grad accumulation set in the wrong config block — effective batch 1
- fp16 on a bf16-capable card — NaN on step 1

> Every one of these produces a run that **completes**. Nothing errors. The loss curve often looks fine.

---

# PHASE: RFT (Rejection Sampling)

**Duration: one week.** Generate many attempts → keep only what passes → fine-tune on those → repeat.

## The loop

1. **Take problems that ship with tests** — CodeContests, APPS, TACO, MBPP-train.
2. **Generate N samples per problem at temperature > 0** — **N = 10–50, temp 0.8–1.0.**
   At temperature 0 you get the same wrong answer N times and learn nothing.
3. **Execute every sample through the sandbox** — millions of executions; Level 1 speed matters here.
4. **Keep the passers** — typically **5–30% survive**. That is normal — you are mining, not harvesting.
5. **Deduplicate the survivors** — without dedup, easy problems dominate by volume of duplicates.
6. **Stratify by difficulty when keeping** — cap per problem AND per difficulty band.
7. **SFT on the result** — exactly the SFT recipe. Same trainer, same config shape, new data version.
8. **Evaluate, then consider iterating.**

## N and temperature

| Setting | Effect | Recommendation |
|---|---|---|
| N = 4 | Few passers; only easy problems yield anything | Too few. Difficulty collapse guaranteed. |
| **N = 10** | Reasonable yield on easy and medium | **Good starting point for round 1** |
| N = 20–50 | Mines genuinely hard problems | Use on the hard slice only, not uniformly |
| temp = 0.0 | Identical output N times | Useless. One sample, N times. |
| temp = 0.6 | Mild diversity | Too conservative; wastes the sampling budget |
| **temp = 0.8–1.0** | Genuine diversity | **The working range. Start at 0.8.** |
| temp = 1.2+ | High diversity, more garbage | Occasionally useful for very hard problems only |

**Adaptive sampling:** give easy problems N=5 and hard problems N=50. Uniform N wastes most of your
compute re-solving trivial problems. Yield rate at fixed N and temperature **is** your difficulty label.

## Difficulty collapse — the failure that kills round 2

| Difficulty band | Problems in source set | Surviving samples (naive RFT) |
|---|---|---|
| Easy | 30% | **71%** |
| Medium | 40% | 26% |
| Hard | 30% | **3%** |

- **Mechanism:** hard problems produce few or no passing samples; easy problems produce many. You
  train on what the model could already do.
- **Symptom:** round 2 shows almost no improvement.
- **Fix 1 — cap per problem:** keep at most **k = 1–4** passing samples per problem.
- **Fix 2 — stratified quotas:** fixed proportion from each band, even if that means keeping every
  single hard-problem success.
- **Fix 3 — adaptive N:** N=50 on hard, N=5 on easy, same total budget.

## Filtering strategy

| Strategy | Effect | When |
|---|---|---|
| All passers | Maximum volume; easy problems dominate | Never, without a per-problem cap |
| Best-1 per problem | Clean, low-volume, low-diversity | Small datasets; quality > quantity |
| **Top-k per problem (k=2–4)** | **Balanced. The default.** | **Most of the time** |
| Diverse-k | Preserves solution variety | When you want to keep pass@10 alive |
| Shortest passer | Biases toward terse code | If you want concision; watch for golf |
| Include near-misses (>80% tests) | Adds signal on hard problems | **Risky — teaches subtly wrong code** |

> **Do not keep near-misses in RFT — save them for DPO.** A solution passing 80% of tests is WRONG.
> It is excellent DPO "rejected" data though.

**Dedup AFTER filtering, not before.** Near-identical passers are extremely common at temperature 0.8.

## Iterated RFT — when to stop

- **Round 1** — generate with the SFT model.
- **Round 2** — generate with the RFT-1 model. It now solves problems round 1 could not.
- **Round 3** — diminishing returns arrive. Gains typically shrink sharply by round 3.
- **The stopping signal:** track how many problems yield their **first** passing sample this round.
  When that number collapses, iteration is finished — **not** when eval plateaus.
- **Keep the original data — mix, don't replace.** Always mix RFT data with the curated set.

## RFT traps

- Temperature 0: N identical samples, zero information
- Uniform N: wastes budget re-solving easy problems
- Keeping all passers: easy problems drown everything else
- No per-problem cap: one problem contributes fifty examples
- Skipping dedup: near-identical solutions inflate volume
- Keeping near-misses: teaches confidently wrong code
- Training purely on self-generated data: style drifts
- Iterating past round 3 with no first-time-solved growth

> "I proudly reported a 50,000-example RFT dataset. After dedup it was **11,000** — the rest was the
> same handful of easy solutions sampled repeatedly. The model trained on it was **worse** than the
> one trained on the deduplicated set."

---

# PHASE: DPO

**Duration: one week.** Run time: 30–60 min. Cheap — iterate freely.

## The recipe

- Build pairs from RFT execution outcomes — **they are free**
- Chosen and rejected must answer the **same prompt**
- **beta = 0.1, LR = 5e-6, ONE epoch**
- Reference model is your **RFT checkpoint**, not the base
- With LoRA, `ref_model=None` — TRL disables the adapter
- Log implicit reward margin, reference KL, and **output length**
- Do 2–3 iterative rounds, regenerating pairs each time

## The loss

```
# The implicit reward — the policy IS the reward model
r(x, y)  =  beta * log( pi(y|x) / pi_ref(y|x) )

# The DPO loss on a preference pair (chosen yw, rejected yl):
L = -log sigmoid( beta * [
        log(pi(yw|x) / pi_ref(yw|x))
      - log(pi(yl|x) / pi_ref(yl|x))
    ] )

# Two models in memory, not four. No rollouts.
# pi_ref is FROZEN — it is your RFT checkpoint.
```

With LoRA you do not even need two copies — disable the adapter to get the reference.
**This is why DPO fits on 4 GB.**

## Beta — the leash

| beta | Behavior | Use when |
|---|---|---|
| 0.01 | Very weak leash; can lose syntax validity | Almost never |
| 0.05 | Loose; strong preference learning, some drift risk | Large, high-quality pair sets |
| **0.1** | **Balanced — the default** | **Start here** |
| 0.3 | Tight; slow, conservative learning | Small or noisy pair sets |
| 0.5+ | Very tight; barely moves from reference | When DPO is destabilizing everything |

- **Watch the implicit reward margin** (`chosen_rewards − rejected_rewards`). It should rise then
  plateau. **If it explodes, beta is too low.**
- **Watch reference KL.** Unbounded growth means you are drifting. Raise beta or stop earlier.

## Building pairs

| Pair source | Chosen | Rejected | Signal quality |
|---|---|---|---|
| **Execution outcome (free!)** | Passes all tests | Fails tests | **Excellent — objective, zero labeling** |
| **Partial credit** | Passes 100% | Passes 60–90% | Very good — "nearly right" is a strong negative |
| Efficiency | Passes, fewer ops | Passes, brute force | Good — needs a benchmark harness |
| Length (both correct) | Concise correct | Verbose correct | Good — directly counters verbosity bias |
| Style / idiom | Idiomatic | Non-idiomatic | Needs a judge; subjective |
| Teacher vs student | Teacher output | Student output | Risky — teaches imitation, not correctness |

> RFT threw away every **failing** sample. Those are your rejected side.
> **Your preference dataset already exists.**

**Pair within a problem.** Cross-problem pairs teach ranking of problems, not quality of solutions.

## `dpo.py` — the full config

```python
from trl import DPOTrainer, DPOConfig

cfg = DPOConfig(
    output_dir='ckpt/08-dpo-b0.1',
    beta=0.1,                        # the leash. Start here.
    learning_rate=5e-6,              # 40x LOWER than SFT. Not a typo.
    lr_scheduler_type='cosine', warmup_ratio=0.1,
    per_device_train_batch_size=1,
    gradient_accumulation_steps=16,
    num_train_epochs=1,              # DPO overfits fast. One epoch.
    max_length=1024, max_prompt_length=512,
    bf16=True, gradient_checkpointing=True,
    optim='paged_adamw_8bit',
    loss_type='sigmoid',             # 'ipo' | 'kto_pair' | 'simpo' here
    eval_strategy='steps', eval_steps=50,
    seed=0, report_to='wandb',
)

# ref_model=None -> TRL disables the LoRA adapter to get reference logprobs.
# One model in memory. This is what makes DPO viable on 4GB.
trainer = DPOTrainer(model=model, ref_model=None, args=cfg,
                     train_dataset=pairs, peft_config=peft_config)
```

> **SFT uses 2e-4; DPO uses 5e-6.** Copying the SFT LR destroys the model in fifty steps.

## Verbosity bias — log output length on every run

| Phase | Mean output length (lines) |
|---|---|
| Base | 38 |
| After SFT | 41 |
| After RFT | 44 |
| **After DPO** | **96** |

Longer sequences accumulate more log-probability terms. The DPO objective has a **structural**
preference for length that has nothing to do with quality. In code it looks like: defensive
try/except around everything, redundant comments, unnecessary helpers, docstrings restating the signature.

**Fixes:** length-matched pairs · SimPO (length-normalized loss) · deliberately include
(concise correct, verbose correct) pairs.

> "41 lines to 96 after DPO, almost entirely comments and defensive error handling.
> **pass@1 rose 0.4 points.** I had trained a model to LOOK thorough."

## The DPO family

| Method | Data needed | Reference? | What it fixes |
|---|---|---|---|
| **DPO** | Pairs | Yes | The baseline. Simple, well understood, well supported. |
| IPO | Pairs | Yes | DPO overfits when preferences are deterministic; IPO regularizes |
| KTO | **Binary labels** | Yes | No pairs needed. Matches how real production feedback arrives. |
| ORPO | Pairs | **No** | Folds SFT and preference into one stage |
| SimPO | Pairs | **No** | Reference-free, length-normalized. Directly attacks verbosity bias. |
| CPO | Pairs | **No** | Contrastive variant; memory-efficient |

> Run DPO, then KTO on the same data converted to binary, then ORPO from the SFT checkpoint.
> **Three runs, one afternoon.**

## DPO traps

- SFT learning rate (2e-4): destroys the model within ~50 steps
- Multiple epochs: DPO overfits preference data very fast
- Cross-problem pairs: teaches problem ranking, not solution quality
- Base model as reference: fights all your prior training
- Not logging output length: verbosity bias goes unnoticed for weeks
- beta too low: policy drifts and loses basic syntax validity
- Judging with an LLM when you have a verifier available
- **Expecting RFT-sized gains** — in verifiable domains DPO gives less. Its value is control, not raw capability.

---

# PHASE: GRPO

**Duration: two to three weeks.** Run time: **8–24 hrs.** This is an overnight-run discipline, not
an interactive one.

## The recipe

- **Dense reward: fraction of tests passed, never binary**
- Filter problems to **pass-rate 0.2–0.8** before training
- **Group size 8**; log the fraction of zero-variance groups
- **LR ~1e-6, KL beta ~0.04**, short completions
- **Checkpoint every 25 steps** — RL collapses without warning
- Log **20 rollouts every 50 steps** as a table, and READ them
- Plot reward and held-out pass@1 **on the same axis**
- Add each penalty only in response to an **observed** hack

## Why GRPO and not PPO

| | PPO | GRPO |
|---|---|---|
| Models in memory | Policy + reference + reward + **value** | **Policy + reference** |
| Baseline for advantage | Learned value function (an extra network) | **Mean reward of the sampled group** |
| **Memory on your 4GB card** | **Impossible** | **Feasible at 0.5B** |
| Stability failure mode | Value function diverges, drags policy with it | Group collapse — all samples score identically |

```python
# GRPO's central trick: the group IS the baseline.
for each prompt:
    outputs = [policy.sample(prompt) for _ in range(G)]      # G = group size, e.g. 8
    rewards = [reward_fn(o) for o in outputs]
    advantages = (rewards - mean(rewards)) / (std(rewards) + eps)   # <- no value model
    # then a PPO-style clipped policy-gradient update, plus a KL term
```

## Group size

| G | Advantage estimate | Verdict |
|---|---|---|
| 2 | Extremely noisy; std is meaningless | Too small. Training will not move. |
| 4 | Noisy but functional | Viable on very constrained hardware |
| **8** | Reasonable signal | **The practical default on your card** |
| 16 | Good signal, stable advantages | Better if you can afford the generation time |
| 32–64 | Excellent | Standard in published work; **impractical on 4 GB** |

**Group collapse:** if every sample in a group scores the same, std is zero, advantage is zero, **no
gradient at all.** Happens when problems are far too easy or far too hard.

> **Curate for the middle: pass rate 0.2–0.8.** Feed GRPO problems your model solves *sometimes*.
> **Log the fraction of dead groups (std == 0)** — this is the most useful GRPO diagnostic.
> "My first GRPO run had **71% dead groups**. Filtering to pass-rate 0.2–0.8 **tripled the useful
> gradient per hour.**"

## Dense vs binary reward — the single highest-leverage decision

| Step | Binary reward | Dense reward (fraction passed) |
|---|---|---|
| 0 | 0.20 | 0.20 |
| 200 | 0.22 | 0.34 |
| 400 | 0.23 | 0.43 |
| 600 | **0.25** | **0.48** |

- **Binary starves the group.** On a hard problem all 8 samples fail. Reward 0 for every one. Std
  zero. Advantage zero. **No gradient.**
- **Dense creates a slope.** One sample passes 3 of 10 tests, another passes 5. Now there is variance,
  an advantage, and a direction to move.

> Bigger than group size, bigger than KL coefficient, bigger than learning rate. **Get it right first.**
> "I ran binary reward for two days and concluded GRPO did not work on small models. It was not GRPO.
> Ninety percent of my groups had zero variance."

## The composite reward

| Term | Trigger | Value |
|---|---|---|
| **Correctness** | fraction of tests passed | **0.0 – 1.0** — the primary term, dense not binary |
| Format | parseable fenced code block | **+0.1** — drop it once the model reliably formats |
| Compiles | `ast.parse` succeeds | **+0.1** — gradient on problems where nothing passes yet |
| Timeout | execution exceeded limit | **−0.2** — without this, infinite loops are free |
| Banned imports | `os, sys, subprocess, socket` | **−1.0** — must be paired with **actual sandbox enforcement** |
| Test-file access | flagged by sandbox | **−1.0** — the single most important penalty |
| Length | tokens beyond a cap | **−0.001/token beyond 512** — optional; watch for truncation gaming |

> **Start with correctness + format only.** Add each penalty in response to a hack you actually
> observed — not preemptively.

### Six rules for reward design

1. **Your reward function IS the task specification.** Write it as if an adversary will read it, because one will.
2. **Prefer dense over sparse.**
3. **Every term you add is a new attack surface.** A format reward invites format-only outputs. A length penalty invites truncation.
4. **Penalties need enforcement, not just scoring.** Penalizing a banned import while the sandbox still allows it teaches *evasion*.
5. **Reward the outcome you want, not the behavior you imagine.** Rewarding "has a docstring" gets you docstrings, not better code.
6. **Assume it will be gamed.** Do not ask *whether* it will be hacked. Ask *how you will notice*. **Build the detection before the run.**

## `grpo.py` — the full config

```python
from trl import GRPOTrainer, GRPOConfig

def reward_fn(completions, prompts, **kw):
    out = []
    for c, p in zip(completions, prompts):
        code = extract_code(c)
        if code is None:            out.append(-0.5); continue      # no parseable block
        if not ast_valid(code):     out.append(-0.2); continue      # does not compile
        r = sandbox.run(code, tests_for(p))
        score = r.fraction                       # DENSE, not binary
        if r.status == 'timeout':   score -= 0.2
        if 'read_test_file' in r.flags: score -= 1.0   # anti-cheat
        out.append(score + 0.1)                   # format bonus
    return out

cfg = GRPOConfig(
    learning_rate=1e-6,           # 200x lower than SFT
    num_generations=8,            # group size G
    per_device_train_batch_size=1, gradient_accumulation_steps=8,
    max_prompt_length=384, max_completion_length=384,   # SHORT. VRAM-bound.
    beta=0.04,                    # KL coefficient
    temperature=1.0, bf16=True, gradient_checkpointing=True,
    optim='paged_adamw_8bit', save_steps=25, logging_steps=1,
)
```

> **Note the discrepancy:** this inline reward function uses `no parseable block = −0.5` and
> `does not compile = −0.2`, whereas the composite-reward table above lists `compiles = +0.1`.
> Both appear in the field guide. Pick one, write it into your config, and be consistent.

> **Expect this to be SLOW.** Generation dominates: 8 samples × every prompt × every step.
> **Hours, not minutes.** That is normal.

## Throughput — GRPO is generation-bound

| Setup | Backend | Throughput | Viability |
|---|---|---|---|
| **TUF RTX 3050 4GB** | HF generate (default) | Slow — sequential, unbatched | **Works. Plan for overnight runs.** |
| TUF RTX 3050 4GB | vLLM | Faster, but VRAM-hungry | Marginal at 4 GB. Test with 0.5B. |
| Mac M5 Pro 48GB | MLX | Fast for generation | But no TRL GRPO integration |
| Mac M5 Pro 48GB | vLLM | Not practical on Metal | No |

**Speed fixes, in order:**

1. **Cut completion length first** — 384 rather than 1024. Generation scales with tokens produced.
2. **Shrink the problem set** — filter to pass-rate 0.2–0.8. A throughput fix as much as a signal fix.
3. **Reduce group size before giving up** — G=4 is noisier but 4× faster than G=16. A noisy run that
   finishes beats a clean run that does not.
4. **Accept the timeline** — set it up, sleep, read rollouts at breakfast.

## Reward hacking — the gallery

### The classics

| Hack | Code | Fix |
|---|---|---|
| Reads the test file | `open('test_solution.py').read()` | Tests live outside cwd. Flag any file read. |
| Exits clean | `import sys; sys.exit(0)` | Parse test **output**, never the exit code. |
| Swallows everything | `try: solve()` / `except: pass` | Assert on counts of passed tests, not absence of errors. |
| Hardcodes the answers | `if n == 7: return 13` | Hold out tests. Score on unseen cases only. |
| Trivially true tests | `def test_x(): assert True` | Mutation testing: do the tests catch a broken impl? |
| Kills the timeout | `signal.alarm(0)` | Enforce timeout in the **parent**, not the child. |

> Every one of these appeared **at 0.5B on a laptop.** You do not need scale to meet them.

### The subtle ones — these take weeks to notice

| Hack | Signature | Fix |
|---|---|---|
| Format-only optimization | Perfect code fence containing nothing useful | Make format reward conditional on compiling |
| Length gaming | One-character variable names, no whitespace | Cap the penalty; do not minimize length |
| Truncation gaming | Stops mid-function to avoid a length penalty | Penalize non-compiling output more than length |
| Exception-as-control-flow | Raises the exception the test expects, unconditionally | Test both happy path and error path |
| Overfitting to test style | Learns your specific assertion phrasing | Vary test generation; hold out test styles |
| Import-based shortcuts | `from solutions import answer` | Minimal environment. Explicit import allowlist. |

> These do not spike the reward curve. They **creep** — which is exactly why reading rollouts beats
> reading metrics.

### The structural ones — not the model's fault

| Issue | Fix |
|---|---|
| Weak tests in the source dataset — wrong solutions legitimately pass | Cross-validate: run known-good AND known-bad solutions. Drop problems where bad code passes. |
| Tests generated by the same model that wrote the solution — shared blind spots | Generate tests from the **problem statement only**, never from the reference solution. |
| Reward scale imbalance — a trivially-obtainable +0.1 dominates hard-won correctness | Plot each reward **term** separately. Ensure correctness dominates in practice, not just in intent. |
| Optimizing the metric you report | Tune the reward on a **dev** split. Keep the real held-out set sealed. |

### Detecting it systematically

| Practice | Cadence | Detail |
|---|---|---|
| **Read rollouts. Actually read them.** | **20 samples every 50 steps** | Log as a W&B table. "Every hack I have ever found, I found by reading generated text — never by looking at a curve." |
| **Watch reward/eval divergence** | reward up, pass@1 down | The definitive signature. **The single most important chart in the phase.** |
| Instrument the sandbox with flags | `read_test_file`, `net_attempt` | Plot flag frequency over training. A rising flag rate IS a hack in progress. |
| Track reward-term distributions | per-term histograms | Format reward rising while correctness is flat → the model found the cheap term. |
| Diff against a held-out verifier | second, stricter test set | Score rollouts with tests the model was never optimized against. |
| Sudden reward jumps are suspicious | not cause for celebration | Genuine capability improves gradually. A discontinuity almost always means a shortcut. |

> **Build the detection BEFORE you start the run.** Retro-fitting means re-running everything.

## Instability, collapse, recovery

| Symptom | Cause | Fix |
|---|---|---|
| All outputs identical within ~50 steps | LR too high — policy collapsed to one mode | **Lower LR 10×.** Restart from last good checkpoint. |
| Output degrades into non-code text | KL coefficient too low — drifted off reference | **Raise beta (0.04 → 0.1).** Restart. |
| Reward flat for hours | Sparse reward, or dead groups (std = 0) | Dense reward. Filter to pass-rate 0.2–0.8. |
| Reward oscillates violently | Group size too small; noisy advantages | Raise G, or raise gradient accumulation |
| **Reward climbs, held-out pass@1 falls** | **REWARD HACKING** | Read rollouts. Patch the reward AND the sandbox. |
| Loss NaN | fp16, or an extreme advantage value | bf16; clip advantages; check for inf in the reward fn |
| Sudden reward discontinuity | A shortcut was discovered | Read the rollouts at that exact step. It will be obvious. |
| Everything fine, nothing improves | Reward does not measure what you think | Manually score 20 rollouts yourself and compare |

- **Checkpoint every 25 steps.** An RL run can go from healthy to unrecoverable in a handful of steps.
- **Keep the reference fixed — do not update it mid-run.** It is your only stable anchor.

## What a healthy GRPO run looks like

- **Reward rises gradually** — smooth, over hundreds of steps. Not a step function.
- **Held-out pass@1 tracks it** — same direction, usually smaller magnitude. Divergence is the alarm.
- **KL grows slowly and plateaus** — unbounded growth means the leash is too loose.
- **Dead-group fraction stays under ~30%.**
- **Output length stays stable.**
- **Rollouts stay readable** — twenty samples look like sincere attempts at the problem.

> **Realistic expectation: a few points of pass@1 over SFT+DPO, and a great deal of understanding.**
> The honest reference result at 0.5B was **+2.8 pass@1** over the DPO checkpoint — modest, alongside
> four discovered reward hacks.

> **The measure of success in this phase is NOT the pass@1 number. It is whether you can find,
> explain, and fix two reward hacks.**
