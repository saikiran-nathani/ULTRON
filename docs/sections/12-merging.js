/* PART XII — MODEL SURGERY  (Phase 11) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("MERGE", "Phase 11", "Model Merging — Free Gains",
    "Two days, zero GPU-hours. The cheapest improvement available anywhere in this\ncurriculum, and the one most people skip because it sounds like a trick."));

  /* ---- Why it works ---- */
  {
    const s = T.slide("Merge", "Why averaging two models works at all");
    s.addText(
      "It sounds like it should produce noise. Averaging the weights of two different neural networks ought to give you a " +
      "third network that is worse than both. For models fine-tuned from a COMMON base, it usually does not.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.grid(s, 2.2, [
      ["The shared-basin intuition", "Fine-tunes from one base stay in the same loss basin. They are nearby points in weight space, not independent networks, so the interpolation between them is also in the basin.", C.ink],
      ["Task vectors", "Define tau = finetuned − base. This delta behaves like a semantically meaningful direction: you can add it, scale it, subtract it, and combine it with others.", C.moss],
      ["Ensembling without the cost", "A merge captures much of the benefit of ensembling several models, but produces ONE model with one model's inference cost.", C.moss],
      ["Noise cancellation", "Each fine-tune overfits to its own data in different directions. Averaging cancels a portion of the idiosyncratic noise while preserving the shared signal.", C.ink],
      ["It requires a common ancestor", "Merging models with different bases, architectures, or tokenizers does not work. Everything here assumes one base model.", C.rust],
      ["It costs no GPU time", "Merging is elementwise arithmetic on weight tensors. It runs on CPU, in seconds to minutes. There is no training involved.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.4, "This is the highest return-per-minute operation in the entire curriculum. Do it before you conclude you are finished.", C.moss);
    T.fieldNote(s, 0.55, 6.2, 12.2, 0.95,
      "TIES-merging my SFT and GRPO checkpoints gave +1.3 points over either alone, in about forty seconds of CPU time. I had nearly skipped the phase.");
    T.num(s);
  }

  /* ---- Methods table ---- */
  {
    const s = T.slide("Merge", "The methods, in increasing sophistication");
    T.table(s, 1.4,
      ["Method", "How it works", "Models", "Use when"],
      [
        ["Linear / weighted average", "Elementwise weighted mean of weights", "2+", "Baseline. Always try it first — often enough."],
        ["Task arithmetic", "base + sum(lambda_i * tau_i) where tau = ft − base", "2+", "Composing distinct skills; also for SUBTRACTING behavior"],
        ["SLERP", "Spherical interpolation — preserves vector norm", "Exactly 2", "Two checkpoints, when linear degrades quality"],
        ["TIES", "Trim small deltas → Elect sign by majority → Merge disjointly", "3+", "Several fine-tunes with conflicting updates. Strong default."],
        ["DARE", "Randomly Drop delta params, REscale survivors by 1/(1−p)", "2+", "Reduces interference; often stacked with TIES"],
        ["DARE-TIES", "DARE's sparsification followed by TIES' sign election", "3+", "The current practical default for multi-model merges"],
        ["Model soup", "Average many checkpoints from the same or similar runs", "Many", "Several seeds or hyperparameter variants of one recipe"],
      ],
      [2.6, 4.7, 1.3, 3.6], { size: 10.5, rowH: 0.42 });
    T.accentRows(s, 4.75, [
      ["Start with linear", "weights 0.5 / 0.5", "It takes two minutes and it works surprisingly often. Only escalate when it does not.", C.moss],
      ["TIES for three or more", "sign conflicts are the problem", "When several fine-tunes disagree on the SIGN of an update, naive averaging cancels both. TIES resolves it by majority vote.", C.moss],
      ["Sweep the weights", "0.3/0.7, 0.5/0.5, 0.7/0.3", "The mixing ratio matters more than the method. Sweep it — each merge costs seconds.", C.moss],
    ], { h: 0.68, labelW: 3.0 });
    T.num(s);
  }

  /* ---- Task arithmetic ---- */
  {
    const s = T.slide("Merge", "Task arithmetic — the most conceptually interesting one");
    T.codeBlock(s, 0.55, 1.4, 6.8, 3.4, [
      { t: "# A task vector is just a difference", c: C.moss },
      "tau_code   = W_code_finetune   - W_base",
      "tau_chat   = W_chat_finetune   - W_base",
      "",
      { t: "# ADD skills:", c: C.moss },
      "W_new = W_base + 0.7*tau_code + 0.3*tau_chat",
      "",
      { t: "# SUBTRACT a behavior you do not want:", c: C.amber },
      "W_new = W_base + tau_code - 0.4*tau_verbose",
      "",
      { t: "# SCALE the strength of a fine-tune:", c: C.moss },
      "W_new = W_base + 1.3*tau_code    # amplify",
      "W_new = W_base + 0.6*tau_code    # soften, recover",
      "                                 # general ability",
    ], "TASK VECTORS");
    T.grid(s, 1.4, [
      ["Scaling recovers forgetting", "If your code fine-tune destroyed general ability, merging at 0.6 gives you most of the code gain and most of the general ability back. A genuine, continuous dial.", C.moss],
      ["Subtraction actually works", "You can build a 'verbosity' task vector by fine-tuning deliberately on verbose output, then SUBTRACT it. Odd, effective, and cheap to try.", C.moss],
      ["Coefficients above 1.0 are valid", "Amplifying a task vector past the fine-tuned point sometimes helps. It also breaks things. Sweep and measure.", C.amber],
      ["LoRA adapters are already task vectors", "(alpha/r)·BA IS your tau. You can scale, add, and subtract adapters directly without ever materializing a merged model.", C.moss],
    ], { cols: 1, x: 7.55, w: 5.2, h: 0.85, gapY: 0.1 });
    T.banner(s, 4.95, "For LoRA specifically: merging adapters is arithmetic on tiny matrices. You can sweep twenty merges in a minute.", C.moss);
    T.fieldNote(s, 0.55, 5.75, 12.2, 1.2,
      "Scaling my code task vector to 0.65 recovered nearly all the general ability my model had lost, at a cost of 1.1 points " +
      "of pass@1. That is a much better trade than retraining with mixed data, and it took two minutes to find.");
    T.num(s);
  }

  /* ---- TIES / DARE ---- */
  {
    const s = T.slide("Merge", "TIES and DARE — solving interference");
    T.steps(s, 1.4, [
      ["The problem: interference", "When you merge several fine-tunes, most parameter deltas are tiny noise, and where two models disagree on the SIGN of a change, naive averaging cancels both to roughly zero. You lose both skills."],
      ["TIES step 1 — TRIM", "Keep only the top-k% of deltas by magnitude (typically k=20). The rest are set to zero. Most of a fine-tune's delta is noise, and discarding it loses almost nothing."],
      ["TIES step 2 — ELECT SIGN", "For each parameter, take a majority vote on the sign across models, weighted by magnitude. This decides the direction before any averaging happens."],
      ["TIES step 3 — DISJOINT MERGE", "Average only the deltas that agree with the elected sign. Disagreeing values are excluded rather than allowed to cancel."],
      ["DARE — the orthogonal trick", "Randomly DROP a large fraction p of delta parameters (p=0.9 is common) and RESCALE the survivors by 1/(1−p). Preserves the expected delta while drastically reducing overlap between models."],
      ["DARE-TIES — stack them", "Apply DARE's sparsification, then TIES' sign election. This combination is the current practical default for merging three or more models."],
    ], { h: 0.87 });
    T.num(s);
  }

  /* ---- mergekit ---- */
  {
    const s = T.slide("Merge", "mergekit in practice");
    T.codeBlock(s, 0.55, 1.4, 7.0, 3.6, [
      { t: "# merge-config.yaml", c: C.moss },
      "models:",
      "  - model: ./ckpt/06-sft",
      "    parameters: { weight: 0.4, density: 0.6 }",
      "  - model: ./ckpt/09-grpo",
      "    parameters: { weight: 0.4, density: 0.6 }",
      "  - model: ./ckpt/10-repair",
      "    parameters: { weight: 0.2, density: 0.5 }",
      "",
      "merge_method: dare_ties",
      "base_model: Qwen/Qwen2.5-Coder-0.5B-Instruct",
      "dtype: bfloat16",
      "parameters:",
      "  int8_mask: true",
      "",
      { t: "$ mergekit-yaml merge-config.yaml ./merged/v1 --cuda", c: C.moss },
      { t: "# runs on CPU too — no GPU required", c: C.muted },
    ], "mergekit");
    T.grid(s, 1.4, [
      ["Merge adapters or full models", "For LoRA, merge the adapters directly — far faster. mergekit also has PEFT-aware modes.", C.moss],
      ["density is DARE's keep rate", "0.5 means drop half the deltas and rescale. Lower density means less interference and more information loss.", C.ink],
      ["weight is the mixing ratio", "These need not sum to 1.0, though it is a sensible starting constraint. Sweep them.", C.ink],
      ["Evaluate EVERY merge", "A merge is a new model. It gets the same three-seed evaluation as anything else. Merges can silently be worse.", C.rust],
      ["Runs on CPU", "No GPU needed. Your Mac's 48GB makes it the natural machine for this phase.", C.moss],
    ], { cols: 1, x: 7.75, w: 5.0, h: 0.83, gapY: 0.09 });
    T.num(s);
  }

  /* ---- when it helps ---- */
  {
    const s = T.slide("Merge", "When merging helps, and when it destroys");
    T.compare(s, 1.4, 3.0,
      { title: "MERGING TENDS TO HELP", items: [
        "Checkpoints from the SAME base model",
        "Fine-tunes on related but distinct data",
        "Several seeds of one recipe (model soup)",
        "Recovering general ability lost to specialization",
        "Combining an SFT model with an RL model",
        "Adjacent checkpoints from one training run",
      ]},
      { title: "MERGING TENDS TO DESTROY", items: [
        "Different base models — will not work at all",
        "Different architectures or tokenizers",
        "Models with genuinely conflicting objectives",
        "Very unequal quality — the weak one drags",
        "Heavily-trained models far from the base",
        "Anything where you skip evaluating the result",
      ]}
    );
    T.accentRows(s, 4.65, [
      ["The sweep is the method", "20 merges, 20 minutes", "Merging is so cheap that brute-force search over methods and weights is the correct approach. Do not reason about it — measure it.", C.moss],
      ["Merges can be worse", "evaluate every one", "There is no guarantee. A merge is a hypothesis, and your eval harness is how you test it.", C.rust],
    ], { h: 0.68, labelW: 3.0 });
    T.num(s);
  }

  /* ---- traps ---- */
  {
    T.num(T.ptn("Merge", "Merging — path and traps",
      [
        "Try linear 0.5/0.5 first — it is often enough",
        "Escalate to TIES or DARE-TIES for three or more models",
        "Sweep mixing weights; each merge costs seconds",
        "Scale a single task vector (0.6–1.3) to trade specialization against general ability",
        "Merge LoRA adapters directly rather than materializing full models",
        "Evaluate every merge with the same three-seed protocol",
        "Run it on the Mac — it is CPU work and needs RAM",
      ],
      [
        "Merging models with different bases: produces garbage, not a compromise",
        "Assuming a merge is always better — it frequently is not",
        "Skipping evaluation because 'it is just an average'",
        "Merging a strong model with a much weaker one at equal weight",
        "Storing merged full models: they are a pure function of adapter + base",
        "Sweeping methods but not weights — the ratio matters more than the method",
      ],
      "Merging is the closest thing to a free lunch in this entire curriculum. Zero GPU-hours, minutes of wall clock, " +
      "and a genuine chance of a point or two. The only reason to skip it is not knowing it exists.",
      { noteH: 1.15 }));
  }
};
