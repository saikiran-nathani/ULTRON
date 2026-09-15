/**
 * Stage 3c's properties: the reconciler finds the damage a clean merge leaves,
 * names it, and changes nothing.
 *
 * Every failure these guard against shares one signature — **no error, no
 * conflict, no lost push, and a state the app cannot render.** That is what
 * makes them worth tests: there is nothing else in the system that would ever
 * complain.
 *
 * Three classes here, and the third is the reason for the other two:
 *
 * - **found** — a pointer into a deleted record is reported, for every
 *   reference in the table rather than for habits specifically.
 * - **not found** — a record pointing nowhere is healthy. A needs-attention
 *   list with false positives is a list nobody reads, at which point the real
 *   findings are invisible again and the feature is worse than absent.
 * - **inert** — `reconcile` does not mutate, does not repair, and returns the
 *   same list twice. Its caller holds the snapshot as its sync baseline, and a
 *   baseline that moves makes the next diff come out empty.
 */
import { describe, expect, it } from "vitest";
import { NEXUS_REGISTRY, flatten, joinKey, rehydrate, type Orphan } from "./registry";
import { applyPulled, diff, snapshotOf, type Snapshot } from "./flatten";
import { formatHlc } from "./clock";
import { NEXUS_REFERENCES, reconcile } from "./reconcile";

const T0 = 1_789_344_000_000;
const hlc = () => {
  let n = 0;
  return () => formatHlc(T0, n++, "dev-a");
};

/**
 * A blob the app itself could have written, with the id shapes it really mints.
 *
 * The ids are load-bearing, not decoration: `uid()`-shaped records, a habit
 * completion's `${habitId}:${date}` composite, and a roadmap phase/task pair
 * carrying `seed:NNNN:kind:slug` on *both* sides of a nested key. Fixtures
 * built from `p1`/`t1` let a key-splitting bug pass every test and then lose a
 * real dataset — that already happened once in 3b.
 */
function cleanBlob() {
  return {
    schemaVersion: 4,
    settings: { baseCurrency: "USD" },
    academics: {
      semesters: ["Fall 2025"],
      courses: [
        { id: "mzr7x8ab1", code: "CS5010", assignments: [{ id: "mzr7x8ab2", name: "HW1" }] },
      ],
      studyPlanner: {
        plans: [{ id: "mzr7x8ab3", name: "DSA" }],
        sessions: [
          { id: "mzr7x8ab4", duration: 30, plan: "mzr7x8ab3", topic: "graphs" },
          // The "No plan" session. Every real store has these.
          { id: "mzr7x8ab5", duration: 45, plan: null, topic: "reading" },
        ],
        pomodoroSettings: { focus: 25, shortBreak: 5, longBreak: 15, rounds: 4 },
        weeklyGoalMinutes: 420,
      },
    },
    projects: [
      {
        id: "p1",
        name: "Alpha",
        tasks: [
          { id: "t1", name: "design", sort: 1024 },
          { id: "t2", name: "build", sort: 2048 },
        ],
      },
      { id: "p2", name: "Beta", tasks: [] },
    ],
    career: { jobs: [], certifications: [] },
    journal: {
      entries: [{ id: "mzr7x8ab6", content: "hi", mood: 3 }],
      habits: [
        { id: "h1", name: "Read", color: "#fff" },
        { id: "h2", name: "Walk", color: "#000" },
      ],
      habitCompletions: [
        { id: "h1:2026-09-12", habitId: "h1", date: "2026-09-12" },
        { id: "h1:2026-09-13", habitId: "h1", date: "2026-09-13" },
        { id: "h2:2026-09-13", habitId: "h2", date: "2026-09-13" },
      ],
      readingList: [],
      fragments: [],
    },
    dashboard: { todos: [] },
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
      layers: [],
    },
  };
}

const clean = (): Snapshot => flatten(cleanBlob(), NEXUS_REGISTRY);

/** A bucket, asserted present, so a drifted fixture fails here and not silently. */
function bucket(snap: Snapshot, collection: string): Record<string, unknown> {
  const b = snap[collection];
  expect(b, `fixture has no ${collection} bucket`).toBeDefined();
  return b as Record<string, unknown>;
}

// ══ a healthy snapshot ═══════════════════════════════════════════════════

describe("a snapshot the app could have produced", () => {
  it("yields no findings", () => {
    // Prevents: a reconciler that reports healthy data. Everything below it
    // offers the user a destructive repair, so a false positive here costs
    // real records — and a list of them trains the user to dismiss the list.
    expect(reconcile(clean())).toEqual([]);
  });

  it("is not vacuously clean — it holds records and live references", () => {
    // Prevents: the above passing because the fixture drifted to empty, or
    // because every reference field happens to be null. A green suite over no
    // data is the failure mode that hides all the others.
    const snap = clean();
    for (const ref of NEXUS_REFERENCES) {
      const holders = Object.values(bucket(snap, ref.from));
      const pointing = holders.filter(
        (r) => typeof (r as Record<string, unknown>)[ref.field] === "string",
      );
      expect(pointing.length, `no ${ref.from} record sets ${ref.field}`).toBeGreaterThan(0);
      expect(Object.keys(bucket(snap, ref.to)).length, `${ref.to} is empty`).toBeGreaterThan(0);
    }
    // And the orphan half needs something to be wrong about too.
    const nested = NEXUS_REGISTRY.filter((s) => s.kind === "nested");
    const populated = nested.filter((s) => Object.keys(snap[s.name] ?? {}).length > 0);
    expect(populated.length, "no nested collection has children").toBeGreaterThan(0);
  });
});

// ══ dangling references — the half rehydrate cannot see ══════════════════

describe("dangling references", () => {
  it("finds a habit tick whose habit was deleted elsewhere", () => {
    // The case this file exists for. Two devices, no conflict, both pushes
    // accepted, and a tick that renders nowhere because the grid iterates
    // habits. Prevents: the only observable symptom staying "the user's
    // streak is wrong and nothing says why".
    const snap = clean();
    delete bucket(snap, "journal.habits")["h1"];

    const found = reconcile(snap);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      kind: "dangling-reference",
      collection: "journal.habitCompletions",
      id: "h1:2026-09-12",
      field: "habitId",
      missing: { collection: "journal.habits", id: "h1" },
    });
    expect(found[0]!.message).toContain("h1");
  });

  it("finds a study session whose plan was deleted, without a line of code about plans", () => {
    // Prevents: a habit-shaped special case masquerading as a general check.
    // If the second table entry did not work, adding the third would silently
    // do nothing — and read as a clean report.
    const snap = clean();
    delete bucket(snap, "academics.studyPlanner.plans")["mzr7x8ab3"];

    const found = reconcile(snap);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      collection: "academics.studyPlanner.sessions",
      id: "mzr7x8ab4",
      field: "plan",
      missing: { collection: "academics.studyPlanner.plans", id: "mzr7x8ab3" },
    });
  });

  it("does not report a reference that is absent, null or empty", () => {
    // Prevents: "points nowhere" being read as "points at something missing".
    // `StudySession.plan` is `ID | null` and the plan picker's "No plan" is
    // `value=""`, so this mistake reports every unplanned session in the app
    // on first load — thousands of findings, none actionable, and the real one
    // buried among them.
    //
    // The positive control in the same snapshot is what stops this test
    // passing for the wrong reason: if the check were disabled outright, the
    // fourth record would not be found either.
    const snap = clean();
    const ticks = bucket(snap, "journal.habitCompletions");
    ticks["no-field"] = { id: "no-field", date: "2026-09-14" };
    ticks["null-field"] = { id: "null-field", habitId: null, date: "2026-09-14" };
    ticks["empty-field"] = { id: "empty-field", habitId: "", date: "2026-09-14" };
    ticks["gone-field"] = { id: "gone-field", habitId: "h9", date: "2026-09-14" };

    expect(reconcile(snap).map((f) => f.id)).toEqual(["gone-field"]);
  });

  it("treats a target that is present but bodyless as gone", () => {
    // Prevents: an `Object.hasOwn` existence check. `applyPulled` writes
    // `bucket[id] = r.body` for any non-tombstone record, so a record arriving
    // with no body leaves the key in place with nothing behind it. A
    // key-existence check calls that habit present and reports clean, while
    // the app has nothing to draw.
    const snap = clean();
    bucket(snap, "journal.habits")["h1"] = undefined;
    bucket(snap, "academics.studyPlanner.plans")["mzr7x8ab3"] = null;

    expect(reconcile(snap).map((f) => f.id).sort()).toEqual([
      "h1:2026-09-12",
      "h1:2026-09-13",
      "mzr7x8ab4",
    ]);
  });

  it("reports every broken record, not just the first one it meets", () => {
    // Prevents: an early return, or a `find` where a filter belongs. Half a
    // needs-attention list is the worst possible artefact — the user repairs
    // what it shows, sees it go green, and still has broken data.
    const snap = clean();
    delete bucket(snap, "journal.habits")["h1"];
    delete bucket(snap, "academics.studyPlanner.plans")["mzr7x8ab3"];
    delete bucket(snap, "projects")["p1"];

    const found = reconcile(snap);
    expect(found.filter((f) => f.kind === "dangling-reference")).toHaveLength(3);
    expect(found.filter((f) => f.kind === "orphaned-child")).toHaveLength(2);
    expect(new Set(found.map((f) => f.collection)).size).toBe(3);
  });

  it("reports a pointer into a collection that is gone entirely", () => {
    // Prevents: skipping the sweep when the target bucket is absent. Deleting
    // the last habit removes the bucket (`applyPulled` drops it when it
    // empties), which is precisely when every surviving tick is dangling — so
    // the cheap `if (!targets) continue;` guard blinds the check in the one
    // case where it matters most.
    const snap = clean();
    delete snap["journal.habits"];

    expect(reconcile(snap).filter((f) => f.kind === "dangling-reference")).toHaveLength(3);
  });

  it("carries a remedy as data, and performs neither", () => {
    // Prevents: auto-repair creeping in. Deleting the tick republishes the
    // habit deletion as a fresh authoritative write and destroys the evidence
    // the day was ticked; recreating the habit resurrects something someone
    // deleted on purpose. Both are offered; neither is chosen here.
    const snap = clean();
    delete bucket(snap, "journal.habits")["h1"];
    const before = snapshotOf(snap);

    const found = reconcile(snap);
    expect(found[0]!.remedies).toEqual([
      { action: "delete-record", collection: "journal.habitCompletions", id: "h1:2026-09-12" },
      { action: "recreate-record", collection: "journal.habits", id: "h1" },
    ]);
    expect(snap, "a remedy was applied").toEqual(before);
  });
});

// ══ orphaned children — rehydrate's half, surfaced rather than logged ═════

describe("orphaned children", () => {
  it("finds a nested child whose parent is gone", () => {
    // `rehydrate` drops these and `console.warn`s. A warning in a devtools
    // console the user will never open is indistinguishable from silence.
    // Prevents: the drop being invisible to the UI that could report it.
    const snap = clean();
    delete bucket(snap, "projects")["p1"];

    const found = reconcile(snap);
    expect(found).toHaveLength(2);
    expect(found[0]).toMatchObject({
      kind: "orphaned-child",
      collection: "projects.tasks",
      id: joinKey("p1", "t1"),
      missing: { collection: "projects", id: "p1" },
    });
    // No field: an orphan's pointer is its own key, and naming a field here
    // would be inventing one.
    expect(found[0]!.field).toBeUndefined();
  });

  it("recovers the parent id from a key with colons on both sides", () => {
    // Prevents: splitting the key on ":" by hand. The roadmap seed mints
    // `seed:0001:phase:…` parents and `seed:0002:task:…` children, so a naive
    // split names a parent of "seed" (decoded) or keeps the percent-escapes
    // (encoded) — and the remedy then offers to recreate a record that has
    // never existed, on every device.
    const snap = clean();
    delete bucket(snap, "roadmap.phases")["seed:0001:phase:ship"];

    const found = reconcile(snap);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      collection: "roadmap.phases.tasks",
      id: joinKey("seed:0001:phase:ship", "seed:0002:task:do-the-thing"),
      missing: { collection: "roadmap.phases", id: "seed:0001:phase:ship" },
    });
    expect(found[0]!.message).toContain("seed:0001:phase:ship");
    expect(found[0]!.message).not.toContain("%3A");
  });

  it("names a real collection in every message it produces", () => {
    // Prevents: a template hole. These strings are the whole product — a
    // sentence reading "belongs to undefined undefined" is a bug report from
    // the user rather than an action they can take.
    const snap = clean();
    delete bucket(snap, "projects")["p1"];
    delete bucket(snap, "journal.habits")["h1"];
    delete bucket(snap, "roadmap.phases")["seed:0001:phase:ship"];

    const found = reconcile(snap);
    expect(found.length).toBeGreaterThan(0);
    const names = new Set(NEXUS_REGISTRY.map((s) => s.name));
    for (const f of found) {
      expect(f.message, f.message).not.toContain("undefined");
      expect(f.message.split("\n")).toHaveLength(1);
      expect(names, `${f.collection} is not a registry collection`).toContain(f.collection);
      expect(names).toContain(f.missing.collection);
      expect(f.missing.id.length, `${f.kind} has no missing id`).toBeGreaterThan(0);
    }
  });
});

// ══ inert by construction ════════════════════════════════════════════════

describe("purity", () => {
  it("does not mutate the snapshot it inspects", () => {
    // Prevents the worst bug available to this file. The caller holds this
    // snapshot as its sync BASELINE; a write here moves the thing the next
    // diff is measured against, in the direction that makes the diff look
    // empty. Two devices would agree to disagree and never exchange another
    // record. `rehydrate` writes `parent[childKey]` into the records it
    // rebuilds, so a reconciler that skipped its clone would do exactly this.
    const snap = clean();
    delete bucket(snap, "projects")["p1"];
    delete bucket(snap, "journal.habits")["h1"];
    const frozen = snapshotOf(snap);

    reconcile(snap);
    expect(snap).toEqual(frozen);
  });

  it("returns the same list whatever order the records arrived in", () => {
    // Prevents: findings ordered by `Object.entries` insertion order, which is
    // the server's `seq` delivery order. Two devices holding identical data
    // would show the user the same problems in different orders, and a list
    // that reshuffles between loads reads as churn instead of as something to
    // act on. Same argument as `rehydrate`'s canonical sort.
    const snap = clean();
    delete bucket(snap, "projects")["p1"];
    delete bucket(snap, "journal.habits")["h1"];
    const records = Object.entries(snap).flatMap(([collection, recs]) =>
      Object.entries(recs).map(([id, body]) => ({ collection, id, body })),
    );

    const forwards = reconcile(applyPulled({}, records));
    const backwards = reconcile(applyPulled({}, [...records].reverse()));
    expect(backwards).toEqual(forwards);
    expect(forwards.length).toBeGreaterThan(1);
  });
});

// ══ the reference table ══════════════════════════════════════════════════

describe("the reference table", () => {
  it("names only collections that exist in the registry", () => {
    // The self-check, and it is not bookkeeping. A typo in `from` or `to`
    // means that reference is never checked — and the result is not an error,
    // it is a *clean report*. That is strictly worse than having no check at
    // all, because the clean report is believed.
    const names = new Set(NEXUS_REGISTRY.map((s) => s.name));
    for (const ref of NEXUS_REFERENCES) {
      expect(names, `${ref.from}.${ref.field}: no such collection ${ref.from}`).toContain(ref.from);
      expect(names, `${ref.from}.${ref.field}: no such collection ${ref.to}`).toContain(ref.to);
    }
  });

  it("points only at `records` collections", () => {
    // Prevents a false-positive flood. A `singleton` bucket is keyed by the
    // collection name and a `nested` bucket by `parentId:childId`, so an id
    // compared against either matches nothing and every holding record is
    // reported. Better to fail here than to ship a screen full of wrong.
    for (const ref of NEXUS_REFERENCES) {
      const spec = NEXUS_REGISTRY.find((s) => s.name === ref.to);
      expect(spec?.kind, `${ref.to} is ${spec?.kind}, not records`).toBe("records");
    }
  });

  it("declares each reference once", () => {
    // Prevents: a duplicated line double-reporting one broken record. The user
    // repairs it, the count only halves, and the list stops looking credible.
    const keys = NEXUS_REFERENCES.map((r) => `${r.from}.${r.field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("covers the reference the model is built around", () => {
    // `HabitCompletion.habitId` is the one with a deletion path on one device
    // and a creation path on another (`delHabit` sweeps locally; `toggleHabit`
    // refuses to tick a habit it cannot see) — so it is the one place the
    // invariant is impossible to break locally and trivial to break by
    // syncing. Prevents: the table being refactored down to nothing.
    expect(NEXUS_REFERENCES).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "journal.habitCompletions",
          field: "habitId",
          to: "journal.habits",
        }),
      ]),
    );
  });
});

// ══ the narrative: both devices synced cleanly, the result is broken ══════

describe("two devices, two records, no conflict", () => {
  it("produces a state neither device could have written, and only reconcile says so", () => {
    // The whole reason Stage 3c exists, walked end to end through the real
    // path: flatten → diff → applyPulled → rehydrate.
    //
    // Prevents: believing per-record granularity made the merge safe. Every
    // check the system has passes here. The pushes are disjoint, so nothing
    // conflicts; both devices converge on byte-identical snapshots, so
    // commutativity holds; `rehydrate` reports no orphans, because the
    // relationship is a field and not a key. The data is still broken, and
    // without this file nothing in the app would ever mention it.
    const baseline = flatten(cleanBlob(), NEXUS_REGISTRY);

    // The phone deletes habit h1. `delHabit` sweeps its ticks on the way out,
    // so the phone's own state is perfectly consistent.
    const phone = cleanBlob();
    phone.journal.habits = phone.journal.habits.filter((h) => h.id !== "h1");
    phone.journal.habitCompletions = phone.journal.habitCompletions.filter(
      (c) => c.habitId !== "h1",
    );
    const phoneSnap = flatten(phone, NEXUS_REGISTRY);

    // The laptop, offline, ticks h1 for today. `toggleHabit` checks the habit
    // exists first — and on the laptop it still does. Also consistent.
    const laptop = cleanBlob();
    laptop.journal.habitCompletions.push({
      id: "h1:2026-09-14",
      habitId: "h1",
      date: "2026-09-14",
    });
    const laptopSnap = flatten(laptop, NEXUS_REGISTRY);

    const fromPhone = diff(baseline, phoneSnap, hlc());
    const fromLaptop = diff(baseline, laptopSnap, hlc());

    // Nothing to conflict over: the two pushes touch disjoint record ids, so
    // the server accepts both and neither device is told anything is amiss.
    const touched = (cs: { collection: string; id: string }[]) =>
      new Set(cs.map((c) => `${c.collection}/${c.id}`));
    const phoneKeys = touched(fromPhone.changes);
    const laptopKeys = touched(fromLaptop.changes);
    expect(phoneKeys.size).toBeGreaterThan(0);
    expect(laptopKeys.size).toBeGreaterThan(0);
    expect([...laptopKeys].filter((k) => phoneKeys.has(k))).toEqual([]);

    // Both pull the other's changes and land on the same state — the
    // convergence property 3b promised, delivered.
    const onPhone = applyPulled(phoneSnap, fromLaptop.changes);
    const onLaptop = applyPulled(laptopSnap, fromPhone.changes);
    expect(onLaptop).toEqual(onPhone);

    // Rebuilding the blob reports nothing. This is the blind spot: the
    // orphan sweep is structural, and a `habitId` is not a key.
    const orphans: Orphan[] = [];
    const merged = rehydrate(onPhone, NEXUS_REGISTRY, (o) => orphans.push(o)) as ReturnType<
      typeof cleanBlob
    >;
    expect(orphans).toEqual([]);

    // And yet: a tick belonging to a habit that no longer exists. Neither
    // device's code can reach this state; only the merge can.
    const habits = new Set(merged.journal.habits.map((h) => h.id));
    expect(habits.has("h1")).toBe(false);
    expect(merged.journal.habitCompletions.map((c) => c.id)).toContain("h1:2026-09-14");
    expect(
      merged.journal.habitCompletions.filter((c) => !habits.has(c.habitId)).map((c) => c.id),
    ).toEqual(["h1:2026-09-14"]);

    const found = reconcile(onPhone);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "dangling-reference",
      collection: "journal.habitCompletions",
      id: "h1:2026-09-14",
      field: "habitId",
      missing: { collection: "journal.habits", id: "h1" },
    });

    // Reporting is all it does. The snapshot is untouched, so nothing is
    // queued to push — a repair here would republish the phone's deletion as
    // a second edit and lose the tick on every device at once.
    expect(diff(onPhone, onPhone, hlc()).changes).toEqual([]);
  });
});
