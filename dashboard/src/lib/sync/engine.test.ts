/**
 * Stage 3c's correctness argument: the orchestration, which is the half that
 * cannot be proved by a pure function.
 *
 * `sync.test.ts` and `registry.test.ts` cover the pieces — a diff, an apply, a
 * round trip of shapes. None of them can be wrong about *order*, because none
 * of them have any. Every bug left in this layer is a sequencing bug, and each
 * one is silent by construction:
 *
 * - a cursor that advanced before the records landed loses a page forever, and
 *   the device that lost it reports a clean sync;
 * - a baseline that did not advance with the live state makes two devices that
 *   already agree exchange records until one of them is closed;
 * - a quarantined record offered again fails every batch it rides in, so the
 *   device stops syncing *everything* while its status still reads "idle";
 * - a frame treated as data moves state the cursor has not acknowledged.
 *
 * So the engine is driven here through a fake hub rather than a stub: every
 * test scripts the actual replies a real `/api/sync` produces, including the
 * two nobody writes by hand — the response that never arrives, and the 401 a
 * hub with no accounts enrolled answers with on a good day.
 */
import { describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "../auth";
import { formatHlc } from "./clock";
import { type Change, type Snapshot } from "./flatten";
import { REST, flatten, joinKey, type Registry } from "./registry";
import {
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  STREAM_URL,
  SYNC_KEYS,
  SyncEngine,
  type EngineDeps,
  type EventSourceLike,
  type FetchLike,
  type PulledRecord,
  type SyncReply,
} from "./engine";

const T0 = 1_789_344_000_000;

/**
 * A two-kind registry, so the blob stays readable and orphans are reachable.
 *
 * Synthetic rather than `NEXUS_REGISTRY` for the same reason 3b's tests are:
 * the domains have not been ported yet, and an engine that knows what a
 * `Project` is gets rewritten whenever a `Project` changes.
 */
const REG: Registry = [
  { name: "j", path: "j", kind: "records" },
  { name: "j.kids", path: "j[].kids", kind: "nested" },
];

/** A blob's records, as the app holds them. `kids` is the nested collection. */
type Row = { id: string; v: number; kids?: unknown[] };
const rows = (...r: Row[]): Record<string, unknown> => ({
  j: r.map((x) => ({ kids: [], ...x })),
});

const ids = (b: Record<string, unknown>): string[] =>
  ((b["j"] as Row[] | undefined) ?? []).map((x) => x.id);

const valueOf = (b: Record<string, unknown>, id: string): number | undefined =>
  ((b["j"] as Row[] | undefined) ?? []).find((x) => x.id === id)?.v;

/**
 * One stored record as the server returns it.
 *
 * The body carries its own `id` because it IS the app's object — `flatten`
 * drops a record without one, so a body missing it would look deleted on the
 * very next read.
 */
const rec = (seq: number, id: string, v: number): PulledRecord => ({
  collection: "j",
  id,
  seq,
  hlc: formatHlc(T0 + seq, 0, "other"),
  deleted: false,
  body: { id, v },
  device_id: "other",
});

const tomb = (seq: number, id: string): PulledRecord => ({
  ...rec(seq, id, 0),
  deleted: true,
  body: null,
});

/**
 * The records a request offered, minus `__rest__`.
 *
 * `flatten` always mints a `__rest__` record holding everything the registry
 * does not describe — that totality is what stops an old client silently
 * deleting a field a new one added — so it is a genuine change on a device's
 * first push, and noise in every assertion about which of the app's records
 * moved. Tests that care about an empty batch seed a baseline instead.
 */
const offered = (req: Sent | undefined): Change[] =>
  (req?.changes ?? []).filter((c) => c.collection !== REST);

/* ── the fake hub ────────────────────────────────────────────────────────── */

interface Sent {
  since: number;
  limit: number;
  device: string;
  name: string | null;
  headers: Record<string, string>;
  changes: Change[];
}

type Step = Partial<SyncReply> & {
  /** Thrown rather than answered: a response lost in transit. */
  lost?: true;
  status?: number;
  errorBody?: unknown;
  /** Runs while the request is in flight — "the user edited mid-round-trip". */
  during?: () => void;
};

interface RigOpts {
  blob?: Record<string, unknown>;
  /** Seed "we already pushed this", so a batch assertion is about what moved. */
  pushed?: Record<string, unknown>;
  cursor?: number;
  script?: Step[];
  onBootstrap?: () => void;
  intervalMs?: number;
}

function rig(o: RigOpts = {}) {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };
  if (o.pushed) store.set(SYNC_KEYS.baseline, JSON.stringify(flatten(o.pushed, REG)));
  if (o.cursor !== undefined) store.set(SYNC_KEYS.cursor, String(o.cursor));

  let blob = structuredClone(o.blob ?? {}) as Record<string, unknown>;
  let breakWrites = 0;
  let wall = T0;

  const script: Step[] = o.script ?? [];
  const sent: Sent[] = [];
  const streamUrls: string[] = [];
  const handlers = new Map<string, (ev: Event) => void>();
  let live: EventSourceLike | null = null;
  let closes = 0;

  const fetchLike: FetchLike = async (url, init) => {
    const u = new URL(url, "http://box");
    sent.push({
      since: Number(u.searchParams.get("since")),
      limit: Number(u.searchParams.get("limit")),
      device: u.searchParams.get("device") ?? "",
      name: u.searchParams.get("name"),
      headers: init.headers,
      changes: (JSON.parse(init.body) as { changes: Change[] }).changes,
    });
    // Past the end of the script the hub answers an empty, no-op 200, so a
    // stray extra cycle shows up in `sent` rather than as a crash.
    const { lost, status, errorBody, during, ...reply } = script[sent.length - 1] ?? {};
    during?.();
    if (lost) throw new TypeError("Failed to fetch");
    if (status !== undefined) {
      return { ok: false, status, json: async () => errorBody ?? {} };
    }
    return { ok: true, status: 200, json: async () => reply as unknown };
  };

  const deps: EngineDeps = {
    read: () => blob,
    write: (b) => {
      if (breakWrites > 0) {
        breakWrites -= 1;
        throw new Error("the app refused the blob");
      }
      blob = b;
    },
    fetch: fetchLike,
    storage,
    now: () => wall,
    registry: REG,
    intervalMs: o.intervalMs ?? 30_000,
    onBootstrap: o.onBootstrap,
    eventSource: (url) => {
      streamUrls.push(url);
      handlers.clear();
      const es: EventSourceLike = {
        addEventListener: (type, fn) => void handlers.set(type, fn),
        onerror: null,
        close: () => void (closes += 1),
      };
      live = es;
      return es;
    },
  };

  return {
    engine: new SyncEngine(deps),
    /** A second engine over the same storage and blob: a reload. */
    reload: () => new SyncEngine(deps),
    deps,
    script,
    sent,
    store,
    streamUrls,
    blob: () => blob,
    edit: (fn: (b: Record<string, unknown>) => void) => fn(blob),
    breakWrite: (n = 1) => void (breakWrites = n),
    tick: (ms: number) => void (wall += ms),
    /** One `event: sync` frame. The cast mirrors api.ts's own. */
    frame: (head: number) =>
      handlers.get("sync")?.({ data: JSON.stringify({ head }) } as unknown as Event),
    drop: () => live?.onerror?.({} as Event),
    closes: () => closes,
  };
}

/** Let already-resolved promises settle. Fake timers do not do this for us. */
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

// ══ rule 1 & 4: the diff base, and moving it ═════════════════════════════

describe("the baseline", () => {
  it("does not resurrect a record deleted locally", async () => {
    // The failure end to end. A client that diffed against the SERVER would
    // see "the server has `a`, I do not", pull it back, and do so again every
    // sync forever with the user deleting it each time. Diffing against our
    // own previous state says "I had `a`, I removed it" — a push, not a pull.
    const start = rows({ id: "a", v: 1 }, { id: "z", v: 0 });
    const r = rig({
      blob: start,
      pushed: start,
      script: [
        // Push-then-pull in one round trip means our own tombstone comes back.
        { accepted: ["j/a"], records: [tomb(1, "a")], cursor: 1, more: false, head: 1 },
      ],
    });

    r.edit((b) => void ((b["j"] as Row[]).splice(0, 1)));
    await r.engine.sync();
    expect(offered(r.sent[0])).toMatchObject([{ collection: "j", id: "a", deleted: true }]);
    expect(ids(r.blob())).toEqual(["z"]);

    await r.engine.sync();
    expect(r.sent[1]!.changes).toEqual([]);
    expect(ids(r.blob())).toEqual(["z"]);
  });

  it("does not re-push what the pull just delivered", async () => {
    // Rule 4. Advancing the live state without the baseline makes the next
    // diff read every pulled record as a local creation and push it back — an
    // infinite exchange between two devices that already agree, which looks
    // like a healthy sync on both.
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 }],
    });

    await r.engine.sync();
    expect(ids(r.blob())).toEqual(["b"]);

    await r.engine.sync();
    expect(r.sent[1]!.changes).toEqual([]);
  });

  it("clears the dirty flag on `accepted`, not on seeing the record come back", async () => {
    // The server echoes our own writes in the same round trip, which masks
    // this until it does not: a `limit` that clips the echo onto a later page,
    // or a cycle that fails between pages. `accepted` is the acknowledgement;
    // the echo is a coincidence.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [{ accepted: ["j/a"], records: [], cursor: 0, more: false, head: 1 }],
    });

    await r.engine.sync();
    expect(r.sent[0]!.changes).toHaveLength(1);

    await r.engine.sync();
    expect(r.sent[1]!.changes).toEqual([]);
  });

  it("advances to the version it sent, not to live state", async () => {
    // The user edits during the round trip. Snapshotting live state as
    // "pushed" records that edit as already sent, and the next diff never
    // offers it again — the edit is gone, with both devices agreeing.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
    });
    r.script.push({
      during: () => r.edit((b) => void ((b["j"] as Row[])[0]!.v = 2)),
      accepted: ["j/a"],
      cursor: 0,
      more: false,
      head: 1,
    });

    await r.engine.sync();
    expect(valueOf(r.blob(), "a")).toBe(2);

    await r.engine.sync();
    expect(offered(r.sent[1])).toMatchObject([{ id: "a", body: { id: "a", v: 2 } }]);
  });

  it("does not let a pull clobber an edit made during the round trip", async () => {
    // Same race, the other direction. The pull carries another device's
    // version of the record the user is editing; applying it on top and
    // advancing the baseline with it loses the edit and leaves nothing to
    // re-offer. Keeping ours live and taking the server's into the baseline
    // only means the next diff re-offers ours under a higher reading and the
    // HLC decides — the same outcome as an edit made a second later.
    const r = rig({ blob: rows({ id: "a", v: 1 }), pushed: rows({ id: "a", v: 1 }) });
    r.script.push({
      during: () => r.edit((b) => void ((b["j"] as Row[])[0]!.v = 2)),
      records: [rec(1, "a", 9)],
      cursor: 1,
      more: false,
      head: 1,
    });

    await r.engine.sync();
    expect(valueOf(r.blob(), "a")).toBe(2);

    await r.engine.sync();
    expect(offered(r.sent[1])).toMatchObject([{ id: "a", body: { id: "a", v: 2 } }]);
  });
});

// ══ rule 2: seq decides what you need, hlc decides who wins ══════════════

describe("the cursor", () => {
  it("asks from the server's seq and never from a clock reading", async () => {
    // An HLC-derived cursor loses a record written on a slow-clocked device
    // permanently: it lands below another device's position and is never
    // delivered to that device again. See hlc.py.
    const slow: PulledRecord = {
      ...rec(3, "b", 9),
      hlc: formatHlc(T0 + 300_000, 4, "slow"),
    };
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ records: [slow], cursor: 3, more: false, head: 3 }],
    });

    await r.engine.sync();
    expect(r.engine.status().cursor).toBe(3);

    await r.engine.sync();
    expect(r.sent[1]!.since).toBe(3);
  });

  it("never folds a winner's seq into the pull cursor", async () => {
    // A winner is the server's current version of ONE record; the cursor is a
    // position in an ordered log. Folding the first into the second skips
    // every record in between, silently and for good.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [
        {
          rejected: [{ collection: "j", id: "a", winner: rec(7, "a", 9) }],
          records: [rec(3, "b", 1)],
          cursor: 3,
          more: true,
          head: 7,
        },
        { records: [rec(7, "c", 2)], cursor: 7, more: false, head: 7 },
      ],
    });

    await r.engine.sync();
    expect(r.sent[1]!.since).toBe(3);
    expect(ids(r.blob())).toEqual(["a", "b", "c"]);
  });

  it("does not advance when the response is lost", async () => {
    // Rule 3. The client is authoritative for its own cursor: a response that
    // never arrived proves nothing, so the next request has to ask from the
    // same place. Advancing on send would skip a page that was never received
    // and report success while doing it.
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ lost: true }, { records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 }],
    });

    await r.engine.sync();
    expect(r.engine.status().cursor).toBe(0);
    expect(r.store.get(SYNC_KEYS.cursor)).toBeUndefined();
    expect(r.engine.status().phase).toBe("offline");

    await r.engine.sync();
    expect(r.sent[1]!.since).toBe(0);
    expect(ids(r.blob())).toEqual(["b"]);
  });

  it("does not advance before the app has the records", async () => {
    // The ordering, isolated: the cursor is persisted AFTER the merged blob is
    // in the app's hands. Here the app refuses it — which stands in for any
    // failure between receiving a page and applying it. Moving the cursor
    // first marks those records delivered and they are never sent again.
    const page = { records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 };
    const r = rig({ blob: rows(), pushed: rows(), script: [page, page] });

    r.breakWrite(1);
    await r.engine.sync();
    expect(ids(r.blob())).toEqual([]);
    expect(r.store.get(SYNC_KEYS.cursor)).toBeUndefined();

    await r.engine.sync();
    expect(r.sent[1]!.since).toBe(0);
    expect(ids(r.blob())).toEqual(["b"]);
  });

  it("keeps asking while the server says `more`", async () => {
    // `more` is explicit rather than inferred from a full page, which is wrong
    // exactly when the last page happens to be full. Stopping early leaves the
    // device quietly behind until the next cycle, or forever if the tab closes.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [
        { accepted: ["j/a"], records: [rec(1, "b", 1)], cursor: 1, more: true, head: 3 },
        { records: [rec(3, "c", 2)], cursor: 3, more: false, head: 3 },
      ],
    });

    await r.engine.sync();
    expect(r.sent.map((s) => s.since)).toEqual([0, 1]);
    // Only the first page pushes. Re-sending the batch re-offers changes the
    // server acknowledged on the page before, under the same readings — a
    // replay it has to resolve for no reason.
    expect(r.sent[1]!.changes).toEqual([]);
    expect(ids(r.blob())).toEqual(["a", "b", "c"]);
    expect(r.engine.status().cursor).toBe(3);
  });
});

// ══ rule 6: accepted, rejected, quarantined ══════════════════════════════

describe("the three outcomes", () => {
  it("re-offers an unacknowledged change under the same reading", async () => {
    // A lost response is indistinguishable from a rejected one from here, and
    // the server may well have stored it. Re-minting the reading turns a
    // replay into a fresh, higher write: a second `seq`, a re-delivery to
    // every other device, and an archive row claiming an overwrite that never
    // happened. An identical HLC is accepted with no write at all.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [{ lost: true }, { accepted: ["j/a"], cursor: 0, more: false, head: 1 }],
    });

    await r.engine.sync();
    await r.engine.sync();
    expect(r.sent[1]!.changes).toEqual(r.sent[0]!.changes);

    await r.engine.sync();
    expect(r.sent[2]!.changes).toEqual([]);
  });

  it("applies the winner of a rejection", async () => {
    // A client told only "you lost" cannot converge, because it does not know
    // what it lost to. It clears its dirty flag believing it won, diverges
    // permanently, and nothing in the system can notice — it is no longer a
    // conflict, because only one party thinks there is anything to resolve.
    //
    // The winner's `seq` is below our cursor on purpose: a version we already
    // pulled and then wrote over with a losing clock appears in no `records`
    // page, so it arrives here or nowhere.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      cursor: 4,
      script: [
        {
          rejected: [{ collection: "j", id: "a", winner: rec(1, "a", 9) }],
          cursor: 4,
          more: false,
          head: 4,
        },
      ],
    });

    await r.engine.sync();
    expect(valueOf(r.blob(), "a")).toBe(9);

    // And the baseline took the winner too, so we stop arguing.
    await r.engine.sync();
    expect(r.sent[1]!.changes).toEqual([]);
  });

  it("never offers a quarantined record again", async () => {
    // The bug the quarantine list was added to kill. A client keeps a change
    // until it is acknowledged, so one unstorable record failed every
    // subsequent push as well: sync stopped for that device permanently and
    // the only symptom was a 422 no screen displayed. Losing one record
    // visibly beats losing every future record silently.
    const reason = "body is 400001 bytes, over the 400000 limit";
    const r = rig({
      blob: rows({ id: "a", v: 1 }, { id: "b", v: 1 }),
      pushed: rows({ id: "a", v: 0 }, { id: "b", v: 0 }),
      script: [
        {
          accepted: ["j/b"],
          quarantined: [{ collection: "j", id: "a", reason }],
          cursor: 0,
          more: false,
          head: 1,
        },
      ],
    });

    await r.engine.sync();
    expect(offered(r.sent[0]).map((c) => c.id).sort()).toEqual(["a", "b"]);
    expect(r.engine.status().quarantined).toEqual([{ collection: "j", id: "a", reason }]);
    // Surfaced, and not counted as work outstanding — a pending badge that
    // never reaches zero is a pending badge nobody reads.
    expect(r.engine.status().pending).toBe(0);

    // The rest of the device keeps syncing, which is the whole point of
    // answering per record instead of failing the batch.
    r.edit((b) => void ((b["j"] as Row[])[1]!.v = 7));
    await r.engine.sync();
    expect(offered(r.sent[1]).map((c) => c.id)).toEqual(["b"]);
  });

  it("keeps a quarantine across a reload", async () => {
    // In memory only, a reload re-offers the record and the device is back to
    // failing its own pushes — the bug returning by way of the refresh button.
    const reason = "id is 600 characters, over the 512 limit";
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [
        { quarantined: [{ collection: "j", id: "a", reason }], cursor: 0, more: false, head: 0 },
      ],
    });

    await r.engine.sync();
    const next = r.reload();
    expect(next.status().quarantined).toEqual([{ collection: "j", id: "a", reason }]);

    await next.sync();
    expect(offered(r.sent[1])).toEqual([]);
  });

  it("offers a released record again", async () => {
    // Release is manual because this side does not know the server's caps, so
    // "the body changed, it is probably fine now" is blind retry wearing a
    // nicer name. Someone has to look at the reason and decide.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [
        { quarantined: [{ collection: "j", id: "a", reason: "too big" }], cursor: 0, head: 0 },
      ],
    });

    await r.engine.sync();
    r.engine.release("j", "a");
    expect(r.engine.status().quarantined).toEqual([]);

    await r.engine.sync();
    expect(offered(r.sent[1]).map((c) => c.id)).toEqual(["a"]);
  });
});

// ══ rule 5: the stream is an optimisation ════════════════════════════════

describe("the nudge stream", () => {
  it("converges on the timer when a frame is missed", async () => {
    // A dozing radio, a socket Safari suspended in a backgrounded tab, a proxy
    // that buffered the stream. None of them announce themselves, and a client
    // that only syncs on a frame is a client that stops syncing without a
    // single error anywhere.
    vi.useFakeTimers();
    try {
      const r = rig({
        blob: rows(),
        pushed: rows(),
        intervalMs: 1_000,
        script: [{}, { records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 }],
      });

      r.engine.start();
      await advance(0);
      expect(r.sent).toHaveLength(1);

      // The other device writes. No frame ever arrives.
      await advance(1_000);
      expect(r.sent).toHaveLength(2);
      expect(ids(r.blob())).toEqual(["b"]);
      r.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a frame as a nudge and never as data", async () => {
    // The frame carries one number. Applying it — or letting it move the
    // cursor — makes it a second delivery path with its own ordering, racing
    // the pull: the cursor may only advance to a `seq` this device has
    // acknowledged, so an out-of-band record is either re-delivered forever
    // or skipped forever, with nothing in between.
    vi.useFakeTimers();
    try {
      const r = rig({
        blob: rows(),
        pushed: rows(),
        intervalMs: 600_000,
        script: [{}, { records: [rec(4, "b", 9)], cursor: 4, more: false, head: 4 }],
      });

      r.engine.start();
      await advance(0);
      expect(r.sent).toHaveLength(1);
      expect(r.streamUrls).toEqual([STREAM_URL]);

      r.frame(4);
      expect(r.engine.status().cursor).toBe(0);
      expect(ids(r.blob())).toEqual([]);

      // It did exactly one thing: ask, well inside the ten-minute interval.
      await advance(0);
      expect(r.sent).toHaveLength(2);
      expect(r.sent[1]!.since).toBe(0);
      expect(ids(r.blob())).toEqual(["b"]);
      expect(r.engine.status().cursor).toBe(4);
      r.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a frame that says nothing new", async () => {
    // `head > cursor` means "you are behind, go pull". A frame at our own
    // position is the server's first-tick announcement, and answering it with
    // a round trip per device per write is a busy loop dressed as liveness.
    vi.useFakeTimers();
    try {
      const r = rig({
        blob: rows(),
        pushed: rows(),
        intervalMs: 600_000,
        cursor: 4,
        script: [{ cursor: 4, more: false, head: 4 }],
      });

      r.engine.start();
      await advance(0);
      expect(r.sent).toHaveLength(1);

      r.frame(4);
      await advance(0);
      expect(r.sent).toHaveLength(1);
      r.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the timer running when the stream drops", async () => {
    // `EventSource` reconnects on its own — the server sends `retry: 3000`
    // before anything can go wrong. Tearing the timer down with the socket
    // makes a transient stream fault into a device that never syncs again.
    vi.useFakeTimers();
    try {
      const r = rig({
        blob: rows(),
        pushed: rows(),
        intervalMs: 1_000,
        script: [{}, { records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 }],
      });

      r.engine.start();
      await advance(0);
      r.drop();
      expect(r.engine.status().live).toBe(false);

      await advance(1_000);
      expect(r.sent).toHaveLength(2);
      expect(ids(r.blob())).toEqual(["b"]);
      r.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops the timer and closes the stream on stop", async () => {
    // A stream left open per mount exhausts the browser's six connections per
    // origin after five remounts, and the whole dashboard stops loading. That
    // one has already been paid for once, in api.ts.
    vi.useFakeTimers();
    try {
      const r = rig({ blob: rows(), pushed: rows(), intervalMs: 1_000 });
      r.engine.start();
      await advance(0);
      r.engine.stop();
      // Cancelled, not merely ignored, and asserted before the clock moves —
      // a leaked timer fires once and drains, so after any advance it is
      // indistinguishable from a cancelled one. The `stopped` guard inside the
      // callback makes it harmless and invisible while it still pins the
      // engine, its storage and the blob it closed over in memory: one per
      // mount, twice per mount under StrictMode's double render.
      expect(vi.getTimerCount()).toBe(0);

      await advance(10_000);
      expect(r.sent).toHaveLength(1);
      expect(r.closes()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ rule 9: backoff ══════════════════════════════════════════════════════

describe("backoff", () => {
  it("grows exponentially and resets on success", async () => {
    // Without the reset, one bad response leaves the engine crawling for the
    // rest of the session — still running, still reporting idle, hours behind.
    const r = rig({
      intervalMs: 30_000,
      script: [{ lost: true }, { lost: true }, { lost: true }, {}],
    });

    expect(r.engine.nextDelay()).toBe(30_000);
    await r.engine.sync();
    expect(r.engine.nextDelay()).toBe(BASE_BACKOFF_MS);
    await r.engine.sync();
    expect(r.engine.nextDelay()).toBe(BASE_BACKOFF_MS * 2);
    await r.engine.sync();
    expect(r.engine.nextDelay()).toBe(BASE_BACKOFF_MS * 4);

    await r.engine.sync();
    expect(r.engine.status().failures).toBe(0);
    expect(r.engine.status().error).toBeNull();
    expect(r.engine.nextDelay()).toBe(30_000);
  });

  it("stops growing at the ceiling", async () => {
    // Uncapped, a device that was offline overnight comes back with a delay
    // measured in hours and looks broken while being perfectly healthy.
    const r = rig({ script: Array.from({ length: 30 }, () => ({ lost: true as const })) });
    for (let i = 0; i < 30; i += 1) await r.engine.sync();
    expect(r.engine.nextDelay()).toBe(MAX_BACKOFF_MS);
  });

  it("does not wedge: the timer retries on the backoff and recovers", async () => {
    // The failure mode this exists for is not a wrong delay, it is an engine
    // that stops scheduling after a throw and reports nothing.
    vi.useFakeTimers();
    try {
      const r = rig({
        blob: rows(),
        pushed: rows(),
        intervalMs: 600_000,
        script: [{ lost: true }, { records: [rec(1, "b", 9)], cursor: 1, more: false, head: 1 }],
      });

      r.engine.start();
      await advance(0);
      expect(r.engine.status().phase).toBe("offline");

      // The backoff, not the interval: a device that just lost a request must
      // not wait a full cycle to find out the link came back.
      await advance(BASE_BACKOFF_MS);
      expect(r.sent).toHaveLength(2);
      expect(r.engine.status().phase).toBe("idle");
      expect(ids(r.blob())).toEqual(["b"]);
      r.engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

// ══ rule 7: joining ═════════════════════════════════════════════════════

describe("bootstrap", () => {
  it("seeds only when the server is genuinely empty", async () => {
    const seed = vi.fn();
    const r = rig({
      blob: {},
      pushed: {},
      onBootstrap: seed,
      script: [{ cursor: 0, more: false, head: 0 }],
    });

    await r.engine.sync();
    expect(seed).toHaveBeenCalledTimes(1);

    await r.engine.sync();
    expect(seed).toHaveBeenCalledTimes(1);
  });

  it("adopts rather than seeds when the server holds anything", async () => {
    // "A device whose first pull returns anything never bootstraps." The test
    // is the server's head, not the page we happened to receive: a second
    // device joining an established account that seeds as well writes its own
    // copy of every seeded record under a second clock, and the merge keeps
    // both. The reply below also cannot make progress — `more` with a cursor
    // that did not move — so it doubles as proof the page loop stops.
    const seed = vi.fn();
    const r = rig({
      blob: {},
      pushed: {},
      onBootstrap: seed,
      script: [{ records: [], cursor: 0, more: true, head: 5 }],
    });

    await r.engine.sync();
    expect(seed).not.toHaveBeenCalled();
    expect(r.sent).toHaveLength(1);
  });

  it("does not seed again after a reload", async () => {
    // A genuinely empty server leaves the cursor at 0 and the baseline empty,
    // so without the persisted flag a reload is indistinguishable from a first
    // cycle and the seed is written twice under two clocks.
    const seed = vi.fn();
    const r = rig({
      blob: {},
      pushed: {},
      onBootstrap: seed,
      script: [{ head: 0 }, { head: 0 }],
    });

    await r.engine.sync();
    expect(seed).toHaveBeenCalledTimes(1);

    await r.reload().sync();
    expect(seed).toHaveBeenCalledTimes(1);
  });
});

// ══ rule 8: orphans ═════════════════════════════════════════════════════

describe("orphans", () => {
  it("reports a child whose parent is gone, and stops when it arrives", async () => {
    // `rehydrate`'s default reporter is a console warning, which is invisible
    // on a phone — and a dropped child is exactly the failure that lost every
    // one of 90 records once without a single failing assertion. Absence of
    // evidence must never render as success.
    const key = joinKey("ghost", "k1");
    const child: PulledRecord = {
      collection: "j.kids",
      id: key,
      seq: 1,
      hlc: formatHlc(T0 + 1, 0, "other"),
      deleted: false,
      body: { id: "k1" },
      device_id: "other",
    };
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [
        { records: [child], cursor: 1, more: false, head: 1 },
        { records: [rec(2, "ghost", 1)], cursor: 2, more: false, head: 2 },
      ],
    });

    await r.engine.sync();
    expect(r.engine.status().orphans).toEqual([{ collection: "j.kids", id: key }]);

    // Being an orphan is a property of the snapshot, not an event: once the
    // parent lands the child is attached and the report has to stop, or the
    // list becomes a permanent scar nobody can clear.
    await r.engine.sync();
    expect(r.engine.status().orphans).toEqual([]);
    expect(ids(r.blob())).toEqual(["ghost"]);
  });
});

// ══ the clock ════════════════════════════════════════════════════════════

describe("the clock", () => {
  it("never emits a reading below one it has already published", async () => {
    // Saved BEFORE the request, not after. A reading that reached the server
    // and then died with the tab would otherwise be re-minted by a clock that
    // never advanced, so a write made after the reload loses to one made
    // before it — and the loser is the newer edit.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [{ lost: true }, { accepted: ["j/a"], head: 1 }],
    });

    await r.engine.sync();
    const published = r.sent[0]!.changes[0]!.hlc;

    await r.reload().sync();
    expect(r.sent[1]!.changes[0]!.hlc > published).toBe(true);
  });

  it("moves past the highest reading it pulled", async () => {
    // Causality. Skip it and an edit to a record the server just told us about
    // can sort *before* the thing it was based on — so the merge picks the
    // older version and both devices agree on it.
    const remote = rec(1, "b", 9);
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ records: [remote], cursor: 1, more: false, head: 1 }],
    });

    await r.engine.sync();
    r.edit((b) => void ((b["j"] as Row[])[0]!.v = 10));

    await r.engine.sync();
    expect(r.sent[1]!.changes[0]!.hlc > remote.hlc).toBe(true);
  });

  it("refuses a remote clock past the drift ceiling without failing the cycle", async () => {
    // Adopting it would let that writer win every future conflict
    // permanently, with no recovery but a hand-edited database. The records
    // themselves are fine and already applied, so this is a warning on a
    // successful sync — reporting it as a failed cycle would put the device
    // into a backoff it can never leave.
    const mad: PulledRecord = {
      ...rec(1, "b", 9),
      hlc: formatHlc(T0 + 3_600_000, 0, "wrong"),
    };
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ records: [mad], cursor: 1, more: false, head: 1 }],
    });

    await r.engine.sync();
    expect(r.engine.status().phase).toBe("idle");
    expect(r.engine.status().cursor).toBe(1);
    expect(ids(r.blob())).toEqual(["b"]);
    expect(r.engine.status().error).toMatch(/ceiling/);
  });
});

// ══ transport and shell behaviour ════════════════════════════════════════

describe("the request", () => {
  it("carries the guard headers the server requires on a write", async () => {
    // ADR-0003 C3: without `X-Trainwatch` the write is refused with 403, which
    // reads exactly like a rejected password. `writeHeaders()` is the single
    // place that decision lives — the CSRF token rides with it and is absent
    // here only because there is no `document` to read the cookie from.
    const r = rig({ script: [{}] });
    await r.engine.sync();
    expect(r.sent[0]!.headers["X-Trainwatch"]).toBe("1");
    expect(r.sent[0]!.headers["Content-Type"]).toBe("application/json");
    expect(r.sent[0]!.device).toBe(r.engine.device);
  });

  it("reports a 401 to the shell, with the server's explanation intact", async () => {
    // Not an edge case: sync refuses without an identity even when global
    // enforcement is off, because filing records under a placeholder owner
    // hides every one of them the day a real account exists. So a 401 here is
    // routinely "this hub has no accounts yet", and the recovery is a CLI
    // command rather than the login form a bare status code implies.
    const seen: number[] = [];
    const off = onUnauthorized(() => seen.push(1));
    try {
      const r = rig({
        script: [
          {
            status: 401,
            errorBody: {
              detail: {
                error: "sync needs an account",
                why: "Records are stored per owner.",
                fix: "trainwatch user add <name>",
              },
            },
          },
        ],
      });

      await r.engine.sync();
      expect(seen).toHaveLength(1);
      // `error`, not `offline`: the box answered. A single state would make a
      // flaky tailnet look like a broken account, and the fix is not the same.
      expect(r.engine.status().phase).toBe("error");
      expect(r.engine.status().error).toContain("trainwatch user add");
    } finally {
      off();
    }
  });

  it("joins a cycle already in flight instead of starting a second", async () => {
    // Two overlapping cycles diff the same baseline and offer the same edit
    // under two readings: the server accepts both, burns two `seq` numbers on
    // one row, and re-delivers it to every other device twice.
    const r = rig({
      blob: rows({ id: "a", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [{ accepted: ["j/a"], head: 1 }],
    });

    await Promise.all([r.engine.sync(), r.engine.sync()]);
    expect(r.sent).toHaveLength(1);
  });

  it("survives corrupt persisted state", async () => {
    // A throw in the constructor takes the whole app down — including the
    // login form, which is the only way to fix anything. A lost baseline costs
    // one redundant full push.
    const r = rig({ blob: rows({ id: "a", v: 1 }), script: [{}, {}] });
    r.store.set(SYNC_KEYS.baseline, "{not json");
    r.store.set(SYNC_KEYS.clock, "nonsense");
    r.store.set(SYNC_KEYS.cursor, "banana");

    const engine = r.reload();
    expect(engine.status().cursor).toBe(0);
    await engine.sync();
    expect(engine.status().phase).toBe("idle");
    expect(offered(r.sent[0]).map((c) => c.id)).toEqual(["a"]);
  });

  it("counts pending changes and reaches zero", async () => {
    // The count comes from a diff against the baseline with a placeholder
    // reading, because ticking the real clock to render a "3 pending" badge
    // would advance a published counter from a read.
    const r = rig({
      blob: rows({ id: "a", v: 1 }, { id: "b", v: 1 }),
      pushed: rows({ id: "a", v: 0 }),
      script: [{ accepted: ["j/a", "j/b"], head: 2 }],
    });

    // One update and one creation. `__rest__` is already in the seeded
    // baseline, so it is not outstanding — which is the count a badge wants.
    expect(r.engine.status().pending).toBe(2);
    expect(r.engine.status().pending).toBe(2);

    await r.engine.sync();
    expect(r.engine.status().pending).toBe(0);
    expect(r.engine.status().lastSync).toBe(T0);
  });

  it("publishes status to subscribers", async () => {
    const r = rig({ blob: rows(), pushed: rows(), script: [{ head: 0 }] });
    const phases: string[] = [];
    const off = r.engine.subscribe((s) => phases.push(s.phase));

    await r.engine.sync();
    off();
    expect(phases[0]).toBe("syncing");
    expect(phases[phases.length - 1]).toBe("idle");

    await r.engine.sync();
    expect(phases).toHaveLength(2);
  });
});

// ══ persistence ═════════════════════════════════════════════════════════

describe("persistence", () => {
  it("resumes from the cursor and baseline it saved", async () => {
    // All four of these are saved because all four are load-bearing across a
    // reload: the device id (a new one per load pins the tombstone GC
    // watermark at zero forever), the clock, the cursor, and the baseline.
    const r = rig({
      blob: rows(),
      pushed: rows(),
      script: [{ records: [rec(6, "b", 9)], cursor: 6, more: false, head: 6 }],
    });

    await r.engine.sync();
    const saved = r.store.get(SYNC_KEYS.baseline);
    expect(saved).toBeDefined();
    expect((JSON.parse(saved!) as Snapshot)["j"]).toEqual({ b: { id: "b", v: 9 } });

    const next = r.reload();
    expect(next.status().cursor).toBe(6);
    expect(next.device).toBe(r.engine.device);

    // Nothing outstanding, because the baseline came back with the cursor.
    await next.sync();
    expect(r.sent[1]!.since).toBe(6);
    expect(r.sent[1]!.changes).toEqual([]);
  });
});
