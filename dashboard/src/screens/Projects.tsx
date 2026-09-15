/**
 * Projects — the largest domain in the model, and the one where array
 * position bites hardest.
 *
 * A project carries five nested per-record collections (`tasks`,
 * `milestones`, `timeLog`, `releases`, `decisions`) plus an optional
 * `runbook`. All five are synced one record at a time and rebuilt by
 * ascending key, so **no part of this screen may render in array order**.
 * Every list goes through `./projects/ordering`, which states what each one
 * is ordered by and why.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, DatabaseZap, FolderGit2, Plus } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import {
  Button,
  Callout,
  Card,
  CountUp,
  EmptyState,
  FormModal,
  StatBand,
  Tabs,
  type FormField,
  type TabDef,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { useData } from "@/store/data";
import { useProjects } from "@/store/projects";
import { fmtDuration } from "@/lib/nexus/format";
import { PRIORITIES, PROJECT_STATUSES, type Priority, type ProjectStatus } from "@/lib/nexus/constants";
import { ProjectsList } from "./projects/ProjectsList";
import { ProjectDetail } from "./projects/ProjectDetail";
import { Workspace } from "./projects/Workspace";
import { filterSortProjects, rollup, staleProjects } from "./projects/ordering";

const NEW_PROJECT_FIELDS: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  { key: "description", label: "Description", type: "textarea", full: true },
  { key: "directory", label: "Directory", full: true, placeholder: "/Users/you/code/project" },
  {
    key: "status",
    label: "Status",
    type: "select",
    required: true,
    defaultValue: "Active",
    options: PROJECT_STATUSES.map((s) => ({ value: s, label: s })),
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    required: true,
    defaultValue: "Medium",
    options: PRIORITIES.map((s) => ({ value: s, label: s })),
  },
  { key: "startDate", label: "Start", type: "date" },
  { key: "endDate", label: "End", type: "date" },
];

/**
 * The screen, and the one guard in front of it.
 *
 * `useProjects()` reads `s.data!.projects` — a non-null assertion, as every
 * slice in this store does — so it must not be called before the cache has
 * answered. The app shell boots the store (`startNexusSync` in `App.tsx`,
 * which does `load()` and wires sync in one step because the two share
 * `cacheHit`), and that runs in the same mount as this screen, so there is a
 * real tick where `data` is null.
 *
 * Which is a *waiting* state, not an error and not an empty one, and it says
 * so. Deliberately no `load()` call from here: a second read would be
 * harmless today but it is a store write from a screen, and it can only ever
 * resolve to the same blob the shell is already awaiting — or, on a slow
 * localStorage, land *after* the first pull and overwrite merged data with
 * the cache.
 */
export function ProjectsScreen() {
  const loaded = useData((s) => s.loaded);
  const hasData = useData((s) => s.data !== null);
  const error = useData((s) => s.error);

  if (!loaded || !hasData) {
    return (
      <ScreenShell eyebrow="Build" title="Projects">
        <Card className="flex items-center gap-3 px-4 py-3">
          <DatabaseZap size={14} aria-hidden className="shrink-0 text-accent-dim" />
          <p className="text-[12px] text-fg-dim">Reading the local cache…</p>
        </Card>
      </ScreenShell>
    );
  }

  return <ProjectsBoard cacheError={error} />;
}

const TABS: TabDef[] = [
  { id: "projects", label: "Projects" },
  { id: "workspace", label: "Workspace" },
];

/** Days of silence before an Active project is called out. Named so the
 *  threshold and the label that states it cannot drift apart. */
const STALE_DAYS = 10;

function ProjectsBoard({ cacheError }: { cacheError: string | null }) {
  const { list, add } = useProjects();
  const [tab, setTab] = useState("projects");
  const [selId, setSelId] = useState<string | null>(null);
  /**
   * Which of the two columns a narrow screen is showing.
   *
   * Only consulted below `md`. At `md` and up both panes are in the grid at
   * once, exactly as the desktop app laid them out — this state cannot move
   * anything there, because both wrappers are `md:block` unconditionally.
   */
  const [pane, setPane] = useState<"list" | "detail">("list");
  const [adding, setAdding] = useState(false);

  /**
   * What is open when the screen is first shown.
   *
   * nexus used `list[0]`, which is the ordering trap in one character: after
   * a sync that is the *lowest id*, not the project you were last in, and it
   * changes under you when a record arrives. This is the most recently active
   * project instead — and it is picked **once, at mount**, which is the half
   * that matters. Recomputed every render it would slide the detail column
   * onto a different project mid-read as the first burst of records lands.
   */
  const [arrivalPick] = useState<string | null>(
    () => filterSortProjects(list, { sort: "recent" })[0]?.id ?? null,
  );

  /** An explicit tap wins, and survives a rename, a re-sort and a sync. */
  const selected = useMemo(() => {
    const id = selId ?? arrivalPick;
    return id ? list.find((p) => p.id === id) ?? null : null;
  }, [list, selId, arrivalPick]);

  const totals = rollup(list);
  const stale = useMemo(() => staleProjects(list, { staleDays: STALE_DAYS }), [list]);
  const showEmpty = tab === "projects" && list.length === 0;
  const showBoard = tab === "projects" && list.length > 0;

  const open = (id: string) => {
    setSelId(id);
    setPane("detail");
    setTab("projects");
  };

  return (
    <ScreenShell
      eyebrow="Build"
      title="Projects"
      actions={
        <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
          New project
        </Button>
      }
    >
      <Stagger className="flex flex-col gap-4">
        <Reveal>
          <Tabs
            tabs={TABS.map((t) => (t.id === "projects" ? { ...t, count: list.length } : t))}
            active={tab}
            onChange={setTab}
            layoutId="projects-tabs"
          />
        </Reveal>

        {/* A cache that was present and unreadable is a fault, and it looks
            like one: a bad-toned rule and a plain statement of consequence.
            Nothing else on this screen is drawn this way — an empty project
            list is dashed and quiet, and a loaded one is neither. */}
        {cacheError && (
          <Reveal>
            <Card active accent="var(--color-bad)" className="flex items-start gap-3 px-4 py-3">
              <AlertTriangle
                size={14}
                aria-hidden
                className="mt-0.5 shrink-0 text-[var(--color-bad)]"
              />
              <div className="text-[12px] leading-relaxed text-fg-dim">
                <span className="text-[var(--color-bad)]">The local cache was unreadable</span> —{" "}
                {cacheError}. What you see below is whatever sync has since delivered, which on a
                first load is nothing. Anything you add now is a new record, not an edit to a lost
                one.
              </div>
            </Card>
          </Reveal>
        )}

        {/*
          Flat siblings rather than a branch that returns a fragment:
          `Stagger` clones each child to hand it its `--i`, and cloning a
          `React.Fragment` with a `style` prop is a dev-mode warning and a
          stagger delay that lands on nothing.
        */}
        {tab === "workspace" && (
          <Reveal>
            <Workspace list={list} onOpen={open} />
          </Reveal>
        )}

        {showEmpty && (
          <Reveal>
            <EmptyState
              icon={<FolderGit2 size={22} strokeWidth={1.6} />}
              title="No projects yet"
              hint="A project holds its tasks, milestones, time log, runbook, releases and decisions. Start with a name; the rest accumulates."
              action={
                <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
                  New project
                </Button>
              }
            />
          </Reveal>
        )}

        {showBoard && (
          <Reveal>
            <StatBand
              min={150}
              items={[
                { label: "Projects", value: <CountUp value={totals.projects} /> },
                {
                  label: "Active",
                  value: <CountUp value={totals.active} />,
                  color: "var(--color-good)",
                },
                { label: "Open tasks", value: <CountUp value={totals.openTasks} /> },
                {
                  label: "Logged",
                  value: fmtDuration(totals.minutes),
                  color: "var(--color-accent-lt)",
                },
              ]}
            />
          </Reveal>
        )}

        {showBoard && stale.length > 0 && (
          <Reveal>
            <Callout
              icon={<AlertTriangle size={12} aria-hidden />}
              label={`Quiet for ${STALE_DAYS} days (${stale.length})`}
              tone="var(--color-warn)"
            >
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {stale.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => open(s.id)}
                    /* nexus styled these as `text-warm-dim hover:text-warm`
                       inside a wrapped text run: legible at rest, but a
                       ~16px-tall tap target on a phone. Same look, real
                       target. */
                    className="flex items-center gap-1.5 rounded-xs text-left text-[11.5px] text-fg-dim transition-colors hover:text-fg pointer-coarse:min-h-[44px]"
                  >
                    {s.name}
                    <span className="nums text-fg-muted">· {s.daysSince}d</span>
                  </button>
                ))}
              </div>
            </Callout>
          </Reveal>
        )}

        {/*
          Master-detail. At `md` and above this is the desktop app's layout,
          unchanged: a 300px column of project cards and the selected one
          managed beside it.

          Below `md` a 300px master column would leave 43px for the detail, so
          nexus stacked them — and stacking means scrolling past every project
          card to reach the one you just tapped. Here the two are panes
          instead: the list, then the detail with a way back. Both wrappers
          carry `md:block`, so the pane state is inert on the desktop.
        */}
        {showBoard && (
          <Reveal>
            <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-[300px_1fr]">
              <div className={pane === "detail" ? "hidden md:block" : "md:block"}>
                <ProjectsList list={list} selectedId={selected?.id ?? null} onSelect={open} />
              </div>
              <div className={pane === "list" ? "hidden md:block" : "md:block"}>
                {selected ? (
                  <ProjectDetail project={selected} onBack={() => setPane("list")} />
                ) : (
                  /* Reachable two ways: the selected project was just deleted,
                     or the screen mounted empty and a project has since synced
                     in. Neither is an error, and it is drawn like neither —
                     no dashed frame, no alert tone, just the instruction in
                     the column the detail will fill. */
                  <p className="px-1 py-3 text-[12px] text-fg-muted">
                    Pick a project to manage its tasks, time and runbook.
                  </p>
                )}
              </div>
            </div>
          </Reveal>
        )}
      </Stagger>

      {adding && (
        <FormModal
          title="New project"
          fields={NEW_PROJECT_FIELDS}
          onSubmit={(v) =>
            add({
              name: String(v.name),
              description: String(v.description),
              directory: String(v.directory),
              status: String(v.status) as ProjectStatus,
              priority: String(v.priority) as Priority,
              startDate: String(v.startDate),
              endDate: String(v.endDate),
            })
          }
          onClose={() => setAdding(false)}
        />
      )}
    </ScreenShell>
  );
}
