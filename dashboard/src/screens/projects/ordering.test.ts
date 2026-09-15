/**
 * The ordering rules, and the one contract that cannot be wrong quietly.
 *
 * Every test in the first half asserts the same property from a different
 * angle: **the output does not depend on the order of the input array.** That
 * is not a stylistic preference here. `projects`, and each of the five lists
 * nested inside a project, are per-record synced collections: records arrive
 * in the server's `seq` order and `rehydrate` rebuilds each array by ascending
 * key. So the array a screen receives is not the array anybody built, and a
 * list that maps it renders one order before a sync and another after it, on
 * data that never changed. No exception is thrown and nothing is logged.
 *
 * The second half is the task-reorder contract. `moveTask` takes indices and
 * resolves them against `orderTasks`; the rows come from `taskPositions`,
 * which is built from the same call. If those two ever disagreed the up/down
 * buttons would move a *different* task than the one the user pressed — and
 * only for lists where the two orders happened to differ, which is the kind
 * of bug that reproduces once a week.
 *
 * No DOM: this repo has no jsdom, and none of this needs one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SORT_STEP } from "@/lib/nexus/constants";
import { makeDefaultData } from "@/lib/nexus/migrate";
import { projects as projectActions } from "@/store/projects";
import { useData } from "@/store/data";
import type {
  Decision,
  Milestone,
  Project,
  ProjectTask,
  Release,
  TimeEntry,
} from "@/lib/nexus/types";
import {
  buildStandup,
  dayIndex,
  daysBetween,
  declaredPorts,
  filterSortProjects,
  fmtBytes,
  lastActivityDay,
  milestoneProgress,
  orderDecisions,
  orderEnvVars,
  orderLinks,
  orderMilestones,
  orderPorts,
  orderReleases,
  orderRunCommands,
  orderTimeLog,
  rollup,
  staleProjects,
  taskPositions,
  taskProgress,
  totalMinutes,
} from "./ordering";

/* ── Fixtures ───────────────────────────────────────────────────────────── */

const task = (id: string, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  name: id,
  priority: "Medium",
  done: false,
  doneAt: null,
  notes: "",
  attachments: [],
  ...over,
});

const milestone = (id: string, over: Partial<Milestone> = {}): Milestone => ({
  id,
  name: id,
  done: false,
  doneAt: null,
  ...over,
});

const entry = (id: string, date: string, duration = 30): TimeEntry => ({
  id,
  date,
  duration,
  description: id,
});

const release = (id: string, date: string): Release => ({
  id,
  version: id,
  date,
  notes: "",
  url: "",
});

const decision = (id: string, date: string, status: Decision["status"] = "Accepted"): Decision => ({
  id,
  title: id,
  context: "",
  decision: "",
  consequences: "",
  status,
  date,
});

const project = (id: string, over: Partial<Project> = {}): Project => ({
  id,
  name: id,
  description: "",
  directory: "",
  status: "Active",
  priority: "Medium",
  startDate: "",
  endDate: "",
  tasks: [],
  milestones: [],
  timeLog: [],
  ...over,
});

const ids = (xs: ReadonlyArray<{ id: string }>): string[] => xs.map((x) => x.id);

/** Every rotation of a list — a cheap stand-in for "whatever order sync
 *  delivered them in". */
function rotations<T>(xs: readonly T[]): T[][] {
  return xs.map((_, i) => [...xs.slice(i), ...xs.slice(0, i)]);
}

/* ── Tasks: `sort` ascending, `id` as the tiebreak ──────────────────────── */

describe("taskPositions", () => {
  it("orders by sort ascending, whatever order the array arrived in", () => {
    const list = [task("c", { sort: 3072 }), task("a", { sort: 1024 }), task("b", { sort: 2048 })];
    for (const arrangement of rotations(list)) {
      expect(ids(taskPositions(arrangement).map((r) => r.task))).toEqual(["a", "b", "c"]);
    }
  });

  it("breaks a tied sort by id, so two devices agree", () => {
    // Two devices each adding the first task to an empty list legitimately
    // produce the same sort value. Without a deterministic tiebreak the two
    // render in different orders forever, with the data fully converged.
    const list = [task("zz", { sort: 1024 }), task("aa", { sort: 1024 })];
    expect(ids(taskPositions(list).map((r) => r.task))).toEqual(["aa", "zz"]);
    expect(ids(taskPositions([...list].reverse()).map((r) => r.task))).toEqual(["aa", "zz"]);
  });

  it("treats a missing sort as 0 rather than dropping the task", () => {
    // `sort` is optional: a store written before the key existed loads
    // unchanged, and `migrate` backfills on load. A task that slipped through
    // must still render.
    const rows = taskPositions([task("b", { sort: 1024 }), task("a")]);
    expect(ids(rows.map((r) => r.task))).toEqual(["a", "b"]);
  });

  it("marks the ends of the list, so the buttons can disable themselves", () => {
    const rows = taskPositions([task("a", { sort: 1 }), task("b", { sort: 2 }), task("c", { sort: 3 })]);
    expect(rows.map((r) => [r.index, r.canUp, r.canDown])).toEqual([
      [0, false, true],
      [1, true, true],
      [2, true, false],
    ]);
    expect(rows.every((r) => r.total === 3)).toBe(true);
  });

  it("gives a single task neither direction", () => {
    const rows = taskPositions([task("only")]);
    expect(rows).toHaveLength(1);
    expect([rows[0]!.canUp, rows[0]!.canDown]).toEqual([false, false]);
  });

  it("is empty, not undefined, for a project with no tasks", () => {
    // A project with no tasks is a normal state, not an error.
    expect(taskPositions([])).toEqual([]);
  });
});

/* ── Milestones: `id` ascending ─────────────────────────────────────────── */

describe("orderMilestones", () => {
  it("orders by id — creation order, since uid() is time-prefixed", () => {
    const list = [milestone("m3"), milestone("m1"), milestone("m2")];
    for (const arrangement of rotations(list)) {
      expect(ids(orderMilestones(arrangement))).toEqual(["m1", "m2", "m3"]);
    }
  });

  it("does not re-sort by done, so the checklist holds still when ticked", () => {
    const list = [milestone("m1", { done: true, doneAt: "2026-01-01T00:00:00Z" }), milestone("m2")];
    expect(ids(orderMilestones(list))).toEqual(["m1", "m2"]);
  });

  it("does not mutate its argument", () => {
    const list = [milestone("m2"), milestone("m1")];
    orderMilestones(list);
    expect(ids(list)).toEqual(["m2", "m1"]);
  });
});

/* ── Logs: `date` descending, `id` descending ───────────────────────────── */

describe("orderTimeLog / orderReleases / orderDecisions", () => {
  it("puts the newest entry first regardless of array order", () => {
    const list = [entry("e1", "2026-01-01"), entry("e3", "2026-03-01"), entry("e2", "2026-02-01")];
    for (const arrangement of rotations(list)) {
      expect(ids(orderTimeLog(arrangement))).toEqual(["e3", "e2", "e1"]);
    }
  });

  it("breaks a same-day tie by id descending — newest-created first", () => {
    const list = [entry("a", "2026-05-05"), entry("c", "2026-05-05"), entry("b", "2026-05-05")];
    expect(ids(orderTimeLog(list))).toEqual(["c", "b", "a"]);
  });

  it("sorts an undated record last, not first", () => {
    // The release form allows a blank date. `"" < "2026-.."`, so a naive
    // descending compare would float "we don't know when" to the top of a
    // most-recent-first list.
    const list = [release("v2", ""), release("v1", "2026-01-01")];
    expect(ids(orderReleases(list))).toEqual(["v1", "v2"]);
  });

  it("orders decisions newest-first too", () => {
    const list = [
      decision("adr2", "2026-02-01", "Proposed"),
      decision("adr1", "2026-01-01"),
      decision("adr3", "2026-03-01", "Superseded"),
    ];
    for (const arrangement of rotations(list)) {
      expect(ids(orderDecisions(arrangement))).toEqual(["adr3", "adr2", "adr1"]);
    }
  });

  it("returns an empty list for an empty log", () => {
    expect(orderTimeLog([])).toEqual([]);
    expect(orderReleases([])).toEqual([]);
    expect(orderDecisions([])).toEqual([]);
  });
});

/* ── Runbook sub-lists ──────────────────────────────────────────────────── */

describe("runbook ordering", () => {
  it("orders commands, env and links by id", () => {
    expect(ids(orderRunCommands([{ id: "c2", label: "b", cmd: "b" }, { id: "c1", label: "a", cmd: "a" }])))
      .toEqual(["c1", "c2"]);
    expect(ids(orderEnvVars([{ id: "e2", key: "B", value: "" }, { id: "e1", key: "A", value: "" }])))
      .toEqual(["e1", "e2"]);
    expect(ids(orderLinks([{ id: "l2", label: "b", url: "b" }, { id: "l1", label: "a", url: "a" }])))
      .toEqual(["l1", "l2"]);
  });

  it("sorts ports numerically, not lexicographically", () => {
    // The trap in a bare `.sort()`: it stringifies, so 8080 lands before 9.
    expect(orderPorts([8080, 9, 80, 3000])).toEqual([9, 80, 3000, 8080]);
  });

  it("de-duplicates ports, because the value is the identity", () => {
    expect(orderPorts([3000, 3000, 5173])).toEqual([3000, 5173]);
  });
});

/* ── Derived numbers ────────────────────────────────────────────────────── */

describe("progress and totals", () => {
  it("reports 0%, not NaN, for a project with no tasks", () => {
    const p = project("p");
    expect(taskProgress(p)).toEqual({ done: 0, total: 0, pct: 0 });
    expect(milestoneProgress(p)).toEqual({ done: 0, total: 0, pct: 0 });
    expect(totalMinutes(p)).toBe(0);
  });

  it("counts done tasks and milestones", () => {
    const p = project("p", {
      tasks: [task("t1", { done: true }), task("t2"), task("t3", { done: true }), task("t4")],
      milestones: [milestone("m1", { done: true }), milestone("m2")],
    });
    expect(taskProgress(p)).toEqual({ done: 2, total: 4, pct: 50 });
    expect(milestoneProgress(p)).toEqual({ done: 1, total: 2, pct: 50 });
  });

  it("sums logged minutes across a log", () => {
    const p = project("p", { timeLog: [entry("e1", "2026-01-01", 45), entry("e2", "2026-01-02", 15)] });
    expect(totalMinutes(p)).toBe(60);
  });

  it("rolls up across projects", () => {
    expect(
      rollup([
        project("a", { tasks: [task("t1"), task("t2", { done: true })] }),
        project("b", { status: "Paused", timeLog: [entry("e", "2026-01-01", 20)] }),
      ]),
    ).toEqual({ projects: 2, active: 1, openTasks: 1, minutes: 20 });
  });
});

/* ── Days ───────────────────────────────────────────────────────────────── */

describe("dayIndex / daysBetween", () => {
  it("reads the date half of an ISO timestamp", () => {
    expect(dayIndex("2026-03-01T22:14:00.000Z")).toBe(dayIndex("2026-03-01"));
  });

  it("returns null for anything that is not a date", () => {
    for (const bad of ["", "tomorrow", "2026", "2026-13"]) expect(dayIndex(bad)).toBeNull();
    expect(daysBetween("", "2026-01-01")).toBeNull();
  });

  it("counts whole days across a DST boundary", () => {
    // Both sides are read as UTC midnight, so a US spring-forward weekend is
    // still exactly two days rather than 1.958.
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-03-09", "2026-03-07")).toBe(-2);
    expect(daysBetween("2026-03-09", "2026-03-09")).toBe(0);
  });
});

/* ── Activity and staleness ─────────────────────────────────────────────── */

describe("lastActivityDay", () => {
  it("takes the latest signal from any of the five lists", () => {
    const p = project("p", {
      tasks: [task("t", { done: true, doneAt: "2026-01-10T09:00:00Z" })],
      milestones: [milestone("m", { done: true, doneAt: "2026-01-12T09:00:00Z" })],
      timeLog: [entry("e", "2026-01-20")],
      releases: [release("v1", "2026-01-15")],
      decisions: [decision("adr", "2026-01-18")],
    });
    expect(lastActivityDay(p)).toBe("2026-01-20");
  });

  it("ignores tasks and milestones that are not done", () => {
    const p = project("p", { tasks: [task("t")], milestones: [milestone("m")] });
    expect(lastActivityDay(p)).toBe("");
  });

  it("is blank for a project with no records at all", () => {
    // An absent `runbook`, `releases` and `decisions` are all normal — this is
    // a new project, not a broken one.
    expect(lastActivityDay(project("fresh"))).toBe("");
  });
});

describe("staleProjects", () => {
  const today = "2026-06-01";

  it("reports an Active project with nothing recorded for 10 days", () => {
    const list = [project("p", { timeLog: [entry("e", "2026-05-01")] })];
    expect(staleProjects(list, { today })).toEqual([{ id: "p", name: "p", daysSince: 31 }]);
  });

  it("leaves a project that was touched yesterday alone", () => {
    const list = [project("p", { timeLog: [entry("e", "2026-05-31")] })];
    expect(staleProjects(list, { today })).toEqual([]);
  });

  it("counts logging time as activity, not only finishing a task", () => {
    // nexus looked at completed tasks alone, so a project you worked on all
    // week without closing anything was reported stale. That reading is what
    // teaches someone to ignore the banner.
    const list = [project("p", { startDate: "2026-01-01", timeLog: [entry("e", "2026-05-30")] })];
    expect(staleProjects(list, { today })).toEqual([]);
  });

  it("falls back to the start date when nothing has happened yet", () => {
    const list = [project("p", { startDate: "2026-01-01" })];
    expect(staleProjects(list, { today })[0]?.daysSince).toBe(151);
  });

  it("says nothing about a project with no date to measure from", () => {
    // "Stale since never" is a guess dressed as a fact.
    expect(staleProjects([project("p")], { today })).toEqual([]);
  });

  it("only looks at Active projects", () => {
    const old = { startDate: "2020-01-01" };
    const list = [
      project("paused", { ...old, status: "Paused" }),
      project("done", { ...old, status: "Completed" }),
      project("archived", { ...old, status: "Archived" }),
      project("planning", { ...old, status: "Planning" }),
    ];
    expect(staleProjects(list, { today })).toEqual([]);
  });

  it("orders stalest first, and identically whatever order it scanned", () => {
    const list = [
      project("a", { startDate: "2026-05-01" }),
      project("b", { startDate: "2026-01-01" }),
      project("c", { startDate: "2026-03-01" }),
    ];
    for (const arrangement of rotations(list)) {
      expect(staleProjects(arrangement, { today }).map((s) => s.id)).toEqual(["b", "c", "a"]);
    }
  });

  it("honours a custom threshold", () => {
    const list = [project("p", { timeLog: [entry("e", "2026-05-29")] })];
    expect(staleProjects(list, { today, staleDays: 3 })).toHaveLength(1);
    expect(staleProjects(list, { today, staleDays: 30 })).toHaveLength(0);
  });
});

/* ── The master column ──────────────────────────────────────────────────── */

describe("filterSortProjects", () => {
  const a = project("id-a", { name: "Azimuth", timeLog: [entry("e1", "2026-01-01")], priority: "Low" });
  const b = project("id-b", { name: "Beacon", timeLog: [entry("e2", "2026-03-01")], priority: "Critical" });
  const c = project("id-c", { name: "Cairn", timeLog: [entry("e3", "2026-02-01")], priority: "High" });
  const list = [a, b, c];

  it("sorts by recent activity, not by array position", () => {
    // nexus's "recent" was a comparator returning 0 — "leave the array as it
    // is". That array is whatever rehydrate produced, presented as recency.
    for (const arrangement of rotations(list)) {
      expect(ids(filterSortProjects(arrangement, { sort: "recent" }))).toEqual([
        "id-b",
        "id-c",
        "id-a",
      ]);
    }
  });

  it("falls back to the start date for a project with no activity", () => {
    const fresh = project("id-d", { name: "Delta", startDate: "2026-04-01" });
    expect(ids(filterSortProjects([...list, fresh], { sort: "recent" }))[0]).toBe("id-d");
  });

  it("sorts by name and by priority rank", () => {
    expect(ids(filterSortProjects(list, { sort: "name" }))).toEqual(["id-a", "id-b", "id-c"]);
    expect(ids(filterSortProjects(list, { sort: "priority" }))).toEqual(["id-b", "id-c", "id-a"]);
  });

  it("puts an unknown priority last instead of first", () => {
    // A priority no build has ever defined — the kind of value a newer device
    // can legitimately push at an older one.
    const odd = project("id-x", { name: "Odd", priority: "Someday" as unknown as Project["priority"] });
    expect(ids(filterSortProjects([odd, ...list], { sort: "priority" })).at(-1)).toBe("id-x");
  });

  it("filters by name, case-insensitively, and by status", () => {
    expect(ids(filterSortProjects(list, { q: "cai" }))).toEqual(["id-c"]);
    expect(ids(filterSortProjects(list, { q: "  BEA  " }))).toEqual(["id-b"]);
    expect(filterSortProjects(list, { status: "Paused" })).toEqual([]);
    expect(ids(filterSortProjects(list, { status: "Active", sort: "name" }))).toHaveLength(3);
  });

  it("does not mutate the list it was given", () => {
    const arrangement = [c, a, b];
    filterSortProjects(arrangement, { sort: "name" });
    expect(ids(arrangement)).toEqual(["id-c", "id-a", "id-b"]);
  });
});

/* ── Cross-project rollups ──────────────────────────────────────────────── */

describe("declaredPorts", () => {
  it("collects every runbook port, project-name ordered and numerically sorted", () => {
    const list = [
      project("b", { name: "Beacon", runbook: { commands: [], env: [], ports: [8080, 80], links: [] } }),
      project("a", { name: "Azimuth", runbook: { commands: [], env: [], ports: [5173], links: [] } }),
      project("c", { name: "Cairn" }),
    ];
    expect(declaredPorts(list)).toEqual([
      { projectId: "a", projectName: "Azimuth", port: 5173 },
      { projectId: "b", projectName: "Beacon", port: 80 },
      { projectId: "b", projectName: "Beacon", port: 8080 },
    ]);
  });

  it("is empty when no project has a runbook — an absent one is normal", () => {
    expect(declaredPorts([project("a")])).toEqual([]);
  });
});

describe("buildStandup", () => {
  const OPTS = { sinceISO: "2026-06-01T00:00:00.000Z", sinceDate: "2026-06-01" };

  it("takes the next open tasks in the order the list is shown in", () => {
    // nexus took `p.tasks.filter(t => !t.done).slice(0, 2)` — the first two of
    // the *array*, i.e. whichever two a rehydrate happened to put first. The
    // array here is deliberately scrambled relative to the sort keys.
    const p = project("p", {
      name: "Azimuth",
      tasks: [
        task("t3", { name: "third", sort: 3072 }),
        task("t1", { name: "first", sort: 1024 }),
        task("t2", { name: "second", sort: 2048 }),
      ],
    });
    const out = buildStandup([p], OPTS);
    expect(out).toContain("[Azimuth] first");
    expect(out).toContain("[Azimuth] second");
    expect(out).not.toContain("[Azimuth] third");
    expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
  });

  it("reports closed tasks, closed milestones and logged time since the cutoff", () => {
    const p = project("p", {
      name: "Beacon",
      tasks: [
        task("t1", { name: "shipped it", done: true, doneAt: "2026-06-02T10:00:00.000Z" }),
        task("t2", { name: "last month", done: true, doneAt: "2026-05-02T10:00:00.000Z" }),
      ],
      milestones: [milestone("m1", { name: "v1", done: true, doneAt: "2026-06-02T11:00:00.000Z" })],
      timeLog: [entry("e1", "2026-06-02", 90), entry("e2", "2026-05-01", 30)],
    });
    const out = buildStandup([p], OPTS);
    expect(out).toContain("[Beacon] shipped it");
    expect(out).toContain("[Beacon] v1 (milestone)");
    expect(out).toContain("[Beacon] 90m logged");
    expect(out).not.toContain("last month");
  });

  it("produces the same text whatever order the projects arrived in", () => {
    const list = [
      project("p1", { name: "Azimuth", tasks: [task("t", { name: "a task" })] }),
      project("p2", { name: "Beacon", tasks: [task("t", { name: "b task" })] }),
    ];
    const outputs = rotations(list).map((arrangement) => buildStandup(arrangement, OPTS));
    expect(new Set(outputs).size).toBe(1);
  });

  it("writes an em-dash rather than an empty section", () => {
    const out = buildStandup([project("p", { name: "Quiet" })], OPTS);
    expect(out).toBe("Since\n  —\n\nNext\n  —\n\nBlockers\n  —");
  });
});

describe("fmtBytes", () => {
  it("scales, and refuses to guess at a missing size", () => {
    expect(fmtBytes(0)).toBe("—");
    expect(fmtBytes(Number.NaN)).toBe("—");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

/* ══ The reorder contract ═══════════════════════════════════════════════ */

describe("taskPositions ↔ moveTask", () => {
  const PID = "proj";

  /** A project whose task array is deliberately *not* in sort order, which is
   *  what a rehydrate hands over. */
  function seed(): void {
    const data = makeDefaultData();
    data.projects.push(
      project(PID, {
        tasks: [
          task("t-c", { name: "c", sort: 3 * SORT_STEP }),
          task("t-a", { name: "a", sort: 1 * SORT_STEP }),
          task("t-b", { name: "b", sort: 2 * SORT_STEP }),
        ],
      }),
    );
    useData.setState({ data, loaded: true, cacheHit: true });
  }

  /** The rendered order, read back out of the store. */
  const rendered = (): string[] => {
    const p = useData.getState().data?.projects.find((x) => x.id === PID);
    return taskPositions(p?.tasks ?? []).map((r) => r.task.name);
  };

  beforeEach(() => {
    // The store debounces a save for 250ms and then writes to localStorage,
    // which node does not have. Frozen time means the timer never fires, so
    // nothing leaks into the next test.
    vi.useFakeTimers();
    seed();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("renders sort order, not array order", () => {
    expect(rendered()).toEqual(["a", "b", "c"]);
  });

  it("moves the task the button was next to, up", () => {
    // "c" is index 2 in the rendered list and index 0 in the array.
    const rows = taskPositions(useData.getState().data!.projects[0]!.tasks);
    const c = rows.find((r) => r.task.name === "c")!;
    projectActions.moveTask(PID, c.index, c.index - 1);
    expect(rendered()).toEqual(["a", "c", "b"]);
  });

  it("moves the task the button was next to, down", () => {
    const rows = taskPositions(useData.getState().data!.projects[0]!.tasks);
    const a = rows.find((r) => r.task.name === "a")!;
    projectActions.moveTask(PID, a.index, a.index + 1);
    expect(rendered()).toEqual(["b", "a", "c"]);
  });

  it("writes a sort key to exactly one record", () => {
    // The property that makes a move mergeable: two devices moving two
    // different tasks in one list do not conflict at all.
    const before = new Map(
      useData.getState().data!.projects[0]!.tasks.map((t) => [t.id, t.sort] as const),
    );
    projectActions.moveTask(PID, 2, 0);
    const changed = useData
      .getState()
      .data!.projects[0]!.tasks.filter((t) => t.sort !== before.get(t.id));
    expect(changed).toHaveLength(1);
    expect(changed[0]!.name).toBe("c");
  });

  it("would move the wrong task if the screen passed an array index", () => {
    // Documented rather than hypothetical. "c" sits at array index 0, so a
    // screen that mapped `p.tasks` and handed its own index to `moveTask`
    // would ask to move index 0 — which in the *canonical* order is "a".
    const arrayIndexOfC = useData.getState().data!.projects[0]!.tasks.findIndex(
      (t) => t.name === "c",
    );
    expect(arrayIndexOfC).toBe(0);
    projectActions.moveTask(PID, arrayIndexOfC, arrayIndexOfC + 1);
    expect(rendered()).toEqual(["b", "a", "c"]); // "a" moved. Not "c".
  });

  it("ignores a move that runs off either end", () => {
    projectActions.moveTask(PID, 0, -1);
    projectActions.moveTask(PID, 2, 3);
    projectActions.moveTask(PID, 1, 1);
    expect(rendered()).toEqual(["a", "b", "c"]);
  });

  it("survives being moved to the same slot repeatedly", () => {
    for (let i = 0; i < 6; i += 1) {
      projectActions.moveTask(PID, 0, 2);
      projectActions.moveTask(PID, 2, 0);
    }
    expect(rendered()).toEqual(["a", "b", "c"]);
  });
});
