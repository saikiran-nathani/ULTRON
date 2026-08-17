/* PART XI — SELF-REPAIR  (Phase 10) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("REPAIR", "Phase 10", "Turning Failure Into Training Signal",
    "One week. The phase that most separates a code model from a chat model,\nand the closest thing here to how frontier agentic models are actually built."));

  /* ---- The idea ---- */
  {
    const s = T.slide("Repair", "The repair loop");
    T.pipeline(s, 1.4, [
      ["ATTEMPT", "Model writes a solution. It fails — most attempts do.", C.moss],
      ["EXECUTE", "Sandbox returns the traceback and the failing test output.", C.amber],
      ["FEED BACK", "Traceback is appended as a new turn in the conversation.", C.moss],
      ["REPAIR", "Model reads its own error and produces a corrected version.", C.moss],
      ["RE-EXECUTE", "Score the repaired attempt. Reward the fix.", C.forest2],
    ], { h: 1.8 });
    s.addText(
      "You already have everything you need. Phase 3's ExecResult captured the traceback; Phases 7 and 9 generated hundreds of " +
      "thousands of failures. Most people throw that away — it is arguably the richest signal you produced.",
      { x: 0.55, y: 3.4, w: 12.2, h: 0.75, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.grid(s, 4.3, [
      ["Why it matters", "Real programming is iterative. A model that writes once and gives up is far less useful than one that reads an error and fixes it — even if the first drafts are equally good.", C.moss],
      ["Why it is cheap", "The data is a byproduct of work you already did. No new generation is required for round one.", C.moss],
      ["Why it is agentic", "This is the smallest possible agent loop: act, observe, revise. Everything larger is this pattern with more tools.", C.moss],
    ], { cols: 3, h: 1.45 });
    T.fieldNote(s, 0.55, 5.95, 12.2, 1.0,
      "The tracebacks from Phase 9 alone gave me 180,000 repair examples for free. I had nearly discarded them because ExecResult " +
      "looked verbose. Capture the traceback in Phase 3 — this is why.");
    T.num(s);
  }

  /* ---- Building the dataset ---- */
  {
    const s = T.slide("Repair", "Building the repair dataset");
    T.steps(s, 1.4, [
      ["Mine your existing failures", "Every failed sample from Phases 7 and 9, with its traceback. Filter to failures that are actually informative — a syntax error teaches less than a wrong-algorithm assertion failure."],
      ["Pair each failure with a correct solution", "Ideally the model's OWN later successful attempt on the same problem. Failing that, a verified reference solution."],
      ["Format as a multi-turn conversation", "user: problem → assistant: broken attempt → user: traceback → assistant: fixed version. The traceback arrives in the USER role, because it is environment feedback."],
      ["Mask correctly across turns", "Loss on BOTH assistant turns, or only on the repair turn — this is a real design choice. Masking the first attempt teaches repair only; unmasking it teaches both."],
      ["Stratify by error type", "SyntaxError, NameError, AssertionError, TimeoutError. Different failure classes need different repair skills, and your dataset should represent all of them."],
      ["Cap repair chains", "One or two repair rounds. Longer chains teach the model that giving a bad first answer is acceptable because it can iterate."],
    ], { h: 0.87 });
    T.num(s);
  }

  /* ---- Format ---- */
  {
    const s = T.slide("Repair", "The conversation format");
    T.codeBlock(s, 0.55, 1.4, 7.2, 4.3, [
      "[",
      "  {\"role\": \"user\", \"content\":",
      "     \"Write a function that returns the median.\"},",
      "",
      "  {\"role\": \"assistant\", \"content\":",
      "     \"def median(xs):\\n    xs.sort()\\n",
      "      return xs[len(xs)//2]\"},",
      "",
      { t: "  # Environment feedback arrives as USER, not system.", c: C.moss },
      "  {\"role\": \"user\", \"content\":",
      "     \"Test failed:\\n\"",
      "     \"AssertionError: median([1,2,3,4]) == 2.5\\n\"",
      "     \"  got 3\"},",
      "",
      "  {\"role\": \"assistant\", \"content\":",
      "     \"def median(xs):\\n    xs = sorted(xs)\\n",
      "      n = len(xs)\\n",
      "      if n % 2: return xs[n//2]\\n",
      "      return (xs[n//2-1] + xs[n//2]) / 2\"}",
      "]",
    ], "ONE REPAIR EXAMPLE");
    T.grid(s, 1.4, [
      ["Traceback in the user turn", "It is environment feedback, and the user role is where external information belongs in a chat template. Putting it in system breaks most templates.", C.ink],
      ["Truncate tracebacks carefully", "Keep the exception type, the message, and the failing assertion. Drop the framework stack frames — they are noise and they consume your tiny context.", C.moss],
      ["Include the failing input", "'median([1,2,3,4]) == 2.5, got 3' teaches far more than 'AssertionError'. Make your test harness report values.", C.moss],
      ["Do not include the answer", "The feedback should say what went wrong, never what the fix is. Otherwise you are training copying, not repair.", C.rust],
    ], { cols: 1, x: 7.95, w: 4.8, h: 1.03, gapY: 0.11 });
    T.num(s);
  }

  /* ---- Reward design ---- */
  {
    const s = T.slide("Repair", "The reward design problem — and the trap");
    s.addText(
      "If you reward only the repaired attempt, you create a perverse incentive: a bad first draft costs nothing, and the model " +
      "learns to gamble. Measured first-attempt quality actually declines.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.7, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.table(s, 2.2,
      ["Reward scheme", "First-attempt quality", "Repair quality", "Verdict"],
      [
        ["Reward final attempt only", "DECLINES — gambling", "Improves", "The trap. Avoid."],
        ["Reward first attempt only", "Improves", "No signal", "Not repair training at all"],
        ["Reward both, equal weight", "Stable", "Improves", "Reasonable default"],
        ["Reward both, first weighted higher", "Improves", "Improves", "Best. Try 0.7 / 0.3."],
        ["Reward first + bonus for fixing", "Improves", "Improves", "Also good; more knobs to tune"],
      ],
      [3.6, 2.9, 2.6, 3.1], { size: 11, rowH: 0.44 });
    T.banner(s, 5.0, "Weight the first attempt HIGHER than the repair. You want a model that gets it right, and can recover when it does not.", C.moss);
    T.fieldNote(s, 0.55, 5.85, 12.2, 1.1,
      "First-attempt pass@1 fell 1.9 points while after-repair rose 6.4. Net looked great and the model had become measurably " +
      "worse at its actual job. Report the two numbers separately, always — a merged number hides this completely.");
    T.num(s);
  }

  /* ---- Measuring ---- */
  {
    const s = T.slide("Repair", "Measuring repair — report two numbers, never one");
    s.addChart(pres.ChartType.bar, [
      { name: "First attempt", labels: ["Phase 6 SFT", "Phase 9 GRPO", "Phase 10 repair (bad reward)", "Phase 10 repair (weighted)"], values: [31.2, 36.8, 34.9, 37.4] },
      { name: "After one repair", labels: ["Phase 6 SFT", "Phase 9 GRPO", "Phase 10 repair (bad reward)", "Phase 10 repair (weighted)"], values: [33.0, 39.1, 46.2, 48.8] },
    ], {
      x: 0.55, y: 1.4, w: 8.0, h: 3.6,
      barDir: "col", barGrouping: "clustered",
      showTitle: true, title: "HumanEval+ pass@1 — first attempt vs after one repair round",
      titleFontFace: BODY, titleFontSize: 12, titleColor: C.muted,
      showValue: true, dataLabelPosition: "outEnd",
      dataLabelFontFace: BODY, dataLabelFontSize: 10, dataLabelColor: C.ink,
      chartColors: [C.moss, C.forest2],
      catAxisLabelFontFace: BODY, catAxisLabelFontSize: 9.5, catAxisLabelColor: C.ink,
      valAxisLabelFontFace: BODY, valAxisLabelFontSize: 10, valAxisLabelColor: C.muted,
      valGridLine: { color: C.faint, size: 1 }, catGridLine: { style: "none" },
      valAxisMinVal: 25, valAxisMaxVal: 55,
      showLegend: true, legendPos: "b", legendFontFace: BODY, legendFontSize: 10.5,
    });
    T.grid(s, 1.4, [
      ["Column 3 is the trap", "First attempt REGRESSED while after-repair soared. A single merged metric would have called this a large win.", C.rust],
      ["Column 4 is what you want", "Both numbers up. First attempt improved because it was still rewarded.", C.moss],
      ["Repair gain is large", "+11 points from one repair round is typical and genuinely useful — most real usage allows a retry.", C.moss],
    ], { cols: 1, x: 8.7, w: 4.05, h: 1.15, gapY: 0.12 });
    T.num(s);
  }

  /* ---- Variants ---- */
  {
    const s = T.slide("Repair", "Related approaches worth knowing");
    T.grid(s, 1.4, [
      ["Reflexion", "The model writes a natural-language reflection on WHY it failed before attempting a fix. The reflection becomes part of the context. Helps on harder problems; costs tokens.", C.ink],
      ["Self-debugging", "The model explains its own code line by line, then identifies the bug. Explicit rubber-duck debugging as a prompting strategy.", C.ink],
      ["Multi-round repair", "Three or more attempts. Diminishing returns after round two, and it strongly encourages first-draft gambling. Cap it.", C.amber],
      ["Test-driven repair", "The model writes tests first, then code, then repairs against its own tests. Elegant, and vulnerable to the trivially-true-test hack from Phase 9.", C.amber],
      ["Compiler-in-the-loop", "Feed only the compiler or linter output, not test results. Cheaper, and teaches syntax and type discipline rather than correctness.", C.ink],
      ["Repair as an agent loop", "Once repair works, you have an agent: act, observe, revise. Adding tools to that loop is the natural next project.", C.moss],
    ], { cols: 3, h: 1.7 });
    T.banner(s, 5.35, "Repair is the bridge from 'model' to 'agent'. Everything agentic is this loop with a larger action space.", C.moss);
    T.num(s);
  }

  /* ---- Traps ---- */
  {
    T.num(T.ptn("Repair", "Self-repair — path and traps",
      [
        "Mine failures from Phases 7 and 9 — the data already exists",
        "Traceback goes in the USER turn as environment feedback",
        "Truncate to exception type, message, and failing values",
        "Include the actual failing input and expected output",
        "Weight the FIRST attempt higher than the repair (try 0.7 / 0.3)",
        "Cap chains at one or two repair rounds",
        "Report first-attempt and after-repair pass@1 SEPARATELY",
        "Stratify the dataset by error type",
      ],
      [
        "Rewarding only the final attempt: teaches gambling on the first draft",
        "Reporting a single merged number: hides first-attempt regression",
        "Including the fix in the feedback: trains copying, not repair",
        "Full untruncated tracebacks: burns your tiny context on stack frames",
        "Long repair chains: 'I can always fix it later' becomes the policy",
        "Only mining syntax errors: they are the least informative failures",
        "Putting the traceback in the system role: breaks most chat templates",
      ],
      "This is the phase where the model stops being a text generator and starts being something that responds to its " +
      "environment. It is also the smallest, cleanest agent loop you will ever build — which makes it the right place to learn one.",
      { noteH: 1.2 }));
  }
};
