import { useData } from "./data";
import { uid } from "@/lib/nexus/format";
import type { NexusData, Job, Certification } from "@/lib/nexus/types";
import type { JobStatus } from "@/lib/nexus/constants";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);

export const career = {
  addJob: (j: Omit<Job, "id">) =>
    update((d) => void d.career.jobs.push({ id: uid(), ...j })),
  editJob: (id: string, patch: Partial<Job>) =>
    update((d) => {
      const j = d.career.jobs.find((j) => j.id === id);
      if (j) Object.assign(j, patch);
    }),
  setJobStatus: (id: string, status: string) =>
    update((d) => {
      const j = d.career.jobs.find((j) => j.id === id);
      if (j) j.status = status as JobStatus;
    }),
  delJob: (id: string) =>
    update((d) => {
      d.career.jobs = d.career.jobs.filter((j) => j.id !== id);
    }),

  addCert: (c: Omit<Certification, "id">) =>
    update((d) => void d.career.certifications.push({ id: uid(), ...c })),
  editCert: (id: string, patch: Partial<Certification>) =>
    update((d) => {
      const c = d.career.certifications.find((c) => c.id === id);
      if (c) Object.assign(c, patch);
    }),
  delCert: (id: string) =>
    update((d) => {
      d.career.certifications = d.career.certifications.filter((c) => c.id !== id);
    }),
};

export function useCareer() {
  const c = useData((s) => s.data!.career);
  return { career: c, ...career };
}
