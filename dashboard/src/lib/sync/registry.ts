/**
 * Stage 3b: the declarative registry, and the flatten/rehydrate it drives.
 *
 * 3a already moved records one at a time — the server stores opaque JSON keyed
 * by `(collection, id)` and the client diffs a `collection -> id -> record`
 * snapshot. What 3a did *not* have was a description of how the app's blob maps
 * onto that shape, so the only honest granularity was "one record per
 * top-level domain".
 *
 * That coarseness has a specific cost: editing two different journal entries on
 * two devices within one offline window is a conflict on the whole `journal`
 * slice, and one device's edit loses. Per-record granularity removes it.
 *
 * The plan's actual requirement for this stage is not "be per-record" but:
 *
 * > One declarative registry file is the only thing that changes.
 *
 * So `flatten` and `rehydrate` below know nothing about journals or projects.
 * They know three structural shapes. Adding a collection is one line in
 * `NEXUS_REGISTRY`, and the ~11k lines of screens never learn that sync
 * exists — they keep reading the nested blob they always read.
 *
 * Why the blob survives at all
 * ----------------------------
 * The screens are written against nested `NexusData`. Rewriting them to read a
 * flat record store would be the largest change in the project and would buy
 * nothing: the blob is the *in-memory* shape, and flat records are the *wire*
 * shape. Converting between them costs microseconds on a 38 KB dataset.
 */

/**
 * One collection: a path into the blob and how to identify its records.
 *
 * Three kinds, because the model has exactly three shapes:
 *
 * - `singleton` — the subtree at `path` is one record. For genuinely
 *   scalar-ish state (`settings`, `routine`, a list of semester names with no
 *   ids). Two devices editing it in one window do conflict, and that is
 *   accepted: there is no sub-identity to key on, and inventing one would be
 *   worse than a conflict you can see.
 * - `records` — an array of objects carrying `id`, at `path`.
 * - `nested` — an array of objects carrying `id`, inside *each* record of a
 *   parent array. `path` marks the parent with `[]`, e.g. `projects[].tasks`.
 *   Keyed `parentId:childId`, because child ids are only unique within their
 *   parent in this model — two projects may both hold a task `t1`.
 */
export interface CollectionSpec {
  /** Server-side collection name. Half the record's primary key; never reuse one. */
  name: string;
  /** Dotted path from the blob root. `[]` marks the parent array for `nested`. */
  path: string;
  kind: "singleton" | "records" | "nested";
}

export type Registry = readonly CollectionSpec[];

/** A record dropped during rehydrate because its parent was gone. */
export interface Orphan {
  collection: string;
  id: string;
}

type Obj = Record<string, unknown>;

/** The separator in a nested record's key. */
const SEP = ":";

/**
 * The collection holding everything the registry does not describe.
 *
 * Named, not inlined, because the server treats it as an ordinary collection
 * and renaming it later would orphan every device's copy.
 */
export const REST = "__rest__";

export const collectionsOf = (r: Registry): string[] => r.map((s) => s.name);

/**
 * A nested record's key: both ids, percent-encoded, joined by a separator.
 *
 * The obvious scheme is `${parentId}:${childId}` split on the first colon, and
 * it is wrong on this app's real data. Ids here contain colons on **both**
 * sides: the roadmap seed mints `seed:phase:ship-the-flagship` and
 * `seed:task:build-an-eval-harness`, and a habit completion's id is
 * `${habitId}:${date}`. Splitting `seed:phase:x:seed:task:y` on the first
 * colon yields a parent of `"seed"`, which matches no project — so every child
 * becomes an orphan and is dropped.
 *
 * That is not a hypothetical. The naive version passed 22 unit tests and then
 * lost **every one of the 90 records** in a real default blob, silently,
 * because the fixtures used ids like `p1` and `t1`. Splitting on the *last*
 * colon fails symmetrically on the completion ids.
 *
 * `encodeURIComponent` escapes `:` (and `%`), so each component is separator-
 * free by construction and the split is unambiguous for *any* id, including
 * ones from schemes that do not exist yet.
 *
 * One consequence for callers: a key is **not** safe to drop into a URL path.
 * It contains percent-escapes, and the server's stack decodes the path before
 * routing — so `%3A` arrives as `:` however many times you escape it, and the
 * server looks up an id that exists nowhere and answers 200 with an empty
 * result. `GET /api/sync/history` therefore takes `collection` and `id` as
 * query parameters, where one encode and one decode round-trip exactly.
 */
export const joinKey = (parent: string, child: string): string =>
  `${encodeURIComponent(parent)}${SEP}${encodeURIComponent(child)}`;

export function splitKey(key: string): { parent: string; child: string } {
  const at = key.indexOf(SEP);
  // No separator: a key that was never a nested one. Report an empty parent
  // rather than guessing, so the caller treats it as an orphan instead of
  // attaching it to something arbitrary.
  if (at < 0) return { parent: "", child: decodeURIComponent(key) };
  return {
    parent: decodeURIComponent(key.slice(0, at)),
    child: decodeURIComponent(key.slice(at + 1)),
  };
}

/**
 * Canonical record order: by key, ascending.
 *
 * Array *position* is not a synced property. Records arrive one at a time in
 * whatever order the server's `seq` hands them over, so if `rehydrate` simply
 * appended in arrival order, two devices holding an identical record set would
 * rebuild different blobs — and the plan's commutativity property would be
 * false. Not visibly false, either: both devices would sync clean and just
 * render their lists differently forever.
 *
 * Sorting by key is what makes the order a function of the data alone. It is
 * also faithful to the real ids rather than arbitrary: nexus's `uid()` is
 * `Date.now().toString(36)` plus five random characters, and that time prefix
 * is a fixed eight characters until 2059 — so ascending key order *is*
 * creation order for everything the app mints, which is the order the arrays
 * were in before flattening.
 *
 * The standing consequence, for Stage 4: **a screen may not depend on array
 * position.** Order by a field — `sort`, a date, a name. `ProjectTask.sort`
 * and `orderTasks()` exist for exactly this reason.
 */
const byKey = (a: [string, unknown], b: [string, unknown]): number =>
  a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;

/** Bucket → array, in canonical order. */
const ordered = (bucket: Record<string, unknown>): unknown[] =>
  Object.entries(bucket).sort(byKey).map(([, v]) => v);

function getPath(root: Obj, path: string): unknown {
  let node: unknown = root;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Obj)[part];
  }
  return node;
}

function setPath(root: Obj, path: string, value: unknown): void {
  const parts = path.split(".");
  let node = root;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (next === null || typeof next !== "object") node[part] = {};
    node = node[part] as Obj;
  }
  node[parts[parts.length - 1]!] = value;
}

function deletePath(root: Obj, path: string): void {
  const parts = path.split(".");
  let node: unknown = root;
  for (const part of parts.slice(0, -1)) {
    if (node === null || typeof node !== "object") return;
    node = (node as Obj)[part];
  }
  if (node !== null && typeof node === "object") delete (node as Obj)[parts[parts.length - 1]!];
}

/** `projects[].tasks` → `{ parentPath: "projects", childKey: "tasks" }` */
function splitNested(path: string): { parentPath: string; childKey: string } {
  const at = path.indexOf("[]");
  if (at < 0) throw new Error(`a nested path must contain "[]": ${path}`);
  return { parentPath: path.slice(0, at), childKey: path.slice(at + 3) };
}

/**
 * Blob → `collection -> id -> record`.
 *
 * Registered subtrees are **removed** from the leftover, and whatever remains
 * becomes the `__rest__` singleton. That is what makes the round-trip total:
 * `schemaVersion`, and any field a future build adds that this registry has
 * never heard of, survive rather than being silently dropped.
 *
 * Dropping them is the "old client eats new data" failure at the sync layer,
 * and it is worse here than in a normal migration — the deletion does not stay
 * local, it propagates to every other device as an authoritative write.
 */
export function flatten(blob: Obj, registry: Registry): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  // Deep clone once: the leftover is mutated as registered subtrees are cut
  // out of it, and mutating the caller's blob would corrupt the live app state.
  const rest = structuredClone(blob) as Obj;

  // Nested FIRST, and this ordering is load-bearing rather than stylistic.
  //
  // A nested spec reads the parent array, and the parent's own spec *deletes*
  // that array once it has captured it. Run the parent first and the nested
  // pass finds nothing — every child silently vanishes and every project
  // record still carries its tasks inline, which is 3a's granularity wearing
  // 3b's collection names. (That was the first version of this function, and
  // six tests caught it.)
  //
  // Going nested-first also means the buckets below hold *references* into
  // `rest`, so stripping `parent[childKey]` here is visible to the parent
  // record captured in the second pass. One clone, no re-walk.
  for (const spec of registry) {
    if (spec.kind !== "nested") continue;
    const { parentPath, childKey } = splitNested(spec.path);
    const parents = getPath(rest, parentPath);
    if (!Array.isArray(parents)) continue;
    const bucket: Record<string, unknown> = {};
    for (const parent of parents as Obj[]) {
      const parentId = parent?.["id"];
      if (typeof parentId !== "string" || !parentId) continue;
      const children = parent[childKey];
      // Cut the children out of the parent's own record either way — an
      // absent `tasks` and an empty `tasks` both rehydrate to `[]`, so
      // leaving an empty array behind would be a diff-visible difference
      // between a blob and its own round-trip.
      delete parent[childKey];
      if (!Array.isArray(children)) continue;
      for (const child of children as Obj[]) {
        const childId = child?.["id"];
        if (typeof childId !== "string" || !childId) continue;
        bucket[joinKey(parentId, childId)] = child;
      }
    }
    out[spec.name] = bucket;
  }

  for (const spec of registry) {
    if (spec.kind === "nested") continue;

    if (spec.kind === "singleton") {
      const value = getPath(rest, spec.path);
      if (value !== undefined) {
        out[spec.name] = { [spec.name]: value };
        deletePath(rest, spec.path);
      }
      continue;
    }

    const list = getPath(rest, spec.path);
    if (!Array.isArray(list)) continue;
    const bucket: Record<string, unknown> = {};
    for (const item of list as Obj[]) {
      const id = item?.["id"];
      // A record with no id has no identity, so it cannot be merged or
      // tombstoned. Skipping is the only option — but it is a silent data
      // loss, so `migrate.ts` is where ids are guaranteed, not here.
      if (typeof id !== "string" || !id) continue;
      bucket[id] = item;
    }
    out[spec.name] = bucket;
    deletePath(rest, spec.path);
  }

  out[REST] = { [REST]: rest };
  return out;
}

/**
 * The default orphan reporter: complain.
 *
 * Silence was the default once, and it is how a key-format bug destroyed a
 * whole dataset without a single failing assertion. A caller that genuinely
 * wants quiet has to say so by passing `() => {}` — which is a decision in
 * the source, not an omission.
 */
function warnOrphan(o: Orphan): void {
  console.warn(`sync: dropped orphan ${o.collection}/${o.id} — its parent is gone`);
}

/**
 * `collection -> id -> record` → blob.
 *
 * `onOrphan` is called for every child whose parent is absent. Those children
 * are dropped, and the choice is deliberate: inventing a placeholder parent
 * would resurrect a project someone deleted on another device, which is a
 * worse outcome than losing the task. The record itself survives in the
 * server's append-only log either way, so the loss is recoverable — and
 * reporting it is what stops it being indistinguishable from "never existed".
 */
export function rehydrate(
  snapshot: Record<string, Record<string, unknown>>,
  registry: Registry,
  onOrphan: (o: Orphan) => void = warnOrphan,
): Obj {
  // Clone up front, because every write below would otherwise land in the
  // caller's snapshot: `Object.values(bucket)` hands out live references, and
  // the nested pass then writes `parent[childKey]` into them. The caller holds
  // this snapshot as its sync BASELINE, so a mutation here would move the
  // thing the next diff is measured against — and it would do so in the
  // direction that makes the diff look empty. Devices would agree to disagree
  // and never exchange another record. `applyPulled` avoids the same trap.
  const snap = structuredClone(snapshot) as Record<string, Record<string, unknown>>;

  const restRecord = snap[REST]?.[REST];
  const blob: Obj =
    restRecord !== null && typeof restRecord === "object" ? (restRecord as Obj) : {};

  // Singletons and parents first; nested last, so every parent array exists
  // before a child looks for it. This is what makes the order records arrive
  // in irrelevant.
  for (const spec of registry) {
    if (spec.kind === "singleton") {
      const value = snap[spec.name]?.[spec.name];
      if (value !== undefined) setPath(blob, spec.path, value);
    } else if (spec.kind === "records") {
      const bucket = snap[spec.name];
      if (bucket) setPath(blob, spec.path, ordered(bucket));
    }
  }

  for (const spec of registry) {
    if (spec.kind !== "nested") continue;
    const { parentPath, childKey } = splitNested(spec.path);
    const parents = getPath(blob, parentPath);
    const byId = new Map<string, Obj>();
    if (Array.isArray(parents)) {
      for (const p of parents as Obj[]) {
        if (typeof p?.["id"] === "string") byId.set(p["id"] as string, p);
      }
    }
    // Every parent gets the key, even with no children — so a project with an
    // empty task list round-trips as `[]` rather than losing the field. An
    // absent `tasks` and an empty `tasks` are different blobs, and the
    // round-trip property does not tolerate the difference.
    for (const p of byId.values()) p[childKey] = [];

    for (const [key, child] of Object.entries(snap[spec.name] ?? {}).sort(byKey)) {
      const { parent: parentId } = splitKey(key);
      const parent = byId.get(parentId);
      if (!parent) {
        onOrphan({ collection: spec.name, id: key });
        continue;
      }
      (parent[childKey] as unknown[]).push(child);
    }
  }

  return blob;
}

/**
 * The NexusData registry.
 *
 * **This file is the whole of Stage 3b.** Changing granularity means editing
 * this list; nothing above it and nothing in the app knows the difference.
 *
 * Where a line is drawn, and why:
 *
 * - `settings`, `routine`, `academics.semesters`, `pomodoroSettings` and
 *   `roadmap.meta` are singletons. They have no per-item identity —
 *   `semesters` is a bare `string[]` — so there is nothing to key on. A
 *   conflict on one of these is a visible conflict on a small object, which
 *   is a better outcome than a synthetic id that two devices mint differently.
 * - Everything with an `id` is its own record, including the nested arrays.
 *   Going nested is what makes "two devices editing two tasks of one project"
 *   a non-conflict, and it is the reason 3c's reconciler is an orphan sweep
 *   rather than an invariant reconciler — the plan's own observation.
 * - `projects[].runbook` is a singleton *per project*, not a collection: it is
 *   one optional object, not a list, and it has no id of its own. It rides in
 *   the project record.
 * - `roadmap.layers[].methods` and `demo` stay inside the layer for the same
 *   reason: `string[]` with no identity.
 */
export const NEXUS_REGISTRY: Registry = [
  // ── singletons ──
  { name: "settings", path: "settings", kind: "singleton" },
  { name: "routine", path: "routine", kind: "singleton" },
  { name: "academics.semesters", path: "academics.semesters", kind: "singleton" },
  {
    name: "academics.studyPlanner.pomodoroSettings",
    path: "academics.studyPlanner.pomodoroSettings",
    kind: "singleton",
  },
  {
    name: "academics.studyPlanner.weeklyGoalMinutes",
    path: "academics.studyPlanner.weeklyGoalMinutes",
    kind: "singleton",
  },
  {
    name: "academics.studyPlanner.streakFreezeDate",
    path: "academics.studyPlanner.streakFreezeDate",
    kind: "singleton",
  },
  { name: "roadmap.deadline", path: "roadmap.deadline", kind: "singleton" },
  { name: "roadmap.principles", path: "roadmap.principles", kind: "singleton" },
  { name: "roadmap.lane", path: "roadmap.lane", kind: "singleton" },
  { name: "roadmap.realityCheck", path: "roadmap.realityCheck", kind: "singleton" },
  { name: "roadmap.throughLine", path: "roadmap.throughLine", kind: "singleton" },

  // ── record collections ──
  { name: "academics.courses", path: "academics.courses", kind: "records" },
  { name: "academics.studyPlanner.plans", path: "academics.studyPlanner.plans", kind: "records" },
  {
    name: "academics.studyPlanner.sessions",
    path: "academics.studyPlanner.sessions",
    kind: "records",
  },
  { name: "projects", path: "projects", kind: "records" },
  { name: "career.jobs", path: "career.jobs", kind: "records" },
  { name: "career.certifications", path: "career.certifications", kind: "records" },
  { name: "journal.entries", path: "journal.entries", kind: "records" },
  { name: "journal.habits", path: "journal.habits", kind: "records" },
  { name: "journal.habitCompletions", path: "journal.habitCompletions", kind: "records" },
  { name: "journal.readingList", path: "journal.readingList", kind: "records" },
  { name: "journal.fragments", path: "journal.fragments", kind: "records" },
  { name: "dashboard.todos", path: "dashboard.todos", kind: "records" },
  { name: "roadmap.phases", path: "roadmap.phases", kind: "records" },
  { name: "roadmap.layers", path: "roadmap.layers", kind: "records" },
  { name: "research.experiments", path: "research.experiments", kind: "records" },

  // ── nested records ──
  { name: "academics.courses.assignments", path: "academics.courses[].assignments", kind: "nested" },
  { name: "projects.tasks", path: "projects[].tasks", kind: "nested" },
  { name: "projects.milestones", path: "projects[].milestones", kind: "nested" },
  { name: "projects.timeLog", path: "projects[].timeLog", kind: "nested" },
  { name: "projects.releases", path: "projects[].releases", kind: "nested" },
  { name: "projects.decisions", path: "projects[].decisions", kind: "nested" },
  { name: "roadmap.phases.tasks", path: "roadmap.phases[].tasks", kind: "nested" },
  { name: "roadmap.layers.tools", path: "roadmap.layers[].tools", kind: "nested" },
  { name: "roadmap.layers.resources", path: "roadmap.layers[].resources", kind: "nested" },
];
