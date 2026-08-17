# ULTRON Field Guide — Content Manifest

The authoritative topic list. **Nothing gets built that isn't here; nothing here goes unbuilt.**
Each section maps to one module in `sections/`. Check off as slides are built.

Status: `[ ]` planned · `[x]` built · `[~]` partial

**Status: BUILT — 190 slides.** Every topic below is in the deck.
Regenerate with `node build.js`; build one section with `node build.js 06`.

---

## PART I — ORIENTATION  → `sections/01-orientation.js`
- [x] Title
- [x] How to read this guide (Path / Traps / Field Note legend)
- [x] The full LLM lifecycle: pretraining → midtraining → post-training → serving
- [x] Where post-training sits, and what each stage buys you
- [x] The 80/20 truth: data + eval dominate
- [x] Vocabulary: 20 terms you need before slide 20
- [x] Your two machines, and their distinct jobs
- [x] The distillation rig (Mac teacher → Asus student)
- [x] Why 0.5B is the right size to learn on
- [x] The complete curriculum at a glance
- [x] Prerequisites checklist
- [x] Repo structure
- [x] Config-driven experiments: why the config dir IS the lab notebook

## PART II — ENVIRONMENT  → `sections/02-environment.js`
- [x] Dependency matrix: what runs on CUDA vs Metal vs CPU
- [x] Setup: the Asus (Ubuntu 26.04 + CUDA) — driver, torch, bitsandbytes, Unsloth, TRL
- [x] Freeing the card: the Linux VRAM win (hybrid mode, TTY, no compositor tax)
- [x] Setup: the Mac (Metal) — MLX, llama.cpp, datasets, evalplus
- [x] Verifying the install (the smoke tests that catch 90% of setup bugs)
- [x] Experiment tracking: W&B setup and what to log
- [x] Disk strategy across three volumes (Mac 3TB · Asus 512GB root + 1TB /data)
- [x] Common setup failures and their fixes (Secure Boot/MOK, fstab, drivers)

## PART III — THE MODEL LANDSCAPE  → `sections/03-models.js`
- [x] Open-weight code model families (Qwen, DeepSeek, StarCoder, CodeLlama, Granite)
- [x] Qwen2.5-Coder family deep dive — why it's the default choice
- [x] Base vs Instruct: which to start from and why it matters
- [x] Licensing: what you can legally train on and ship
- [x] Tokenizers: why code tokenization differs from prose
- [x] Fill-in-the-middle (FIM) format
- [x] Chat templates — the format that bites everyone
- [x] Special tokens, EOS handling, and the silent generation bug
- [x] Context length, RoPE, and position extrapolation
- [x] Model selection traps

## PART IV — THE SANDBOX  → `sections/04-sandbox.js`
- [x] Threat model: what "untrusted output" actually means
- [x] The escalation ladder (subprocess → rlimit → Docker → gVisor → hosted)
- [x] Level 1: subprocess + resource.setrlimit (annotated)
- [x] Timeouts: wall-clock vs CPU-time, and why you need both
- [x] Memory limits and the OOM-killer interaction
- [x] Network isolation
- [x] Filesystem isolation and temp-dir discipline
- [x] Level 2: Docker — config and the Mac VM overhead
- [x] Level 3: hosted (E2B, Modal) — when it's worth it
- [x] The structured result schema (and why traceback capture matters for Phase 6)
- [x] Parallel execution and throughput tuning
- [x] The adversarial test suite for your own sandbox
- [x] Sandbox traps and false positives

## PART V — EVALUATION  → `sections/05-evaluation.js`
- [x] Why the ruler comes before the gradient
- [x] pass@k: the unbiased estimator, derived
- [x] Why naive pass@k overestimates
- [x] HumanEval and its known flaws
- [x] HumanEval+ / MBPP+ — what EvalPlus actually adds
- [x] MBPP: format and quirks
- [x] LiveCodeBench — contamination resistance by timestamp
- [x] BigCodeBench, MultiPL-E, CodeContests, APPS, TACO
- [x] SWE-bench — what it measures and why it's deferred
- [x] Building your own domain eval set
- [x] Held-out discipline: the set you never open
- [x] Seeds, variance, and how big a delta must be to mean anything
- [x] Confidence intervals for pass@k
- [x] Prompt template sensitivity (worked example)
- [x] Stop tokens and the extraction regex
- [x] Greedy vs sampled evaluation
- [x] Harnesses: lm-eval, bigcode-eval, or roll your own
- [x] LLM-as-judge for code: when it helps, when it lies
- [x] Regression suites and catastrophic-forgetting checks
- [x] Tracking eval across the whole project
- [x] Evaluation traps
- [x] Evaluation false positives (dedicated slide)

## PART VI — DATA  → `sections/06-data.js`
- [x] The pipeline, end to end
- [x] Source: The Stack v2 (raw code)
- [x] Source: instruction datasets (Magicoder, Evol-Instruct, Glaive, OpenCoder)
- [x] Source: CommitPack / CommitPackFT
- [x] Source: problems with tests (CodeContests, APPS, TACO)
- [x] Licensing and provenance hygiene
- [x] Storage layout for 3TB
- [x] Schema design for training records
- [x] Chat-templating your data correctly
- [x] Loss masking — deep dive with a worked example
- [x] Decontamination: the n-gram method
- [x] Decontamination: code-specific signals (function names, docstrings, AST shape)
- [x] Dedup 1: exact hashing
- [x] Dedup 2: MinHash + LSH, how it actually works
- [x] Dedup 3: semantic/embedding dedup
- [x] Quality filter: heuristics
- [x] Quality filter: ast.parse validity (code-specific)
- [x] Quality filter: classifier-based scoring
- [x] Quality filter: LLM-as-judge scoring
- [x] Difficulty estimation and stratification
- [x] Data mixing ratios (domain vs general)
- [x] Curriculum ordering: does it matter?
- [x] Synthetic: Self-Instruct
- [x] Synthetic: Evol-Instruct (depth and breadth evolution)
- [x] Synthetic: OSS-Instruct (grounded in real code)
- [x] Synthetic: back-translation (code → problem)
- [x] Synthetic: verified generation on your own rig
- [x] Data versioning and lineage
- [x] The curation ablation (the experiment that recalibrates you)
- [x] Data traps
- [x] Data false positives

## PART VII — SFT  → `sections/07-sft.js`
- [x] What SFT actually changes in the model
- [x] Full fine-tuning vs PEFT: the real tradeoff
- [x] LoRA: the low-rank decomposition, explained
- [x] LoRA hyperparameter — rank
- [x] LoRA hyperparameter — alpha and the scaling factor
- [x] LoRA hyperparameter — target modules
- [x] LoRA hyperparameter — dropout
- [x] QLoRA: NF4, double quantization, paged optimizers
- [x] DoRA, rsLoRA, and whether they're worth it
- [x] The memory math table (your 4GB budget, line by line)
- [x] Learning rate and schedule
- [x] Batch size, gradient accumulation, effective batch
- [x] Sequence length, packing, and truncation
- [x] Epochs and early stopping
- [x] Precision: bf16 vs fp16 vs fp32 master weights
- [x] Gradient checkpointing: the compute/memory trade
- [x] Optimizers: AdamW, 8-bit Adam, Lion
- [x] Unsloth: what it actually does to get 2×
- [x] TRL SFTTrainer: annotated config
- [x] Axolotl / LLaMA-Factory: config-driven alternative
- [x] MLX on the Mac: the parallel path
- [x] Catastrophic forgetting: measuring and mitigating
- [x] Checkpoint selection strategy
- [x] Reading the training curves
- [x] SFT traps
- [x] SFT false positives

## PART VIII — REJECTION SAMPLING / RFT  → `sections/08-rft.js`
- [x] The idea: self-improvement without RL
- [x] The loop in detail
- [x] Choosing N
- [x] Temperature for diversity
- [x] Filtering strategy: all-passers vs best-1
- [x] Deduplicating survivors
- [x] Difficulty collapse and stratified keeping
- [x] Iterated RFT (STaR-style bootstrapping)
- [x] Teacher–student distillation on your two machines
- [x] RFT traps and false positives

## PART IX — PREFERENCE OPTIMIZATION  → `sections/09-preference.js`
- [x] Why preference learning exists at all
- [x] Reward modeling: Bradley-Terry, explained
- [x] RLHF / PPO: the classical pipeline (read, don't build)
- [x] DPO: the key insight
- [x] DPO: beta and the reference model
- [x] DPO: constructing pairs for code
- [x] KTO: learning from binary signals
- [x] ORPO: folding SFT and preference together
- [x] IPO, SimPO, CPO — what each fixes
- [x] Choosing among them: a decision table
- [x] Verbosity bias and length normalization
- [x] On-policy vs off-policy preference data
- [x] Preference traps
- [x] Preference false positives

## PART X — RLVR / GRPO  → `sections/10-rlvr.js`
- [x] Why verifiable rewards changed the field
- [x] Policy gradient, intuitively
- [x] PPO vs GRPO: what GRPO drops and why
- [x] GRPO: group-relative advantage, explained
- [x] GRPO hyperparameters: group size, LR, clip
- [x] The KL penalty and reference-model anchoring
- [x] Reward function design: first principles
- [x] Composite rewards for code (annotated)
- [x] Dense vs sparse reward, and partial credit
- [x] Format rewards
- [x] Penalty terms and the anti-cheat budget
- [x] Process rewards vs outcome rewards
- [x] THE REWARD-HACKING GALLERY (multi-slide)
- [x] Detecting reward hacking systematically
- [x] Hardening the sandbox against your own model
- [x] Rollout logging and the habit of reading samples
- [x] Running GRPO on 4GB: the practical config
- [x] vLLM for rollouts (and the Metal limitation)
- [x] Training instability, collapse, and recovery
- [x] GRPO traps
- [x] GRPO false positives

## PART XI — SELF-REPAIR  → `sections/11-repair.js`
- [x] The repair loop
- [x] Building repair datasets from your own failures
- [x] Multi-turn conversation formatting
- [x] Rewarding repair without rewarding sloppy first drafts
- [x] Reflexion and related approaches
- [x] Measuring first-attempt vs after-repair separately
- [x] Repair traps

## PART XII — MODEL SURGERY  → `sections/12-merging.js`
- [x] Why merging works at all
- [x] Linear merging / task arithmetic
- [x] SLERP
- [x] TIES
- [x] DARE
- [x] Model soups
- [x] mergekit in practice
- [x] When merging helps and when it destroys
- [x] Merging traps

## PART XIII — QUANTIZATION & SERVING  → `sections/13-serving.js`
- [x] Quantization: what actually gets quantized
- [x] GPTQ, AWQ, bitsandbytes, GGUF, MLX — a comparison
- [x] Measuring the quality/speed curve on YOUR eval
- [x] llama.cpp + GGUF on both machines
- [x] MLX serving on the Mac
- [x] vLLM and multi-LoRA serving
- [x] Constrained/structured decoding
- [x] Speculative decoding
- [x] Wiring the model into an editor
- [x] Serving traps

## PART XIV — OPERATIONS  → `sections/14-operations.js`
- [x] Experiment discipline: one variable, one config, one result file
- [x] The reproducibility checklist
- [x] Compute budgeting on free hardware
- [x] When renting finally makes sense, and what to rent
- [x] Debugging: OOM
- [x] Debugging: NaN and loss spikes
- [x] Debugging: training is mysteriously slow
- [x] Debugging: model outputs garbage
- [x] Debugging: eval score won't move
- [x] Reading training curves like an engineer

## PART XV — SYNTHESIS  → `sections/15-synthesis.js`
- [x] The Diversions Index — what looks essential and isn't
- [x] THE TRAP INDEX (multi-slide, by phase)
- [x] THE FALSE POSITIVE INDEX (dedicated, multi-slide)
- [x] General laws that transfer to any domain
- [x] A 12-week schedule
- [x] What to do first tomorrow
- [x] Further reading, ranked
- [x] Closing
