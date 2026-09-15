/**
 * The entire Nexus data model — the formal schema the legacy app lacked.
 * Persistence is a single JSON object (see lib/db.ts). One source of truth.
 */
import type {
  AssignmentStatus, Priority, ProjectStatus,
  JobStatus, CertStatus, ReadingType, ReadingStatus, Grade,
} from "./constants";

export type ID = string;
export type ISODate = string; // "YYYY-MM-DD"
export type ISODateTime = string; // full ISO timestamp

/*
 * `TxType = "income" | "expense"` used to sit here and did not come across. It
 * is the last vocabulary of the removed `finance` domain — an alias with no
 * referent anywhere in the model. Porting it would leave behind a type that
 * invites someone to build the domain back, which is the one thing this model
 * is explicit about not doing.
 */

export const NEW_SCHEMA_VERSION = 4;

/* ───────────── Academics ───────────── */

export interface Assignment {
  id: ID;
  name: string;
  status: AssignmentStatus;
  dueDate: ISODate;
  weight: number | string; // % of course grade (string "" allowed for empty input)
  grade: number | string; // 0–100 (string "" allowed for empty input)
  reminder: boolean;
}

export interface Course {
  id: ID;
  name: string;
  code: string;
  credits: number;
  semester: string;
  grade: Grade | ""; // "" = ungraded
  assignments: Assignment[];
}

/* ───────────── Study ───────────── */

export interface Topic {
  id: ID;
  name: string;
  done: boolean;
  doneAt: ISODateTime | null;
}

export interface StudyModule {
  id: ID;
  name: string;
  topics: Topic[];
}

export interface StudyPlan {
  id: ID;
  name: string;
  course: string;
  deadline: ISODate;
  modules: StudyModule[];
}

export interface StudySession {
  id: ID;
  date: ISODateTime;
  duration: number; // minutes
  plan: ID | null;
  topic: string;
  xp: number;
  notes?: string;
  tags?: string[];
}

export interface PomodoroSettings {
  focus: number;
  shortBreak: number;
  longBreak: number;
  rounds: number;
}

export interface StudyPlanner {
  plans: StudyPlan[];
  /**
   * The source of truth for everything below. Each session carries its own
   * `xp`, so totals are a fold over this list rather than a stored number.
   */
  sessions: StudySession[];
  pomodoroSettings: PomodoroSettings;
  weeklyGoalMinutes: number;
  streakFreezeDate?: ISODate;
}

/*
 * `xp`, `streak` and `lastStudyDate` used to live on StudyPlanner. They are
 * gone, and that is a sync fix rather than a tidy-up.
 *
 * `xp` was a true accumulator — `planner.xp += xp` on add, `-= s.xp` on
 * delete. **Last-writer-wins on a counter loses increments.** Log a session on
 * the phone and one on the laptop in the same offline window and one device's
 * total overwrites the other's, so the XP from the losing session is gone
 * while the session itself survives — a total that disagrees with the list it
 * is meant to summarise, and nothing to say which is right.
 *
 * `streak` and `lastStudyDate` were already derived and merely cached, which
 * is the same hazard with a smaller blast radius: a stale cache that LWW can
 * resurrect over a fresh one.
 *
 * Deriving them removes the class of bug rather than handling it. There is
 * nothing to merge, so there is nothing to lose — and `sessions` is a
 * per-record collection, which merges correctly on its own.
 *
 * See `totalXp`, `calculateStreak` and `lastStudyDate` in `lib/study.ts`.
 */

export interface Academics {
  courses: Course[];
  semesters: string[];
  studyPlanner: StudyPlanner;
}

/* ───────────── Projects ───────────── */

export interface Attachment {
  name?: string;
  original_name: string;
  stored_name: string;
  size: number;
  file_type?: string;
  is_image: boolean;
}

export interface ProjectTask {
  id: ID;
  name: string;
  priority: Priority;
  done: boolean;
  doneAt: ISODateTime | null;
  notes: string;
  attachments: Attachment[];
  /**
   * Fractional sort key. Order is `sort` ascending, then `id` as a tiebreak.
   *
   * Reordering used to be an index splice on the array, and a positional
   * index is not an identity: two devices reordering the same list produce
   * two different arrays with no way to reconcile them, and the merge result
   * is arbitrary rather than either user's intent.
   *
   * A fractional key makes a move a write to ONE record -- the moved task
   * gets a value between its new neighbours -- so a concurrent move of a
   * different task in the same list does not conflict at all. The two moves
   * commute, which is the property the array version could never have.
   *
   * Optional so a store written before this field loads unchanged; migrate
   * assigns keys from the existing array order.
   */
  sort?: number;
}

export interface Milestone {
  id: ID;
  name: string;
  done: boolean;
  doneAt: ISODateTime | null;
}

export interface TimeEntry {
  id: ID;
  date: ISODate;
  duration: number; // minutes
  description: string;
}

/* ── Developer add-ons (all optional; back-compat for existing projects) ── */

export interface RunCommand {
  id: ID;
  label: string; // "dev", "build", "test"
  cmd: string; // "npm run dev"
}
export interface EnvVar {
  id: ID;
  key: string;
  value: string;
}
export interface ResourceLink {
  id: ID;
  label: string;
  url: string;
}
/** Per-project runbook: how to run it + where its resources live. */
export interface Runbook {
  commands: RunCommand[];
  env: EnvVar[];
  ports: number[];
  links: ResourceLink[];
}

export interface Release {
  id: ID;
  version: string;
  date: ISODate;
  notes: string;
  url: string;
}

/** Architecture Decision Record. */
export interface Decision {
  id: ID;
  title: string;
  context: string;
  decision: string;
  consequences: string;
  status: "Proposed" | "Accepted" | "Superseded";
  date: ISODate;
}

export interface Project {
  id: ID;
  name: string;
  description: string;
  directory: string;
  status: ProjectStatus;
  priority: Priority;
  startDate: ISODate;
  endDate: ISODate;
  tasks: ProjectTask[];
  milestones: Milestone[];
  timeLog: TimeEntry[];
  /** Developer add-ons — optional so pre-existing projects load unchanged. */
  runbook?: Runbook;
  releases?: Release[];
  decisions?: Decision[];
}

/* ───────────── Career ───────────── */

export interface Job {
  id: ID;
  company: string;
  role: string;
  status: JobStatus;
  dateApplied: ISODate;
  salary: string;
  url: string;
  contact: string;
  nextAction: string;
  notes: string;
  prepNotes: string;
  resumeVersion: string;
}

export interface Certification {
  id: ID;
  name: string;
  provider: string;
  status: CertStatus;
  expiryDate: ISODate;
  cost: string;
  link: string;
  notes: string;
}

export interface Career {
  jobs: Job[];
  certifications: Certification[];
}

/* ───────────── Journal ───────────── */

export interface JournalEntry {
  id: ID;
  date: ISODate;
  content: string;
  mood: number; // 1–5
}

export interface Habit {
  id: ID;
  name: string;
  color: string;
}

/**
 * One tick of one habit on one day, as its own record.
 *
 * It used to be `Habit.completions: ISODate[]`, and `toggleHabit` replaced the
 * whole array. That is invisible on one device and a data-loss bug the moment
 * there are two: under any whole-record merge, ticking habits on the phone and
 * on the laptop within one offline window means one device's array overwrites
 * the other's, and every day recorded only on the loser is gone. Habit-ticking
 * is *the* phone activity, so it was the most likely real loss in the app.
 *
 * `id` is derived and not random -- `${habitId}:${date}` -- which is the part
 * that actually does the work. Two devices ticking the same habit on the same
 * day independently produce the *same* record id, so they converge onto one
 * record instead of merging into two identical ticks. A `uid()` here would
 * make the schema per-record and still be wrong.
 */
export interface HabitCompletion {
  /** Always `completionId(habitId, date)`. Never generated. */
  id: ID;
  habitId: ID;
  date: ISODate;
}

/** The one place this key is constructed. */
export const completionId = (habitId: ID, date: ISODate): ID => `${habitId}:${date}`;

export interface ReadingItem {
  id: ID;
  title: string;
  author: string;
  type: ReadingType;
  status: ReadingStatus;
  url: string;
  notes: string;
}

export type FragmentType = "seed" | "thread" | "principle" | "action";

/** A categorized journal fragment. Recurs (visible mark) and promotes to The Room at 3×. */
export interface Fragment {
  id: ID;
  date: ISODate; // YYYY-MM-DD (local)
  category: string; // category id (see JOURNAL_CATEGORIES)
  fragment: string; // the thought, one line
  body?: string; // "why it matters" (optional)
  type: FragmentType;
  recurrence: number; // bumped each time the thought returns (default 1)
  promoted: boolean; // true = lives in The Room
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface Journal {
  entries: JournalEntry[];
  habits: Habit[];
  /** Flat, one record per (habit, day). See HabitCompletion for why. */
  habitCompletions: HabitCompletion[];
  readingList: ReadingItem[];
  fragments: Fragment[];
}

/* ───────────── Dashboard ───────────── */

export interface DashboardTodo {
  id: ID;
  text: string;
  done: boolean;
  dueDate: ISODate | null;
  order: number;
  createdAt: ISODateTime;
}

export interface Dashboard {
  todos: DashboardTodo[];
}

/* ───────────── Routine (nightly check-in) ───────────── */

export interface Routine {
  lastCompletedDate: ISODate | null;
  time: string; // "HH:MM", default "23:30"
}

/* ───────────── Roadmap (co-op / career roadmap) ───────────── */

export type Proficiency = "none" | "learning" | "working" | "solid";

export interface RoadmapTask {
  id: ID;
  text: string;
  done: boolean;
}

export interface RoadmapPhase {
  id: ID;
  title: string;
  period: string; // human label, e.g. "Jul–Sep 2026"
  start: ISODate;
  end: ISODate;
  goal: string;
  tasks: RoadmapTask[];
}

export interface LayerResource {
  id: ID;
  label: string;
  url: string;
}

export interface LayerToolGroup {
  id: ID;
  group: string; // e.g. "Frameworks & libraries"
  items: string[];
}

export interface RoadmapLayer {
  id: ID;
  name: string;
  tag: string; // "Differentiator" | "Flex" | "Gate" | "Foundation" | "Working knowledge"
  target: string; // target by co-op start
  proficiency: Proficiency; // self-rated current level
  what: string;
  role: string;
  tools: LayerToolGroup[];
  methods: string[];
  resources: LayerResource[];
  demo: { name: string; tree: string; flow: string[] };
}

export interface Roadmap {
  deadline: ISODate; // "the real deadline" — Sep 2026
  principles: string[];
  phases: RoadmapPhase[];
  layers: RoadmapLayer[];
  lane: string;
  realityCheck: string;
  throughLine: string;
}

/* ───────────── Settings ───────────── */

export interface Settings {
  baseCurrency: string;
}

/* ───────────── Root ───────────── */

export interface NexusData {
  schemaVersion: number;
  settings: Settings;
  academics: Academics;
  projects: Project[];
  career: Career;
  journal: Journal;
  dashboard: Dashboard;
  routine: Routine;
  roadmap: Roadmap;
}
