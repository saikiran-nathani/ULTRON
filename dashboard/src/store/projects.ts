import { useData } from "./data";
import { uid } from "@/lib/nexus/format";
import type { NexusData, Project, Attachment } from "@/lib/nexus/types";
import type { Priority, ProjectStatus } from "@/lib/nexus/constants";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);
const find = (d: NexusData, id: string) => d.projects.find((p) => p.id === id);

/**
 * Re-exported, not declared: `migrate.ts` needs it too, and importing it from
 * here closed `db → migrate → store/projects → store/data → db` into a real
 * cycle. It lives in `@/lib/nexus/constants` now; this line keeps every
 * existing `from "@/store/projects"` import working.
 */
export { SORT_STEP } from "@/lib/nexus/constants";
import { SORT_STEP } from "@/lib/nexus/constants";

/**
 * The canonical task order: `sort` ascending, `id` as the tiebreak.
 *
 * Exported and used by BOTH the list and `moveTask`. If the screen rendered
 * one order and the store resolved indices against another, the up/down
 * buttons would move the wrong task — and only for lists where the two
 * happened to differ, which is the kind of bug that reproduces once a week.
 *
 * The `id` tiebreak matters: two devices can legitimately produce the same
 * sort value (adding a first task to an empty list on each), and without a
 * deterministic tiebreak the two would render in different orders on the two
 * devices forever, with the data fully converged.
 */
export function orderTasks<T extends { id: string; sort?: number }>(tasks: T[]): T[] {
  return [...tasks].sort(
    (a, b) => (a.sort ?? 0) - (b.sort ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

export const projects = {
  add: (p: Omit<Project, "id" | "tasks" | "milestones" | "timeLog"> & { milestones?: string[] }) =>
    update((d) => {
      const { milestones, ...rest } = p;
      d.projects.push({
        id: uid(),
        tasks: [],
        milestones: (milestones ?? []).map((name) => ({ id: uid(), name, done: false, doneAt: null })),
        timeLog: [],
        ...rest,
      });
    }),
  editProject: (id: string, patch: Partial<Project>) =>
    update((d) => {
      const p = find(d, id);
      if (p) Object.assign(p, patch);
    }),
  updateStatus: (id: string, status: string) =>
    update((d) => {
      const p = find(d, id);
      if (p) p.status = status as ProjectStatus;
    }),
  del: (id: string) =>
    // nexus also called `deleteProjectFiles(id)` here, a Tauri `invoke` into
    // the Rust side's attachment directory. There is no such directory in a
    // PWA and `@tauri-apps/api` is not a dependency, so the call is gone
    // rather than stubbed — a no-op wrapper would read as "attachments are
    // handled" at every call site. The project record and its attachment
    // *metadata* still go, and still sync; the bytes were never here to
    // delete. The Mac service being built alongside this owns that half.
    update((d) => {
      d.projects = d.projects.filter((p) => p.id !== id);
    }),

  /* Tasks */
  addTask: (pid: string, t: { name: string; priority: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (!p) return;
      // One step past the current maximum, so a new task lands at the end of
      // the list without depending on array position — and so two devices
      // adding a task at the same time get different keys rather than both
      // claiming the same slot.
      const maxSort = p.tasks.reduce((m, x) => Math.max(m, x.sort ?? 0), 0);
      p.tasks.push({
        id: uid(),
        done: false,
        doneAt: null,
        notes: "",
        attachments: [],
        sort: maxSort + SORT_STEP,
        ...t,
        priority: t.priority as Priority,
      });
    }),
  editTask: (pid: string, tid: string, patch: { name?: string; priority?: string }) =>
    update((d) => {
      const t = find(d, pid)?.tasks.find((t) => t.id === tid);
      if (t) Object.assign(t, patch);
    }),
  toggleTask: (pid: string, tid: string) =>
    update((d) => {
      const t = find(d, pid)?.tasks.find((t) => t.id === tid);
      if (!t) return;
      t.done = !t.done;
      t.doneAt = t.done ? new Date().toISOString() : null;
    }),
  delTask: (pid: string, tid: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p) p.tasks = p.tasks.filter((t) => t.id !== tid);
    }),
  /**
   * Move a task, by writing a sort key to that one task and nothing else.
   *
   * The previous implementation spliced the array. A positional index is not
   * an identity: two devices reordering the same list produce two different
   * arrays, and no merge can tell which of them the user meant -- the result
   * is arbitrary, and it is arbitrary for *every* task in the list, not just
   * the one that moved.
   *
   * With a fractional key, a move is a single-record write. Two devices
   * moving two different tasks in the same list do not conflict at all, and
   * moving the same task twice resolves to whichever write is later --
   * a defensible answer rather than a scrambled list.
   *
   * `from`/`to` stay as indices because that is what the up/down buttons
   * have; they are resolved against the SAME order the list renders in,
   * which is what `orderTasks` guarantees.
   */
  moveTask: (pid: string, from: number, to: number) =>
    update((d) => {
      const p = find(d, pid);
      if (!p) return;
      const ordered = orderTasks(p.tasks);
      if (to < 0 || to >= ordered.length || from < 0 || from >= ordered.length) return;
      if (from === to) return;

      const moved = ordered[from];
      if (!moved) return;

      // The neighbours it will land between, in the list as it looks WITHOUT
      // the moved task. Computing them against the original list is the
      // classic off-by-one here: moving down by one would pick the task it is
      // already above and produce a key that changes nothing.
      const without = ordered.filter((t) => t.id !== moved.id);
      const before = to > 0 ? without[to - 1] : undefined;
      const after = without[to];

      const lo = before?.sort ?? (after?.sort ?? SORT_STEP) - SORT_STEP;
      const hi = after?.sort ?? lo + SORT_STEP * 2;

      const target = p.tasks.find((t) => t.id === moved.id);
      if (target) target.sort = (lo + hi) / 2;
    }),
  updateTaskNotes: (pid: string, tid: string, notes: string) =>
    update((d) => {
      const t = find(d, pid)?.tasks.find((t) => t.id === tid);
      if (t) t.notes = notes;
    }),

  /* Milestones */
  addMilestone: (pid: string, name: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p) p.milestones.push({ id: uid(), name, done: false, doneAt: null });
    }),
  toggleMilestone: (pid: string, mid: string) =>
    update((d) => {
      const m = find(d, pid)?.milestones.find((m) => m.id === mid);
      if (!m) return;
      m.done = !m.done;
      m.doneAt = m.done ? new Date().toISOString() : null;
    }),
  delMilestone: (pid: string, mid: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p) p.milestones = p.milestones.filter((m) => m.id !== mid);
    }),

  /* Time log */
  logTime: (pid: string, e: { date: string; duration: number; description: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) p.timeLog.push({ id: uid(), ...e });
    }),
  delTime: (pid: string, eid: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p) p.timeLog = p.timeLog.filter((e) => e.id !== eid);
    }),

  /* Attachments */
  addTaskAttachments: (pid: string, tid: string, metas: Attachment[]) =>
    update((d) => {
      const t = find(d, pid)?.tasks.find((t) => t.id === tid);
      if (t) t.attachments.push(...metas);
    }),
  removeTaskAttachment: (pid: string, tid: string, storedName: string) =>
    // Same as `del`: the metadata record goes, the native delete does not
    // exist here. See the note there.
    update((d) => {
      const t = find(d, pid)?.tasks.find((t) => t.id === tid);
      if (t) t.attachments = t.attachments.filter((a) => a.stored_name !== storedName);
    }),

  /* Runbook (dev add-on) — how to run the project + its resources */
  setPorts: (pid: string, ports: number[]) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.runbook ??= { commands: [], env: [], ports: [], links: [] }).ports = ports;
    }),
  addRunCommand: (pid: string, c: { label: string; cmd: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.runbook ??= { commands: [], env: [], ports: [], links: [] }).commands.push({ id: uid(), ...c });
    }),
  delRunCommand: (pid: string, cid: string) =>
    update((d) => {
      const rb = find(d, pid)?.runbook;
      if (rb) rb.commands = rb.commands.filter((c) => c.id !== cid);
    }),
  addEnvVar: (pid: string, e: { key: string; value: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.runbook ??= { commands: [], env: [], ports: [], links: [] }).env.push({ id: uid(), ...e });
    }),
  delEnvVar: (pid: string, eid: string) =>
    update((d) => {
      const rb = find(d, pid)?.runbook;
      if (rb) rb.env = rb.env.filter((e) => e.id !== eid);
    }),
  addLink: (pid: string, l: { label: string; url: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.runbook ??= { commands: [], env: [], ports: [], links: [] }).links.push({ id: uid(), ...l });
    }),
  delLink: (pid: string, lid: string) =>
    update((d) => {
      const rb = find(d, pid)?.runbook;
      if (rb) rb.links = rb.links.filter((l) => l.id !== lid);
    }),

  /* Releases (dev add-on) */
  addRelease: (pid: string, r: { version: string; date: string; notes: string; url: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.releases ??= []).push({ id: uid(), ...r });
    }),
  delRelease: (pid: string, rid: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p?.releases) p.releases = p.releases.filter((r) => r.id !== rid);
    }),

  /* Architecture Decision Records (dev add-on) */
  addDecision: (pid: string, dec: { title: string; context: string; decision: string; consequences: string; status: string; date: string }) =>
    update((d) => {
      const p = find(d, pid);
      if (p) (p.decisions ??= []).push({ id: uid(), ...dec, status: dec.status as "Proposed" | "Accepted" | "Superseded" });
    }),
  editDecision: (pid: string, did: string, patch: Partial<{ title: string; context: string; decision: string; consequences: string; status: string; date: string }>) =>
    update((d) => {
      const dec = find(d, pid)?.decisions?.find((x) => x.id === did);
      if (dec) Object.assign(dec, patch);
    }),
  delDecision: (pid: string, did: string) =>
    update((d) => {
      const p = find(d, pid);
      if (p?.decisions) p.decisions = p.decisions.filter((x) => x.id !== did);
    }),
};

export function useProjects() {
  const list = useData((s) => s.data!.projects);
  return { list, ...projects };
}
