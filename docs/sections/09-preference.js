/* PART IX — PREFERENCE OPTIMIZATION  (Phase 8) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("DPO", "Phase 8", "Learning From Comparisons",
    "One week. SFT teaches what a good answer looks like. Preference optimization\nteaches which of two plausible answers is better — a signal SFT cannot express."));

  /* ---- Why ---- */
  {
    const s = T.slide("DPO", "Why preference learning exists at all");
    s.addText(
      "SFT has a structural blind spot: it only ever sees positive examples. It can tell the model 'produce output like this', " +
      "but it has no way to say 'this is better than that', and no way at all to say 'never do this'.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.compare(s, 2.25, 2.6,
      { title: "SFT CAN EXPRESS", items: [
        "This is a correct solution",
        "This is the format I want",
        "This is the style I want",
        "(one target per prompt, nothing else)",
      ]},
      { title: "SFT CANNOT EXPRESS", items: [
        "This is better than that — both are valid",
        "Never do this, even though it is plausible",
        "Prefer terse when both are correct",
        "Degrees of wrongness",
      ]}
    );
    T.grid(s, 5.15, [
      ["For code, this matters less than you think", "You have a verifier. Correctness is already handled by execution. Preference optimization is for everything that is NOT correctness.", C.amber],
      ["Where it earns its place", "Choosing between two correct solutions. Suppressing verbose padding. Teaching failure avoidance from your RFT rejects.", C.moss],
      ["Where the free data is", "Phase 7 threw away every failing sample. Those are your 'rejected' side. The pairs cost you nothing.", C.moss],
    ], { cols: 3, h: 1.35 });
    T.fieldNote(s, 0.55, 6.65, 12.2, 0.6,
      "Set expectations: in a verifiable domain, DPO usually gives a smaller gain than RFT did. Its value is control, not raw capability.");
    T.num(s);
  }

  /* ---- Bradley-Terry / reward models ---- */
  {
    const s = T.slide("DPO", "The classical path — reward models and PPO");
    T.pipeline(s, 1.4, [
      ["COLLECT", "Humans compare pairs of outputs. Expensive, slow, noisy.", C.muted],
      ["TRAIN RM", "Fit a reward model on those comparisons via Bradley-Terry.", C.muted],
      ["PPO", "RL against the reward model, with a KL leash to the reference.", C.muted],
      ["PRAY", "Four models in memory, unstable, reward hacking against the RM.", C.rust],
    ], { h: 1.6 });
    T.codeBlock(s, 0.55, 3.25, 6.5, 1.55, [
      { t: "# Bradley-Terry: the probability A beats B", c: C.moss },
      "P(A > B) = sigmoid( r(A) - r(B) )",
      "",
      { t: "# Reward model loss over human comparisons:", c: C.moss },
      "L_RM = -log sigmoid( r(chosen) - r(rejected) )",
    ]);
    T.grid(s, 3.25, [
      ["Four models in memory", "Policy, reference, reward model, value model. On a 4GB card this is not merely impractical — it is impossible.", C.rust],
      ["The reward model is hackable", "The policy learns to exploit the RM's blind spots rather than to satisfy the underlying preference. A whole research literature exists on this.", C.rust],
      ["Read it, do not build it", "Understand PPO conceptually. Implementing it is a month you should spend on data and reward design instead.", C.amber],
    ], { cols: 1, x: 7.25, w: 5.5, h: 0.95, gapY: 0.1 });
    T.banner(s, 6.4, "DPO's contribution: it proves you can skip the reward model AND the rollouts entirely.", C.moss);
    T.num(s);
  }

  /* ---- DPO insight ---- */
  {
    const s = T.slide("DPO", "DPO — the key insight");
    s.addText(
      "The optimal policy under a KL-constrained reward objective has a closed form. Invert it, and the reward is expressible " +
      "in terms of the policy itself. So you can optimize the policy directly on preference pairs — no reward model, no sampling loop.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.75, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.codeBlock(s, 0.55, 2.25, 7.2, 2.9, [
      { t: "# The implicit reward — the policy IS the reward model", c: C.moss },
      "r(x, y)  =  beta * log( pi(y|x) / pi_ref(y|x) )",
      "",
      { t: "# The DPO loss on a preference pair (chosen yw, rejected yl):", c: C.moss },
      "L = -log sigmoid( beta * [",
      "        log(pi(yw|x) / pi_ref(yw|x))",
      "      - log(pi(yl|x) / pi_ref(yl|x))",
      "    ] )",
      "",
      { t: "# Two models in memory, not four. No rollouts.", c: C.moss, b: true },
      "# pi_ref is FROZEN — it is your Phase 7 checkpoint.",
    ], "THE SUBSTITUTION");
    T.grid(s, 2.25, [
      ["Two models, not four", "Policy and frozen reference. With LoRA you do not even need two copies — disable the adapter to get the reference. Fits on 4GB comfortably.", C.moss],
      ["No sampling during training", "The pairs are precomputed. Training is as fast and as stable as SFT.", C.moss],
      ["Stable relative to PPO", "No rollout variance, no value function to diverge. It is a supervised loss on a clever objective.", C.moss],
      ["The catch: it is off-policy", "Pairs come from an older model. As the policy moves away from the data, the signal degrades — the core limitation.", C.amber],
    ], { cols: 1, x: 7.95, w: 4.8, h: 0.86, gapY: 0.1 });
    T.num(s);
  }

  /* ---- beta ---- */
  {
    const s = T.slide("DPO", "Beta and the reference model");
    T.table(s, 1.4,
      ["beta", "Behavior", "Symptom", "Use when"],
      [
        ["0.01", "Very weak leash", "Drifts far from reference; can lose syntax validity", "Almost never"],
        ["0.05", "Loose", "Strong preference learning, some drift risk", "Large, high-quality pair sets"],
        ["0.1", "Balanced — the default", "Healthy margin growth, controlled drift", "Start here"],
        ["0.3", "Tight", "Slow, conservative learning", "Small or noisy pair sets"],
        ["0.5+", "Very tight", "Barely moves from reference", "When DPO is destabilizing everything"],
      ],
      [1.2, 3.4, 3.9, 3.7], { size: 11, rowH: 0.44 });
    T.accentRows(s, 4.05, [
      ["The reference is your Phase 7 model", "not the base model", "Always the immediately preceding checkpoint. Using the original base as reference means fighting all of your prior training.", C.rust],
      ["With LoRA, reference is free", "disable the adapter", "TRL computes reference logprobs by turning the adapter off. No second model in memory. This is why DPO fits on 4GB.", C.moss],
      ["Watch the implicit reward margin", "log it every step", "chosen_rewards minus rejected_rewards. It should rise and then plateau. If it explodes, beta is too low.", C.moss],
      ["Watch reference KL", "log it every step", "If KL from reference grows without bound, you are drifting. Raise beta or stop earlier.", C.moss],
    ], { h: 0.68, labelW: 3.3 });
    T.num(s);
  }

  /* ---- Building pairs ---- */
  {
    const s = T.slide("DPO", "Constructing preference pairs for code — where you have an unfair advantage");
    T.table(s, 1.4,
      ["Pair source", "Chosen", "Rejected", "Quality of signal"],
      [
        ["Execution outcome (free!)", "Passes all tests", "Fails tests", "Excellent — objective, zero labeling"],
        ["Partial credit", "Passes 100%", "Passes 60–90%", "Very good — 'nearly right' is a strong negative"],
        ["Efficiency", "Passes, fewer ops", "Passes, brute force", "Good — needs a benchmark harness"],
        ["Length (both correct)", "Concise correct", "Verbose correct", "Good — directly counters verbosity bias"],
        ["Style / idiom", "Idiomatic", "Non-idiomatic", "Needs a judge; subjective"],
        ["Teacher vs student", "Teacher output", "Student output", "Risky — teaches imitation, not correctness"],
        ["Human annotation", "Human-preferred", "Human-rejected", "Best signal, worst throughput"],
      ],
      [3.2, 2.8, 3.0, 3.2], { size: 11, rowH: 0.4 });
    T.banner(s, 4.5, "Phase 7 threw away every FAILING sample. Those are your rejected side. Your preference dataset already exists.", C.moss);
    T.accentRows(s, 5.3, [
      ["Pair within a problem", "same prompt, both sides", "Chosen and rejected must answer the SAME prompt. Cross-problem pairs teach ranking of problems, not quality of solutions.", C.rust],
      ["Balance the difficulty", "or easy dominates again", "Same collapse as Phase 7: easy problems generate the most pairs. Stratify.", C.amber],
    ], { h: 0.64, labelW: 2.7 });
    T.num(s);
  }

  /* ---- Variants ---- */
  {
    const s = T.slide("DPO", "The DPO family — what each variant fixes");
    T.table(s, 1.4,
      ["Method", "Data needed", "Reference model?", "What it fixes / adds"],
      [
        ["DPO", "Pairs (chosen, rejected)", "Yes", "The baseline. Simple, well understood, well supported."],
        ["IPO", "Pairs", "Yes", "DPO overfits when preferences are deterministic; IPO regularizes against that."],
        ["KTO", "BINARY labels (good/bad)", "Yes", "No pairs needed. Matches how real production feedback actually arrives."],
        ["ORPO", "Pairs", "NO", "Folds SFT and preference into one stage. One model, one run, no reference."],
        ["SimPO", "Pairs", "NO", "Reference-free, length-normalized. Directly attacks verbosity bias."],
        ["CPO", "Pairs", "NO", "Contrastive variant; memory-efficient, close to ORPO in spirit."],
      ],
      [1.9, 3.4, 2.3, 4.6], { size: 11, rowH: 0.46 });
    T.grid(s, 4.35, [
      ["Learn DPO first", "It is the reference point every other method is described against. Understand beta and the implicit reward before you touch a variant.", C.moss],
      ["KTO is the practical one", "Real feedback is thumbs-up/thumbs-down, not ranked pairs. KTO consumes that directly. If you ever ship a product, this is the one you will use.", C.moss],
      ["ORPO saves a stage", "SFT and preference in one pass, no reference model. Attractive when compute is tight — which it is.", C.moss],
      ["SimPO for verbosity", "If DPO inflates your output length badly, SimPO's length normalization addresses it at the loss level rather than by prompting.", C.moss],
    ], { cols: 2, h: 1.25 });
    T.fieldNote(s, 0.55, 6.05, 12.2, 0.9,
      "Run DPO, then KTO on the same data converted to binary, then ORPO from the Phase 6 checkpoint. Three runs, one afternoon, and you will genuinely understand the family.");
    T.num(s);
  }

  /* ---- Verbosity ---- */
  {
    const s = T.slide("DPO", "Verbosity bias — the defect you WILL hit");
    s.addChart(pres.ChartType.bar, [
      { name: "Mean output length (lines)", labels: ["Base", "After SFT", "After RFT", "After DPO"], values: [38, 41, 44, 96] },
    ], {
      x: 0.55, y: 1.4, w: 6.9, h: 3.3,
      barDir: "col",
      showTitle: true, title: "Output length across phases — DPO is the discontinuity",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 12, dataLabelColor: C.ink,
      chartColors: [C.lightMoss, C.lightMoss, C.moss, C.rust],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 11, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      showLegend: false,
    });
    T.grid(s, 1.4, [
      ["Why it happens", "Longer sequences accumulate more log-probability terms. The DPO objective has a structural preference for length that has nothing to do with quality.", C.rust],
      ["What it looks like in code", "Defensive try/except around everything, redundant comments, unnecessary helper functions, docstrings restating the signature.", C.rust],
      ["Fix 1 — length-matched pairs", "Ensure chosen and rejected have similar length. Removes the confound at the data level.", C.moss],
      ["Fix 2 — SimPO", "Length-normalized loss. Attacks it directly rather than through data curation.", C.moss],
      ["Fix 3 — length in the pairs", "Deliberately include (concise correct, verbose correct) pairs to teach the preference explicitly.", C.moss],
    ], { cols: 1, x: 7.75, w: 5.0, h: 0.88, gapY: 0.1 });
    T.fieldNote(s, 0.55, 4.95, 12.2, 1.25,
      "41 lines to 96 after DPO, almost entirely comments and defensive error handling. pass@1 rose 0.4 points. I had trained a " +
      "model to LOOK thorough. Log mean output length on every single run — it is one number and it catches this instantly.");
    T.num(s);
  }

  /* ---- On/off policy ---- */
  {
    const s = T.slide("DPO", "On-policy vs off-policy — the core limitation");
    T.compare(s, 1.4, 3.0,
      { title: "OFF-POLICY (standard DPO)", items: [
        "Pairs generated once, before training",
        "As the policy moves, the data becomes stale",
        "Cheap: one generation pass, then pure supervised training",
        "Gains plateau quickly — usually within one epoch",
        "This is what TRL's DPOTrainer does by default",
      ]},
      { title: "ON-POLICY (iterative DPO)", items: [
        "Regenerate pairs from the CURRENT policy periodically",
        "Data always reflects what the model actually produces now",
        "Expensive: generation + verification every N steps",
        "Larger total gains; approaches what RL achieves",
        "Conceptually a bridge toward GRPO in Phase 9",
      ]}
    );
    T.accentRows(s, 4.65, [
      ["Do 2–3 rounds of iterative DPO", "generate, train, regenerate", "Each round: sample from the current policy, verify, build fresh pairs, train. The gain over single-shot DPO is substantial.", C.moss],
      ["This is why GRPO exists", "fully on-policy", "GRPO takes iterative DPO to its limit — regenerate every step. Understanding that continuum makes Phase 9 far less mysterious.", C.moss],
    ], { h: 0.68, labelW: 3.3 });
    T.num(s);
  }

  /* ---- Config ---- */
  {
    const s = T.slide("DPO", "The DPO config, annotated");
    T.codeBlock(s, 0.55, 1.4, 12.2, 4.0, [
      "from trl import DPOTrainer, DPOConfig",
      "",
      "cfg = DPOConfig(",
      "    output_dir='ckpt/08-dpo-b0.1',",
      { t: "    beta=0.1,                        # the leash. Start here.", c: C.moss },
      { t: "    learning_rate=5e-6,              # 40x LOWER than SFT. Not a typo.", c: C.rust, b: true },
      "    lr_scheduler_type='cosine', warmup_ratio=0.1,",
      "    per_device_train_batch_size=1,",
      "    gradient_accumulation_steps=16,",
      { t: "    num_train_epochs=1,              # DPO overfits fast. One epoch.", c: C.moss },
      "    max_length=1024, max_prompt_length=512,",
      "    bf16=True, gradient_checkpointing=True,",
      "    optim='paged_adamw_8bit',",
      { t: "    loss_type='sigmoid',             # 'ipo' | 'kto_pair' | 'simpo' here", c: C.moss },
      "    eval_strategy='steps', eval_steps=50,",
      "    seed=0, report_to='wandb',",
      ")",
      "",
      { t: "# ref_model=None -> TRL disables the LoRA adapter to get reference logprobs.", c: C.moss },
      { t: "# One model in memory. This is what makes DPO viable on 4GB.", c: C.moss },
      "trainer = DPOTrainer(model=model, ref_model=None, args=cfg,",
      "                     train_dataset=pairs, peft_config=peft_config)",
    ], "dpo.py");
    T.banner(s, 5.6, "The learning rate is the thing people get wrong. SFT uses 2e-4; DPO uses 5e-6. Copying the SFT LR destroys the model in fifty steps.", C.rust);
    T.num(s);
  }

  /* ---- Traps ---- */
  {
    T.num(T.ptn("DPO", "Preference optimization — path and traps",
      [
        "Build pairs from Phase 7 execution outcomes — they are free",
        "Chosen and rejected must answer the SAME prompt",
        "beta = 0.1, LR = 5e-6, ONE epoch",
        "Reference model is your Phase 7 checkpoint, not the base",
        "With LoRA, ref_model=None — TRL disables the adapter",
        "Log implicit reward margin, reference KL, and output length",
        "Do 2–3 iterative rounds, regenerating pairs each time",
        "Try KTO and ORPO on the same data to understand the family",
      ],
      [
        "SFT learning rate (2e-4): destroys the model within ~50 steps",
        "Multiple epochs: DPO overfits preference data very fast",
        "Cross-problem pairs: teaches problem ranking, not solution quality",
        "Base model as reference: fights all your prior training",
        "Not logging output length: verbosity bias goes unnoticed for weeks",
        "beta too low: policy drifts and loses basic syntax validity",
        "Judging with an LLM when you have a verifier available",
        "Expecting RFT-sized gains: in verifiable domains DPO gives less",
      ],
      "DPO is where the numbers start moving less and the failure modes start getting subtler. Its real value here is " +
      "control over things your verifier cannot express — and understanding the on-policy/off-policy continuum that leads directly into GRPO.",
      { noteH: 1.25, size: 11.8 }));
  }

  /* ---- False positives ---- */
  {
    const s = T.slide("DPO", "The preference-optimization false positives");
    T.table(s, 1.4,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Verbosity bias", "Judge scores up, pass@1 flat", "Model learned that longer looks better", "Log mean output length every run"],
        ["Judge-verifier divergence", "LLM-judge loves it, tests disagree", "You optimized for the judge's preferences", "Verifier is truth; judge is advisory only"],
        ["Margin without capability", "Reward margin climbs beautifully", "Model separates the pairs it trained on, nothing more", "Held-out pass@1, not training margin"],
        ["Reference drift", "Early gains, then degradation", "beta too low; policy wandered off", "Log KL from reference; raise beta"],
        ["Overfit in one epoch", "Best checkpoint is at step 80 of 400", "DPO saturates fast on small pair sets", "Evaluate every 50 steps, not per epoch"],
        ["Easy-problem dominance", "Great on easy, unchanged on hard", "Pair set inherited Phase 7's difficulty collapse", "Difficulty histogram of the pair set"],
        ["Style over substance", "Output looks more professional", "Learned formatting cues, not correctness", "pass@1 is the arbiter, not appearance"],
      ],
      [2.7, 3.0, 3.4, 3.1], { size: 10.5, rowH: 0.45 });
    T.banner(s, 5.05, "The pattern repeats: every one of these makes some number go up. Only held-out pass@1 is not fooled.", C.rust);
    T.num(s);
  }
};
