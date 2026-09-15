import { NEW_SCHEMA_VERSION } from "./types";
import { completionId } from "./types";
import { SORT_STEP } from "./constants";
import type {
  NexusData,
  StudyPlanner,
  Project,
  Course,
  Habit,
  HabitCompletion,
  Experiment,
} from "./types";
import { uid } from "./format";
import { makeRoadmapSeed } from "./roadmapSeed";

/* ── Builders for fresh state ───────────────────────────── */

function makeDefaultStudyPlanner(): StudyPlanner {
  return {
    plans: [],
    sessions: [],
    pomodoroSettings: { focus: 25, shortBreak: 5, longBreak: 15, rounds: 4 },
    weeklyGoalMinutes: 420,
  };
}

/**
 * A fresh, empty store.
 *
 * Note what is NOT here: a call to `uid()`. It seeds no record with a
 * generated identifier, and that is a property worth protecting rather than a
 * coincidence — see the test that asserts it.
 *
 * It used to mint two: a Cash account and two default workplaces. On first
 * sync, every device would have bootstrapped its own copy of those with
 * different random ids, and the merge would have produced two Cash accounts
 * and four workplaces — duplicates that look like a user mistake and cannot
 * be told apart from deliberate records. Removing the two domains removed the
 * only two calls, so the collision is now structurally impossible rather than
 * guarded against.
 */
export function makeDefaultData(): NexusData {
  return {
    schemaVersion: NEW_SCHEMA_VERSION,
    settings: { baseCurrency: "USD" },
    academics: {
      courses: [],
      semesters: ["Fall 2025", "Spring 2026"],
      studyPlanner: makeDefaultStudyPlanner(),
    },
    projects: [],
    career: { jobs: [], certifications: [] },
    journal: { entries: [], habits: [], habitCompletions: [], readingList: [], fragments: [] },
    dashboard: { todos: [] },
    routine: { lastCompletedDate: null, time: "23:30" },
    roadmap: makeRoadmapSeed(),
    // Seeded empty on purpose. Every other block here either has content worth
    // starting from or is a settings object; an experiment log that arrives
    // pre-populated would be inventing work you have not done.
    research: { experiments: [] },
  };
}

/* ── Normalizers (port shapes, fill gaps) ───────────────── */

/**
 * Fill a project's required fields without discarding its optional ones.
 *
 * This used to be a pure whitelist: it enumerated the fields it knew and
 * returned only those, so `runbook`, `releases` and `decisions` — all
 * optional, all real — were silently dropped, along with the `sort` key that
 * now carries task order.
 *
 * That is the "old client eats new data" shape. A reader that rebuilds a
 * record from the fields it happens to know about deletes everything added
 * since it was written, and reports success. With sync, that reader is a
 * device on an older build, and the deletion propagates.
 *
 * So: spread first, then override. Unknown keys survive; known keys get
 * their defaults. The trade is that genuine garbage survives too, which at
 * this dataset size is the cheaper mistake — a stray key is inert, a dropped
 * runbook is gone.
 */
function normalizeProject(p: Record<string, unknown>): Project {
  const o = p as Partial<Project>;
  return {
    ...o,
    id: o.id ?? uid(),
    name: o.name ?? "Untitled",
    description: o.description ?? "",
    directory: o.directory ?? "",
    status: o.status ?? "Active",
    priority: o.priority ?? "Medium",
    startDate: o.startDate ?? "",
    endDate: o.endDate ?? "",
    tasks: Array.isArray(o.tasks)
      ? o.tasks.map((t) => ({
          // Same reason: a whitelist here dropped `sort`, so a project loaded
          // through the legacy path lost its task order entirely.
          ...t,
          id: t.id ?? uid(),
          name: t.name ?? "",
          priority: t.priority ?? "Medium",
          done: !!t.done,
          doneAt: t.doneAt ?? null,
          notes: t.notes ?? "",
          attachments: Array.isArray(t.attachments) ? t.attachments : [],
        }))
      : [],
    milestones: Array.isArray(o.milestones) ? o.milestones : [],
    timeLog: Array.isArray(o.timeLog) ? o.timeLog : [],
  };
}

function migrateStudyPlanner(sp: Record<string, unknown> | undefined): StudyPlanner {
  const base = makeDefaultStudyPlanner();
  if (!sp) return base;
  const o = sp as Partial<StudyPlanner> & { plans?: unknown };
  // Keep plans/modules/topics but strip removed spaced-repetition fields.
  const plans = Array.isArray(o.plans)
    ? (o.plans as unknown as Array<Record<string, unknown>>).map((pl) => ({
        id: (pl.id as string) ?? uid(),
        name: (pl.name as string) ?? "",
        course: (pl.course as string) ?? "",
        deadline: (pl.deadline as string) ?? "",
        modules: Array.isArray(pl.modules)
          ? (pl.modules as Array<Record<string, unknown>>).map((m) => ({
              id: (m.id as string) ?? uid(),
              name: (m.name as string) ?? "",
              topics: Array.isArray(m.topics)
                ? (m.topics as Array<Record<string, unknown>>).map((t) => ({
                    id: (t.id as string) ?? uid(),
                    name: (t.name as string) ?? "",
                    done: !!t.done,
                    doneAt: (t.doneAt as string) ?? null,
                    // srInterval intentionally dropped (review queue removed)
                  }))
                : [],
            }))
          : [],
      }))
    : [];

  return {
    plans,
    sessions: Array.isArray(o.sessions) ? o.sessions : [],
    pomodoroSettings: o.pomodoroSettings ?? base.pomodoroSettings,
    weeklyGoalMinutes:
      typeof o.weeklyGoalMinutes === "number" && o.weeklyGoalMinutes > 0
        ? o.weeklyGoalMinutes
        : base.weeklyGoalMinutes,
    ...(o.streakFreezeDate ? { streakFreezeDate: o.streakFreezeDate } : {}),
    // todos, badges, recurringTasks intentionally dropped
  };
}

/**
 * Legacy (`_schemaVersion` ≤ 2) → Nexus 2.0.
 * Finance is wiped fresh (seeded Cash). Planning / DSA / Escape Route / AI
 * pages are not carried into the active app (archived in the old backup).
 */
export function migrateLegacy(old: Record<string, unknown>): NexusData {
  const fresh = makeDefaultData();
  const academics = (old.academics ?? {}) as Record<string, unknown>;

  const courses = Array.isArray(academics.courses)
    ? (academics.courses as Course[])
    : [];
  const semesters = Array.isArray(academics.semesters)
    ? (academics.semesters as string[])
    : fresh.academics.semesters;

  const journal = (old.journal ?? {}) as Record<string, unknown>;

  return {
    ...fresh,
    academics: {
      courses,
      semesters,
      studyPlanner: migrateStudyPlanner(
        academics.studyPlanner as Record<string, unknown> | undefined,
      ),
    },
    projects: Array.isArray(old.projects)
      ? (old.projects as Array<Record<string, unknown>>).map(normalizeProject)
      : [],
    career: {
      jobs: Array.isArray(old.jobs) ? (old.jobs as never[]) : [],
      certifications: Array.isArray(old.certifications)
        ? (old.certifications as never[])
        : [],
    },
    journal: {
      entries: Array.isArray(journal.entries) ? (journal.entries as never[]) : [],
      habits: stripInlineCompletions(journal.habits),
      habitCompletions: liftCompletions(journal.habits),
      readingList: Array.isArray(journal.readingList)
        ? (journal.readingList as never[])
        : [],
      fragments: [],
    },
  };
}

/* ── schema 3 → 4: habit ticks and task order become records ──────────────
   Both changes exist for the same reason: a field that is rewritten wholesale
   cannot be merged, and every write here used to rewrite a whole array. See
   HabitCompletion and ProjectTask.sort in types.ts. */

type LegacyHabit = { id?: unknown; completions?: unknown };

/** Habits without their inline `completions`, which moved out in schema 4. */
function stripInlineCompletions(habits: unknown): Habit[] {
  if (!Array.isArray(habits)) return [];
  return habits.map((h) => {
    // Destructured out rather than deleted: `normalize` must not mutate the
    // object it was handed, or a caller that still holds a reference to the
    // parsed JSON sees it change underneath them.
    const { completions: _dropped, ...rest } = h as LegacyHabit & Record<string, unknown>;
    void _dropped;
    return rest as unknown as Habit;
  });
}

/** Legacy `habits[].completions` → flat HabitCompletion records. */
function liftCompletions(habits: unknown): HabitCompletion[] {
  if (!Array.isArray(habits)) return [];
  const out: HabitCompletion[] = [];
  for (const raw of habits as LegacyHabit[]) {
    const habitId = typeof raw?.id === "string" ? raw.id : null;
    if (!habitId || !Array.isArray(raw.completions)) continue;
    for (const date of raw.completions) {
      if (typeof date !== "string" || !date) continue;
      out.push({ id: completionId(habitId, date), habitId, date });
    }
  }
  return out;
}

/**
 * One record per id, last occurrence winning.
 *
 * Needed because a tick can arrive from both sources at once -- lifted from a
 * legacy habit AND already present as a record -- and two rows with the same
 * id would make the collection's primary key a lie before the sync layer ever
 * sees it.
 */
function dedupeCompletions(rows: HabitCompletion[]): HabitCompletion[] {
  const byId = new Map<string, HabitCompletion>();
  for (const r of rows) {
    if (!r || typeof r.habitId !== "string" || typeof r.date !== "string") continue;
    // Recompute rather than trust: an id that disagrees with its own fields
    // would silently break convergence, which is the one thing it is for.
    byId.set(completionId(r.habitId, r.date), {
      id: completionId(r.habitId, r.date),
      habitId: r.habitId,
      date: r.date,
    });
  }
  return [...byId.values()];
}

/**
 * Give every task a `sort` key, preserving the order the array already had.
 *
 * Spaced by SORT_STEP rather than 0,1,2 so a later insertion between two
 * tasks has room for a fraction without renumbering anything -- renumbering
 * would be a write to every record, which is exactly what this change is
 * getting rid of.
 */
function withTaskSortKeys(projects: Project[]): Project[] {
  let changed = false;
  const next = projects.map((project) => {
    if (!Array.isArray(project?.tasks)) return project;
    if (project.tasks.every((t) => typeof t?.sort === "number")) return project;
    changed = true;
    return {
      ...project,
      tasks: project.tasks.map((t, i) => ({
        ...t,
        sort: typeof t?.sort === "number" ? t.sort : (i + 1) * SORT_STEP,
      })),
    };
  });
  // Return the original array when nothing needed a key, so an already-migrated
  // store is not rewritten on every load.
  return changed ? next : projects;
}

/**
 * Already-new data (`schemaVersion` ≥ 3): defensively fill any missing
 * top-level domains so later additions never crash an existing store.
 *
 * `work` and `finance` are deliberately absent. A store written before their
 * removal still has those keys; they are dropped on load, because normalize()
 * rebuilds from a whitelist rather than spreading the input. The data is not
 * migrated anywhere — the domains are gone, not moved.
 */
export function normalize(parsed: Record<string, unknown>): NexusData {
  const d = makeDefaultData();
  const p = parsed as Partial<NexusData>;
  return {
    schemaVersion: NEW_SCHEMA_VERSION,
    settings: { ...d.settings, ...(p.settings ?? {}) },
    academics: {
      ...d.academics,
      ...(p.academics ?? {}),
      studyPlanner: {
        ...d.academics.studyPlanner,
        ...(p.academics?.studyPlanner ?? {}),
      },
    },
    /*
     * `normalizeProject` runs here too, and it did not in nexus.
     *
     * `Project.milestones` and `Project.timeLog` are NOT optional in the type,
     * and a schema-3 project can be missing both. nexus never noticed because
     * its loader routed schema 3 to `migrateLegacy` — which does call
     * `normalizeProject` — so the only stores reaching `normalize` were
     * already on 4 and already complete. Fixing that routing (see
     * `RECORDS_SCHEMA_VERSION` in db.ts) makes this the live path, and without
     * this call it hands screens a `NexusData` whose `milestones` is
     * `undefined` while its type promises an array. `p.milestones.length` is
     * then a crash on the first render after an upgrade.
     *
     * Safe to apply to an already-complete project: it spreads first and only
     * fills what is missing, so the result compares equal to its input and the
     * next diff has nothing to say.
     */
    projects: withTaskSortKeys(
      (Array.isArray(p.projects) ? p.projects : d.projects).map((project) =>
        normalizeProject(project as unknown as Record<string, unknown>),
      ),
    ),
    career: { ...d.career, ...(p.career ?? {}) },
    journal: {
      ...d.journal,
      ...(p.journal ?? {}),
      // Habits and their ticks are reconciled together, because the ticks
      // used to live *inside* the habit. A store written before schema 4 has
      // `habits[].completions` and no `habitCompletions`; one written after
      // has the reverse. Both must load, and a half-migrated file -- written
      // by an older client after a newer one had already run -- must not lose
      // either side, so the two sources are merged rather than chosen between.
      habits: stripInlineCompletions((p.journal as { habits?: unknown })?.habits),
      habitCompletions: dedupeCompletions([
        ...liftCompletions((p.journal as { habits?: unknown })?.habits),
        ...(Array.isArray(p.journal?.habitCompletions) ? p.journal.habitCompletions : []),
      ]),
    },
    dashboard: { ...d.dashboard, ...(p.dashboard ?? {}) },
    routine: { ...d.routine, ...(p.routine ?? {}) },
    roadmap: p.roadmap ?? d.roadmap,
    research: {
      experiments: Array.isArray((p.research as { experiments?: unknown })?.experiments)
        ? ((p.research as { experiments: Experiment[] }).experiments)
        : [],
    },
  };
}
