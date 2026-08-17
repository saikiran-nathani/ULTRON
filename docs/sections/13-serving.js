/* PART XIII — QUANTIZATION & SERVING  (Phase 12) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("SERVE", "Phase 12", "Quantize, Serve, Ship",
    "One week. The model leaves your training loop and starts running on-device —\nno API cost, no data leaving the machine, works on a plane."));

  /* ---- Quantization overview ---- */
  {
    const s = T.slide("Serve", "Quantization — what actually gets quantized");
    s.addText(
      "You already used quantization for TRAINING (QLoRA's NF4). Serving quantization is a different problem: there, the goal " +
      "was fitting in memory during backprop. Here, the goal is inference speed and footprint, and you can afford calibration.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.table(s, 2.2,
      ["Format", "Bits", "Method", "Best for"],
      [
        ["bf16 / fp16", "16", "No quantization", "Baseline quality reference. 2 bytes/param."],
        ["GPTQ", "4 / 3", "Post-training, layer-wise, calibration set", "GPU serving, mature tooling"],
        ["AWQ", "4", "Activation-aware — protects salient weights", "GPU serving, often better than GPTQ at 4-bit"],
        ["bitsandbytes NF4", "4", "On-the-fly, no calibration", "Convenience; what QLoRA uses. Slower inference."],
        ["GGUF (llama.cpp)", "2–8", "K-quants, many variants (Q4_K_M etc.)", "CPU + Metal. The portable format."],
        ["MLX 4-bit", "4", "Apple-native quantization", "Your Mac. Fast, simple, Apple-only."],
      ],
      [2.9, 1.3, 4.6, 3.4], { size: 11, rowH: 0.42 });
    T.grid(s, 5.2, [
      ["Merge the adapter first", "Quantizing a base + separate adapter is awkward. Merge to a full model, THEN quantize. The merged model is regenerable, so this is not permanent storage.", C.moss],
      ["4-bit is the practical floor", "Below 4-bit, quality degrades sharply on small models. A 0.5B model has less redundancy to spare than a 70B.", C.amber],
      ["Q4_K_M is the GGUF default", "Mixed precision per tensor type. Good quality-size tradeoff. Start there and compare against Q5_K_M and Q8_0.", C.moss],
    ], { cols: 3, h: 1.35 });
    T.num(s);
  }

  /* ---- quality curve ---- */
  {
    const s = T.slide("Serve", "Measure the quality/speed curve on YOUR eval");
    s.addChart(pres.ChartType.bar, [
      { name: "HumanEval+ pass@1", labels: ["bf16", "Q8_0", "Q5_K_M", "Q4_K_M", "Q3_K_M", "Q2_K"], values: [37.4, 37.2, 36.8, 35.9, 32.1, 24.6] },
    ], {
      x: 0.55, y: 1.4, w: 7.2, h: 3.5,
      barDir: "col",
      showTitle: true, title: "Quality vs quantization level — 0.5B model, your own eval",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 11, dataLabelColor: C.ink,
      chartColors: [C.forest, C.forest2, C.moss, C.moss, C.amber, C.rust],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 11, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10.5, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      valAxisMinVal: 20, valAxisMaxVal: 42, showLegend: false,
    });
    T.grid(s, 1.4, [
      ["The cliff is real and model-specific", "Q4 costs about 1.5 points here. Q3 costs 5. Q2 is unusable. WHERE the cliff falls depends on your model and your task — measure it.", C.rust],
      ["Small models degrade faster", "A 70B model shrugs off Q4. A 0.5B model has far less parameter redundancy and feels it much more.", C.amber],
      ["Never trust a generic curve", "Published quantization benchmarks use different models and tasks. Run your own harness on each quantized artifact.", C.moss],
      ["Size matters for shipping", "0.5B at Q4_K_M is roughly 400MB. That fits anywhere — phone, browser, embedded. This is the point of the whole exercise.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 0.86, gapY: 0.1 });
    T.num(s);
  }

  /* ---- llama.cpp / GGUF ---- */
  {
    const s = T.slide("Serve", "GGUF and llama.cpp — the portable path");
    T.codeBlock(s, 0.55, 1.4, 7.2, 3.5, [
      { t: "# 1. Merge the LoRA adapter into the base", c: C.moss },
      "python -m peft.utils.merge_adapter \\",
      "  --base Qwen/Qwen2.5-Coder-0.5B-Instruct \\",
      "  --adapter ckpt/11-merged --out models/ultron-fp16",
      "",
      { t: "# 2. Convert to GGUF", c: C.moss },
      "python llama.cpp/convert_hf_to_gguf.py \\",
      "  models/ultron-fp16 --outfile ultron-f16.gguf",
      "",
      { t: "# 3. Quantize", c: C.moss },
      "llama-quantize ultron-f16.gguf ultron-q4km.gguf Q4_K_M",
      "",
      { t: "# 4. Serve — OpenAI-compatible endpoint", c: C.moss },
      "llama-server -m ultron-q4km.gguf --port 8080 \\",
      "  -c 4096 -ngl 99        # -ngl = layers on GPU/Metal",
    ], "THE GGUF PIPELINE");
    T.grid(s, 1.4, [
      ["One artifact, everywhere", "The same .gguf runs on your Mac via Metal, on the Asus via CUDA, on a Raspberry Pi via CPU. This portability is why GGUF won.", C.moss],
      ["OpenAI-compatible API", "llama-server exposes /v1/chat/completions. Every tool that speaks the OpenAI API now speaks to your model, unchanged.", C.moss],
      ["-ngl is the key flag", "Number of layers offloaded to GPU. 99 means all of them. On a 0.5B model everything fits comfortably.", C.ink],
      ["Verify after conversion", "Re-run your eval harness against the served endpoint. Conversion bugs are real, and they are silent.", C.rust],
    ], { cols: 1, x: 7.95, w: 4.8, h: 0.82, gapY: 0.1 });
    T.num(s);
  }

  /* ---- MLX ---- */
  {
    const s = T.slide("Serve", "MLX — the Mac-native path");
    T.codeBlock(s, 0.55, 1.4, 7.2, 2.6, [
      { t: "# Convert and quantize in one step", c: C.moss },
      "mlx_lm.convert --hf-path models/ultron-fp16 \\",
      "  -q --q-bits 4 --mlx-path models/ultron-mlx-q4",
      "",
      { t: "# Generate", c: C.moss },
      "mlx_lm.generate --model models/ultron-mlx-q4 \\",
      "  --prompt 'Write a binary search' --max-tokens 256",
      "",
      { t: "# Serve an OpenAI-compatible endpoint", c: C.moss },
      "mlx_lm.server --model models/ultron-mlx-q4 --port 8081",
    ], "MLX");
    T.grid(s, 1.4, [
      ["Faster than GGUF on Apple Silicon", "MLX is built for unified memory and the Apple GPU. For Mac-only deployment it is usually the fastest option.", C.moss],
      ["Apple-only", "The artifact does not run anywhere else. If portability matters, use GGUF; if this is your personal Mac tool, use MLX.", C.amber],
      ["Ship both", "Conversion is cheap. Produce a GGUF for portability and an MLX build for your own machine.", C.moss],
    ], { cols: 1, x: 7.95, w: 4.8, h: 0.86, gapY: 0.1 });
    T.accentRows(s, 4.25, [
      ["vLLM", "GPU serving at scale", "Continuous batching, PagedAttention, multi-LoRA. The right answer for a server; overkill for one laptop and not available on Metal.", C.ink],
      ["Multi-LoRA serving", "one base, many adapters", "vLLM can hot-swap LoRA adapters per request. One base model in memory, dozens of specializations. Worth knowing when you have several adapters.", C.ink],
      ["Structured decoding", "outlines, llguidance, xgrammar", "Constrain generation to a grammar or JSON schema at sample time. Guarantees parseable output rather than hoping for it.", C.moss],
    ], { h: 0.72, labelW: 2.8 });
    T.num(s);
  }

  /* ---- editor integration ---- */
  {
    const s = T.slide("Serve", "Wiring it into your editor — the actual payoff");
    T.steps(s, 1.4, [
      ["Start the server", "llama-server -m ultron-q4km.gguf --port 8080. It now speaks the OpenAI chat-completions API on localhost."],
      ["Point a client at it", "Continue.dev, Zed, Cursor (custom endpoint), Aider, or plain curl. Anything with a configurable base_url works."],
      ["Set base_url to http://localhost:8080/v1", "No API key needed. No network egress. Your code never leaves the machine."],
      ["Use it for a week on real work", "This is the honest evaluation. Benchmarks measured whether it improved; daily use measures whether it is USEFUL, which is a different question."],
      ["Log what it gets wrong", "Every failure in real use is a new eval case. This is how your custom eval set grows past its first 200 problems."],
    ], { h: 0.95, bottom: 6.18 });
    T.banner(s, 6.3, "A 400MB model that runs offline on your laptop, that you trained yourself, that you use daily. That is the deliverable.", C.moss);
    T.num(s);
  }

  /* ---- final eval ---- */
  {
    const s = T.slide("Serve", "The final evaluation — opening the sealed set");
    T.steps(s, 1.4, [
      ["Re-run everything through the SERVED endpoint", "Not through your training-time generate() call. Serving introduces its own bugs: template handling, stop tokens, sampling defaults. Evaluate what you actually ship."],
      ["Run LiveCodeBench", "Timestamped, contamination-resistant. If your HumanEval+ is strong but LiveCodeBench is weak, you have a contamination problem and now you know."],
      ["Open the sealed test split — once", "The one you have not looked at since Phase 5. This number is the honest one, and you get exactly one shot at it."],
      ["Report the full ladder", "Baseline → SFT → RFT → DPO → GRPO → repair → merged → quantized. Every delta, with seeds and confidence intervals."],
      ["Write down what did NOT work", "The failed ablations are more useful to future-you than the successes. Most of what you learned lives there."],
    ], { h: 0.95, bottom: 6.13 });
    T.fieldNote(s, 0.55, 6.25, 12.2, 0.95,
      "Evaluating through the served endpoint caught a stop-token bug that had never appeared in training-time evaluation. " +
      "Two points, invisible until the very last step. Always evaluate the thing you ship.");
    T.num(s);
  }

  /* ---- traps ---- */
  {
    T.num(T.ptn("Serve", "Quantization and serving — path and traps",
      [
        "Merge the adapter into a full model, then quantize",
        "Produce both GGUF (portable) and MLX (Mac-native)",
        "Measure the quality/speed curve on YOUR eval, not a generic one",
        "Start at Q4_K_M; compare Q5_K_M and Q8_0",
        "Serve via llama-server for an OpenAI-compatible endpoint",
        "Re-run the full eval THROUGH the served endpoint",
        "Use it daily on real work — that is the honest test",
      ],
      [
        "Trusting published quantization curves for your model and task",
        "Going below 4-bit on a small model: the cliff is steep",
        "Evaluating the training checkpoint and shipping the quantized one",
        "Forgetting the chat template in the serving config",
        "Wrong stop tokens at serve time: endless generation returns",
        "Storing merged full models in git: regenerate them instead",
        "Declaring victory on benchmarks without ever using the model",
      ],
      "The gap between 'scores well' and 'is useful' is only visible when you use the thing. Ship it to yourself first, " +
      "use it for a week, and let the failures become your next eval set.",
      { noteH: 1.15 }));
  }
};
