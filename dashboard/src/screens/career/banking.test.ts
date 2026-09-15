/**
 * The banking ledger, which is the one thing on the Career screen that can be
 * confidently, invisibly wrong.
 *
 * Every failure mode here is silent:
 *
 * - A false positive marks work "on the record" that nobody has ever written
 *   down, so the screen says the tracks terminated when they did not. That is
 *   worse than having no ledger, because it is reassuring.
 * - A false negative keeps a row red forever, and a needs-attention list that
 *   cries wolf is a list nobody reads.
 * - Collapsing `planned` into `record` would make writing a roadmap task look
 *   like having banked the work — the exact confusion the three states exist
 *   to prevent.
 *
 * No DOM here: this repo has no jsdom, and none of this needs one.
 */
import { describe, expect, it } from "vitest";
import {
  bankTaskText,
  classify,
  containsRun,
  evidenceSurfaces,
  ledger,
  needle,
  planComplete,
  planSurfaces,
  tally,
  terminalItems,
  tokens,
  type BankingInput,
  type TrackItem,
} from "./banking";

/* ── builders: only the fields the ledger reads ───────────────────────── */

const job = (over: Partial<Parameters<typeof evidenceSurfaces>[0][number]> = {}) => ({
  id: "j1",
  company: "Acme",
  role: "ML Engineer",
  notes: "",
  prepNotes: "",
  resumeVersion: "",
  nextAction: "",
  ...over,
});

const cert = (over: Partial<{ id: string; name: string; notes: string }> = {}) => ({
  id: "c1",
  name: "",
  notes: "",
  ...over,
});

const phase = (over: Partial<{ id: string; title: string; goal: string; tasks: { id: string; text: string; done: boolean }[] }> = {}) => ({
  id: "p1",
  title: "Phase one",
  goal: "",
  tasks: [],
  ...over,
});

const layer = (
  over: Partial<{
    id: string;
    name: string;
    what: string;
    role: string;
    methods: string[];
    tools: { id: string; group: string; items: string[] }[];
    resources: { id: string; label: string; url: string }[];
    demo: { name: string; tree: string; flow: string[] };
  }> = {},
) => ({
  id: "l1",
  name: "Layer",
  what: "",
  role: "",
  methods: [],
  tools: [],
  resources: [],
  demo: { name: "", tree: "", flow: [] },
  ...over,
});

const item = (over: Partial<TrackItem> = {}): TrackItem => ({
  track: "courses",
  id: "x1",
  title: "Deep Learning",
  aliases: [],
  why: "graded A",
  ...over,
});

const input = (over: Partial<BankingInput> = {}): BankingInput => ({
  courses: [],
  projects: [],
  experiments: [],
  plans: [],
  jobs: [],
  certifications: [],
  phases: [],
  layers: [],
  throughLine: "",
  ...over,
});

/* ── normalisation ────────────────────────────────────────────────────── */

describe("tokens", () => {
  it("lowercases and splits on everything that is not alphanumeric", () => {
    expect(tokens("Deep-Learning, v2.0!")).toEqual(["deep", "learning", "v2", "0"]);
  });

  it("drops empties rather than emitting them", () => {
    expect(tokens("  ---  ")).toEqual([]);
    expect(tokens("")).toEqual([]);
  });
});

describe("needle", () => {
  it("refuses a title with fewer than three characters of signal", () => {
    // "C++" is 2 characters of signal. Searching for "c" would match any word
    // containing a c, so the honest answer is "not searchable".
    expect(needle("C++")).toBeNull();
    expect(needle("AI")).toBeNull();
    expect(needle("")).toBeNull();
  });

  it("measures the joined tokens, not the raw string", () => {
    // Eight raw characters, two of signal.
    expect(needle("- . / a b")).toBeNull();
    expect(needle("a-b-c")).toEqual(["a", "b", "c"]);
  });
});

describe("containsRun", () => {
  const hay = tokens("built a deep learning pipeline for chain-of-thought training");

  it("matches a contiguous run of whole tokens", () => {
    expect(containsRun(hay, tokens("deep learning"))).toBe(true);
    expect(containsRun(hay, tokens("Deep Learning Pipeline"))).toBe(true);
  });

  it("does not match a substring of a token", () => {
    // The whole reason this is not `String.includes`: "ai" appears inside
    // "chain" and "training" three times in that sentence.
    expect(containsRun(hay, ["ai"])).toBe(false);
    expect(containsRun(hay, ["rain"])).toBe(false);
  });

  it("does not match tokens that are present but not adjacent", () => {
    expect(containsRun(hay, tokens("deep pipeline"))).toBe(false);
  });

  it("does not match out-of-order tokens", () => {
    expect(containsRun(hay, tokens("learning deep"))).toBe(false);
  });

  it("matches nothing for an empty pin", () => {
    // Not "everything": a titleless record must not read as banked by every
    // surface in the app.
    expect(containsRun(hay, [])).toBe(false);
    expect(containsRun([], [])).toBe(false);
  });

  it("handles a pin longer than the hay", () => {
    expect(containsRun(["a"], ["a", "b"])).toBe(false);
  });

  it("matches at both ends of the hay", () => {
    expect(containsRun(hay, ["built"])).toBe(true);
    expect(containsRun(hay, ["training"])).toBe(true);
  });
});

/* ── the two surfaces ─────────────────────────────────────────────────── */

describe("evidenceSurfaces", () => {
  it("searches a job's written content and not its company or role", () => {
    // A course called "Research" must not read as banked against every
    // application for a research role.
    const [s] = evidenceSurfaces([job({ company: "Research Labs", role: "Research Eng", notes: "shipped x" })], []);
    expect(s!.tokens).toEqual(["shipped", "x"]);
    expect(s!.label).toBe("Research Labs — Research Eng");
  });

  it("covers all four written job fields", () => {
    const [s] = evidenceSurfaces(
      [job({ notes: "alpha", prepNotes: "beta", resumeVersion: "gamma", nextAction: "delta" })],
      [],
    );
    expect(s!.tokens).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("treats a certification's own name as content", () => {
    const [s] = evidenceSurfaces([], [cert({ name: "Deep Learning Specialization" })]);
    expect(containsRun(s!.tokens, tokens("deep learning"))).toBe(true);
  });

  it("labels an unnamed certification rather than rendering an empty string", () => {
    expect(evidenceSurfaces([], [cert()])[0]!.label).toBe("Untitled certification");
  });

  it("does not run words together across two fields", () => {
    // Joined with whitespace, so "deep" in one field and "learning" in the
    // next do not become the phrase "deep learning".
    const [s] = evidenceSurfaces([job({ notes: "deep", prepNotes: "learning" })], []);
    expect(containsRun(s!.tokens, tokens("deep learning"))).toBe(true);
    // ...and the separator is real: adjacency across fields is a known,
    // accepted approximation, asserted here so a future change is deliberate.
    expect(s!.tokens).toEqual(["deep", "learning"]);
  });
});

describe("planSurfaces", () => {
  it("searches phase goals and task text", () => {
    const s = planSurfaces(
      [phase({ goal: "ship it", tasks: [{ id: "t1", text: "finish Deep Learning", done: false }] })],
      [],
      "",
    );
    expect(containsRun(s[0]!.tokens, tokens("deep learning"))).toBe(true);
  });

  it("searches a layer's tools, resources, methods and demo", () => {
    const s = planSurfaces(
      [],
      [
        layer({
          methods: ["backprop"],
          tools: [{ id: "g1", group: "Frameworks", items: ["PyTorch Lightning"] }],
          resources: [{ id: "r1", label: "Spinning Up", url: "" }],
          demo: { name: "Tiny GPT", tree: "", flow: ["train it"] },
        }),
      ],
      "",
    );
    const t = s[0]!.tokens;
    expect(containsRun(t, tokens("pytorch lightning"))).toBe(true);
    expect(containsRun(t, tokens("spinning up"))).toBe(true);
    expect(containsRun(t, tokens("backprop"))).toBe(true);
    expect(containsRun(t, tokens("tiny gpt"))).toBe(true);
    expect(containsRun(t, tokens("train it"))).toBe(true);
  });

  it("always emits a through-line surface, even when it is empty", () => {
    const s = planSurfaces([], [], "");
    expect(s.map((x) => x.label)).toEqual(["Through-line"]);
    expect(s[0]!.tokens).toEqual([]);
  });
});

/* ── the verdict ──────────────────────────────────────────────────────── */

describe("classify", () => {
  const onRecord = evidenceSurfaces([job({ prepNotes: "led the Deep Learning capstone" })], []);
  const planned = planSurfaces(
    [phase({ title: "Phase 2", tasks: [{ id: "t", text: "write up Deep Learning", done: false }] })],
    [],
    "",
  );

  it("reports evidence, with the surface that named it", () => {
    const r = classify(item(), onRecord, planned);
    expect(r.state).toBe("record");
    expect(r.where).toBe("Acme — ML Engineer");
  });

  it("prefers evidence over the plan when both name it", () => {
    // Both surfaces mention it; "on the record" is the stronger fact.
    expect(classify(item(), onRecord, planned).state).toBe("record");
  });

  it("reports the plan alone as planned, not as banked", () => {
    const r = classify(item(), [], planned);
    expect(r.state).toBe("planned");
    expect(r.where).toBe("Phase 2");
  });

  it("reports nothing at all as unbanked, with no surface", () => {
    const r = classify(item(), [], planSurfaces([], [], ""));
    expect(r.state).toBe("unbanked");
    expect(r.where).toBe("");
    expect(r.matchable).toBe(true);
  });

  it("matches on an alias, so a course code banks the course", () => {
    const byCode = evidenceSurfaces([job({ resumeVersion: "resume-CS5800" })], []);
    const r = classify(item({ title: "Algorithms", aliases: ["CS5800"] }), byCode, []);
    expect(r.state).toBe("record");
  });

  it("flags an unsearchable title instead of blaming the user for it", () => {
    const r = classify(item({ title: "AI" }), onRecord, planned);
    expect(r.state).toBe("unbanked");
    expect(r.matchable).toBe(false);
  });

  it("carries the track, id, title and reason through unchanged", () => {
    const r = classify(item({ track: "learn", id: "p9", why: "all topics done" }), [], []);
    expect(r).toMatchObject({ track: "learn", id: "p9", title: "Deep Learning", why: "all topics done" });
  });
});

/* ── what counts as finished ──────────────────────────────────────────── */

describe("planComplete", () => {
  it("is false for a plan with no topics", () => {
    // A bare `every()` calls this complete, which files an untouched plan as
    // work that should be on a résumé.
    expect(planComplete({ id: "p", name: "n", modules: [] })).toBe(false);
    expect(planComplete({ id: "p", name: "n", modules: [{ topics: [] }] })).toBe(false);
  });

  it("is true only when every topic in every module is ticked", () => {
    const t = (done: boolean, id = "t") => ({ id, name: id, done, doneAt: null });
    expect(planComplete({ id: "p", name: "n", modules: [{ topics: [t(true)] }] })).toBe(true);
    expect(
      planComplete({ id: "p", name: "n", modules: [{ topics: [t(true, "a")] }, { topics: [t(false, "b")] }] }),
    ).toBe(false);
  });
});

describe("terminalItems", () => {
  it("takes graded courses and leaves ungraded ones in flight", () => {
    const items = terminalItems(
      input({
        courses: [
          { id: "c2", name: "Algorithms", code: "CS5800", grade: "A" },
          { id: "c1", name: "Still Running", code: "CS1", grade: "" },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["c2"]);
    expect(items[0]!.why).toBe("graded A");
    expect(items[0]!.aliases).toEqual(["CS5800"]);
  });

  it("takes completed and archived projects only", () => {
    const items = terminalItems(
      input({
        projects: [
          { id: "p1", name: "Done", status: "Completed" },
          { id: "p2", name: "Shelved", status: "Archived" },
          { id: "p3", name: "Live", status: "Active" },
          { id: "p4", name: "Waiting", status: "Planning" },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["p1", "p2"]);
  });

  it("takes done experiments and excludes abandoned ones", () => {
    const items = terminalItems(
      input({
        experiments: [
          { id: "e1", name: "Worked", status: "done" },
          { id: "e2", name: "Gave up", status: "abandoned" },
          { id: "e3", name: "Going", status: "running" },
          { id: "e4", name: "Idea", status: "planned" },
        ],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["e1"]);
  });

  it("orders by track, then by id inside a track", () => {
    const items = terminalItems(
      input({
        courses: [
          { id: "c9", name: "Nine", code: "", grade: "B" },
          { id: "c1", name: "One", code: "", grade: "B" },
        ],
        projects: [{ id: "p1", name: "Proj", status: "Completed" }],
        experiments: [{ id: "e1", name: "Exp", status: "done" }],
        plans: [{ id: "s1", name: "Plan", modules: [{ topics: [{ id: "t", name: "t", done: true, doneAt: null }] }] }],
      }),
    );
    expect(items.map((i) => i.id)).toEqual(["c1", "c9", "p1", "e1", "s1"]);
    expect(items.map((i) => i.track)).toEqual(["courses", "courses", "projects", "research", "learn"]);
  });

  it("does not depend on the order the arrays arrive in", () => {
    const courses = [
      { id: "c3", name: "Three", code: "", grade: "A" as const },
      { id: "c1", name: "One", code: "", grade: "A" as const },
      { id: "c2", name: "Two", code: "", grade: "A" as const },
    ];
    const a = terminalItems(input({ courses }));
    const b = terminalItems(input({ courses: [...courses].reverse() }));
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
  });
});

/* ── end to end ───────────────────────────────────────────────────────── */

describe("ledger", () => {
  it("splits the same finished work three ways by where it is named", () => {
    const rows = ledger(
      input({
        courses: [
          { id: "c1", name: "Deep Learning", code: "", grade: "A" },
          { id: "c2", name: "Compilers", code: "", grade: "B" },
          { id: "c3", name: "Distributed Systems", code: "", grade: "A" },
        ],
        jobs: [job({ prepNotes: "the Deep Learning capstone" })],
        phases: [phase({ title: "Phase 2", tasks: [{ id: "t", text: "write up Compilers", done: false }] })],
      }),
    );
    expect(rows.map((r) => [r.title, r.state])).toEqual([
      ["Deep Learning", "record"],
      ["Compilers", "planned"],
      ["Distributed Systems", "unbanked"],
    ]);
  });

  it("finds the task text the remedy writes, so acting on a row changes it", () => {
    // If `bankTaskText` and the matcher ever disagree, the button looks broken:
    // the user taps it, a task appears, and the row stays red.
    const title = "Distributed Systems";
    const rows = ledger(
      input({
        courses: [{ id: "c1", name: title, code: "", grade: "A" }],
        phases: [phase({ tasks: [{ id: "t", text: bankTaskText(title), done: false }] })],
      }),
    );
    expect(rows[0]!.state).toBe("planned");
  });

  it("is empty when nothing has finished, rather than reporting zero banked", () => {
    expect(
      ledger(input({ courses: [{ id: "c1", name: "Running", code: "", grade: "" }] })),
    ).toEqual([]);
  });
});

describe("tally", () => {
  it("counts the three states and the per-track shortfall", () => {
    const rows = ledger(
      input({
        courses: [
          { id: "c1", name: "Deep Learning", code: "", grade: "A" },
          { id: "c2", name: "Compilers", code: "", grade: "A" },
        ],
        projects: [{ id: "p1", name: "Orchestrator", status: "Completed" }],
        jobs: [job({ prepNotes: "Deep Learning" })],
      }),
    );
    const t = tally(rows);
    expect(t).toMatchObject({ total: 3, record: 1, planned: 0, unbanked: 2 });
    expect(t.byTrack.courses).toEqual({ total: 2, unbanked: 1 });
    expect(t.byTrack.projects).toEqual({ total: 1, unbanked: 1 });
    expect(t.byTrack.research).toEqual({ total: 0, unbanked: 0 });
    expect(t.byTrack.learn).toEqual({ total: 0, unbanked: 0 });
  });

  it("is all zeroes for an empty ledger", () => {
    expect(tally([])).toMatchObject({ total: 0, record: 0, planned: 0, unbanked: 0 });
  });
});
