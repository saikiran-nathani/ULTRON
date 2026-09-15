/**
 * The roadmap's plan half, ported from nexus's `roadmap/Plan.tsx`.
 *
 * The roadmap folds into Career rather than staying a screen of its own: it is
 * the career side's plan, and the four tracks terminate here. What was two
 * top-level screens is now two tabs, which also frees a nav slot the phone's
 * bottom bar did not have.
 *
 * Touch fixes, all of them the same bug wearing different clothes — the source
 * hung five controls off `tap-44` plus `opacity-50 group-hover:opacity-100`.
 * `tap-44` is not a utility this app's base layer defines (it was nexus's
 * own), so it silently expanded to nothing, leaving an 11px pencil glyph that
 * only reached full contrast under a cursor. Every one of them is an
 * `IconButton` now, which draws a resting surface and a 44px box on a coarse
 * pointer and is byte-identical to the source on a fine one.
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Check, Compass, Flag, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  ConfirmDialog,
  CountUp,
  EmptyState,
  FormModal,
  IconButton,
  ProgressBar,
  ProgressRing,
  inputCls,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { daysFromToday, longDate, todayStr } from "@/lib/nexus/format";
import type { Roadmap, RoadmapPhase } from "@/lib/nexus/types";
import { currentPhaseIndex, roadmap, roadmapProgress } from "@/store/roadmap";
import { byId, orderPhases } from "./order";
import { Runway } from "./Runway";

const scrollToCard = (id: string) =>
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "center" });

const PHASE_FIELDS = [
  { key: "title", label: "Title", required: true, full: true },
  { key: "period", label: "Period (label)" },
  { key: "start", label: "Start", type: "date" as const },
  { key: "end", label: "End", type: "date" as const },
  { key: "goal", label: "Goal", type: "textarea" as const, full: true },
];

function PhaseCard({
  phase,
  index,
  current,
}: {
  phase: RoadmapPhase;
  index: number;
  current: boolean;
}) {
  const [text, setText] = useState("");
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editTask, setEditTask] = useState<{ id: string; text: string } | null>(null);

  // Ascending id, which for the seeded curriculum IS authored order — the
  // seed's zero-padded ordinal exists precisely so that holds. See `order.tsx`.
  const tasks = byId(phase.tasks);
  const done = tasks.filter((t) => t.done).length;
  const pct = tasks.length ? (done / tasks.length) * 100 : 0;

  const addTask = () => {
    const t = text.trim();
    if (!t) return;
    roadmap.addTask(phase.id, t);
    setText("");
  };

  return (
    <Card id={`phase-${phase.id}`} className="p-5" active={current}>
      <div className="flex flex-wrap items-start gap-4 md:flex-nowrap">
        <ProgressRing value={pct} size={52} stroke={4}>
          <span className="nums text-[10px] text-fg">{Math.round(pct)}%</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="label text-accent-dim">Phase {index + 1}</span>
            <span className="nums text-[10px] text-fg-muted">{phase.period}</span>
            {current && (
              <span className="label rounded-full border border-line-active bg-accent/10 px-2 py-0.5 text-accent-lt">
                Current
              </span>
            )}
          </div>
          <div className="display mt-1 text-[16px] text-fg">{phase.title}</div>
          <p className="mt-1 max-w-[68ch] text-[12.5px] leading-relaxed text-fg-dim">{phase.goal}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="nums text-[11px] text-fg-muted">
            {done}/{tasks.length}
          </span>
          <IconButton icon={<Pencil size={13} />} label="Edit phase" onClick={() => setEditing(true)} />
          <IconButton
            icon={<Trash2 size={13} />}
            label="Delete phase"
            danger
            onClick={() => setDeleting(true)}
          />
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-0.5 border-t-[0.5px] border-line pt-3">
        {tasks.map((t) => (
          <div
            key={t.id}
            className="group flex items-center gap-2.5 rounded-xs px-1 py-1 hover:bg-card-hover"
          >
            <button
              onClick={() => roadmap.toggleTask(phase.id, t.id)}
              aria-pressed={t.done}
              className="flex flex-1 items-start gap-2.5 text-left pointer-coarse:min-h-[44px] pointer-coarse:items-center"
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded-xs border transition-all pointer-coarse:mt-0",
                  t.done ? "border-accent bg-accent text-bg" : "border-line-strong",
                )}
              >
                {t.done && <Check size={11} strokeWidth={3} />}
              </span>
              <span
                className={cn(
                  "text-[12.5px] leading-snug",
                  t.done ? "text-fg-muted line-through" : "text-fg-dim",
                )}
              >
                {t.text}
              </span>
            </button>
            {/* Dimmed at rest, not hidden — and unconditionally full on touch,
                where hover never fires and 50% reads as disabled. */}
            <div className="flex shrink-0 opacity-50 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
              <IconButton
                icon={<Pencil size={11} />}
                label="Edit task"
                onClick={() => setEditTask({ id: t.id, text: t.text })}
              />
              <IconButton
                icon={<Trash2 size={11} />}
                label="Delete task"
                danger
                onClick={() => roadmap.delTask(phase.id, t.id)}
              />
            </div>
          </div>
        ))}

        <div className="mt-1.5 flex items-center gap-2">
          <input
            className={inputCls}
            placeholder="Add a task, Enter to save"
            aria-label={`Add a task to ${phase.title}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addTask()}
          />
          <IconButton icon={<Plus size={15} />} label="Add task" onClick={addTask} />
        </div>
      </div>

      {editing && (
        <FormModal
          title="Edit phase"
          initial={{
            title: phase.title,
            period: phase.period,
            goal: phase.goal,
            start: phase.start,
            end: phase.end,
          }}
          fields={PHASE_FIELDS}
          onSubmit={(v) =>
            roadmap.editPhase(phase.id, {
              title: String(v.title),
              period: String(v.period),
              goal: String(v.goal),
              start: String(v.start),
              end: String(v.end),
            })
          }
          onClose={() => setEditing(false)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete phase"
          message={`Delete "${phase.title}" and its ${tasks.length} task${tasks.length === 1 ? "" : "s"}?`}
          onConfirm={() => roadmap.delPhase(phase.id)}
          onClose={() => setDeleting(false)}
        />
      )}
      {editTask && (
        <FormModal
          title="Edit task"
          initial={{ text: editTask.text }}
          fields={[{ key: "text", label: "Task", type: "textarea", full: true, required: true }]}
          onSubmit={(v) => roadmap.editTask(phase.id, editTask.id, String(v.text))}
          onClose={() => setEditTask(null)}
        />
      )}
    </Card>
  );
}

/** A narrative block with an edit affordance that exists without a cursor. */
function Narrative({
  icon,
  label,
  tone,
  body,
  onEdit,
  placeholder,
}: {
  icon: ReactNode;
  label: string;
  tone?: string;
  body: string;
  onEdit: () => void;
  placeholder: string;
}) {
  return (
    <Card className="p-5">
      <div className="label mb-2 flex items-center gap-1.5" style={tone ? { color: tone } : undefined}>
        {icon}
        {label}
        <span className="ml-auto">
          <IconButton icon={<Pencil size={11} />} label={`Edit ${label}`} onClick={onEdit} />
        </span>
      </div>
      <p className="text-[12.5px] leading-relaxed text-fg-dim">
        {body || <span className="text-fg-muted">{placeholder}</span>}
      </p>
    </Card>
  );
}

export function Plan({ data }: { data: Roadmap }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<"deadline" | "lane" | "reality" | null>(null);

  // Chronological, `id` as the tiebreak — see `order.tsx` for why phases are
  // the one roadmap list not ordered by id alone.
  const phases = orderPhases(data.phases);
  const prog = roadmapProgress(phases);
  const days = daysFromToday(data.deadline);
  // Given the ordered array, not the raw one: `currentPhaseIndex` is a
  // `findIndex` over dates and is only correct on a chronological list.
  const curIdx = currentPhaseIndex(phases);
  const currentPhase = phases[curIdx];

  return (
    <div className="flex flex-col gap-5 pt-5">
      <Runway phases={phases} deadline={data.deadline} onSelect={(id) => scrollToCard(`phase-${id}`)} />

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Card className="p-4">
          <div className="label">Roadmap progress</div>
          <CountUp
            value={prog.pct}
            suffix="%"
            className="nums mt-1.5 block text-[22px] leading-none text-fg"
          />
          <div className="mt-2">
            <ProgressBar value={prog.pct} />
          </div>
          <div className="mt-1.5 text-[11px] text-fg-muted">
            {prog.done} of {prog.total} tasks done
          </div>
        </Card>
        <Card className="p-4">
          <div className="label">Now</div>
          <div className="display mt-1.5 text-[16px] leading-tight text-fg">
            {currentPhase?.title ?? "—"}
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">
            {currentPhase?.period ?? "no phases yet"}
          </div>
        </Card>
        <Card className="p-4" active>
          <div className="label flex items-center justify-between">
            The real deadline
            <IconButton
              icon={<Pencil size={11} />}
              label="Edit the deadline"
              onClick={() => setEditing("deadline")}
            />
          </div>
          <div className="nums mt-1.5 text-[16px] leading-none text-accent-lt">
            {longDate(data.deadline) || "not set"}
          </div>
          <div className="mt-1 text-[11px] text-fg-muted">
            {data.deadline === ""
              ? "a roadmap without one is a wish"
              : days > 0
                ? `${days} days out`
                : days === 0
                  ? "today"
                  : `${-days} days passed`}
          </div>
        </Card>
      </div>

      {data.principles.length > 0 && (
        <Card className="p-5">
          <div className="label mb-2.5 flex items-center gap-1.5">
            <Flag size={12} aria-hidden /> The principles this hangs on
          </div>
          <div className="flex flex-col gap-2.5">
            {/* `principles` is a bare `string[]` inside a singleton sync
                bucket — no ids, so authored order is the only order there is
                and the index is a legitimate key here. */}
            {data.principles.map((p, i) => (
              <div key={`${i}-${p.slice(0, 24)}`} className="flex gap-3">
                <span className="nums text-[13px] text-accent-lt">{i + 1}</span>
                <p className="text-[12.5px] leading-relaxed text-fg-dim">{p}</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <div className="flex items-center justify-between">
        <span className="label">Phases</span>
        <Button size="sm" variant="ghost" icon={<Plus size={13} />} onClick={() => setAdding(true)}>
          Add phase
        </Button>
      </div>

      {phases.length === 0 ? (
        <EmptyState
          title="No phases"
          hint="A phase is a window with a goal and a task list. The runway above draws itself once there are two."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={() => setAdding(true)}>
              Add phase
            </Button>
          }
        />
      ) : (
        <Stagger className="flex flex-col gap-3">
          {phases.map((p, i) => (
            <Reveal key={p.id}>
              <PhaseCard phase={p} index={i} current={i === curIdx} />
            </Reveal>
          ))}
        </Stagger>
      )}

      <Narrative
        icon={<Compass size={12} aria-hidden />}
        label="The lane question"
        body={data.lane}
        placeholder="Which lane are you actually in? Write it down and the rest of this screen has something to answer to."
        onEdit={() => setEditing("lane")}
      />
      <Narrative
        icon={<AlertTriangle size={12} aria-hidden />}
        label="Reality check"
        tone="var(--color-warn)"
        body={data.realityCheck}
        placeholder="The thing you would rather not write down."
        onEdit={() => setEditing("reality")}
      />

      {adding && (
        <FormModal
          title="New phase"
          fields={PHASE_FIELDS.map((f) =>
            f.key === "start" || f.key === "end" ? { ...f, defaultValue: todayStr() } : f,
          )}
          onSubmit={(v) =>
            roadmap.addPhase({
              title: String(v.title),
              period: String(v.period),
              goal: String(v.goal),
              start: String(v.start),
              end: String(v.end),
            })
          }
          onClose={() => setAdding(false)}
        />
      )}
      {editing === "deadline" && (
        <FormModal
          title="The real deadline"
          initial={{ deadline: data.deadline }}
          fields={[{ key: "deadline", label: "Deadline", type: "date", full: true, required: true }]}
          onSubmit={(v) => roadmap.setDeadline(String(v.deadline))}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "lane" && (
        <FormModal
          title="The lane question"
          initial={{ lane: data.lane }}
          fields={[{ key: "lane", label: "The lane question", type: "textarea", full: true }]}
          onSubmit={(v) => roadmap.setLane(String(v.lane))}
          onClose={() => setEditing(null)}
        />
      )}
      {editing === "reality" && (
        <FormModal
          title="Reality check"
          initial={{ realityCheck: data.realityCheck }}
          fields={[{ key: "realityCheck", label: "Reality check", type: "textarea", full: true }]}
          onSubmit={(v) => roadmap.setRealityCheck(String(v.realityCheck))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
