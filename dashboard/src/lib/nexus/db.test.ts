/**
 * The cache, treated as a cache.
 *
 * Every test here is about one sentence: **the server is the record and
 * localStorage is not.** iOS discards a PWA's storage after ~7 days unopened,
 * so "nothing is stored" is a routine state on a device whose data is intact
 * on the server — and the two mistakes available at this seam are to *hide*
 * that state from the caller, and to *end* it by writing over it.
 */
import { describe, expect, it } from "vitest";
import { LS_KEY, loadData, saveData, type Store } from "./db";
import { NEW_SCHEMA_VERSION } from "./types";

/** A storage double. The map is the assertion surface. */
function fake(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  const store: Store = {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
  return { store, map };
}

const schema3 = {
  schemaVersion: 3,
  career: { jobs: [{ id: "j1", company: "Acme" }], certifications: [] },
  journal: { habits: [{ id: "h1", completions: ["2026-01-01"] }] },
  projects: [{ id: "p1", name: "Alpha", tasks: [{ id: "t1", name: "x" }] }],
};

describe("a cache miss", () => {
  it("is reported rather than papered over", () => {
    // A loader that just returns `makeDefaultData()` leaves its caller unable
    // to tell a first run from an eviction — and those two need opposite
    // handling. One seeds the server; the other must not write a single record
    // until it has pulled. `hit` is the only thing that distinguishes them.
    const { store } = fake();
    return expect(loadData(store)).resolves.toMatchObject({ hit: false });
  });

  it("does not persist the defaults it hands back", async () => {
    // The destructive line, deleted. nexus wrote the freshly minted defaults
    // to storage here, which on this platform turns the *next* boot into a
    // cache hit — so the device forgets it was recovering and offers ~90
    // pristine seed records as ordinary local edits, on top of whatever the
    // user has since made of them elsewhere.
    const { store, map } = fake();
    await loadData(store);
    expect(map.size).toBe(0);
  });

  it("still hands back something renderable", async () => {
    // The screens read `NexusData` with non-null assertions; a null here is a
    // blank app, not a degraded one.
    const { data } = await loadData(fake().store);
    expect(data.schemaVersion).toBe(NEW_SCHEMA_VERSION);
    expect(data.roadmap.phases.length).toBeGreaterThan(0);
  });

  it("survives storage being unavailable at all", async () => {
    // Safari with cookies blocked, or a locked-down iframe. A throw on boot is
    // the whole app; running uncached is one slow load.
    await expect(loadData(null)).resolves.toMatchObject({ hit: false });
  });
});

describe("a cache that will not parse", () => {
  it("reports corrupt, and is a miss rather than an empty dataset", async () => {
    const { store } = fake({ [LS_KEY]: "{not json" });
    await expect(loadData(store)).resolves.toMatchObject({ hit: false, corrupt: true });
  });

  it("does not overwrite what it failed to read", async () => {
    // The only copy of whatever that value held. A later build might
    // understand it; a `saveData` here means nothing ever will.
    const { store, map } = fake({ [LS_KEY]: "{not json" });
    await loadData(store);
    expect(map.get(LS_KEY)).toBe("{not json");
  });

  it("treats a non-object payload as corrupt too", async () => {
    // `JSON.parse("[]")` and `JSON.parse("4")` both succeed and are both
    // unusable. Passing an array to `normalize` yields a blob of `undefined`s.
    for (const raw of ["[]", "4", '"hello"', "null"]) {
      const { store } = fake({ [LS_KEY]: raw });
      await expect(loadData(store)).resolves.toMatchObject({ hit: false });
    }
  });
});

describe("schema routing", () => {
  it("sends a schema 3 store to normalize, keeping career", async () => {
    // The bug this rewrite fixes. nexus routed on
    // `version >= NEW_SCHEMA_VERSION ? normalize : migrateLegacy`, which sends
    // schema 3 — the immediately previous release — to the function written
    // for the *legacy* app, where jobs lived at `old.jobs` and there was no
    // `career` block at all. Every job application and certification was
    // silently dropped on load, and the next sync cycle pushed that as
    // tombstones.
    const { store } = fake({ [LS_KEY]: JSON.stringify(schema3) });
    const { data, hit } = await loadData(store);
    expect(hit).toBe(true);
    expect(data.career.jobs.map((j) => j.company)).toEqual(["Acme"]);
  });

  it("performs the 3 → 4 record migrations on the way", async () => {
    const { store } = fake({ [LS_KEY]: JSON.stringify(schema3) });
    const { data } = await loadData(store);
    expect(data.journal.habitCompletions).toHaveLength(1);
    expect(data.projects[0]?.tasks[0]?.sort).toBeGreaterThan(0);
  });

  it("persists a store whose version moved, and only then", async () => {
    // A migration is worth keeping; a no-op rewrite is noise that also makes
    // every load look like a write to anything watching storage.
    const three = fake({ [LS_KEY]: JSON.stringify(schema3) });
    await loadData(three.store);
    expect(JSON.parse(three.map.get(LS_KEY)!).schemaVersion).toBe(NEW_SCHEMA_VERSION);

    const raw = JSON.stringify({ ...schema3, schemaVersion: NEW_SCHEMA_VERSION });
    const four = fake({ [LS_KEY]: raw });
    await loadData(four.store);
    expect(four.map.get(LS_KEY)).toBe(raw);
  });

  it("sends a legacy store to migrateLegacy", async () => {
    // `_schemaVersion` — the underscore is the whole reason the old comparison
    // appeared to work: a legacy store reads as version 0 through the current
    // key, so 0 and 4 were the only two cases anyone had tried.
    const { store } = fake({
      [LS_KEY]: JSON.stringify({ _schemaVersion: 2, jobs: [{ id: "j1", company: "Legacy" }] }),
    });
    const { data, hit } = await loadData(store);
    expect(hit).toBe(true);
    expect(data.career.jobs.map((j) => j.company)).toEqual(["Legacy"]);
  });

  it("clamps a version from the future rather than refusing it", async () => {
    // An older build reading a newer store. `normalize` keeps unknown fields
    // out of harm's way in `__rest__`, so the honest move is to load it.
    const { store } = fake({ [LS_KEY]: JSON.stringify({ schemaVersion: 99 }) });
    const { data } = await loadData(store);
    expect(data.schemaVersion).toBe(NEW_SCHEMA_VERSION);
  });
});

describe("saveData", () => {
  it("stamps the current schema version", () => {
    const { store, map } = fake();
    expect(saveData({ schemaVersion: 1 } as never, store)).toBe(true);
    expect(JSON.parse(map.get(LS_KEY)!).schemaVersion).toBe(NEW_SCHEMA_VERSION);
  });

  it("reports a failure instead of throwing it", () => {
    // A full quota must not fail a sync cycle. The blob is already in memory
    // and already on the server; the cost of not caching it is a slower next
    // boot, and the cost of throwing is a cursor that never advances and a
    // device that re-pulls the same page forever.
    const store: Store = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("QuotaExceededError");
      },
    };
    expect(saveData({ schemaVersion: 4 } as never, store)).toBe(false);
  });
});
