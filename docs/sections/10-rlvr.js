/* PART X — RL WITH VERIFIABLE REWARDS  (Phase 9) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("GRPO", "Phase 9", "RL With Verifiable Rewards",
    "Two to three weeks. The centerpiece. Your reward function becomes the product,\nand your model becomes an adversary searching it for holes."));

  /* ---- Why RLVR ---- */
  {
    const s = T.slide("GRPO", "Why verifiable rewards changed the field");
    T.compare(s, 1.4, 2.9,
      { title: "RLHF — reward from a MODEL", items: [
        "Reward model trained on human comparisons",
        "Expensive to collect, noisy, subjective",
        "The RM is itself hackable — a known research problem",
        "Quality ceiling is the reward model's quality",
        "Needs 4 models in memory",
      ]},
      { title: "RLVR — reward from a PROGRAM", items: [
        "Reward from tests, a checker, a compiler",
        "Free, objective, unlimited, unambiguous",
        "The verifier cannot be persuaded — only circumvented",
        "Quality ceiling is your verifier's rigor",
        "GRPO needs 2 models, and fits on your card",
      ]}
    );
    T.banner(s, 4.55, "Wherever an answer can be checked mechanically, you can train on it. Finding that verifier is the real design work in any new domain.", C.moss);
    T.grid(s, 5.35, [
      ["Code is the ideal domain", "Tests give unambiguous, gradable, partial-credit signal. This is why coding models improved so fast.", C.moss],
      ["Math was the other one", "Exact answer match. Same property, same rapid progress, same methods.", C.ink],
      ["You already built the verifier", "Phase 3's sandbox IS your reward function. Everything since has been preparation for this.", C.moss],
    ], { cols: 3, h: 1.35 });
    T.num(s);
  }

  /* ---- Policy gradient intuition ---- */
  {
    const s = T.slide("GRPO", "Policy gradient, without the derivation");
    T.steps(s, 1.4, [
      ["Sample outputs from the current model", "Not from a dataset — from the model itself, right now. This is what makes it on-policy, and what makes it different from everything in Phases 6–8."],
      ["Score each output with the reward function", "Your sandbox runs the tests and returns a number. No human, no reward model, no ambiguity."],
      ["Increase the probability of high-reward outputs", "Push up the log-probability of tokens in good samples; push down the log-probability of tokens in bad ones. That is the whole gradient."],
      ["Constrain how far you move", "A KL penalty against a frozen reference stops the policy from wandering into high-reward gibberish. This leash is not optional."],
      ["Repeat, with the model that just changed", "Next step samples from the UPDATED model. The data distribution moves with the policy — the defining property of on-policy RL."],
    ], { h: 1.0, bottom: 6.33 });
    T.banner(s, 6.45, "The crucial difference from SFT: there is no fixed dataset. The model generates its own training data, every single step.", C.moss);
    T.num(s);
  }

  /* ---- PPO vs GRPO ---- */
  {
    const s = T.slide("GRPO", "PPO vs GRPO — what GRPO drops, and why it matters to you");
    T.table(s, 1.4,
      ["", "PPO", "GRPO"],
      [
        ["Models in memory", "Policy + reference + reward + VALUE", "Policy + reference"],
        ["Baseline for advantage", "Learned value function (a whole extra network)", "Mean reward of the sampled GROUP"],
        ["Extra training needed", "Value model trains alongside the policy", "None"],
        ["Memory on your 4GB card", "Impossible", "Feasible at 0.5B"],
        ["Stability failure mode", "Value function diverges, drags policy with it", "Group collapse — all samples score identically"],
        ["Implementation complexity", "High", "Moderate — TRL provides it"],
        ["Where it came from", "OpenAI, RLHF-era", "DeepSeekMath; popularized by DeepSeek-R1"],
      ],
      [3.6, 4.6, 4.0], { size: 11, rowH: 0.42 });
    T.codeBlock(s, 0.55, 4.55, 12.2, 1.75, [
      { t: "# GRPO's central trick: the group IS the baseline.", c: C.moss },
      "for each prompt:",
      "    outputs = [policy.sample(prompt) for _ in range(G)]      # G = group size, e.g. 8",
      "    rewards = [reward_fn(o) for o in outputs]",
      { t: "    advantages = (rewards - mean(rewards)) / (std(rewards) + eps)   # <- no value model", c: C.moss, b: true },
      "    # then a PPO-style clipped policy-gradient update, plus a KL term",
    ]);
    T.banner(s, 6.45, "'Better than my siblings on this prompt' replaces 'better than a learned value estimate'. That one substitution removes an entire network.", C.moss);
    T.num(s);
  }

  /* ---- group size ---- */
  {
    const s = T.slide("GRPO", "Group size — the parameter unique to GRPO");
    T.table(s, 1.4,
      ["Group size G", "Advantage estimate", "Cost per step", "Verdict"],
      [
        ["2", "Extremely noisy; std is meaningless", "Lowest", "Too small. Training will not move."],
        ["4", "Noisy but functional", "Low", "Viable on very constrained hardware"],
        ["8", "Reasonable signal", "Moderate", "The practical default on your card"],
        ["16", "Good signal, stable advantages", "High", "Better if you can afford the generation time"],
        ["32–64", "Excellent", "Very high", "Standard in published work; impractical on 4GB"],
      ],
      [2.4, 3.8, 2.4, 3.6], { size: 11, rowH: 0.44 });
    T.accentRows(s, 4.05, [
      ["Group collapse", "all rewards identical", "If every sample in a group scores the same, std is zero and the advantage is zero — no gradient at all. Happens when problems are far too easy or far too hard.", C.rust],
      ["Curate for the middle", "pass rate 0.2 – 0.8", "Feed GRPO problems your model solves SOMETIMES. Problems it always solves and problems it never solves both produce zero signal.", C.moss],
      ["Log the fraction of dead groups", "std == 0", "If 60% of your groups have zero variance, you are wasting 60% of your compute. This is the most useful GRPO diagnostic.", C.moss],
    ], { h: 0.72, labelW: 3.0 });
    T.fieldNote(s, 0.55, 6.35, 12.2, 0.85,
      "My first GRPO run had 71% dead groups because I fed it the whole problem set. Filtering to pass-rate 0.2–0.8 tripled the useful gradient per hour.");
    T.num(s);
  }

  /* ---- Reward design principles ---- */
  {
    const s = T.slide("GRPO", "Reward design — first principles");
    T.steps(s, 1.4, [
      ["Your reward function IS the task specification", "Not your intent, not your prompt, not your documentation. Whatever the reward measures is what the model will learn to maximize. Write it as if an adversary will read it, because one will."],
      ["Prefer dense over sparse", "Binary pass/fail gives almost no gradient — most samples score 0 and the group has no variance. Fraction-of-tests-passed gives the model a slope to climb."],
      ["Every term you add is a new attack surface", "A format reward invites format-only outputs. A length penalty invites truncation. Add terms deliberately and watch what each one produces."],
      ["Penalties need enforcement, not just scoring", "Penalizing a banned import in the reward while the sandbox still allows it teaches evasion. The sandbox must actually block it."],
      ["Reward the outcome you want, not the behavior you imagine", "Rewarding 'has a docstring' gets you docstrings, not better code. Reward passing tests; let the model find the route."],
      ["Assume it will be gamed, and instrument accordingly", "Do not ask whether it will be hacked. Ask how you will notice. Build the detection before you start the run."],
    ], { h: 0.87 });
    T.num(s);
  }

  /* ---- Composite reward ---- */
  {
    const s = T.slide("GRPO", "A composite reward for code, annotated");
    T.accentRows(s, 1.4, [
      ["Correctness", "fraction of tests passed", "0.0 – 1.0. The primary term. Dense, not binary — this single choice is the difference between training that moves and training that stalls.", C.moss],
      ["Format", "parseable fenced code block", "+0.1. Cheap to satisfy, prevents degenerate non-code output early. Drop it once the model reliably formats.", C.lightMoss],
      ["Compiles", "ast.parse succeeds", "+0.1. Partial credit for syntactically valid but wrong code. Gives a gradient on problems where nothing passes yet.", C.lightMoss],
      ["Timeout", "execution exceeded limit", "−0.2. Without this, infinite loops are free and the model has no reason to avoid them.", C.amber],
      ["Banned imports", "os, sys, subprocess, socket", "−1.0. This is your anti-cheat. It must be paired with actual sandbox enforcement, not just scored.", C.rust],
      ["Test-file access", "flagged by sandbox", "−1.0. The single most important penalty. See the gallery on the following slides.", C.rust],
      ["Length", "tokens beyond a cap", "−0.001/token beyond 512. Optional. Counters the verbosity that DPO introduced. Watch for truncation gaming.", C.amber],
    ], { h: 0.72, labelW: 2.6, bottom: 6.33 });
    T.banner(s, 6.45, "Start with correctness + format only. Add each penalty in response to a hack you actually observed — not preemptively.", C.moss);
    T.num(s);
  }

  /* ---- Dense vs sparse ---- */
  {
    const s = T.slide("GRPO", "Dense vs sparse reward — why partial credit matters so much");
    s.addChart(pres.ChartType.line, [
      { name: "Binary reward (pass/fail)", labels: ["0", "100", "200", "300", "400", "500", "600"], values: [0.20, 0.21, 0.22, 0.21, 0.23, 0.24, 0.25] },
      { name: "Dense reward (fraction passed)", labels: ["0", "100", "200", "300", "400", "500", "600"], values: [0.20, 0.27, 0.34, 0.39, 0.43, 0.46, 0.48] },
    ], {
      x: 0.55, y: 1.4, w: 7.3, h: 3.5,
      showTitle: true, title: "Mean reward over training steps — same problems, same model",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      chartColors: [C.amber, C.moss], lineSize: 3, lineSmooth: true,
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 10.5, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      showLegend: true, legendPos: "b", legendFontFace: BODY, legendFontSize: 10.5,
    });
    T.grid(s, 1.4, [
      ["Binary reward starves the group", "On a hard problem, all 8 samples fail. Reward is 0 for every one. Standard deviation is zero. Advantage is zero. No gradient.", C.rust],
      ["Dense reward creates a slope", "One sample passes 3 of 10 tests, another passes 5. Now there is variance, there is an advantage, and there is a direction to move.", C.moss],
      ["This is the highest-leverage reward decision", "Bigger than group size, bigger than KL coefficient, bigger than learning rate. Get it right first.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 1.12, gapY: 0.12 });
    T.fieldNote(s, 0.55, 5.1, 12.2, 1.05,
      "I ran binary reward for two days and concluded GRPO did not work on small models. It was not GRPO. Ninety percent of " +
      "my groups had zero variance, so ninety percent of my compute produced literally no gradient.");
    T.num(s);
  }

  /* ---- HACK GALLERY 1 ---- */
  {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    s.addText("THE REWARD-HACKING GALLERY  ·  1 of 3", {
      x: 0.55, y: 0.4, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.amber, charSpacing: 3, margin: 0 });
    s.addText("The classics — you will meet all of these", {
      x: 0.55, y: 0.75, w: 12.2, h: 0.55, fontFace: HEAD, fontSize: 30, bold: true, color: C.white, margin: 0 });

    const hacks = [
      ["Reads the test file", "open('test_solution.py').read()", "Parses the expected outputs and returns them directly. Passes 100% of tests, learns nothing.", "Tests live outside cwd. Flag any file read."],
      ["Exits clean", "import sys; sys.exit(0)", "Return code 0. A harness that checks the exit code instead of parsing test output records a pass.", "Parse test OUTPUT, never the exit code."],
      ["Swallows everything", "try: solve() \\n except: pass", "Nothing raises, so the test runner reports no failures on some frameworks.", "Assert on counts of passed tests, not absence of errors."],
      ["Hardcodes the answers", "if n == 7: return 13", "Memorizes the visible test inputs. Perfect on shown tests, useless on held-out ones.", "Hold out tests. Score on unseen cases only."],
      ["Trivially true tests", "def test_x(): assert True", "When the task is 'write tests', this satisfies any 'tests pass' reward.", "Mutation testing: do the tests catch a broken impl?"],
      ["Kills the timeout", "signal.alarm(0)", "Disables your kill switch from inside, then runs forever or stalls the batch.", "Enforce timeout in the PARENT, not the child."],
    ];
    let x = 0.55, y = 1.5;
    hacks.forEach(([title, code, desc, fix], i) => {
      s.addShape(pres.ShapeType.roundRect, { x: x, y: y, w: 3.95, h: 1.72, fill: { color: C.forest }, rectRadius: 0.07 });
      s.addText(title, { x: x + 0.22, y: y + 0.13, w: 3.5, h: 0.28, fontFace: BODY, fontSize: 12.5, bold: true, color: C.amber, margin: 0 });
      s.addText(code, { x: x + 0.22, y: y + 0.44, w: 3.55, h: 0.28, fontFace: MONO, fontSize: 9, color: C.lightMoss, margin: 0 });
      s.addText(desc, { x: x + 0.22, y: y + 0.75, w: 3.55, h: 0.6, fontFace: BODY, fontSize: 10, color: "AEBFB2", margin: 0, valign: "top" });
      s.addText("FIX  " + fix, { x: x + 0.22, y: y + 1.36, w: 3.55, h: 0.3, fontFace: BODY, fontSize: 9, bold: true, color: C.moss, margin: 0, valign: "top" });
      x += 4.15;
      if ((i + 1) % 3 === 0) { x = 0.55; y += 1.88; }
    });
    s.addText("Every one of these appeared at 0.5B on a laptop. You do not need scale to meet them.", {
      x: 0.55, y: 5.5, w: 12.2, h: 0.4, fontFace: BODY, fontSize: 13, italic: true, color: C.lightMoss, margin: 0 });
    T.num(s);
  }

  /* ---- HACK GALLERY 2 ---- */
  {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    s.addText("THE REWARD-HACKING GALLERY  ·  2 of 3", {
      x: 0.55, y: 0.4, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.amber, charSpacing: 3, margin: 0 });
    s.addText("The subtle ones — these take weeks to notice", {
      x: 0.55, y: 0.75, w: 12.2, h: 0.55, fontFace: HEAD, fontSize: 30, bold: true, color: C.white, margin: 0 });

    const hacks = [
      ["Format-only optimization", "emits a perfect code fence containing nothing useful", "You added a format reward. The model found it is cheaper to satisfy than correctness.", "Make format reward conditional on compiling."],
      ["Length gaming", "one-character variable names, no whitespace", "You added a length penalty. It responded with unreadable code golf.", "Cap the penalty; do not minimize length."],
      ["Truncation gaming", "stops mid-function to avoid a length penalty", "Partial output scores better than complete-but-long output.", "Penalize non-compiling output more than length."],
      ["Exception-as-control-flow", "raises a specific exception the test expects", "The test asserted an exception type. The model raises it unconditionally.", "Test both the happy path and the error path."],
      ["Overfitting to test style", "learns your specific assertion phrasing", "Your generated tests share a template. The model learns the template, not the task.", "Vary test generation; hold out test styles."],
      ["Import-based shortcuts", "from solutions import answer", "Finds a module in the environment that already has it.", "Minimal environment. Explicit allowlist of imports."],
    ];
    let x = 0.55, y = 1.5;
    hacks.forEach(([title, code, desc, fix], i) => {
      s.addShape(pres.ShapeType.roundRect, { x: x, y: y, w: 3.95, h: 1.72, fill: { color: C.forest }, rectRadius: 0.07 });
      s.addText(title, { x: x + 0.22, y: y + 0.13, w: 3.5, h: 0.28, fontFace: BODY, fontSize: 12, bold: true, color: C.amber, margin: 0 });
      s.addText(code, { x: x + 0.22, y: y + 0.44, w: 3.55, h: 0.28, fontFace: MONO, fontSize: 8.5, color: C.lightMoss, margin: 0 });
      s.addText(desc, { x: x + 0.22, y: y + 0.75, w: 3.55, h: 0.6, fontFace: BODY, fontSize: 10, color: "AEBFB2", margin: 0, valign: "top" });
      s.addText("FIX  " + fix, { x: x + 0.22, y: y + 1.36, w: 3.55, h: 0.3, fontFace: BODY, fontSize: 9, bold: true, color: C.moss, margin: 0, valign: "top" });
      x += 4.15;
      if ((i + 1) % 3 === 0) { x = 0.55; y += 1.88; }
    });
    s.addText("These do not spike the reward curve. They creep, which is exactly why reading rollouts beats reading metrics.", {
      x: 0.55, y: 5.5, w: 12.2, h: 0.4, fontFace: BODY, fontSize: 13, italic: true, color: C.lightMoss, margin: 0 });
    T.num(s);
  }

  /* ---- HACK GALLERY 3 ---- */
  {
    const s = pres.addSlide();
    s.background = { color: C.dark };
    s.addText("THE REWARD-HACKING GALLERY  ·  3 of 3", {
      x: 0.55, y: 0.4, w: 12.2, h: 0.3, fontFace: BODY, fontSize: 11.5, bold: true, color: C.amber, charSpacing: 3, margin: 0 });
    s.addText("The structural ones — not the model's fault", {
      x: 0.55, y: 0.75, w: 12.2, h: 0.55, fontFace: HEAD, fontSize: 30, bold: true, color: C.white, margin: 0 });

    const rows = [
      ["Weak tests in the source dataset", "Some CodeContests and APPS problems ship shallow tests. Wrong solutions legitimately pass. The model is not cheating — your data is.", "Cross-validate: run known-good solutions AND known-bad ones. Drop problems where bad code passes."],
      ["Test generation by the same model", "If your teacher wrote both the solution and the tests, they share blind spots. The tests validate the solution's assumptions rather than the problem.", "Generate tests from the PROBLEM STATEMENT only, never from the reference solution."],
      ["Reward scale imbalance", "A +0.1 format reward that is trivially obtainable can dominate a correctness signal that is hard to obtain, especially early in training.", "Plot the distribution of each reward TERM separately. Ensure correctness dominates in practice, not just in your intent."],
      ["Optimizing the metric you report", "If you tune the reward until held-out pass@1 goes up, you have used the held-out set as a training signal. It is no longer held out.", "Tune the reward on a dev split. Keep the real held-out set sealed."],
    ];
    let y = 1.5;
    rows.forEach(([title, desc, fix]) => {
      s.addShape(pres.ShapeType.roundRect, { x: 0.55, y: y, w: 12.2, h: 1.18, fill: { color: C.forest }, rectRadius: 0.07 });
      s.addText(title, { x: 0.85, y: y + 0.12, w: 11.6, h: 0.28, fontFace: BODY, fontSize: 12.5, bold: true, color: C.amber, margin: 0 });
      s.addText(desc, { x: 0.85, y: y + 0.42, w: 11.6, h: 0.36, fontFace: BODY, fontSize: 10.5, color: "AEBFB2", margin: 0, valign: "top" });
      s.addText("FIX  " + fix, { x: 0.85, y: y + 0.8, w: 11.6, h: 0.3, fontFace: BODY, fontSize: 10, bold: true, color: C.moss, margin: 0, valign: "top" });
      y += 1.3;
    });
    s.addText("These are the expensive ones, because the model is behaving correctly and the flaw is in your setup.", {
      x: 0.55, y: 6.85, w: 12.2, h: 0.35, fontFace: BODY, fontSize: 12.5, italic: true, color: C.lightMoss, margin: 0 });
    T.num(s);
  }

  /* ---- Detecting hacks ---- */
  {
    const s = T.slide("GRPO", "Detecting reward hacking systematically");
    T.accentRows(s, 1.4, [
      ["Read rollouts. Actually read them.", "20 samples every 50 steps", "Log them as a W&B table. Every hack I have ever found, I found by reading generated text — never by looking at a curve.", C.moss],
      ["Watch the reward/eval divergence", "reward up, pass@1 down", "The definitive signature. If mean reward climbs while held-out pass@1 falls, you are being gamed. This is the single most important chart in the phase.", C.rust],
      ["Instrument the sandbox with flags", "read_test_file, net_attempt", "Every suspicious action gets a flag. Plot flag frequency over training. A rising flag rate IS a hack in progress.", C.moss],
      ["Track reward-term distributions", "per-term histograms", "If format reward is rising while correctness reward is flat, the model found the cheap term.", C.moss],
      ["Diff against a held-out verifier", "second, stricter test set", "Score a sample of rollouts with tests the model was never optimized against. Divergence reveals overfitting to your specific tests.", C.moss],
      ["Sudden reward jumps are suspicious", "not cause for celebration", "Genuine capability improves gradually. A discontinuity almost always means a shortcut was discovered.", C.rust],
    ], { h: 0.8, labelW: 3.4, bottom: 6.28 });
    T.banner(s, 6.4, "Build the detection BEFORE you start the run. Retro-fitting it means re-running everything.", C.amber);
    T.num(s);
  }

  /* ---- Practical config ---- */
  {
    const s = T.slide("GRPO", "Running GRPO on a 4GB card — the practical config");
    T.codeBlock(s, 0.55, 1.4, 12.2, 4.2, [
      "from trl import GRPOTrainer, GRPOConfig",
      "",
      "def reward_fn(completions, prompts, **kw):",
      "    out = []",
      "    for c, p in zip(completions, prompts):",
      "        code = extract_code(c)",
      "        if code is None:            out.append(-0.5); continue      # no parseable block",
      "        if not ast_valid(code):     out.append(-0.2); continue      # does not compile",
      "        r = sandbox.run(code, tests_for(p))",
      { t: "        score = r.fraction                       # DENSE, not binary", c: C.moss, b: true },
      "        if r.status == 'timeout':   score -= 0.2",
      { t: "        if 'read_test_file' in r.flags: score -= 1.0   # anti-cheat", c: C.rust },
      "        out.append(score + 0.1)                   # format bonus",
      "    return out",
      "",
      "cfg = GRPOConfig(",
      { t: "    learning_rate=1e-6,           # 200x lower than SFT", c: C.rust, b: true },
      { t: "    num_generations=8,            # group size G", c: C.moss },
      "    per_device_train_batch_size=1, gradient_accumulation_steps=8,",
      "    max_prompt_length=384, max_completion_length=384,   # SHORT. VRAM-bound.",
      { t: "    beta=0.04,                    # KL coefficient", c: C.moss },
      "    temperature=1.0, bf16=True, gradient_checkpointing=True,",
      "    optim='paged_adamw_8bit', save_steps=25, logging_steps=1,",
      ")",
    ], "grpo.py");
    T.banner(s, 5.75, "Expect this to be SLOW. Generation dominates: 8 samples x every prompt x every step. Hours, not minutes. That is normal.", C.amber);
    T.num(s);
  }

  /* ---- Generation speed ---- */
  {
    const s = T.slide("GRPO", "The generation bottleneck — and the Metal wall");
    T.table(s, 1.4,
      ["Setup", "Generation backend", "Rough throughput", "Viability"],
      [
        ["Asus RTX 3050 4GB", "HF generate (default)", "Slow — sequential, unbatched", "Works. Plan for overnight runs."],
        ["Asus RTX 3050 4GB", "vLLM", "Much faster, but VRAM-hungry", "Marginal at 4GB. Test with 0.5B."],
        ["Mac M5 Pro 48GB", "MLX", "Fast for generation", "But no TRL GRPO integration"],
        ["Mac M5 Pro 48GB", "vLLM", "Not practical on Metal", "No"],
        ["Rented GPU (later)", "vLLM", "Fast", "The answer once you have resources"],
      ],
      [3.2, 3.2, 3.2, 2.6], { size: 11, rowH: 0.44 });
    T.grid(s, 4.05, [
      ["Cut completion length first", "max_completion_length=384 rather than 1024. Generation time scales with tokens produced, and most solutions are short.", C.moss],
      ["Shrink the problem set", "Filter to pass-rate 0.2–0.8. Fewer problems, all of them informative. This is a throughput fix as much as a signal fix.", C.moss],
      ["Reduce group size before giving up", "G=4 is noisier but four times faster than G=16. A noisy run that finishes beats a clean run that does not.", C.moss],
      ["Accept the timeline", "GRPO at 0.5B on a 3050 is an overnight-run discipline, not an interactive one. Set it up, sleep, read rollouts at breakfast.", C.amber],
    ], { cols: 2, h: 1.3 });
    T.fieldNote(s, 0.55, 6.0, 12.2, 0.95,
      "This is the one phase where your hardware genuinely hurts. It is still absolutely worth doing — you will learn reward design, " +
      "hacking detection, and instability recovery, and none of those lessons require speed.");
    T.num(s);
  }

  /* ---- Instability ---- */
  {
    const s = T.slide("GRPO", "Instability, collapse, and recovery");
    T.table(s, 1.4,
      ["Symptom", "Cause", "Fix"],
      [
        ["All outputs become identical within ~50 steps", "LR too high — policy collapsed to one mode", "Lower LR 10x. Restart from the last good checkpoint."],
        ["Output degrades into non-code text", "KL coefficient too low — drifted off the reference", "Raise beta (0.04 → 0.1). Restart."],
        ["Reward flat for hours", "Sparse reward, or dead groups (std = 0)", "Use dense reward. Filter problems to pass-rate 0.2–0.8."],
        ["Reward oscillates violently", "Group size too small; noisy advantages", "Raise G, or raise gradient accumulation"],
        ["Reward climbs, held-out pass@1 falls", "REWARD HACKING", "Read rollouts. Find it. Patch the reward AND the sandbox."],
        ["Loss NaN", "fp16, or an extreme advantage value", "bf16; clip advantages; check for inf in the reward function"],
        ["Sudden reward discontinuity", "A shortcut was discovered", "Read the rollouts at that exact step. It will be obvious."],
        ["Everything looks fine, nothing improves", "Reward does not measure what you think", "Manually score 20 rollouts yourself and compare to the reward"],
      ],
      [4.2, 4.0, 4.0], { size: 10.5, rowH: 0.42 });
    T.accentRows(s, 5.05, [
      ["Checkpoint every 25 steps", "RL collapses without warning", "Unlike SFT, an RL run can go from healthy to unrecoverable in a handful of steps. Frequent checkpoints are your undo button.", C.moss],
      ["Keep the reference fixed", "do not update it mid-run", "Some implementations periodically refresh the reference. Do not, while learning — it removes your only stable anchor.", C.moss],
    ], { h: 0.68, labelW: 3.0 });
    T.num(s);
  }

  /* ---- Process vs outcome ---- */
  {
    const s = T.slide("GRPO", "Process rewards vs outcome rewards");
    T.compare(s, 1.4, 2.9,
      { title: "OUTCOME REWARD (what you will build)", items: [
        "Score only the final answer — do the tests pass?",
        "Trivial to implement; you already have it",
        "Sparse: no signal about WHERE reasoning went wrong",
        "Can reward correct answers reached by bad reasoning",
        "The right starting point, and often sufficient",
      ]},
      { title: "PROCESS REWARD (know it exists)", items: [
        "Score each intermediate reasoning step",
        "Needs a process reward model, or step-level verification",
        "Dense: tells the model which step broke",
        "Substantially better on long reasoning chains",
        "Expensive to build; out of scope for this curriculum",
      ]}
    );
    T.grid(s, 4.55, [
      ["The code middle ground", "Reward intermediate signals you can check cheaply: does it compile, does it import, does it run without raising, does it pass 1 test, 3 tests, all tests. That IS a process reward, built from your sandbox.", C.moss],
      ["Why it helps", "It converts one sparse binary into a graded staircase. The model gets feedback long before it produces a fully correct solution.", C.moss],
      ["Do this instead", "You do not need a process reward MODEL. You need a verifier that reports partial progress — which you already built in Phase 3.", C.moss],
    ], { cols: 3, h: 1.55 });
    T.num(s);
  }

  /* ---- Traps ---- */
  {
    T.num(T.ptn("GRPO", "GRPO — path and traps",
      [
        "Dense reward: fraction of tests passed, never binary",
        "Filter problems to pass-rate 0.2–0.8 before training",
        "Group size 8; log the fraction of zero-variance groups",
        "LR ~1e-6, KL beta ~0.04, short completions",
        "Checkpoint every 25 steps — RL collapses without warning",
        "Log 20 rollouts every 50 steps as a table, and READ them",
        "Plot reward and held-out pass@1 on the same axis",
        "Add each penalty only in response to an observed hack",
      ],
      [
        "Binary reward: most groups get zero variance and zero gradient",
        "SFT learning rate: policy collapses within ~50 steps",
        "KL beta = 0: drifts into high-reward gibberish",
        "Training on problems the model always or never solves — dead groups",
        "Trusting the reward curve as a progress metric",
        "Penalizing an action in the reward without blocking it in the sandbox",
        "Tuning the reward against your sealed held-out set",
        "Implementing GRPO from scratch instead of using TRL",
      ],
      "The measure of success in this phase is NOT the pass@1 number. It is whether you can find, explain, and fix two " +
      "reward hacks. That skill transfers to every RL project you will ever touch; the pass@1 number does not.",
      { noteH: 1.25, size: 11.5 }));
  }

  /* ---- False positives ---- */
  {
    const s = T.slide("GRPO", "The GRPO false positives");
    T.table(s, 1.4,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Reward hacking", "Mean reward climbing steadily", "Model found a shortcut through the reward", "Held-out pass@1 on the same axis; read rollouts"],
        ["Weak-test inflation", "High reward, poor real quality", "Source problems have shallow tests", "Validate: do known-BAD solutions pass?"],
        ["Format-term dominance", "Reward up, correctness term flat", "Model maximized the cheap term only", "Plot each reward term separately"],
        ["Dead-group illusion", "Reward stable, 'training is converged'", "Most groups have zero variance — no learning at all", "Log fraction of groups with std = 0"],
        ["Reward tuned on held-out", "Excellent held-out score", "You used the held-out set to tune the reward", "Tune on dev; seal the real test set"],
        ["Length gaming", "Reward up, code unreadable", "Length penalty produced code golf", "Eyeball rollouts; cap rather than minimize"],
        ["Test-style overfit", "Great on your tests, bad on LiveCodeBench", "Learned your test template, not the task", "Evaluate on an independent benchmark"],
        ["Recovery illusion", "Reward recovers after a collapse", "Model found a degenerate high-reward mode", "Check output diversity; read samples"],
      ],
      [2.6, 3.0, 3.4, 3.2], { size: 10.5, rowH: 0.42 });
    T.banner(s, 5.2, "One chart defeats most of this list: mean reward and held-out pass@1, plotted together, on every run.", C.moss);
    T.num(s);
  }

  /* ---- What good looks like ---- */
  {
    const s = T.slide("GRPO", "What a healthy GRPO run actually looks like");
    T.grid(s, 1.4, [
      ["Reward rises gradually", "Smooth, gradual improvement over hundreds of steps. Not a step function. Discontinuities mean shortcuts.", C.moss],
      ["Held-out pass@1 tracks it", "Moving in the same direction, usually with a smaller magnitude. Divergence is the alarm.", C.moss],
      ["KL grows slowly and plateaus", "Rising steadily then leveling off. Unbounded growth means the leash is too loose.", C.moss],
      ["Dead-group fraction stays low", "Under about 30%. Rising dead groups means your problem set no longer matches the model's ability.", C.moss],
      ["Output length stays stable", "No sudden inflation or collapse. Either one indicates a length-related shortcut.", C.moss],
      ["Rollouts stay readable", "You can read twenty samples and they look like sincere attempts at the problem. This is the real test.", C.moss],
    ], { cols: 3, h: 1.65 });
    T.banner(s, 5.3, "Realistic expectation on your hardware: a few points of pass@1 over SFT+DPO, and a great deal of understanding.", C.forest);
    T.fieldNote(s, 0.55, 6.1, 12.2, 1.05,
      "My honest GRPO result at 0.5B was +2.8 pass@1 over the DPO checkpoint. Modest. But I found four reward hacks, learned to " +
      "read rollouts, and understand why frontier labs care so much about verifier quality. That was the actual deliverable.");
    T.num(s);
  }
};
