/**
 * The read/manage half of sync, over HTTP: the conflict archive, the device
 * list, and retiring a device.
 *
 * Deliberately NOT in `lib/sync/`. That directory is the engine — the clock,
 * the registry, the flatten/rehydrate pair — and it owns every write to a
 * record. This file owns HTTP plus the small amount of arithmetic needed to
 * turn an append-only log into "which one of these is live", and nothing else.
 * Nothing here pushes a record; a restore is handed back to the caller as a
 * callback so there is exactly one code path that writes.
 *
 * Three things in here are load-bearing, and two of them fail silently.
 *
 * 1. **A record id travels as a query parameter, encoded, never as a path
 *    segment.** Stage 3b keys a nested record as
 *    `encodeURIComponent(parent):encodeURIComponent(child)`, so an id
 *    genuinely contains percent-escapes — `seed%3A0001%3Aphase%3Aship:…`. The
 *    server stack decodes the path before routing, so `%3A` in a path segment
 *    arrives as `:` however many times the client escapes it, the lookup
 *    misses, and the reply is a **200 with an empty version list**. That reads
 *    as "this record has no conflict history" rather than as a bug, which is
 *    the worst possible failure for a screen whose entire job is to prove that
 *    history exists. `URLSearchParams` round-trips exactly. See the comment on
 *    the `/history` route in `server/sync_api.py`.
 *
 * 2. **A 401 here has two quite different causes.** `AuthGuard` sends
 *    `{error: "authentication required", …}` when a session died under an open
 *    screen — the shell must flip to the login form, so that one reports
 *    through `reportUnauthorized()` like every other fetch path in the app.
 *    But `sync_api._owner()` also answers 401, with a `fix` field, when the
 *    instance has no accounts at all: sync refuses rather than filing records
 *    under a placeholder owner. Reporting *that* as unauthorized would put a
 *    login form in front of a box with no accounts — the door-with-no-key trap
 *    `lib/auth.ts` was written to avoid. `fix` is the discriminator.
 *
 * 3. **`accepted` is not `applied`, and `rejected` is not `superseded`.** An
 *    `accepted` row was stored and did reach other devices; it may since have
 *    lost its place to a higher clock. A `rejected` row never landed at all —
 *    it arrived already stale. "Your edit was overwritten" and "your edit never
 *    arrived" are different sentences with different fixes, so the role each
 *    row gets is derived rather than guessed.
 */
import { reportUnauthorized, writeHeaders } from "./auth";

const BASE = "/api/sync";

/* ── the wire ─────────────────────────────────────────────────────────────
   Types mirror what the server actually returns, not what would be tidy.
   `Sync.history` in src/trainwatch/sync.py is the source: seven fields per
   row, `device_name` falling back to `device_id` so it is never empty. */

/** The column is free text server-side, but only these two are ever written. */
export type SyncOutcome = "accepted" | "rejected";

/** One row of the append-only log. `ts` is epoch **seconds**, as a float. */
export interface SyncVersion {
  hlc: string;
  deleted: boolean;
  /** Parsed JSON, or null for a tombstone. Shape belongs to the collection. */
  body: unknown;
  device_id: string;
  /** Never empty: the server falls back to `device_id` when nobody named it. */
  device_name: string;
  outcome: SyncOutcome;
  ts: number;
}

export interface SyncHistory {
  collection: string;
  id: string;
  /** Newest first — `ORDER BY l.id DESC`. */
  versions: SyncVersion[];
}

export interface SyncDevice {
  id: string;
  name: string;
  platform: string;
  last_pull_seq: number;
  first_seen: number;
  last_seen: number;
  retired: boolean;
}

export interface SyncStats {
  records: number;
  tombstones: number;
  versions: number;
  head: number;
  devices: number;
  gc_watermark: number;
}

export interface SyncState {
  devices: SyncDevice[];
  stats: SyncStats;
}

export interface RetireResult {
  /** False when the device was already retired — the call is idempotent. */
  retired: boolean;
  device: string;
}

/* ── errors ─────────────────────────────────────────────────────────────── */

/**
 * A refusal, with the server's own reasoning attached rather than flattened
 * into one string. The panels render `why` and `fix` as separate lines because
 * a message that says what to do next is the difference between a dead end and
 * a one-command fix.
 */
export class SyncApiError extends Error {
  readonly status: number;
  readonly why: string | undefined;
  readonly fix: string | undefined;

  constructor(status: number, message: string, why?: string, fix?: string) {
    super(message);
    this.name = "SyncApiError";
    this.status = status;
    this.why = why;
    this.fix = fix;
  }

  /**
   * "This instance has no accounts" rather than "your session died". See note
   * 2 in the module docstring: only the second one may flip the shell to a
   * login form.
   */
  get needsAccount(): boolean {
    return this.status === 401 && this.fix !== undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Non-empty strings only: `""` carries no information and reads as a bug. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface Refusal {
  message: string;
  why: string | undefined;
  fix: string | undefined;
}

/**
 * Normalise the three refusal shapes this API can produce into one.
 *
 * The guards answer `{error, why}` (`server/auth_api.py:_deny`), the sync
 * routes answer `HTTPException`, which FastAPI wraps as `{detail: …}` — a dict
 * for the hand-written refusals and a **list** for its own request validation.
 * Three shapes, and the list one matters: rendering FastAPI's raw validation
 * array on screen is indistinguishable from a crash.
 */
function refusalFrom(body: unknown): Refusal | undefined {
  if (!isRecord(body)) return undefined;

  const detail = body["detail"];

  if (Array.isArray(detail)) {
    const msgs = detail
      .map((d) => (isRecord(d) ? text(d["msg"]) : undefined))
      .filter((m): m is string => m !== undefined);
    return msgs.length > 0 ? { message: msgs.join("; "), why: undefined, fix: undefined } : undefined;
  }

  if (isRecord(detail)) {
    const message = text(detail["error"]);
    if (message === undefined) return undefined;
    return { message, why: text(detail["why"]), fix: text(detail["fix"]) };
  }

  const plain = text(detail) ?? text(body["error"]);
  if (plain === undefined) return undefined;
  return { message: plain, why: text(body["why"]), fix: text(body["fix"]) };
}

async function refuse(res: Response, path: string): Promise<never> {
  // `.json()` on an HTML 502 from a proxy throws; the status is still the most
  // useful thing we know, so a parse failure must not replace it with a
  // TypeError about unexpected tokens.
  const parsed = refusalFrom(await res.json().catch(() => undefined));

  let message = parsed?.message ?? `${res.status} ${res.statusText} — ${path}`;
  let why = parsed?.why;
  const fix = parsed?.fix;

  if (res.status === 421) {
    // Same words as the private helper in lib/hub.ts. Not imported because it
    // is not exported there — if one changes, change both.
    message = "the server refused this hostname (DNS-rebinding guard)";
    why =
      "Add it to TRAINWATCH_ALLOWED_HOSTS, or reach the box by its Tailscale name.";
  }

  // 403 has two causes and one status code. Which one it was is the difference
  // between reloading the tab and not having permission at all.
  if (res.status === 403 && /csrf/i.test(message)) {
    message = "this tab's CSRF token is stale";
    why = "Reload the page and try again — the cookie and the header disagree.";
  }

  // Note 2: `fix` present means "no accounts enrolled", which is not a dead
  // session and must not summon a login form.
  if (res.status === 401 && fix === undefined) reportUnauthorized();

  throw new SyncApiError(res.status, message, why, fix);
}

/* ── URLs ───────────────────────────────────────────────────────────────── */

export const HISTORY_LIMIT_MIN = 1;
export const HISTORY_LIMIT_MAX = 200;
export const HISTORY_LIMIT_DEFAULT = 50;

/**
 * Clamped client-side, not left to the server.
 *
 * FastAPI declares `ge=1, le=200` and answers an out-of-range value with a 422
 * whose body is its validation array — a refusal caused entirely by us, shown
 * to the user as though the archive were broken. Same instinct as
 * `fetchSeries` chunking rather than letting the server truncate: keep the
 * request inside the contract so the server never has to say no.
 */
export function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return HISTORY_LIMIT_DEFAULT;
  return Math.min(HISTORY_LIMIT_MAX, Math.max(HISTORY_LIMIT_MIN, Math.floor(limit)));
}

/**
 * The archive URL. Note 1 in the module docstring is the whole reason this is
 * a function and not a template literal at the call site: every part of the id
 * goes through `URLSearchParams`, which escapes the `%` of an existing escape
 * so the server decodes back to the exact bytes we were given.
 */
export function historyPath(
  collection: string,
  recordId: string,
  limit: number = HISTORY_LIMIT_DEFAULT,
): string {
  const query = new URLSearchParams({
    collection,
    // `id`, not `record_id`: the route aliases it.
    id: recordId,
    limit: String(clampLimit(limit)),
  });
  return `${BASE}/history?${query.toString()}`;
}

/**
 * Retire's id IS a path segment — the route is shaped that way
 * (`/devices/{device_id}/retire`), so this one is the server's choice, not
 * ours. `encodeURIComponent` keeps a device name with separators in it from
 * reshaping the path; an id that itself contained a percent-escape would hit
 * the same decode trap note 1 describes, but device ids are minted by the
 * client as plain slugs, so that case does not arise today.
 */
export function retirePath(deviceId: string): string {
  return `${BASE}/devices/${encodeURIComponent(deviceId)}/retire`;
}

/* ── calls ──────────────────────────────────────────────────────────────── */

async function read<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) await refuse(res, path);
  return (await res.json()) as T;
}

export const syncApi = {
  /**
   * Every version of one record. An empty `versions` array is a **successful**
   * answer meaning "only ever one version", and the caller must be able to
   * tell it apart from a failure — which is why this rejects on !ok rather
   * than returning an empty list.
   */
  history: (
    collection: string,
    recordId: string,
    limit: number = HISTORY_LIMIT_DEFAULT,
    signal?: AbortSignal,
  ) => read<SyncHistory>(historyPath(collection, recordId, limit), signal),

  state: (signal?: AbortSignal) => read<SyncState>(`${BASE}/state`, signal),

  /** Mutating, so it carries C3 + C12 from `writeHeaders()`. Idempotent. */
  retire: async (deviceId: string, signal?: AbortSignal): Promise<RetireResult> => {
    const path = retirePath(deviceId);
    const res = await fetch(path, {
      method: "POST",
      signal,
      headers: writeHeaders({ Accept: "application/json" }),
    });
    if (!res.ok) await refuse(res, path);
    return (await res.json()) as RetireResult;
  },
};

/* ── deriving what the user actually needs to see ─────────────────────────
   The log says what happened; it does not say which row is live. That one
   fact is what separates a useful archive from a list you cannot read, so it
   is computed here, once, where a test can hold it still. */

export type VersionRole =
  /** The row currently in `sync_records`. Exactly one, or none in a window. */
  | "live"
  /** Stored, reached other devices, then lost its place to a higher clock. */
  | "superseded"
  /** Never stored: it arrived already behind the incumbent. */
  | "refused";

export interface ArchivedVersion extends SyncVersion {
  role: VersionRole;
}

export interface Archive {
  /** Server order preserved — newest first. */
  versions: ArchivedVersion[];
  live: ArchivedVersion | undefined;
  /** The window is full, so older versions probably exist behind it. */
  truncated: boolean;
}

/**
 * Label each row, and find the live one.
 *
 * The winner is the **highest-HLC accepted** row, not simply the first row the
 * server handed back. Both give the same answer today — an accepted write only
 * happens when it beats the incumbent, so the newest accepted row is the live
 * one — but deriving it from the HLC means a change to that `ORDER BY` cannot
 * silently re-label which version is live, and mislabelling the winner is the
 * one bug that makes this screen worse than not having it.
 *
 * Plain string comparison is correct on an HLC: the format is fixed-width and
 * zero-padded (`0000001789344000-00000-dev-a`), so lexicographic order is
 * logical order. That is asserted on both sides, in `lib/sync/clock.ts` and
 * `trainwatch/hlc.py`.
 *
 * `live` can legitimately be absent. `ORDER BY id DESC LIMIT n` cuts the
 * newest `n` rows, and a rejection is logged *after* the accepted write of the
 * same batch — so a small limit can return nothing but rejections. Saying "no
 * live version in this window" is honest; calling the newest row the winner
 * would be a lie with a tick next to it.
 */
export function archiveOf(
  versions: readonly SyncVersion[],
  limit: number = HISTORY_LIMIT_DEFAULT,
): Archive {
  let winner: SyncVersion | undefined;
  for (const v of versions) {
    if (v.outcome !== "accepted") continue;
    if (winner === undefined || v.hlc > winner.hlc) winner = v;
  }

  const labelled = versions.map<ArchivedVersion>((v) => ({
    ...v,
    role: v === winner ? "live" : v.outcome === "accepted" ? "superseded" : "refused",
  }));

  return {
    versions: labelled,
    live: labelled.find((v) => v.role === "live"),
    truncated: versions.length >= clampLimit(limit),
  };
}

/**
 * JSON with every object's keys sorted, at every depth.
 *
 * `JSON.stringify` preserves insertion order, so two identical records that
 * were built by different code paths stringify differently — and a diff built
 * on that would report every field as changed on a version that is byte-equal.
 * A diff that cries wolf is a diff nobody reads before pressing Restore.
 */
export function stableJson(value: unknown, indent = 0): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (isRecord(v)) {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v).sort()) out[key] = sort(v[key]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value), null, indent) ?? "undefined";
}

export interface FieldDiff {
  key: string;
  /** Rendered value in the live version; undefined when the key is absent. */
  live: string | undefined;
  /** Rendered value in this version; undefined when the key is absent. */
  version: string | undefined;
  changed: boolean;
}

export interface BodyDiff {
  /** True when both sides are JSON objects, so the rows are per-field. */
  byField: boolean;
  fields: FieldDiff[];
}

/**
 * Compare a losing version against the live one, top level only.
 *
 * Top level is a deliberate stopping point: a deeper walk would have to know
 * the record's schema, and the registry owns that. Nested values are compared
 * whole, via `stableJson`, so `changed` is never wrong — only coarse. A body
 * that is not an object (a bare string, a number, a tombstone's null) gets one
 * row for the whole value, flagged by `byField: false`, so the caller renders
 * it as a value rather than pretending it has fields.
 */
export function diffBodies(live: unknown, version: unknown): BodyDiff {
  if (!isRecord(live) || !isRecord(version)) {
    const a = live === undefined ? undefined : stableJson(live, 2);
    const b = version === undefined ? undefined : stableJson(version, 2);
    return { byField: false, fields: [{ key: "body", live: a, version: b, changed: a !== b }] };
  }

  const keys = [...new Set([...Object.keys(live), ...Object.keys(version)])].sort();
  return {
    byField: true,
    fields: keys.map((key) => {
      const a = key in live ? stableJson(live[key]) : undefined;
      const b = key in version ? stableJson(version[key]) : undefined;
      return { key, live: a, version: b, changed: a !== b };
    }),
  };
}

/**
 * Which devices are holding tombstone GC where it is.
 *
 * Rule 4: the watermark is `min(last_pull_seq)` across NON-retired devices, so
 * a device that is never retired pins it at whatever it last pulled — forever.
 * The *number* comes from `stats.gc_watermark` and is not recomputed here,
 * because the server has a case this cannot see (no active devices at all, in
 * which case the watermark is the head). This answers only "who is sitting at
 * the bottom", which is the part a devices panel can act on.
 */
export function watermarkHolders(devices: readonly SyncDevice[]): SyncDevice[] {
  const active = devices.filter((d) => !d.retired);
  if (active.length === 0) return [];
  const low = Math.min(...active.map((d) => d.last_pull_seq));
  return active.filter((d) => d.last_pull_seq === low);
}
