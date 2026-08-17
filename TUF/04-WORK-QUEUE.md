# Work Queue — what the TUF actually does, in order

The pipeline order is fixed. **Do not reorder it.**

```
sandbox → eval harness → baseline → data curation → SFT → RFT → DPO → GRPO → self-repair → merge → serve
```

Each phase has a **gate**. You do not start the next phase until the gate passes. A phase that
"mostly works" is a phase that will silently corrupt every number after it.

---

## Before anything trains — the first six things

From the field guide, in this exact order. Nothing on this list trains a model. **That is the point.**

| # | Do | Why | Where |
|---|---|---|---|
| 1 | Create the repo and directory structure | Twenty minutes. `data/ src/ configs/ results/ checkpoints/`. Commit the empty structure so the shape exists before the content. | Either |
| 2 | Set `HF_HOME` before you download anything | One line in your shell profile. The single cheapest mistake to avoid, and unfixable in hindsight without re-downloading everything. | **TUF** |
| 3 | Get both environments to pass smoke tests | `torch.cuda.is_available()` on the TUF, MLX generating on the Mac. Do not proceed until both are green. | Both |
| 4 | Write `executor.py` + its adversarial suite | Before any model code. This is the trust boundary and it becomes your reward function. The most reused file in the project. | Mac (write) · TUF (bulk) |
| 5 | Write `harness.py`, produce `results/00-baseline.md` | One command, one number, three seeds. Everything after this is "better than that". | Mac |
| 6 | Only then download a training dataset | The temptation is to start with the model. Resist it. Everything you build before the model is what makes the model work. | Mac |

> The TUF's job in items 1–6 is **step 2 and the CUDA half of step 3**. Everything else is Mac work
> or machine-agnostic. Do not start training just because the GPU is idle.

---

## The twelve-week schedule

Assumes evenings and weekends, not full time. Compress freely if you have more hours.

| Week | Phase | Deliverable | Gate | Machine |
|---|---|---|---|---|
| 1 | Setup + Model | Both environments working; base model loads and generates | All smoke tests pass | Both |
| 2 | Sandbox | `executor.py` + adversarial suite | Survives all 12 adversarial tests | Mac writes · **TUF runs bulk** |
| 3 | Eval | `harness.py` + baseline table | Reproducible pass@1 ± std, 3 seeds | Mac |
| 4–5 | Data | Curated, deduped, decontaminated v1 | Curated-10k beats raw-100k | Mac |
| 6 | SFT | First fine-tuned adapter | Beats baseline across 3 seeds | **TUF** |
| 7 | SFT ablations | Rank, LR, epochs, mixture swept | You can explain each result | **TUF** |
| 8 | RFT | Rejection-sampled dataset + model | Beats SFT; difficulty distribution healthy | Mac generates · **TUF executes + trains** |
| 9 | DPO | Preference-optimized model | Beats RFT; output length tracked | **TUF** |
| 10–11 | GRPO | RLVR model + reward-hack log | Two documented hacks with fixes | **TUF** |
| 12 | Repair + Merge + Serve | Quantized on-device model | Runs in your editor; sealed test opened once | TUF trains · Mac merges/quantizes |

> **If a week slips, cut ablations — never cut the eval harness or the data phase.**
> Those two carry everything else.

---

## Compute budget — what each run actually costs

| Phase | Where | Wall clock | Notes |
|---|---|---|---|
| Sandbox + eval harness | Mac (write) · TUF (bulk) | 3–5 days | Mostly your time, not compute. Identical POSIX code on both. |
| Data curation | Mac | 1–2 weeks | CPU/RAM bound. 48 GB is the enabler. |
| **SFT run (0.5B, 10k examples)** | **TUF** | **20–40 min** | Run many. This is your iteration loop. |
| **SFT run (1.5B, 10k examples)** | **TUF** | **2–3 hours** | Overnight-adjacent. Use sparingly. |
| Rejection sampling generation | Mac | 6–12 hrs | Overnight. The teacher is the bottleneck. |
| **Rejection sampling execution** | **TUF** | **1–3 hrs** | Docker is cheap on Linux; 8 cores in parallel. |
| **DPO run** | **TUF** | **30–60 min** | Cheap. Iterate freely. |
| **GRPO run** | **TUF** | **8–24 hrs** | Generation and reward execution on one machine. |
| Merging | Mac | seconds–minutes | Effectively free. Sweep widely. |
| Quantization + serving | Both | 1–2 hours | Mostly conversion and verification. |

**The daily rhythm.** Kick off generation before bed. Curate over coffee. Train before lunch.
Evaluate after. Read rollouts in the evening.

**Two machines means parallelism.** The Mac generates while the TUF trains and executes.
Never leave one idle waiting on the other.

**One OS family, one codebase.** Both machines are POSIX, so the sandbox and harness run
unmodified on either. No branch, no WSL, no second code path.

---

## Experiment discipline — non-negotiable on every run

1. **One variable per experiment.** If you change the learning rate AND the dataset, you have
   learned nothing about either. Tedious, and the entire scientific content of the work.
2. **Every run has a committed config** — committed *before* the run, not reconstructed after.
   A config written after the fact is a memory, not a record.
3. **Every result names its config and data version.** `results/07-rft.md` says which config file
   and which data version produced each number. Without that link, the number is folklore.
4. **Three seeds, always, before you believe anything.** Most "improvements" evaporate at the
   second seed.
5. **Write down what failed.** A results file with only successes is a marketing document.
6. **Log rollouts, not just metrics.** Every phase from RFT onward: sample outputs to a table.
   Metrics tell you *that* something changed; samples tell you *what* changed.

### The reproducibility checklist

**Seed everything** — partial seeding is worse than none, because it *looks* reproducible.

```python
random.seed(s)
numpy.random.seed(s)
torch.manual_seed(s)
torch.cuda.manual_seed_all(s)
# DataLoader worker_init_fn and generator
transformers.set_seed(s)   # covers most of the above
```

**Record everything**

- Git SHA of the training code
- Data version tag (`v3-curated-10k`)
- Chat template name and version
- Full config file as a W&B artifact
- Library versions (`pip freeze`)
- GPU model and driver version
- The exact eval harness commit

> **The test:** can you regenerate any number in `results/` six weeks from now, from the repo
> alone? If not, it is not a result.

---

## What to log to W&B

**Always, every phase**

- `train/loss` and `eval/loss` per step
- learning rate — verify your schedule is real
- `grad_norm` — spikes precede divergence
- GPU memory allocated and reserved
- tokens/sec — your throughput baseline
- The full config as a run artifact
- Git SHA of the code that ran
- Data version tag

**Phase-specific, easy to forget**

- SFT: mean completion length
- DPO: implicit reward margin, chosen/rejected logps
- DPO: output length before and after (verbosity)
- GRPO: mean reward, reward std within group
- GRPO: KL from the reference model
- GRPO: a sample of raw rollouts as a text table
- All: held-out pass@1 at every checkpoint
- All: a general benchmark, to catch forgetting

> If a number is not logged, it did not happen. If a rollout is not sampled to the dashboard,
> you will never read it.

---

## Diversions — what looks essential and is not

Do not spend TUF time on any of these.

| Diversion | Why not |
|---|---|
| Chasing benchmark SOTA | You are learning a craft, not competing. A model that taught you five failure modes beat one that scored two points higher and taught you nothing. |
| Full fine-tuning | LoRA teaches identical concepts at 1/20th the memory. Full FT is a resource decision, not a knowledge one. |
| Implementing PPO from scratch | Superseded by DPO and GRPO for practitioners. Read the paper; do not spend a month on the implementation. |
| Writing your own trainer | TRL covers every method in the guide. Time on training infrastructure is time not spent on data and rewards. |
| Reading papers instead of running experiments | The failure modes are not in the papers. They are in your rollout logs. |
| Scaling up too early | Every problem you have at 7B, you also had at 0.5B — where it cost nothing to find. |
| Hyperparameter sweeps on dirty data | You will find the settings that best memorize noise. Fix the data first; the answers change. |
| Building a custom eval framework | Wrap evalplus. Your custom set matters; your custom framework does not. |
| Perfect data filtering | Ship at 90% clean. The last 10% costs more than the phase after it is worth. |
| Long-context / repo-level work | A genuinely different discipline. Out of scope until everything else works. |
| Multi-GPU and distributed training | You have one GPU. The concepts transfer; the plumbing does not. |
| Waiting until you "understand the math" | You will understand DPO's derivation faster after running it than before. |

---

## The nine laws

1. **Build the ruler first.** Sandbox and eval before any gradient step. You cannot improve what
   you cannot measure, and you cannot measure with an instrument you have not tested.
2. **Data beats hyperparameters.** Every time, by a wide margin. If you are tuning learning rates
   before you have deduplicated, you are optimizing the wrong variable.
3. **The metric is not the goal.** Loss proxies capability. Reward proxies capability. Both diverge
   from it under optimization pressure — and optimization pressure is exactly what you are applying.
4. **Read your samples.** Every failure mode is invisible in aggregate metrics and obvious in twenty
   rollouts. Make samples easy to look at, then look at them.
5. **Small and fast wins.** Experiments per week determines how fast you learn. Optimize for loop
   speed over model size until the loop is boring.
6. **Verifiable rewards changed everything.** Wherever an answer can be checked mechanically, you
   can train on it. Finding that verifier is the real design work in any new domain.
7. **Every reward term is an attack surface.** The model will find what you actually rewarded, not
   what you meant. Assume it, and build the detection before the run.
8. **Three seeds or it did not happen.** Most reported improvements are noise.
9. **Order is not negotiable.** Decontaminate before dedup. Dedup before split. Eval before train.
   Data before hyperparameters. Getting the order wrong invalidates results silently.

---

## Further reading, ranked

| Priority | What | Why |
|---|---|---|
| Read first | TRL docs — SFTTrainer, DPOTrainer, GRPOTrainer | You will use these daily. Better than most tutorials. |
| Read first | QLoRA paper (Dettmers et al.) | NF4, double quantization, paged optimizers. Directly explains why your 4 GB card works. |
| Read first | Unsloth docs and notebooks | Practical, current, tuned for exactly your constraints. |
| Read early | DPO paper (Rafailov et al.) | The derivation is worth understanding once. Read it *after* running DPO, not before. |
| Read early | DeepSeekMath (GRPO) and DeepSeek-R1 | GRPO's origin and the clearest demonstration of RLVR at scale. |
| Read early | EvalPlus paper | Why weak tests inflate scores. Changes how you think about verification. |
| When relevant | LoRA paper (Hu et al.) | The original. Short, readable, intuition still holds. |
| When relevant | Magicoder / OSS-Instruct | The synthetic data recipe you will actually use. |
| When relevant | TIES / DARE merging papers | Short. Read them the day you start merging. |
| When relevant | STaR (self-taught reasoner) | The formal framing of the RFT loop. |
| Skip for now | PPO / InstructGPT | Historically essential, practically superseded. Understand the shape, skip the implementation. |
| Skip for now | Anything about training at scale | Different discipline. Nothing transfers to a single 4 GB card. |

> Papers read before you have the corresponding problem are entertainment; the same paper read
> the day you hit the problem is a solution.
