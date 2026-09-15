/**
 * The banking ledger: which finished work has become evidence, and which has
 * not.
 *
 * The plan is unusually blunt about why this exists, so it is quoted rather
 * than paraphrased:
 *
 * > `career` stays, and is not peripheral — it is the point. The four tracks
 * > exist to produce a career outcome; jobs, certifications and the roadmap are
 * > where learning becomes evidence of learning. That also makes `career` the
 * > natural place the four tracks *terminate* — a course that never surfaces on
 * > the career side is a course whose value was never banked.
 *
 * A straight port of two screens side by side renders the career side and the
 * four tracks as two unrelated things, which is exactly the state the sentence
 * above describes as a failure. So the screen's first tab is this: every piece
 * of *finished* work from the four tracks, and whether anything on the career
 * side names it.
 *
 * Three states, not two
 * ---------------------
 * "Banked / not banked" would be a lie by simplification, because the roadmap
 * is a plan and a résumé is evidence, and conflating them makes writing a
 * to-do look like having done it:
 *
 * - **`"record"`** — named in a job application (its notes, prep notes, résumé
 *   version or next action) or in a certification. These are the artefacts
 *   somebody outside this app actually reads. This is banked.
 * - **`"planned"`** — named only in the roadmap: a phase goal, a phase task, a
 *   layer, a resource, the through-line. You have decided to bank it. You have
 *   not banked it.
 * - **`"unbanked"`** — named nowhere on the career side. This is the fact the
 *   screen exists to show.
 *
 * The three-way split also makes the remedy honest: the "add to roadmap"
 * action on the screen moves an item from `unbanked` to `planned`, which is
 * real progress and is visibly *not* the same as being on the record. A
 * two-state ledger would have flipped it to "banked" and been wrong.
 *
 * Why matching is textual, and why that is not a cop-out
 * -----------------------------------------------------
 * There is no `Course.bankedAs` field, and adding one is not this screen's
 * call (`lib/**` is out of scope) — but more to the point, a link field would
 * measure the wrong thing. Banking is not a pointer; it is whether the words
 * appear in the artefact. A résumé line that does not mention the course is
 * not evidence of the course, whatever a foreign key says.
 *
 * So: token-sequence matching, not substring matching. `"AI"` as a substring
 * hits "ch**ai**n", "tr**ai**ning" and "expl**ai**n"; a contiguous run of
 * whole tokens does not. Both sides are normalised to lowercase alphanumeric
 * tokens first, so "Deep-Learning" matches "deep learning".
 *
 * The one honest limitation, stated rather than hidden: a needle shorter than
 * `MIN_NEEDLE` characters is not searched at all, because a one- or
 * two-character token matches far too much to mean anything. Such an item
 * reads as `unbanked` and `matchable: false` says why, so the row can tell the
 * user the title is too short to find rather than implying they never banked
 * it.
 *
 * Pure, and typed against the model
 * ---------------------------------
 * No React in here — `.tsx` only because this directory's brief allows that
 * extension and no other (the ui kit's `index.tsx` carries the same note). The
 * inputs are `Pick<>`s of the real interfaces rather than hand-written shapes,
 * so renaming `Job.prepNotes` breaks this file at compile time instead of
 * quietly reducing the evidence surface to nothing.
 */
import type {
  Certification,
  Course,
  Experiment,
  Job,
  Project,
  RoadmapLayer,
  RoadmapPhase,
  StudyModule,
  StudyPlan,
} from "@/lib/nexus/types";
import { byId } from "./order";

/**
 * The four tracks, in the order they feed each other.
 *
 * Declared here rather than imported from `config/nav.ts`'s `TRACKS`, which
 * holds the same four ids. That list is typed `ScreenId[]` — an eight-member
 * union including `career` and `brain` — so a `Record<ScreenId, …>` keyed off
 * it would demand four buckets that cannot exist. A four-member union is the
 * type this file actually needs, and the duplication is one line that a
 * `satisfies`-style cross-check could not make safer without importing a
 * component-layer module into a pure one.
 */
export const TRACK_ORDER = ["courses", "projects", "research", "learn"] as const;
export type Track = (typeof TRACK_ORDER)[number];

export const TRACK_LABEL: Record<Track, string> = {
  courses: "Courses",
  projects: "Projects",
  research: "Research",
  learn: "Self-learning",
};

export type BankState = "record" | "planned" | "unbanked";

/** Shortest needle worth searching for. See the module note. */
export const MIN_NEEDLE = 3;

/* ── normalisation ─────────────────────────────────────────────────────── */

/**
 * Lowercase alphanumeric tokens. Everything else is a separator, which is what
 * makes "Deep-Learning", "deep learning" and "Deep_Learning" the same needle.
 */
export function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * A searchable needle, or `null` when the title is too short to mean anything.
 *
 * Length is measured on the joined tokens, not the raw string: `"C++"` is two
 * characters of signal and eleven of punctuation, and searching for `c` would
 * match every word containing a c.
 */
export function needle(title: string): string[] | null {
  const t = tokens(title);
  const n = t.join("").length;
  return n >= MIN_NEEDLE ? t : null;
}

/**
 * Whether `hay` contains `pin` as a contiguous run of whole tokens.
 *
 * An empty pin matches nothing rather than everything — the alternative is
 * that a record with no title is reported as banked by every surface in the
 * app.
 */
export function containsRun(hay: readonly string[], pin: readonly string[]): boolean {
  if (pin.length === 0 || pin.length > hay.length) return false;
  for (let i = 0; i <= hay.length - pin.length; i++) {
    let hit = true;
    for (let j = 0; j < pin.length; j++) {
      if (hay[i + j] !== pin[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return true;
  }
  return false;
}

/* ── the two career-side surfaces ──────────────────────────────────────── */

/** One searchable place on the career side, with a label a person recognises. */
export interface Surface {
  /** Shown in the row as "where": "Acme — ML Engineer", "Phase 2", … */
  label: string;
  tokens: string[];
}

type JobLike = Pick<
  Job,
  "id" | "company" | "role" | "notes" | "prepNotes" | "resumeVersion" | "nextAction"
>;
type CertLike = Pick<Certification, "id" | "name" | "notes">;
type PhaseLike = Pick<RoadmapPhase, "id" | "title" | "goal" | "tasks">;
type LayerLike = Pick<
  RoadmapLayer,
  "id" | "name" | "what" | "role" | "methods" | "tools" | "resources" | "demo"
>;

/**
 * Evidence: the things somebody outside this app reads.
 *
 * `company` and `role` are deliberately NOT searched. They are the label, not
 * the content — including them would bank a course called "Research" against
 * every application for a research role, which is the class of false positive
 * that makes a needs-attention list unreadable.
 */
export function evidenceSurfaces(
  jobs: readonly JobLike[],
  certs: readonly CertLike[],
): Surface[] {
  return [
    ...byId(jobs).map((j) => ({
      label: `${j.company} — ${j.role}`,
      tokens: tokens([j.notes, j.prepNotes, j.resumeVersion, j.nextAction].join(" \n ")),
    })),
    // A cert's own name is content here: "Deep Learning Specialization" is
    // itself the evidence that banks a deep-learning course.
    ...byId(certs).map((c) => ({
      label: c.name || "Untitled certification",
      tokens: tokens([c.name, c.notes].join(" \n ")),
    })),
  ];
}

/** The plan: decided, not yet shown to anyone. */
export function planSurfaces(
  phases: readonly PhaseLike[],
  layers: readonly LayerLike[],
  throughLine: string,
): Surface[] {
  return [
    ...byId(phases).map((p) => ({
      label: p.title || "Untitled phase",
      tokens: tokens([p.title, p.goal, ...byId(p.tasks).map((t) => t.text)].join(" \n ")),
    })),
    ...byId(layers).map((l) => ({
      label: l.name || "Untitled layer",
      tokens: tokens(
        [
          l.name,
          l.what,
          l.role,
          ...l.methods,
          ...byId(l.tools).flatMap((g) => [g.group, ...g.items]),
          ...byId(l.resources).map((r) => r.label),
          l.demo.name,
          ...l.demo.flow,
        ].join(" \n "),
      ),
    })),
    { label: "Through-line", tokens: tokens(throughLine) },
  ];
}

/* ── the four tracks' finished work ────────────────────────────────────── */

/** One piece of finished work that is due to have become evidence. */
export interface TrackItem {
  track: Track;
  id: string;
  title: string;
  /** Other names that also count as a mention — a course code, say. */
  aliases: readonly string[];
  /** Why it counts as finished. Shown, so the rule is never implicit. */
  why: string;
}

type CourseLike = Pick<Course, "id" | "name" | "code" | "grade">;
type ProjectLike = Pick<Project, "id" | "name" | "status">;
type ExperimentLike = Pick<Experiment, "id" | "name" | "status">;
type PlanLike = Pick<StudyPlan, "id" | "name"> & {
  modules: readonly Pick<StudyModule, "topics">[];
};

export interface BankingInput {
  courses: readonly CourseLike[];
  projects: readonly ProjectLike[];
  experiments: readonly ExperimentLike[];
  plans: readonly PlanLike[];
  jobs: readonly JobLike[];
  certifications: readonly CertLike[];
  phases: readonly PhaseLike[];
  layers: readonly LayerLike[];
  throughLine: string;
}

/**
 * A study plan is finished when every topic in it is ticked.
 *
 * `total > 0` matters: an empty plan has no unticked topics, so a bare
 * `every()` calls it complete and files a plan nobody has started under work
 * that should be on a résumé.
 */
export function planComplete(plan: PlanLike): boolean {
  let total = 0;
  let done = 0;
  for (const m of plan.modules) {
    for (const t of m.topics) {
      total++;
      if (t.done) done++;
    }
  }
  return total > 0 && done === total;
}

/**
 * The finished work of the four tracks, ordered by id within each track.
 *
 * "Finished" is per-track and each rule is the track's own definition of done
 * rather than a guess:
 *
 * - a course carries a `grade` (`""` means ungraded, i.e. still running);
 * - a project's `status` is `Completed` or `Archived`;
 * - an experiment's `status` is `done` — `abandoned` is deliberately excluded,
 *   since an abandoned experiment is not evidence of anything and listing it
 *   would train the user to ignore this list;
 * - every topic of a study plan is ticked.
 *
 * Work still in flight is not here at all. A ledger that reported an in-progress
 * course as unbanked would be permanently red for doing nothing wrong.
 */
export function terminalItems(input: BankingInput): TrackItem[] {
  const courses = byId(input.courses)
    .filter((c) => c.grade !== "")
    .map<TrackItem>((c) => ({
      track: "courses",
      id: c.id,
      title: c.name,
      aliases: c.code ? [c.code] : [],
      why: `graded ${c.grade}`,
    }));

  const projects = byId(input.projects)
    .filter((p) => p.status === "Completed" || p.status === "Archived")
    .map<TrackItem>((p) => ({
      track: "projects",
      id: p.id,
      title: p.name,
      aliases: [],
      why: p.status.toLowerCase(),
    }));

  const experiments = byId(input.experiments)
    .filter((e) => e.status === "done")
    .map<TrackItem>((e) => ({
      track: "research",
      id: e.id,
      title: e.name,
      aliases: [],
      why: "experiment done",
    }));

  const plans = byId(input.plans)
    .filter(planComplete)
    .map<TrackItem>((p) => ({
      track: "learn",
      id: p.id,
      title: p.name,
      aliases: [],
      why: "all topics done",
    }));

  // Concatenated in TRACK_ORDER so the screen's grouping needs no second sort.
  return [...courses, ...projects, ...experiments, ...plans];
}

/* ── the ledger ────────────────────────────────────────────────────────── */

export interface LedgerRow extends TrackItem {
  state: BankState;
  /** The surface that named it, or `""` when nothing did. */
  where: string;
  /** False when the title is too short to search for. See `MIN_NEEDLE`. */
  matchable: boolean;
}

/** Where, if anywhere, a set of surfaces names this item. */
function findIn(surfaces: readonly Surface[], pins: readonly string[][]): string | null {
  for (const s of surfaces) {
    for (const pin of pins) {
      if (containsRun(s.tokens, pin)) return s.label;
    }
  }
  return null;
}

/** One item's verdict. Evidence wins over plan; both win over nothing. */
export function classify(
  item: TrackItem,
  evidence: readonly Surface[],
  plan: readonly Surface[],
): LedgerRow {
  const pins = [item.title, ...item.aliases]
    .map(needle)
    .filter((n): n is string[] => n !== null);

  if (pins.length === 0) {
    return { ...item, state: "unbanked", where: "", matchable: false };
  }
  const onRecord = findIn(evidence, pins);
  if (onRecord !== null) return { ...item, state: "record", where: onRecord, matchable: true };
  const planned = findIn(plan, pins);
  if (planned !== null) return { ...item, state: "planned", where: planned, matchable: true };
  return { ...item, state: "unbanked", where: "", matchable: true };
}

/** The whole ledger, in track order then id order. */
export function ledger(input: BankingInput): LedgerRow[] {
  const evidence = evidenceSurfaces(input.jobs, input.certifications);
  const plan = planSurfaces(input.phases, input.layers, input.throughLine);
  return terminalItems(input).map((item) => classify(item, evidence, plan));
}

/** Counts for the stat band. Separate so the screen never folds twice. */
export interface LedgerTally {
  total: number;
  record: number;
  planned: number;
  unbanked: number;
  /** Per track, for the group headers. */
  byTrack: Record<Track, { total: number; unbanked: number }>;
}

export function tally(rows: readonly LedgerRow[]): LedgerTally {
  const byTrack = {
    courses: { total: 0, unbanked: 0 },
    projects: { total: 0, unbanked: 0 },
    research: { total: 0, unbanked: 0 },
    learn: { total: 0, unbanked: 0 },
  } satisfies Record<Track, { total: number; unbanked: number }>;

  let record = 0;
  let planned = 0;
  let unbanked = 0;
  for (const r of rows) {
    const t = byTrack[r.track];
    t.total++;
    if (r.state === "record") record++;
    else if (r.state === "planned") planned++;
    else {
      unbanked++;
      t.unbanked++;
    }
  }
  return { total: rows.length, record, planned, unbanked, byTrack };
}

/**
 * The roadmap task text an "add to roadmap" remedy writes.
 *
 * Here rather than in the component because the ledger has to be able to find
 * it again afterwards: the text must contain the item's title verbatim, or the
 * row would stay `unbanked` after the user acted on it and the button would
 * look broken. That coupling is a fact about the matcher, so it lives next to
 * the matcher.
 */
export const bankTaskText = (title: string): string =>
  `Bank ${title} — put it on the résumé or in a portfolio writeup`;

/** The prep-note line the "bank on an application" remedy prefills. */
export const bankNoteText = (title: string, why: string): string =>
  `${title} (${why}) — what it shows: `;
