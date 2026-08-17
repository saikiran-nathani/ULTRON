/* PART VI — DATA  (Phase 5) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("DATA", "Phase 5", "The Work That Actually Matters",
    "Two to three weeks, and the highest-leverage time you will spend on this project.\nEverything downstream is bounded by what you build here."));

  /* ---- Pipeline ---- */
  {
    const s = T.slide("Data", "The pipeline, end to end");
    T.pipeline(s, 1.4, [
      ["ACQUIRE", "Download raw corpora. Never modify. Record provenance and license.", C.moss],
      ["DECONTAM", "Remove anything overlapping your eval sets. Do this FIRST and again after every change.", C.rust],
      ["DEDUP", "Exact, then near-dup, then semantic. Before splitting, never after.", C.moss],
      ["FILTER", "Heuristics, AST validity, classifier, judge. Aggressive beats permissive.", C.moss],
      ["FORMAT", "Chat template, loss mask, tokenize. Verify by decoding one example.", C.moss],
      ["VERSION", "Tag it v1..vN. Immutable. Referenced by every config.", C.forest2],
    ], { h: 1.85 });
    T.banner(s, 3.5, "Order matters: decontaminate before dedup, dedup before split, filter before format. Getting this order wrong invalidates results silently.", C.rust);
    T.grid(s, 4.35, [
      ["Every stage writes a new directory", "raw/ → interim/decontam/ → interim/dedup/ → interim/filtered/ → processed/v3/. Disk is cheap; a broken provenance chain costs you a week.", C.moss],
      ["Every stage logs its removal count", "'Removed 41 contaminated, 12,308 near-dup, 4,102 invalid AST.' These numbers are findings, not bookkeeping.", C.moss],
      ["Every stage is re-runnable", "One script per stage, idempotent, reading from the previous directory. You will re-run these many times.", C.moss],
    ], { cols: 3, h: 1.5 });
    T.fieldNote(s, 0.55, 6.05, 12.2, 0.95,
      "I did dedup before decontamination once. Deduplication removed the duplicate copies of contaminated problems, so my " +
      "n-gram check found fewer hits and I concluded the data was clean. It was not.");
    T.num(s);
  }

  /* ---- Sources: raw code ---- */
  {
    const s = T.slide("Data", "Sources — raw code corpora");
    T.table(s, 1.4,
      ["Corpus", "Scale", "License posture", "What it is for"],
      [
        ["The Stack v2 (BigCode)", "Hundreds of B tokens, 600+ langs", "Permissive-only, opt-out honored", "Continued pretraining, FIM, synthetic seed material"],
        ["The Stack v2 'smol'", "Sampled subset", "Same", "Prototyping the pipeline without 200GB downloads"],
        ["CommitPack / CommitPackFT", "~4TB raw / filtered subset", "Permissive", "Commit message → diff pairs. Natural instruction data."],
        ["GitHub Code (various mirrors)", "Varies", "Varies wildly — check", "Generally avoid; provenance is often unclear"],
      ],
      [3.2, 3.0, 2.9, 3.1], { size: 11, rowH: 0.46 });
    T.grid(s, 3.65, [
      ["You probably do not need raw code", "For instruction tuning, curated instruction datasets beat raw code. Raw corpora matter for continued pretraining and for generating synthetic data — both later concerns.", C.amber],
      ["Download a language subset", "The Stack v2 filtered to Python is a few tens of GB. The whole thing is not something you want on a laptop.", C.moss],
      ["Opt-out is a moving target", "Developers can request removal. A corpus you downloaded a year ago may contain code its author has since withdrawn.", C.amber],
    ], { cols: 3, h: 1.55 });
    T.fieldNote(s, 0.55, 5.4, 12.2, 1.4,
      "I downloaded 180GB of The Stack in week one because it felt like the serious thing to do. I used approximately none of it " +
      "for the next two months. Start with instruction datasets — they are 5GB and they are what you actually train on first.");
    T.num(s);
  }

  /* ---- Sources: instruction ---- */
  {
    const s = T.slide("Data", "Sources — instruction datasets (what you actually train on)");
    T.table(s, 1.4,
      ["Dataset", "Size", "How it was made", "Quality"],
      [
        ["Magicoder OSS-Instruct", "~75k", "LLM invents a problem from a REAL open-source snippet", "High — grounded in real code, not imagined"],
        ["Magicoder Evol-Instruct", "~110k", "Iteratively complexified seed instructions", "High, but complexity can become artificial"],
        ["Evol-Instruct-Code (WizardCoder)", "~80k", "Depth + breadth evolution of seed prompts", "Good; some degenerate over-complex examples"],
        ["Glaive Code Assistant", "~140k", "Synthetic assistant dialogues", "Mixed — useful volume, uneven quality"],
        ["OpenCoder datasets", "Large", "Curated pipeline, well documented", "Good; read their filtering paper"],
        ["CodeAlpaca", "~20k", "Self-Instruct from GPT-3.5, 2023", "Low by modern standards — useful as a NEGATIVE control"],
        ["self-oss-instruct-sc2", "~50k", "StarCoder2 self-generated, verified", "Good; fully open provenance"],
      ],
      [3.3, 1.4, 4.3, 3.2], { size: 10.5, rowH: 0.42 });
    T.banner(s, 4.85, "Start with Magicoder OSS-Instruct. Add CodeAlpaca deliberately as your 'bad data' control for the Phase 5 ablation.", C.moss);
    T.fieldNote(s, 0.55, 5.65, 12.2, 1.3,
      "Having a known-bad dataset on hand is genuinely useful. When curated-10k beats CodeAlpaca-20k by nine points, you have " +
      "a concrete demonstration of why data quality dominates — and you will need that conviction when curation gets tedious.");
    T.num(s);
  }

  /* ---- Sources: problems with tests ---- */
  {
    const s = T.slide("Data", "Sources — problems WITH tests (your RLVR goldmine)");
    s.addText(
      "These are different from instruction datasets and far more valuable later. A problem shipped with executable test cases " +
      "is a training signal you can verify — which is what makes Phases 7 through 9 possible at all.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.table(s, 2.2,
      ["Dataset", "Problems", "Tests included", "Difficulty", "Used in"],
      [
        ["CodeContests (DeepMind)", "~13.5k", "Yes, extensive", "Competitive programming — hard", "RFT, GRPO"],
        ["APPS", "10,000", "Yes", "Interview → competition, graded", "RFT, GRPO, stratified eval"],
        ["TACO", "~26k", "Yes", "Algorithmic, varied", "GRPO at volume"],
        ["MBPP (train split)", "~600", "Yes", "Basic", "Warm-up, sanity checks"],
        ["HumanEval / MBPP test", "164 / 378", "Yes", "Mixed", "EVAL ONLY — never train on these"],
      ],
      [3.1, 1.6, 2.4, 3.3, 1.8], { size: 11, rowH: 0.44 });
    T.banner(s, 4.7, "HumanEval and MBPP test splits are EVAL ONLY. Training on them is the contamination that invalidates everything.", C.rust);
    T.grid(s, 5.5, [
      ["Test quality varies", "Some CodeContests tests are weak. Your model will find that out before you do.", C.amber],
      ["Difficulty stratification is free", "APPS ships difficulty labels. Use them — they prevent the difficulty collapse you hit in Phase 7.", C.moss],
      ["Volume matters for RL", "GRPO burns through problems. 13k+ is a comfortable floor.", C.moss],
    ], { cols: 3, h: 1.15 });
    T.num(s);
  }

  /* ---- Licensing ---- */
  {
    const s = T.slide("Data", "Licensing and provenance — ten minutes now, or a rewrite later");
    T.accentRows(s, 1.4, [
      ["Dataset license ≠ model license", "two separate grants", "You need permission to TRAIN on the data and permission to USE the base model's weights. They are different documents with different terms.", C.rust],
      ["Teacher-output terms", "distillation restrictions", "Most commercial API providers prohibit using outputs to train competing models. Check before you distill from anything hosted.", C.rust],
      ["Copyleft contamination", "GPL in training data", "The legal status of training on copyleft code is genuinely unsettled. The Stack's permissive-only filter exists for this reason.", C.amber],
      ["Attribution requirements", "some licenses require it", "If you publish an adapter trained on attribution-required data, you may owe attribution. Record sources now, not later.", C.amber],
      ["Opt-out honoring", "am-I-in-the-stack", "Developers can withdraw. Using a stale snapshot means using code someone asked to have removed.", C.amber],
      ["Record everything", "a provenance manifest", "One JSON per raw dataset: URL, license, download date, SHA. Takes five minutes, answers every future question.", C.moss],
    ], { h: 0.8, labelW: 3.4, bottom: 6.28 });
    T.fieldNote(s, 0.55, 6.4, 12.2, 0.85,
      "This is not legal advice and I am not a lawyer. But recording provenance costs nothing and not recording it can cost you the whole project.");
    T.num(s);
  }

  /* ---- Schema ---- */
  {
    const s = T.slide("Data", "Schema design — decide this once, live with it for months");
    T.codeBlock(s, 0.55, 1.4, 6.7, 4.6, [
      "{",
      { t: "  \"id\": \"ossinstruct-000123\",        # stable, unique", c: C.moss },
      "  \"messages\": [",
      "    {\"role\": \"user\", \"content\": \"Write a...\"},",
      "    {\"role\": \"assistant\", \"content\": \"def f(...\"}",
      "  ],",
      "",
      { t: "  # provenance — never drop these", c: C.moss },
      "  \"source\": \"magicoder-oss-instruct\",",
      "  \"source_url\": \"hf://ise-uiuc/...\",",
      "  \"license\": \"mit\",",
      "",
      { t: "  # computed during curation", c: C.moss },
      "  \"n_tokens\": 412,",
      "  \"ast_valid\": true,",
      "  \"lang\": \"python\",",
      "  \"difficulty\": \"medium\",",
      "  \"category\": [\"recursion\", \"strings\"],",
      "  \"quality_score\": 0.83,",
      "",
      { t: "  # dedup / decontam bookkeeping", c: C.moss },
      "  \"content_hash\": \"a3f9...\",",
      "  \"minhash_cluster\": 8812,",
      "  \"contaminated\": false",
      "}",
    ], "ONE TRAINING RECORD");
    T.grid(s, 1.4, [
      ["Keep provenance forever", "When you later discover a source was contaminated or badly licensed, you need to find and remove exactly those records. Without source tags you re-run everything.", C.rust],
      ["Compute-once fields", "n_tokens, ast_valid, difficulty. Expensive to compute, cheap to store. Never recompute them in the training loop.", C.moss],
      ["messages, not prompt/completion", "The chat-template format is the universal one. Converting later is painful; starting there is free.", C.moss],
      ["Stable ids", "You will want to trace one bad generation back to one training record. Random ids make that impossible.", C.moss],
      ["Flags, not deletions", "Mark contaminated: true rather than dropping the row. You keep the count, and you can revisit the threshold.", C.moss],
    ], { cols: 1, x: 7.45, w: 5.3, h: 0.92, gapY: 0.1 });
    T.num(s);
  }

  /* ---- Loss masking ---- */
  {
    const s = T.slide("Data", "Loss masking — the silent bug that costs everyone a week",
      "You want the model to learn to WRITE the answer, not to PREDICT THE QUESTION.");
    T.codeBlock(s, 0.55, 1.68, 7.0, 3.1, [
      { t: "# tokens:  <|im_start|>user  Write a fn...  <|im_end|>", c: C.muted },
      { t: "# labels:      -100  -100      -100  -100     -100      <- MASKED", c: C.amber },
      { t: "# tokens:  <|im_start|>assistant  def f():  ...  <|im_end|>", c: C.muted },
      { t: "# labels:      -100  -100         3251  ...  151645      <- LEARNED", c: C.moss },
      "",
      { t: "# VERIFY IT. Every new dataset. Ninety seconds.", c: C.moss, b: true },
      "batch = next(iter(dataloader))",
      "ids, labels = batch['input_ids'][0], batch['labels'][0]",
      "for i, l in zip(ids, labels):",
      "    mark = '.' if l == -100 else 'LEARN'",
      "    print(f'{mark:6} {tok.decode([i])!r}')",
      "",
      { t: "# You should see '.' for the whole prompt,", c: C.muted },
      { t: "# and 'LEARN' starting exactly at the assistant content.", c: C.muted },
    ], "WHAT CORRECT MASKING LOOKS LIKE");
    T.grid(s, 1.68, [
      ["Symptom of getting it wrong", "Loss falls beautifully. Instruction-following gets measurably worse. You have taught the model to generate plausible user questions.", C.rust],
      ["TRL does this for you", "SFTTrainer with a DataCollatorForCompletionOnlyLM handles it — IF you pass the correct response template string. Get that string wrong and masking silently does nothing.", C.amber],
      ["Multi-turn is harder", "With several assistant turns, EVERY assistant span must be unmasked and every user span masked. Off-by-one errors here are common.", C.amber],
      ["EOS must stay unmasked", "If EOS falls inside the masked region, the model never learns to stop. This is the endless-generation bug from Phase 2.", C.rust],
    ], { cols: 1, x: 7.75, w: 5.0, h: 0.86, gapY: 0.1 });
    T.fieldNote(s, 0.55, 5.0, 12.2, 1.25,
      "Three days of training with loss over the prompt tokens too. Everything ran, loss went down, and the model got worse at " +
      "following instructions because I was teaching it to predict my questions. Decode one batch and look at the labels. " +
      "I now do this on every new dataset without exception.");
    T.num(s);
  }

  /* ---- Decontamination: method ---- */
  {
    const s = T.slide("Data", "Decontamination — the n-gram method");
    T.steps(s, 1.4, [
      ["Build the contaminant set", "Every eval problem you will ever report: HumanEval, HumanEval+, MBPP, MBPP+, your custom set. Include prompts AND reference solutions AND test code."],
      ["Normalize aggressively", "Lowercase, strip comments, collapse whitespace, normalize string literals. Contamination often survives cosmetic differences."],
      ["Extract n-grams", "13-gram is the common threshold, inherited from GPT-3. Shorter catches more but false-positives on boilerplate; longer misses paraphrases."],
      ["Index and match", "Build a set of eval n-grams. For each training record, flag it if it shares any n-gram with the contaminant set."],
      ["Flag, count, and remove", "Write contaminated: true. Log the count per source dataset. THAT COUNT IS A FINDING — it tells you which sources to distrust."],
      ["Re-run after every data change", "Especially after synthetic generation, which can regenerate contaminated content from a contaminated model."],
    ], { h: 0.88, bottom: 6.38 });
    T.banner(s, 6.5, "13-gram overlap is a floor, not a ceiling. It catches copies. It does not catch paraphrases.", C.amber);
    T.num(s);
  }

  /* ---- Decontamination: code-specific ---- */
  {
    const s = T.slide("Data", "Decontamination — the code-specific signals n-grams miss");
    T.accentRows(s, 1.4, [
      ["Function-name match", "def has_close_elements", "HumanEval function names are distinctive. An exact name match is near-certain contamination even with a completely rewritten body.", C.rust],
      ["Docstring similarity", "embedding cosine > 0.9", "The problem statement paraphrased is still the problem. n-grams miss it entirely; embeddings catch it.", C.rust],
      ["Test-case value match", "the literal assert values", "If a training example contains the exact input/output pairs from an eval test, it is contaminated regardless of surrounding text.", C.rust],
      ["AST structural match", "normalized parse tree", "Rename every variable and n-grams see nothing. The AST shape is unchanged. Hash normalized ASTs to catch this.", C.amber],
      ["Solution-approach match", "same algorithm, diff names", "The hardest case and the one you will not fully solve. Accept residual contamination; measure it against LiveCodeBench.", C.amber],
      ["Synthetic regeneration", "teacher saw the eval too", "Your teacher model may reproduce eval problems from ITS training data. Decontaminate synthetic output, not just downloaded data.", C.rust],
    ], { h: 0.8, labelW: 3.3, bottom: 6.28 });
    T.fieldNote(s, 0.55, 6.4, 12.2, 0.85,
      "41 HumanEval problems verbatim in a popular instruction dataset. pass@1 dropped 5.1 points after removal — and that drop was the most valuable number I produced that month.");
    T.num(s);
  }

  /* ---- Dedup ladder ---- */
  {
    const s = T.slide("Data", "Deduplication — the three-rung ladder");
    T.steps(s, 1.4, [
      ["Exact — content hash", "SHA256 of normalized content. Catches literal copies, which are more common than you expect because datasets are assembled from overlapping sources. Milliseconds. Always do this first."],
      ["Near-duplicate — MinHash + LSH", "Estimates Jaccard similarity between token shingles without pairwise comparison. Threshold ~0.8. This is where the bulk of redundancy actually lives. Use datasketch."],
      ["Semantic — embedding similarity", "Encode with a code embedding model, cluster by cosine. Catches the same solution with different names and formatting. Expensive; run it last, on the already-reduced set."],
    ], { h: 1.25 });
    T.codeBlock(s, 0.55, 5.35, 12.2, 1.55, [
      { t: "# MinHash near-dup, the practical version", c: C.moss },
      "from datasketch import MinHash, MinHashLSH",
      "lsh = MinHashLSH(threshold=0.8, num_perm=128)",
      "for rec in records:",
      "    m = MinHash(num_perm=128)",
      "    for shingle in shingles(rec['text'], k=5):   # 5-token shingles",
      "        m.update(shingle.encode())",
      "    if lsh.query(m): rec['dup'] = True      # near-duplicate of something already seen",
      "    else: lsh.insert(rec['id'], m)",
    ]);
    T.num(s);
  }

  /* ---- Dedup: why it matters ---- */
  {
    const s = T.slide("Data", "Why deduplication matters more than it sounds");
    T.grid(s, 1.4, [
      ["Duplicates are implicit upweighting", "An example appearing 50 times is trained on 50x. You did not choose that weighting — the dataset assembly process did, arbitrarily.", C.rust],
      ["It inflates your eval", "If a near-duplicate straddles your train/eval split, you are evaluating on training data. This is the #1 cause of 'great val, terrible reality'.", C.rust],
      ["It wastes your tiny compute budget", "On a 4GB card every gradient step is precious. Spending 30% of them on redundancy is a 30% cut to your effective budget.", C.amber],
      ["It causes memorization, not learning", "Repeated exposure to identical text drives verbatim memorization — exactly the failure mode you are trying to avoid.", C.rust],
      ["DEDUP BEFORE SPLITTING", "Split first and duplicates land on both sides. This is the single most common ordering mistake in the whole pipeline.", C.rust],
      ["Log the reduction", "'100k → 68k after near-dup at 0.8'. That number belongs in results/. It is often the biggest single finding of the phase.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.35, "Order: decontaminate → dedup → split → filter. Any other order leaks something somewhere.", C.rust);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "31% near-duplicate in my first assembled dataset. After dedup, the same compute budget produced a model 2.4 points better — " +
      "not because I changed anything about training, but because a third of it had been redundant.");
    T.num(s);
  }

  /* ---- Quality filters ---- */
  {
    const s = T.slide("Data", "Quality filters — cheap to expensive");
    T.table(s, 1.4,
      ["Filter", "Cost", "Typically removes", "What it catches"],
      [
        ["Length bounds", "Free", "2–5%", "Truncated fragments, single-line non-answers, 10k-token dumps"],
        ["ast.parse() validity", "~0.1ms", "3–8%", "Code that does not compile. Astonishingly common."],
        ["Language detection", "Fast", "1–3%", "Wrong-language records in a Python-only set"],
        ["Non-answer patterns", "Free regex", "1–2%", "'I cannot help with that', 'Here is the code:' with no code"],
        ["Comment/code ratio", "Fast", "1–3%", "Pure-prose records masquerading as code examples"],
        ["Prompt/response overlap", "Fast", "1–2%", "Response that merely echoes the prompt"],
        ["Reward-model / classifier score", "Moderate (GPU)", "10–25%", "Low-quality-but-valid examples. Needs a trained scorer."],
        ["LLM-as-judge scoring", "Expensive", "15–30%", "Subtle quality: correctness, idiom, helpfulness"],
        ["Execution verification", "Expensive", "varies", "The gold standard — does the code actually WORK"],
      ],
      [3.4, 2.0, 2.2, 4.6], { size: 10.5, rowH: 0.395 });
    T.banner(s, 5.35, "Run them in cost order. Every cheap filter you apply first reduces the volume the expensive ones must process.", C.moss);
    T.fieldNote(s, 0.55, 6.15, 12.2, 1.0,
      "ast.parse rejected 7% of a dataset I had assumed was clean. Seven percent of my gradient updates were teaching the model to write code that does not compile.");
    T.num(s);
  }

  /* ---- Execution verification ---- */
  {
    const s = T.slide("Data", "Execution verification — the filter only you can run");
    s.addText(
      "You built a sandbox in Phase 3. Almost nobody assembling instruction datasets has one. That means you can apply a " +
      "filter that most public datasets never had applied to them: does the code actually run?",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.steps(s, 2.2, [
      ["For records that ship with tests", "Run them. Keep only what passes. This is unambiguous and it is the strongest quality signal that exists."],
      ["For records without tests — generate them", "Have your Mac teacher write tests for the given solution, then run them. Weaker signal (the tests may be wrong), but far better than nothing."],
      ["For records without tests — at minimum, execute", "Import the module, call the function with trivial arguments. Catches runtime errors that ast.parse cannot: undefined names, bad imports, syntax-valid nonsense."],
      ["Record the outcome as a field", "verified: 'tests_pass' | 'runs' | 'compiles' | 'invalid'. This becomes a filterable quality tier and a mixing knob later."],
    ], { h: 1.0 });
    T.banner(s, 6.5, "This is your unfair advantage over anyone assembling a dataset without an executor. Use it aggressively.", C.moss);
    T.num(s);
  }

  /* ---- Difficulty ---- */
  {
    const s = T.slide("Data", "Difficulty estimation and stratification");
    T.grid(s, 1.4, [
      ["Why you need it", "Without difficulty labels, Phase 7 rejection sampling silently collapses onto easy problems — the only ones that produce passing samples.", C.rust],
      ["Signal 1 — provided labels", "APPS ships difficulty tiers. CodeContests has ratings. Free, reliable, use them when present.", C.moss],
      ["Signal 2 — pass rate", "Sample your baseline model n times per problem. Pass rate IS difficulty, measured against your actual model rather than a human's opinion.", C.moss],
      ["Signal 3 — solution length", "Crude proxy. Longer reference solutions correlate with harder problems. Free and better than nothing.", C.ink],
      ["Signal 4 — AST complexity", "Cyclomatic complexity, nesting depth, node count of the reference solution. Cheap and surprisingly informative.", C.ink],
      ["Use it for stratified sampling", "Keep a fixed proportion from each difficulty band at every stage. This single habit prevents the most common Phase 7 failure.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.codeBlock(s, 0.55, 5.35, 12.2, 1.35, [
      { t: "# Model-measured difficulty — the most useful signal you can compute", c: C.moss },
      "for prob in problems:",
      "    sols = generate(baseline_model, prob, n=10, temperature=0.8)",
      "    prob['pass_rate'] = mean(sandbox.run(s, prob.tests).ok for s in sols)",
      "    prob['difficulty'] = 'easy' if pass_rate > .7 else 'hard' if pass_rate < .2 else 'medium'",
    ]);
    T.num(s);
  }

  /* ---- Mixing ---- */
  {
    const s = T.slide("Data", "Data mixing ratios — the knob nobody documents");
    T.table(s, 1.4,
      ["Mixture", "Code perf.", "General perf.", "When to use it"],
      [
        ["100% code instruction", "Best", "Degrades noticeably", "Pure code appliance; you accept the forgetting"],
        ["90% code / 10% general", "Near-best", "Mostly preserved", "The default. Cheap insurance against forgetting."],
        ["70% code / 30% general", "Slightly lower", "Well preserved", "If the model must also converse"],
        ["Code + 5% FIM", "Same", "Same", "If you want to retain fill-in-the-middle ability"],
        ["Code + math", "Slightly better", "Same", "Math data measurably helps code reasoning"],
      ],
      [3.4, 2.2, 2.4, 4.2], { size: 11, rowH: 0.44 });
    T.accentRows(s, 4.05, [
      ["Start at 90/10", "code / general instruct", "It costs about half a point of code performance and buys back most general capability. Ablate it later if it matters.", C.moss],
      ["Mix at the record level", "not by alternating files", "Shuffle thoroughly. Training on 10k code records then 1k general records is curriculum learning by accident, not a mixture.", C.amber],
      ["Ratios are per-token, not per-record", "long code, short chat", "A 90/10 record ratio can be a 98/2 token ratio. Compute the mixture in tokens or your intended balance is fiction.", C.rust],
    ], { h: 0.72, labelW: 3.0 });
    T.fieldNote(s, 0.55, 6.4, 12.2, 0.85,
      "The token-vs-record ratio one is subtle and cost me an ablation. My '80/20 mix' was 96/4 by tokens, and behaved exactly like pure code data.");
    T.num(s);
  }

  /* ---- Synthetic: overview ---- */
  {
    const s = T.slide("Data", "Synthetic data — four generation strategies");
    T.grid(s, 1.4, [
      ["Self-Instruct", "Seed with ~175 human-written tasks. Model generates new instructions in the same style, then generates responses. Filter for diversity and validity. The original recipe; now mostly of historical interest.", C.ink],
      ["Evol-Instruct", "Take a seed instruction and evolve it. DEPTH: add constraints, increase reasoning steps, complicate the input. BREADTH: generate a related but distinct new problem. Iterate several rounds.", C.moss],
      ["OSS-Instruct", "Sample a REAL code snippet from The Stack. Ask the model to invent a problem that this code solves, then write a clean solution. Grounded in real code, so the distribution is realistic.", C.moss],
      ["Back-translation", "Take real code, generate the docstring/problem it answers, then discard the original and keep (generated problem, real code). The solution is guaranteed real; only the question is synthetic.", C.moss],
    ], { cols: 2, h: 1.75 });
    T.banner(s, 5.05, "OSS-Instruct is the best default: real code as the seed means realistic distribution, and it needs only a mid-size teacher.", C.moss);
    T.fieldNote(s, 0.55, 5.85, 12.2, 1.1,
      "Purely self-generated data drifts. By round three of unconstrained Evol-Instruct my problems were baroque nonsense with " +
      "seven nested constraints that no human would ever write. Grounding in real code is what stops the drift.");
    T.num(s);
  }

  /* ---- Synthetic: the verified loop ---- */
  {
    const s = T.slide("Data", "Verified synthetic generation — your actual pipeline");
    T.pipeline(s, 1.4, [
      ["SEED (Mac)", "Sample a real function from The Stack, filtered for quality and license.", C.moss],
      ["INVENT (Mac)", "14B teacher writes a problem statement that this code solves.", C.moss],
      ["SOLVE (Mac)", "Teacher writes N fresh solutions to its own problem statement.", C.moss],
      ["TEST (Mac)", "Teacher writes test cases. Sandbox runs them against all N.", C.amber],
      ["KEEP", "Retain only (problem, solution) pairs where the solution passes.", C.forest2],
    ], { h: 1.85 });
    T.grid(s, 3.5, [
      ["The verification is the whole trick", "A weak teacher producing occasionally-correct solutions still yields a perfectly clean dataset, because you only keep the verified ones.", C.moss],
      ["Generate overnight", "This is Mac work and it is slow. Kick it off, sleep, wake to a dataset. This is the best use of having two machines.", C.moss],
      ["Decontaminate the OUTPUT", "The teacher may reproduce eval problems from its own training data. Synthetic data needs decontamination too.", C.rust],
      ["Watch for mode collapse", "Sampling seeds from a narrow slice of The Stack gives you a thousand variations of one problem. Stratify your seed sampling.", C.amber],
    ], { cols: 2, h: 1.3 });
    T.fieldNote(s, 0.55, 6.25, 12.2, 0.9,
      "This loop is the highest-value thing your hardware combination can do. It turns 'I have no data' into 'I have as much verified data as I have nights'.");
    T.num(s);
  }

  /* ---- Versioning ---- */
  {
    const s = T.slide("Data", "Versioning and lineage");
    T.codeBlock(s, 0.55, 1.4, 6.7, 3.6, [
      { t: "data/processed/v3-curated-10k/", c: C.moss, b: true },
      "├── train.jsonl            9,412 records",
      "├── val.jsonl                 500 records",
      "├── test.jsonl                500 records  (SEALED)",
      "└── MANIFEST.json",
      "",
      { t: "// MANIFEST.json", c: C.moss },
      "{",
      "  \"version\": \"v3-curated-10k\",",
      "  \"built\": \"2026-03-14T22:10:00Z\",",
      "  \"code_sha\": \"8f2a1c9\",",
      "  \"sources\": [",
      "    {\"name\": \"magicoder-oss\", \"in\": 75197, \"out\": 8102},",
      "    {\"name\": \"general-instruct\", \"in\": 4000, \"out\": 1310}",
      "  ],",
      "  \"removed\": {\"contaminated\": 41, \"near_dup\": 12308,",
      "               \"ast_invalid\": 4102, \"low_quality\": 49134},",
      "  \"eval_sets_decontaminated_against\": [\"humaneval+\",\"mbpp+\",\"custom-v1\"]",
      "}",
    ], "A VERSIONED DATASET");
    T.grid(s, 1.4, [
      ["Immutable once written", "A version is never edited. Changed your filter? That is v4. This is the only way comparisons across weeks stay honest.", C.moss],
      ["MANIFEST is the contract", "Every removal count, every source, the code SHA that built it. When a result looks strange, this file is where you look first.", C.moss],
      ["Configs reference versions", "data_version: v3-curated-10k in the training config. Now every run is traceable to exact data.", C.moss],
      ["test.jsonl is sealed", "Write it once. Do not read it until the end of Phase 12. Consider making the file read-only so you cannot casually peek.", C.rust],
    ], { cols: 1, x: 7.45, w: 5.3, h: 0.88, gapY: 0.1 });
    T.num(s);
  }

  /* ---- The ablation ---- */
  {
    const s = T.slide("Data", "The ablation that recalibrates everything");
    s.addChart(pres.ChartType.bar, [{
      name: "HumanEval+ pass@1",
      labels: ["100k raw", "100k deduped", "30k filtered", "10k curated", "10k + verified"],
      values: [28.7, 31.2, 33.9, 35.4, 37.1],
    }], {
      x: 0.55, y: 1.4, w: 7.3, h: 3.7,
      barDir: "col",
      showTitle: true, title: "Same model, same hyperparameters, same compute budget",
      titleFontFace: BODY, titleFontSize: 12.5, titleColor: C.muted,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 11.5, dataLabelColor: C.ink,
      chartColors: [C.amber, C.lightMoss, C.moss, C.forest2, C.forest],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 10.5, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      valAxisMinVal: 20, valAxisMaxVal: 42, showLegend: false,
    });
    T.grid(s, 1.4, [
      ["+8.4 points", "From data alone. No architecture change, no hyperparameter tuning, no extra compute. This is larger than most gains you will produce later.", C.moss],
      ["10x less data, 10x faster runs", "Which means 10x more experiments per day, which compounds into everything else you learn.", C.moss],
      ["Run this FIRST", "One afternoon. It permanently recalibrates where you think effort belongs — and you will need that conviction when curation gets boring.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 1.18, gapY: 0.13 });
    T.fieldNote(s, 0.55, 5.35, 12.2, 1.45,
      "I had been tuning learning rates for a week to chase two points. Then I spent one afternoon deduplicating and filtering, " +
      "and got eight. Every instinct I had about where the leverage was in this field turned out to be wrong, and this was the " +
      "experiment that told me.");
    T.num(s);
  }

  /* ---- Data traps ---- */
  {
    T.num(T.ptn("Data", "Data — path and traps",
      [
        "Decontaminate → dedup → split → filter → format. In that order",
        "Log removal counts at every stage; they are findings, not bookkeeping",
        "Verify loss masking by decoding one batch, on every new dataset",
        "Use ast.parse and your sandbox — filters most datasets never had",
        "90/10 code-to-general mixture, computed in TOKENS not records",
        "Stratify by difficulty at every stage",
        "Version immutably with a MANIFEST; seal the test split",
        "Run the curation ablation early — it recalibrates your priorities",
      ],
      [
        "Dedup before decontamination: hides contamination behind removed copies",
        "Splitting before dedup: near-duplicates straddle the boundary and leak",
        "Trusting a public dataset's quality claims without measuring",
        "Computing mixture ratios in records when tokens are what matter",
        "Unconstrained synthetic evolution: drifts into baroque nonsense by round 3",
        "Forgetting to decontaminate synthetic output — the teacher saw the evals too",
        "Editing a dataset version in place, silently invalidating old comparisons",
        "Chasing a perfect filter. Ship at 90% clean and move on",
      ],
      "This is the phase people skip because it does not feel like machine learning. It is the phase with the highest " +
      "return per hour in the entire curriculum, and nothing you do later can compensate for getting it wrong.",
      { noteH: 1.2, size: 11.8 }));
  }

  /* ---- Data false positives ---- */
  {
    const s = T.slide("Data", "The data false positives");
    T.table(s, 1.4,
      ["False positive", "What you see", "What is actually happening", "The check"],
      [
        ["Contamination", "Excellent eval, mediocre real use", "Eval problems present in training data", "n-gram + function-name + docstring embedding"],
        ["Leaked near-duplicates", "Val tracks train perfectly", "You split before deduplicating", "Dedup first; check cross-split MinHash overlap"],
        ["More data looks better", "100k beats 10k on val", "Val is contaminated by the same duplicates", "Compare on a clean, sealed held-out set"],
        ["Filter that removes hard examples", "Score rises after filtering", "You filtered out difficulty, not noise", "Track difficulty distribution before/after"],
        ["Synthetic self-agreement", "Teacher-graded quality is high", "Teacher rates its own output favorably", "Grade with execution, not with the generator"],
        ["Token/record ratio confusion", "'80/20 mix' behaves like 100/0", "Long code records dominate the token count", "Compute mixture in tokens"],
        ["Quality score drift", "Judge scores climb across versions", "Your judge prompt changed, not the data", "Version the judge prompt like any other config"],
      ],
      [2.7, 2.9, 3.4, 3.2], { size: 10.5, rowH: 0.45 });
    T.banner(s, 5.0, "Every one of these makes a number go UP. That is precisely why they survive so long.", C.rust);
    T.fieldNote(s, 0.55, 5.8, 12.2, 1.15,
      "The 'filter removed hard examples' one is genuinely insidious. My quality filter was preferentially deleting long, " +
      "complex, correct solutions because they looked unusual. The score went up and the model got worse at exactly the " +
      "problems I cared about most.");
    T.num(s);
  }
};
