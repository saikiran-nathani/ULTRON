/* PART V — EVALUATION  (Phase 4) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("EVAL", "Phase 4", "Building the Ruler",
    "Three days. Everything after this is measured with the instrument you build here.\nA bad ruler does not slow you down — it points you confidently in the wrong direction."));

  /* ---- Why first ---- */
  {
    const s = T.slide("Eval", "Why the ruler comes before the gradient");
    T.grid(s, 1.4, [
      ["You cannot improve what you cannot measure", "Obvious, and universally ignored. Everyone wants to train on day one. The people who build eval first finish faster.", C.moss],
      ["Most 'improvements' are measurement artifacts", "Prompt drift, seed noise, contamination, a changed extraction regex. Without a trustworthy ruler you cannot tell these from real gains.", C.rust],
      ["The verifier IS the reward function", "In Phase 9 this exact code becomes your GRPO reward. Building it well now is building the RL infrastructure now.", C.moss],
      ["It sets the honest baseline", "Every claim in your results/ folder is 'better than X'. If X is wrong, every claim is wrong.", C.ink],
      ["It catches your bugs, not the model's", "Half of what an eval harness finds in month one is broken data plumbing, not model behavior.", C.ink],
      ["It makes failure legible", "'It got worse' is useless. 'pass@1 fell 3.2 ± 0.7 on held-out, concentrated in problems needing recursion' is actionable.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.35, "The order is not negotiable: sandbox → eval harness → baseline → data → training. Skipping ahead costs weeks.", C.moss);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "I trained for eleven days before I had a trustworthy eval. Every result from that period went in the bin — not because the " +
      "training was wrong, but because I could not prove anything about it after the fact.");
    T.num(s);
  }

  /* ---- pass@k ---- */
  {
    const s = T.slide("Eval", "pass@k — the metric, derived");
    s.addText(
      "pass@k is the probability that at least one of k sampled solutions passes all tests. It is not a percentage of problems solved — " +
      "it is an estimate of a probability, and the way you estimate it matters enormously.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.65, fontFace: BODY, fontSize: 13, color: C.ink, margin: 0, valign: "top" }
    );
    T.codeBlock(s, 0.55, 2.15, 6.6, 2.5, [
      { t: "# The unbiased estimator (Chen et al., Codex paper)", c: C.moss },
      "# n = samples generated per problem (n >> k)",
      "# c = number of those n that passed",
      "",
      "def pass_at_k(n, c, k):",
      "    if n - c < k:",
      "        return 1.0",
      "    return 1.0 - np.prod(",
      "        1.0 - k / np.arange(n - c + 1, n + 1)",
      "    )",
      "",
      { t: "# Then average pass_at_k over all problems.", c: C.muted },
    ], "UNBIASED pass@k");
    T.grid(s, 2.15, [
      ["Why not just sample k and check?", "Because with k=1 you get a Bernoulli sample per problem — enormous variance. The estimator uses all n samples to estimate the same quantity with far less noise.", C.ink],
      ["Typical settings", "n = 20 or 50, then report pass@1, pass@5, pass@10 from the same generation run. One expensive generation, three metrics.", C.moss],
      ["pass@1 with n=1 is not pass@1", "It is a single coin flip. People report it constantly and it is why their numbers jump around by 4 points between runs.", C.rust],
      ["Temperature interacts", "pass@1 is usually reported greedy or low-temp; pass@10 benefits from higher temperature. Report the temperature or the number is meaningless.", C.amber],
    ], { cols: 1, x: 7.35, w: 5.4, h: 0.98, gapY: 0.1 });
    T.num(s);
  }

  /* ---- pass@k pitfalls ---- */
  {
    const s = T.slide("Eval", "What pass@k does and does not tell you");
    T.compare(s, 1.4, 2.9,
      { title: "pass@1 RISING MEANS", items: [
        "The model's most likely output is more often correct",
        "Genuine capability gain, usually",
        "The thing you care about for a single-shot assistant",
        "The metric to optimize in SFT, DPO, and GRPO",
      ]},
      { title: "pass@10 RISING ALONE MEANS", items: [
        "Somewhere in ten tries there is a correct answer",
        "Often just increased DIVERSITY, not increased skill",
        "Can rise while pass@1 falls — a classic false positive",
        "Only useful if you have a verifier at inference time",
      ]}
    );
    T.accentRows(s, 4.55, [
      ["The diversity trap", "pass@10 up, pass@1 flat", "You made the model less certain, not more capable. Common after high-temperature RFT. Always report both.", C.rust],
      ["The sharpening effect", "pass@1 up, pass@10 down", "The model concentrated probability on its best answer. Usually good for deployment, bad for search-based inference.", C.amber],
      ["Both up", "the real win", "Genuine capability improvement. Rarer than you would like, and worth celebrating when the seeds agree.", C.moss],
    ], { h: 0.68, labelW: 2.4 });
    T.num(s);
  }

  /* ---- HumanEval ---- */
  {
    const s = T.slide("Eval", "HumanEval — the standard, and its real flaws");
    T.grid(s, 1.4, [
      ["What it is", "164 hand-written Python problems: a function signature, a docstring, and hidden unit tests. Released with the Codex paper in 2021.", C.ink],
      ["Why everyone uses it", "It is small, fast, universally reported, and every paper quotes it. Comparability is its main virtue.", C.ink],
      ["Flaw 1 — it is tiny", "164 problems means ±3 points is noise. Papers report differences of 1.2 points as meaningful. They are not.", C.rust],
      ["Flaw 2 — weak tests", "The original tests are shallow. Many wrong solutions pass. This is precisely what EvalPlus was built to fix.", C.rust],
      ["Flaw 3 — saturated and contaminated", "It has been in training corpora for years. High scores may reflect memorization rather than capability.", C.rust],
      ["Flaw 4 — narrow", "Short, self-contained, single-function Python. Says almost nothing about real software work.", C.amber],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.35, "Use it because it is comparable, not because it is good. Never let it be your only metric.", C.amber);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "164 problems. One problem is 0.61 points. When you see a paper claiming a 1-point HumanEval improvement, they are " +
      "claiming they solved 1.6 more problems — which is well inside seed noise.");
    T.num(s);
  }

  /* ---- EvalPlus ---- */
  {
    const s = T.slide("Eval", "EvalPlus — why the + matters more than the benchmark");
    T.pipeline(s, 1.4, [
      ["ORIGINAL", "HumanEval ships ~7.7 test cases per problem on average. Shallow coverage.", C.amber],
      ["AUGMENT", "EvalPlus generates ~80x more tests via LLM seeding plus type-aware mutation.", C.moss],
      ["RESULT", "Many previously-'correct' solutions now fail. Scores drop, typically by 10–20%.", C.moss],
      ["MEANING", "The lower number is the honest one. The original was measuring test weakness.", C.forest2],
    ], { h: 1.7 });
    T.accentRows(s, 3.4, [
      ["Always report the + variant", "HumanEval+ / MBPP+", "It is strictly more rigorous. Reporting the base variant when you have the + available is choosing the flattering number.", C.moss],
      ["Expect the drop", "typically -10 to -20%", "Your model did not get worse. Your ruler got honest. Do not chase the base number back up.", C.moss],
      ["It changes rankings", "not just magnitudes", "Models that overfit to weak tests fall further than models with real capability. That reordering is the point.", C.moss],
      ["Install and go", "pip install evalplus", "Handles generation, execution, and scoring. Do not hand-roll HumanEval — you will get the extraction wrong.", C.lightMoss],
    ], { h: 0.68, labelW: 3.0 });
    T.fieldNote(s, 0.55, 6.35, 12.2, 0.85,
      "My model dropped from 34.1 to 28.7 the day I switched to HumanEval+. That 5.4 points was never real — it was test weakness.");
    T.num(s);
  }

  /* ---- Benchmark landscape ---- */
  {
    const s = T.slide("Eval", "The benchmark landscape — what each one actually measures");
    T.table(s, 1.4,
      ["Benchmark", "Size", "Measures", "Use it for"],
      [
        ["HumanEval / +", "164", "Short single-function Python from a docstring", "Comparability. Report it because everyone does."],
        ["MBPP / +", "~974 (378 test)", "Simpler, more basic Python tasks", "A second signal; less saturated than HumanEval"],
        ["LiveCodeBench", "Growing, timestamped", "Contest problems released AFTER a model's cutoff", "The honest number. Contamination-resistant by construction."],
        ["BigCodeBench", "~1,140", "Realistic tasks using many libraries", "Closer to real work than HumanEval"],
        ["MultiPL-E", "HumanEval x 18+ langs", "Cross-language transfer", "If you care about anything other than Python"],
        ["CodeContests", "~13.5k w/ tests", "Competitive programming, hard", "TRAINING with RLVR — this is your reward-signal goldmine"],
        ["APPS", "10,000 w/ tests", "Interview to competition difficulty, graded", "Training and difficulty-stratified evaluation"],
        ["TACO", "~26k", "Algorithmic problems with tests", "More RLVR training data"],
        ["SWE-bench (Verified)", "500", "Real GitHub issues, repo-level, multi-file", "Deferred. A research project, not a first curriculum."],
      ],
      [2.5, 2.0, 4.0, 3.7], { size: 10.5, rowH: 0.4 });
    T.banner(s, 5.35, "Note the split: some of these are for MEASURING, some are for TRAINING. CodeContests and APPS are training data.", C.moss);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "LiveCodeBench is the one to trust for a final number, because problems are timestamped after model cutoffs. " +
      "If your HumanEval is strong and your LiveCodeBench is weak, you have a contamination problem, not a capability.");
    T.num(s);
  }

  /* ---- Own eval set ---- */
  {
    const s = T.slide("Eval", "Building your own eval set — the one that actually matters");
    T.steps(s, 1.4, [
      ["Collect 100–200 problems from your target distribution", "Public benchmarks measure public distributions. If you care about a specific kind of code, no public benchmark measures it. Yours does."],
      ["Write genuinely adversarial tests", "Edge cases, empty inputs, boundary values, type errors. Weak tests are the reason HumanEval needed EvalPlus. Do not repeat that mistake in your own set."],
      ["Stratify by difficulty and by category", "Tag each problem: recursion, string manipulation, data structures, math. When a score moves you want to know WHERE it moved."],
      ["Split three ways: dev / val / test", "dev for daily iteration, val for checkpoint selection, test opened exactly once at the end. Three splits, not two."],
      ["Version it and never edit in place", "eval-v1, eval-v2. Changing the eval set invalidates every previous number — so make that change explicit and dated."],
      ["Decontaminate it against your training data", "Your own eval can be contaminated too, especially if both came from similar sources."],
    ], { h: 0.86 });
    T.fieldNote(s, 0.55, 6.4, 12.2, 0.85,
      "Category tags paid for themselves the first time a checkpoint improved overall while collapsing on recursion. Without tags that is invisible.");
    T.num(s);
  }

  /* ---- Seeds and variance ---- */
  {
    const s = T.slide("Eval", "Seeds, variance, and how big a delta must be");
    s.addText(
      "This is the slide that will save you the most wasted time. On 164 problems, the standard deviation across seeds is " +
      "typically 1.5–2.5 points. That means a 3-point 'improvement' from a single run is frequently nothing at all.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.table(s, 2.2,
      ["Observed delta", "On 164 problems, 1 seed", "On 164 problems, 3 seeds", "What to do"],
      [
        ["+0.5 pt", "Noise", "Noise", "Ignore. Do not write it down."],
        ["+1.5 pt", "Noise", "Probably noise", "Re-run with more seeds before believing it"],
        ["+3.0 pt", "Possibly real", "Probably real", "Report with std. Investigate what changed."],
        ["+6.0 pt", "Likely real", "Real", "This is a genuine finding. Write it up properly."],
        ["-3.0 pt", "Possibly real", "Probably real", "Something broke. Bisect your change."],
      ],
      [2.3, 3.0, 3.2, 3.7], { size: 11, rowH: 0.4 });
    T.accentRows(s, 4.7, [
      ["Three seeds is the minimum", "seed: [0, 1, 2]", "Report mean ± std, always. A number without a std is an anecdote.", C.moss],
      ["Bigger eval sets shrink the noise", "combine HumanEval+ + MBPP+ + yours", "~700 problems instead of 164 roughly halves your standard deviation for free.", C.moss],
      ["Seed everything", "python, numpy, torch, cuda, dataloader", "Partial seeding is worse than none — you get irreproducibility you believe is reproducible.", C.rust],
    ], { h: 0.68, labelW: 3.2 });
    T.num(s);
  }

  /* ---- Prompt sensitivity ---- */
  {
    const s = T.slide("Eval", "Prompt template sensitivity — a worked example");
    s.addText(
      "Same model weights, byte-identical. Four prompt formats. Real spread on HumanEval+ pass@1:",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.4, fontFace: BODY, fontSize: 13, color: C.ink, margin: 0 }
    );
    s.addChart(pres.ChartType.bar, [{
      name: "HumanEval+ pass@1",
      labels: ["Raw completion", "Chat template", "+ system prompt", "+ 'think first'"],
      values: [24.4, 28.7, 30.5, 26.2],
    }], {
      x: 0.55, y: 1.9, w: 7.2, h: 3.4,
      barDir: "col",
      showTitle: false,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 12, dataLabelColor: C.ink,
      chartColors: [C.amber, C.moss, C.moss, C.amber],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 11, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      valAxisMinVal: 15, valAxisMaxVal: 35, showLegend: false,
    });
    T.grid(s, 1.9, [
      ["6.1 points of spread", "From formatting alone. That is larger than most fine-tuning gains you will produce in this entire curriculum.", C.rust],
      ["'Think step by step' HURT here", "On a small code model, chain-of-thought prompting often degrades pass@1 — it produces prose where code was expected and the extractor fails.", C.amber],
      ["Fix it, version it, never touch it", "Choose one template, put its name in every config, and treat changing it as a separate experiment with its own baseline.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 1.08, gapY: 0.12 });
    T.fieldNote(s, 0.55, 5.5, 12.2, 1.45,
      "The first improvement I ever celebrated was a template change. I moved the docstring, re-ran, saw +4.2, and spent an " +
      "evening feeling clever. The weights were identical. The template now lives in the config file and changing it counts " +
      "as changing the experiment.");
    T.num(s);
  }

  /* ---- Extraction ---- */
  {
    const s = T.slide("Eval", "Stop tokens and the extraction regex — where points quietly vanish");
    T.accentRows(s, 1.4, [
      ["Fenced block extraction", "```python ... ```", "Most instruct models wrap code in fences. Your extractor must handle: no fences, unlabeled fences, multiple blocks, unterminated fences.", C.moss],
      ["Which block do you take?", "first vs last vs longest", "A model that explains, shows a wrong approach, then shows the right one will fail if you take the first block. Take the LAST complete block.", C.rust],
      ["Stop sequences", "'\\ndef ', '\\nclass ', '\\nif __name__'", "For raw-completion evaluation you must stop before the model writes the next function. Wrong stops truncate valid solutions.", C.amber],
      ["Prompt echo", "model repeats the signature", "If the model re-emits the function signature and you also prepend it, you get a duplicate def and a syntax error on correct code.", C.rust],
      ["Markdown leakage", "prose inside the block", "Explanatory text inside the fence breaks compilation. Strip non-code lines, or penalize it in training instead.", C.amber],
      ["Log extraction failures separately", "status='extract_fail'", "If 8% of generations fail extraction, that is an 8-point ceiling on your score that has nothing to do with the model.", C.moss],
    ], { h: 0.8, labelW: 3.2, bottom: 6.28 });
    T.fieldNote(s, 0.55, 6.4, 12.2, 0.85,
      "I lost 4 points to an extractor that took the first fenced block. The model was explaining a naive approach first, then giving the good one.");
    T.num(s);
  }

  /* ---- Greedy vs sampled ---- */
  {
    const s = T.slide("Eval", "Greedy vs sampled evaluation");
    T.compare(s, 1.4, 2.8,
      { title: "GREEDY (temperature = 0)", items: [
        "Deterministic — same input, same output, every time",
        "Zero seed variance from sampling",
        "The right choice for pass@1 and for regression tests",
        "Fast: one generation per problem",
        "Can get stuck in degenerate repetition loops",
      ]},
      { title: "SAMPLED (temperature > 0)", items: [
        "Required for pass@k with k > 1",
        "n=20 at temp 0.6–0.8 is a common setting",
        "Reveals the model's actual output distribution",
        "20x the compute of greedy",
        "Introduces sampling variance on top of seed variance",
      ]}
    );
    T.accentRows(s, 4.45, [
      ["Daily iteration", "greedy, pass@1", "Fast, deterministic, and sensitive enough to catch regressions. This is 90% of your eval runs.", C.moss],
      ["Phase gates", "n=20, temp 0.8, pass@1/5/10", "Once per phase. Expensive, but tells you about diversity as well as accuracy.", C.moss],
      ["Never mix them", "in one comparison", "Comparing a greedy baseline against a sampled checkpoint is not a comparison. It happens constantly.", C.rust],
    ], { h: 0.68, labelW: 2.6 });
    T.num(s);
  }

  /* ---- Harnesses ---- */
  {
    const s = T.slide("Eval", "Harnesses — use one, then wrap it");
    T.grid(s, 1.4, [
      ["evalplus", "pip install evalplus. Handles HumanEval+/MBPP+ end to end: generation, extraction, execution, scoring. Start here.", C.moss],
      ["bigcode-evaluation-harness", "Broader benchmark coverage, more configuration surface, more moving parts. Reach for it when evalplus is not enough.", C.ink],
      ["lm-evaluation-harness", "General LLM eval; weaker for code specifically. Useful for your catastrophic-forgetting regression checks.", C.ink],
      ["Your own thin wrapper", "One entrypoint that runs all of the above plus your custom set, writes one JSON, and logs to W&B. Build this on day one of Phase 4.", C.moss],
    ], { cols: 2, h: 1.35 });
    T.codeBlock(s, 0.55, 4.3, 12.2, 1.85, [
      { t: "# src/eval/harness.py — the interface everything else calls", c: C.moss },
      "def evaluate(model_path, suites=('humaneval+','mbpp+','custom'), seeds=(0,1,2),",
      "             temperature=0.0, n=1, template='qwen-chatml-v1') -> dict:",
      "    \"\"\"Returns {suite: {'pass@1': mean, 'pass@1_std': std, 'n_extract_fail': int, ...}}",
      "    Writes results/<run_id>.json AND logs to W&B. One call site for the whole project.\"\"\"",
    ]);
    T.banner(s, 6.4, "One function. Every phase calls it. If evaluation is more than one call, you will do it less often than you should.", C.moss);
    T.num(s);
  }

  /* ---- LLM as judge ---- */
  {
    const s = T.slide("Eval", "LLM-as-judge for code — when it helps, when it lies");
    T.compare(s, 1.4, 2.9,
      { title: "USE A JUDGE FOR", items: [
        "Code quality, readability, idiom",
        "Whether an explanation is actually correct",
        "Style adherence and naming conventions",
        "Preference pairs where BOTH solutions pass tests",
        "Anything with no mechanical checker",
      ]},
      { title: "NEVER USE A JUDGE FOR", items: [
        "Correctness — you have a compiler and tests. Use them.",
        "Anything you can verify mechanically. Ever.",
        "Your primary reported metric",
        "Comparing models from the judge's own family",
        "Reward in RLVR — the V stands for verifiable",
      ]}
    );
    T.accentRows(s, 4.55, [
      ["Position bias", "A vs B ordering", "Judges systematically favor whichever answer appears first. Always evaluate both orderings and average.", C.rust],
      ["Length bias", "longer = better", "Judges reliably prefer longer answers regardless of quality. This compounds with DPO's verbosity bias catastrophically.", C.rust],
      ["Self-preference", "same family", "Models rate their own family's output higher. Never judge a Qwen student with a Qwen teacher for a headline number.", C.rust],
    ], { h: 0.68, labelW: 2.4 });
    T.num(s);
  }

  /* ---- Regression / forgetting ---- */
  {
    const s = T.slide("Eval", "Regression suites and catastrophic forgetting");
    s.addText(
      "Fine-tuning on code makes a model better at code and quietly worse at everything else. If you only measure code, " +
      "you will never see the cost — and you will ship a model that cannot hold a conversation.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.65, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.table(s, 2.15,
      ["Check", "What it catches", "Run it"],
      [
        ["General benchmark subset (e.g. MMLU 500q)", "Broad capability loss from narrow fine-tuning", "Every checkpoint"],
        ["Instruction-following (IFEval-style)", "Loss of ability to follow formatting constraints", "Every phase gate"],
        ["A fixed 20-prompt smoke set", "Obvious breakage: endless generation, garbage, template collapse", "Every checkpoint, eyeball it"],
        ["Output length distribution", "Verbosity drift, especially after DPO", "Every checkpoint"],
        ["Non-Python code (MultiPL-E subset)", "Over-specialization to a single language", "Every phase gate"],
        ["The previous phase's eval", "Direct regression against what you already had", "Every checkpoint"],
      ],
      [4.6, 4.9, 2.7], { size: 11, rowH: 0.42 });
    T.banner(s, 5.1, "Mitigation: mix 5–15% general instruction data into your code SFT. It costs a little code performance and buys back most of the general ability.", C.moss);
    T.fieldNote(s, 0.55, 5.9, 12.2, 1.05,
      "My best code checkpoint could no longer answer 'what is the capital of France' in a complete sentence. It had become " +
      "a function-emitting appliance. That is a legitimate design choice — but it should be a choice, not a surprise.");
    T.num(s);
  }

  /* ---- Eval traps ---- */
  {
    T.num(T.ptn("Eval", "Evaluation — path and traps",
      [
        "Build one evaluate() entrypoint. Everything calls it",
        "HumanEval+ and MBPP+ via evalplus, plus your own 100–200 problem set",
        "Three seeds minimum; always report mean ± std",
        "Greedy for daily iteration, n=20 sampled at phase gates",
        "Fix the template, version it, name it in every config",
        "Log extraction failures as their own status",
        "Carve a test split you do not open until the very end",
        "Run a general benchmark every checkpoint to catch forgetting",
      ],
      [
        "Single seed: 1–3 point swings are pure noise and you will chase them",
        "Naive pass@k: sample k and check. Biased and high-variance",
        "Reporting base HumanEval when you have HumanEval+ available",
        "Changing the template between baseline and checkpoint",
        "Taking the first fenced code block instead of the last",
        "Trusting exit code instead of parsing test output",
        "Looking at the test split 'just once' mid-project",
        "Comparing a greedy run against a sampled run",
      ],
      "Phase 4 produces exactly one artifact: a number you trust. Everything after this is 'better than that number', " +
      "so if it is wrong, the entire rest of the project is measured against a lie.",
      { noteH: 1.2, size: 11.8 }));
  }

  /* ---- Eval false positives ---- */
  {
    const s = T.slide("Eval", "The evaluation false positives", "These do not fail. They succeed, incorrectly, and you believe them.");
    T.table(s, 1.68,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Contamination", "Strong HumanEval, weak LiveCodeBench", "Eval problems are in your training data", "n-gram overlap; compare timestamped benchmarks"],
        ["Template drift", "Sudden multi-point jump", "You changed the prompt, not the model", "Diff the rendered prompt between runs"],
        ["Seed noise", "Gains appear and vanish", "One-seed variance read as signal", "Three seeds, report std"],
        ["Extraction change", "Score moves after a 'cleanup' commit", "Your regex now grabs a different block", "Log n_extract_fail every run"],
        ["Checkpoint cherry-pick", "Best-of-20 checkpoints looks great", "You overfit to the validation set", "Pick on val, report on untouched test"],
        ["Weak-test inflation", "High base HumanEval", "Wrong solutions pass shallow tests", "Use the + variants, always"],
        ["Diversity mistaken for skill", "pass@10 up, pass@1 flat", "More variety, no more capability", "Always report both k values"],
        ["Judge preference", "Judge score up, pass@1 flat", "You optimized for the judge's length bias", "Verifier is truth; judge is advisory"],
        ["Baseline sandbagging", "Huge gain over baseline", "Your baseline used a worse prompt", "Baseline gets the same template and effort"],
      ],
      [2.4, 2.9, 3.6, 3.3], { size: 10, rowH: 0.4 });
    T.banner(s, 5.65, "Every one of these produces a number that goes UP. That is what makes them expensive.", C.rust);
    T.num(s);
  }

  /* ---- Baseline ---- */
  {
    const s = T.slide("Eval", "Phase 4 deliverable — your baseline table");
    T.table(s, 1.4,
      ["Model", "HumanEval+ pass@1", "MBPP+ pass@1", "Custom set", "Notes"],
      [
        ["Qwen2.5-Coder-0.5B-Instruct", "~26 ± 2", "~40 ± 2", "your number", "Primary student. Everything is measured against this."],
        ["Qwen2.5-Coder-1.5B-Instruct", "~38 ± 2", "~52 ± 2", "your number", "Stretch target. Shows what scale alone buys."],
        ["Qwen2.5-Coder-7B-Instruct", "~62 ± 2", "~68 ± 2", "your number", "Teacher / ceiling. Mac inference only."],
        ["Qwen2.5-0.5B-Instruct (non-code)", "~12 ± 2", "~22 ± 2", "your number", "Control. Isolates code-specific gains."],
      ],
      [4.0, 2.3, 2.0, 1.8, 2.1], { size: 11, rowH: 0.48 });
    T.grid(s, 3.75, [
      ["The control is the point", "The non-code model tells you how much of any future gain is code-specific versus generic instruction-following.", C.moss],
      ["The ceiling is the point", "7B tells you what capability looks like. If your 0.5B approaches it on your custom set, you have done something real.", C.moss],
      ["Write it down in results/00-baseline.md", "With the harness commit SHA, the template name, the seeds, and the date. This file is referenced for the rest of the project.", C.moss],
    ], { cols: 3, h: 1.35 });
    T.fieldNote(s, 0.55, 5.35, 12.2, 1.45,
      "Published numbers and my measured numbers disagreed by up to 6 points on identical weights — different prompt, different " +
      "stop tokens, different extraction. Do not trust any number you did not reproduce yourself, including the ones on this slide. " +
      "They are approximate placeholders; your table is the real one.");
    T.num(s);
  }
};
