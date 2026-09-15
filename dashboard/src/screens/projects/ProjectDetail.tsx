import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronLeft,
  Check,
  Clock,
  Play,
  Plus,
  Pencil,
  Rocket,
  ScrollText,
  Square,
  Terminal,
  Trash2,
} from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  CopyButton,
  FormModal,
  IconButton,
  ProgressBar,
  ScrollList,
  inputCls,
  type FormField,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { useProjects } from "@/store/projects";
import { useStopwatch } from "@/store/stopwatch";
import { fmtDuration, todayStr } from "@/lib/nexus/format";
import { PRIORITIES, PROJECT_STATUSES, type Priority, type ProjectStatus } from "@/lib/nexus/constants";
import type { Project } from "@/lib/nexus/types";
import { TaskRow } from "./TaskRow";
import { Runbook } from "./Runbook";
import { Releases } from "./Releases";
import { Decisions } from "./Decisions";
import {
  milestoneProgress,
  orderMilestones,
  orderTimeLog,
  priorityTone,
  statusTone,
  taskPositions,
  taskProgress,
  totalMinutes,
} from "./ordering";

const PROJECT_FIELDS: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  { key: "description", label: "Description", type: "textarea", full: true },
  { key: "directory", label: "Directory", full: true, placeholder: "/Users/you/code/project" },
  {
    key: "status",
    label: "Status",
    type: "select",
    required: true,
    options: PROJECT_STATUSES.map((s) => ({ value: s, label: s })),
  },
  {
    key: "priority",
    label: "Priority",
    type: "select",
    required: true,
    options: PRIORITIES.map((s) => ({ value: s, label: s })),
  },
  { key: "startDate", label: "Start", type: "date" },
  { key: "endDate", label: "End", type: "date" },
];

/**
 * A disclosure row inside the detail card.
 *
 * The header is a 14px line of text, so on a touch screen the whole row is
 * the target rather than the glyph. nexus wrote that as
 * `min-h-11 md:min-h-0`, which handed the 44px floor back on the iPad — a
 * 1024px-wide device driven by a thumb. `pointer-coarse:` asks about the
 * pointer instead, so a mouse matches no rule at all and the desktop row
 * keeps its original height.
 */
function Section({
  icon,
  label,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  label: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-3 border-t-[0.5px] border-line pt-3">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 text-fg-muted transition-colors hover:text-fg-dim pointer-coarse:min-h-[44px]"
      >
        {icon}
        <span className="label">{label}</span>
        <ChevronDown
          size={13}
          aria-hidden
          className={cn("ml-auto transition-transform", open && "rotate-180")}
        />
      </button>
      {open && <div className="pt-3">{children}</div>}
    </div>
  );
}

/**
 * The selected project, managed.
 *
 * `onBack` exists for the narrow layout only: below `md` the master list and
 * this card stack, and nexus's answer was to scroll past the whole list to
 * reach the detail. With a dozen projects that is a long scroll every time
 * you tap one, so below `md` the two are panes and this is the way back. At
 * `md` and above both render side by side exactly as before and the control
 * is not in the layout at all.
 */
export function ProjectDetail({ project: p, onBack }: { project: Project; onBack?: () => void }) {
  const { editProject, del, updateStatus, addTask, addMilestone, toggleMilestone, delMilestone } =
    useProjects();
  const [taskText, setTaskText] = useState("");
  const [msText, setMsText] = useState("");
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tasks = taskProgress(p);
  const milestones = milestoneProgress(p);
  const minutes = totalMinutes(p);

  return (
    <Card className="flex flex-col p-5" active={p.status === "Active"} accent={statusTone(p.status)}>
      {onBack && (
        <button
          onClick={onBack}
          className="mb-2 -ml-1 flex w-fit items-center gap-1 self-start rounded-xs px-1 text-[11.5px] text-fg-muted transition-colors hover:text-fg-dim pointer-coarse:min-h-[44px] md:hidden"
        >
          <ChevronLeft size={13} aria-hidden /> All projects
        </button>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="display text-[18px] text-fg">{p.name}</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Chip color={statusTone(p.status)}>{p.status}</Chip>
            <Chip color={priorityTone(p.priority)}>{p.priority}</Chip>
            {minutes > 0 && (
              <span className="nums text-[11px] text-fg-muted">{fmtDuration(minutes)} logged</span>
            )}
            {(p.startDate || p.endDate) && (
              <span className="nums text-[11px] text-fg-muted">
                {p.startDate || "…"} → {p.endDate || "…"}
              </span>
            )}
          </div>
          {p.description && (
            <p className="mt-2 max-w-[74ch] text-[12.5px] leading-relaxed text-fg-dim">
              {p.description}
            </p>
          )}
          {/*
            nexus put "Open in Finder" and an "Open in IDE…" picker here, both
            Tauri commands into the Mac's shell. A PWA cannot open a Finder
            window or launch WebStorm, and `@tauri-apps/api` is not a
            dependency — so the directory is shown as what it still is: a
            string, with the one action a browser can genuinely perform on it.
            Copying beats a dead "Open in…" button that a phone could never
            have honoured anyway.
          */}
          {p.directory && (
            <div className="mt-2 flex items-center gap-2">
              <p className="nums min-w-0 flex-1 truncate text-[11px] text-fg-muted" title={p.directory}>
                {p.directory}
              </p>
              <CopyButton text={p.directory} size="sm" label="Path" />
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={<Pencil size={14} />} label="Edit project" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={14} />}
            label="Delete project"
            danger
            onClick={() => setConfirmDelete(true)}
          />
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <label className="sr-only" htmlFor={`status-${p.id}`}>
          Status
        </label>
        <select
          id={`status-${p.id}`}
          className={inputCls + " w-auto py-1 text-[11px]"}
          value={p.status}
          onChange={(e) => updateStatus(p.id, e.target.value)}
        >
          {PROJECT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>

      {/* Tasks — rendered in exactly `orderTasks` order, because the up/down
          buttons send indices into that order. See `taskPositions`. */}
      <div className="mt-4 border-t-[0.5px] border-line pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Tasks</span>
          <span className="nums text-[11px] text-fg-muted">
            {tasks.done}/{tasks.total}
          </span>
        </div>
        {tasks.total > 0 && (
          <div className="mb-2">
            <ProgressBar value={tasks.pct} />
          </div>
        )}
        {tasks.total === 0 ? (
          <p className="text-[11px] leading-relaxed text-fg-muted">
            No tasks yet — a project without any is a perfectly normal place to start.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {taskPositions(p.tasks).map((row) => (
              <TaskRow
                key={row.task.id}
                pid={p.id}
                task={row.task}
                index={row.index}
                total={row.total}
                canUp={row.canUp}
                canDown={row.canDown}
              />
            ))}
          </div>
        )}
        <input
          className={inputCls + " mt-2"}
          placeholder="New task, Enter to add"
          aria-label="New task"
          value={taskText}
          onChange={(e) => setTaskText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && taskText.trim()) {
              addTask(p.id, { name: taskText.trim(), priority: "Medium" });
              setTaskText("");
            }
          }}
        />
      </div>

      {/* Milestones — `id` ascending, i.e. the order they were created in.
          Deliberately *not* re-sorted by done-ness: a checklist whose rows
          jump the moment you tick one loses your place. */}
      <div className="mt-3 border-t-[0.5px] border-line pt-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label">Milestones</span>
          {milestones.total > 0 && (
            <span className="nums text-[11px] text-fg-muted">
              {milestones.done}/{milestones.total}
            </span>
          )}
        </div>
        {milestones.total === 0 ? (
          <p className="text-[11px] leading-relaxed text-fg-muted">
            No milestones. Add one when there is a moment worth marking.
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {orderMilestones(p.milestones).map((m) => (
              <div key={m.id} className="flex items-center gap-2">
                <button
                  onClick={() => toggleMilestone(p.id, m.id)}
                  aria-pressed={m.done}
                  className="flex flex-1 items-center gap-2 text-left pointer-coarse:min-h-[44px]"
                >
                  <span
                    className={cn(
                      "grid h-4 w-4 shrink-0 place-items-center rounded-xs border",
                      m.done ? "border-accent bg-accent text-bg" : "border-line-active",
                    )}
                  >
                    {m.done && <Check size={11} strokeWidth={3} aria-hidden />}
                  </span>
                  <span className={cn("text-[12.5px]", m.done ? "text-fg-muted line-through" : "text-fg-dim")}>
                    {m.name}
                  </span>
                </button>
                <IconButton
                  icon={<Trash2 size={11} />}
                  label={`Delete milestone ${m.name}`}
                  danger
                  onClick={() => delMilestone(p.id, m.id)}
                />
              </div>
            ))}
          </div>
        )}
        <input
          className={inputCls + " mt-2"}
          placeholder="New milestone, Enter to add"
          aria-label="New milestone"
          value={msText}
          onChange={(e) => setMsText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && msText.trim()) {
              addMilestone(p.id, msText.trim());
              setMsText("");
            }
          }}
        />
      </div>

      <Section icon={<Clock size={13} aria-hidden />} label={`Time — ${fmtDuration(minutes)}`}>
        <TimeSection project={p} />
      </Section>

      <Section icon={<Terminal size={13} aria-hidden />} label="Runbook — how to run it">
        <Runbook project={p} />
      </Section>

      <Section icon={<Rocket size={13} aria-hidden />} label={`Releases (${(p.releases ?? []).length})`}>
        <Releases project={p} />
      </Section>

      <Section
        icon={<ScrollText size={13} aria-hidden />}
        label={`Decisions (${(p.decisions ?? []).length})`}
      >
        <Decisions project={p} />
      </Section>

      {editing && (
        <FormModal
          title="Edit project"
          initial={{
            name: p.name,
            description: p.description,
            directory: p.directory,
            status: p.status,
            priority: p.priority,
            startDate: p.startDate,
            endDate: p.endDate,
          }}
          fields={PROJECT_FIELDS}
          onSubmit={(v) =>
            editProject(p.id, {
              name: String(v.name),
              description: String(v.description),
              directory: String(v.directory),
              status: String(v.status) as ProjectStatus,
              priority: String(v.priority) as Priority,
              startDate: String(v.startDate),
              endDate: String(v.endDate),
            })
          }
          onClose={() => setEditing(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Delete project"
          message={`Delete "${p.name}"? Its ${p.tasks.length} tasks, ${p.milestones.length} milestones and ${p.timeLog.length} time entries go with it. Any files attached to a task were only ever recorded here, never stored — those records go too.`}
          onConfirm={() => {
            del(p.id);
            onBack?.();
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Card>
  );
}

/**
 * The timer and the log.
 *
 * Its own component because `useStopwatch` publishes a new `now` every second
 * while a timer runs. Subscribed from `ProjectDetail`, that re-rendered the
 * whole card — every task row, the runbook, both ADR lists — once a second,
 * on a phone. Here the second-by-second render is one button wide.
 */
function TimeSection({ project: p }: { project: Project }) {
  const { logTime, delTime } = useProjects();
  const sw = useStopwatch();
  const [logging, setLogging] = useState(false);

  const running = sw.runningId === p.id;
  const busyElsewhere = sw.runningId !== null && !running;
  const elapsedMins = running && sw.startedAt ? Math.floor((sw.now - sw.startedAt) / 60000) : 0;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {running ? (
          <Button size="sm" variant="danger" icon={<Square size={12} />} onClick={sw.stop}>
            {fmtDuration(elapsedMins)} · Stop
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Play size={12} />}
            onClick={() => sw.start(p.id)}
            disabled={busyElsewhere}
          >
            Start timer
          </Button>
        )}
        <Button size="sm" variant="ghost" icon={<Plus size={12} />} onClick={() => setLogging(true)}>
          Log
        </Button>
        {busyElsewhere && (
          <span className="text-[11px] text-fg-muted">
            A timer is already running on another project.
          </span>
        )}
      </div>

      {p.timeLog.length === 0 ? (
        <p className="text-[11px] leading-relaxed text-fg-muted">
          Nothing logged. The timer writes an entry when you stop it.
        </p>
      ) : (
        <ScrollList maxH={210} className="flex flex-col gap-0.5">
          {/* `date` descending, `id` descending — newest first. nexus reversed
              the array, which after a sync is reversed creation order only by
              coincidence. */}
          {orderTimeLog(p.timeLog).map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-[11.5px]">
              <span className="nums w-16 shrink-0 text-fg-muted">{e.date || "—"}</span>
              <span className="min-w-0 flex-1 truncate text-fg-dim">{e.description || "—"}</span>
              <span className="nums shrink-0 text-fg-muted">{fmtDuration(e.duration)}</span>
              <IconButton
                icon={<Trash2 size={10} />}
                label={`Delete the ${fmtDuration(e.duration)} entry from ${e.date || "an unknown date"}`}
                danger
                onClick={() => delTime(p.id, e.id)}
              />
            </div>
          ))}
        </ScrollList>
      )}

      {logging && (
        <FormModal
          title="Log time"
          fields={[
            { key: "duration", label: "Minutes", type: "number", step: 5, min: 0, required: true },
            { key: "date", label: "Date", type: "date", defaultValue: todayStr() },
            { key: "description", label: "What did you do?", full: true },
          ]}
          onSubmit={(v) =>
            logTime(p.id, {
              duration: Number(v.duration),
              date: String(v.date),
              description: String(v.description),
            })
          }
          onClose={() => setLogging(false)}
        />
      )}
    </div>
  );
}
