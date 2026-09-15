/**
 * Every order this screen renders in, and every number it derives — in one
 * place, with no JSX and no React, so it can be tested without a DOM.
 *
 * `.tsx` and not `.ts` only because this directory's brief allowed `*.tsx`
 * and `*.test.ts` and nothing else; the extension carries no meaning here.
 * (`components/ui/index.tsx` carries the same note for the same reason.)
 *
 * ── Why a module exists at all ────────────────────────────────────────────
 *
 * Array *position* is not a synced property. Records arrive one at a time in
 * the server's `seq` order and `rehydrate` rebuilds every array by ascending
 * key, so two devices holding an identical record set rebuild identical
 * arrays — but not the array either user was looking at. A screen that maps
 * `p.tasks` renders one order before a sync and another after it, on data
 * that never changed.
 *
 * So nothing here reads an index out of a stored array. Each of the five
 * nested lists is ordered by a *field*:
 *
 * | list       | ordered by                        | why that field              |
 * | ---------- | --------------------------------- | --------------------------- |
 * | tasks      | `sort` asc, `id` asc  (the store's `orderTasks`) | the list is user-reorderable, so it needs a key a move can write |
 * | milestones | `id` asc                          | a checklist; `uid()` is time-prefixed, so this is creation order and it does not jump when one is ticked |
 * | timeLog    | `date` desc, `id` desc            | a log — newest first; undated entries sort last rather than first |
 * | releases   | `date` desc, `id` desc            | a shipping history — newest first |
 * | decisions  | `date` desc, `id` desc            | an ADR log — newest first |
 *
 * `id` ascending is not an arbitrary tiebreak: `uid()` is
 * `Date.now().toString(36)` plus five random characters, and that time prefix
 * is a fixed eight characters until 2059 — so ascending id order *is*
 * creation order for everything this app mints, and it is also exactly the
 * order `rehydrate` rebuilds an array in. Ordering by it means the list looks
 * the same before and after a sync, and the same on all five devices.
 *
 * The runbook's own sub-lists (commands, env, links) get `id` asc for the
 * same reason. `ports` is a bare `number[]` with no ids at all, so it is
 * sorted numerically — the one list here where the values *are* the identity.
 */
import { orderTasks } from "@/store/projects";
import { todayStr } from "@/lib/nexus/format";
import type {
  Decision,
  EnvVar,
  Milestone,
  Project,
  ProjectTask,
  Release,
  ResourceLink,
  RunCommand,
  TimeEntry,
} from "@/lib/nexus/types";

/* ── Comparators ────────────────────────────────────────────────────────── */

/** Lexicographic, and explicit: `Array#sort`'s default stringifies, which is
 *  right here by accident and wrong the moment a caller passes numbers. */
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Ascending id — creation order, and the order `rehydrate` rebuilds in. */
const byIdAsc = <T extends { id: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => cmpStr(a.id, b.id));

/**
 * Newest first, by an `ISODate` field, with `id` descending as the tiebreak.
 *
 * `date` is a plain `YYYY-MM-DD` string, so a lexicographic compare is a
 * chronological one. An empty date — a release logged without one, which the
 * form allows — sorts *last*: `"" < "2026-01-01"`, and in a descending
 * compare that puts it at the bottom, which is where "we don't know when"
 * belongs. Reversing the comparator instead would float undated rows to the
 * top of a "most recent" list.
 */
const byDateDesc = <T extends { id: string; date: string }>(xs: readonly T[]): T[] =>
  [...xs].sort((a, b) => cmpStr(b.date, a.date) || cmpStr(b.id, a.id));

/* ── The five nested lists ──────────────────────────────────────────────── */

/** Tasks, in the *store's* canonical order. Re-exported rather than
 *  re-implemented: `moveTask` resolves its indices against `orderTasks`, and a
 *  screen that rendered a second opinion would move the wrong task. */
export { orderTasks };

export const orderMilestones = (ms: readonly Milestone[]): Milestone[] => byIdAsc(ms);
export const orderTimeLog = (es: readonly TimeEntry[]): TimeEntry[] => byDateDesc(es);
export const orderReleases = (rs: readonly Release[]): Release[] => byDateDesc(rs);
export const orderDecisions = (ds: readonly Decision[]): Decision[] => byDateDesc(ds);

/* ── Runbook sub-lists ──────────────────────────────────────────────────── */

export const orderRunCommands = (cs: readonly RunCommand[]): RunCommand[] => byIdAsc(cs);
export const orderEnvVars = (es: readonly EnvVar[]): EnvVar[] => byIdAsc(es);
export const orderLinks = (ls: readonly ResourceLink[]): ResourceLink[] => byIdAsc(ls);
/** Numerically, and de-duplicated: the value is the identity here. */
export const orderPorts = (ports: readonly number[]): number[] =>
  [...new Set(ports)].sort((a, b) => a - b);

/* ── Task positions: the one bridge between the list and `moveTask` ─────── */

export interface TaskPosition {
  task: ProjectTask;
  /** Index into `orderTasks(tasks)` — the same order `moveTask` resolves. */
  index: number;
  total: number;
  canUp: boolean;
  canDown: boolean;
}

/**
 * The rendered task list, each row carrying the index `moveTask` expects.
 *
 * This function is the contract. `moveTask(pid, from, to)` takes indices and
 * resolves them against `orderTasks(p.tasks)`; the rows are produced *from*
 * that same call, so `index ± 1` is always the neighbour the user can see.
 * Any other rendered order — done tasks sunk to the bottom, a "hide
 * completed" filter — would silently re-point the up/down buttons at
 * whichever task happened to occupy that slot in the store's order instead.
 * That is why there is no such filter on this screen.
 */
export function taskPositions(tasks: readonly ProjectTask[]): TaskPosition[] {
  const ordered = orderTasks([...tasks]);
  const total = ordered.length;
  return ordered.map((task, index) => ({
    task,
    index,
    total,
    canUp: index > 0,
    canDown: index < total - 1,
  }));
}

/* ── Days, without a timezone ───────────────────────────────────────────── */

const DAY_MS = 86400000;

/** `YYYY-MM-DD` (or the date half of an ISO timestamp) → whole days since the
 *  epoch; `null` for anything that is not a date. Both sides are read as UTC
 *  midnight, so a diff is DST- and zone-proof. */
export function dayIndex(day: string): number | null {
  const parts = day.slice(0, 10).split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return null;
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Whole days from `from` to `to`; `null` if either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = dayIndex(from);
  const b = dayIndex(to);
  return a === null || b === null ? null : b - a;
}

const laterDay = (a: string, b: string): string => (b > a ? b : a);

/* ── Derived numbers ────────────────────────────────────────────────────── */

export interface Progress {
  done: number;
  total: number;
  /** 0–100. An empty list is 0, not NaN. */
  pct: number;
}

const progress = (done: number, total: number): Progress => ({
  done,
  total,
  pct: total === 0 ? 0 : (done / total) * 100,
});

export const taskProgress = (p: Pick<Project, "tasks">): Progress =>
  progress(p.tasks.filter((t) => t.done).length, p.tasks.length);

/**
 * Milestone progress.
 *
 * `p.milestones` is read directly, with no `?? []`. It is non-optional in the
 * type and `normalize` backfills it for the older stores that predate it — so
 * a guard here would not be defensive, it would hide the one case worth
 * seeing: a project whose milestones genuinely failed to load.
 */
export const milestoneProgress = (p: Pick<Project, "milestones">): Progress =>
  progress(p.milestones.filter((m) => m.done).length, p.milestones.length);

/** Minutes logged against a project. Same note as above: no `?? []`. */
export const totalMinutes = (p: Pick<Project, "timeLog">): number =>
  p.timeLog.reduce((s, e) => s + (Number(e.duration) || 0), 0);

export const openTasks = (p: Pick<Project, "tasks">): number =>
  p.tasks.filter((t) => !t.done).length;

/**
 * The most recent day a project shows any activity on, as `YYYY-MM-DD`, or
 * `""` when it shows none.
 *
 * Wider than nexus's staleness check, which looked only at completed tasks.
 * Logging two hours against a project is activity; so is cutting a release or
 * recording a decision. The narrow version called a project you worked on
 * yesterday stale because you had not *finished* anything in ten days, which
 * is the reading that makes the alert easy to ignore.
 *
 * `releases` and `decisions` take `?? []` because the *type* says they are
 * optional — a project that predates the dev add-ons has neither, and that is
 * a normal state. `tasks`, `milestones` and `timeLog` do not, because they
 * are not optional.
 */
export function lastActivityDay(p: Project): string {
  let day = "";
  for (const t of p.tasks) if (t.done && t.doneAt) day = laterDay(day, t.doneAt.slice(0, 10));
  for (const m of p.milestones) if (m.done && m.doneAt) day = laterDay(day, m.doneAt.slice(0, 10));
  for (const e of p.timeLog) day = laterDay(day, e.date.slice(0, 10));
  for (const r of p.releases ?? []) day = laterDay(day, r.date.slice(0, 10));
  for (const d of p.decisions ?? []) day = laterDay(day, d.date.slice(0, 10));
  return day;
}

export interface StaleProject {
  id: string;
  name: string;
  daysSince: number;
}

/**
 * Active projects with nothing recorded against them for `staleDays`.
 *
 * A project with no activity *and* no start date is not reported: there is no
 * date to measure from, and "stale since never" is a guess dressed as a fact.
 * `today` is a parameter so this is a pure function of its arguments.
 */
export function staleProjects(
  list: readonly Project[],
  opts: { staleDays?: number; today?: string } = {},
): StaleProject[] {
  const staleDays = opts.staleDays ?? 10;
  const today = opts.today ?? todayStr();
  const out: StaleProject[] = [];
  for (const p of list) {
    if (p.status !== "Active") continue;
    const since = lastActivityDay(p) || p.startDate;
    const days = since ? daysBetween(since, today) : null;
    if (days !== null && days >= staleDays) out.push({ id: p.id, name: p.name, daysSince: days });
  }
  // Stalest first, id ascending to break a tie — so the row order is a
  // function of the data rather than of the array it was scanned from.
  return out.sort((a, b) => b.daysSince - a.daysSince || cmpStr(a.id, b.id));
}

/* ── The project list itself ────────────────────────────────────────────── */

export type ProjectSort = "recent" | "name" | "priority";

export const PRIORITY_RANK: Record<string, number> = {
  Critical: 0,
  High: 1,
  Medium: 2,
  Low: 3,
};

const rank = (p: string): number => PRIORITY_RANK[p] ?? 9;

/**
 * Filter and sort the master column.
 *
 * `"recent"` is the fix nexus's version needed most: there it was a
 * comparator returning `0`, i.e. "leave the array as it is" — which is the
 * ordering trap at the *project* level. `projects` is a per-record synced
 * collection too, so that order was the id order a rehydrate happened to
 * produce, presented as recency. Here recency is the project's last activity
 * day, descending, with its start date as the fallback and `id` last.
 */
export function filterSortProjects(
  list: readonly Project[],
  opts: { q?: string; status?: string; sort?: ProjectSort } = {},
): Project[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const status = opts.status ?? "All";
  const sort = opts.sort ?? "recent";

  const kept = list.filter(
    (p) =>
      (status === "All" || p.status === status) &&
      (q === "" || p.name.toLowerCase().includes(q)),
  );

  const activity = new Map(kept.map((p) => [p.id, lastActivityDay(p) || p.startDate]));
  const at = (p: Project): string => activity.get(p.id) ?? "";

  return kept.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name) || cmpStr(a.id, b.id);
    if (sort === "priority") {
      return rank(a.priority) - rank(b.priority) || a.name.localeCompare(b.name) || cmpStr(a.id, b.id);
    }
    return cmpStr(at(b), at(a)) || cmpStr(b.id, a.id);
  });
}

/* ── Cross-project rollups (the Workspace tab) ──────────────────────────── */

export interface Rollup {
  projects: number;
  active: number;
  openTasks: number;
  minutes: number;
}

export function rollup(list: readonly Project[]): Rollup {
  return {
    projects: list.length,
    active: list.filter((p) => p.status === "Active").length,
    openTasks: list.reduce((s, p) => s + openTasks(p), 0),
    minutes: list.reduce((s, p) => s + totalMinutes(p), 0),
  };
}

export interface PortLink {
  projectId: string;
  projectName: string;
  port: number;
}

/**
 * Every port declared in any runbook, as a link.
 *
 * nexus *scanned* localhost for listeners and drew a live dot next to each
 * one. That was a Tauri `invoke` into a Rust socket probe; a browser cannot
 * open a raw socket, and `fetch` to a port that is closed is
 * indistinguishable from one blocked by CORS. So no liveness is claimed here
 * — these are the ports you wrote down, and the link either opens something
 * or it does not.
 */
export function declaredPorts(list: readonly Project[]): PortLink[] {
  const out: PortLink[] = [];
  for (const p of [...list].sort((a, b) => a.name.localeCompare(b.name) || cmpStr(a.id, b.id))) {
    for (const port of orderPorts(p.runbook?.ports ?? [])) {
      out.push({ projectId: p.id, projectName: p.name, port });
    }
  }
  return out;
}

export interface StandupOpts {
  /** Full ISO timestamp — `doneAt` is compared against this. */
  sinceISO: string;
  /** `YYYY-MM-DD` — time-log and release dates are compared against this. */
  sinceDate: string;
  /** How many open tasks to carry into "Today" per project. */
  openPerProject?: number;
}

/**
 * A copy-pasteable standup, from the store alone. Pure — no I/O.
 *
 * Two changes from nexus's `buildStandup`:
 *
 * 1. **The commit section is gone.** It read `git log` through a Tauri
 *    command. There is no git here and there is no shell; a section that
 *    silently rendered empty forever would be worse than its absence.
 * 2. **"Today" no longer slices the raw array.** nexus took
 *    `p.tasks.filter(t => !t.done).slice(0, 2)` — array position, so the two
 *    tasks it volunteered were whichever two a rehydrate happened to put
 *    first, not the two at the top of the list the user ordered. It takes
 *    them from `orderTasks` now, which is what the screen shows.
 *
 * Projects are walked in name order for the same reason: the output has to be
 * a function of the data, or two devices generate two different standups from
 * one dataset.
 */
export function buildStandup(list: readonly Project[], opts: StandupOpts): string {
  const perProject = opts.openPerProject ?? 2;
  const done: string[] = [];
  const next: string[] = [];

  const byName = [...list].sort((a, b) => a.name.localeCompare(b.name) || cmpStr(a.id, b.id));

  for (const p of byName) {
    for (const t of orderTasks([...p.tasks])) {
      if (t.done && t.doneAt && t.doneAt >= opts.sinceISO) done.push(`[${p.name}] ${t.name}`);
    }
    for (const m of orderMilestones(p.milestones)) {
      if (m.done && m.doneAt && m.doneAt >= opts.sinceISO) done.push(`[${p.name}] ${m.name} (milestone)`);
    }
    const mins = p.timeLog
      .filter((e) => e.date >= opts.sinceDate)
      .reduce((s, e) => s + (Number(e.duration) || 0), 0);
    if (mins > 0) done.push(`[${p.name}] ${mins}m logged`);

    for (const t of orderTasks([...p.tasks]).filter((t) => !t.done).slice(0, perProject)) {
      next.push(`[${p.name}] ${t.name}`);
    }
  }

  const section = (title: string, lines: string[]): string =>
    `${title}\n${lines.length ? lines.map((l) => `  ${l}`).join("\n") : "  —"}`;

  return [section("Since", done), section("Next", next), section("Blockers", [])].join("\n\n");
}

/* ── Tones ──────────────────────────────────────────────────────────────── */

/**
 * Status and priority hues, as token references.
 *
 * nexus named copper, amber and steel here — three palette words that only
 * meant anything in its theme. These return `var(--color-*)`, so the screen
 * re-palettes with `theme.css` and the semantics stay put: `--warn` for
 * paused, `--bad` for critical, the accent for the ordinary case, and the
 * neutral ramp for "no signal".
 *
 * The fallthrough is deliberate rather than exhaustive: `ProjectStatus` can
 * grow, and an unknown status should read as neutral rather than crash or
 * borrow a meaning it has not earned.
 */
export const statusTone = (s: string): string =>
  s === "Active"
    ? "var(--color-good)"
    : s === "Planning"
      ? "var(--color-info)"
      : s === "Paused"
        ? "var(--color-warn)"
        : s === "Completed"
          ? "var(--color-accent-lt)"
          : "var(--color-neutral-100)";

export const priorityTone = (p: string): string =>
  p === "Critical"
    ? "var(--color-bad)"
    : p === "High"
      ? "var(--color-warn)"
      : p === "Medium"
        ? "var(--color-accent)"
        : "var(--color-neutral-100)";

export const decisionTone = (s: string): string =>
  s === "Accepted"
    ? "var(--color-good)"
    : s === "Superseded"
      ? "var(--color-neutral-100)"
      : "var(--color-info)";

/** "1.2 MB" for an attachment's recorded size. */
export function fmtBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
