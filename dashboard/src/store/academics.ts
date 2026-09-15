import { useData } from "./data";
import { uid } from "@/lib/nexus/format";
import type { NexusData, Assignment } from "@/lib/nexus/types";
import type { Grade } from "@/lib/nexus/constants";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);

export const academics = {
  addCourse: (c: { name: string; code: string; credits: number; semester: string; grade: string }) =>
    update((d) => void d.academics.courses.push({ id: uid(), assignments: [], ...c, grade: c.grade as Grade | "" })),
  editCourse: (id: string, patch: Partial<{ name: string; code: string; credits: number; semester: string; grade: string }>) =>
    update((d) => {
      const c = d.academics.courses.find((c) => c.id === id);
      if (c) Object.assign(c, patch);
    }),
  delCourse: (id: string) =>
    update((d) => {
      d.academics.courses = d.academics.courses.filter((c) => c.id !== id);
    }),

  addAssignment: (courseId: string, a: Omit<Assignment, "id" | "reminder">) =>
    update((d) => {
      const c = d.academics.courses.find((c) => c.id === courseId);
      if (c) c.assignments.push({ id: uid(), reminder: false, ...a });
    }),
  editAssignment: (courseId: string, aId: string, patch: Partial<Assignment>) =>
    update((d) => {
      const a = d.academics.courses.find((c) => c.id === courseId)?.assignments.find((a) => a.id === aId);
      if (a) Object.assign(a, patch);
    }),
  delAssignment: (courseId: string, aId: string) =>
    update((d) => {
      const c = d.academics.courses.find((c) => c.id === courseId);
      if (c) c.assignments = c.assignments.filter((a) => a.id !== aId);
    }),
  toggleReminder: (courseId: string, aId: string) =>
    update((d) => {
      const a = d.academics.courses.find((c) => c.id === courseId)?.assignments.find((a) => a.id === aId);
      if (a) a.reminder = !a.reminder;
    }),

  /** Bulk import: one assignment per line, "Name | YYYY-MM-DD | Weight%". */
  importSyllabus: (courseId: string, text: string) =>
    update((d) => {
      const c = d.academics.courses.find((c) => c.id === courseId);
      if (!c) return;
      text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach((line) => {
          const [name, due, weight] = line.split("|").map((s) => s.trim());
          if (!name) return;
          c.assignments.push({
            id: uid(),
            name,
            status: "Not Started",
            dueDate: due || "",
            weight: weight ? weight.replace(/%/g, "") : "",
            grade: "",
            reminder: false,
          });
        });
    }),
};

export function useAcademics() {
  const academicsData = useData((s) => s.data!.academics);
  return { academics: academicsData, ...academics };
}
