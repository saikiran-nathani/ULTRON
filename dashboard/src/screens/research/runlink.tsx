import { HttpError } from "@/lib/api";
/**
 * `Experiment.runId`, resolved — and the three different facts that a naive
 * version of this would flatten into one.
 *
 * `types.ts` states what the field is for:
 *
 * > `runId` is the reason this domain exists in *this* app rather than in a
 * > notebook: it names a trainwatch run, so an experiment is joined to the loss
 * > curve, the GPU trace and the checkpoint that came out of it. Two apps merged
 * > into one is otherwise just two apps sharing a URL.
 *
 * And what it is not:
 *
 * > It is a plain string, not a foreign key into the synced blob: runs live in
 * > the hub's own tables on the server, not in NexusData, so the reconciler
 * > cannot check it and must not pretend to.
 *
 * So resolving it is a question for the network, and a network gives three
 * answers, not two:
 *
 * - **`none`** — the field is empty. Not an error, not a warning, not a
 *   degraded state: most experiments are not training runs, and `types.ts`
 *   documents `""` as the normal value for one that was not. Rendering this
 *   the same as a broken link would put a permanent warning on correct data.
 * - **`linked`** — the hub knows the run. The row can show the status, the
 *   step count and how long it ran.
 * - **`missing`** — the hub was asked and said 404. The id names nothing: a
 *   run deleted, a database rebuilt, or a typo. This is a real problem with
 *   real data and it is worth saying out loud.
 * - **`unreachable`** — we could not ask. Absence of evidence, and the one
 *   answer a lazy implementation always gets wrong, because "the fetch failed"
 *   and "the run is gone" arrive at the same `catch`.
 * - **`checking`** — the question is still open. Distinct from `unreachable`
 *   so a slow link does not flash a false verdict on the way to the true one,
 *   and it covers both "asked, no answer yet" and "the stream has not
 *   finished connecting". See `HubReach` below: the first version of this
 *   collapsed the second case into `unreachable` and therefore announced, on
 *   every first mount, that a hub answering 200 could not be reached.
 *
 * Why the live run list is not enough on its own
 * ----------------------------------------------
 * `useLiveState()` hands over `state.runs`, and it is tempting to call
 * anything outside that list missing. It is also wrong:
 * `src/trainwatch/server/app.py` builds the snapshot with
 * `"runs": store.runs(limit=25)`. The list is the **25 most recent runs**, so
 * an experiment from two months ago resolves to "missing" for the sole reason
 * that twenty-six runs have happened since — the exact conflation this project
 * exists to remove, and one that gets *worse* the more you use the app.
 *
 * So the live list is a fast path, and `GET /api/runs/{id}` (which 404s for an
 * unknown id) is the authoritative one, asked only for ids the list did not
 * already answer. That fetch goes through `api.ts`'s own `getJSON`, not a bare
 * `fetch`, so a dead session still reports 401 centrally and flips the shell
 * to the login form.
 *
 * Pure; no JSX (`.tsx` only because this directory's brief allows that
 * extension and no other). The hook that does the asking is `useRunLinks.tsx`.
 */
import type { Experiment, ReadingItem } from "@/lib/nexus/types";
import type { Run } from "@/lib/api";

/** What one authoritative ask returned. */
export type Probe =
  | { kind: "run"; run: Run }
  | { kind: "absent" }
  | { kind: "error"; detail: string };

export type RunLink =
  | { state: "none" }
  | { state: "linked"; runId: string; run: Run }
  | { state: "missing"; runId: string }
  | { state: "checking"; runId: string }
  | { state: "unreachable"; runId: string; detail: string };

export type LinkState = RunLink["state"];

/**
 * The id as the hub would see it.
 *
 * Trimmed because a pasted run id routinely carries a trailing newline, and
 * `" abc "` must not be a different link from `"abc"` — nor must `"   "` be a
 * link at all. `""` after trimming is `none`.
 */
export const normaliseRunId = (raw: string): string => raw.trim();

/**
 * An error from `getJSON`, turned into a verdict.
 *
 * `getJSON` throws `new Error(\`${status} ${statusText} — ${path}\`)` for any
 * non-ok response and lets fetch's own `TypeError` through for a transport
 * failure, so the status is recoverable only from the message. That is
 * genuinely fragile and the right fix is a `status` field on the thrown error
 * in `lib/api.ts` — out of scope here, so the parse is narrow (a leading
 * three-digit group, nothing else) and anything it does not recognise falls to
 * `unreachable`, which is the safe direction: claiming we could not ask is
 * recoverable, claiming a run is gone is not.
 *
 * A non-404 HTTP status is `error` rather than `absent` on purpose. A 500 or a
 * 502 means the hub is there and broken, which tells you nothing about whether
 * the run exists.
 */
export function classifyProbeError(err: unknown): Probe {
  // `HttpError.status` is read as a field. This used to parse the status back
  // out of the message with `/^(\d{3})\b/` — a contract nobody had declared,
  // which the next person to reword that message would have broken silently,
  // turning every 404 into "we could not ask". The regex remains as a fallback
  // for anything that throws a plain Error, because guessing "unreachable" is
  // the safe direction: it says less than it knows rather than more.
  const status =
    err instanceof HttpError
      ? err.status
      : Number(/^(\d{3})\b/.exec(err instanceof Error ? err.message : String(err))?.[1]);
  if (status === 404) return { kind: "absent" };
  if (Number.isFinite(status)) return { kind: "error", detail: `the hub answered ${status}` };
  return { kind: "error", detail: "the hub could not be reached" };
}

/**
 * What we know about our ability to ask the hub anything at all.
 *
 * Three values and not a boolean, and the third one is the whole reason:
 *
 * - `asking` — the stream is still connecting and no snapshot has arrived.
 *   Nobody has finished asking, so there is nothing to conclude. `api.ts`
 *   guarantees this resolves — `connection` moves `connecting → live` or
 *   `connecting → offline` and deliberately does not sit here — which is what
 *   makes a spinner honest in this state and only in this state.
 * - `reachable` — a snapshot arrived. New ids can be asked about.
 * - `unreachable` — the stream reported offline. We cannot ask.
 *
 * A boolean forced `asking` to be spelled as one of the other two, and the
 * choice was `unreachable`: on first mount the screen asserted that the hub
 * could not be reached while the request to reach it was in flight. That is
 * the same mistake as reading a failed fetch as a deleted run — claiming a
 * verdict where there is only a pending question — and it fired on every
 * single mount, including against a hub that was answering 200.
 *
 * `unreachable` is also deliberately reachable *with* a populated `runs` list:
 * a snapshot that arrived and then a stream that dropped means the runs we
 * already saw are still known facts, while nothing new can be resolved.
 */
export type HubReach = "asking" | "reachable" | "unreachable";

export interface RunLinkContext {
  /** The live snapshot's run list — the 25 most recent. A fast path only. */
  runs: readonly Run[];
  /** Whether the hub can be asked. See `HubReach`. */
  hub: HubReach;
  /** Authoritative answers, keyed by normalised run id. */
  probes: ReadonlyMap<string, Probe>;
}

/** One experiment's link, as a fact rather than a guess. */
export function resolveRunLink(rawId: string, ctx: RunLinkContext): RunLink {
  const runId = normaliseRunId(rawId);
  if (runId === "") return { state: "none" };

  const live = ctx.runs.find((r) => r.id === runId);
  if (live) return { state: "linked", runId, run: live };

  const probe = ctx.probes.get(runId);
  if (probe?.kind === "run") return { state: "linked", runId, run: probe.run };
  if (probe?.kind === "absent") return { state: "missing", runId };
  if (probe?.kind === "error") return { state: "unreachable", runId, detail: probe.detail };

  // No probe yet. Only a hub we have *established* is unreachable earns that
  // verdict; `asking` and `reachable` are both open questions and read as
  // `checking`. Collapsing `asking` into `unreachable` is what made the
  // screen assert failure on every first mount.
  return ctx.hub === "unreachable"
    ? { state: "unreachable", runId, detail: "the hub could not be reached" }
    : { state: "checking", runId };
}

/**
 * The distinct run ids that still need an authoritative ask.
 *
 * Deduped, because five experiments from one sweep legitimately share a run
 * id and five identical requests would be five round-trips on a cellular link;
 * and filtered against the live list, because a run in the recent 25 is
 * already resolved and asking again would be a request per screen open for no
 * new information.
 */
export function unresolvedRunIds(
  experiments: readonly Pick<Experiment, "runId">[],
  runs: readonly Run[],
): string[] {
  const live = new Set(runs.map((r) => r.id));
  const out = new Set<string>();
  for (const e of experiments) {
    const id = normaliseRunId(e.runId);
    if (id !== "" && !live.has(id)) out.add(id);
  }
  // Sorted so the request order is deterministic — easier to read in a network
  // log, and it keeps the tests from depending on Set insertion order.
  return [...out].sort();
}

/* ── ordering ──────────────────────────────────────────────────────────── */

/**
 * Ascending id, which here is also newest-last creation order.
 *
 * Per-record sync rebuilds arrays in id order, so the array's own order is
 * whatever the last pull produced and is not something a screen may read.
 * `uid()` is a base36 `Date.now()` prefix (fixed-width until 2059) followed by
 * randomness, so ascending id is creation order for anything a person made —
 * and it is a *total* order, which `started` is not: `Experiment.started` is
 * `ISODate | null`, and a planned experiment has no date at all.
 */
export function byId<T extends { id: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/* ── tallies ───────────────────────────────────────────────────────────── */

export interface LinkTally {
  total: number;
  linked: number;
  none: number;
  missing: number;
  checking: number;
  unreachable: number;
}

export function linkTally(links: readonly RunLink[]): LinkTally {
  const t: LinkTally = {
    total: links.length,
    linked: 0,
    none: 0,
    missing: 0,
    checking: 0,
    unreachable: 0,
  };
  for (const l of links) t[l.state]++;
  return t;
}

/** Experiment counts by status, for the header band. */
export function statusTally(
  experiments: readonly Pick<Experiment, "status">[],
): Record<Experiment["status"], number> {
  const t = { planned: 0, running: 0, done: 0, abandoned: 0 };
  for (const e of experiments) t[e.status]++;
  return t;
}

/**
 * A `done` experiment with an empty `result` — the record that exists but does
 * not say anything.
 *
 * `result` is documented as "What actually happened. The point of the record."
 * An experiment marked done with nothing written in it is the notebook failure
 * this domain is meant to replace, so it is counted and shown rather than
 * rendered as a blank line.
 */
export const isUnwritten = (e: Pick<Experiment, "status" | "result">): boolean =>
  e.status === "done" && e.result.trim() === "";

/* ── the reading list, which is the paper list ─────────────────────────── */

/**
 * Papers first, then everything else, each block by id.
 *
 * `READING_TYPES` gained `"Paper"` for this screen, and the reading list is
 * the paper list — but it is one list, deliberately (`constants.ts`: "two
 * lists would mean deciding, every time, which of them a thing belongs in").
 * So the whole list surfaces here with papers on top, rather than being
 * filtered down to papers and leaving the rest with nowhere to live now that
 * Journal is not a screen.
 */
export function orderReading<T extends Pick<ReadingItem, "id" | "type">>(
  items: readonly T[],
): T[] {
  const byType = (t: string) => (t === "Paper" ? 0 : 1);
  return [...items].sort(
    (a, b) => byType(a.type) - byType(b.type) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}
