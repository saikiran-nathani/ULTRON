/**
 * Courses — nexus's `academics` domain, ported.
 *
 * Source: `nexus/src/screens/Academics.tsx` + `screens/academics/CourseCard.tsx`.
 * Data: `academics.courses` (each with nested `assignments`) and
 * `academics.semesters`.
 *
 * Three things this screen does that nexus's did not, all forced by the port
 * rather than chosen:
 *
 * 1. **It reads the store defensively.** `useAcademics()` is
 *    `useData((s) => s.data!.academics)` — a non-null assertion on a field
 *    that is `null` until something calls `load()`, and nothing in this build
 *    does yet (`startNexusSync` has no caller). Calling the hook would throw
 *    during render. So the blob is selected with `?.` and the three
 *    not-success states are rendered explicitly.
 * 2. **It orders the list by a field.** nexus rendered `courses.map` in array
 *    order. See the header of `courses/courseMath.tsx`.
 * 3. **The new-course form defaults to the most recent semester**, not
 *    `semesters[0]`.
 *
 * Writes go through the `academics` slice. Never `adopt` — that is sync's
 * entry point, and calling it from a screen would make a local edit arrive as
 * a merge.
 */
import { useState, type ReactNode } from "react";
import { BookMarked, DatabaseZap, Plus, TriangleAlert } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import {
  Button,
  Callout,
  Card,
  CountUp,
  EmptyState,
  FormModal,
  ProgressRing,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { academics as academicsActions } from "@/store/academics";
import { useData } from "@/store/data";
import { CourseCard, courseFields } from "./courses/CourseCard";
import { calcGPA, defaultSemester, sortedCourses } from "./courses/courseMath";

const EYEBROW = "Academics";
const TITLE = "Courses";

export function CoursesScreen() {
  // Three selectors rather than one object: zustand v5 compares by identity,
  // and a fresh `{...}` from a selector re-renders on every store write.
  const loaded = useData((s) => s.loaded);
  const cacheError = useData((s) => s.error);
  const data = useData((s) => s.data?.academics ?? null);

  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);

  // State 1 of 3 — the vault is not open. Distinct from empty (which is a
  // finished screen with nothing in it) and from the error banner below
  // (which sits over real, editable data).
  if (!loaded || !data) return <VaultClosed />;

  const courses = sortedCourses(data.courses);
  const gpa = calcGPA(data.courses);
  const gpaNum = Number(gpa) || 0;
  const totalCredits = data.courses.reduce((s, c) => s + (Number(c.credits) || 0), 0);

  const addCourseModal = () =>
    setModal(
      <FormModal
        title="New course"
        onClose={close}
        fields={courseFields(data.semesters, defaultSemester(data.semesters))}
        onSubmit={(v) =>
          academicsActions.addCourse({
            code: String(v.code),
            name: String(v.name),
            credits: Number(v.credits),
            semester: String(v.semester),
            grade: String(v.grade),
          })
        }
      />,
    );

  return (
    <ScreenShell
      eyebrow={EYEBROW}
      title={TITLE}
      actions={
        <Button variant="primary" icon={<Plus size={14} />} onClick={addCourseModal}>
          New course
        </Button>
      }
    >
      {modal}

      {/* State 2 of 3 — something went wrong, but the data underneath is
          usable. A banner over a working screen, not instead of one. */}
      {cacheError && (
        <Callout
          className="mb-4"
          tone="var(--color-bad)"
          icon={<TriangleAlert size={12} />}
          label="Local cache"
        >
          {cacheError}. What you see is whatever sync has delivered since — edits made
          before this device last synced may be missing.
        </Callout>
      )}

      <Reveal>
        <div className="grid grid-cols-1 gap-3 pt-2 md:grid-cols-3">
          <Card interactive className="flex items-center gap-4 p-5">
            <ProgressRing value={Math.min(100, (gpaNum / 4) * 100)} size={68} stroke={5}>
              <span className="nums text-[15px] text-accent-lt">{gpa}</span>
            </ProgressRing>
            <div>
              <div className="label">Cumulative GPA</div>
              <div className="mt-1 text-[11px] text-fg-muted">on a 4.0 scale</div>
            </div>
          </Card>
          <Card interactive className="p-5">
            <div className="label">Courses</div>
            <CountUp
              value={data.courses.length}
              className="nums mt-1.5 block text-[25px] leading-none text-fg"
            />
          </Card>
          <Card interactive className="p-5">
            <div className="label">Total credits</div>
            <CountUp
              value={totalCredits}
              className="nums mt-1.5 block text-[25px] leading-none text-fg"
            />
          </Card>
        </div>
      </Reveal>

      <div className="mt-5">
        {courses.length === 0 ? (
          // State 3 of 3 — empty, and finished: dashed rule, centred, and a
          // way out of it. Nothing here says anything is wrong.
          <EmptyState
            icon={<BookMarked size={22} strokeWidth={1.6} />}
            title="No courses yet"
            hint="Add a course, then track its assignments and work back from the grade you want."
            action={
              <Button variant="primary" icon={<Plus size={14} />} onClick={addCourseModal}>
                New course
              </Button>
            }
          />
        ) : (
          <Stagger className="flex flex-col gap-4">
            {courses.map((c) => (
              <Reveal key={c.id}>
                <CourseCard course={c} semesters={data.semesters} />
              </Reveal>
            ))}
          </Stagger>
        )}
      </div>
    </ScreenShell>
  );
}

/**
 * The vault has not been read yet.
 *
 * Deliberately not a spinner. `load()` is app-boot wiring — `startNexusSync`
 * owns it, because it is the only caller that can carry `cacheHit` through to
 * the bridge, and a screen that quietly called `load()` on mount would be boot
 * wiring hiding in a screen. Nothing calls it in this build, so this state is
 * currently what the screen shows; the button makes it recoverable in one tap
 * instead of leaving a dead screen.
 */
function VaultClosed() {
  return (
    <ScreenShell eyebrow={EYEBROW} title={TITLE}>
      <Callout
        tone="var(--color-info)"
        icon={<DatabaseZap size={12} />}
        label="Vault not open"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void useData.getState().load()}>
            Open
          </Button>
        }
      >
        Courses reads the local vault, and nothing has opened it in this session yet —
        sync boots it once <span className="nums">startNexusSync</span> is wired into the
        app shell. Open it now to work offline against the cache.
      </Callout>
    </ScreenShell>
  );
}
