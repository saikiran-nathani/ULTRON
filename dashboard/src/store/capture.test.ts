/**
 * The capture inbox, tested against the two words the plan measures it on.
 *
 * **Nothing lost** is the reason the persistence assertions do not advance
 * timers. `update()` alone arms a 250ms debounce, and a phone killed inside
 * that window loses a capture the UI has already cleared from the box — so
 * "the record is in localStorage before any timer runs" is the actual
 * requirement, not an implementation detail. Same for filing: the target is
 * created and the fragment removed in one recipe, so a test that finds the
 * text in neither place, or in both, is finding a real data-loss bug.
 *
 * **Nothing typed twice** is why `keep` asserts that no record is created or
 * destroyed. The moment triage moves a thought between collections, a failed
 * move is a retype — so the cheap path has to stay a one-field write.
 *
 * There is no jsdom in this repo, so nothing here renders. Everything under
 * test is either pure or a store action, which is where the loss would happen
 * anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LS_KEY } from "@/lib/nexus/db";
import { JOURNAL_CATEGORIES, SORT_STEP } from "@/lib/nexus/constants";
import { makeDefaultData } from "@/lib/nexus/migrate";
import { todayStr } from "@/lib/nexus/format";
import type { Fragment, NexusData, Project } from "@/lib/nexus/types";
import { useData } from "./data";
import {
  CAPTURE_DRAFT_KEY,
  INBOX_CATEGORY,
  ageLabel,
  capture,
  clearDraft,
  encodeFileTarget,
  fileTargets,
  inboxOf,
  looksLikeUrl,
  orderInbox,
  parseCapture,
  parseFileTarget,
  readDraft,
  writeDraft,
} from "./capture";

/* ── fixtures ───────────────────────────────────────────────────────────── */

function frag(over: Partial<Fragment> & { id: string }): Fragment {
  return {
    date: "2026-09-15",
    category: INBOX_CATEGORY,
    fragment: over.id,
    type: "seed",
    recurrence: 1,
    promoted: false,
    createdAt: "2026-09-15T10:00:00.000Z",
    updatedAt: "2026-09-15T10:00:00.000Z",
    ...over,
  };
}

function project(id: string, name: string, tasks: Project["tasks"] = []): Project {
  return {
    id,
    name,
    description: "",
    directory: "",
    status: "Active",
    priority: "Medium",
    startDate: "",
    endDate: "",
    tasks,
    milestones: [],
    timeLog: [],
  };
}

/** A localStorage the tests can read back. Node has none. */
function stubStorage() {
  const map = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  });
  return map;
}

/** The blob as the store currently holds it. */
const blob = (): NexusData => {
  const d = useData.getState().data;
  if (!d) throw new Error("the test store has no blob");
  return d;
};

/** The blob as it was actually written to the cache, not as it is in memory. */
const persisted = (storage: Map<string, string>): NexusData =>
  JSON.parse(storage.get(LS_KEY) ?? "null") as NexusData;

let storage: Map<string, string>;

beforeEach(() => {
  vi.useFakeTimers();
  storage = stubStorage();
  // A clean store per test: `useData` is a module singleton, and a debounce
  // left armed by one test firing inside the next is its own small nightmare.
  useData.setState({ data: makeDefaultData(), loaded: true, cacheHit: true });
});

afterEach(() => {
  useData.getState().flush();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── the reserved category ──────────────────────────────────────────────── */

describe("INBOX_CATEGORY", () => {
  it("matches no journal category, so an untriaged capture is never filed by accident", () => {
    // The whole "is it triaged?" question is this one fact. If a real category
    // ever took this id, every capture would appear pre-filed into it and
    // triage would silently have nothing to do.
    expect(JOURNAL_CATEGORIES.map((c) => c.id)).not.toContain(INBOX_CATEGORY);
  });
});

/* ── parsing ────────────────────────────────────────────────────────────── */

describe("parseCapture", () => {
  it("refuses text with nothing in it", () => {
    expect(parseCapture("")).toBeNull();
    expect(parseCapture("   \n\t\n ")).toBeNull();
  });

  it("takes one line as the thought, defaulting to a seed", () => {
    expect(parseCapture("  ship the eval harness  ")).toEqual({
      fragment: "ship the eval harness",
      type: "seed",
    });
  });

  it("takes the rest as the body, across CRLF and leading blanks", () => {
    expect(parseCapture("\r\n\r\nthe thought\r\nwhy it matters\r\nand more")).toEqual({
      fragment: "the thought",
      body: "why it matters\nand more",
      type: "seed",
    });
  });

  it("reads the typed action markers and strips them", () => {
    expect(parseCapture("! email the advisor")).toMatchObject({
      fragment: "email the advisor",
      type: "action",
    });
    expect(parseCapture("TODO: email the advisor")).toMatchObject({
      fragment: "email the advisor",
      type: "action",
    });
  });

  it("reads a question as a thread", () => {
    expect(parseCapture("is attention all we need?")).toMatchObject({ type: "thread" });
  });

  it("refuses a marker with nothing after it", () => {
    // Otherwise a stray "!" commits an empty fragment, which is a record that
    // says nothing and still has to be triaged.
    expect(parseCapture("!")).toBeNull();
    expect(parseCapture("todo:   ")).toBeNull();
  });
});

describe("looksLikeUrl", () => {
  it("accepts a bare link and rejects prose containing one", () => {
    expect(looksLikeUrl(" https://example.com/a?b=c ")).toBe(true);
    expect(looksLikeUrl("read https://example.com later")).toBe(false);
    expect(looksLikeUrl("example.com")).toBe(false);
  });
});

/* ── ordering ───────────────────────────────────────────────────────────── */

describe("orderInbox", () => {
  it("is newest-first and independent of the input order", () => {
    // Per-record sync rebuilds arrays in key order, not arrival order, so the
    // order must be a function of the data alone — otherwise two converged
    // devices render different lists forever.
    const a = frag({ id: "a", createdAt: "2026-09-01T00:00:00.000Z" });
    const b = frag({ id: "b", createdAt: "2026-09-02T00:00:00.000Z" });
    const c = frag({ id: "c", createdAt: "2026-09-03T00:00:00.000Z" });
    const ids = (l: Fragment[]) => orderInbox(l).map((f) => f.id);
    expect(ids([a, b, c])).toEqual(["c", "b", "a"]);
    expect(ids([c, a, b])).toEqual(["c", "b", "a"]);
    expect(ids([b, c, a])).toEqual(["c", "b", "a"]);
  });

  it("breaks a same-instant tie deterministically", () => {
    const x = frag({ id: "x", createdAt: "2026-09-01T00:00:00.000Z" });
    const y = frag({ id: "y", createdAt: "2026-09-01T00:00:00.000Z" });
    expect(orderInbox([x, y]).map((f) => f.id)).toEqual(["y", "x"]);
    expect(orderInbox([y, x]).map((f) => f.id)).toEqual(["y", "x"]);
  });
});

describe("inboxOf", () => {
  it("holds only untriaged captures", () => {
    const list = [
      frag({ id: "in", createdAt: "2026-09-02T00:00:00.000Z" }),
      frag({ id: "filed", category: "career", createdAt: "2026-09-03T00:00:00.000Z" }),
    ];
    expect(inboxOf(list).map((f) => f.id)).toEqual(["in"]);
  });
});

describe("ageLabel", () => {
  it("names today, yesterday, and everything older in days", () => {
    const today = todayStr();
    const shift = (n: number) => {
      const d = new Date();
      d.setDate(d.getDate() + n);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    };
    expect(ageLabel(today)).toBe("today");
    expect(ageLabel(shift(-1))).toBe("yesterday");
    expect(ageLabel(shift(-4))).toBe("4d ago");
  });
});

/* ── filing targets ─────────────────────────────────────────────────────── */

describe("file targets", () => {
  it("round-trips through the select value", () => {
    for (const t of [
      { kind: "todo" } as const,
      { kind: "reading" } as const,
      { kind: "task", projectId: "seed:phase:x" } as const,
    ]) {
      expect(parseFileTarget(encodeFileTarget(t))).toEqual(t);
    }
  });

  it("refuses a value it cannot decode", () => {
    expect(parseFileTarget("")).toBeNull();
    expect(parseFileTarget("task:")).toBeNull();
    expect(parseFileTarget("nonsense")).toBeNull();
  });

  it("offers the fixed domains plus every project, ordered by name", () => {
    const d = makeDefaultData();
    d.projects = [project("p2", "Zebra"), project("p1", "Aardvark")];
    expect(fileTargets(d).map((o) => o.value)).toEqual(["todo", "reading", "task:p1", "task:p2"]);
  });
});

/* ── committing ─────────────────────────────────────────────────────────── */

describe("capture.add", () => {
  it("lands an untriaged fragment and persists it before any timer runs", () => {
    expect(capture.add("hold this thought")).toBe(true);

    const [f] = blob().journal.fragments;
    expect(f).toMatchObject({
      category: INBOX_CATEGORY,
      fragment: "hold this thought",
      type: "seed",
      date: todayStr(),
      recurrence: 1,
      promoted: false,
    });

    // No `vi.advanceTimersByTime`. This is the assertion that matters: a phone
    // killed inside the 250ms debounce must still have the capture on disk.
    expect(persisted(storage).journal.fragments).toHaveLength(1);
  });

  it("refuses blank text without touching the blob", () => {
    expect(capture.add("   ")).toBe(false);
    expect(blob().journal.fragments).toHaveLength(0);
  });

  it("refuses when the blob has not loaded, so the box does not clear", () => {
    // `update()` silently skips its recipe on a null blob. Without this guard
    // the UI would clear the box over a capture that went nowhere.
    useData.setState({ data: null, loaded: false });
    expect(capture.add("typed before boot finished")).toBe(false);
  });

  it("keeps a second capture typed in the same millisecond", () => {
    vi.setSystemTime(new Date("2026-09-15T12:00:00.000Z"));
    capture.add("first");
    capture.add("second");
    // Two records, two ids — `uid()` is time-prefixed but randomly suffixed,
    // so the collision this guards against is a same-id overwrite.
    const ids = new Set(blob().journal.fragments.map((f) => f.id));
    expect(ids.size).toBe(2);
    expect(inboxOf(blob().journal.fragments)).toHaveLength(2);
  });
});

/* ── triage ─────────────────────────────────────────────────────────────── */

describe("capture.keep", () => {
  it("moves a capture out of the inbox without creating or destroying a record", () => {
    capture.add("a principle worth holding");
    const before = blob().journal.fragments.length;
    const id = blob().journal.fragments[0]?.id ?? "";

    expect(capture.keep(id, "character")).toBe(true);

    const after = blob().journal.fragments;
    expect(after).toHaveLength(before);
    expect(after[0]).toMatchObject({ id, category: "character" });
    expect(inboxOf(after)).toHaveLength(0);
  });

  it("sets the promoted flag when kept into The Room, so the two cannot disagree", () => {
    capture.add("who I am becoming");
    const id = blob().journal.fragments[0]?.id ?? "";
    capture.keep(id, "room");
    expect(blob().journal.fragments[0]).toMatchObject({ category: "room", promoted: true });
  });

  it("refuses to keep into the inbox, or to touch an already-triaged fragment", () => {
    capture.add("x");
    const id = blob().journal.fragments[0]?.id ?? "";
    expect(capture.keep(id, INBOX_CATEGORY)).toBe(false);
    expect(capture.keep(id, "")).toBe(false);
    capture.keep(id, "mind");
    expect(capture.keep(id, "career")).toBe(false);
    expect(blob().journal.fragments[0]).toMatchObject({ category: "mind" });
  });
});

describe("capture.setType", () => {
  it("retypes an inbox capture and leaves a triaged one alone", () => {
    capture.add("email the advisor");
    const id = blob().journal.fragments[0]?.id ?? "";
    capture.setType(id, "action");
    expect(blob().journal.fragments[0]).toMatchObject({ type: "action" });

    capture.keep(id, "career");
    capture.setType(id, "principle");
    expect(blob().journal.fragments[0]).toMatchObject({ type: "action" });
  });
});

describe("capture.file", () => {
  it("creates a todo and removes the fragment in one write", () => {
    useData.setState((s) => {
      if (s.data) s.data.dashboard.todos.push({
        id: "t0",
        text: "existing",
        done: false,
        dueDate: null,
        order: 7,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
    });
    capture.add("chase the reimbursement");
    const id = blob().journal.fragments[0]?.id ?? "";

    expect(capture.file(id, { kind: "todo" })).toBe(true);

    const d = blob();
    expect(d.journal.fragments).toHaveLength(0);
    const filed = d.dashboard.todos.find((t) => t.text === "chase the reimbursement");
    // `order` from the maximum, not the length: length is array position under
    // another name, and position is not a synced property.
    expect(filed).toMatchObject({ order: 8, done: false, dueDate: null });

    // Both halves reached the cache together — no instant where the text is in
    // neither place.
    const onDisk = persisted(storage);
    expect(onDisk.journal.fragments).toHaveLength(0);
    expect(onDisk.dashboard.todos).toHaveLength(2);
  });

  it("creates a project task after the existing ones, by sort key", () => {
    useData.setState((s) => {
      if (s.data)
        s.data.projects.push(
          project("p1", "Nexus", [
            {
              id: "t1",
              name: "old",
              priority: "Medium",
              done: false,
              doneAt: null,
              notes: "",
              attachments: [],
              sort: 2048,
            },
          ]),
        );
    });
    capture.add("wire the bridge\nbecause read() must not lie");
    const id = blob().journal.fragments[0]?.id ?? "";

    expect(capture.file(id, { kind: "task", projectId: "p1" })).toBe(true);
    const task = blob().projects[0]?.tasks.find((t) => t.name === "wire the bridge");
    expect(task).toMatchObject({ sort: 2048 + SORT_STEP, notes: "because read() must not lie" });
  });

  it("keeps the capture when the target project is gone", () => {
    // Deleted on another device between opening the sheet and submitting it.
    // Dropping the fragment here would lose the text with nothing to show for
    // it, so filing refuses instead.
    capture.add("file me nowhere");
    const id = blob().journal.fragments[0]?.id ?? "";
    expect(capture.file(id, { kind: "task", projectId: "missing" })).toBe(false);
    expect(inboxOf(blob().journal.fragments)).toHaveLength(1);
  });

  it("puts a bare link in the reading item's url, and prose in its title", () => {
    capture.add("https://arxiv.org/abs/1706.03762");
    const linkId = blob().journal.fragments[0]?.id ?? "";
    capture.file(linkId, { kind: "reading" });
    expect(blob().journal.readingList[0]).toMatchObject({
      url: "https://arxiv.org/abs/1706.03762",
      status: "Queue",
      type: "Article",
    });

    capture.add("read the RLHF survey\nthe one Sam linked");
    const proseId = blob().journal.fragments[0]?.id ?? "";
    capture.file(proseId, { kind: "reading" });
    const item = blob().journal.readingList.find((r) => r.title === "read the RLHF survey");
    expect(item).toMatchObject({ url: "", notes: "the one Sam linked" });
  });

  it("refuses to file an already-triaged fragment", () => {
    capture.add("x");
    const id = blob().journal.fragments[0]?.id ?? "";
    capture.keep(id, "mind");
    expect(capture.file(id, { kind: "todo" })).toBe(false);
    expect(blob().dashboard.todos).toHaveLength(0);
  });
});

describe("capture.drop", () => {
  it("removes an inbox capture and persists the removal immediately", () => {
    capture.add("never mind");
    const id = blob().journal.fragments[0]?.id ?? "";
    expect(capture.drop(id)).toBe(true);
    expect(blob().journal.fragments).toHaveLength(0);
    expect(persisted(storage).journal.fragments).toHaveLength(0);
  });

  it("will not reach outside the inbox", () => {
    // Otherwise the capture screen could delete a journal fragment somebody
    // wrote weeks ago, from a list it is not showing.
    useData.setState((s) => {
      if (s.data) s.data.journal.fragments.push(frag({ id: "old", category: "people" }));
    });
    expect(capture.drop("old")).toBe(false);
    expect(blob().journal.fragments).toHaveLength(1);
  });
});

/* ── the draft ──────────────────────────────────────────────────────────── */

describe("the draft", () => {
  const map = () => {
    const m = new Map<string, string>();
    return {
      m,
      store: {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
      },
    };
  };

  it("survives a round-trip and clears on empty", () => {
    const { m, store } = map();
    expect(writeDraft("half a thought", store)).toBe(true);
    expect(m.get(CAPTURE_DRAFT_KEY)).toBe("half a thought");
    expect(readDraft(store)).toBe("half a thought");
    writeDraft("", store);
    expect(readDraft(store)).toBe("");
  });

  it("stays out of the synced blob entirely", () => {
    // The draft is device-local by design: syncing a half-typed thought is a
    // request per keystroke and noise on four other devices.
    const { store } = map();
    writeDraft("not a capture yet", store);
    expect(JSON.stringify(blob())).not.toContain("not a capture yet");
  });

  it("reports a refusal instead of pretending, and survives no storage at all", () => {
    const hostile: Parameters<typeof writeDraft>[1] = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(writeDraft("x", hostile)).toBe(false);
    expect(readDraft(hostile)).toBe("");
    expect(() => clearDraft(hostile)).not.toThrow();

    expect(writeDraft("x", null)).toBe(false);
    expect(readDraft(null)).toBe("");
    expect(() => clearDraft(null)).not.toThrow();
  });
});
