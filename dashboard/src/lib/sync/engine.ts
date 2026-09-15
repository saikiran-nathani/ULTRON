/**
 * Stage 3c: the round trip. The only file in this directory that holds a
 * clock, opens a socket, and has an opinion about *when*.
 *
 * Everything under it is pure — `diff` and `applyPulled` move snapshots,
 * `flatten` and `rehydrate` move shapes, `Clock` stamps — and none of them can
 * be wrong about ordering, because none of them have any. This one can. So the
 * order of several statements below IS the correctness argument, which makes it
 * the kind of thing that survives a review and then loses data:
 *
 * - **The cursor moves last.** Persisted after the records above it are in the
 *   app's hands, never before. A response lost between the two has to leave
 *   this device asking from the same place.
 * - **The baseline moves with the live state, in the same breath.** Advancing
 *   one without the other makes the next diff re-push whatever the pull just
 *   changed — two devices that already agree, exchanging records forever.
 * - **The clock is saved before the request, not after.** A reading that
 *   reaches the server and then dies with the tab would otherwise be re-minted
 *   by a clock that never advanced, and a re-minted reading is at best a replay
 *   and at worst below one already published.
 *
 * And the one that is not sequencing but is just as quiet: a quarantined record
 * is **never offered again**. A record the server cannot store, retried
 * forever, fails every batch it rides in — which is how a device stops syncing
 * altogether while reporting nothing whatsoever.
 *
 * The stream is not in that list, deliberately. `GET /api/sync/events` carries
 * one number and it is an optimisation: a missed frame costs latency, not
 * correctness, because the timer below never stops asking. `head > cursor`
 * means "you are behind, go pull" and nothing more.
 *
 * Injected I/O, all of it
 * -----------------------
 * `fetch`, `storage`, `now` and the stream factory are parameters rather than
 * globals, and not for purity. The interesting states here are "the response
 * never came", "the server said 401 because nobody is enrolled yet", "the frame
 * was missed" and "the wall clock went backwards", and none of them are
 * reachable from a browser on demand.
 */
import { reportUnauthorized, writeHeaders } from "../auth";
import { Clock, deviceId } from "./clock";
import {
  applyPulled,
  diff,
  mayBootstrap,
  type Change,
  type Record_,
  type Snapshot,
} from "./flatten";
import {
  NEXUS_REGISTRY,
  flatten,
  rehydrate,
  type Orphan,
  type Registry,
} from "./registry";

/* ── the wire ────────────────────────────────────────────────────────────── */

/** One stored record, exactly as `_row_to_json` in `sync.py` emits it. */
export interface PulledRecord {
  collection: string;
  id: string;
  /** The server's sequence number. The pull cursor, and nothing else. */
  seq: number;
  hlc: string;
  deleted: boolean;
  body: Record_ | null;
  device_id: string;
}

/** A change that lost, with the version that beat it. */
export interface Rejection {
  collection: string;
  id: string;
  /** The whole record. A client told only "you lost" cannot converge. */
  winner: PulledRecord;
}

/** A change the server can never store, and why. */
export interface Quarantined {
  collection: string;
  id: string;
  reason: string;
}

/** The 200 body of `POST /api/sync`. */
export interface SyncReply {
  accepted: string[];
  rejected: Rejection[];
  quarantined: Quarantined[];
  records: PulledRecord[];
  cursor: number;
  more: boolean;
  head: number;
}

/**
 * The slice of `fetch` this file uses.
 *
 * Structural and narrow so a fake is three lines and no test ever casts
 * something to `Response`. `globalThis.fetch` satisfies it as written.
 */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * The slice of `EventSource` this file uses.
 *
 * `addEventListener` is typed against `Event` rather than `MessageEvent`
 * because the DOM's own signature is, and a narrower listener type is not
 * assignable to it in either direction — so the cast at the call site is the
 * price of letting a real `EventSource` satisfy this. `api.ts` pays it too.
 */
export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: Event) => void): void;
  onerror: ((ev: Event) => void) | null;
  close(): void;
}

/* ── knobs ───────────────────────────────────────────────────────────────── */

export const SYNC_URL = "/api/sync";
export const STREAM_URL = "/api/sync/events";

/** Slow on purpose: the stream is what makes sync feel immediate. */
export const DEFAULT_INTERVAL_MS = 30_000;
export const BASE_BACKOFF_MS = 1_000;
/**
 * The ceiling. Without it a device that was offline overnight comes back with
 * a delay measured in hours and looks broken while being perfectly healthy.
 */
export const MAX_BACKOFF_MS = 5 * 60_000;

/** Well under the server's 2000 cap. The whole dataset is ~38 KB. */
const PAGE_SIZE = 500;

/**
 * A bound on paging within one cycle.
 *
 * `more` comes from the server, so a server bug could assert it forever. That
 * is a bug either way; looping is the version that takes the phone's battery
 * with it.
 */
const MAX_PAGES = 64;

/** Persisted state. Exported because a future migration has to know the names. */
export const SYNC_KEYS = {
  /** Owned by `deviceId()` in clock.ts — named here only for completeness. */
  device: "tw.sync.device",
  clock: "tw.sync.clock",
  cursor: "tw.sync.cursor",
  baseline: "tw.sync.baseline",
  quarantine: "tw.sync.quarantine",
  joined: "tw.sync.joined",
} as const;

/* ── status ──────────────────────────────────────────────────────────────── */

export type SyncPhase = "idle" | "syncing" | "offline" | "error";

export interface SyncStatus {
  /**
   * `offline` and `error` are separated on purpose. One means "we cannot reach
   * the box, your edits are queued and safe"; the other means "the box
   * answered and said no". Collapsing them makes a flaky tailnet look like a
   * broken account, and the fix for those is not the same.
   */
  phase: SyncPhase;
  /** Changes a cycle would offer right now. The "3 pending" indicator. */
  pending: number;
  lastSync: number | null;
  /** Server `seq` we have acknowledged. */
  cursor: number;
  /** The owner's highest assigned `seq`, as of the last reply. */
  head: number;
  /** Records that will never sync until the data changes. Rule 6. */
  quarantined: Quarantined[];
  /** Children dropped on the last rehydrate because their parent is gone. */
  orphans: Orphan[];
  /** Last failure, or a warning from a successful cycle. */
  error: string | null;
  /** Consecutive failures. Drives the backoff. */
  failures: number;
  /** Whether the nudge stream is attached. Never a correctness signal. */
  live: boolean;
}

export interface EngineDeps {
  /** The app's live blob. Read fresh every time; `flatten` clones it. */
  read: () => Record<string, unknown>;
  /** Hand the merged blob back to the app. Called only when something moved. */
  write: (blob: Record<string, unknown>) => void;
  fetch: FetchLike;
  storage: Pick<Storage, "getItem" | "setItem">;
  /** The wall clock, for the HLC and for `lastSync`. */
  now: () => number;
  /** Omit to run without a stream — the timer alone is still correct. */
  eventSource?: (url: string) => EventSourceLike;
  registry?: Registry;
  /** Called at most once, and only when `mayBootstrap` says so. */
  onBootstrap?: () => void;
  intervalMs?: number;
  limit?: number;
  /** Cosmetic labels for the device list. */
  label?: { name?: string; platform?: string };
}

/** A server that answered, and refused. Distinct from a network fault. */
export class SyncFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "SyncFailure";
  }
}

/**
 * `collection/id`, matching the server's `accepted` entries byte for byte.
 *
 * Only ever compared, never split back apart — record ids in this model
 * already contain colons and percent-escapes, and one of them will contain a
 * slash eventually. Both sides build the string the same way, so membership is
 * an exact-string test and the ambiguity never arises.
 */
const keyOf = (r: { collection: string; id: string }): string => `${r.collection}/${r.id}`;

function readJson<T>(storage: Pick<Storage, "getItem">, key: string): T | null {
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Corrupt persisted state must not brick the engine. A lost baseline costs
    // one redundant full push; a throw in the constructor costs the whole app,
    // including the login form that is the only way to fix anything.
    return null;
  }
}

/** Compose the server's refusal into something a screen can show. */
async function explain(
  res: { status: number; json: () => Promise<unknown> },
): Promise<string> {
  const body = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  const detail = body?.detail;
  if (typeof detail === "string" && detail) return detail;
  if (detail && typeof detail === "object") {
    const d = detail as { error?: string; why?: string; fix?: string };
    // `why` and `fix` are the sentences that make a 401 on a box with no
    // accounts actionable — it is `trainwatch user add`, not a login form.
    // Dropping them leaves the user staring at a number.
    const parts = [d.error, d.why, d.fix ? `Fix: ${d.fix}` : ""].filter(
      (p): p is string => !!p,
    );
    if (parts.length) return parts.join(" — ");
  }
  return `sync refused (${res.status})`;
}

/* ── the engine ──────────────────────────────────────────────────────────── */

export class SyncEngine {
  /** This device's stable id: the HLC node and the sync device parameter. */
  readonly device: string;

  private readonly registry: Registry;
  private readonly interval: number;
  private readonly limit: number;
  private readonly clock: Clock;

  private cursor = 0;
  private baseline: Snapshot = {};
  private readonly quarantine = new Map<string, Quarantined>();
  private joined: boolean;

  /**
   * Changes minted and not yet acknowledged.
   *
   * Re-offered under the SAME readings rather than re-diffed into new ones,
   * because a lost response is indistinguishable from a rejected one from
   * here — and the server recognises an identical HLC as a replay: accepted,
   * no write, and no archive row claiming an overwrite that never happened.
   * In memory only: a reload legitimately re-mints, which costs one redundant
   * accepted write and nothing else.
   */
  private retry: Change[] = [];

  private phase: SyncPhase = "idle";
  private lastSync: number | null = null;
  private head = 0;
  private orphans: Orphan[] = [];
  private failure: string | null = null;
  private failures = 0;

  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stream: EventSourceLike | null = null;
  private liveOpen = false;
  private stopped = true;

  private readonly watchers = new Set<(s: SyncStatus) => void>();

  constructor(private readonly deps: EngineDeps) {
    this.registry = deps.registry ?? NEXUS_REGISTRY;
    this.interval = deps.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.limit = deps.limit ?? PAGE_SIZE;
    this.device = deviceId(deps.storage);

    const saved = readJson<{ node?: string; millis?: number; counter?: number }>(
      deps.storage,
      SYNC_KEYS.clock,
    );
    // Adopt a saved reading only if it is OURS. A clock's node id is the device
    // id, so a reading filed under another node was never published by us —
    // and a copied browser profile that adopted it would be minting readings a
    // second, live device is also minting.
    this.clock =
      saved && saved.node === this.device
        ? new Clock(this.device, saved.millis ?? 0, saved.counter ?? 0)
        : new Clock(this.device);

    const cursor = Number(deps.storage.getItem(SYNC_KEYS.cursor) ?? 0);
    this.cursor = Number.isInteger(cursor) && cursor >= 0 ? cursor : 0;
    this.baseline = readJson<Snapshot>(deps.storage, SYNC_KEYS.baseline) ?? {};
    for (const q of readJson<Quarantined[]>(deps.storage, SYNC_KEYS.quarantine) ?? []) {
      this.quarantine.set(keyOf(q), q);
    }
    this.joined = deps.storage.getItem(SYNC_KEYS.joined) === "1";
  }

  /* ── observation ───────────────────────────────────────────────────── */

  status(): SyncStatus {
    return {
      phase: this.phase,
      pending: this.dirtyKeys(this.snapshot()).size,
      lastSync: this.lastSync,
      cursor: this.cursor,
      head: this.head,
      quarantined: [...this.quarantine.values()],
      orphans: [...this.orphans],
      error: this.failure,
      failures: this.failures,
      live: this.liveOpen,
    };
  }

  subscribe(fn: (s: SyncStatus) => void): () => void {
    this.watchers.add(fn);
    return () => void this.watchers.delete(fn);
  }

  /** The delay before the next scheduled cycle. Also a "retrying in Ns" label. */
  nextDelay(): number {
    if (this.failures === 0) return this.interval;
    return Math.min(BASE_BACKOFF_MS * 2 ** (this.failures - 1), MAX_BACKOFF_MS);
  }

  /**
   * Offer a quarantined record again, after somebody has changed the data.
   *
   * Deliberately manual. This side does not know the server's caps, so "the
   * body changed, it is probably fine now" is blind retry wearing a nicer
   * name — and blind retry is the exact bug the quarantine list was added to
   * kill.
   */
  release(collection: string, id: string): void {
    if (this.quarantine.delete(keyOf({ collection, id }))) {
      this.saveQuarantine();
      this.emit();
    }
  }

  /* ── schedule ──────────────────────────────────────────────────────── */

  /**
   * Sync now, then on a timer, and attach the stream.
   *
   * The timer is not conditional on the stream, and that is the whole of rule
   * 5. Safari suspends sockets in a backgrounded tab and the socket looks fine
   * on return, so a stream can be open and dead — which costs latency only for
   * as long as something else is still asking on its own schedule.
   */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.listen();
    // Through the timer even for the first cycle, so scheduling has exactly
    // one door and `stop()` between two statements cannot leave a cycle
    // running that nothing is tracking.
    this.arm(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.stream?.close();
    this.stream = null;
    this.liveOpen = false;
    this.emit();
  }

  /** Ask for a cycle as soon as the stack unwinds. */
  nudge(): void {
    if (!this.stopped) this.arm(0);
  }

  /**
   * One cycle. Never rejects — a failed sync is a status, because the caller
   * is a timer with nowhere to report to.
   *
   * A second call while one is in flight joins it rather than starting another.
   * Two overlapping cycles diff the same baseline and offer the same edit under
   * two readings: the server accepts both, burns two `seq` numbers on one row
   * and re-delivers it to every other device twice.
   */
  sync(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const run = this.cycle().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    await this.sync();
    // Re-armed after the cycle rather than set once with `setInterval`: the
    // delay changes with the backoff, and an interval fires while a cycle is
    // still in flight, stacking round trips on exactly the slow link that
    // caused the delay.
    if (!this.stopped) this.arm(this.nextDelay());
  }

  private arm(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delay);
  }

  /* ── the cycle ─────────────────────────────────────────────────────── */

  private async cycle(): Promise<void> {
    // A fresh attempt carries no verdict yet. Cleared here rather than on
    // success so that a warning raised mid-cycle survives to the end of it.
    this.failure = null;
    this.setPhase("syncing");

    const offered = this.offer(this.snapshot());
    this.retry = offered;

    // Before the request, not after. See the module docstring: a reading that
    // reaches the server and then dies with the tab must not be re-minted.
    this.saveClock();

    let pulled = 0;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        // Only the first page pushes. Re-sending the batch would re-offer
        // changes the server acknowledged on the page before.
        const reply = await this.parse(await this.post(page === 0 ? offered : []));
        const winners = page === 0 ? this.absorbPush(offered, reply) : [];
        pulled += reply.records.length;

        const before = this.cursor;
        this.absorbPull(reply, winners);

        if (!reply.more) break;
        // `more` with a cursor that did not move would spin here forever.
        // Stopping costs one interval of latency; the timer and the stream
        // both come back.
        if (this.cursor <= before) break;
      }

      this.failures = 0;
      this.lastSync = this.deps.now();
      // Inside the try: a seed that throws leaves a half-populated device, and
      // that is a failed cycle however well the transport behaved.
      this.join(pulled);
      this.setPhase("idle");
    } catch (e) {
      this.failures += 1;
      this.failure = e instanceof Error ? e.message : String(e);
      // A server that answered is an `error`; a fetch that threw never reached
      // it and is `offline`.
      this.setPhase(e instanceof SyncFailure ? "error" : "offline");
    }
  }

  /**
   * The changes to offer: anything unacknowledged, plus a fresh diff, minus
   * anything quarantined.
   *
   * The fresh diff runs against a *provisional* baseline — the real baseline
   * with the unacknowledged batch applied — which is what makes a replay a
   * replay. If nothing changed since those readings were minted, the
   * provisional baseline already matches the current state and the diff is
   * empty, so the same readings go back out. If the record was edited again,
   * the new version supersedes the old one and the server sees an ordinary
   * later write.
   */
  private offer(current: Snapshot): Change[] {
    const provisional = applyPulled(this.baseline, this.retry);
    const fresh = diff(provisional, current, () =>
      this.clock.tick(this.deps.now()),
    ).changes;
    const superseded = new Set(fresh.map(keyOf));
    const batch = [...this.retry.filter((c) => !superseded.has(keyOf(c))), ...fresh];
    // Rule 6's teeth. An unstorable record — an id past the length cap, a body
    // past the size cap, a clock past the drift ceiling — used to fail every
    // batch it rode in, so one bad record stopped that device syncing anything
    // at all, permanently, with a 422 no screen displayed.
    return batch.filter((c) => !this.quarantine.has(keyOf(c)));
  }

  private async post(changes: Change[]): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
  }> {
    const q = new URLSearchParams({
      device: this.device,
      // The cursor, and only the cursor. Never derived from an HLC: a record
      // written on a slow-clocked device would land below another device's
      // position and never be delivered to it again.
      since: String(this.cursor),
      limit: String(this.limit),
    });
    if (this.deps.label?.name) q.set("name", this.deps.label.name);
    if (this.deps.label?.platform) q.set("platform", this.deps.label.platform);

    const res = await this.deps.fetch(`${SYNC_URL}?${q.toString()}`, {
      method: "POST",
      // `writeHeaders()`, not a hand-rolled pair. `X-Trainwatch` is ADR-0003
      // C3 and `X-CSRF-Token` is C12; they defend different things, and a
      // second copy of that decision here is a second place for it to drift.
      headers: writeHeaders({
        "Content-Type": "application/json",
        Accept: "application/json",
      }),
      body: JSON.stringify({ changes }),
    });

    if (res.ok) return res;

    if (res.status === 401) {
      // Both the mid-session death and the nothing-enrolled state, which is
      // why this is not an edge case: sync refuses without an identity even
      // when global enforcement is off, because filing records under a
      // placeholder owner hides every one of them the day a real account
      // exists. One central report; auth.ts owns what happens next.
      reportUnauthorized();
    }
    throw new SyncFailure(res.status, await explain(res));
  }

  private async parse(res: { json: () => Promise<unknown> }): Promise<SyncReply> {
    const r = ((await res.json()) ?? {}) as Partial<SyncReply>;
    // Normalised once. The server guarantees all seven keys — `quarantined` is
    // always present precisely because a client that has to check will forget
    // — but a proxy or a captive portal can put anything on the wire, and a
    // missing key must not become a TypeError halfway through the apply step
    // with the state already moved.
    return {
      accepted: r.accepted ?? [],
      rejected: r.rejected ?? [],
      quarantined: r.quarantined ?? [],
      records: r.records ?? [],
      // Defaults that stay put rather than reset: learning nothing must not
      // rewind the cursor to zero and re-pull the whole dataset.
      cursor: typeof r.cursor === "number" ? r.cursor : this.cursor,
      more: r.more === true,
      head: typeof r.head === "number" ? r.head : this.head,
    };
  }

  /**
   * Every change we sent comes back in exactly one of three lists, and each
   * demands something different. Returns the winners, so they land in the same
   * apply as the pulled page.
   */
  private absorbPush(offered: Change[], reply: SyncReply): PulledRecord[] {
    if (reply.quarantined.length) {
      for (const q of reply.quarantined) this.quarantine.set(keyOf(q), q);
      this.saveQuarantine();
    }

    // Accepted: the server now holds exactly what we sent, so the baseline
    // advances for those records — and to THE VERSION WE SENT, never to
    // `read()` as it now stands. The user may have edited during the round
    // trip; recording live state as pushed would mark those edits clean and
    // the next diff would never offer them again.
    const sent = new Map(offered.map((c) => [keyOf(c), c] as const));
    const landed: Change[] = [];
    for (const key of reply.accepted) {
      const change = sent.get(key);
      if (change) landed.push(change);
    }
    if (landed.length) {
      this.baseline = applyPulled(this.baseline, landed);
      this.saveBaseline();
    }

    // Anything in none of the three lists stays minted and is offered again,
    // which is exactly what a lost response looks like from here. Safe, and
    // the only honest default.
    const done = new Set<string>([
      ...reply.accepted,
      ...reply.rejected.map(keyOf),
      ...reply.quarantined.map(keyOf),
    ]);
    this.retry = offered.filter((c) => !done.has(keyOf(c)));

    // Rejected: hand back the winner, because a client told only "you lost"
    // cannot converge. This is also the half the pull cannot cover — a winner
    // whose `seq` is already below our cursor never appears in `records`, so
    // it arrives here or not at all.
    return reply.rejected.map((r) => r.winner);
  }

  private absorbPull(reply: SyncReply, winners: PulledRecord[]): void {
    // Winners first, then the page in `seq` order: a record in both lists is
    // the same row, and the pulled copy carries the higher `seq`.
    const incoming = [...winners, ...reply.records];

    if (incoming.length) {
      const live = this.snapshot();
      // Keep a local edit that raced this pull. A record changed since the
      // baseline and not yet acknowledged is an unpushed edit; letting the
      // server's copy land on top of it drops it with no conflict entry
      // anywhere, because the baseline advances too and the next diff then has
      // nothing to say. Instead the server's version goes into the baseline
      // only, so the next diff re-offers ours under a fresh — and, after
      // `observe`, higher — reading, and the HLC decides. Identical to the
      // outcome of an edit made a second later.
      // Winners are exempt from that, and have to be: a rejection says *our
      // version lost*, so there is no unpushed edit left to protect — and
      // withholding the winner is rule 6's own failure, a loser that clears
      // its dirty flag believing it won and diverges permanently, with nobody
      // left who thinks there is a conflict to resolve.
      const dirty = this.dirtyKeys(live);
      const settled = [...winners, ...reply.records.filter((r) => !dirty.has(keyOf(r)))];

      const nextLive = applyPulled(live, settled);
      const nextBaseline = applyPulled(this.baseline, incoming);

      // `write` before the baseline moves. If handing the blob to the app
      // throws, the baseline must not already claim we agree with a version
      // the app never received — the next diff would read the difference as
      // deletions and push tombstones for records another device just wrote.
      this.deps.write(this.toBlob(nextLive));
      this.baseline = nextBaseline;

      // Causality. Our next write has to sort above the highest reading we
      // have seen, or an edit can sort *before* the thing it was based on.
      this.observe(incoming);
    }

    this.head = reply.head;

    // The cursor, last, and persisted with the baseline it belongs to. Rule 3
    // is these three statements being after the `write` above and not before
    // it: the cursor advances only on a pull this device has acknowledged.
    //
    // Assigned rather than `max`-ed with our own. The server computes it from
    // rows above the `since` we sent, so it cannot come back lower, and a
    // `max` here would paper over a server answering the wrong question.
    // `winner.seq` in particular never touches it — a winner can sit far below
    // the cursor, and folding it in would skip every record in between.
    this.cursor = reply.cursor;
    this.deps.storage.setItem(SYNC_KEYS.cursor, String(this.cursor));
    this.saveBaseline();
  }

  /** Rule 7, once per install. */
  private join(pulled: number): void {
    if (this.joined) return;
    // Persisted before the verdict, not after. On a genuinely empty server the
    // first cycle leaves the cursor at 0 and the baseline empty, so without
    // the flag a reload would look like a first cycle again and seed twice.
    this.joined = true;
    this.deps.storage.setItem(SYNC_KEYS.joined, "1");
    // "A device whose first pull returns anything never bootstraps." The test
    // is "has the server anything at all", not "has it my collections": a
    // second device joining an established account must adopt, never seed.
    if (mayBootstrap(this.head, pulled)) this.deps.onBootstrap?.();
  }

  private observe(incoming: PulledRecord[]): void {
    let highest = "";
    for (const r of incoming) if (r.hlc > highest) highest = r.hlc;
    if (!highest) return;
    try {
      this.clock.observe(highest, this.deps.now());
      this.saveClock();
    } catch (e) {
      // A remote clock past the drift ceiling. `Clock.observe` refuses and
      // leaves ours alone, which is the point — adopting it would let that
      // writer win every future conflict permanently. The records themselves
      // are fine and already applied, so this is a warning on a successful
      // cycle, not a failed one.
      this.failure = e instanceof Error ? e.message : String(e);
    }
  }

  /* ── shapes and persistence ────────────────────────────────────────── */

  /** The app's blob as a flat snapshot. A clone of ~38 KB; cost is noise. */
  private snapshot(): Snapshot {
    return flatten(this.deps.read(), this.registry);
  }

  /**
   * Snapshot → blob, recording every orphan.
   *
   * `rehydrate`'s default reporter is a console warning, which is invisible on
   * a phone — and a dropped child is precisely the failure that destroyed a
   * whole dataset once without a single failing assertion. The list is rebuilt
   * per call rather than appended to, because being an orphan is a property of
   * the current snapshot and not an event: a child whose parent comes back has
   * to stop being reported.
   */
  private toBlob(snapshot: Snapshot): Record<string, unknown> {
    const found: Orphan[] = [];
    const blob = rehydrate(snapshot, this.registry, (o) => found.push(o));
    this.orphans = found;
    return blob;
  }

  /**
   * Keys the next push would offer.
   *
   * The placeholder reading is deliberate: `diff` only copies it onto the
   * change, and ticking the real clock here would advance a published counter
   * from a *read* — a "3 pending" badge must not move the clock every time it
   * renders.
   */
  private dirtyKeys(current: Snapshot): Set<string> {
    const out = new Set<string>();
    for (const c of diff(this.baseline, current, () => "").changes) {
      const key = keyOf(c);
      if (!this.quarantine.has(key)) out.add(key);
    }
    return out;
  }

  private saveBaseline(): void {
    this.deps.storage.setItem(SYNC_KEYS.baseline, JSON.stringify(this.baseline));
  }

  private saveClock(): void {
    this.deps.storage.setItem(SYNC_KEYS.clock, JSON.stringify(this.clock.toJSON()));
  }

  private saveQuarantine(): void {
    this.deps.storage.setItem(
      SYNC_KEYS.quarantine,
      JSON.stringify([...this.quarantine.values()]),
    );
  }

  /* ── the nudge stream ──────────────────────────────────────────────── */

  /**
   * Attach the stream. One number, never data.
   *
   * No options object: `EventSource` cannot set request headers, so this
   * authenticates on the cookie alone. It is a GET, so ADR-0003 C3 does not
   * apply and `writeHeaders()` has nothing to contribute.
   */
  private listen(): void {
    const open = this.deps.eventSource;
    if (!open) return;
    this.stream?.close();
    const es = open(STREAM_URL);
    this.stream = es;

    es.addEventListener("open", () => {
      this.liveOpen = true;
      this.emit();
    });

    es.addEventListener("sync", (ev) => {
      this.liveOpen = true;
      let head: unknown;
      try {
        // Cast as in api.ts: the DOM types `addEventListener` against `Event`.
        head = (JSON.parse((ev as MessageEvent<string>).data) as { head?: unknown })
          .head;
      } catch {
        // A malformed tick is not worth tearing the stream down.
        return;
      }
      // The frame's only effect is whether to ask. It is never applied, never
      // stored, and never touches the cursor: a record arriving out of band
      // would be a second delivery path with its own ordering, racing the
      // pull, and the cursor may only advance to a `seq` this device has
      // acknowledged. Out-of-band data is therefore either re-delivered
      // forever or skipped forever, and nothing in between.
      if (typeof head === "number" && head > this.cursor) this.nudge();
      this.emit();
    });

    es.onerror = () => {
      // `EventSource` reconnects on its own — the server sends `retry: 3000`
      // first thing, before anything can go wrong. Surface the gap, tear
      // nothing down, and above all leave the timer alone.
      this.liveOpen = false;
      this.emit();
    };
  }

  private setPhase(p: SyncPhase): void {
    this.phase = p;
    this.emit();
  }

  private emit(): void {
    const s = this.status();
    // A copy, because a watcher may unsubscribe from inside its own callback.
    for (const fn of [...this.watchers]) fn(s);
  }
}
