/* PART VII — SUPERVISED FINE-TUNING  (Phase 6) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("SFT", "Phase 6", "Your First Real Training Run",
    "One to two weeks. The mechanics are easy and the silent bugs are expensive.\nThis is where you learn to read a training run rather than just launch one."));

  /* ---- What SFT does ---- */
  {
    const s = T.slide("SFT", "What SFT actually changes");
    T.compare(s, 1.4, 2.9,
      { title: "SFT IS GOOD AT TEACHING", items: [
        "Output FORMAT — code fences, structure, where to stop",
        "Task shape — what a response to this kind of prompt looks like",
        "Style, tone, and idiom",
        "Domain vocabulary and conventions",
        "When to use a tool, and how to call it",
      ]},
      { title: "SFT IS BAD AT TEACHING", items: [
        "New FACTS — use retrieval instead, not fine-tuning",
        "New reasoning capability the base model lacks",
        "Anything requiring more than surface pattern completion",
        "Correctness — it learns to imitate, not to verify",
        "Preferences between two plausible answers (that is Phase 8)",
      ]}
    );
    T.banner(s, 4.55, "SFT teaches BEHAVIOR, not KNOWLEDGE. If you are fine-tuning to inject facts, you want retrieval.", C.moss);
    T.fieldNote(s, 0.55, 5.4, 12.2, 1.55,
      "The clearest way I have heard it put: SFT does not make the model smarter, it makes the model's existing intelligence " +
      "point in your direction. A 0.5B model that has never seen a good code answer will produce good-shaped code answers after " +
      "SFT — but it will not become able to solve problems it fundamentally could not reason about before. That capability jump " +
      "is what Phase 9 is for.");
    T.num(s);
  }

  /* ---- Full FT vs PEFT ---- */
  {
    const s = T.slide("SFT", "Full fine-tuning vs PEFT — the real tradeoff");
    T.table(s, 1.4,
      ["", "Full fine-tune", "LoRA", "QLoRA"],
      [
        ["Trainable params", "100%", "0.1 – 2%", "0.1 – 2%"],
        ["Memory for 0.5B", "~8 GB", "~1.5 GB", "~0.6 GB"],
        ["Memory for 1.5B", "~24 GB", "~4.5 GB", "~1.6 GB"],
        ["Memory for 7B", "~112 GB", "~20 GB", "~6 GB"],
        ["Runs on your 4GB card", "No", "0.5B only", "Both, comfortably"],
        ["Quality ceiling", "Highest", "~98% of full FT", "~97% of full FT"],
        ["Artifact size", "Full model (GB)", "Adapter (MB)", "Adapter (MB)"],
        ["Hot-swappable at serve time", "No", "Yes", "Yes"],
        ["Catastrophic forgetting risk", "High", "Lower", "Lower"],
      ],
      [3.4, 3.0, 2.9, 2.9], { size: 11, rowH: 0.4 });
    T.grid(s, 5.35, [
      ["Use QLoRA. All of it.", "On your hardware there is no decision to make. QLoRA is the only option that reaches 1.5B, and the quality gap is within noise.", C.moss],
      ["The gap is smaller than people think", "For task adaptation, LoRA is within a point or two of full FT. Full FT wins on large distribution shifts, which is not what you are doing.", C.ink],
      ["Adapters are a feature, not a compromise", "Tens of MB, versionable, hot-swappable, mergeable. Full checkpoints are none of those things.", C.moss],
    ], { cols: 3, h: 1.3 });
    T.num(s);
  }

  /* ---- LoRA explained ---- */
  {
    const s = T.slide("SFT", "LoRA — what is actually happening");
    T.codeBlock(s, 0.55, 1.4, 6.5, 2.9, [
      { t: "# A frozen weight matrix W  (d x k), e.g. 2048 x 2048", c: C.muted },
      "",
      { t: "# Full fine-tuning learns a dense update:", c: C.amber },
      "W' = W + dW          # dW is 2048x2048 = 4.2M params",
      "",
      { t: "# LoRA constrains dW to be LOW RANK:", c: C.moss },
      "W' = W + (alpha/r) * B @ A",
      "",
      "#   A is r x k   (16 x 2048 =  32,768)",
      "#   B is d x r   (2048 x 16 =  32,768)",
      "#   total        =  65,536 params  ->  1.5% of dW",
      "",
      { t: "# B is initialized to ZERO, so at step 0:  W' == W", c: C.moss },
      "# The model starts exactly as it was. Nothing is broken.",
    ], "THE DECOMPOSITION");
    T.grid(s, 1.4, [
      ["Why low rank works", "Empirically, the update needed to adapt a pretrained model to a task has low intrinsic dimensionality. You are not learning new capability — you are steering existing capability.", C.ink],
      ["B starts at zero", "Which means the adapted model is identical to the base at initialization. Training cannot 'break' the model on step one, unlike full FT with a bad LR.", C.moss],
      ["The base is frozen", "No gradients, no optimizer state for 99% of parameters. That is where the 20x memory saving comes from — not from the adapter being small.", C.moss],
      ["Merging is exact", "W + (alpha/r)·BA can be folded back into W with no approximation. A merged model is not an approximation of the adapter.", C.moss],
    ], { cols: 1, x: 7.25, w: 5.5, h: 1.05, gapY: 0.12 });
    T.num(s);
  }

  /* ---- rank ---- */
  {
    const s = T.slide("SFT", "LoRA hyperparameter — rank (r)");
    T.table(s, 1.4,
      ["r", "Params (0.5B, all-linear)", "Capacity", "Use when"],
      [
        ["4", "~1.5 M", "Very constrained", "Tiny datasets (< 1k), style-only adaptation"],
        ["8", "~3 M", "Light", "Small datasets, quick experiments"],
        ["16", "~6 M", "Balanced — the default", "Most tasks. Start here."],
        ["32", "~12 M", "Generous", "Larger datasets (50k+), bigger distribution shift"],
        ["64", "~24 M", "High", "Substantial behavior change; watch for overfitting"],
        ["128+", "~48 M+", "Approaching full FT", "Rarely justified. Usually a sign the problem is elsewhere."],
      ],
      [1.0, 3.6, 3.2, 4.4], { size: 11, rowH: 0.42 });
    T.accentRows(s, 4.35, [
      ["Higher rank is not 'better'", "it is more capacity", "More capacity on a small dataset means faster memorization, not better generalization. Rank should scale with data volume, not ambition.", C.rust],
      ["Rank interacts with data size", "rule of thumb", "< 5k examples: r=8. 5k–50k: r=16. 50k+: r=32. Then ablate around your starting point.", C.moss],
      ["Ablate rank AFTER data is clean", "order matters", "Tuning rank on dirty data optimizes for memorizing noise. Fix the data first — the answer often changes.", C.amber],
    ], { h: 0.68, labelW: 3.0 });
    T.num(s);
  }

  /* ---- alpha ---- */
  {
    const s = T.slide("SFT", "LoRA hyperparameter — alpha, and the scaling trap");
    s.addText(
      "alpha does not control capacity. It controls the MAGNITUDE of the update, through the scaling factor alpha/r. " +
      "This is the parameter people most often misunderstand.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.65, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.codeBlock(s, 0.55, 2.15, 6.5, 2.4, [
      "W' = W + (alpha / r) * B @ A",
      "",
      { t: "# r=16, alpha=32  ->  scale 2.0    <- common default", c: C.moss },
      { t: "# r=16, alpha=16  ->  scale 1.0    <- conservative", c: C.ink },
      { t: "# r=64, alpha=16  ->  scale 0.25   <- update barely applied!", c: C.rust },
      "",
      { t: "# THE TRAP: raising r while keeping alpha fixed", c: C.rust, b: true },
      { t: "# SHRINKS the effective update. People raise rank,", c: C.rust },
      { t: "# see no improvement, and conclude rank does not matter.", c: C.rust },
    ], "SCALING");
    T.grid(s, 2.15, [
      ["The convention", "alpha = 2r. Keeps the scale at 2.0 as you vary rank, so a rank sweep actually measures rank.", C.moss],
      ["The alternative convention", "alpha = r, scale 1.0. Also fine. What matters is that you keep it CONSISTENT across a sweep.", C.moss],
      ["rsLoRA changes the formula", "Rank-stabilized LoRA uses alpha/sqrt(r) instead of alpha/r, which keeps the scale sane at high rank. Worth enabling for r >= 64.", C.ink],
      ["alpha interacts with LR", "Doubling alpha is roughly like doubling the learning rate for the adapter. Do not tune both at once.", C.amber],
    ], { cols: 1, x: 7.25, w: 5.5, h: 0.86, gapY: 0.1 });
    T.fieldNote(s, 0.55, 4.8, 12.2, 1.3,
      "I ran a rank sweep — 8, 16, 32, 64 — with alpha pinned at 16, and concluded that rank had no effect on my task. " +
      "It did not, because I was simultaneously scaling the update down by 8x. Set alpha = 2r and sweep again.");
    T.num(s);
  }

  /* ---- target modules ---- */
  {
    const s = T.slide("SFT", "LoRA hyperparameter — target modules");
    T.table(s, 1.4,
      ["Target set", "Modules", "Params", "Effect"],
      [
        ["Attention only (original paper)", "q_proj, v_proj", "Lowest", "Works, but leaves capability on the table"],
        ["Full attention", "q, k, v, o_proj", "Low", "Better; still misses the MLP where most parameters live"],
        ["all-linear (recommended)", "q,k,v,o + gate,up,down_proj", "Moderate", "Consistently best in practice. The default you want."],
        ["+ embeddings / lm_head", "above + embed_tokens, lm_head", "High", "Only if you added tokens to the vocabulary"],
      ],
      [3.6, 4.0, 1.6, 3.0], { size: 11, rowH: 0.46 });
    T.grid(s, 3.65, [
      ["Target all-linear", "The original LoRA paper targeted attention because that was the 2021 intuition. Subsequent work — and QLoRA specifically — found that including the MLP projections matters more. Most of a transformer's parameters live in the MLP.", C.moss],
      ["Do NOT target embeddings by default", "Large, slow to train, and rarely helpful. The exception is when you have added special tokens to the vocabulary, in which case you must.", C.amber],
      ["Verify what you actually hit", "print the module names PEFT matched. A typo in target_modules silently trains nothing at all and looks like a normal run.", C.rust],
    ], { cols: 3, h: 1.75 });
    T.codeBlock(s, 0.55, 5.6, 12.2, 1.3, [
      "peft_config = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05,",
      "                        target_modules='all-linear', task_type='CAUSAL_LM')",
      "model = get_peft_model(model, peft_config)",
      { t: "model.print_trainable_parameters()   # ALWAYS. Expect ~0.5-2%. If it says 0.0%, you targeted nothing.", c: C.moss },
    ]);
    T.num(s);
  }

  /* ---- QLoRA ---- */
  {
    const s = T.slide("SFT", "QLoRA — the three tricks that fit 1.5B on 4GB");
    T.steps(s, 1.4, [
      ["NF4 — 4-bit NormalFloat quantization", "The frozen base weights are stored in a 4-bit datatype that is information-theoretically optimal for normally-distributed values, which is what neural network weights approximately are. Dequantized on the fly during the forward pass. ~8x smaller than fp32."],
      ["Double quantization", "The quantization constants themselves are quantized. Saves roughly another 0.4 bits per parameter. Small in percentage terms, meaningful when you are 200MB from an OOM."],
      ["Paged optimizers", "Optimizer state lives in unified memory and pages to CPU RAM under pressure, using NVIDIA's unified memory. Turns a hard OOM crash during a memory spike into a slowdown. On a 4GB card this is what makes long runs survivable."],
    ], { h: 1.35, bottom: 5.5 });
    T.codeBlock(s, 0.55, 5.65, 12.2, 1.25, [
      "bnb_config = BitsAndBytesConfig(",
      "    load_in_4bit=True, bnb_4bit_quant_type='nf4',",
      "    bnb_4bit_use_double_quant=True, bnb_4bit_compute_dtype=torch.bfloat16)",
      { t: "# compute_dtype is NOT the storage dtype — weights are stored 4-bit, computed in bf16", c: C.moss },
    ]);
    T.num(s);
  }

  /* ---- Memory math ---- */
  {
    const s = T.slide("SFT", "The memory math — your 4GB budget, line by line",
      "Assumes Ubuntu in hybrid mode: the display runs on the integrated Radeon, so the 3050 is yours.");
    T.table(s, 1.62,
      ["Component", "Formula", "0.5B QLoRA", "1.5B QLoRA"],
      [
        ["Base weights (NF4)", "~0.55 bytes/param", "0.28 GB", "0.83 GB"],
        ["LoRA adapter (bf16)", "2 bytes/trainable", "0.01 GB", "0.03 GB"],
        ["Gradients (adapter only)", "2 bytes/trainable", "0.01 GB", "0.03 GB"],
        ["Optimizer state (8-bit Adam)", "2 bytes/trainable", "0.01 GB", "0.03 GB"],
        ["Activations (seq 512, batch 1)", "scales with seq x batch", "0.35 GB", "0.75 GB"],
        ["CUDA context + fragmentation", "fixed overhead", "0.50 GB", "0.50 GB"],
        ["Desktop compositor", "0 on Linux — was 0.5–1.0 on Windows", "0.00 GB", "0.00 GB"],
        ["TOTAL", "", "~1.2 GB", "~2.2 GB"],
        ["Headroom of the 3.95 GB usable", "", "2.75 GB — raise batch", "1.75 GB — raise seq_len"],
      ],
      [4.0, 3.4, 2.4, 2.4], { size: 10.5, rowH: 0.345 });
    T.banner(s, 5.25, "Activations dominate and they scale with seq_len x batch_size. Cut sequence length before you cut model size.", C.moss);
    T.grid(s, 5.9, [
      ["Gradient checkpointing", "Trades ~30% speed for a large activation reduction. Turn it on the moment you hit OOM.", C.moss],
      ["Flash Attention 2", "Attention memory from O(n²) to O(n). Free win on Ampere. Compile it once.", C.moss],
      ["Unsloth", "Halves the budget again via fused kernels. Non-optional at 1.5B.", C.moss],
    ], { cols: 3, h: 1.05 });
    T.num(s);
  }

  /* ---- LR ---- */
  {
    const s = T.slide("SFT", "Learning rate — the single most important knob");
    T.table(s, 1.4,
      ["Setting", "Typical LR", "Symptom if too high", "Symptom if too low"],
      [
        ["Full fine-tune", "1e-5 – 5e-5", "Loss spikes, then NaN", "Barely moves off baseline"],
        ["LoRA / QLoRA", "1e-4 – 3e-4", "Loss oscillates; output degrades into repetition", "Loss falls slowly, model unchanged"],
        ["Embeddings (if targeted)", "1e-5 – 5e-5", "Vocabulary collapse", "No effect"],
        ["DPO (Phase 8)", "5e-7 – 5e-6", "Reference drift, gibberish", "Preference margin never separates"],
        ["GRPO (Phase 9)", "1e-6 – 5e-6", "Policy collapse within ~50 steps", "Reward flat for hours"],
      ],
      [3.2, 2.6, 3.4, 3.0], { size: 11, rowH: 0.44 });
    T.banner(s, 4.05, "LoRA needs a learning rate roughly 10x higher than full fine-tuning. Copying an LR from a full-FT tutorial is the classic 'LoRA doesn't work' bug.", C.rust);
    T.grid(s, 4.85, [
      ["Schedule: cosine with warmup", "Warmup 3–5% of total steps, then cosine decay to ~10% of peak. Boring, reliable, hard to beat.", C.moss],
      ["Sweep in multiples of 3", "1e-4, 3e-4, 1e-3. Factor-of-3 steps. Sweeping 2e-4 vs 2.5e-4 is measuring noise.", C.moss],
      ["Verify the schedule is real", "Log the LR every step. A misconfigured scheduler that stays flat at peak is a common and invisible bug.", C.rust],
    ], { cols: 3, h: 1.3 });
    T.fieldNote(s, 0.55, 6.3, 12.2, 0.9,
      "My first LoRA run used 2e-5 from a full-FT guide. Loss dropped a little, eval was unchanged, and I spent two days assuming LoRA was overhyped. It was 10x too low.");
    T.num(s);
  }

  /* ---- batch / accum ---- */
  {
    const s = T.slide("SFT", "Batch size, gradient accumulation, and effective batch");
    T.codeBlock(s, 0.55, 1.4, 6.5, 2.0, [
      "effective_batch = per_device_batch",
      "                  x gradient_accumulation_steps",
      "                  x num_devices",
      "",
      { t: "# Your 4GB reality:", c: C.moss },
      "per_device_batch = 1        # VRAM-bound",
      "gradient_accumulation = 16  # free, costs only time",
      { t: "effective_batch = 16        # <- what actually matters", c: C.moss, b: true },
    ], "THE ONLY EQUATION THAT MATTERS");
    T.grid(s, 1.4, [
      ["Only effective batch matters for quality", "Gradient accumulation is mathematically equivalent to a larger batch (modulo batch norm, which transformers do not use). You are not compromising.", C.moss],
      ["Target 16–64 effective for SFT", "Below 8 the gradients are noisy and training is unstable. Above 128 you are wasting steps on a small dataset.", C.moss],
      ["Accumulation costs time, not memory", "16 accumulation steps means 16 forward/backward passes before one optimizer step. Slower wall clock, identical memory.", C.ink],
      ["Verify it took effect", "Log the actual number of optimizer steps. A config that silently runs accum=1 gives you effective batch 1 and terrible results.", C.rust],
    ], { cols: 1, x: 7.25, w: 5.5, h: 0.88, gapY: 0.1 });
    T.accentRows(s, 3.7, [
      ["Small effective batch", "eff = 1-4", "Noisy gradients, unstable loss, poor final quality. Almost always an accidental misconfiguration.", C.rust],
      ["Good effective batch", "eff = 16-64", "The sweet spot for SFT on datasets of 5k-100k examples.", C.moss],
      ["Large effective batch", "eff = 128+", "Smoother, but on a 10k dataset that is only ~80 optimizer steps per epoch. Too few to learn much.", C.amber],
    ], { h: 0.7, labelW: 2.4 });
    T.fieldNote(s, 0.55, 6.2, 12.2, 1.0,
      "I lost a week to an effective batch size of 1. I had set gradient_accumulation_steps in the wrong config block, it was " +
      "silently ignored, and every run was noisy and bad. Log the optimizer step count.");
    T.num(s);
  }

  /* ---- sequence length / packing ---- */
  {
    const s = T.slide("SFT", "Sequence length, packing, and truncation");
    T.compare(s, 1.4, 2.9,
      { title: "PADDING (default)", items: [
        "Each example padded to seq_len",
        "Simple, obviously correct",
        "Wastes compute on padding tokens",
        "Short-example datasets can be 60% padding",
        "Attention mask prevents cross-contamination",
      ]},
      { title: "PACKING", items: [
        "Multiple examples concatenated into one sequence",
        "Near-zero wasted compute — often 2–3x throughput",
        "Needs correct position ids and attention masking",
        "Naive packing lets examples ATTEND ACROSS boundaries",
        "TRL supports it; verify the mask, do not assume",
      ]}
    );
    T.accentRows(s, 4.55, [
      ["Choose seq_len from the p95", "measure, do not guess", "Compute your dataset's token-length percentiles. Set seq_len at p95. Truncating 5% is fine; truncating 25% silently destroys your data.", C.moss],
      ["Truncation is invisible", "no warning is emitted", "A truncated example teaches the model to stop mid-function. Log the truncation rate every run.", C.rust],
      ["Packing changes the batch math", "eff. batch is fuzzy", "With packing, 'batch size 1' may be six examples. Your effective batch is larger than the config says.", C.amber],
    ], { h: 0.7, labelW: 3.0 });
    T.num(s);
  }

  /* ---- epochs ---- */
  {
    const s = T.slide("SFT", "Epochs, overfitting, and checkpoint selection");
    s.addChart(pres.ChartType.line, [
      { name: "Train loss (normalized)", labels: ["0", "0.5", "1", "1.5", "2", "2.5", "3", "4", "5"], values: [1.00, 0.71, 0.58, 0.47, 0.39, 0.31, 0.25, 0.15, 0.08] },
      { name: "Held-out pass@1 (normalized)", labels: ["0", "0.5", "1", "1.5", "2", "2.5", "3", "4", "5"], values: [0.70, 0.86, 0.95, 1.00, 0.99, 0.96, 0.93, 0.88, 0.82] },
    ], {
      x: 0.55, y: 1.4, w: 7.3, h: 3.5,
      showTitle: true, title: "Epochs — train loss keeps falling long after the model stops improving",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      chartColors: [C.amber, C.moss], lineSize: 3, lineSmooth: true,
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 10.5, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      showLegend: true, legendPos: "b", legendFontFace: BODY, legendFontSize: 10.5,
    });
    T.grid(s, 1.4, [
      ["1–3 epochs for SFT", "Beyond three, you are memorizing. On small curated datasets the peak is often before epoch 2.", C.moss],
      ["Checkpoint on EVAL, never on loss", "The two diverge after roughly epoch 1.5. Saving on best-loss ships your worst useful model.", C.rust],
      ["Evaluate mid-epoch", "On a 10k dataset one epoch is few steps. Evaluate every N steps, not every epoch, or you will miss the peak entirely.", C.moss],
      ["Keep every checkpoint", "Adapters are tens of MB. Keep them all — you will want them in Phase 11 for merging.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 0.85, gapY: 0.1 });
    T.fieldNote(s, 0.55, 5.1, 12.2, 1.1,
      "I shipped the epoch-5 checkpoint because the loss curve looked like a textbook. It was two points worse than epoch 2 " +
      "on anything it had not seen. Every run now saves on best-eval and the loss curve is decoration.");
    T.num(s);
  }

  /* ---- precision / checkpointing / optimizers ---- */
  {
    const s = T.slide("SFT", "Precision, checkpointing, and optimizers");
    T.accentRows(s, 1.4, [
      ["bf16, not fp16", "bnb_4bit_compute_dtype=bfloat16", "Ampere and later support bfloat16. It has fp32's exponent range, so it does not overflow the way fp16 does. fp16 NaN on step 1 is nearly always this.", C.moss],
      ["Gradient checkpointing", "gradient_checkpointing=True", "Recomputes activations during the backward pass instead of storing them. Roughly 30% slower, large memory saving. Turn on at the first OOM.", C.moss],
      ["8-bit Adam", "optim='paged_adamw_8bit'", "Optimizer state at 1/4 the memory. With LoRA the state is already small, but paged is what survives spikes on 4GB.", C.moss],
      ["Do not use fp32", "wastes everything", "No benefit at this scale and 2x the memory. bf16 mixed precision is the default for good reason.", C.amber],
      ["torch.compile", "optional, fiddly", "Can give real speedups; also breaks frequently with PEFT and quantization. Try it late, not early.", C.ink],
      ["Watch grad_norm", "log it every step", "Rising grad_norm precedes divergence. It is your earliest warning that the LR is too high — earlier than the loss curve.", C.moss],
    ], { h: 0.8, labelW: 3.3 });
    T.num(s);
  }

  /* ---- Unsloth ---- */
  {
    const s = T.slide("SFT", "Unsloth — why it is not optional on 4GB");
    T.grid(s, 1.4, [
      ["What it does", "Replaces the hot paths — attention, MLP, RoPE, cross-entropy — with hand-written Triton kernels and a manual backward pass. Same math, far less overhead.", C.ink],
      ["What you get", "Roughly 2x throughput and 50–70% less VRAM versus stock HF + PEFT. No accuracy loss; this is an implementation optimization, not an approximation.", C.moss],
      ["Why it matters here", "It is the difference between 1.5B being trainable on your card and not. At 0.5B it means twice as many experiments per day.", C.moss],
      ["The catch", "CUDA only, so the Mac cannot use it. Model coverage is good but not universal — check that your architecture is supported before building a pipeline around it.", C.amber],
    ], { cols: 2, h: 1.45 });
    T.codeBlock(s, 0.55, 4.35, 12.2, 2.0, [
      "from unsloth import FastLanguageModel",
      "model, tok = FastLanguageModel.from_pretrained(",
      "    'unsloth/Qwen2.5-Coder-0.5B-Instruct', max_seq_length=1024,",
      "    load_in_4bit=True, dtype=None)                    # dtype=None -> auto bf16",
      "model = FastLanguageModel.get_peft_model(",
      "    model, r=16, lora_alpha=32, lora_dropout=0.0,     # 0.0 is Unsloth's fast path",
      "    target_modules=['q_proj','k_proj','v_proj','o_proj',",
      "                    'gate_proj','up_proj','down_proj'],",
      "    use_gradient_checkpointing='unsloth')             # their own, more efficient variant",
    ]);
    T.num(s);
  }

  /* ---- TRL trainer ---- */
  {
    const s = T.slide("SFT", "The TRL SFTTrainer, annotated");
    T.codeBlock(s, 0.55, 1.4, 12.2, 4.4, [
      "from trl import SFTTrainer, SFTConfig",
      "from trl import DataCollatorForCompletionOnlyLM",
      "",
      { t: "# THE CRITICAL LINE — this string must match your template EXACTLY", c: C.rust, b: true },
      "collator = DataCollatorForCompletionOnlyLM(",
      "    response_template='<|im_start|>assistant\\n', tokenizer=tok)",
      "",
      "cfg = SFTConfig(",
      "    output_dir='ckpt/06-sft-r16-lr2e4',",
      "    per_device_train_batch_size=1,",
      "    gradient_accumulation_steps=16,      # effective batch = 16",
      "    num_train_epochs=2,",
      "    learning_rate=2e-4,                  # 10x a full-FT LR",
      "    lr_scheduler_type='cosine', warmup_ratio=0.03,",
      "    bf16=True, gradient_checkpointing=True,",
      "    optim='paged_adamw_8bit',",
      "    max_seq_length=1024,                 # from YOUR p95, not a guess",
      "    logging_steps=10,",
      { t: "    eval_strategy='steps', eval_steps=100,          # mid-epoch eval", c: C.moss },
      { t: "    load_best_model_at_end=True,                    # pick on EVAL", c: C.moss },
      { t: "    metric_for_best_model='eval_pass_at_1',         # not eval_loss!", c: C.moss, b: true },
      "    seed=0, report_to='wandb',",
      ")",
      "trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds,",
      "                     data_collator=collator, peft_config=peft_config)",
    ], "sft.py");
    T.banner(s, 6.0, "response_template must match your chat template byte for byte. A mismatch means NO masking is applied and nothing warns you.", C.rust);
    T.num(s);
  }

  /* ---- Alternatives ---- */
  {
    const s = T.slide("SFT", "Alternatives — Axolotl, LLaMA-Factory, and the MLX path");
    T.grid(s, 1.4, [
      ["Axolotl", "Config-driven YAML, no Python required for standard runs. Excellent defaults, wide model support. Good when you want to run many variants without writing code.", C.ink],
      ["LLaMA-Factory", "Similar philosophy, plus a web UI. Very broad method coverage — SFT, DPO, PPO, KTO all in one place.", C.ink],
      ["torchtune", "PyTorch-native, readable recipes. Good if you want to READ the training loop rather than configure one.", C.ink],
      ["MLX (Mac)", "mlx_lm.lora trains on Apple Silicon. Fast for its class. Apple-specific, so the knowledge does not transfer — use it for local iteration, not as your primary path.", C.amber],
    ], { cols: 2, h: 1.5 });
    T.codeBlock(s, 0.55, 4.45, 12.2, 1.6, [
      { t: "# The MLX path on the Mac — useful for a parallel run while the Asus is busy", c: C.moss },
      "mlx_lm.lora --model Qwen/Qwen2.5-Coder-0.5B-Instruct --train \\",
      "  --data data/processed/v3-curated-10k --batch-size 4 --num-layers 16 \\",
      "  --iters 2000 --learning-rate 2e-4 --adapter-path ckpt/mlx-sft-v3",
    ]);
    T.banner(s, 6.25, "Recommendation: write sft.py with TRL yourself. You are here to learn the mechanics, and configs hide them.", C.moss);
    T.num(s);
  }

  /* ---- Forgetting ---- */
  {
    const s = T.slide("SFT", "Catastrophic forgetting — measure it or it happens invisibly");
    T.grid(s, 1.4, [
      ["What it is", "The model gains your task and loses unrelated abilities. Weights that encoded general capability get overwritten by your narrow gradient signal.", C.ink],
      ["Why LoRA helps", "The base is frozen and the update is low-rank, so the damage is bounded. LoRA forgets far less than full fine-tuning — but it still forgets.", C.moss],
      ["How to see it", "Run a general benchmark on every checkpoint. Without that, forgetting is completely invisible until a user complains.", C.rust],
      ["Mitigation 1 — mix in general data", "5–15% general instruction data. Costs about half a point of code performance, recovers most general ability.", C.moss],
      ["Mitigation 2 — lower rank / fewer epochs", "Less capacity and less exposure means less overwriting. Often the simplest fix.", C.moss],
      ["Mitigation 3 — merge with the base", "In Phase 11, merging your fine-tune back toward the base recovers general ability at some task cost. A genuine dial.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.35, "Forgetting is a legitimate design CHOICE. It should never be a surprise.", C.moss);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "My best code checkpoint could no longer answer a general knowledge question in a complete sentence. It had become a " +
      "function-emitting appliance. Fine as a deliberate decision; alarming as a discovery.");
    T.num(s);
  }

  /* ---- Reading curves ---- */
  {
    const s = T.slide("SFT", "Reading training curves like an engineer");
    T.table(s, 1.4,
      ["What you see", "What it means", "What to do"],
      [
        ["Loss flat from step 0", "LR too low, or nothing is trainable", "print_trainable_parameters(); raise LR 10x"],
        ["Loss drops then plateaus high", "Underfitting: capacity or LR too low", "Raise rank, raise LR, train longer"],
        ["Loss drops smoothly, eval flat", "Memorization — the classic", "Fewer epochs; checkpoint on eval; check for duplicates"],
        ["Loss oscillates violently", "LR too high, or effective batch too small", "Lower LR 3x; raise gradient accumulation"],
        ["Sudden spike then recovery", "A bad batch — outlier or corrupt record", "Usually benign; if repeated, inspect that data slice"],
        ["Loss → NaN", "fp16 overflow, or LR far too high", "Switch to bf16; lower LR; check for inf in data"],
        ["grad_norm climbing steadily", "Approaching divergence", "Lower LR now, before the loss shows it"],
        ["Eval improves then declines", "Overfitting past the peak", "You already have the best checkpoint. Stop."],
        ["Train and eval both flat", "Data problem, not a training problem", "Go back to Phase 5. Check masking and templates."],
      ],
      [3.9, 4.2, 4.1], { size: 10.5, rowH: 0.4 });
    T.banner(s, 5.5, "The loss curve tells you about optimization. Only the eval curve tells you about capability.", C.moss);
    T.num(s);
  }

  /* ---- Debugging OOM ---- */
  {
    const s = T.slide("SFT", "Debugging — OOM on a 4GB card",
      "Work down this list in order. The first two solve most cases.");
    T.steps(s, 1.62, [
      ["Confirm the card is actually idle", "nvidia-smi should read single-digit MB before you start. Hundreds means the dGPU drives your display, or a dead process holds the context."],
      ["Lower seq_len before anything else", "Activations scale with sequence length. 1024 → 512 roughly halves activation memory and is the single most effective lever."],
      ["Enable gradient checkpointing", "gradient_checkpointing=True. About 30% slower, large memory saving. Should be on by default at this scale."],
      ["Use Unsloth", "50–70% less VRAM for identical math. If you are not using it on this card, start."],
      ["Switch to paged 8-bit optimizer", "optim='paged_adamw_8bit'. Survives transient spikes by paging to host RAM instead of crashing."],
      ["Reduce batch to 1, raise accumulation", "Effective batch is preserved. Costs wall-clock time only."],
      ["Set the allocator config", "PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True helps materially with fragmentation on small cards."],
      ["Last resort — drop to a TTY", "Ctrl+Alt+F3, log in, run headless. Buys back the last ~20MB and removes any chance the desktop touches the card mid-run."],
    ], { h: 0.72, bottom: 7.0 });
    T.num(s);
  }

  /* ---- SFT traps ---- */
  {
    T.num(T.ptn("SFT", "SFT — path and traps",
      [
        "QLoRA, r=16, alpha=32, target all-linear, bf16",
        "LR 2e-4 with cosine schedule and 3% warmup",
        "Effective batch 16 via batch 1 x accumulation 16",
        "seq_len from your data's p95, not a round number",
        "1–3 epochs; evaluate every 100 steps, not every epoch",
        "Checkpoint on eval_pass_at_1, never on eval_loss",
        "Verify masking by decoding a batch; verify trainable % is non-zero",
        "Run a general benchmark each checkpoint to catch forgetting",
      ],
      [
        "Full-FT learning rate (2e-5) on LoRA — 10x too low, looks like 'LoRA doesn't work'",
        "Loss over prompt tokens: the silent bug that costs a week",
        "response_template not matching the chat template: masking silently disabled",
        "Raising rank while holding alpha fixed: shrinks the update, hides the effect",
        "Saving on best loss: ships your most memorized checkpoint",
        "seq_len guessed: silently truncates a quarter of your data",
        "grad accumulation set in the wrong config block: effective batch 1",
        "fp16 on a bf16-capable card: NaN on step 1",
      ],
      "Every trap on the right produces a run that COMPLETES. Nothing errors. The loss curve often looks fine. " +
      "That is what makes SFT deceptively hard — the failure mode is not a crash, it is a plausible-looking run that taught the model the wrong thing.",
      { noteH: 1.3, size: 11.5 }));
  }

  /* ---- SFT false positives ---- */
  {
    const s = T.slide("SFT", "The SFT false positives");
    T.table(s, 1.4,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Memorization", "Train loss beautiful, eval flat", "Model memorized the training set", "Checkpoint on eval; check dedup"],
        ["Nothing was trained", "Loss decreases slightly, model unchanged", "target_modules typo — 0% trainable", "print_trainable_parameters()"],
        ["Masking silently off", "Loss looks normal, behavior degrades", "response_template mismatch, no masking applied", "Decode a batch, inspect labels"],
        ["Truncation", "Model stops mid-function", "seq_len below your data's p95", "Log truncation rate every run"],
        ["Template mismatch at eval", "Fine-tune scores WORSE than base", "Trained with one template, evaluated with another", "Diff the rendered strings"],
        ["Effective batch of 1", "Noisy loss, poor results, no error", "Accumulation config silently ignored", "Log optimizer step count"],
        ["Forgetting", "Code up, everything else quietly gone", "Narrow gradient overwrote general ability", "General benchmark every checkpoint"],
        ["Cherry-picked checkpoint", "Best-of-20 looks excellent", "Overfit to the validation set", "Select on val, report on sealed test"],
      ],
      [2.7, 3.0, 3.4, 3.1], { size: 10.5, rowH: 0.42 });
    T.banner(s, 5.2, "Three of these produce a HIGHER number than the truth. Five produce a run that looks entirely normal.", C.rust);
    T.fieldNote(s, 0.55, 6.0, 12.2, 0.95,
      "'Fine-tune scores worse than base' is almost never the fine-tune. It is almost always the template. Check that first, every time.");
    T.num(s);
  }
};
