/* PART XIV — OPERATIONS  (cross-cutting) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("SERVE", "Cross-cutting", "Operations and Debugging",
    "Not a phase — a discipline you need from day one. Placed here because it is\nthe reference you will come back to, not because it comes last."));

  /* ---- Experiment discipline ---- */
  {
    const s = T.slide("Ops", "Experiment discipline — the habits that compound");
    T.steps(s, 1.4, [
      ["One variable per experiment", "If you change the learning rate AND the dataset, you have learned nothing about either. This is tedious and it is the entire scientific content of the work."],
      ["Every run has a committed config", "Committed BEFORE the run, not reconstructed after. A config written after the fact is a memory, not a record."],
      ["Every result names its config and data version", "results/07-rft.md says which config file and which data version produced each number. Without that link, the number is folklore."],
      ["Three seeds, always, before you believe anything", "The single habit that most reduces wasted work. Most 'improvements' evaporate at the second seed."],
      ["Write down what failed", "A results file with only successes is a marketing document. The failures are where the transferable knowledge lives."],
      ["Log rollouts, not just metrics", "Every phase from 7 onward: sample outputs to a table. Metrics tell you THAT something changed; samples tell you WHAT changed."],
    ], { h: 0.87 });
    T.num(s);
  }

  /* ---- Reproducibility ---- */
  {
    const s = T.slide("Ops", "The reproducibility checklist");
    T.compare(s, 1.4, 3.2,
      { title: "SEED EVERYTHING", items: [
        "random.seed(s)",
        "numpy.random.seed(s)",
        "torch.manual_seed(s)",
        "torch.cuda.manual_seed_all(s)",
        "DataLoader worker_init_fn and generator",
        "transformers.set_seed(s) covers most of these",
        "Partial seeding is worse than none — it looks reproducible",
      ]},
      { title: "RECORD EVERYTHING", items: [
        "Git SHA of the training code",
        "Data version tag (v3-curated-10k)",
        "Chat template name and version",
        "Full config file as a W&B artifact",
        "Library versions (pip freeze)",
        "GPU model and driver version",
        "The exact eval harness commit",
      ]}
    );
    T.banner(s, 4.85, "Test: can you regenerate any number in results/ six weeks from now, from the repo alone? If not, it is not a result.", C.moss);
    T.fieldNote(s, 0.55, 5.7, 12.2, 1.25,
      "Three weeks in I had a checkpoint that scored better than anything since, and no idea what produced it. I never " +
      "reproduced it. That single lost result cost me more than the entire discipline of committing configs first has cost since.");
    T.num(s);
  }

  /* ---- Debugging: OOM ---- */
  {
    const s = T.slide("Ops", "Debugging — CUDA out of memory");
    T.table(s, 1.4,
      ["Lever", "Memory saved", "Cost", "Try in this order"],
      [
        ["Close other GPU processes", "0.3–0.8 GB", "None", "1 — nvidia-smi first, always"],
        ["Lower max_seq_length", "Large — scales linearly", "Truncates long examples", "2 — biggest lever by far"],
        ["gradient_checkpointing=True", "Large", "~30% slower", "3"],
        ["Use Unsloth", "50–70%", "CUDA-only", "4 — should already be on"],
        ["per_device_batch=1 + accumulation", "Moderate", "Slower wall clock", "5 — quality unaffected"],
        ["paged_adamw_8bit", "Small, but survives spikes", "Slight slowdown", "6"],
        ["expandable_segments:True", "Fragmentation relief", "None", "7 — env var, free"],
        ["Lower LoRA rank", "Small", "Less capacity", "8 — rarely the real problem"],
        ["Smaller model", "Large", "You are here to learn", "9 — last resort"],
      ],
      [3.6, 2.7, 2.8, 3.1], { size: 10.5, rowH: 0.4 });
    T.codeBlock(s, 0.55, 5.35, 12.2, 1.4, [
      { t: "# Find out where the memory actually went", c: C.moss },
      "print(torch.cuda.memory_allocated()/1e9, torch.cuda.memory_reserved()/1e9)",
      "print(torch.cuda.memory_summary())          # detailed per-allocator breakdown",
      "export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True   # helps a lot on 4GB",
    ]);
    T.num(s);
  }

  /* ---- Debugging: NaN ---- */
  {
    const s = T.slide("Ops", "Debugging — NaN, loss spikes, and divergence");
    T.table(s, 1.4,
      ["Symptom", "Most likely cause", "Diagnostic", "Fix"],
      [
        ["NaN on step 1", "fp16 overflow in attention", "Check dtype config", "Use bf16 — your card supports it"],
        ["NaN after many steps", "LR too high; gradient explosion", "Plot grad_norm — it climbs first", "Lower LR 3x; add max_grad_norm=1.0"],
        ["Loss spikes then recovers", "A single bad batch", "Log the batch index at the spike", "Usually benign; inspect that data slice"],
        ["Loss spikes and stays high", "Optimizer state corrupted", "Check for inf in the data", "Restart from the last good checkpoint"],
        ["Loss slowly climbing", "LR too high for this stage", "grad_norm trending up", "Lower LR; check the schedule is decaying"],
        ["GRPO reward → NaN", "Extreme advantage; std near zero", "Log reward std per group", "Clip advantages; add eps to the denominator"],
        ["Everything NaN after resume", "Optimizer state not restored", "Compare LR and step count", "Resume properly, or restart the schedule"],
      ],
      [3.0, 3.0, 3.2, 3.0], { size: 10.5, rowH: 0.44 });
    T.banner(s, 4.9, "grad_norm is your early-warning system. It rises before the loss does. Log it every step in every phase.", C.moss);
    T.fieldNote(s, 0.55, 5.7, 12.2, 1.25,
      "fp16 NaN on step 1 is so common it is almost a rite of passage. Ampere and later support bfloat16, which has fp32's " +
      "exponent range. There is no reason to use fp16 on your card, and one very good reason not to.");
    T.num(s);
  }

  /* ---- Debugging: slow / wrong ---- */
  {
    const s = T.slide("Ops", "Debugging — slow training and wrong output");
    T.compare(s, 1.4, 3.1,
      { title: "TRAINING IS MYSTERIOUSLY SLOW", items: [
        "Silently on CPU — assert the device, do not assume",
        "MPS fallback on the Mac: many ops go to CPU with no warning",
        "Gradient checkpointing on when you no longer need it (~30%)",
        "Dataloader starved — raise num_workers",
        "Padding instead of packing: up to 60% wasted compute",
        "Flash Attention not installed",
        "Thermal throttling on a laptop — check clocks under load",
      ]},
      { title: "MODEL OUTPUTS GARBAGE", items: [
        "Chat template mismatch between train and inference",
        "Wrong EOS token: generation never terminates",
        "Loss masking wrong: learned to predict prompts",
        "LR far too high: collapsed into repetition",
        "Adapter not actually loaded at inference",
        "Quantization applied twice",
        "Sampling params differ from evaluation defaults",
      ]}
    );
    T.codeBlock(s, 0.55, 4.75, 12.2, 1.5, [
      { t: "# The three assertions that catch most of the left column", c: C.moss },
      "assert next(model.parameters()).device.type == 'cuda',  'training on CPU!'",
      "assert model.config.torch_dtype == torch.bfloat16",
      "print(f'{tokens_per_sec:.0f} tok/s')   # baseline it on run 1, watch for regressions",
    ]);
    T.num(s);
  }

  /* ---- eval won't move ---- */
  {
    const s = T.slide("Ops", "Debugging — the eval score will not move");
    T.steps(s, 1.4, [
      ["Confirm anything is training at all", "model.print_trainable_parameters(). If it says 0.0%, your target_modules string is wrong and every run so far has been a no-op."],
      ["Confirm the effective batch size", "Log the optimizer step count. If accumulation was silently ignored, your effective batch is 1 and training is pure noise."],
      ["Confirm masking is applied", "Decode one batch and inspect the labels. If the whole sequence is unmasked, you are training on prompts too."],
      ["Confirm train and eval use the SAME template", "Print both rendered strings and diff them. This is the single most common cause of a fine-tune scoring worse than its base."],
      ["Confirm the data is not junk", "Read fifty random training examples with your eyes. Not a sample of five — fifty. Problems are usually visible immediately."],
      ["Confirm the eval is sensitive enough", "Evaluate the BASE model and a deliberately-broken model. If they score the same, your harness is not measuring anything."],
      ["Only then tune hyperparameters", "In that order. Hyperparameters are the last thing to suspect, and the first thing everyone reaches for."],
    ], { h: 0.76 });
    T.num(s);
  }

  /* ---- Compute budgeting ---- */
  {
    const s = T.slide("Ops", "Compute budgeting on free hardware");
    T.table(s, 1.4,
      ["Phase", "Where", "Wall clock", "Notes"],
      [
        ["Sandbox + eval harness", "Mac (write) · Asus (bulk)", "3–5 days", "Mostly your time, not compute. Identical POSIX code on both."],
        ["Data curation", "Mac", "1–2 weeks", "CPU/RAM bound. 48GB is the enabler."],
        ["SFT run (0.5B, 10k examples)", "Asus", "20–40 min", "Run many. This is your iteration loop."],
        ["SFT run (1.5B, 10k examples)", "Asus", "2–3 hours", "Overnight-adjacent. Use sparingly."],
        ["Rejection sampling generation", "Mac", "6–12 hrs", "Overnight. The teacher is the bottleneck."],
        ["Rejection sampling execution", "Asus", "1–3 hrs", "Docker is cheap on Linux; 8 cores in parallel."],
        ["DPO run", "Asus", "30–60 min", "Cheap. Iterate freely."],
        ["GRPO run", "Asus", "8–24 hrs", "Generation and reward execution on one machine."],
        ["Merging", "Mac", "seconds–minutes", "Effectively free. Sweep widely."],
        ["Quantization + serving", "Both", "1–2 hours", "Mostly conversion and verification"],
      ],
      [4.2, 2.5, 1.9, 3.6], { size: 10, rowH: 0.365 });
    T.grid(s, 5.6, [
      ["The daily rhythm", "Kick off generation before bed. Curate over coffee. Train before lunch. Evaluate after. Read rollouts in the evening.", C.moss],
      ["Two machines means parallelism", "The Mac generates while the Asus trains and executes. Never leave one idle waiting on the other.", C.moss],
      ["One OS family, one codebase", "Both machines are POSIX, so the sandbox and harness run unmodified on either. No branch, no WSL, no second code path.", C.moss],
    ], { cols: 3, h: 1.2 });
    T.num(s);
  }

  /* ---- reading curves ---- */
  {
    const s = T.slide("Ops", "Reading training curves — the full reference");
    T.table(s, 1.4,
      ["Signal", "Healthy", "Warning", "Action"],
      [
        ["train/loss", "Smooth decline, then flattening", "Oscillation, spikes, NaN", "Lower LR; raise effective batch"],
        ["eval/pass@1", "Rises, peaks, then declines", "Flat from the start", "Check trainable %, masking, template"],
        ["grad_norm", "Stable or slowly declining", "Steady climb", "Lower LR NOW — before the loss shows it"],
        ["learning_rate", "Warms up then decays as configured", "Flat at peak", "Scheduler misconfigured"],
        ["output length", "Roughly stable", "Doubling (DPO) or collapsing", "Verbosity bias, or truncation gaming"],
        ["reward mean (GRPO)", "Gradual rise", "Step-function jump", "A shortcut was found — read rollouts"],
        ["reward std (GRPO)", "Non-zero, stable", "Trending to zero", "Dead groups — refilter your problem set"],
        ["KL from reference", "Slow rise, then plateau", "Unbounded growth", "Raise beta; the leash is too loose"],
        ["tokens/sec", "Constant", "Dropping over time", "Thermal throttling, or a memory leak"],
      ],
      [2.9, 3.4, 2.9, 3.0], { size: 10.5, rowH: 0.4 });
    T.banner(s, 5.35, "The loss curve describes optimization. Only the eval curve describes capability. Never confuse the two.", C.moss);
    T.num(s);
  }
};
