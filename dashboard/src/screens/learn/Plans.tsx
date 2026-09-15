/**
 * Study plans: plan → modules → topics, with a checkbox per topic.
 *
 * Ported from nexus's `screens/study/Plans.tsx`. Five changes:
 *
 * - **Plans, modules and topics are ordered by a field.** All three were
 *   rendered in array order; see the header of `studyMath.tsx` for why that
 *   cannot survive per-record sync, and for the note about `StudyModule`
 *   having no order field to use.
 * - **The topic checkbox is a real target.** It was a 16px box in a `py-0.5`
 *   row — about 20px of tappable height, on the control this whole screen
 *   exists to press.
 * - **Adding a topic no longer requires a hardware keyboard.** The source's
 *   inline input committed on Enter and was *destroyed* on blur, with no
 *   submit control anywhere. On a phone, blur is what happens when you reach
 *   for anything, so the field vanished and took the typing with it.
 * - **Deleting a module asks first.** It takes every topic in it with it, and
 *   those are records the tap cannot see.
 * - **No colour literals.** The unchecked checkbox border was a hard-coded
 *   translucent copper written inline in the class string — a literal, in a
 *   component, naming a hue this theme does not have. It is `border-line-strong`
 *   now.
 */
import { useState, type ReactNode } from "react";
import { Check, ChevronDown, GraduationCap, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  FormModal,
  IconButton,
  ProgressRing,
  inputCls,
  type FormField,
} from "@/components/ui";
import { cn } from "@/lib/cn";
import { relDue } from "@/lib/nexus/format";
import { study } from "@/store/study";
import type { StudyPlan, StudyPlanner } from "@/lib/nexus/types";
import { planProgress, sortedModules, sortedPlans, sortedTopics } from "./studyMath";

const planFields: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  { key: "course", label: "Course" },
  { key: "deadline", label: "Deadline", type: "date" },
];

function TopicCheck({ done, onClick, label }: { done: boolean; onClick: () => void; label: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={done}
      // `flex-1` + the coarse floor: the target is the whole row, not the
      // 16px box. The box stays 16px because it is the *mark*, and a 44px
      // checkbox in a checklist reads as a button.
      className="flex flex-1 items-center gap-2 py-0.5 text-left pointer-coarse:min-h-[44px]"
    >
      <span
        className={cn(
          "grid h-4 w-4 shrink-0 place-items-center rounded-[3px] border transition-all duration-150",
          done ? "border-accent bg-accent text-bg" : "border-line-strong",
        )}
      >
        {done && <Check size={11} strokeWidth={3} aria-hidden />}
      </span>
      <span className={cn("text-[12.5px]", done ? "text-fg-muted line-through" : "text-fg-dim")}>
        {label}
      </span>
    </button>
  );
}

function PlanCard({ plan }: { plan: StudyPlan }) {
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);
  const [open, setOpen] = useState(true);
  const [addingTo, setAddingTo] = useState<string | null>(null);
  const [topicText, setTopicText] = useState("");
  const prog = planProgress(plan);
  const modules = sortedModules(plan.modules);

  const editModal = () =>
    setModal(
      <FormModal
        title="Edit plan"
        onClose={close}
        initial={{ name: plan.name, course: plan.course, deadline: plan.deadline }}
        fields={planFields}
        onSubmit={(v) =>
          study.editPlan(plan.id, {
            name: String(v.name),
            course: String(v.course),
            deadline: String(v.deadline),
          })
        }
      />,
    );

  const addModuleModal = () =>
    setModal(
      <FormModal
        title="Add module"
        onClose={close}
        fields={[{ key: "name", label: "Module name", required: true, full: true }]}
        onSubmit={(v) => study.addModule(plan.id, String(v.name))}
      />,
    );

  const deletePlanModal = () =>
    setModal(
      <ConfirmDialog
        title="Delete plan"
        message={`Delete "${plan.name}", its ${plan.modules.length} module${
          plan.modules.length === 1 ? "" : "s"
        } and all ${prog.total} topic${prog.total === 1 ? "" : "s"}?`}
        onClose={close}
        onConfirm={() => study.delPlan(plan.id)}
      />,
    );

  const deleteModuleModal = (modId: string, name: string, topics: number) =>
    setModal(
      <ConfirmDialog
        title="Delete module"
        message={`Delete "${name}" and its ${topics} topic${topics === 1 ? "" : "s"}?`}
        onClose={close}
        onConfirm={() => study.delModule(plan.id, modId)}
      />,
    );

  const commitTopic = (modId: string) => {
    const text = topicText.trim();
    if (!text) return;
    study.addTopic(plan.id, modId, text);
    // Cleared but left open, so a list of topics is one field and many
    // returns rather than one field per reopen.
    setTopicText("");
  };

  return (
    <Card className="p-5" active={prog.pct === 100 && prog.total > 0}>
      {modal}

      <div className="flex items-start gap-4">
        <ProgressRing value={prog.pct} size={52} stroke={4} className="shrink-0">
          <span className="nums text-[10px] text-fg">{Math.round(prog.pct)}%</span>
        </ProgressRing>
        <div className="min-w-0 flex-1">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            className="flex items-center gap-2 text-left pointer-coarse:min-h-[44px]"
          >
            <span className="display text-[15px] text-fg">{plan.name}</span>
            <ChevronDown
              size={14}
              aria-hidden
              className={cn("shrink-0 text-fg-muted transition-transform", open && "rotate-180")}
            />
          </button>
          <div className="mt-0.5 text-[11px] text-fg-muted">
            {plan.course && <span>{plan.course} · </span>}
            {prog.done}/{prog.total} topics
            {plan.deadline && <span> · {relDue(plan.deadline)}</span>}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={<Pencil size={13} />} label="Edit plan" onClick={editModal} />
          <IconButton icon={<Trash2 size={13} />} label="Delete plan" danger onClick={deletePlanModal} />
        </div>
      </div>

      {open && (
        <div className="mt-4 flex flex-col gap-3 border-t-[0.5px] border-line pt-3">
          {modules.length === 0 && (
            <p className="text-[12px] text-fg-muted">
              No modules yet — a module is a chapter, a week, or a unit.
            </p>
          )}
          {modules.map((m) => {
            const topics = sortedTopics(m.topics);
            return (
              <div key={m.id}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="label min-w-0 truncate">{m.name}</span>
                  <div className="flex shrink-0 items-center gap-1">
                    <IconButton
                      icon={<Plus size={12} />}
                      label={`Add topic to ${m.name}`}
                      onClick={() => {
                        setAddingTo(m.id);
                        setTopicText("");
                      }}
                    />
                    <IconButton
                      icon={<Trash2 size={12} />}
                      label={`Delete module ${m.name}`}
                      danger
                      onClick={() => deleteModuleModal(m.id, m.name, m.topics.length)}
                    />
                  </div>
                </div>
                <div className="flex flex-col gap-0.5 pl-1">
                  {topics.map((tp) => (
                    <div key={tp.id} className="flex items-center gap-2">
                      <TopicCheck
                        done={tp.done}
                        label={tp.name}
                        onClick={() => study.toggleTopic(plan.id, m.id, tp.id)}
                      />
                      <IconButton
                        icon={<Trash2 size={11} />}
                        label={`Delete topic ${tp.name}`}
                        danger
                        onClick={() => study.delTopic(plan.id, m.id, tp.id)}
                      />
                    </div>
                  ))}
                  {addingTo === m.id && (
                    // No `onBlur` handler. The source cancelled on blur, which
                    // on a phone fires the moment you reach for anything —
                    // including the Add button you would otherwise press.
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <input
                        autoFocus
                        className={inputCls + " min-w-0 flex-1"}
                        placeholder="New topic"
                        value={topicText}
                        onChange={(e) => setTopicText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            commitTopic(m.id);
                          }
                          if (e.key === "Escape") setAddingTo(null);
                        }}
                      />
                      <Button
                        size="sm"
                        variant="primary"
                        onClick={() => commitTopic(m.id)}
                        disabled={topicText.trim() === ""}
                      >
                        Add
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setAddingTo(null)}>
                        Done
                      </Button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          <Button
            size="sm"
            variant="ghost"
            icon={<Plus size={13} />}
            onClick={addModuleModal}
            className="self-start"
          >
            Add module
          </Button>
        </div>
      )}
    </Card>
  );
}

export function Plans({ sp }: { sp: StudyPlanner }) {
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);
  const plans = sortedPlans(sp.plans);

  const addPlanModal = () =>
    setModal(
      <FormModal
        title="New study plan"
        onClose={close}
        fields={planFields}
        onSubmit={(v) =>
          study.addPlan({
            name: String(v.name),
            course: String(v.course),
            deadline: String(v.deadline),
          })
        }
      />,
    );

  return (
    <div className="flex flex-col gap-4 pt-5">
      {modal}
      <div className="flex justify-end">
        <Button variant="primary" icon={<Plus size={14} />} onClick={addPlanModal}>
          New plan
        </Button>
      </div>
      {plans.length === 0 ? (
        <EmptyState
          icon={<GraduationCap size={22} strokeWidth={1.6} />}
          title="No study plans"
          hint="Create a plan, break it into modules and topics, and check them off."
          action={
            <Button variant="primary" icon={<Plus size={14} />} onClick={addPlanModal}>
              New plan
            </Button>
          }
        />
      ) : (
        plans.map((p) => <PlanCard key={p.id} plan={p} />)
      )}
    </div>
  );
}
