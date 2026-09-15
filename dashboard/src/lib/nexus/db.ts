/**
 * Persistence, rewritten for the PWA — and the rewrite is a change of *status*
 * rather than of backend.
 *
 * In nexus this was a file on a Mac, written by a Rust command through a file
 * lock, with a localStorage branch bolted on so the UI was developable in a
 * browser. The file was the record. The browser branch was a toy.
 *
 * Here there is no file, and the toy is all that is left — so:
 *
 * > **localStorage is a cache. The server is the record.**
 *
 * That is not a stylistic framing. iOS evicts a PWA's storage after ~7 days of
 * non-use, wholesale and without warning, and the phone is the device most
 * likely to go a week unopened. So "storage is empty" is a routine event on a
 * device whose data is perfectly intact on the server, and the one thing this
 * layer must never do is let that event be read as *the user deleted
 * everything*. See `bridge.ts` for the other half; the two facts that make it
 * work live here:
 *
 * 1. **A miss is reported, not papered over.** `loadData` returns whether the
 *    cache answered. A function that silently hands back `makeDefaultData()`
 *    gives its caller no way to tell a first run from an eviction, and those
 *    two need opposite handling: one seeds the server, the other must not
 *    write a single record until it has pulled.
 *
 * 2. **A miss does not write.** nexus persisted the defaults it had just
 *    minted, which on this platform is the destructive line: caching them
 *    turns the *next* boot into a cache hit, so the device forgets it was ever
 *    recovering and offers ~90 pristine seed records as ordinary local edits —
 *    on top of whatever the user has since made of them on another device.
 *    The defaults still come back, for the screens to render; they just do not
 *    become a stored fact.
 *
 * The Tauri branch is gone entirely rather than guarded. `@tauri-apps/api` is
 * not a dependency of this app and an `isTauri()` check would imply it could
 * come back, which would mean two persistence models and one of them dead.
 */
import type { NexusData } from "./types";
import { NEW_SCHEMA_VERSION } from "./types";
import { makeDefaultData, migrateLegacy, normalize } from "./migrate";

/**
 * Unchanged from nexus, deliberately: the browser that ran the Tauri app's
 * web preview is the same origin as this PWA on a developer's machine, and a
 * new key would orphan that data for no gain. The `v3` is historical — the
 * schema inside is versioned by `schemaVersion`, which is what migrations
 * read.
 */
export const LS_KEY = "nexus-data-v3";

/**
 * The oldest `schemaVersion` whose *shape* `normalize` understands.
 *
 * This constant is a bug fix, and it is worth the paragraph. nexus routed on
 * `version >= NEW_SCHEMA_VERSION ? normalize : migrateLegacy`, which sends a
 * **schema 3** store — the immediately previous release, the one most real
 * stores are on — to `migrateLegacy`. That function is written for the legacy
 * app, where jobs and certifications were top-level `old.jobs` / `old.certs`
 * and there was no `career` block at all; handed a schema-3 store it reads
 * keys that are not there and returns empty arrays. Every job application and
 * certification, silently gone on load, and then pushed to the server as
 * tombstones by the very next sync cycle.
 *
 * It routed that way because the legacy marker was a *different key*
 * (`_schemaVersion`), so `Number(parsed.schemaVersion ?? 0)` is 0 for a truly
 * legacy store and the comparison happened to work for the only two cases that
 * existed when it was written: 0 and 4. Three appeared later, between them.
 *
 * `migrate.ts`'s own tests are unambiguous about which function owns 3 — they
 * call `normalize({ schemaVersion: 3, … })` — and `normalize` is where the
 * 3 → 4 work actually lives (lifting `habits[].completions` into records,
 * assigning task `sort` keys). So the boundary is the marker's *presence*, not
 * its distance from the current version.
 */
export const RECORDS_SCHEMA_VERSION = 3;

/** The slice of `Storage` this file needs. Injected so tests are three lines. */
export type Store = Pick<Storage, "getItem" | "setItem">;

/**
 * Whether the cache answered, and what the app should render either way.
 *
 * `hit: false` is the load-bearing field. It means "this device holds no
 * record of its own", which is true of a first run and of an evicted phone,
 * and the caller may not push anything derived from `data` until it knows
 * which. `data` is always renderable — screens read `NexusData` with non-null
 * assertions and a null here would be a crash, not a degraded mode.
 */
export interface Cached {
  data: NexusData;
  hit: boolean;
  /**
   * Set when a *present* cache could not be used: unparseable JSON, or a
   * non-object at the top. Distinct from a plain miss because it is a bug or a
   * corruption rather than a platform behaviour, and it should be visible
   * rather than indistinguishable from a fresh install.
   */
  corrupt?: boolean;
}

const storage = (): Store | null => {
  // Private-mode Safari used to throw on `localStorage` access, and an iframe
  // with a restrictive storage policy still can. A throw here would take the
  // whole app down on boot, which is a worse outcome than running without a
  // cache — every read falls through to the server.
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/**
 * Write the cache. Stamped with the current schema version, as nexus did.
 *
 * Returns whether it landed instead of throwing. A full quota or a blocked
 * store must not fail a sync cycle: the blob the engine just handed us is
 * already in memory and already on the server, so the cost of not caching it
 * is a slower next boot, and the cost of throwing is a cursor that never
 * advances and a device that re-pulls the same page forever.
 */
export function saveData(data: NexusData, store: Store | null = storage()): boolean {
  if (!store) return false;
  try {
    const stamped: NexusData = { ...data, schemaVersion: NEW_SCHEMA_VERSION };
    store.setItem(LS_KEY, JSON.stringify(stamped));
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the cache, migrating what is there.
 *
 * Async although localStorage is not, and that is not ceremony: the call sites
 * ported from nexus already `await` it, and the only realistic successor to
 * this cache — IndexedDB, which iOS evicts on the same schedule but with a
 * larger budget — is genuinely async. Making it sync now buys nothing and
 * costs a change at every caller later.
 */
export async function loadData(store: Store | null = storage()): Promise<Cached> {
  const raw = readRaw(store);

  // Nothing cached: a first run, or an eviction. This function cannot tell
  // them apart and does not try — it reports the miss and lets the bridge,
  // which can ask the server, decide. Note what is NOT here: a `saveData`.
  if (raw === null) return { data: makeDefaultData(), hit: false };

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    // Also a miss, and also not persisted over. Overwriting a cache we failed
    // to parse would destroy the only copy of anything it held that a later
    // build might have understood.
    return { data: makeDefaultData(), hit: false, corrupt: true };
  }

  const blob = parsed as Record<string, unknown>;
  const version = Number(blob["schemaVersion"] ?? 0);

  if (version >= RECORDS_SCHEMA_VERSION) {
    // 3 and 4 share a shape, so one function covers both: `normalize` fills
    // gaps from a whitelist, drops the removed `work`/`finance` keys — the one
    // place those domains actually die — performs the 3 → 4 record migrations,
    // and clamps the version. A store already on 4 comes back untouched, which
    // is what keeps a load from looking like an edit to the next diff.
    const data = normalize(blob);
    // Persisted only when the version moved. Writing on every load would be
    // harmless but noisy; writing when it moved means the next boot does not
    // redo the work. Nothing is invented either way — this is the device's own
    // data, reshaped.
    if (version < NEW_SCHEMA_VERSION) saveData(data, store);
    return { data, hit: true };
  }

  // A legacy store: `_schemaVersion` ≤ 2, so the current marker reads 0.
  const migrated = migrateLegacy(blob);
  saveData(migrated, store);
  return { data: migrated, hit: true };
}

function readRaw(store: Store | null): string | null {
  if (!store) return null;
  try {
    return store.getItem(LS_KEY);
  } catch {
    return null;
  }
}
