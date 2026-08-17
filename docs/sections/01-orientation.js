/* PART I — ORIENTATION */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  /* ---- Title ---- */
  {
    const s = T.darkSlide();
    s.addText("FIELD GUIDE", {
      x: 0.85, y: 1.85, w: 11.6, h: 0.4,
      fontFace: BODY, fontSize: 13, bold: true, color: C.moss, charSpacing: 6, margin: 0,
    });
    s.addText("Post-Training a Code Model", {
      x: 0.85, y: 2.3, w: 11.6, h: 1.0,
      fontFace: HEAD, fontSize: 46, bold: true, color: C.white, margin: 0,
    });
    s.addText("What worked, what wasted my time, and what lied to me.", {
      x: 0.85, y: 3.35, w: 10.8, h: 0.5,
      fontFace: BODY, fontSize: 18, italic: true, color: C.lightMoss, margin: 0,
    });
    s.addShape(pres.ShapeType.rect, { x: 0.85, y: 4.15, w: 1.4, h: 0.04, fill: { color: C.moss } });
    s.addText(
      "A complete cookbook, written backwards from the far side of the jungle.\n" +
      "Ordered the way you will actually build it — day one to shipped model.",
      { x: 0.85, y: 4.45, w: 10.8, h: 0.9, fontFace: BODY, fontSize: 13.5, color: C.muted, margin: 0, valign: "top" }
    );
    s.addNotes("Read front-to-back once. After that, the Trap Index and False Positive Index at the back are the working reference.");
    T.num(s);
  }

  /* ---- How to read ---- */
  {
    const s = T.slide("Orientation", "How to read this guide");
    const rows = [
      ["path", "The technique, why it works, and the two or three parameters that actually move the needle. If a slide only had one of these blocks, it would be this one."],
      ["trap", "Loopholes, diversions, and outright traps. Things that cost me days and are not written down anywhere in the papers."],
      ["fp", "The expensive category. These do not fail — they succeed, incorrectly, and you believe them. Every one of these has burned me at least once."],
      ["note", "First-person, with numbers. Replace these with your own results as you go; the deck is designed to become your lab notebook."],
    ];
    let y = 1.42;
    rows.forEach(([kind, desc]) => {
      T.card(s, 0.55, y, 12.2, 1.10, C.white);
      T.marker(s, kind, 0.85, y + 0.22);
      s.addText(desc, {
        x: 1.3, y: y + 0.56, w: 11.1, h: 0.48,
        fontFace: BODY, fontSize: 11.8, color: C.ink, margin: 0, valign: "top",
      });
      y += 1.22;
    });
    T.banner(s, 6.35, "Every phase repeats this pattern. The order of the deck is the order of the work.", C.forest);
    T.num(s);
  }

  /* ---- LLM lifecycle ---- */
  {
    const s = T.slide("Orientation", "The full lifecycle, and your slice of it");
    T.pipeline(s, 1.45, [
      ["PRETRAINING", "Trillions of tokens. Months. Millions of dollars. Produces a base model that completes text and follows nothing.", C.muted],
      ["MID-TRAINING", "Domain adaptation, long-context extension, capability injection. Increasingly its own stage.", C.muted],
      ["POST-TRAINING", "SFT, preference optimization, RL. Turns a completion engine into something that follows instructions and does tasks.", C.moss],
      ["INFERENCE", "Quantize, serve, decode. Where all the capability actually gets delivered to a user.", C.muted],
    ], { h: 1.75 });

    T.banner(s, 3.45, "Everything in this deck lives in box three — and box three is reachable on a laptop.", C.moss);

    T.grid(s, 4.3, [
      ["What pretraining gives you", "Raw capability. Knowledge, syntax, reasoning substrate. You cannot add much of this in post-training — you can only surface it.", C.ink],
      ["What post-training gives you", "Format, instruction-following, task competence, refusal behavior, tool use, and reasoning depth. Enormous behavioral change, tiny compute.", C.moss],
      ["What inference gives you", "Cost, latency, and reach. A 0.5B model on-device serves people a 400B model never will.", C.ink],
    ], { cols: 3, h: 1.9 });

    T.fieldNote(s, 0.55, 6.35, 12.2, 0.85,
      "I spent two weeks reading pretraining scaling laws before touching anything. Interesting, and completely irrelevant to the work in front of me.");
    T.num(s);
  }

  /* ---- 80/20 ---- */
  {
    const s = T.slide("Orientation", "The thing nobody tells you first");
    s.addText("80%", { x: 0.55, y: 1.32, w: 3.2, h: 1.3, fontFace: HEAD, fontSize: 76, bold: true, color: C.moss, margin: 0 });
    s.addText("of this job is data and evaluation.", {
      x: 3.9, y: 1.7, w: 8.8, h: 0.6, fontFace: HEAD, fontSize: 24, bold: true, color: C.ink, margin: 0, valign: "middle" });
    s.addText(
      "The training code is a solved problem. TRL, PEFT, and Unsloth run your job in twenty lines and are not where you will struggle. " +
      "What separates good post-training from bad is whether your data is clean and whether you can tell the model actually improved.",
      { x: 0.55, y: 2.85, w: 12.2, h: 0.9, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    const split = [["Data curation", 45, C.moss], ["Evaluation", 35, C.lightMoss], ["Training code", 15, C.amber], ["Tuning", 5, C.muted]];
    let x = 0.55;
    split.forEach(([label, pct, col]) => {
      const w = (pct / 100) * 12.2;
      s.addShape(pres.ShapeType.rect, { x: x, y: 3.95, w: w, h: 0.52, fill: { color: col } });
      if (pct >= 15) {
        s.addText(`${label}  ${pct}%`, {
          x: x, y: 3.95, w: w, h: 0.52, fontFace: BODY, fontSize: 11.5, bold: true,
          color: C.dark, align: "center", valign: "middle", margin: 0,
        });
      }
      x += w;
    });
    s.addText("Where my hours actually went, measured after the fact — not where I expected them to go.", {
      x: 0.55, y: 4.58, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11, italic: true, color: C.muted, margin: 0 });
    T.fieldNote(s, 0.55, 5.05, 12.2, 1.15,
      "I rewrote my training loop four separate times before I ever checked my dataset for duplicates. It was 31% near-duplicate. " +
      "Fixing that beat every hyperparameter I have ever tuned, combined, and it took an afternoon.");
    T.banner(s, 6.35, "If you take one thing from this deck: build the ruler, then clean the data, then train.", C.moss);
    T.num(s);
  }

  /* ---- Vocabulary 1 ---- */
  {
    const s = T.slide("Orientation", "Vocabulary, part 1", "Terms used from here on without further explanation.");
    T.table(s, 1.62,
      ["Term", "What it means in practice"],
      [
        ["Base model", "Pretrained weights, no instruction tuning. Completes text; does not answer questions."],
        ["Instruct model", "Base + post-training. Follows instructions, has a chat template, knows when to stop."],
        ["SFT", "Supervised fine-tuning. Train on (prompt, ideal completion) pairs. Teaches format and task shape."],
        ["PEFT", "Parameter-efficient fine-tuning. Train a small number of added parameters, freeze the rest."],
        ["LoRA", "The dominant PEFT method. Learns two small matrices whose product approximates the weight update."],
        ["QLoRA", "LoRA on top of a 4-bit quantized frozen base. ~20× memory reduction vs full fine-tuning."],
        ["Adapter", "The trained LoRA weights, stored separately. Tens of MB, hot-swappable at serve time."],
        ["Preference optimization", "Training on comparisons (A is better than B) rather than on a single target."],
        ["DPO", "Direct Preference Optimization. Preference learning with no reward model and no rollouts."],
        ["Reward model", "A model trained to score outputs. Needed for PPO; DPO removes the need for it."],
        ["RLVR", "RL with Verifiable Rewards. The reward comes from a program (tests, checker), not a model."],
        ["GRPO", "Group Relative Policy Optimization. Scores a group of rollouts against each other; no value model."],
      ],
      [2.6, 9.6], { size: 11, rowH: 0.375 });
    T.num(s);
  }

  /* ---- Vocabulary 2 ---- */
  {
    const s = T.slide("Orientation", "Vocabulary, part 2");
    T.table(s, 1.4,
      ["Term", "What it means in practice"],
      [
        ["Rollout", "One generated sample from the policy during RL. You will read thousands of these."],
        ["Policy", "The model being trained, in RL terminology."],
        ["Reference model", "A frozen copy of the starting model. KL divergence from it is penalized to prevent drift."],
        ["KL penalty", "The leash. Stops the policy wandering into gibberish that happens to score well."],
        ["pass@k", "Probability at least one of k sampled solutions passes the tests. The core code metric."],
        ["Contamination", "Eval problems present in training data. Inflates scores without improving the model."],
        ["Decontamination", "Removing them. Must be re-run on every data change, not once."],
        ["Loss masking", "Computing loss only on completion tokens, not prompt tokens. The classic silent bug."],
        ["Chat template", "The exact token format wrapping turns. Mismatch between train and eval silently destroys scores."],
        ["Catastrophic forgetting", "Gaining the new task while losing general ability. Measure it or it happens invisibly."],
        ["Reward hacking", "Model satisfies the reward function without doing the task. Guaranteed, not hypothetical."],
        ["Distillation", "Training a small student on a large teacher's outputs. Your two machines make this free."],
        ["Merging", "Averaging several fine-tuned checkpoints into one. Costs no GPU time, often free gains."],
        ["Quantization", "Storing weights at lower precision. 4-bit is the practical floor for quality."],
      ],
      [2.6, 9.6], { size: 11, rowH: 0.355 });
    T.num(s);
  }

  /* ---- Machines ---- */
  {
    const s = T.slide("Orientation", "Two machines, and their distinct jobs");
    const machines = [
      ["THE CLASSROOM", "Asus TUF A17 · Ubuntu 26.04 · RTX 3050 4GB", C.amber,
        ["CUDA — the real industry stack runs here",
         "bitsandbytes, Unsloth, TRL, PEFT, Flash Attention 2",
         "Linux keeps ~3.95 of the 4GB free — no compositor tax",
         "0.5B QLoRA comfortably; 1.5B workable with Unsloth",
         "512GB root + 1TB /data · 16GB RAM is the real ceiling"]],
      ["THE WORKSHOP", "MacBook Pro · M5 Pro · 48GB unified · 3TB", C.moss,
        ["Data pipeline, eval harness, sandbox — CPU/RAM bound",
         "14B–30B quantized inference: the teacher model",
         "MLX for local training and serving",
         "No CUDA: no bitsandbytes, Unsloth, vLLM, or DeepSpeed",
         "48GB unified runs teachers most single GPUs cannot"]],
    ];
    let x = 0.55;
    machines.forEach(([tag, name, col, items]) => {
      T.card(s, x, 1.42, 6.0, 3.0, C.white);
      s.addText(tag, { x: x + 0.3, y: 1.62, w: 5.4, h: 0.26, fontFace: BODY, fontSize: 10.5, bold: true, color: col, charSpacing: 2, margin: 0 });
      s.addText(name, { x: x + 0.3, y: 1.9, w: 5.4, h: 0.32, fontFace: HEAD, fontSize: 15, bold: true, color: C.ink, margin: 0 });
      T.bullets(s, items, { x: x + 0.3, y: 2.3, w: 5.4, h: 2.0, size: 11 });
      x += 6.4;
    });
    T.banner(s, 4.6, "Neither machine can do the whole job. Together they cover all of it.", C.forest);
    T.grid(s, 5.4, [
      ["Rule 1", "The Mac owns data. 16GB will not hold a deduplication index.", C.moss],
      ["Rule 2", "The Asus owns training. It is the only CUDA you have.", C.amber],
      ["Rule 3", "Prototype at 0.5B before anything else. Always.", C.moss],
    ], { cols: 3, h: 1.05 });
    T.num(s);
  }

  /* ---- Distillation rig ---- */
  {
    const s = T.slide("Orientation", "Your two machines are already a distillation rig");
    T.pipeline(s, 1.45, [
      ["TEACHER (Mac)", "Qwen2.5-Coder-14B quantized generates N candidate solutions per problem.", C.moss],
      ["VERIFIER (Mac)", "Sandbox executes every candidate against real tests. Keeps only what passes.", C.amber],
      ["STUDENT (Asus)", "0.5B model trains via QLoRA on the verified survivors.", C.moss],
      ["MEASURE (Mac)", "Eval harness scores the student on held-out problems.", C.forest2],
    ], { h: 1.7 });

    T.banner(s, 3.42, "This is verified distillation. It costs nothing but electricity and it is the core loop of the whole project.", C.moss);

    s.addText(
      "The teacher never needs to be trained. It only needs to be smart enough to occasionally produce a correct solution — " +
      "and the verifier guarantees you only learn from the correct ones. That guarantee is what makes this work with a weak teacher " +
      "and a tiny student.",
      { x: 0.55, y: 4.28, w: 12.2, h: 0.85, fontFace: BODY, fontSize: 13, color: C.ink, margin: 0, valign: "top" }
    );

    T.grid(s, 5.25, [
      ["Why it beats plain SFT", "Every training example is known-correct, not merely plausible. No noisy labels at all.", C.moss],
      ["Why it beats the teacher", "The student learns the teacher's successes without its failures — the filter is the whole trick.", C.moss],
      ["Why it costs nothing", "Both machines are yours. Generation is the expensive part, and it runs on the Mac overnight.", C.moss],
    ], { cols: 3, h: 1.15 });
    T.num(s);
  }

  /* ---- Why 0.5B ---- */
  {
    const s = T.slide("Orientation", "Why 0.5B is the right size to learn on");
    T.steps(s, 1.42, [
      ["Every failure mode still appears", "Reward hacking, memorization, verbosity bias, contamination, policy collapse — all of them show up at 0.5B. Scale changes the absolute numbers, not the lessons. You are not learning a watered-down version."],
      ["Twenty experiments a day, not three", "Experiments per week is the single variable that determines how fast you get good at this. A ten-minute training run teaches more than a six-hour one, because you run thirty of them."],
      ["Nothing is hidden by raw capability", "A large model papers over bad data with brute ability. A small model fails loudly and specifically — which is exactly what you want while you are learning to read failures."],
      ["Zero cost anxiety", "You will make mistakes. Making them for free means making more of them, faster, which is the entire point of a learning phase."],
      ["It is a real deliverable", "A good 0.5B code model runs on a phone. That is a genuinely useful artifact, not a toy — and nobody else is building it."],
    ], { h: 1.0 });
    T.num(s);
  }

  /* ---- Curriculum at a glance ---- */
  {
    const s = T.slide("Orientation", "The complete curriculum, in build order");
    T.table(s, 1.4,
      ["#", "Phase", "Machine", "What you build", "Done when"],
      [
        ["1", "Setup", "Both", "Working environments, W&B, disk layout", "Smoke tests pass on both machines"],
        ["2", "Model", "Mac", "Base model chosen, template verified", "Model generates sane output from your template"],
        ["3", "Sandbox", "Mac", "Untrusted-code executor + adversarial suite", "Survives infinite loop, fork bomb, network, escape"],
        ["4", "Eval", "Mac", "pass@k harness, baselines, held-out split", "Reproducible score ± std, three seeds"],
        ["5", "Data", "Mac", "Curated, deduped, decontaminated corpus", "Curated-10k beats raw-100k at equal compute"],
        ["6", "SFT", "Asus", "First fine-tuned model", "Beats baseline across three seeds"],
        ["7", "RFT", "Both", "Rejection-sampled self-improvement", "Beats SFT; you can explain why without RL"],
        ["8", "DPO", "Asus", "Preference-optimized model", "Beats RFT; length tracked before/after"],
        ["9", "GRPO", "Asus", "RL with verifiable rewards", "Beats DPO AND two documented hacks with fixes"],
        ["10", "Repair", "Both", "Self-repair from tracebacks", "First-attempt and after-repair reported separately"],
        ["11", "Merge", "Mac", "Merged checkpoint", "Merged beats every individual checkpoint"],
        ["12", "Serve", "Both", "Quantized, on-device model", "Runs in your editor, offline"],
      ],
      [0.5, 1.5, 1.1, 4.5, 4.6], { size: 10.5, rowH: 0.355 });
    T.num(s);
  }

  /* ---- Prerequisites ---- */
  {
    const s = T.slide("Orientation", "Prerequisites — be honest with yourself here");
    T.compare(s, 1.42, 2.5,
      { title: "YOU NEED THESE", items: [
        "Python: comfortable with classes, generators, context managers",
        "PyTorch: tensors, autograd, what .backward() does",
        "The transformer block, at least conceptually",
        "Git, virtualenv/conda, the shell",
        "Willingness to read tracebacks instead of guessing",
      ]},
      { title: "YOU DO NOT NEED THESE", items: [
        "CUDA kernel programming",
        "Distributed training theory",
        "The math of attention derived from scratch",
        "A GPU cluster, or any rented compute",
        "Prior ML research experience",
      ]}
    );
    s.addText(
      "If PyTorch autograd is genuinely unfamiliar, spend three days on it first. Everything downstream assumes you can read " +
      "a training loop and know what a gradient is. Nothing else on the left-hand list takes more than a weekend to reach 'comfortable'.",
      { x: 0.55, y: 4.15, w: 12.2, h: 0.8, fontFace: BODY, fontSize: 12.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.fieldNote(s, 0.55, 5.1, 12.2, 1.1,
      "I started this without really understanding gradient accumulation and lost a week to a bug where my effective batch size " +
      "was 1 instead of 16. The concepts on the left are not optional background — they are the debugging vocabulary.");
    T.num(s);
  }

  /* ---- Repo structure ---- */
  {
    const s = T.slide("Orientation", "Repository structure");
    T.codeBlock(s, 0.55, 1.4, 6.6, 4.6, [
      { t: "ULTRON/", b: true, c: C.moss },
      "├── data/",
      "│   ├── raw/          downloaded, never modified",
      "│   ├── interim/      filtered, deduped, decontam.",
      "│   └── processed/    templated, versioned v1..vN",
      "├── src/",
      "│   ├── sandbox/      executor.py  ← trust boundary",
      "│   ├── data/         download filter dedup synth",
      "│   ├── eval/         harness.py  pass_at_k.py",
      "│   ├── train/        sft rft dpo grpo repair",
      "│   └── serve/        mlx / llama.cpp entrypoints",
      "├── configs/          ONE YAML PER EXPERIMENT",
      "├── results/          NN-phase.md  numbers + seeds",
      "├── checkpoints/      adapters only, not full models",
      "└── notebooks/        scratch only, never canonical",
    ], "LAYOUT");

    T.grid(s, 1.4, [
      ["data/ is append-only", "raw/ is never edited. Every transformation writes a new directory. Disk is cheap; a lost provenance chain is not.", C.moss],
      ["configs/ IS the lab notebook", "If an experiment is not a committed config file, it did not happen and cannot be reproduced.", C.moss],
      ["results/ is written by hand", "One markdown file per phase, with numbers, seeds, and what failed. Your future self reads only this.", C.moss],
      ["checkpoints/ holds adapters", "LoRA adapters are tens of MB. Never commit merged full models — regenerate from adapter + base.", C.moss],
    ], { cols: 1, x: 7.3, w: 5.45, h: 1.09, gapY: 0.12 });
    T.fieldNote(s, 0.55, 6.2, 12.2, 0.85,
      "Two directories carry the whole project: configs/ tells you what you ran, results/ tells you what happened. Everything else is regenerable.");
    T.num(s);
  }

  /* ---- Config discipline ---- */
  {
    const s = T.slide("Orientation", "Config-driven experiments, from day one");
    s.addText(
      "The single habit that separates people who learn this quickly from people who spin: every run is defined by a committed " +
      "config file, and every result names the config that produced it. No exceptions, no 'quick manual test'.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.75, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.codeBlock(s, 0.55, 2.25, 6.35, 3.3, [
      { t: "# configs/06-sft-r16-lr2e4.yaml", c: C.moss },
      "base_model: Qwen/Qwen2.5-Coder-0.5B",
      "data_version: v3-curated-10k",
      "template: qwen-chatml-v1",
      "",
      "lora:",
      "  r: 16",
      "  alpha: 32",
      "  dropout: 0.05",
      "  target: all-linear",
      "",
      "train:",
      "  lr: 2.0e-4",
      "  epochs: 2",
      "  seq_len: 512",
      "  batch: 1",
      "  grad_accum: 16",
      "  seed: [0, 1, 2]",
    ]);
    T.grid(s, 2.25, [
      ["Every field matters", "data_version and template are as load-bearing as the learning rate. A run that does not record them is not reproducible.", C.ink],
      ["Seeds are a list", "Three seeds is the minimum honest experiment. Bake it into the config so you cannot forget.", C.ink],
      ["Name files by what changed", "06-sft-r16-lr2e4 names the phase and the variable. You will have two hundred of these.", C.ink],
      ["Commit before running", "A config committed after the fact is a reconstruction, not a record.", C.ink],
    ], { cols: 1, x: 7.3, w: 5.45, h: 0.76, gapY: 0.11 });
    T.fieldNote(s, 0.55, 5.75, 12.2, 1.2,
      "Three weeks in I had a checkpoint that scored better than anything since, and no idea what produced it. " +
      "I never reproduced it. Every config has been committed before the run ever since — that one lost result cost me more than the discipline ever has.");
    T.num(s);
  }
};
