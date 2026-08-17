# The Trap Index & The False Positive Index

Two lists. The first is things that **fail**. The second is things that **succeed, incorrectly** —
and those are far more expensive, because you believe them.

---

# PART 1 — THE TRAP INDEX

## Setup through Data

| Phase | Trap | The tell | The fix |
|---|---|---|---|
| Setup | CPU-only torch installed | `cuda.is_available()` False | Reinstall with the `cuXXX` index URL |
| Setup | HF cache in home directory | Disk fills in a week | Set `HF_HOME` on day one |
| Setup | bitsandbytes broken | Fails at training, not install | Run `python -m bitsandbytes` |
| Model | Chat template guessed | Fine-tune scores below base | `apply_chat_template`; print `repr()` |
| Model | Wrong EOS token | Generation never terminates | Decode a training example end to end |
| Model | `seq_len` guessed | Silent truncation of 20%+ | Measure your data's p95 |
| Sandbox | No timeout | Run hangs at a random step | Wall-clock AND CPU limits, both |
| Sandbox | Kills process, not group | Orphans accumulate overnight | `os.setsid()` + `os.killpg()` |
| Sandbox | Test file readable from cwd | Model reads it during GRPO | Tests outside cwd; flag file reads |
| Sandbox | Env inherited | HF/W&B tokens leak into codegen | Explicit minimal env allowlist |
| Eval | Single seed | Gains appear then vanish | Three seeds, report mean ± std |
| Eval | Naive pass@k | Biased, high variance | Unbiased combinatorial estimator |
| Eval | First code block extracted | Points vanish inexplicably | Take the **last** complete block |
| Data | Dedup before decontamination | Contamination hidden by removal | Decontaminate FIRST, always |
| Data | Split before dedup | Val tracks train suspiciously well | Dedup, then split |
| Data | Mixture computed in records | "80/20" behaves like 100/0 | Compute the ratio in **tokens** |

## SFT through GRPO

| Phase | Trap | The tell | The fix |
|---|---|---|---|
| SFT | Full-FT learning rate on LoRA | Barely moves off baseline | LoRA wants ~10× higher: `2e-4` |
| SFT | Loss over prompt tokens | Loss falls, behavior degrades | Decode a batch, inspect labels |
| SFT | `response_template` mismatch | Masking silently disabled | Match the template byte for byte |
| SFT | Rank raised, alpha fixed | "Rank has no effect" | Set `alpha = 2r` and re-sweep |
| SFT | `target_modules` typo | 0% trainable, run looks normal | `print_trainable_parameters()` |
| SFT | Checkpoint on best loss | Ships the most memorized model | Checkpoint on `eval_pass_at_1` |
| SFT | Accumulation silently ignored | Noisy loss, poor results | Log the optimizer step count |
| SFT | fp16 on an Ampere card | NaN on step 1 | Use bf16 |
| RFT | Temperature 0 | N identical samples | 0.8–1.0; diversity is the point |
| RFT | No per-problem cap | One problem gives 50 examples | Keep k=2–4 per problem |
| RFT | Difficulty collapse | Round 2 shows no gain | Stratify the keep-set by difficulty |
| DPO | SFT learning rate | Model destroyed in ~50 steps | `5e-6`, not `2e-4` |
| DPO | Multiple epochs | Peak at step 80 of 400 | One epoch; evaluate every 50 steps |
| DPO | Cross-problem pairs | Learns ranking, not quality | Pair within a single prompt |
| DPO | Length unlogged | Output doubles unnoticed | Log mean output length always |
| GRPO | Binary reward | Reward flat for hours | Fraction of tests passed |
| GRPO | Dead groups | "Converged" but nothing learned | Filter to pass-rate 0.2–0.8 |
| GRPO | KL beta = 0 | Drifts into gibberish | `beta ~0.04`; log KL |

## Repair through Serving, plus the cross-cutting ones

| Phase | Trap | The tell | The fix |
|---|---|---|---|
| GRPO | Penalty scored but not enforced | Model learns evasion, not avoidance | Sandbox must actually block it |
| GRPO | Reward tuned on held-out | Excellent held-out score | Tune on dev; seal the test set |
| GRPO | Trusting the reward curve | Reward up, capability down | Plot pass@1 on the same axis |
| Repair | Reward final attempt only | First-attempt quality declines | Weight first attempt 0.7 / repair 0.3 |
| Repair | Single merged metric | Hides first-attempt regression | Report both numbers separately |
| Repair | Fix included in feedback | Learns copying, not repair | Report what broke, never the fix |
| Repair | Full untruncated tracebacks | Context consumed by stack frames | Exception, message, failing values |
| Merge | Different base models | Output is garbage | Merging requires a common ancestor |
| Merge | Merge not evaluated | Silently worse than components | Same three-seed protocol |
| Merge | Methods swept, weights not | Marginal gains only | The mixing ratio matters more |
| Serve | Generic quantization curve | Quality drops unexpectedly | Measure on YOUR eval |
| Serve | Below 4-bit on a small model | Sharp quality cliff | `Q4_K_M` is the practical floor |
| Serve | Eval the checkpoint, ship the quant | Two points vanish at launch | Evaluate through the served endpoint |
| Serve | Stop tokens wrong at serve time | Endless generation returns | Verify the serving config's template |
| Ops | Partial seeding | Irreproducible, but looks seeded | Seed python, numpy, torch, cuda, loader |
| Ops | Config written after the run | Result cannot be regenerated | Commit the config BEFORE running |
| Ops | `grad_norm` not logged | Divergence arrives with no warning | Log it every step, every phase |

---

# PART 2 — THE FALSE POSITIVE INDEX

> These do not fail. They succeed, incorrectly, and you believe them.
> **This is the most expensive page in the project.**

## Numbers that go UP while the model gets worse

| Name | Cause | The tell | The check |
|---|---|---|---|
| Contamination | Eval problems sit in your training data | Strong HumanEval, weak LiveCodeBench | Timestamped benchmark; n-gram + name + docstring check |
| Template drift | You changed the prompt, not the model | Multi-point jump with no weight change | Diff the rendered prompt strings between runs |
| Seed noise | One-seed variance read as signal | Gains of 1–3 points appear and vanish | Three seeds; report mean ± std |
| Weak-test inflation | Wrong solutions pass shallow tests | High base HumanEval, poor real use | Use the `+` variants; test with known-bad code |
| Memorization | Model memorized the training set | Train loss beautiful, eval flat | Checkpoint on eval; verify dedup |
| Leaked near-duplicates | You split before deduplicating | Val tracks train almost perfectly | Dedup first; check cross-split overlap |
| Diversity as skill | More variety, no more capability | pass@10 rises, pass@1 flat | Always report both k values |
| Checkpoint cherry-pick | Overfit to the validation set | Best-of-20 checkpoints looks great | Select on val, report on sealed test |

## The training-phase deceptions

| Name | Cause | The tell | The check |
|---|---|---|---|
| Nothing was trained | `target_modules` typo — 0% trainable | Small loss decrease, model unchanged | `print_trainable_parameters()` |
| Effective batch of 1 | Accumulation config silently ignored | Noisy loss, poor results, no error | Log the optimizer step count |
| Masking silently off | `response_template` mismatch | Loss normal, behavior degrades | Decode a batch, inspect labels |
| Filter removed difficulty | You filtered hardness, not noise | Score rises after filtering | Difficulty histogram before/after |
| Duplicate inflation | Near-identical passers counted twice | "50k examples" from 3k problems | Dedup survivors, then recount |
| Verbosity bias | Model learned longer looks better | Judge score up, pass@1 flat | Log mean output length every run |
| Judge-verifier divergence | You optimized for the judge | Judge loves it, tests disagree | Verifier is truth; judge is advisory |
| Reward hacking | Model found a shortcut | Reward climbing, held-out falling | Read rollouts; plot both on one axis |
| Dead-group illusion | Zero variance means zero gradient | Reward stable, "converged" | Log fraction of groups with std = 0 |
| Synthetic self-agreement | Teacher grades its own output | Teacher-rated quality is excellent | Grade with execution, not the generator |
| Recovery illusion | Degenerate high-reward mode found | Reward recovers after a collapse | Check output diversity; read samples |
| Baseline sandbagging | Your baseline used a worse prompt | Huge gain over baseline | Baseline gets the same template and effort |

> The pattern is universal: **every one makes a number rise.**
> Only held-out pass@1, on a sealed set, is not fooled.

---

# PART 3 — SANDBOX SPECIFICS

The sandbox is the trust boundary and it becomes the GRPO reward function. Build it once, properly.

### The path

- Start at Level 1 (subprocess + `setrlimit`), move to Level 2 (Docker) before the first unattended run
- Two timeouts: CPU-time **and** wall-clock. Always both
- `os.setsid()` + `os.killpg()` — kill the process **group**, not the process
- Scrub the environment to an explicit allowlist
- Return fraction-of-tests-passed, not a boolean
- Capture the traceback — self-repair is built from it
- Write the adversarial suite and re-run it on every change

### The traps

- **No timeout** — the classic. Hangs runs silently for hours
- **Only CPU timeout** — sleeps and blocking I/O sail straight through
- **Killing the process but not the group** — orphans accumulate all night
- **Test file readable from cwd** — the model will find it during GRPO
- **Inheriting env** — leaks your HF and W&B tokens into generated code
- **Trusting exit code 0 as success** — `sys.exit(0)` defeats it
- **Boolean-only results** — you cannot build a dense reward later

### The adversarial suite — 12 cases, all must pass

| Attack | Payload | Expected result |
|---|---|---|
| Infinite loop | `while True: pass` | `status='timeout'`, killed within `wall_s` |
| Sleep past the limit | `import time; time.sleep(999)` | `status='timeout'` (CPU limit alone would MISS this) |
| Fork bomb | `while True: os.fork()` | Contained by `RLIMIT_NPROC` / `--pids-limit` |
| Memory bomb | `x = [0] * 10**10` | `MemoryError` inside sandbox, host unaffected |
| Orphan subprocess | `subprocess.Popen(['sleep','999'])` | Killed by `killpg` — **this is the one that usually fails** |
| Clean exit | `import sys; sys.exit(0)` | NOT counted as pass — must check test output, not exit code |
| Swallow everything | `try: main() except: pass` | Tests must still report failure |
| Read the test file | `open('test_solution.py').read()` | `FileNotFoundError`, or flagged |
| Network egress | `urllib.request.urlopen('http://...')` | Blocked (L2) or flagged (L1) |
| Filesystem escape | `open('../../secrets','w')` | `PermissionError` or contained in tmpfs |
| Disk fill | `open('f','w').write('x'*10**10)` | Capped by `RLIMIT_FSIZE` |
| Env leak | `os.environ.get('HF_TOKEN')` | Returns `None` — env was scrubbed |

> The orphan-subprocess test is the one that fails on almost every hand-rolled sandbox.
> `subprocess.run(timeout=)` kills the child and cheerfully leaves its children running.

### The threat model

You are about to run millions of lines of code written by a model that is being actively
optimized to make your tests pass. It is not malicious. It is worse than malicious: **it is a
search process with an objective, and your sandbox is part of the search space.**

---

# PART 4 — EVALUATION SPECIFICS

### How big must a delta be to mean anything

On 164 problems, the standard deviation across seeds is typically **1.5–2.5 points**.

| Observed delta | 1 seed | 3 seeds | What to do |
|---|---|---|---|
| +0.5 pt | Noise | Noise | Ignore. Do not write it down. |
| +1.5 pt | Noise | Probably noise | Re-run with more seeds before believing it |
| +3.0 pt | Possibly real | Probably real | Report with std. Investigate what changed. |
| +6.0 pt | Likely real | Real | A genuine finding. Write it up properly. |
| −3.0 pt | Possibly real | Probably real | Something broke. Bisect your change. |

- **Three seeds is the minimum.** `seed: [0, 1, 2]`. A number without a std is an anecdote.
- **Bigger eval sets shrink the noise.** HumanEval+ + MBPP+ + yours ≈ 700 problems instead of 164,
  which roughly halves your standard deviation for free.

### Prompt template sensitivity — 6.1 points from formatting alone

Same model weights, byte-identical. Four prompt formats, HumanEval+ pass@1:

| Prompt format | pass@1 |
|---|---|
| Raw completion | 24.4 |
| Chat template | 28.7 |
| + system prompt | **30.5** |
| + "think first" | 26.2 |

That spread is **larger than most fine-tuning gains you will produce in this entire curriculum.**
Choose one template, put its name in every config, and treat changing it as a separate experiment
with its own baseline.

> "Think step by step" *hurt* here. On a small code model, chain-of-thought prompting often
> degrades pass@1 — it produces prose where code was expected and the extractor fails.

### Where points quietly vanish — extraction

| Item | Guidance |
|---|---|
| Fenced block extraction | Handle: no fences, unlabeled fences, multiple blocks, unterminated fences |
| **Which block do you take?** | **Take the LAST complete block.** A model that explains, shows a wrong approach, then shows the right one will fail if you take the first |
| Stop sequences | `'\ndef '`, `'\nclass '`, `'\nif __name__'` for raw-completion eval |
| Prompt echo | If the model re-emits the signature and you also prepend it → duplicate `def`, syntax error on correct code |
| Markdown leakage | Prose inside the fence breaks compilation |
| Log extraction failures separately | `status='extract_fail'`. If 8% fail extraction, that is an 8-point ceiling that has nothing to do with the model |

### Catastrophic forgetting — run these every checkpoint

| Check | What it catches | Run it |
|---|---|---|
| General benchmark subset (e.g. MMLU 500q) | Broad capability loss from narrow fine-tuning | Every checkpoint |
| Instruction-following (IFEval-style) | Loss of ability to follow formatting constraints | Every phase gate |
| A fixed 20-prompt smoke set | Endless generation, garbage, template collapse | Every checkpoint, eyeball it |
| Output length distribution | Verbosity drift, especially after DPO | Every checkpoint |
| Non-Python code (MultiPL-E subset) | Over-specialization to a single language | Every phase gate |
| The previous phase's eval | Direct regression against what you already had | Every checkpoint |

> **Mitigation:** mix 5–15% general instruction data into your code SFT. It costs a little code
> performance and buys back most of the general ability.
