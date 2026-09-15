/**
 * Stage 4's wiring, which is four functions and two ways to lose a dataset.
 *
 * `engine.test.ts` proved the engine's sequencing against a synthetic two-kind
 * registry, because the domains did not exist yet. These run the real model
 * through the real `NEXUS_REGISTRY`, and none of them are about the engine.
 * They are about what `read()` is allowed to answer, and the answer turns
 * entirely on a fact the engine cannot see: **whether this device holds a
 * record of its own.**
 *
 * iOS discards a PWA's storage after ~7 days unopened, so it does not. Not
 * rarely — routinely, on the phone, which is the device most likely to go a
 * week unopened. And the state it leaves behind is indistinguishable, from
 * inside the app, from a user who deleted everything.
 *
 * Both endings are silent, and they are opposites:
 *
 * - answer with an **empty** blob and the diff is every record this device
 *   ever pushed, *as a deletion*. Well-formed, correctly clocked,
 *   authoritative tombstones. The other four devices delete the dataset on
 *   their next pull and nothing reports an error.
 * - answer with `makeDefaultData()` — which is what the screens are already
 *   rendering — and the diff is ~90 creations of pristine seed content. The
 *   seed's ids are content-derived, so they converge onto the real rows
 *   instead of duplicating them, which is *worse* than duplication: each one
 *   is a later write to a row the user has since edited, so every ticked
 *   roadmap task reverts to its factory text.
 *
 * So the tests below are mostly assertions about a request body that should be
 * nearly empty, which reads as thin and is the entire point.
 */
import { describe, expect, it, vi } from "vitest";
import { formatHlc } from "@/lib/sync/clock";
import { SYNC_KEYS, type FetchLike, type PulledRecord, type SyncReply } from "@/lib/sync/engine";
import { type Change } from "@/lib/sync/flatten";
import { NEXUS_REGISTRY, REST, flatten } from "@/lib/sync/registry";
import { createNexusSync, resetOwnership, type DataSeam } from "./bridge";
import { makeDefaultData } from "./migrate";
import { NEW_SCHEMA_VERSION, type NexusData } from "./types";

const T0 = 1_789_344_000_000;
const DEVICE = "dev-a";

/* ── the fake hub ────────────────────────────────────────────────────────── */

interface Sent {
  since: number;
  changes: Change[];
}

type Step = Partial<SyncReply>;

/**
 * The server's copy of a dataset, as `/api/sync` would hand it over.
 *
 * Built by flattening a real blob rather than hand-written, because a
 * hand-written fixture is exactly how the nested key format once passed 22
 * tests while losing all 90 records of a real default blob.
 */
function serverRecords(blob: NexusData, from = 1): PulledRecord[] {
  const snapshot = flatten(blob as unknown as Record<string, unknown>, NEXUS_REGISTRY);
  let seq = from;
  return Object.entries(snapshot).flatMap(([collection, recs]) =>
    Object.entries(recs).map(([id, body]) => ({
      collection,
      id,
      seq: seq++,
      hlc: formatHlc(T0 + seq, 0, "other"),
      deleted: false,
      body,
      device_id: "other",
    })),
  );
}

interface RigOpts {
  /** The load verdict. The whole test suite turns on this boolean. */
  cacheHit: boolean;
  /** What the store is holding — defaults, as a recovering device renders. */
  data?: NexusData | null;
  /** Sync state left behind from before an eviction. */
  storage?: Record<string, string>;
  script?: Step[];
  intervalMs?: number;
}

function rig(o: RigOpts) {
  const map = new Map(Object.entries(o.storage ?? {}));
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };

  let data: NexusData | null = o.data === undefined ? makeDefaultData() : o.data;
  const adopted: NexusData[] = [];
  const store: DataSeam = {
    getState: () => ({
      data,
      adopt: (blob) => {
        data = blob;
        adopted.push(blob);
      },
    }),
  };

  // The channel `adopt` must not be able to fire. A test can fire it by hand,
  // which is how the positive control below proves the negative one.
  const edits = new Set<() => void>();

  const sent: Sent[] = [];
  const fetchLike: FetchLike = async (url, init) => {
    const u = new URL(url, "http://box");
    sent.push({
      since: Number(u.searchParams.get("since")),
      changes: (JSON.parse(init.body) as { changes: Change[] }).changes,
    });
    const reply = o.script?.[sent.length - 1] ?? {};
    return {
      ok: true,
      status: 200,
      json: async () =>
        ({
          accepted: reply.accepted ?? (reply.records ? [] : []),
          rejected: [],
          quarantined: [],
          records: reply.records ?? [],
          cursor: reply.cursor ?? 0,
          more: reply.more ?? false,
          head: reply.head ?? 0,
        }) as unknown,
    };
  };

  const orphanReports: string[][] = [];
  const sync = createNexusSync({
    cacheHit: o.cacheHit,
    store,
    onLocalEdit: (fn) => {
      edits.add(fn);
      return () => void edits.delete(fn);
    },
    storage,
    fetch: fetchLike,
    now: () => T0,
    ...(o.intervalMs !== undefined ? { intervalMs: o.intervalMs } : {}),
    onOrphans: (os) => orphanReports.push(os.map((x) => `${x.collection}/${x.id}`)),
  });

  return {
    sync,
    sent,
    map,
    adopted,
    orphanReports,
    data: () => data,
    /** What a request offered, ignoring the always-present `__rest__`. */
    offered: (i: number) => (sent[i]?.changes ?? []).filter((c) => c.collection !== REST),
    edit: () => {
      for (const fn of [...edits]) fn();
    },
  };
}

/** Let already-resolved promises settle; fake timers do not do it for us. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** The sync state an established device leaves behind — all of it. */
const established = (blob: NexusData) => ({
  [SYNC_KEYS.device]: DEVICE,
  [SYNC_KEYS.clock]: JSON.stringify({ node: DEVICE, millis: T0 - 1000, counter: 7 }),
  [SYNC_KEYS.cursor]: "500",
  [SYNC_KEYS.baseline]: JSON.stringify(
    flatten(blob as unknown as Record<string, unknown>, NEXUS_REGISTRY),
  ),
  [SYNC_KEYS.joined]: "1",
});

// ══ the eviction ═════════════════════════════════════════════════════════

describe("a device whose storage was evicted", () => {
  it("pushes no tombstones", async () => {
    // THE test. An evicted device still holds a baseline describing the whole
    // dataset, and a `read()` that answers "empty" turns that baseline into a
    // deletion per record. The server accepts them — they are valid writes —
    // and four other devices delete everything on their next pull.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: false,
      storage: established(blob),
      script: [{ records: serverRecords(blob), cursor: 90, head: 90 }],
    });

    await r.sync.sync();

    const tombstones = (r.sent[0]?.changes ?? []).filter((c) => c.deleted);
    expect(tombstones).toEqual([]);
  });

  it("offers nothing but its schema version", async () => {
    // The other half of the same request, stated positively. `flatten` always
    // mints a `__rest__` record — that totality is what stops an old build
    // deleting a field a new one added — so *something* is always offered.
    // Exactly one record, carrying the one fact a recovering device actually
    // knows, and no user data of any kind.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: false,
      storage: established(blob),
      script: [{ records: serverRecords(blob), cursor: 90, head: 90 }],
    });

    await r.sync.sync();

    expect(r.sent[0]?.changes).toHaveLength(1);
    expect(r.sent[0]?.changes[0]).toMatchObject({ collection: REST, id: REST });
    expect(r.sent[0]?.changes[0]?.body).toEqual({ schemaVersion: NEW_SCHEMA_VERSION });
  });

  it("does not offer the seed content it is rendering", async () => {
    // The opposite mistake, and the tempting one: the store *is* holding
    // `makeDefaultData()`, because the screens need something to render. Diffed
    // against a cleared baseline that is ~90 creations of factory text, each a
    // later write to a row the user has since edited — so a phone that sat
    // unopened for a week silently reverts the roadmap on every other device.
    const r = rig({
      cacheHit: false,
      storage: { [SYNC_KEYS.device]: DEVICE },
      script: [{ records: serverRecords(makeDefaultData()), cursor: 90, head: 90 }],
    });

    await r.sync.sync();

    expect(r.offered(0)).toEqual([]);
  });

  it("asks from zero, so the server resends what it holds", async () => {
    // The quieter half of the eviction, and fatal on its own. A surviving
    // cursor of 500 tells the server "I have seen rows 1–500, do not resend
    // them" — so the recovering device pulls nothing, stays empty forever, and
    // reports a perfectly clean sync while doing it.
    const r = rig({
      cacheHit: false,
      storage: established(makeDefaultData()),
      script: [{ records: [], cursor: 0, head: 90 }],
    });

    await r.sync.sync();

    expect(r.sent[0]?.since).toBe(0);
  });

  it("keeps the clock and the device id it discarded everything else for", async () => {
    // Two keys that must survive, for two different reasons. A re-minted clock
    // publishes readings below ones this node has already published, so a
    // write made after recovery loses to one made before it. A new device id
    // makes this look like a new device to the server — and the tombstone-GC
    // watermark is `min(last_pull_seq)` across live devices, so each phantom
    // pins it at zero and the tombstone table grows without bound.
    const r = rig({ cacheHit: false, storage: established(makeDefaultData()) });

    expect(r.map.get(SYNC_KEYS.device)).toBe(DEVICE);
    expect(JSON.parse(r.map.get(SYNC_KEYS.clock)!)).toMatchObject({ counter: 7 });
    expect(r.sync.device).toBe(DEVICE);
    // And the three that must not.
    expect(r.map.has(SYNC_KEYS.cursor)).toBe(false);
    expect(r.map.has(SYNC_KEYS.baseline)).toBe(false);
    expect(r.map.has(SYNC_KEYS.joined)).toBe(false);
  });

  it("recovers the server's data into the store", async () => {
    // Recovery, rather than merely "does no harm". The blob the engine hands
    // back is adopted verbatim and replaces the defaults the screens were
    // rendering.
    const real = makeDefaultData();
    real.dashboard.todos = [
      { id: "td1", text: "from the server", done: false, dueDate: null, order: 0, createdAt: "" },
    ];
    const r = rig({
      cacheHit: false,
      storage: established(makeDefaultData()),
      script: [{ records: serverRecords(real), cursor: 90, head: 90 }],
    });

    await r.sync.sync();

    expect(r.data()?.dashboard.todos.map((t) => t.text)).toEqual(["from the server"]);
    expect(r.sync.status().recovering).toBe(false);
  });

  it("stops withholding once the server has answered", async () => {
    // The gate has to open, or the device is read-only forever. After the
    // pull, a local edit is offered like any other.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: false,
      storage: established(blob),
      script: [
        { records: serverRecords(blob), cursor: 90, head: 90 },
        { cursor: 90, head: 90 },
      ],
    });

    await r.sync.sync();
    const current = r.data()!;
    current.dashboard.todos = [
      { id: "td9", text: "mine", done: false, dueDate: null, order: 0, createdAt: "" },
    ];
    await r.sync.sync();

    expect(r.offered(1)).toMatchObject([{ collection: "dashboard.todos", id: "td9" }]);
  });
});

// ══ the first device, and the fifth ══════════════════════════════════════

describe("bootstrapping", () => {
  it("seeds an empty server from the defaults it is holding", async () => {
    // `mayBootstrap(head, pulled)` — head 0 and nothing pulled means nobody
    // has ever written, so this device is the first and its defaults are the
    // seed. The gate opens and the *next* cycle offers them.
    vi.useFakeTimers();
    try {
      const r = rig({
        cacheHit: false,
        storage: {},
        script: [
          { records: [], cursor: 0, head: 0 },
          { cursor: 0, head: 0 },
        ],
        intervalMs: 30_000,
      });

      r.sync.start();
      await advance(0);
      expect(r.offered(0)).toEqual([]);

      // The nudge from `onBootstrap` is deliberately deferred by a macrotask:
      // it fires inside the cycle, and `sync()` hands a second caller the
      // in-flight promise rather than starting a cycle, so an immediate nudge
      // would be absorbed by the very cycle that triggered it. Two nested
      // zero-delay timers have to drain — ours, then the engine's own `arm(0)`
      // — and still nothing like the 30s interval, so a pass here cannot be
      // the scheduled cycle arriving early.
      await advance(10);
      expect(r.offered(1).length).toBeGreaterThan(50);
      expect(r.offered(1).some((c) => c.collection === "roadmap.phases")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts rather than seeds when the server has anything at all", async () => {
    // The same test that stops a second device duplicating the roadmap, which
    // is why it covers eviction too: "has the server anything", not "has it my
    // collections". A device that seeded *and* pulled would write every seeded
    // record twice, under two clocks.
    vi.useFakeTimers();
    try {
      const blob = makeDefaultData();
      const r = rig({
        cacheHit: false,
        storage: {},
        script: [
          { records: serverRecords(blob), cursor: 90, head: 90 },
          { cursor: 90, head: 90 },
        ],
        intervalMs: 30_000,
      });

      r.sync.start();
      await advance(0);
      await advance(10);

      // Whatever the second cycle offered, it was not a second copy of the
      // seed: the store now holds the server's blob, which already has it.
      expect(r.offered(1)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ the loop ═════════════════════════════════════════════════════════════

describe("write must not cause a sync", () => {
  it("does not start another cycle after adopting a pull", async () => {
    // pull → write → save → "something changed, sync!" → pull → … Every lap
    // burns a server `seq`, re-delivers the record to all five devices, and
    // each of those does the same. It never terminates and it never errors.
    //
    // Driven through `start()` rather than `sync()` on purpose: `nudge()` is a
    // no-op while the engine is stopped, so a test that only called `sync()`
    // would pass with the loop fully wired.
    vi.useFakeTimers();
    try {
      const blob = makeDefaultData();
      const r = rig({
        cacheHit: true,
        data: blob,
        storage: established(blob),
        script: [{ records: serverRecords(blob, 501), cursor: 590, head: 590 }],
        intervalMs: 30_000,
      });

      r.sync.start();
      await advance(0);
      expect(r.sent).toHaveLength(1);
      expect(r.adopted).toHaveLength(1);

      // Well short of the interval: anything here is a nudge, and a nudge here
      // is the loop.
      await advance(5_000);
      expect(r.sent).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does start another cycle for a real local edit", async () => {
    // The positive control, and it is what makes the test above meaningful
    // rather than vacuous: without it, a bridge that simply never nudged would
    // pass. Same rig, same timing, one difference.
    vi.useFakeTimers();
    try {
      const blob = makeDefaultData();
      const r = rig({
        cacheHit: true,
        data: blob,
        storage: established(blob),
        intervalMs: 30_000,
      });

      r.sync.start();
      await advance(0);
      expect(r.sent).toHaveLength(1);

      r.edit();
      await advance(10);
      expect(r.sent).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("adopts the engine's blob verbatim", async () => {
    // The engine advances its baseline to exactly the blob it handed over, so
    // a spurious cycle diffs to empty. Re-shaping it here — a `normalize()` on
    // the way in, say — makes the store permanently disagree with the baseline
    // by whatever the re-shaping touched, and every cycle forever finds that
    // difference and pushes it. A quiet, endless version of the same loop.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: true,
      data: blob,
      storage: established(blob),
      script: [
        { records: serverRecords(blob, 501), cursor: 590, head: 590 },
        { cursor: 590, head: 590 },
      ],
    });

    await r.sync.sync();
    expect(r.data()).toBe(r.adopted[0]);

    await r.sync.sync();
    expect(r.sent[1]?.changes).toEqual([]);
  });

  it("does not answer a pull with a push", async () => {
    // What "verbatim" is actually protecting, and the assertion the test above
    // cannot make. `normalize()` is right for the blob that *ends* recovery —
    // that one is built only from records the server sent, so whole domains can
    // be missing from it — and wrong for every blob after it.
    //
    // The reason is that normalise fills in what the server does not have, and
    // a filled-in *singleton* is a record. So a store the server's rows do not
    // fully specify would answer every pull with a push of the difference,
    // until the server has been taught each one. Bounded, but it is traffic
    // nobody asked for on all five devices — and where two builds disagree
    // about what normalise produces (the `schemaVersion` clamp is exactly such
    // a field) the two of them push at each other indefinitely.
    //
    // Constructed with `settings` missing because it is a singleton: an absent
    // *collection* normalises to an empty array, which flattens to no records
    // at all and would make this mutation invisible.
    const blob = makeDefaultData() as unknown as Record<string, unknown>;
    delete blob["settings"];
    const under = blob as unknown as NexusData;
    const r = rig({
      cacheHit: true,
      data: under,
      storage: established(under),
      script: [
        { records: serverRecords(under, 501), cursor: 590, head: 590 },
        { cursor: 590, head: 590 },
      ],
    });

    await r.sync.sync();
    expect(r.adopted).toHaveLength(1);
    await r.sync.sync();

    expect(r.offered(1)).toEqual([]);
  });
});

// ══ the rules the engine owns, and this wiring must not defeat ═══════════

describe("the engine's own rules survive the wiring", () => {
  it("diffs against its own baseline, not the server's snapshot", async () => {
    // A record deleted locally must read as a deletion, not as "the server has
    // something I do not". Comparing local to remote cannot tell those apart —
    // both look like "they have a row I lack" — so a client that diffs against
    // the server re-pulls every record it has ever deleted, and every deletion
    // resurrects on the next sync, with the user deleting it each time.
    const blob = makeDefaultData();
    blob.dashboard.todos = [
      { id: "td1", text: "gone soon", done: false, dueDate: null, order: 0, createdAt: "" },
    ];
    const r = rig({
      cacheHit: true,
      data: blob,
      storage: established(blob),
      script: [{ cursor: 500, head: 500 }],
    });

    blob.dashboard.todos = [];
    await r.sync.sync();

    expect(r.offered(0)).toMatchObject([
      { collection: "dashboard.todos", id: "td1", deleted: true },
    ]);
  });

  it("still sees a deletion made after a pull", async () => {
    // The same rule at the seam where this wiring can actually break it, which
    // the test above cannot reach: with no pull in it, there is no server view
    // to accidentally cache.
    //
    // `read()` must answer with the *live store*, every time. Hold on to the
    // last blob the engine handed over and answer with that instead — a
    // plausible optimisation, since it is the most recent complete picture —
    // and a record deleted afterwards looks like a record we never had. The
    // deletion is never offered, the next pull brings the row back, and the
    // user deletes it again.
    const blob = makeDefaultData();
    blob.dashboard.todos = [
      { id: "td1", text: "gone after the pull", done: false, dueDate: null, order: 0, createdAt: "" },
    ];
    const r = rig({
      cacheHit: true,
      data: blob,
      storage: established(blob),
      script: [
        { records: serverRecords(blob, 501), cursor: 590, head: 590 },
        { cursor: 590, head: 590 },
      ],
    });

    await r.sync.sync();
    r.data()!.dashboard.todos = [];
    await r.sync.sync();

    expect(r.offered(1)).toMatchObject([
      { collection: "dashboard.todos", id: "td1", deleted: true },
    ]);
  });

  it("reports orphans rather than dropping them silently", async () => {
    // The known cost of per-record nesting: a task whose project was deleted
    // on another device has nowhere to land. Dropping it is the lesser loss —
    // inventing a placeholder parent would resurrect the deleted project — but
    // a silent drop is indistinguishable from the record never existing, which
    // is the class of bug this whole layer exists to avoid.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: true,
      data: blob,
      storage: established(blob),
      script: [
        {
          records: [
            {
              collection: "projects.tasks",
              id: "ghost:t1",
              seq: 501,
              hlc: formatHlc(T0 + 1, 0, "other"),
              deleted: false,
              body: { id: "t1", name: "orphan" },
              device_id: "other",
            },
          ],
          cursor: 501,
          head: 501,
        },
      ],
    });

    await r.sync.sync();

    expect(r.sync.status().orphans).toEqual([{ collection: "projects.tasks", id: "ghost:t1" }]);
    expect(r.orphanReports).toEqual([["projects.tasks/ghost:t1"]]);
  });

  it("leaves the cursor to the engine", async () => {
    // Rule 3: the cursor advances only on an acknowledged pull, and nothing
    // outside the engine writes it. A bridge that persisted its own would
    // advance it past records the app never received.
    const blob = makeDefaultData();
    const r = rig({
      cacheHit: true,
      data: blob,
      storage: established(blob),
      script: [{ records: serverRecords(blob, 501), cursor: 590, head: 590 }],
    });

    await r.sync.sync();

    expect(r.map.get(SYNC_KEYS.cursor)).toBe("590");
  });
});

describe("resetOwnership", () => {
  it("drops exactly the three keys that describe local contents", () => {
    // Named separately from the eviction tests because the *selection* is the
    // decision, and it is easy to widen by accident while tidying up.
    const map = new Map(Object.entries(established(makeDefaultData())));
    resetOwnership({
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => void map.set(k, v),
      removeItem: (k) => void map.delete(k),
    });
    expect([...map.keys()].sort()).toEqual([SYNC_KEYS.clock, SYNC_KEYS.device].sort());
  });
});
