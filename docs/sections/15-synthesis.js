/* PART XV — SYNTHESIS */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  {
    const s = T.darkSlide();
    s.addText("THE JUNGLE, SUMMARIZED", {
      x: 0.85, y: 2.4, w: 11.6, h: 0.34,
      fontFace: BODY, fontSize: 12.5, bold: true, color: C.moss, charSpacing: 5, margin: 0 });
    s.addText("Indexes and Laws", {
      x: 0.85, y: 2.8, w: 11.6, h: 0.9, fontFace: HEAD, fontSize: 40, bold: true, color: C.white, margin: 0 });
    s.addText("Everything from here on is reference. Read the deck once front to back;\nlive in these last pages afterwards.", {
      x: 0.85, y: 3.75, w: 11.0, h: 0.9, fontFace: BODY, fontSize: 15.5, italic: true, color: C.lightMoss, margin: 0, valign: "top" });
    T.num(s);
  }

  /* ---- Diversions ---- */
  {
    const s = T.slide("Synthesis", "The Diversions Index — what looks essential and is not");
    const divs = [
      ["Chasing benchmark SOTA", "You are learning a craft, not competing. A model that taught you five failure modes beat one that scored two points higher and taught you nothing."],
      ["Full fine-tuning", "LoRA teaches identical concepts at 1/20th the memory. Full FT is a resource decision, not a knowledge one."],
      ["Implementing PPO from scratch", "Superseded by DPO and GRPO for practitioners. Read the paper; do not spend a month on the implementation."],
      ["Writing your own trainer", "TRL covers every method in this deck. Time on training infrastructure is time not spent on data and rewards."],
      ["Reading papers instead of running experiments", "The failure modes in this deck are not in the papers. They are in your rollout logs."],
      ["Scaling up too early", "Every problem you have at 7B, you also had at 0.5B — where it cost nothing to find."],
      ["Hyperparameter sweeps on dirty data", "You will find the settings that best memorize noise. Fix the data first; the answers change."],
      ["Building a custom eval framework", "Wrap evalplus. Your custom set matters; your custom framework does not."],
      ["Perfect data filtering", "Ship at 90% clean. The last 10% costs more than the phase after it is worth."],
      ["Long-context / repo-level work", "A genuinely different discipline. Deliberately out of scope until everything else works."],
      ["Multi-GPU and distributed training", "You have one GPU. The concepts transfer; the plumbing does not. Skip it."],
      ["Waiting until you 'understand the math'", "You will understand DPO's derivation faster after running it than before."],
    ];
    const CW = 3.96, GX = 0.16, RH = 1.32, GY = 0.14;
    divs.forEach(([h, d], i) => {
      const x = 0.55 + (i % 3) * (CW + GX);
      const y = 1.38 + Math.floor(i / 3) * (RH + GY);
      T.card(s, x, y, CW, RH, C.white);
      s.addText("X", { x: x + 0.22, y: y + 0.14, w: 0.3, h: 0.28, fontFace: BODY, fontSize: 13, bold: true, color: C.rust, margin: 0 });
      s.addText(h, { x: x + 0.56, y: y + 0.13, w: 3.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.ink, margin: 0 });
      s.addText(d, { x: x + 0.24, y: y + 0.46, w: 3.5, h: 0.78, fontFace: BODY, fontSize: 10, color: C.muted, margin: 0, valign: "top" });
    });
    T.num(s);
  }

  /* ---- TRAP INDEX 1 ---- */
  {
    const s = T.slide("Synthesis", "The Trap Index  ·  1 of 3", "Setup through Data");
    T.table(s, 1.62,
      ["Phase", "Trap", "The tell", "The fix"],
      [
        ["Setup", "CPU-only torch installed", "cuda.is_available() False", "Reinstall with the cuXXX index URL"],
        ["Setup", "HF cache in home directory", "Disk fills in a week", "Set HF_HOME on day one"],
        ["Setup", "bitsandbytes broken", "Fails at training, not install", "Run python -m bitsandbytes"],
        ["Model", "Chat template guessed", "Fine-tune scores below base", "apply_chat_template; print repr()"],
        ["Model", "Wrong EOS token", "Generation never terminates", "Decode a training example end to end"],
        ["Model", "seq_len guessed", "Silent truncation of 20%+", "Measure your data's p95"],
        ["Sandbox", "No timeout", "Run hangs at a random step", "Wall-clock AND CPU limits, both"],
        ["Sandbox", "Kills process, not group", "Orphans accumulate overnight", "os.setsid() + os.killpg()"],
        ["Sandbox", "Test file readable from cwd", "Model reads it in Phase 9", "Tests outside cwd; flag file reads"],
        ["Sandbox", "Env inherited", "HF/W&B tokens leak into codegen", "Explicit minimal env allowlist"],
        ["Eval", "Single seed", "Gains appear then vanish", "Three seeds, report mean ± std"],
        ["Eval", "Naive pass@k", "Biased, high variance", "Unbiased combinatorial estimator"],
        ["Eval", "First code block extracted", "Points vanish inexplicably", "Take the LAST complete block"],
        ["Data", "Dedup before decontamination", "Contamination hidden by removal", "Decontaminate FIRST, always"],
        ["Data", "Split before dedup", "Val tracks train suspiciously well", "Dedup, then split"],
        ["Data", "Mixture computed in records", "'80/20' behaves like 100/0", "Compute the ratio in tokens"],
      ],
      [1.15, 3.0, 3.6, 4.45], { size: 9.5, rowH: 0.295 });
    T.num(s);
  }

  /* ---- TRAP INDEX 2 ---- */
  {
    const s = T.slide("Synthesis", "The Trap Index  ·  2 of 3", "SFT through GRPO");
    T.table(s, 1.62,
      ["Phase", "Trap", "The tell", "The fix"],
      [
        ["SFT", "Full-FT learning rate on LoRA", "Barely moves off baseline", "LoRA wants ~10x higher: 2e-4"],
        ["SFT", "Loss over prompt tokens", "Loss falls, behavior degrades", "Decode a batch, inspect labels"],
        ["SFT", "response_template mismatch", "Masking silently disabled", "Match the template byte for byte"],
        ["SFT", "Rank raised, alpha fixed", "'Rank has no effect'", "Set alpha = 2r and re-sweep"],
        ["SFT", "target_modules typo", "0% trainable, run looks normal", "print_trainable_parameters()"],
        ["SFT", "Checkpoint on best loss", "Ships the most memorized model", "Checkpoint on eval_pass_at_1"],
        ["SFT", "Accumulation silently ignored", "Noisy loss, poor results", "Log the optimizer step count"],
        ["SFT", "fp16 on an Ampere card", "NaN on step 1", "Use bf16"],
        ["RFT", "Temperature 0", "N identical samples", "0.8–1.0; diversity is the point"],
        ["RFT", "No per-problem cap", "One problem gives 50 examples", "Keep k=2–4 per problem"],
        ["RFT", "Difficulty collapse", "Round 2 shows no gain", "Stratify the keep-set by difficulty"],
        ["DPO", "SFT learning rate", "Model destroyed in ~50 steps", "5e-6, not 2e-4"],
        ["DPO", "Multiple epochs", "Peak at step 80 of 400", "One epoch; evaluate every 50 steps"],
        ["DPO", "Cross-problem pairs", "Learns ranking, not quality", "Pair within a single prompt"],
        ["DPO", "Length unlogged", "Output doubles unnoticed", "Log mean output length always"],
        ["GRPO", "Binary reward", "Reward flat for hours", "Fraction of tests passed"],
        ["GRPO", "Dead groups", "'Converged' but nothing learned", "Filter to pass-rate 0.2–0.8"],
        ["GRPO", "KL beta = 0", "Drifts into gibberish", "beta ~0.04; log KL"],
      ],
      [1.15, 3.0, 3.6, 4.45], { size: 9.5, rowH: 0.275 });
    T.num(s);
  }

  /* ---- TRAP INDEX 3 ---- */
  {
    const s = T.slide("Synthesis", "The Trap Index  ·  3 of 3", "Repair through Serving, plus the cross-cutting ones");
    T.table(s, 1.62,
      ["Phase", "Trap", "The tell", "The fix"],
      [
        ["GRPO", "Penalty scored but not enforced", "Model learns evasion, not avoidance", "Sandbox must actually block it"],
        ["GRPO", "Reward tuned on held-out", "Excellent held-out score", "Tune on dev; seal the test set"],
        ["GRPO", "Trusting the reward curve", "Reward up, capability down", "Plot pass@1 on the same axis"],
        ["Repair", "Reward final attempt only", "First-attempt quality declines", "Weight first attempt 0.7 / repair 0.3"],
        ["Repair", "Single merged metric", "Hides first-attempt regression", "Report both numbers separately"],
        ["Repair", "Fix included in feedback", "Learns copying, not repair", "Report what broke, never the fix"],
        ["Repair", "Full untruncated tracebacks", "Context consumed by stack frames", "Exception, message, failing values"],
        ["Merge", "Different base models", "Output is garbage", "Merging requires a common ancestor"],
        ["Merge", "Merge not evaluated", "Silently worse than components", "Same three-seed protocol"],
        ["Merge", "Methods swept, weights not", "Marginal gains only", "The mixing ratio matters more"],
        ["Serve", "Generic quantization curve", "Quality drops unexpectedly", "Measure on YOUR eval"],
        ["Serve", "Below 4-bit on a small model", "Sharp quality cliff", "Q4_K_M is the practical floor"],
        ["Serve", "Eval the checkpoint, ship the quant", "Two points vanish at launch", "Evaluate through the served endpoint"],
        ["Serve", "Stop tokens wrong at serve time", "Endless generation returns", "Verify the serving config's template"],
        ["Ops", "Partial seeding", "Irreproducible, but looks seeded", "Seed python, numpy, torch, cuda, loader"],
        ["Ops", "Config written after the run", "Result cannot be regenerated", "Commit the config BEFORE running"],
        ["Ops", "grad_norm not logged", "Divergence arrives with no warning", "Log it every step, every phase"],
      ],
      [1.15, 3.0, 3.6, 4.45], { size: 9.5, rowH: 0.29 });
    T.num(s);
  }

  /* ---- FP INDEX 1 ---- */
  {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    s.addText("THE FALSE POSITIVE INDEX  ·  1 of 2", {
      x: 0.55, y: 0.4, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.rust, charSpacing: 3, margin: 0 });
    s.addText("Numbers that go UP while the model gets worse", {
      x: 0.55, y: 0.75, w: 12.2, h: 0.55, fontFace: HEAD, fontSize: 29, bold: true, color: C.white, margin: 0 });
    s.addText("These do not fail. They succeed, incorrectly, and you believe them. This is the most expensive page in the deck.", {
      x: 0.55, y: 1.32, w: 12.2, h: 0.32, fontFace: BODY, fontSize: 12, italic: true, color: C.lightMoss, margin: 0 });

    const rows = [
      ["Contamination", "Eval problems sit in your training data", "Strong HumanEval, weak LiveCodeBench", "Timestamped benchmark; n-gram + name + docstring check"],
      ["Template drift", "You changed the prompt, not the model", "Multi-point jump with no weight change", "Diff the rendered prompt strings between runs"],
      ["Seed noise", "One-seed variance read as signal", "Gains of 1–3 points appear and vanish", "Three seeds; report mean ± std"],
      ["Weak-test inflation", "Wrong solutions pass shallow tests", "High base HumanEval, poor real use", "Use the + variants; test with known-bad code"],
      ["Memorization", "Model memorized the training set", "Train loss beautiful, eval flat", "Checkpoint on eval; verify dedup"],
      ["Leaked near-duplicates", "You split before deduplicating", "Val tracks train almost perfectly", "Dedup first; check cross-split overlap"],
      ["Diversity as skill", "More variety, no more capability", "pass@10 rises, pass@1 flat", "Always report both k values"],
      ["Checkpoint cherry-pick", "Overfit to the validation set", "Best-of-20 checkpoints looks great", "Select on val, report on sealed test"],
    ];
    let y = 1.78;
    rows.forEach(([name, cause, tell, check]) => {
      s.addShape(pres.ShapeType.roundRect, { x: 0.55, y: y, w: 12.2, h: 0.62, fill: { color: C.forest }, rectRadius: 0.05 });
      s.addText(name, { x: 0.8, y: y + 0.05, w: 2.5, h: 0.24, fontFace: BODY, fontSize: 11.5, bold: true, color: C.amber, margin: 0 });
      s.addText(cause, { x: 0.8, y: y + 0.3, w: 2.6, h: 0.26, fontFace: BODY, fontSize: 8.5, color: "8FA396", margin: 0, valign: "top" });
      s.addText("TELL   " + tell, { x: 3.55, y: y + 0.17, w: 4.4, h: 0.3, fontFace: BODY, fontSize: 10, color: C.lightMoss, margin: 0, valign: "middle" });
      s.addText("CHECK   " + check, { x: 8.1, y: y + 0.17, w: 4.5, h: 0.3, fontFace: BODY, fontSize: 10, bold: true, color: C.moss, margin: 0, valign: "middle" });
      y += 0.685;
    });
    T.num(s);
  }

  /* ---- FP INDEX 2 ---- */
  {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    s.addText("THE FALSE POSITIVE INDEX  ·  2 of 2", {
      x: 0.55, y: 0.4, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.rust, charSpacing: 3, margin: 0 });
    s.addText("The training-phase deceptions", {
      x: 0.55, y: 0.75, w: 12.2, h: 0.55, fontFace: HEAD, fontSize: 29, bold: true, color: C.white, margin: 0 });

    const rows = [
      ["Nothing was trained", "target_modules typo — 0% trainable", "Small loss decrease, model unchanged", "print_trainable_parameters()"],
      ["Effective batch of 1", "Accumulation config silently ignored", "Noisy loss, poor results, no error", "Log the optimizer step count"],
      ["Masking silently off", "response_template mismatch", "Loss normal, behavior degrades", "Decode a batch, inspect labels"],
      ["Filter removed difficulty", "You filtered hardness, not noise", "Score rises after filtering", "Difficulty histogram before/after"],
      ["Duplicate inflation", "Near-identical passers counted twice", "'50k examples' from 3k problems", "Dedup survivors, then recount"],
      ["Verbosity bias", "Model learned longer looks better", "Judge score up, pass@1 flat", "Log mean output length every run"],
      ["Judge-verifier divergence", "You optimized for the judge", "Judge loves it, tests disagree", "Verifier is truth; judge is advisory"],
      ["Reward hacking", "Model found a shortcut", "Reward climbing, held-out falling", "Read rollouts; plot both on one axis"],
      ["Dead-group illusion", "Zero variance means zero gradient", "Reward stable, 'converged'", "Log fraction of groups with std = 0"],
      ["Synthetic self-agreement", "Teacher grades its own output", "Teacher-rated quality is excellent", "Grade with execution, not the generator"],
      ["Recovery illusion", "Degenerate high-reward mode found", "Reward recovers after a collapse", "Check output diversity; read samples"],
      ["Baseline sandbagging", "Your baseline used a worse prompt", "Huge gain over baseline", "Baseline gets the same template and effort"],
    ];
    s.addText("CAUSE", { x: 3.45, y: 1.32, w: 3.2, h: 0.2, fontFace: BODY, fontSize: 7.5, bold: true, color: C.forest2, charSpacing: 1.5, margin: 0 });
    s.addText("TELL", { x: 6.75, y: 1.32, w: 3.0, h: 0.2, fontFace: BODY, fontSize: 7.5, bold: true, color: C.forest2, charSpacing: 1.5, margin: 0 });
    s.addText("CHECK", { x: 9.85, y: 1.32, w: 2.75, h: 0.2, fontFace: BODY, fontSize: 7.5, bold: true, color: C.forest2, charSpacing: 1.5, margin: 0 });
    let y = 1.56;
    rows.forEach(([name, cause, tell, check]) => {
      s.addShape(pres.ShapeType.roundRect, { x: 0.55, y: y, w: 12.2, h: 0.42, fill: { color: C.forest }, rectRadius: 0.05 });
      s.addText(name, { x: 0.8, y: y + 0.07, w: 2.6, h: 0.28, fontFace: BODY, fontSize: 10.5, bold: true, color: C.amber, margin: 0, valign: "middle" });
      s.addText(cause, { x: 3.45, y: y + 0.07, w: 3.2, h: 0.28, fontFace: BODY, fontSize: 8.5, color: "8FA396", margin: 0, valign: "middle" });
      s.addText(tell, { x: 6.75, y: y + 0.07, w: 3.0, h: 0.28, fontFace: BODY, fontSize: 8.5, color: C.lightMoss, margin: 0, valign: "middle" });
      s.addText(check, { x: 9.85, y: y + 0.07, w: 2.75, h: 0.28, fontFace: BODY, fontSize: 8.5, bold: true, color: C.moss, margin: 0, valign: "middle" });
      y += 0.455;
    });
    s.addText("The pattern is universal: every one makes a number rise. Only held-out pass@1, on a sealed set, is not fooled.", {
      x: 0.55, y: 7.02, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 10.5, italic: true, color: C.lightMoss, margin: 0 });
    T.num(s);
  }

  /* ---- General laws ---- */
  {
    const s = T.slide("Synthesis", "The general laws — what transfers to any domain");
    const laws = [
      ["Build the ruler first", "Sandbox and eval before any gradient step. You cannot improve what you cannot measure, and you cannot measure with an instrument you have not tested."],
      ["Data beats hyperparameters", "Every time, by a wide margin. If you are tuning learning rates before you have deduplicated, you are optimizing the wrong variable."],
      ["The metric is not the goal", "Loss proxies capability. Reward proxies capability. Both diverge from it under optimization pressure — and optimization pressure is exactly what you are applying."],
      ["Read your samples", "Every failure mode in this deck is invisible in aggregate metrics and obvious in twenty rollouts. Make samples easy to look at, then look at them."],
      ["Small and fast wins", "Experiments per week determines how fast you learn. Optimize for loop speed over model size until the loop is boring."],
      ["Verifiable rewards changed everything", "Wherever an answer can be checked mechanically, you can train on it. Finding that verifier is the real design work in any new domain."],
      ["Every reward term is an attack surface", "The model will find what you actually rewarded, not what you meant. Assume it, and build the detection before the run."],
      ["Three seeds or it did not happen", "Most reported improvements are noise. This one habit eliminates more wasted work than any other."],
      ["Order is not negotiable", "Decontaminate before dedup. Dedup before split. Eval before train. Data before hyperparameters. Getting the order wrong invalidates results silently."],
    ];
    let y = 1.4;
    laws.forEach(([h, d], i) => {
      s.addText(`${i + 1}.`, { x: 0.55, y: y, w: 0.45, h: 0.3, fontFace: HEAD, fontSize: 15, bold: true, color: C.moss, margin: 0 });
      s.addText(h, { x: 1.05, y: y, w: 3.8, h: 0.3, fontFace: HEAD, fontSize: 13.5, bold: true, color: C.ink, margin: 0 });
      s.addText(d, { x: 5.0, y: y - 0.02, w: 7.75, h: 0.62, fontFace: BODY, fontSize: 11, color: C.muted, margin: 0, valign: "top" });
      y += 0.6;
    });
    T.num(s);
  }

  /* ---- Schedule ---- */
  {
    const s = T.slide("Synthesis", "A twelve-week schedule", "Assumes evenings and weekends, not full time. Compress freely if you have more hours.");
    T.table(s, 1.62,
      ["Week", "Phase", "Deliverable", "Gate"],
      [
        ["1", "Setup + Model", "Both environments working; base model loads and generates", "All smoke tests pass"],
        ["2", "Sandbox", "executor.py + adversarial suite", "Survives all 12 adversarial tests"],
        ["3", "Eval", "harness.py + baseline table", "Reproducible pass@1 ± std, 3 seeds"],
        ["4–5", "Data", "Curated, deduped, decontaminated v1", "Curated-10k beats raw-100k"],
        ["6", "SFT", "First fine-tuned adapter", "Beats baseline across 3 seeds"],
        ["7", "SFT ablations", "Rank, LR, epochs, mixture swept", "You can explain each result"],
        ["8", "RFT", "Rejection-sampled dataset + model", "Beats SFT; difficulty distribution healthy"],
        ["9", "DPO", "Preference-optimized model", "Beats RFT; output length tracked"],
        ["10–11", "GRPO", "RLVR model + reward-hack log", "Two documented hacks with fixes"],
        ["12", "Repair + Merge + Serve", "Quantized on-device model", "Runs in your editor; sealed test opened once"],
      ],
      [1.0, 2.6, 5.0, 3.6], { size: 10.5, rowH: 0.42 });
    T.banner(s, 6.05, "If a week slips, cut ablations — never cut the eval harness or the data phase. Those two carry everything else.", C.amber);
    T.num(s);
  }

  /* ---- Tomorrow ---- */
  {
    const s = T.slide("Synthesis", "What to do first tomorrow");
    T.steps(s, 1.4, [
      ["Create the repo and the directory structure", "Twenty minutes. data/ src/ configs/ results/ checkpoints/. Commit the empty structure so the shape exists before the content."],
      ["Set HF_HOME before you download anything", "One line in your shell profile. This is the single cheapest mistake to avoid and it is unfixable in hindsight without re-downloading everything."],
      ["Get both environments to pass their smoke tests", "torch.cuda.is_available() on the Asus, MLX generating on the Mac. Do not proceed until both are green."],
      ["Write executor.py and its adversarial test suite", "Before any model code. This is the trust boundary and it becomes your reward function. It is the most reused file in the project."],
      ["Write harness.py and produce results/00-baseline.md", "One command, one number, three seeds. Everything after this is 'better than that'."],
      ["Only then download a training dataset", "In that order. The temptation is to start with the model — resist it. Everything you build before the model makes the model work."],
    ], { h: 0.87, bottom: 6.38 });
    T.banner(s, 6.5, "Notice that nothing on this list trains a model. That is the point.", C.moss);
    T.num(s);
  }

  /* ---- Further reading ---- */
  {
    const s = T.slide("Synthesis", "Further reading, ranked by usefulness to you");
    T.table(s, 1.4,
      ["Priority", "What", "Why"],
      [
        ["Read first", "TRL documentation — SFTTrainer, DPOTrainer, GRPOTrainer", "You will use these daily. The docs are better than most tutorials."],
        ["Read first", "QLoRA paper (Dettmers et al.)", "NF4, double quantization, paged optimizers. Directly explains why your 4GB card works."],
        ["Read first", "Unsloth documentation and notebooks", "Practical, current, and tuned for exactly your constraints."],
        ["Read early", "DPO paper (Rafailov et al.)", "The derivation is worth understanding once. Read it AFTER running DPO, not before."],
        ["Read early", "DeepSeekMath (GRPO) and DeepSeek-R1", "GRPO's origin and the clearest demonstration of RLVR at scale."],
        ["Read early", "EvalPlus paper", "Why weak tests inflate scores. Changes how you think about verification."],
        ["Read when relevant", "LoRA paper (Hu et al.)", "The original. Short, readable, and the intuition still holds."],
        ["Read when relevant", "Magicoder / OSS-Instruct", "The synthetic data recipe you will actually use."],
        ["Read when relevant", "TIES / DARE merging papers", "Short. Read them the day you start Phase 11."],
        ["Read when relevant", "STaR (self-taught reasoner)", "The formal framing of the RFT loop you built in Phase 7."],
        ["Skip for now", "PPO / InstructGPT", "Historically essential, practically superseded. Understand the shape, skip the implementation."],
        ["Skip for now", "Anything about training at scale", "Different discipline. Nothing transfers to a single 4GB card."],
      ],
      [2.3, 5.0, 4.9], { size: 10, rowH: 0.375 });
    T.fieldNote(s, 0.55, 6.0, 12.2, 0.95,
      "The ordering matters more than the list. Papers read before you have the corresponding problem are entertainment; the same paper read the day you hit the problem is a solution.");
    T.num(s);
  }

  /* ---- Closing ---- */
  {
    const s = T.darkSlide();
    s.addText("The map is not the jungle.", {
      x: 0.85, y: 2.15, w: 11.6, h: 0.8, fontFace: HEAD, fontSize: 38, bold: true, color: C.white, margin: 0 });
    s.addText(
      "Everything in this guide was learned by doing it badly first. The traps are marked because I walked into them, " +
      "and the field notes are the only part that took real time to earn. Your numbers will differ from mine — " +
      "overwrite them as you go, and the deck becomes your lab notebook rather than my travelogue.",
      { x: 0.85, y: 3.1, w: 10.8, h: 1.3, fontFace: BODY, fontSize: 15, italic: true, color: C.lightMoss, margin: 0, valign: "top" }
    );
    s.addShape(pres.ShapeType.roundRect, { x: 0.85, y: 4.7, w: 11.0, h: 1.3, fill: { color: C.forest }, rectRadius: 0.07 });
    s.addText("START HERE", {
      x: 1.2, y: 4.88, w: 10.3, h: 0.28, fontFace: BODY, fontSize: 10.5, bold: true, color: C.moss, charSpacing: 2.5, margin: 0 });
    s.addText(
      "Build the sandbox. Build the eval harness. Benchmark Qwen2.5-Coder-0.5B.\nEverything after that has a number to beat.",
      { x: 1.2, y: 5.18, w: 10.3, h: 0.7, fontFace: BODY, fontSize: 14, bold: true, color: C.lightMoss, margin: 0, valign: "top" }
    );
    s.addNotes("Replace every FIELD NOTE with your own results as you run each phase. The deck is designed to become a lab notebook.");
    T.num(s);
  }
};
