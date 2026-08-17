/* PART VIII — REJECTION SAMPLING / RFT  (Phase 7) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("RFT", "Phase 7", "Rejection Sampling — Self-Improvement Without RL",
    "One week. The simplest idea in the whole curriculum, and it works far better\nthan it has any right to. This is where the model starts teaching itself."));

  /* ---- The idea ---- */
  {
    const s = T.slide("RFT", "The idea, in one sentence");
    T.banner(s, 1.4, "Generate many attempts. Keep only the ones that actually pass the tests. Fine-tune on those. Repeat.", C.moss, 0.75);
    s.addText(
      "That is the entire method. No policy gradients, no reward model, no KL penalty, no value function. It is ordinary " +
      "SFT — the only novelty is where the training data comes from.",
      { x: 0.55, y: 2.32, w: 12.2, h: 0.65, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.grid(s, 3.05, [
      ["Why it works", "The model can already produce correct solutions occasionally — just not reliably. Filtering by execution concentrates probability mass on the behavior that was already there.", C.moss],
      ["Why it is safe", "Every training example is verified correct. There are no noisy labels at all, which is a guarantee no human-annotated dataset can offer.", C.moss],
      ["Why it is cheap", "It is SFT. Same trainer, same hyperparameters, same debugging intuitions you built in Phase 6. Only the dataset changed.", C.moss],
      ["Why it comes before RL", "It captures most of the achievable gain with none of the instability. If RFT does not help, GRPO will not save you — your data or verifier is wrong.", C.moss],
      ["Known by many names", "Rejection sampling fine-tuning, RFT, RAFT, best-of-n distillation, STaR (when iterated). The same core idea rediscovered repeatedly.", C.ink],
      ["The self-improvement loop", "Model generates → verifier filters → model trains on its own verified output → model improves → generates better. This is the conceptual core of Phases 7 through 10.", C.moss],
    ], { cols: 3, h: 1.75 });
    T.fieldNote(s, 0.55, 5.9, 12.2, 1.05,
      "I put off RFT because it seemed too simple to be worth a week. It produced a bigger single gain than DPO did, at a " +
      "fraction of the complexity. Do not skip it on the assumption that the sophisticated method must be better.");
    T.num(s);
  }

  /* ---- The loop ---- */
  {
    const s = T.slide("RFT", "The loop in detail");
    T.steps(s, 1.4, [
      ["Take problems that ship with tests", "CodeContests, APPS, TACO, MBPP-train. You need executable verification, so instruction datasets without tests do not work here."],
      ["Generate N samples per problem at temperature > 0", "N = 10–50. Temperature 0.8–1.0. You NEED diversity — at temperature 0 you get the same wrong answer N times and learn nothing."],
      ["Execute every sample through your Phase 3 sandbox", "This is why you built it. Millions of executions; Level 1 speed matters enormously here."],
      ["Keep the passers, discard the rest", "Typically 5–30% survive depending on model and difficulty. That is normal — you are mining, not harvesting."],
      ["Deduplicate the survivors", "Low-temperature sampling produces near-identical solutions. Without dedup, easy problems dominate purely by volume of duplicates."],
      ["Stratify by difficulty when keeping", "Cap the number kept per problem AND per difficulty band. This is the step that prevents difficulty collapse."],
      ["SFT on the resulting dataset", "Exactly the Phase 6 recipe. Same trainer, same config shape, new data version."],
      ["Evaluate, then consider iterating", "The improved model is a better generator. Round 2 mines problems round 1 could not solve."],
    ], { h: 0.66 });
    T.num(s);
  }

  /* ---- N and temperature ---- */
  {
    const s = T.slide("RFT", "Choosing N and temperature — the two knobs that matter");
    T.table(s, 1.4,
      ["Setting", "Effect", "Cost", "Recommendation"],
      [
        ["N = 4", "Few passers; only easy problems yield anything", "Low", "Too few. Difficulty collapse guaranteed."],
        ["N = 10", "Reasonable yield on easy and medium problems", "Moderate", "Good starting point for round 1"],
        ["N = 20–50", "Mines genuinely hard problems", "High", "Use on the hard slice only, not uniformly"],
        ["temp = 0.0", "Identical output N times", "—", "Useless. You get one sample, N times."],
        ["temp = 0.6", "Mild diversity", "—", "Too conservative; wastes the sampling budget"],
        ["temp = 0.8–1.0", "Genuine diversity", "—", "The working range. Start at 0.8."],
        ["temp = 1.2+", "High diversity, more garbage", "—", "Occasionally useful for very hard problems only"],
      ],
      [2.4, 4.1, 1.8, 3.9], { size: 11, rowH: 0.4 });
    T.accentRows(s, 4.5, [
      ["Spend N where it pays", "adaptive sampling", "Give easy problems N=5 and hard problems N=50. Uniform N wastes most of your compute re-solving trivial problems.", C.moss],
      ["Temperature is a diversity dial", "not a quality dial", "You are not trying to generate good code; you are trying to generate VARIED code so the filter has something to choose from.", C.moss],
      ["Yield rate is a difficulty signal", "log it per problem", "Pass rate at fixed N and temperature IS your difficulty label. Compute it once, reuse it everywhere.", C.moss],
    ], { h: 0.7, labelW: 3.0 });
    T.num(s);
  }

  /* ---- Difficulty collapse ---- */
  {
    const s = T.slide("RFT", "Difficulty collapse — the failure that gets everyone");
    s.addChart(pres.ChartType.bar, [
      { name: "Problems in source set", labels: ["Easy", "Medium", "Hard"], values: [30, 40, 30] },
      { name: "Surviving samples (naive RFT)", labels: ["Easy", "Medium", "Hard"], values: [71, 26, 3] },
    ], {
      x: 0.55, y: 1.4, w: 7.0, h: 3.4,
      barDir: "col", barGrouping: "clustered",
      showTitle: true, title: "What survives filtering is not what you started with (%)",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 11, dataLabelColor: C.ink,
      chartColors: [C.lightMoss, C.amber],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 11, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      showLegend: true, legendPos: "b", legendFontFace: BODY, legendFontSize: 10.5,
    });
    T.grid(s, 1.4, [
      ["The mechanism", "Hard problems produce few or no passing samples. Easy problems produce many. So your filtered dataset is overwhelmingly easy — you train on what the model could already do.", C.rust],
      ["The symptom", "Round 2 shows almost no improvement. The model got better at problems it was already solving and learned nothing new.", C.rust],
      ["Fix 1 — cap per problem", "Keep at most k passing samples per problem (k=1–4). Stops one easy problem contributing fifty examples.", C.moss],
      ["Fix 2 — stratified quotas", "Keep a fixed proportion from each difficulty band, even if that means keeping every single hard-problem success.", C.moss],
      ["Fix 3 — adaptive N", "Spend far more samples on hard problems. N=50 on hard, N=5 on easy, same total budget.", C.moss],
    ], { cols: 1, x: 7.75, w: 5.0, h: 0.9, gapY: 0.1 });
    T.fieldNote(s, 0.55, 5.05, 12.2, 1.15,
      "After two naive RFT rounds my model was excellent at problems it had always been fine at, and had made zero progress on " +
      "anything hard. The dataset was 71% easy problems. Stratify your keep-set — it is one line of code and it is the " +
      "difference between RFT working and RFT plateauing.");
    T.num(s);
  }

  /* ---- Filtering strategy ---- */
  {
    const s = T.slide("RFT", "Filtering strategy — what exactly do you keep?");
    T.table(s, 1.4,
      ["Strategy", "What it keeps", "Effect on the model", "When to use"],
      [
        ["All passers", "Every sample that passes", "Maximum volume; easy problems dominate", "Never, without a per-problem cap"],
        ["Best-1 per problem", "Shortest or highest-scoring passer", "Clean, low-volume, low-diversity", "Small datasets; when quality > quantity"],
        ["Top-k per problem (k=2–4)", "k distinct passers", "Balanced. The default.", "Most of the time"],
        ["Diverse-k", "k passers, maximally different", "Preserves solution variety", "When you want to keep pass@10 alive"],
        ["Shortest passer", "Minimum-token correct solution", "Biases toward terse code", "If you want concision; watch for golf"],
        ["Include near-misses", "Solutions passing >80% of tests", "Adds signal on hard problems", "Risky — teaches subtly wrong code"],
      ],
      [2.8, 3.0, 3.6, 2.8], { size: 11, rowH: 0.42 });
    T.accentRows(s, 4.5, [
      ["Do not keep near-misses in RFT", "save it for DPO", "A solution passing 80% of tests is WRONG. Training on it teaches wrong code. It is excellent DPO 'rejected' data though.", C.rust],
      ["Beware the shortest-solution bias", "code golf", "Optimizing for brevity produces unreadable one-liners. If you filter by length, cap it rather than minimizing it.", C.amber],
      ["Dedup after filtering", "not before", "Near-identical passers are extremely common at temperature 0.8. Dedup the survivors or volume lies to you.", C.moss],
    ], { h: 0.7, labelW: 3.2 });
    T.num(s);
  }

  /* ---- Distillation rig ---- */
  {
    const s = T.slide("RFT", "Where your two machines finally earn their keep");
    T.pipeline(s, 1.4, [
      ["MAC — GENERATE", "14B teacher, 4-bit, produces N candidates per problem. Runs overnight.", C.moss],
      ["MAC — VERIFY", "Sandbox executes all candidates. Keeps only verified passers.", C.amber],
      ["MAC — CURATE", "Dedup, stratify, cap per problem, write a new data version.", C.moss],
      ["ASUS — TRAIN", "0.5B student, QLoRA, on the verified set. Twenty minutes.", C.moss],
      ["MAC — EVAL", "Harness scores the student on held-out problems.", C.forest2],
    ], { h: 1.85 });
    T.grid(s, 3.5, [
      ["This is verified distillation", "The student learns the teacher's SUCCESSES and never sees its failures. That filter is what lets a weak teacher train a good student.", C.moss],
      ["Same tokenizer family matters", "Qwen teacher, Qwen student. Different families still work, but shared tokenization makes the distribution transfer cleaner.", C.ink],
      ["The teacher never trains", "It only needs to be occasionally right. All the quality comes from the verifier, not the teacher.", C.moss],
      ["Generation is the bottleneck", "Not training. A 20-minute training run consumes data that took eight hours to generate. Plan around that asymmetry.", C.amber],
    ], { cols: 2, h: 1.3 });
    T.fieldNote(s, 0.55, 6.25, 12.2, 0.9,
      "Kick off generation before bed, curate over coffee, train before lunch, evaluate after. That rhythm is the actual daily loop of this phase.");
    T.num(s);
  }

  /* ---- Iterated RFT ---- */
  {
    const s = T.slide("RFT", "Iterating — STaR-style bootstrapping");
    T.steps(s, 1.4, [
      ["Round 1 — generate with the SFT model", "Mines the problems the Phase 6 model can already occasionally solve. Yields your first RFT dataset."],
      ["Round 2 — generate with the RFT-1 model", "The improved model is a better generator. It now solves problems round 1 could not, so you mine genuinely new material."],
      ["Round 3 — diminishing returns arrive", "Gains typically shrink sharply by round 3. When the new-problems-solved count approaches zero, stop."],
      ["The stopping signal", "Track how many problems yield their FIRST passing sample this round. When that number collapses, iteration is finished — not when eval plateaus."],
    ], { h: 1.05, bottom: 5.62 });
    T.accentRows(s, 5.75, [
      ["The compounding risk", "self-training drift", "Each round trains on the previous round's output. Errors and stylistic quirks compound. The verifier bounds this — but only for correctness, not for style.", C.amber],
      ["Keep the original data", "mix, don't replace", "Always mix RFT data with your Phase 5 curated set. Pure self-generated training drifts toward the model's own idiosyncrasies.", C.moss],
    ], { h: 0.62, labelW: 2.6 });
    T.num(s);
  }

  /* ---- RFT traps ---- */
  {
    T.num(T.ptn("RFT", "Rejection sampling — path and traps",
      [
        "Only use problems that ship with executable tests",
        "Temperature 0.8–1.0. Diversity is the entire point",
        "Adaptive N: few samples on easy, many on hard",
        "Cap kept samples per problem (k=2–4)",
        "Stratify the keep-set by difficulty band",
        "Dedup survivors AFTER filtering",
        "Mix RFT data with your Phase 5 curated set",
        "Track first-time-solved count as the stopping signal",
      ],
      [
        "Temperature 0: N identical samples, zero information",
        "Uniform N: wastes budget re-solving easy problems",
        "Keeping all passers: easy problems drown everything else",
        "No per-problem cap: one problem contributes fifty examples",
        "Skipping dedup: near-identical solutions inflate volume",
        "Keeping near-misses: teaches confidently wrong code",
        "Training purely on self-generated data: style drifts",
        "Iterating past round 3 with no first-time-solved growth",
      ],
      "RFT is the phase that convinces you the self-improvement loop is real. It is also the cheapest place to learn " +
      "difficulty collapse — a failure mode that reappears, harder to see, in Phase 9.",
      { noteH: 1.15 }));
  }

  /* ---- RFT false positives ---- */
  {
    const s = T.slide("RFT", "The RFT false positives");
    T.table(s, 1.4,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Difficulty collapse", "Round 2 barely improves", "Dataset became almost entirely easy problems", "Plot the difficulty histogram of the keep-set"],
        ["Duplicate inflation", "'50k examples' from 3k problems", "Near-identical passers counted as distinct", "Dedup and recount before training"],
        ["Weak-test survivors", "High pass rate, poor real quality", "Problems with shallow tests let wrong code through", "Spot-check passers on hard problems by hand"],
        ["Teacher-style memorization", "Student matches teacher's quirks exactly", "Pure distillation with no original data mixed in", "Mix in curated data; compare style diversity"],
        ["pass@10 rises, pass@1 flat", "'The model improved'", "You increased diversity, not skill", "Always report both k values"],
        ["Contaminated generation", "Suspiciously strong on eval", "Teacher reproduced eval problems it memorized", "Decontaminate generated data too"],
      ],
      [2.8, 3.0, 3.4, 3.0], { size: 10.5, rowH: 0.46 });
    T.fieldNote(s, 0.55, 5.2, 12.2, 1.7,
      "The duplicate one is embarrassing in hindsight. I proudly reported a 50,000-example RFT dataset. After dedup it was " +
      "11,000 — the rest was the same handful of easy solutions sampled repeatedly. The model trained on it was worse than " +
      "the one trained on the deduplicated set, because the effective distribution was dominated by a few trivial problems.");
    T.num(s);
  }
};
