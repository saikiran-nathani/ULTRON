/**
 * What `lib/syncApi.ts` must not get wrong.
 *
 * The three areas here were chosen because each one fails *quietly*, and a
 * quiet failure on this particular surface is uniquely bad: the whole reason
 * the conflict archive exists is to stop "your edit vanished" being invisible.
 * A bug that makes the archive render an empty, calm, successful-looking list
 * does not fix that problem, it launders it.
 *
 * - **The encoding rule.** A record id contains percent-escapes. Put it in a
 *   path segment and the server's stack decodes it before routing, the lookup
 *   misses, and the reply is a 200 with zero versions — which the UI has no
 *   way to distinguish from a record that genuinely never conflicted. Pinned
 *   by round-tripping the id back out of the URL, and by demonstrating the
 *   single decode that a path segment would suffer.
 * - **Error handling.** An empty list and a failed fetch must take different
 *   code paths, and the two causes of a 401 must not be conflated: a dead
 *   session flips the shell to the login form, "no accounts enrolled" must
 *   not, or the user gets a login form for an instance with nothing to log in
 *   to.
 * - **Role derivation.** Which row is live. Mislabel that and the list is
 *   worse than no list.
 *
 * DOM rendering is deliberately absent — this project has no jsdom and none is
 * being added, so the components keep their logic in this module where it can
 * be held still.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onUnauthorized } from "@/lib/auth";
import {
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  HISTORY_LIMIT_MIN,
  SyncApiError,
  archiveOf,
  clampLimit,
  diffBodies,
  historyPath,
  retirePath,
  stableJson,
  syncApi,
  watermarkHolders,
  type SyncDevice,
  type SyncVersion,
} from "@/lib/syncApi";

/**
 * A real nested id, from the brief. The escapes are data: Stage 3b keys a
 * child as `encodeURIComponent(parent):encodeURIComponent(child)`, and the
 * parent id already contained colons.
 */
const NESTED = "seed%3A0001%3Aphase%3Aship:seed%3A0002%3Atask%3Abuild";

/** Fixed-width and zero-padded, matching `lib/sync/clock.ts` and `hlc.py`. */
const hlc = (millis: number, counter: number, node: string) =>
  `${String(millis).padStart(16, "0")}-${String(counter).padStart(5, "0")}-${node}`;

const T0 = 1_789_344_000_000;

/** Seven fields, per `Sync.history` in src/trainwatch/sync.py. */
function version(over: Partial<SyncVersion> = {}): SyncVersion {
  return {
    hlc: hlc(T0, 0, "dev-a"),
    deleted: false,
    body: { title: "groceries", amount: 12 },
    device_id: "dev-a",
    device_name: "MacBook-Pro",
    outcome: "accepted",
    ts: T0 / 1000,
    ...over,
  };
}

/* ── fetch harness ──────────────────────────────────────────────────────── */

const fetchMock = vi.fn();

function json(status: number, body: unknown, statusText = ""): Response {
  return new Response(JSON.stringify(body), {
    status,
    statusText,
    headers: { "Content-Type": "application/json" },
  });
}

function lastCall(): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls.at(-1) as [unknown, RequestInit | undefined] | undefined;
  if (!call) throw new Error("fetch was never called");
  return { url: String(call[0]), init: call[1] ?? {} };
}

function headerOf(init: RequestInit, name: string): string | undefined {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h[name];
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── 1. the encoding rule ───────────────────────────────────────────────── */

describe("historyPath — a record id is opaque data", () => {
  it("keeps the id out of the path and in an encoded query parameter", () => {
    const path = historyPath("nexus.tasks", NESTED);
    const [route, query] = path.split("?");

    expect(route).toBe("/api/sync/history");
    // No part of the id may reach the path, under any escaping.
    expect(route).not.toContain("seed");
    expect(query).toBeTruthy();
  });

  it("round-trips the id through the URL byte for byte", () => {
    // The server's own parse: a query parameter is decoded exactly once, from
    // the query string, after routing.
    const parsed = new URL(historyPath("nexus.tasks", NESTED), "http://box:8730");
    expect(parsed.searchParams.get("id")).toBe(NESTED);
    expect(parsed.searchParams.get("collection")).toBe("nexus.tasks");
  });

  it("escapes the percent of an existing escape", () => {
    const path = historyPath("nexus.tasks", NESTED);
    // `%3A` in the id must arrive as `%253A` on the wire. This is the whole
    // rule in one assertion.
    expect(path).toContain("%253A");
    // ...and the raw id must never appear verbatim, which is what a template
    // literal at the call site would produce.
    expect(path).not.toContain(NESTED);
  });

  it("documents the decode that makes a path segment silently wrong", () => {
    // A path segment is decoded before routing, so this is what the server
    // would look the record up by — a different id, which exists nowhere. The
    // reply would be a 200 with an empty version list: "no conflict history"
    // rather than "your URL was mangled".
    expect(decodeURIComponent(NESTED)).toBe("seed:0001:phase:ship:seed:0002:task:build");
    expect(decodeURIComponent(NESTED)).not.toBe(NESTED);
  });

  it("encodes a collection name containing separators", () => {
    const parsed = new URL(historyPath("odd/coll ection&x=1", "r1"), "http://box");
    expect(parsed.searchParams.get("collection")).toBe("odd/coll ection&x=1");
    expect(parsed.searchParams.get("id")).toBe("r1");
  });

  it("clamps limit into the range the route declares", () => {
    expect(clampLimit(0)).toBe(HISTORY_LIMIT_MIN);
    expect(clampLimit(-5)).toBe(HISTORY_LIMIT_MIN);
    expect(clampLimit(5000)).toBe(HISTORY_LIMIT_MAX);
    expect(clampLimit(50.9)).toBe(50);
    expect(clampLimit(Number.NaN)).toBe(HISTORY_LIMIT_DEFAULT);

    // Out of range would be a 422 caused entirely by us, shown to the user as
    // though the archive were broken.
    expect(new URL(historyPath("c", "r", 5000), "http://box").searchParams.get("limit")).toBe("200");
    expect(new URL(historyPath("c", "r"), "http://box").searchParams.get("limit")).toBe("50");
  });
});

describe("retirePath", () => {
  it("percent-encodes the device id so it cannot reshape the path", () => {
    expect(retirePath("iPad Pro/2")).toBe("/api/sync/devices/iPad%20Pro%2F2/retire");
    expect(retirePath("dev-a")).toBe("/api/sync/devices/dev-a/retire");
  });
});

/* ── 2. the calls ───────────────────────────────────────────────────────── */

describe("syncApi requests", () => {
  it("reads the archive with the encoded path and no method", async () => {
    fetchMock.mockResolvedValue(json(200, { collection: "c", id: NESTED, versions: [] }));
    await syncApi.history("c", NESTED, 10);

    const { url, init } = lastCall();
    expect(new URL(url, "http://box").searchParams.get("id")).toBe(NESTED);
    expect(init.method).toBeUndefined();
    expect(headerOf(init, "Accept")).toBe("application/json");
  });

  it("treats an empty version list as a successful answer, not an error", async () => {
    fetchMock.mockResolvedValue(json(200, { collection: "c", id: "r", versions: [] }));
    // The distinction this module exists to preserve: "only ever one version"
    // resolves, "could not load the history" rejects. A caller that cannot
    // tell them apart renders a failure as calm reassurance.
    await expect(syncApi.history("c", "r")).resolves.toEqual({
      collection: "c",
      id: "r",
      versions: [],
    });
  });

  it("sends the seven-field rows through unchanged", async () => {
    const row = version({ device_name: "iPad", outcome: "rejected" });
    fetchMock.mockResolvedValue(json(200, { collection: "c", id: "r", versions: [row] }));

    const got = await syncApi.history("c", "r");
    const first = got.versions[0];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {}).sort()).toEqual([
      "body",
      "deleted",
      "device_id",
      "device_name",
      "hlc",
      "outcome",
      "ts",
    ]);
  });

  it("retires with the write headers a mutating request needs", async () => {
    fetchMock.mockResolvedValue(json(200, { retired: true, device: "dev-b" }));
    await expect(syncApi.retire("dev-b")).resolves.toEqual({ retired: true, device: "dev-b" });

    const { url, init } = lastCall();
    expect(url).toBe("/api/sync/devices/dev-b/retire");
    expect(init.method).toBe("POST");
    // ADR-0003 C3, from `writeHeaders()` rather than spelled out here.
    expect(headerOf(init, "X-Trainwatch")).toBe("1");
  });

  it("reads device state from /state", async () => {
    fetchMock.mockResolvedValue(json(200, { devices: [], stats: {} }));
    await syncApi.state();
    expect(lastCall().url).toBe("/api/sync/state");
  });
});

/* ── 3. refusals ────────────────────────────────────────────────────────── */

describe("error handling", () => {
  it("surfaces a plain HTTPException detail", async () => {
    fetchMock.mockResolvedValue(json(422, { detail: "collection must be a non-empty string" }));
    const err = await syncApi.history("", "r").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SyncApiError);
    expect((err as SyncApiError).status).toBe(422);
    expect((err as SyncApiError).message).toContain("non-empty string");
  });

  it("flattens FastAPI's validation array into something readable", async () => {
    fetchMock.mockResolvedValue(
      json(422, {
        detail: [
          { type: "less_than_equal", loc: ["query", "limit"], msg: "Input should be <= 200" },
        ],
      }),
    );
    const err = (await syncApi.history("c", "r").catch((e: unknown) => e)) as SyncApiError;
    // Raw, this renders as `[object Object]` or a JSON blob — indistinguishable
    // from a crash.
    expect(err.message).toBe("Input should be <= 200");
  });

  it("falls back to the status when the body is not JSON", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>502 Bad Gateway</html>", { status: 502, statusText: "Bad Gateway" }),
    );
    const err = (await syncApi.state().catch((e: unknown) => e)) as SyncApiError;

    expect(err).toBeInstanceOf(SyncApiError);
    expect(err.status).toBe(502);
    // Not a TypeError about an unexpected token in JSON.
    expect(err.message).toContain("502");
  });

  it("reports a dead session so the shell can flip to the login form", async () => {
    let fired = 0;
    const off = onUnauthorized(() => (fired += 1));
    try {
      fetchMock.mockResolvedValue(
        json(401, { error: "authentication required", why: "No valid session or token." }),
      );
      const err = (await syncApi.state().catch((e: unknown) => e)) as SyncApiError;

      expect(fired).toBe(1);
      expect(err.needsAccount).toBe(false);
      expect(err.why).toBe("No valid session or token.");
    } finally {
      off();
    }
  });

  it("does NOT report 'sync needs an account' as unauthorized", async () => {
    let fired = 0;
    const off = onUnauthorized(() => (fired += 1));
    try {
      fetchMock.mockResolvedValue(
        json(401, {
          detail: {
            error: "sync needs an account",
            why: "Records are stored per owner.",
            fix: "trainwatch user add <name>",
          },
        }),
      );
      const err = (await syncApi.state().catch((e: unknown) => e)) as SyncApiError;

      // Flipping the shell here would show a login form on a box with no
      // accounts — a door with no key, in front of a room that is not locked.
      expect(fired).toBe(0);
      expect(err.needsAccount).toBe(true);
      expect(err.fix).toBe("trainwatch user add <name>");
    } finally {
      off();
    }
  });

  it("names the stale-tab cause of a 403 rather than passing the status through", async () => {
    fetchMock.mockResolvedValue(json(403, { error: "CSRF token missing or mismatched" }));
    const err = (await syncApi.retire("dev-a").catch((e: unknown) => e)) as SyncApiError;

    expect(err.message).toMatch(/csrf/i);
    expect(err.why).toMatch(/reload/i);
  });

  it("explains a 421 as the rebinding guard, not as a broken request", async () => {
    fetchMock.mockResolvedValue(json(421, {}, "Misdirected Request"));
    const err = (await syncApi.state().catch((e: unknown) => e)) as SyncApiError;

    expect(err.message).toMatch(/hostname/i);
    expect(err.why).toContain("TRAINWATCH_ALLOWED_HOSTS");
  });

  it("does not flip the shell on a 403 for a machine token", async () => {
    let fired = 0;
    const off = onUnauthorized(() => (fired += 1));
    try {
      fetchMock.mockResolvedValue(
        json(403, { detail: { error: "sync is for human identities", why: "A machine token." } }),
      );
      const err = (await syncApi.state().catch((e: unknown) => e)) as SyncApiError;
      expect(fired).toBe(0);
      expect(err.message).toBe("sync is for human identities");
    } finally {
      off();
    }
  });
});

/* ── 4. which row is live ───────────────────────────────────────────────── */

describe("archiveOf", () => {
  it("labels the highest-HLC accepted row live, regardless of server order", () => {
    const older = version({ hlc: hlc(T0, 0, "dev-a"), body: { v: 1 } });
    const newer = version({ hlc: hlc(T0 + 500, 0, "dev-b"), device_name: "iPad", body: { v: 2 } });
    // Handed back out of order on purpose: the role must come from the clock,
    // not from the position in the array.
    const { versions, live } = archiveOf([older, newer]);

    expect(live?.hlc).toBe(newer.hlc);
    expect(versions.map((v) => v.role)).toEqual(["superseded", "live"]);
  });

  it("separates 'was overwritten' from 'never arrived'", () => {
    const winner = version({ hlc: hlc(T0 + 900, 0, "dev-b"), device_name: "iPad" });
    const stored = version({ hlc: hlc(T0 + 400, 0, "dev-a") });
    const refused = version({ hlc: hlc(T0, 0, "dev-c"), outcome: "rejected", device_name: "iPhone" });

    const { versions } = archiveOf([winner, stored, refused]);
    expect(versions.map((v) => v.role)).toEqual(["live", "superseded", "refused"]);
    // `accepted` means stored and delivered; `rejected` means the push never
    // landed. Blurring them gives the user the wrong fix.
    expect(versions.filter((v) => v.role === "live")).toHaveLength(1);
  });

  it("preserves the server's newest-first order", () => {
    const rows = [
      version({ hlc: hlc(T0 + 300, 0, "dev-a") }),
      version({ hlc: hlc(T0 + 200, 0, "dev-a") }),
      version({ hlc: hlc(T0 + 100, 0, "dev-a") }),
    ];
    expect(archiveOf(rows).versions.map((v) => v.hlc)).toEqual(rows.map((r) => r.hlc));
  });

  it("admits when no live version is inside the window", () => {
    // `ORDER BY id DESC LIMIT 1` with a rejection logged after the accepted
    // write of the same batch returns exactly this. Calling the newest row the
    // winner would be a lie with a tick next to it.
    const { live, truncated } = archiveOf([version({ outcome: "rejected" })], 1);
    expect(live).toBeUndefined();
    expect(truncated).toBe(true);
  });

  it("flags a full window as possibly hiding older versions", () => {
    const rows = [version(), version({ hlc: hlc(T0 + 1, 0, "dev-a") })];
    expect(archiveOf(rows, 2).truncated).toBe(true);
    expect(archiveOf(rows, 3).truncated).toBe(false);
  });

  it("handles an empty archive without inventing a winner", () => {
    const { versions, live, truncated } = archiveOf([]);
    expect(versions).toEqual([]);
    expect(live).toBeUndefined();
    expect(truncated).toBe(false);
  });

  it("treats a live tombstone as live", () => {
    const tomb = version({ hlc: hlc(T0 + 800, 0, "dev-b"), deleted: true, body: null });
    const { live } = archiveOf([tomb, version()]);
    expect(live?.deleted).toBe(true);
  });
});

/* ── 5. the diff a restore is decided on ────────────────────────────────── */

describe("stableJson", () => {
  it("is insensitive to key order, at every depth", () => {
    const a = { z: 1, a: { n: 2, m: [{ q: 1, p: 2 }] } };
    const b = { a: { m: [{ p: 2, q: 1 }], n: 2 }, z: 1 };
    expect(stableJson(a)).toBe(stableJson(b));
  });

  it("does not reorder arrays, which are ordered data", () => {
    expect(stableJson([2, 1])).not.toBe(stableJson([1, 2]));
  });
});

describe("diffBodies", () => {
  it("reports added, removed, changed and identical fields", () => {
    const diff = diffBodies(
      { title: "groceries", amount: 12, note: "gone" },
      { title: "groceries", amount: 9, tag: "new" },
    );
    expect(diff.byField).toBe(true);

    const by = new Map(diff.fields.map((f) => [f.key, f]));
    expect(by.get("title")?.changed).toBe(false);
    expect(by.get("amount")?.changed).toBe(true);
    expect(by.get("note")?.version).toBeUndefined();
    expect(by.get("tag")?.live).toBeUndefined();
    expect([...by.keys()]).toEqual(["amount", "note", "tag", "title"]);
  });

  it("does not cry wolf over key order", () => {
    const diff = diffBodies({ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 });
    expect(diff.fields.every((f) => !f.changed)).toBe(true);
  });

  it("falls back to whole-value comparison for a non-object body", () => {
    const diff = diffBodies("live text", "old text");
    expect(diff.byField).toBe(false);
    expect(diff.fields).toHaveLength(1);
    const only = diff.fields[0];
    expect(only?.changed).toBe(true);
    expect(only?.key).toBe("body");
  });

  it("handles a tombstone's null body", () => {
    const diff = diffBodies({ title: "x" }, null);
    expect(diff.byField).toBe(false);
    expect(diff.fields[0]?.version).toBe("null");
    expect(diff.fields[0]?.changed).toBe(true);
  });
});

/* ── 6. who is pinning tombstone GC ────────────────────────────────────── */

describe("watermarkHolders", () => {
  const device = (over: Partial<SyncDevice>): SyncDevice => ({
    id: "d",
    name: "d",
    platform: "ios",
    last_pull_seq: 100,
    first_seen: 0,
    last_seen: 0,
    retired: false,
    ...over,
  });

  it("names the non-retired devices sitting at the bottom", () => {
    const holders = watermarkHolders([
      device({ id: "a", last_pull_seq: 40 }),
      device({ id: "b", last_pull_seq: 40 }),
      device({ id: "c", last_pull_seq: 900 }),
    ]);
    expect(holders.map((d) => d.id)).toEqual(["a", "b"]);
  });

  it("ignores retired devices — that is the whole point of retiring one", () => {
    const holders = watermarkHolders([
      device({ id: "old", last_pull_seq: 0, retired: true }),
      device({ id: "live", last_pull_seq: 500 }),
    ]);
    expect(holders.map((d) => d.id)).toEqual(["live"]);
  });

  it("returns nothing when every device is retired", () => {
    // The server's watermark is the head in this case, which this helper
    // cannot see — so it must not guess.
    expect(watermarkHolders([device({ retired: true })])).toEqual([]);
    expect(watermarkHolders([])).toEqual([]);
  });
});
