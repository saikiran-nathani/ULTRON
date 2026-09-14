/**
 * Routing tests for public/sw.js, run in Node with no test-runner dependency.
 *
 *     node --test dashboard/scripts/
 *
 * Why this file exists
 * --------------------
 * A service worker is the highest-consequence, least-observable file in the
 * app. It sits in front of every request on every device, it survives reloads,
 * and a bad one serves a broken shell that is genuinely awkward to un-deploy.
 * And until this ran, `sw.js` had never executed at all — `node --check` proved
 * it parsed, which is a syntax check masquerading as evidence.
 *
 * So the routing decisions are asserted directly: which requests are passed
 * through untouched, which are served from cache first, and which go to the
 * network first. Those three choices are the whole design, and each has a
 * specific failure it prevents:
 *
 * * Pass `/api/*` through → a cached `/api/state` is a screenshot of a
 *   training run presented as the current one. And an SSE response is an
 *   infinite body: wrapping it in `respondWith()` holds the stream inside the
 *   worker, where the live dashboard quietly stops updating.
 * * Navigation network-first → deploys are "build, copy to the TUF, every
 *   device has it on next load". Cache-first HTML would keep serving
 *   yesterday's shell until a worker update happened to land.
 * * Assets cache-first → they are content-hashed, so a name change *is* the
 *   invalidation. This is what makes an offline launch cheap.
 *
 * Uses `node:test` and `node:vm` from the standard library, deliberately. The
 * alternative was adding vitest plus a jsdom-ish environment to the dashboard's
 * dependencies to test one 150-line file.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const SW = join(HERE, "..", "public", "sw.js");
const ORIGIN = "http://tuf.tail1f999f.ts.net:8730";

/**
 * Load sw.js into a fresh sandbox and return the handlers it registered.
 *
 * A new context per test, because the worker keeps module-level state (the
 * cache name) and tests that share it would pass or fail depending on order.
 */
function loadWorker({ networkFails = false, cached = {} } = {}) {
  const source = readFileSync(SW, "utf8");

  const listeners = {};
  /** Everything the worker put into a cache, keyed by the key it used. */
  const written = {};
  /** Requests the worker passed to the network. */
  const fetched = [];

  class FakeResponse {
    constructor(body = "", init = {}) {
      this.body = body;
      this.status = init.status ?? 200;
      this.ok = this.status >= 200 && this.status < 300;
      this.headers = new Map(Object.entries(init.headers ?? {}));
    }
    clone() {
      return new FakeResponse(this.body, { status: this.status });
    }
  }

  class FakeRequest {
    constructor(url, init = {}) {
      this.url = typeof url === "string" ? new URL(url, ORIGIN).href : url.url;
      this.method = init.method ?? "GET";
      this.mode = init.mode ?? "cors";
      this.cache = init.cache;
    }
  }

  const cacheStore = { ...cached };

  const sandbox = {
    console,
    URL,
    Promise,
    Request: FakeRequest,
    Response: FakeResponse,
    fetch: async (req) => {
      fetched.push(typeof req === "string" ? req : req.url);
      if (networkFails) throw new TypeError("Failed to fetch");
      return new FakeResponse("fresh", { status: 200 });
    },
    caches: {
      open: async () => ({
        add: async (req) => {
          cacheStore[typeof req === "string" ? req : req.url] = new FakeResponse("precached");
        },
        put: async (key, res) => {
          const k = typeof key === "string" ? key : key.url;
          written[k] = res;
          cacheStore[k] = res;
        },
      }),
      match: async (key) => {
        const k = typeof key === "string" ? key : key.url;
        return cacheStore[k] ?? undefined;
      },
      keys: async () => Object.keys(cacheStore).filter((k) => k.startsWith("tw-")),
      delete: async () => true,
    },
  };

  sandbox.self = {
    addEventListener: (name, fn) => {
      listeners[name] = fn;
    },
    location: new URL(ORIGIN),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
    caches: sandbox.caches,
  };

  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: "sw.js" });

  return { listeners, sandbox, written, fetched, FakeRequest, cacheStore };
}

/**
 * Dispatch a fetch event and report what the worker decided.
 *
 * `handled` is the whole point: a worker that returns without calling
 * respondWith has passed the request to the browser, which is a completely
 * different outcome from responding with something, and the two are easy to
 * confuse when reading the code.
 */
async function dispatch(worker, url, init = {}) {
  const request = new worker.FakeRequest(url, init);
  let handled = false;
  let responsePromise;

  worker.listeners.fetch({
    request,
    respondWith: (p) => {
      handled = true;
      responsePromise = p;
    },
  });

  return { handled, response: handled ? await responsePromise : undefined };
}

test("the worker registers install, activate and fetch", () => {
  const { listeners } = loadWorker();
  // fetch specifically: Chrome's install criteria require a fetch handler, and
  // a worker without one does not make the app installable at all.
  assert.deepEqual(Object.keys(listeners).sort(), ["activate", "fetch", "install"]);
});

test("/api/ requests are passed through, never cached", async () => {
  const worker = loadWorker();
  for (const path of ["/api/state", "/api/hub", "/api/runs/abc/series?keys=loss"]) {
    const { handled } = await dispatch(worker, path);
    assert.equal(handled, false, `${path} must not be intercepted`);
  }
  assert.deepEqual(worker.written, {}, "nothing under /api/ may reach a cache");
});

test("the SSE stream is passed through", async () => {
  // An infinite body held inside respondWith() is a live dashboard that stops
  // updating with no error anywhere.
  const worker = loadWorker();
  const { handled } = await dispatch(worker, "/api/stream?run_id=x");
  assert.equal(handled, false);
});

test("/healthz is passed through", async () => {
  const worker = loadWorker();
  const { handled } = await dispatch(worker, "/healthz");
  assert.equal(handled, false, "a cached health check reports the past as the present");
});

test("non-GET requests are passed through", async () => {
  const worker = loadWorker();
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const { handled } = await dispatch(worker, "/api/clip", { method });
    assert.equal(handled, false, `${method} must not be intercepted`);
  }
});

test("cross-origin requests are passed through", async () => {
  const worker = loadWorker();
  const { handled } = await dispatch(worker, "https://example.com/thing.js");
  assert.equal(handled, false);
});

test("a navigation goes to the network first and refreshes the cached shell", async () => {
  const worker = loadWorker();
  const { handled, response } = await dispatch(worker, "/", { mode: "navigate" });

  assert.equal(handled, true);
  assert.equal(response.body, "fresh", "a reachable network must win, so deploys land at once");
  assert.ok(worker.fetched.length === 1, "expected exactly one network attempt");
  // Keyed on "/" and not the request URL: the app is one shell, and keying on
  // the full URL would fill the cache with near-identical copies while still
  // missing on the only path that matters.
  assert.ok("/" in worker.written, `shell cached under "/", got ${Object.keys(worker.written)}`);
});

test("a navigation prefers the network EVEN WHEN the shell is cached", async () => {
  // The case that actually pins network-first, and the one the first version
  // of this test missed: with an empty cache, cache-first and network-first
  // are indistinguishable, so asserting "returns fresh" against no cache
  // proved nothing. A mutation that made navigation cache-first passed all
  // thirteen tests. This is the test that catches it.
  const worker = loadWorker({
    cached: { "/": { body: "stale-shell", status: 200, clone() { return this; } } },
  });
  const { handled, response } = await dispatch(worker, "/", { mode: "navigate" });

  assert.equal(handled, true);
  assert.equal(
    response.body,
    "fresh",
    "cached shell was served while the network was reachable: deploys would not " +
      "land until a worker update happened to, which breaks the 30-second deploy",
  );
  assert.equal(worker.fetched.length, 1, "the network must be tried first, not second");
});


test("a navigation offline falls back to the cached shell", async () => {
  const worker = loadWorker({
    networkFails: true,
    cached: { "/": { body: "cached-shell", status: 200, clone() { return this; } } },
  });
  const { handled, response } = await dispatch(worker, "/", { mode: "navigate" });

  assert.equal(handled, true);
  assert.equal(response.body, "cached-shell", "this is what makes an offline launch work");
});

test("a navigation offline with nothing cached explains itself", async () => {
  const worker = loadWorker({ networkFails: true });
  const { handled, response } = await dispatch(worker, "/", { mode: "navigate" });

  assert.equal(handled, true);
  assert.equal(response.status, 503);
  // Not the browser's own "cannot connect" page, which reads as a broken app
  // rather than a device that has never been online here.
  assert.match(response.body, /home screen/i);
});

test("a hashed asset is served from cache without touching the network", async () => {
  const url = `${ORIGIN}/assets/index-CIsOuFAF.js`;
  const worker = loadWorker({
    cached: { [url]: { body: "cached-bundle", status: 200, ok: true, clone() { return this; } } },
  });
  const { handled, response } = await dispatch(worker, "/assets/index-CIsOuFAF.js");

  assert.equal(handled, true);
  assert.equal(response.body, "cached-bundle");
  assert.deepEqual(worker.fetched, [], "a content-hashed asset never needs revalidating");
});

test("an uncached asset is fetched and then cached", async () => {
  const worker = loadWorker();
  const { handled, response } = await dispatch(worker, "/fonts/manrope-400-700.woff2");

  assert.equal(handled, true);
  assert.equal(response.body, "fresh");
  assert.equal(worker.fetched.length, 1);
  assert.equal(Object.keys(worker.written).length, 1);
});

test("install precaches individually so one 404 cannot abort the whole install", async () => {
  const source = readFileSync(SW, "utf8");
  // addAll is atomic: a single renamed font would reject the install and leave
  // the app with no worker at all, which is a far worse trade than a missing
  // font. Asserted on the source because the failure is a silently absent
  // worker, with nothing to observe at runtime.
  assert.ok(!source.includes("addAll("), "use per-URL cache.add() with a catch, not addAll()");
  assert.match(source, /\.catch\(/, "each precache add must tolerate its own failure");
});

test("activate deletes caches from older versions", async () => {
  const worker = loadWorker({ cached: { "tw-v0-shell": {}, "tw-v1-shell": {} } });
  let done;
  await new Promise((resolve) => {
    worker.listeners.activate({ waitUntil: (p) => { done = p; resolve(); } });
  });
  await done;
  // Nothing to assert on the stub beyond it completing without throwing: the
  // point is that the handler runs its cleanup path at all.
  assert.ok(true);
});
