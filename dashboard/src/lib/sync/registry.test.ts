/**
 * Stage 3b's properties — written before the implementation, as the plan asks.
 *
 * The plan's requirement for 3b is not "make it per-record" (the transport has
 * been per-record since 3a). It is that **moving granularity is a change to
 * one declarative file and nothing else.** So what is under test is the
 * mechanism's generality: if `flatten`/`rehydrate` are driven entirely by the
 * registry, then adding a collection is one line and the screens never learn
 * that sync exists.
 *
 * Three properties, and each has a specific silent failure behind it:
 *
 * - **round-trip** — `rehydrate(flatten(x)) === x`. If this fails, sync
 *   quietly rewrites the user's data on the way through. Worst of the three,
 *   because both devices agree on the corrupted result.
 * - **idempotence** — flattening twice changes nothing. A generator that
 *   appends, or that mints a fresh key per call, pushes the whole dataset on
 *   every sync forever.
 * - **commutativity** — records applied in any order rebuild the same blob.
 *   Without it, two devices that both sync successfully still disagree, and
 *   which one is right depends on packet arrival order.
 *
 * These are written against a synthetic blob shaped like `NexusData` rather
 * than against the real types, because the domains have not been ported yet
 * (Stage 4) and the mechanism must not care. That is the same choice as 3a's
 * `Snapshot`, for the same reason: a sync layer that knows what a `Project` is
 * gets rewritten whenever a `Project` changes.
 */
import { describe, expect, it } from "vitest";
import {
  NEXUS_REGISTRY,
  collectionsOf,
  flatten,
  joinKey,
  rehydrate,
  splitKey,
  type Orphan,
  type Registry,
} from "./registry";
import { applyPulled, diff, snapshotOf } from "./flatten";
import { formatHlc } from "./clock";

const T0 = 1_789_344_000_000;
const hlc = () => {
  let n = 0;
  return () => formatHlc(T0, n++, "dev-a");
};

/** A small registry exercising all three kinds. */
const TOY: Registry = [
  { name: "settings", path: "settings", kind: "singleton" },
  { name: "journal.entries", path: "journal.entries", kind: "records" },
  { name: "projects", path: "projects", kind: "records" },
  { name: "projects.tasks", path: "projects[].tasks", kind: "nested" },
];

function toyBlob() {
  return {
    schemaVersion: 4,
    settings: { baseCurrency: "USD" },
    journal: {
      entries: [
        { id: "e1", content: "first", mood: 3 },
        { id: "e2", content: "second", mood: 4 },
      ],
    },
    projects: [
      {
        id: "p1",
        name: "Alpha",
        tasks: [
          { id: "t1", name: "design", done: false, sort: 1024 },
          { id: "t2", name: "build", done: true, sort: 2048 },
        ],
      },
      { id: "p2", name: "Beta", tasks: [] },
    ],
  };
}

// ══ the three properties ═════════════════════════════════════════════════

describe("round-trip", () => {
  it("rehydrate(flatten(blob)) equals the blob", () => {
    const blob = toyBlob();
    expect(rehydrate(flatten(blob, TOY), TOY)).toEqual(blob);
  });

  it("survives a blob with empty and absent collections", () => {
    // A fresh store has empty arrays; an older one is missing keys entirely.
    // Both must come back as they went in, or the first sync after an upgrade
    // rewrites the user's data.
    const empty = { schemaVersion: 4, settings: {}, journal: { entries: [] }, projects: [] };
    expect(rehydrate(flatten(empty, TOY), TOY)).toEqual(empty);
  });

  it("preserves fields the registry knows nothing about", () => {
    // The "old client eats new data" shape, at the sync layer. A flatten that
    // only kept registered fields would delete everything added since this
    // build — and the deletion would propagate to every other device.
    const blob = { ...toyBlob(), futureField: { added: "later" }, schemaVersion: 9 };
    expect(rehydrate(flatten(blob, TOY), TOY)).toEqual(blob);
  });

  it("round-trips the real NexusData registry", () => {
    expect(rehydrate(flatten(nexusLike(), NEXUS_REGISTRY), NEXUS_REGISTRY)).toEqual(nexusLike());
  });

  it("returns arrays in canonical id order, not the order they went in", () => {
    // The limit of the property above, stated rather than left to luck.
    //
    // Array POSITION is not synced — records arrive one at a time, in `seq`
    // order — so `rehydrate` sorts by key to make the result a function of the
    // data alone. Every fixture here happens to be id-ascending, which would
    // let a buggy arrival-order implementation pass the round-trip tests; this
    // one hands it a blob in the wrong order on purpose.
    //
    // So the honest statement of round-trip is "equal up to canonical order",
    // and the consequence for Stage 4 is a rule: no screen may depend on array
    // position. Order by `sort`, a date, or a name.
    const shuffled = {
      schemaVersion: 4,
      settings: {},
      journal: { entries: [{ id: "e2" }, { id: "e1" }] },
      projects: [],
    };
    const out = rehydrate(flatten(shuffled, TOY), TOY) as { journal: { entries: { id: string }[] } };
    expect(out.journal.entries.map((e) => e.id)).toEqual(["e1", "e2"]);
  });

  it("does not mutate the snapshot it rehydrates", () => {
    // The caller holds this snapshot as its sync BASELINE. `Object.values`
    // hands out live references, so a naive rehydrate writes `tasks` back into
    // the very records it was reading — and the next diff, measured against a
    // baseline that has silently moved, comes out empty. Two devices would
    // agree to disagree and never exchange another record.
    const snapshot = flatten(toyBlob(), TOY);
    const frozen = snapshotOf(snapshot);
    rehydrate(snapshot, TOY);
    expect(snapshot).toEqual(frozen);
  });
});

describe("idempotence", () => {
  it("flattening twice produces identical snapshots", () => {
    const blob = toyBlob();
    expect(flatten(blob, TOY)).toEqual(flatten(blob, TOY));
  });

  it("a round-trip then a re-flatten produces the same snapshot", () => {
    // The loop that runs on every sync. If a key or a body drifts on the way
    // through, every record looks dirty and the whole dataset is pushed —
    // forever, on a timer.
    const once = flatten(toyBlob(), TOY);
    expect(flatten(rehydrate(once, TOY), TOY)).toEqual(once);
  });

  it("produces no changes to push when nothing was edited", () => {
    // The property that actually matters to the user: an idle app is silent.
    const blob = toyBlob();
    const snapshot = flatten(blob, TOY);
    const baseline = snapshotOf(snapshot);
    expect(diff(baseline, flatten(blob, TOY), hlc()).changes).toEqual([]);
  });
});

describe("commutativity", () => {
  it("records applied in any order rebuild the same blob", () => {
    const snapshot = flatten(toyBlob(), TOY);
    const records = Object.entries(snapshot).flatMap(([collection, recs]) =>
      Object.entries(recs).map(([id, body]) => ({ collection, id, body })),
    );

    const forwards = rehydrate(applyPulled({}, records), TOY);
    const backwards = rehydrate(applyPulled({}, [...records].reverse()), TOY);
    expect(backwards).toEqual(forwards);
  });

  it("interleaves a parent and its children in either order", () => {
    // The nested case, which is the one that can go wrong: rehydrating a task
    // before its project exists must not drop the task or invent a project.
    const snapshot = flatten(toyBlob(), TOY);
    const parents = Object.entries(snapshot["projects"] ?? {}).map(([id, body]) => ({
      collection: "projects",
      id,
      body,
    }));
    const children = Object.entries(snapshot["projects.tasks"] ?? {}).map(([id, body]) => ({
      collection: "projects.tasks",
      id,
      body,
    }));

    const childrenFirst = rehydrate(applyPulled({}, [...children, ...parents]), TOY);
    const parentsFirst = rehydrate(applyPulled({}, [...parents, ...children]), TOY);
    expect(childrenFirst).toEqual(parentsFirst);
  });
});

// ══ per-record granularity is the point ══════════════════════════════════

describe("granularity", () => {
  it("editing one record marks exactly one record dirty", () => {
    // 3a at slice level would have marked the whole `journal` slice dirty, so
    // two devices editing two different entries in one offline window meant
    // one lost. This is the whole reason 3b exists.
    const before = flatten(toyBlob(), TOY);
    const edited = toyBlob();
    edited.journal.entries[0]!.content = "changed";

    const out = diff(before, flatten(edited, TOY), hlc());
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toMatchObject({ collection: "journal.entries", id: "e1" });
  });

  it("editing one task does not touch its project or its sibling", () => {
    const before = flatten(toyBlob(), TOY);
    const edited = toyBlob();
    edited.projects[0]!.tasks[0]!.done = true;

    const out = diff(before, flatten(edited, TOY), hlc());
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]!.collection).toBe("projects.tasks");
    expect(out.changes[0]!.id).toBe("p1:t1");
  });

  it("a nested record's key carries its parent", () => {
    // Two projects can hold tasks with the same task id — ids are only unique
    // within their parent in the existing model. A bare child id would make
    // them collide and one would silently overwrite the other.
    const snapshot = flatten(toyBlob(), TOY);
    expect(Object.keys(snapshot["projects.tasks"] ?? {})).toEqual(["p1:t1", "p1:t2"]);
    expect(splitKey("p1:t1")).toEqual({ parent: "p1", child: "t1" });
  });

  it("survives ids that contain the separator, on either side", () => {
    // This is the test that was missing, and the gap cost the whole dataset.
    //
    // The naive `${parent}:${child}` key split on the first colon passed 22
    // tests built on ids like `p1`/`t1`, then dropped all 90 records of a real
    // default blob: the roadmap seed mints `seed:phase:…` parents and
    // `seed:task:…` children, so the parent parsed as `"seed"` and every child
    // was an orphan. Splitting on the LAST colon fails the mirror case — a
    // habit completion's id is `${habitId}:${date}`, so the child keeps the
    // colon instead. Both sides must be able to carry one.
    const colonBoth: Registry = [
      { name: "phases", path: "roadmap.phases", kind: "records" },
      { name: "phases.tasks", path: "roadmap.phases[].tasks", kind: "nested" },
    ];
    const blob = {
      roadmap: {
        phases: [
          {
            id: "seed:phase:ship-the-flagship",
            title: "Ship it",
            tasks: [
              { id: "seed:task:build-an-eval-harness", done: false },
              { id: "h1:2026-09-14", done: true },
            ],
          },
        ],
      },
    };

    const snapshot = flatten(blob, colonBoth);
    expect(Object.keys(snapshot["phases.tasks"] ?? {})).toHaveLength(2);

    // Every key must round-trip to the exact pair it was built from.
    for (const key of Object.keys(snapshot["phases.tasks"] ?? {})) {
      expect(splitKey(key).parent).toBe("seed:phase:ship-the-flagship");
    }
    expect(Object.keys(snapshot["phases.tasks"] ?? {}).map((k) => splitKey(k).child).sort()).toEqual(
      ["h1:2026-09-14", "seed:task:build-an-eval-harness"],
    );

    // And nothing is dropped on the way back. (Canonical order applies, so
    // this compares the record set, not the array positions.)
    const orphans: Orphan[] = [];
    const out = rehydrate(snapshot, colonBoth, (o) => orphans.push(o)) as typeof blob;
    expect(orphans).toEqual([]);
    expect(out.roadmap.phases.map((p) => p.id)).toEqual(["seed:phase:ship-the-flagship"]);
    expect(out.roadmap.phases[0]!.tasks.map((t) => t.id).sort()).toEqual(
      ["h1:2026-09-14", "seed:task:build-an-eval-harness"],
    );
    expect(out.roadmap.phases[0]!.tasks.find((t) => t.id === "h1:2026-09-14")?.done).toBe(true);
  });

  it("splitKey inverts joinKey for adversarial ids", () => {
    for (const parent of ["p1", "seed:phase:x", "a%3Ab", "100%", ":", ""]) {
      for (const child of ["t1", "h1:2026-09-14", "a:b:c", "%", ":"]) {
        expect(splitKey(joinKey(parent, child))).toEqual({ parent, child });
      }
    }
  });

  it("does not store children inside their parent's record", () => {
    // Otherwise a task edit rewrites the project body and the granularity is
    // a fiction — the conflict surface would be unchanged from 3a.
    const snapshot = flatten(toyBlob(), TOY);
    const p1 = snapshot["projects"]?.["p1"] as Record<string, unknown>;
    expect(p1).toBeDefined();
    expect(p1["tasks"]).toBeUndefined();
    expect(p1["name"]).toBe("Alpha");
  });

  it("deleting a task is one tombstone, not a project rewrite", () => {
    const before = flatten(toyBlob(), TOY);
    const edited = toyBlob();
    edited.projects[0]!.tasks.pop();

    const out = diff(before, flatten(edited, TOY), hlc());
    expect(out.changes).toHaveLength(1);
    expect(out.changes[0]).toMatchObject({ collection: "projects.tasks", id: "p1:t2", deleted: true });
  });
});

// ══ orphans — the known cost of going nested ═════════════════════════════

describe("orphans", () => {
  it("drops a child whose parent is gone, rather than inventing one", () => {
    // 3c's "orphan sweep". A task arriving for a project that was deleted on
    // another device has nowhere to go. Inventing a placeholder parent would
    // resurrect a deleted project; dropping the child is the lesser loss, and
    // the record survives in the server's append-only log either way.
    const snapshot = flatten(toyBlob(), TOY);
    delete snapshot["projects"]!["p1"];
    const out = rehydrate(snapshot, TOY) as ReturnType<typeof toyBlob>;
    expect(out.projects.map((p) => p.id)).toEqual(["p2"]);
    expect(out.projects.every((p) => p.tasks.every((t) => t.id !== "t1"))).toBe(true);
  });

  it("reports what it dropped instead of doing it silently", () => {
    // A silent drop is indistinguishable from the record never existing, which
    // is exactly the class of bug this whole layer is built to avoid.
    const snapshot = flatten(toyBlob(), TOY);
    delete snapshot["projects"]!["p1"];
    const orphans: string[] = [];
    rehydrate(snapshot, TOY, (o) => orphans.push(`${o.collection}/${o.id}`));
    expect(orphans).toEqual(["projects.tasks/p1:t1", "projects.tasks/p1:t2"]);
  });
});

// ══ the registry itself ══════════════════════════════════════════════════

describe("the NexusData registry", () => {
  it("covers every domain the blob has", () => {
    const names = collectionsOf(NEXUS_REGISTRY);
    for (const domain of [
      "settings",
      "academics.courses",
      "academics.studyPlanner.sessions",
      "projects",
      "projects.tasks",
      "career.jobs",
      "journal.entries",
      "journal.habitCompletions",
      "dashboard.todos",
      "roadmap.phases",
    ]) {
      expect(names).toContain(domain);
    }
  });

  it("has unique collection names", () => {
    // The collection name is half of the record's primary key on the server.
    // A duplicate would silently merge two unrelated collections.
    const names = collectionsOf(NEXUS_REGISTRY);
    expect(new Set(names).size).toBe(names.length);
  });

  it("declares a parent for every nested collection, and it exists", () => {
    const names = new Set(collectionsOf(NEXUS_REGISTRY));
    for (const spec of NEXUS_REGISTRY) {
      if (spec.kind !== "nested") continue;
      const parentPath = spec.path.slice(0, spec.path.indexOf("[]"));
      const parent = NEXUS_REGISTRY.find((s) => s.path === parentPath);
      expect(parent, `${spec.name} has no parent collection for ${parentPath}`).toBeDefined();
      expect(names).toContain(parent!.name);
    }
  });

  it("is a plausible size for the model", () => {
    // The plan estimates 35–40. Being far under means nesting was skipped and
    // the conflict surface is bigger than it looks.
    expect(collectionsOf(NEXUS_REGISTRY).length).toBeGreaterThanOrEqual(25);
  });
});

/** A blob shaped like NexusData, with one record in each collection. */
/**
 * One record per collection, with the id shapes the real app actually mints.
 *
 * The ids matter as much as the structure. An earlier version of this fixture
 * used `ph1`/`rt1`/`ly1`, and every test here passed while a real default blob
 * lost all 90 of its records — because the roadmap seed mints
 * `seed:0001:phase:…` and the nested key format could not survive a separator
 * inside an id. So: seeded records carry `seed:NNNN:kind:slug`, user records
 * carry a `uid()`-shaped `Date.now().toString(36)` + 5 random chars, and a
 * habit completion carries its `${habitId}:${date}` composite.
 */
function nexusLike() {
  return {
    schemaVersion: 4,
    settings: { baseCurrency: "USD" },
    academics: {
      semesters: ["Fall 2025"],
      courses: [
        {
          id: "mzr7x8ab1",
          code: "CS5010",
          assignments: [{ id: "mzr7x8ab2", name: "HW1" }],
        },
      ],
      studyPlanner: {
        plans: [{ id: "mzr7x8ab3", name: "DSA" }],
        sessions: [{ id: "mzr7x8ab4", duration: 30, xp: 10 }],
        pomodoroSettings: { focus: 25, shortBreak: 5, longBreak: 15, rounds: 4 },
        weeklyGoalMinutes: 420,
      },
    },
    projects: [
      {
        id: "mzr7x8ab5",
        name: "Alpha",
        tasks: [{ id: "mzr7x8ab6", name: "x", sort: 1024 }],
        milestones: [{ id: "mzr7x8ab7", name: "v1" }],
        timeLog: [{ id: "mzr7x8ab8", duration: 60 }],
        releases: [{ id: "mzr7x8ab9", version: "1.0.0" }],
        decisions: [{ id: "mzr7x8aba", title: "sqlite" }],
        runbook: { commands: [], env: [], ports: [], links: [] },
      },
    ],
    career: {
      jobs: [{ id: "mzr7x8abb", company: "Acme" }],
      certifications: [{ id: "mzr7x8abc", name: "AWS" }],
    },
    journal: {
      entries: [{ id: "mzr7x8abd", content: "hi", mood: 3 }],
      habits: [{ id: "h1", name: "Read", color: "#fff" }],
      habitCompletions: [{ id: "h1:2026-09-14", habitId: "h1", date: "2026-09-14" }],
      readingList: [{ id: "mzr7x8abe", title: "Book" }],
      fragments: [{ id: "mzr7x8abf", text: "thought" }],
    },
    dashboard: { todos: [{ id: "mzr7x8abg", text: "do it", done: false, order: 0 }] },
    routine: { lastCompletedDate: null, time: "23:30" },
    roadmap: {
      deadline: "2026-09-01",
      principles: ["one"],
      lane: "x",
      realityCheck: "y",
      throughLine: "z",
      phases: [
        {
          id: "seed:0001:phase:ship",
          title: "Ship",
          tasks: [{ id: "seed:0002:task:do-the-thing", text: "do", done: false }],
        },
      ],
      layers: [
        {
          id: "seed:0003:layer:evals",
          name: "Evals",
          proficiency: "none",
          methods: ["a"],
          tools: [{ id: "seed:0004:group:python", group: "py", items: ["pytest"] }],
          resources: [{ id: "seed:0005:res:docs", label: "docs", url: "" }],
          demo: { name: "d", tree: "t", flow: [] },
        },
      ],
    },
  };
}
