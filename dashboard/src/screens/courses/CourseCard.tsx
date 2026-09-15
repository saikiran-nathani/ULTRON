/**
 * One course: its standing, its assignments, and the target calculator.
 *
 * Ported from nexus's `screens/academics/CourseCard.tsx`. Four things changed,
 * and each is noted at the line that changed:
 *
 * - **Modals are owned here.** nexus pushed JSX into a global `setModal` slot
 *   and the modal closed itself through that store. This kit's modals take a
 *   required `onClose`, so the card holds one `modal` state value and the
 *   dismissal is explicit. `store/ui.ts` still carries the old slot and says
 *   not to use it.
 * - **Assignments are ordered by due date**, not by array position.
 * - **The dense assignment row becomes two lines below `md:`.** Eight children
 *   on one line is a design for a 900px card, and on a 375px phone it left the
 *   assignment name about two characters wide.
 * - **Every colour is a token.** nexus named `--color-copper`,
 *   `--color-amber`, `--color-steel-100`; none of the three exists in this
 *   theme. The mapping lives in `courseMath.tsx` so it is stated once.
 */
import { useState, type ReactNode } from "react";
import { AlertTriangle, Bell, BellOff, FileUp, Pencil, Plus, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  FormModal,
  IconButton,
  inputCls,
  labelCls,
  type FormField,
} from "@/components/ui";
import { GRADES, STATUSES, type AssignmentStatus } from "@/lib/nexus/constants";
import { relDue } from "@/lib/nexus/format";
import { academics } from "@/store/academics";
import type { Assignment, Course } from "@/lib/nexus/types";
import {
  dueTone,
  getWeightedStats,
  gradeNeeded,
  sortedAssignments,
  sortedSemesters,
  statusTone,
  totalWeight,
} from "./courseMath";

/** Course fields, shared by the card's edit form and the screen's create form. */
export function courseFields(semesters: string[], semesterDefault?: string): FormField[] {
  return [
    { key: "code", label: "Code", required: true, placeholder: "CS5010" },
    { key: "name", label: "Name", required: true },
    { key: "credits", label: "Credits", type: "number", step: 1, defaultValue: 4 },
    {
      key: "semester",
      label: "Semester",
      // Free text rather than a select, because there is no `addSemester`
      // action: typing a new term here is the only way one ever enters the
      // store. The placeholder lists what is already on record so the spelling
      // stays consistent — two spellings of one term split a course list in
      // half and nothing looks broken.
      placeholder: sortedSemesters(semesters).slice(0, 2).join(" · ") || "Fall 2025",
      ...(semesterDefault ? { defaultValue: semesterDefault } : {}),
    },
    { key: "grade", label: "Final grade", type: "select", options: GRADES.map((g) => ({ value: g, label: g })) },
  ];
}

const assignmentFields: FormField[] = [
  { key: "name", label: "Name", required: true, full: true },
  {
    key: "status",
    label: "Status",
    type: "select",
    defaultValue: "Not Started",
    options: STATUSES.map((s) => ({ value: s, label: s })),
  },
  { key: "dueDate", label: "Due date", type: "date" },
  { key: "weight", label: "Weight %", type: "number", step: 1, keepEmpty: true },
  { key: "grade", label: "Grade (0–100)", type: "number", step: 0.1, keepEmpty: true },
];

export function CourseCard({ course, semesters }: { course: Course; semesters: string[] }) {
  /**
   * The card's one modal slot. A single value rather than a boolean per form:
   * two modals open at once is not a state this card has, and a `null` here is
   * the only "closed".
   */
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);
  const [target, setTarget] = useState("");

  const assignments = sortedAssignments(course.assignments);
  const stats = getWeightedStats(course.assignments);
  const tw = totalWeight(course.assignments);
  // `Number("")` is 0 and 0 is a legitimate target, so the guard is on the
  // string. Without it an empty box reads as "I want a 0%" and the calculator
  // answers it.
  const needed = stats && target.trim() !== "" ? gradeNeeded(Number(target), stats) : null;

  const editCourseModal = () =>
    setModal(
      <FormModal
        title="Edit course"
        onClose={close}
        initial={{
          code: course.code,
          name: course.name,
          credits: course.credits,
          semester: course.semester,
          grade: course.grade,
        }}
        fields={courseFields(semesters)}
        onSubmit={(v) =>
          academics.editCourse(course.id, {
            code: String(v.code),
            name: String(v.name),
            credits: Number(v.credits),
            semester: String(v.semester),
            grade: String(v.grade),
          })
        }
      />,
    );

  const assignmentPatch = (v: Record<string, string | number | boolean>) => ({
    name: String(v.name),
    status: String(v.status) as AssignmentStatus,
    dueDate: String(v.dueDate),
    weight: v.weight === "" ? "" : Number(v.weight),
    grade: v.grade === "" ? "" : Number(v.grade),
  });

  const addAssignmentModal = () =>
    setModal(
      <FormModal
        title="Add assignment"
        onClose={close}
        fields={assignmentFields}
        onSubmit={(v) => academics.addAssignment(course.id, assignmentPatch(v))}
      />,
    );

  const editAssignmentModal = (a: Assignment) =>
    setModal(
      <FormModal
        title="Edit assignment"
        onClose={close}
        initial={{ name: a.name, status: a.status, dueDate: a.dueDate, weight: a.weight, grade: a.grade }}
        fields={assignmentFields}
        onSubmit={(v) => academics.editAssignment(course.id, a.id, assignmentPatch(v))}
      />,
    );

  const importModal = () =>
    setModal(
      <FormModal
        title="Import syllabus"
        submitLabel="Import"
        onClose={close}
        fields={[
          {
            key: "text",
            label: "One per line: Name | YYYY-MM-DD | Weight%",
            type: "textarea",
            full: true,
            placeholder: "HW1 | 2026-09-10 | 10%\nMidterm | 2026-10-15 | 25%",
          },
        ]}
        onSubmit={(v) => academics.importSyllabus(course.id, String(v.text))}
      />,
    );

  const deleteCourseModal = () =>
    setModal(
      <ConfirmDialog
        title="Delete course"
        message={`Delete "${course.name}" and its ${course.assignments.length} assignment${
          course.assignments.length === 1 ? "" : "s"
        }?`}
        onClose={close}
        onConfirm={() => academics.delCourse(course.id)}
      />,
    );

  return (
    <Card className="p-5" active={course.grade !== ""}>
      {modal}

      {/* Below `md:` the action trio drops to its own line instead of
          competing with the course name for a 375px row. From `md:` this is
          nexus's `flex items-start justify-between`, unchanged. */}
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="nums text-[12px] text-accent-lt">{course.code}</span>
            {course.grade && <Chip>{course.grade}</Chip>}
          </div>
          <div className="display text-[15px] text-fg">{course.name}</div>
          <div className="mt-0.5 text-[11px] text-fg-muted">
            {course.credits} cr · {course.semester}
            {stats && (
              <span>
                {" "}
                · standing {stats.avg.toFixed(1)}% over {stats.gradedWeight}% graded
              </span>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton icon={<FileUp size={14} />} label="Import syllabus" onClick={importModal} />
          <IconButton icon={<Pencil size={14} />} label="Edit course" onClick={editCourseModal} />
          <IconButton icon={<Trash2 size={14} />} label="Delete course" danger onClick={deleteCourseModal} />
        </div>
      </div>

      {tw > 0 && Math.abs(tw - 100) > 0.01 && (
        <div className="mt-3 flex items-start gap-1.5 text-[11px] text-[var(--color-warn)]">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" />
          Assignment weights sum to {tw}% (expected 100%).
        </div>
      )}

      {/* Assignments, due-date order. Never `course.assignments.map`. */}
      <div className="mt-4 flex flex-col gap-0.5">
        {assignments.length === 0 ? (
          <p className="text-[12px] text-fg-muted">
            No assignments yet — add one, or paste the syllabus.
          </p>
        ) : (
          assignments.map((a) => (
            <div
              key={a.id}
              className="flex flex-col gap-1.5 rounded-sm px-2 py-2 transition-colors hover:bg-card-hover md:flex-row md:items-center md:gap-3 md:py-1.5"
            >
              {/* `md:contents` dissolves both wrappers at `md:` and up, so the
                  row's flex children there are exactly nexus's eight, at
                  nexus's `gap-3`. Below `md:` the wrappers are what make it
                  two lines. */}
              <div className="flex min-w-0 items-center gap-2 md:contents">
                <Chip color={statusTone(a.status)}>{a.status}</Chip>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-dim">{a.name}</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 md:contents">
                {a.dueDate && (
                  <span className="nums text-[10.5px]" style={{ color: dueTone(a.dueDate) }}>
                    {relDue(a.dueDate)}
                  </span>
                )}
                {a.weight !== "" && <span className="nums text-[11px] text-fg-muted">{a.weight}%</span>}
                {a.grade !== "" && <span className="nums text-[11.5px] text-fg">{a.grade}</span>}
                <IconButton
                  icon={a.reminder ? <Bell size={13} /> : <BellOff size={13} />}
                  label={a.reminder ? "Reminder on" : "Reminder off"}
                  onClick={() => academics.toggleReminder(course.id, a.id)}
                  className={a.reminder ? "text-accent-lt" : ""}
                />
                <IconButton
                  icon={<Pencil size={12} />}
                  label="Edit assignment"
                  onClick={() => editAssignmentModal(a)}
                />
                {/* One tap, as in nexus. Confirmation is reserved for the
                    deletes that cascade — a course, a plan, a module — where
                    the tap destroys records that are not on screen. */}
                <IconButton
                  icon={<Trash2 size={12} />}
                  label="Delete assignment"
                  danger
                  onClick={() => academics.delAssignment(course.id, a.id)}
                />
              </div>
            </div>
          ))
        )}
      </div>

      {/* Calculator + add. Stacks below `md:`; `md:` is nexus's row. */}
      <div className="mt-4 flex flex-col gap-3 border-t-[0.5px] border-line pt-3 md:flex-row md:items-end md:justify-between md:gap-4">
        <div className="flex flex-wrap items-end gap-2">
          <label>
            <span className={labelCls}>Target %</span>
            <input
              type="number"
              inputMode="decimal"
              className={inputCls + " w-24"}
              placeholder="90"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
          </label>
          {needed !== null && (
            <div className="pb-1.5 text-[12px]">
              <span className="text-fg-muted">Need </span>
              <span className="nums" style={{ color: neededTone(needed) }}>
                {needed > 100 ? "impossible" : needed < 0 ? "already secured" : `${needed.toFixed(1)}%`}
              </span>
              <span className="text-fg-muted"> on remaining work</span>
            </div>
          )}
          {target.trim() !== "" && !stats && (
            <span className="pb-1.5 text-[11px] text-fg-muted">Add graded assignments first.</span>
          )}
          {target.trim() !== "" && stats !== null && needed === null && (
            <span className="pb-1.5 text-[11px] text-fg-muted">
              Every point is graded — the grade is settled.
            </span>
          )}
        </div>
        <Button
          size="sm"
          variant="subtle"
          icon={<Plus size={13} />}
          onClick={addAssignmentModal}
          className="self-start md:self-auto"
        >
          Assignment
        </Button>
      </div>
    </Card>
  );
}

const neededTone = (needed: number): string =>
  needed > 100 ? "var(--color-bad)" : needed < 0 ? "var(--color-good)" : "var(--color-accent-lt)";
