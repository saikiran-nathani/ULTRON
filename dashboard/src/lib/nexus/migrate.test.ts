/**
 * The ported model, checked against the sync layer it now has to live inside.
 *
 * `registry.test.ts` already proved `flatten`/`rehydrate` general, against a
 * blob *shaped* like `NexusData` — it had to, the domains did not exist yet.
 * The fixture it used was hand-written, and a hand-written fixture is exactly
 * where this class of bug hides: an earlier version of that file passed 22
 * tests with ids like `p1`/`t1` while a real default blob lost all 90 of its
 * records to the nested key format.
 *
 * So these run the mechanism over the *real* `makeDefaultData()` and the real
 * `NEXUS_REGISTRY`. Nothing here tests `flatten`; it tests that the model the
 * screens were written against survives a round trip through it.
 */
import { describe, expect, it } from "vitest";
import { NEXUS_REGISTRY, flatten, rehydrate, type Orphan } from "@/lib/sync/registry";
import { diff, snapshotOf } from "@/lib/sync/flatten";
import { SORT_STEP } from "./constants";
import { makeDefaultData, migrateLegacy, normalize } from "./migrate";
import { NEW_SCHEMA_VERSION, completionId } from "./types";

const hlc = () => {
  let n = 0;
  return () => `hlc-${n++}`;
};

/** A store as the previous release wrote it: schema 3, pre-record shapes. */
const schema3 = () => ({
  schemaVersion: 3,
  settings: { baseCurrency: "GBP" },
  academics: {
    semesters: ["Fall 2025"],
    courses: [{ id: "c1", code: "CS5010", assignments: [{ id: "a1", name: "HW1" }] }],
    studyPlanner: { plans: [], sessions: [{ id: "s1", duration: 30, xp: 60 }] },
  },
  projects: [
    { id: "p1", name: "Alpha", tasks: [{ id: "t1", name: "first" }, { id: "t2", name: "second" }] },
  ],
  career: {
    jobs: [{ id: "j1", company: "Acme", role: "SWE" }],
    certifications: [{ id: "k1", name: "AWS" }],
  },
  journal: {
    entries: [{ id: "e1", content: "hi", mood: 3 }],
    // Schema 3's shape: ticks live *inside* the habit, as a bare date array.
    habits: [{ id: "h1", name: "Read", color: "#fff", completions: ["2026-01-01", "2026-01-02"] }],
    readingList: [],
  },
  dashboard: { todos: [] },
  routine: { lastCompletedDate: "2026-01-02", time: "22:00" },
});

// ══ the default blob, through the real registry ═══════════════════════════

describe("makeDefaultData through flatten/rehydrate", () => {
  it("round-trips unchanged", () => {
    // The headline property of the whole port. If this fails, sync rewrites
    // the user's data on the way through — and both devices agree on the
    // rewritten result, so nothing anywhere reports a problem.
    //
    // Bound once, not called twice: the roadmap seed is deterministic per
    // call, so two calls are equal — but comparing a value against a *second*
    // construction of it would also pass if `flatten` returned its input, and
    // this test is meant to exercise the round trip rather than `toEqual`.
    const blob = makeDefaultData();
    const out = rehydrate(flatten(blob as unknown as Record<string, unknown>, NEXUS_REGISTRY), NEXUS_REGISTRY);
    expect(out).toEqual(blob);
  });

  it("drops nothing on the way through, including the roadmap seed", () => {
    // The 90-record failure, stated as a count rather than a shape. The naive
    // nested key split on the first colon parsed `seed:0001:phase:x` as a
    // parent of `"seed"`, so every seeded task orphaned and vanished — while
    // every structural assertion still passed.
    const blob = makeDefaultData();
    const orphans: Orphan[] = [];
    const out = rehydrate(
      flatten(blob as unknown as Record<string, unknown>, NEXUS_REGISTRY),
      NEXUS_REGISTRY,
      (o) => orphans.push(o),
    ) as unknown as ReturnType<typeof makeDefaultData>;

    expect(orphans).toEqual([]);
    expect(out.roadmap.phases).toHaveLength(blob.roadmap.phases.length);
    expect(out.roadmap.phases.flatMap((p) => p.tasks)).toHaveLength(
      blob.roadmap.phases.flatMap((p) => p.tasks).length,
    );
    expect(out.roadmap.layers.flatMap((l) => l.tools)).toHaveLength(
      blob.roadmap.layers.flatMap((l) => l.tools).length,
    );
  });

  it("has nothing to push when nothing was edited", () => {
    // An idle app must be silent. Any per-call non-determinism in the model —
    // a `uid()` in a default, a `Date.now()` in a seed — shows up here as a
    // dataset-sized push on a 30-second timer, on every device, forever.
    const blob = makeDefaultData() as unknown as Record<string, unknown>;
    const baseline = snapshotOf(flatten(blob, NEXUS_REGISTRY));
    expect(diff(baseline, flatten(blob, NEXUS_REGISTRY), hlc()).changes).toEqual([]);
  });

  it("mints no generated ids", () => {
    // `uid()` is `Date.now()` + randomness, so a default that contained one
    // would differ per device. The seed runs once per *device*, so two devices
    // seeding would produce two of every seeded record — duplicates that are
    // indistinguishable from records someone meant to create.
    expect(JSON.stringify(makeDefaultData())).not.toMatch(/"id":"(?!seed:)/);
  });

  it("seeds the same ids however many times it is called", () => {
    // The seed's ordinal counter is module-level. If it were not reset per
    // call, `makeDefaultData()` would return a *different* roadmap on its
    // second call in a process — and `normalize()` calls it on every load, so
    // "which call was this" would leak into record identity.
    const ids = (d: ReturnType<typeof makeDefaultData>) => d.roadmap.phases.map((p) => p.id);
    expect(ids(makeDefaultData())).toEqual(ids(makeDefaultData()));
  });

  it("has no work or finance domain", () => {
    const d = makeDefaultData() as unknown as Record<string, unknown>;
    expect(d).not.toHaveProperty("work");
    expect(d).not.toHaveProperty("finance");
  });
});

// ══ schema 3 → 4 ═════════════════════════════════════════════════════════

describe("normalize on a schema 3 store", () => {
  it("lifts habits[].completions into records and strips the inline array", () => {
    // The unmergeable field, retired. `toggleHabit` used to assign a whole new
    // date array, so two devices ticking different days in one offline window
    // meant one array overwrote the other and the loser's days were gone.
    // Habit-ticking is *the* phone activity, so it was the likeliest real loss
    // in the app.
    const d = normalize(schema3());
    expect(d.journal.habitCompletions.map((c) => c.id).sort()).toEqual([
      completionId("h1", "2026-01-01"),
      completionId("h1", "2026-01-02"),
    ]);
    expect(d.journal.habits[0]).not.toHaveProperty("completions");
  });

  it("gives every task a sort key, in the order the array already had", () => {
    // The other unmergeable field. Order was array position, and a position is
    // not an identity: two devices reordering one list produce two arrays no
    // merge can choose between. Assigning keys on load is what makes a later
    // move a single-record write.
    const tasks = normalize(schema3()).projects[0]!.tasks;
    expect(tasks.map((t) => t.sort)).toEqual([SORT_STEP, SORT_STEP * 2]);
  });

  it("keeps career, which the legacy path would have dropped", () => {
    // Guards the routing bug this port fixed, from the model's side. nexus's
    // loader sent schema 3 to `migrateLegacy`, which reads top-level
    // `old.jobs` / `old.certifications` because that is where the *legacy* app
    // kept them — so a schema-3 store's `career` block was invisible to it.
    // `db.test.ts` guards the routing itself; this proves `normalize` is the
    // function that can actually do the job.
    const d = normalize(schema3());
    expect(d.career.jobs.map((j) => j.company)).toEqual(["Acme"]);
    expect(d.career.certifications.map((c) => c.name)).toEqual(["AWS"]);
  });

  it("carries the rest of the store forward and stamps the new version", () => {
    const d = normalize(schema3());
    expect(d.schemaVersion).toBe(NEW_SCHEMA_VERSION);
    expect(d.settings.baseCurrency).toBe("GBP");
    expect(d.academics.courses[0]?.assignments).toHaveLength(1);
    expect(d.academics.studyPlanner.sessions).toHaveLength(1);
    expect(d.routine.lastCompletedDate).toBe("2026-01-02");
    // Absent in schema 3, so it comes from the defaults rather than being left
    // undefined for a screen to crash on.
    expect(d.journal.fragments).toEqual([]);
  });

  it("survives its own output", () => {
    // Loading twice must not differ from loading once, or every boot is an
    // edit and every boot pushes.
    const once = normalize(schema3());
    expect(normalize(once as unknown as Record<string, unknown>)).toEqual(once);
  });

  it("drops work and finance from a store written before their removal", () => {
    const d = normalize({ ...schema3(), work: { workplaces: [{ id: "w1" }] }, finance: { accounts: [] } });
    expect(d).not.toHaveProperty("work");
    expect(d).not.toHaveProperty("finance");
  });

  it("fills the array fields the type promises are not optional", () => {
    // `Project.milestones` and `Project.timeLog` are required in the type and
    // absent from a schema-3 project. nexus never hit this because its loader
    // sent schema 3 down the legacy path, which filled them; correcting the
    // routing made this the live path, so `normalize` has to fill them too or
    // the first render after an upgrade is `undefined.length`.
    const p0 = normalize(schema3()).projects[0]!;
    expect(p0.milestones).toEqual([]);
    expect(p0.timeLog).toEqual([]);
  });

  it("migrates a schema 3 store into a shape sync will not re-push", () => {
    // The two halves joined. Stated as *snapshot* equality rather than blob
    // equality, because the honest property is narrower than "the round trip
    // is identity" and the difference is worth naming:
    //
    // `rehydrate` gives every parent every nested key, even with no children,
    // so a project with no `releases` comes back with `releases: []`. That is
    // deliberate — an absent and an empty array are different blobs, and the
    // alternative loses the field — and it means a migrated blob is not
    // byte-identical to its own round trip for the *optional* collections.
    //
    // What must hold is the thing a spurious push depends on: `flatten` strips
    // nested arrays off the parent either way, so the wire shape is stable
    // across the trip. If this fails, every device pushes every project on
    // every cycle, forever.
    const d = normalize(schema3()) as unknown as Record<string, unknown>;
    const once = flatten(d, NEXUS_REGISTRY);
    const orphans: Orphan[] = [];
    const back = rehydrate(once, NEXUS_REGISTRY, (o) => orphans.push(o));
    expect(orphans).toEqual([]);
    expect(flatten(back, NEXUS_REGISTRY)).toEqual(once);
  });
});

describe("migrateLegacy", () => {
  it("still handles the pre-schema-3 app it was written for", () => {
    // Not dead code: a store with `_schemaVersion` ≤ 2 reads as version 0
    // through the current key, and this is the only function that understands
    // top-level `jobs`/`certifications`.
    const d = migrateLegacy({
      _schemaVersion: 2,
      jobs: [{ id: "j1", company: "Acme" }],
      journal: { habits: [{ id: "h1", completions: ["2026-01-01"] }] },
      projects: [{ name: "Bare" }],
    });
    expect(d.schemaVersion).toBe(NEW_SCHEMA_VERSION);
    expect(d.career.jobs).toHaveLength(1);
    expect(d.journal.habitCompletions).toHaveLength(1);
    // A project with no id gets one, because `flatten` drops a record without
    // one and would do it without saying anything.
    expect(d.projects[0]?.id).toBeTruthy();
  });
});
