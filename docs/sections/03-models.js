/* PART III — THE MODEL LANDSCAPE  (Phase 2: MODEL) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("MODEL", "Phase 2", "Choosing and Understanding Your Base",
    "One day. Get this wrong and every downstream number is contaminated by a\nformat bug you will not find for three weeks."));

  /* ---- Families ---- */
  {
    const s = T.slide("Model", "The open-weight code model landscape");
    T.table(s, 1.4,
      ["Family", "Sizes", "License", "Notes"],
      [
        ["Qwen2.5-Coder", "0.5 / 1.5 / 3 / 7 / 14 / 32B", "Apache 2.0 (3B differs)", "Strongest small models available. The default choice."],
        ["Qwen3 / Qwen3-Coder", "0.6B upward", "Apache 2.0", "Newer generation; check current sizes and coder variants."],
        ["DeepSeek-Coder / V2", "1.3 / 6.7 / 16 / 33B", "Custom model license", "Strong, especially at repo-level context. Read the license."],
        ["StarCoder2", "3 / 7 / 15B", "BigCode OpenRAIL-M", "Fully transparent training data (The Stack v2). Great for research."],
        ["CodeLlama", "7 / 13 / 34 / 70B", "Llama 2 Community", "Older now. Historically important, rarely the right pick today."],
        ["Granite Code (IBM)", "3 / 8 / 20 / 34B", "Apache 2.0", "Clean licensing, enterprise-oriented, well documented."],
        ["CodeGemma", "2 / 7B", "Gemma Terms", "Decent small models; license has use restrictions."],
      ],
      [2.3, 2.6, 2.6, 4.7], { size: 11, rowH: 0.42 });
    T.banner(s, 4.72, "Verify every license yourself before you ship anything. They change, and they differ per size within one family.", C.amber);
    T.fieldNote(s, 0.55, 5.55, 12.2, 1.4,
      "I picked a model on benchmark scores alone and discovered three weeks later that its license prohibited exactly what I " +
      "wanted to do with it. Read the license on day one — it takes ten minutes and it constrains everything downstream, " +
      "including whether you can use its outputs as training data.");
    T.num(s);
  }

  /* ---- Qwen deep dive ---- */
  {
    const s = T.slide("Model", "Qwen2.5-Coder — why it is the default here");
    T.grid(s, 1.4, [
      ["It goes small enough", "0.5B is a real, usable code model. Most families start at 3B, which does not fit your 4GB training budget with any headroom.", C.moss],
      ["The size ladder is complete", "0.5 → 1.5 → 3 → 7 → 14 → 32B. You can prototype at 0.5B and scale the exact same recipe, changing one config line.", C.moss],
      ["Mostly Apache 2.0", "Permissive for most sizes, which matters when you want to publish an adapter or use outputs as training data.", C.moss],
      ["Strong FIM support", "Native fill-in-the-middle tokens, which matters if you ever want completion rather than instruction behavior.", C.ink],
      ["Well-documented template", "The chat template ships in tokenizer_config.json and is correct. Not every family can say this.", C.ink],
      ["Big-brother teachers", "14B quantized runs on your 48GB Mac. Same tokenizer family as your 0.5B student — distillation is clean.", C.moss],
    ], { cols: 3, h: 1.6 });
    T.accentRows(s, 4.85, [
      ["Your student", "Qwen2.5-Coder-0.5B", "Trains on 4GB with room to spare. This is where you run 90% of experiments.", C.moss],
      ["Your stretch", "Qwen2.5-Coder-1.5B", "Trains on 4GB with Unsloth, seq 512, batch 1. Tight but real.", C.amber],
      ["Your teacher", "Qwen2.5-Coder-14B (4-bit)", "Mac-only, inference only. Generates candidate solutions for verified distillation.", C.forest2],
    ], { h: 0.62, labelW: 2.0 });
    T.num(s);
  }

  /* ---- Base vs instruct ---- */
  {
    const s = T.slide("Model", "Base vs Instruct — which do you start from?");
    T.compare(s, 1.4, 3.2,
      { title: "START FROM BASE WHEN", items: [
        "You have enough SFT data (10k+ good examples)",
        "You want full control of the output format",
        "You are teaching a genuinely new task shape",
        "You want to avoid inheriting another team's alignment quirks",
        "You are doing research and want a clean baseline",
      ]},
      { title: "START FROM INSTRUCT WHEN", items: [
        "You have limited data (< 10k examples)",
        "You want instruction-following for free",
        "You are adding a skill, not replacing behavior",
        "You are learning — this is you, for now",
        "You want a strong baseline to beat on day one",
      ]}
    );
    s.addText(
      "For this curriculum: start from Instruct. You get a working baseline immediately, your first SFT run has something to " +
      "beat, and you are learning the training mechanics rather than fighting a model that does not know what a question is. " +
      "Come back to base later, once you have data volume — the comparison is a genuinely interesting Phase 6 experiment.",
      { x: 0.55, y: 4.8, w: 12.2, h: 0.9, fontFace: BODY, fontSize: 13, color: C.ink, margin: 0, valign: "top" }
    );
    T.fieldNote(s, 0.55, 5.8, 12.2, 1.15,
      "Base models feel broken the first time you use them. You ask a question and get three more questions, because it is " +
      "completing a document that looks like a forum post. That is correct behavior. It is not a bug, and it is why SFT exists.");
    T.num(s);
  }

  /* ---- Tokenizers ---- */
  {
    const s = T.slide("Model", "Tokenizers — why code is different from prose");
    T.grid(s, 1.4, [
      ["Whitespace is semantic", "Python indentation carries meaning. Good code tokenizers have dedicated multi-space tokens; general ones shred indentation into many single-space tokens.", C.ink],
      ["Identifiers fragment", "get_user_by_id might be 6 tokens. Long descriptive names are expensive, and the model sees them as compounds.", C.ink],
      ["Tokens per line varies wildly", "Dense one-liners and sparse boilerplate differ 5x per line. Never budget context by line count.", C.amber],
      ["Special tokens for structure", "FIM markers, file separators, repo metadata. Present in code tokenizers, absent in general ones.", C.ink],
      ["Byte fallback matters", "Unicode in strings and comments must round-trip exactly. A lossy tokenizer silently corrupts your data.", C.rust],
      ["Never assume ~4 chars/token", "That heuristic is for English prose. For code it is closer to 3, and for minified or dense code far less.", C.amber],
    ], { cols: 3, h: 1.6 });
    T.codeBlock(s, 0.55, 4.85, 12.2, 1.35, [
      { t: "# Measure it yourself before you set seq_len — this takes 30 seconds", c: C.moss },
      "tok = AutoTokenizer.from_pretrained('Qwen/Qwen2.5-Coder-0.5B')",
      "lens = [len(tok(ex['text']).input_ids) for ex in dataset.select(range(2000))]",
      "print(np.percentile(lens, [50, 90, 95, 99]))   # pick seq_len from p95, not from a guess",
    ]);
    T.fieldNote(s, 0.55, 6.35, 12.2, 0.85,
      "I set seq_len=512 by intuition and silently truncated 23% of my training examples mid-function. The p95 was 1,100.");
    T.num(s);
  }

  /* ---- Chat templates ---- */
  {
    const s = T.slide("Model", "Chat templates — the bug that costs everyone a week",
      "The exact token sequence wrapping each turn. Get it wrong and nothing errors — the score just quietly collapses.");
    T.codeBlock(s, 0.55, 1.68, 6.4, 2.5, [
      { t: "# Qwen ChatML format — the ACTUAL bytes", c: C.moss },
      "<|im_start|>system",
      "You are a coding assistant.<|im_end|>",
      "<|im_start|>user",
      "Write a function to reverse a list.<|im_end|>",
      "<|im_start|>assistant",
      "def reverse(xs): return xs[::-1]<|im_end|>",
    ], "WHAT THE MODEL ACTUALLY SEES");
    T.codeBlock(s, 7.15, 1.68, 5.6, 2.5, [
      { t: "# NEVER hand-write this. Ever.", c: C.rust },
      "text = tok.apply_chat_template(",
      "    messages,",
      "    tokenize=False,",
      "    add_generation_prompt=True,",
      ")",
      "",
      { t: "# Then LOOK at it:", c: C.moss },
      "print(repr(text))",
    ], "HOW TO PRODUCE IT");
    T.accentRows(s, 4.35, [
      ["Train ≠ eval", "different template", "The single most common cause of 'my fine-tune made it worse'. Both paths must use the identical template.", C.rust],
      ["add_generation_prompt", "True at inference", "Must be True when generating, False when building training text. Getting this backwards is a silent 10-point loss.", C.rust],
      ["System prompt presence", "train with, eval without", "If you train with a system prompt and evaluate without one, you have changed the distribution.", C.amber],
      ["Version the template", "template: qwen-chatml-v1", "Put its name in the config. Changing it counts as changing the experiment.", C.moss],
    ], { h: 0.62, labelW: 2.4 });
    T.num(s);
  }

  /* ---- Special tokens / EOS ---- */
  {
    const s = T.slide("Model", "Special tokens and the endless-generation bug");
    s.addText(
      "Symptom: your fine-tuned model produces a correct answer, then keeps going — inventing a new question, answering that, " +
      "forever, until max_tokens. Everyone hits this. It is almost always EOS.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.65, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.steps(s, 2.15, [
      ["The training data has no EOS token appended", "If your examples end without an end-of-sequence token, the model never learns to stop. Check: decode one tokenized example and look at the final token id."],
      ["Base and Instruct use DIFFERENT EOS tokens", "Qwen base uses <|endoftext|>; Qwen instruct uses <|im_end|>. Train with one, generate expecting the other, and generation never terminates."],
      ["tokenizer.pad_token is unset, so people set it to eos_token", "Reasonable — but if you then mask pad tokens out of the loss, you have also masked EOS out of the loss, and the model never learns to emit it."],
      ["Generation config overrides your eos_token_id", "The model's generation_config.json may specify a different stop token than your tokenizer. They disagree and generation wins."],
    ], { h: 0.98 });
    T.banner(s, 6.4, "Diagnostic: decode one training example end-to-end and print repr(). Ninety seconds. It has saved me days.", C.moss);
    T.num(s);
  }

  /* ---- FIM ---- */
  {
    const s = T.slide("Model", "Fill-in-the-middle (FIM) — the other code format",
      "Instruction-tuning is not the only way to use a code model. FIM is how autocomplete actually works.");
    T.codeBlock(s, 0.55, 1.68, 6.4, 2.2, [
      { t: "# PSM ordering (prefix, suffix, middle)", c: C.moss },
      "<|fim_prefix|>def binary_search(xs, target):",
      "    lo, hi = 0, len(xs)",
      "<|fim_suffix|>    return -1",
      "<|fim_middle|>",
      "",
      { t: "# model generates the middle section", c: C.muted },
    ], "FIM FORMAT");
    T.grid(s, 1.68, [
      ["Why it exists", "Editor autocomplete needs the code AFTER the cursor as context. Left-to-right generation alone cannot use it.", C.ink],
      ["When you need it", "If your end goal is an in-editor completion model rather than a chat-style assistant.", C.ink],
      ["Where it comes from", "Injected during pretraining by randomly splitting documents. You inherit it; you rarely add it.", C.ink],
    ], { cols: 1, x: 7.15, w: 5.6, h: 0.68, gapY: 0.1 });
    T.accentRows(s, 4.1, [
      ["Ordering differs", "PSM vs SPM", "Some models expect prefix-suffix-middle, others suffix-prefix-middle. Using the wrong one produces confident nonsense.", C.rust],
      ["Token names differ", "per family", "Qwen, StarCoder, and DeepSeek all use different FIM sentinel tokens. Read the model card, not another model's docs.", C.amber],
      ["Instruct tuning can erase it", "SFT overwrites", "Heavy instruction fine-tuning degrades FIM ability. If you need both, mix FIM examples into your SFT data.", C.amber],
    ], { h: 0.66, labelW: 2.5 });
    T.fieldNote(s, 0.55, 6.25, 12.2, 0.9,
      "FIM is out of scope for this curriculum — we are building an instruction-following code model. But know it exists, " +
      "because if your goal is an editor plugin, FIM is the format you actually want and everything downstream changes.");
    T.num(s);
  }

  /* ---- Context length ---- */
  {
    const s = T.slide("Model", "Context length, RoPE, and what you can afford");
    T.grid(s, 1.4, [
      ["Advertised ≠ trainable", "A model may advertise 32k context. On 4GB VRAM you will train at 512–1024. Attention memory grows with sequence length, and activations dominate your budget.", C.rust],
      ["RoPE is the position encoding", "Rotary embeddings encode position by rotating query/key vectors. It extrapolates poorly past the trained length without adjustment.", C.ink],
      ["Extension methods exist", "Position Interpolation, NTK-aware scaling, YaRN. They stretch usable context beyond training length — at some quality cost.", C.ink],
      ["Long context is a separate project", "Repo-level code understanding needs long context and is a genuinely different discipline. Deliberately out of scope here.", C.amber],
      ["Pick seq_len from your data", "Measure the p95 token length of your dataset and set seq_len there. Do not pick a round number.", C.moss],
      ["Packing changes the math", "With sequence packing, seq_len is a bin size, not a per-example cap. Different tuning intuitions apply.", C.ink],
    ], { cols: 3, h: 1.7 });
    T.table(s, 4.95,
      ["seq_len", "Approx. activation cost", "Fits on 4GB with 0.5B QLoRA?", "Truncates what fraction of typical SFT data?"],
      [
        ["512", "Low", "Yes, comfortably, batch 2–4", "~20% of examples"],
        ["1024", "Moderate", "Yes, batch 1", "~5%"],
        ["2048", "High", "Marginal, batch 1 + checkpointing", "~1%"],
        ["4096", "Very high", "No", "~0%"],
      ],
      [1.5, 3.0, 4.0, 3.7], { size: 11, rowH: 0.4 });
    T.num(s);
  }

  /* ---- Model traps ---- */
  {
    T.num(T.ptn("Model", "Choosing a base model — path and traps",
      [
        "Start with Qwen2.5-Coder-0.5B-Instruct. Change it only for a measured reason",
        "Load it, apply your chat template, generate — before writing anything else",
        "Verify EOS: generate and confirm it terminates on its own",
        "Measure token-length percentiles on your actual data, then set seq_len",
        "Read the license before you get attached to the model",
        "Confirm the teacher shares a tokenizer family with the student",
      ],
      [
        "Picking by leaderboard score — those numbers use prompts and harnesses you are not using",
        "Assuming the chat template from a sibling model applies. It does not",
        "Starting at 7B 'to get better results' — you cannot train it, so you learn nothing",
        "Ignoring the license until you want to publish",
        "Changing base models mid-curriculum: every prior number becomes incomparable",
        "Trusting the model card's context length as your trainable length",
      ],
      "The whole of Phase 2 is: load the model, print the templated text, generate once, read the license. Half a day. " +
      "Skipping it is how you end up debugging a tokenizer problem while convinced you have a training problem.",
      { noteH: 1.25 }));
  }
};
