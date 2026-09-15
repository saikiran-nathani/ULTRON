/**
 * Writes for `research.experiments` — and a note about where this file should
 * not be.
 *
 * **This belongs in `src/store/research.ts`.** Every other domain has a slice
 * there (`career.ts`, `roadmap.ts`, `journal.ts`, `projects.ts`, …) and
 * `research` is the one that was never written, because the domain is new in
 * this stage. `src/store/**` is outside this change's scope, so the mutators
 * live beside the screen that needs them, shaped exactly like a slice so that
 * moving them is a `git mv` plus an import rewrite and nothing else:
 *
 * - the same `const update = (recipe) => useData.getState().update(recipe)`
 *   preamble as `store/career.ts`;
 * - `uid()` from `lib/nexus/format` for new records, so ids carry a
 *   fixed-width `Date.now()` prefix and sort into creation order;
 * - find-by-id then mutate, never index-by-position.
 *
 * Two things this deliberately does not do:
 *
 * - **It never calls `adopt`.** That is sync's entry point: it replaces the
 *   blob verbatim and tells the edit listeners nothing, which is exactly right
 *   for a merged pull and exactly wrong for a person typing. An edit routed
 *   through `adopt` would be saved and then never pushed — invisible on one
 *   device and simply absent on the other four.
 * - **It does not validate `runId`.** Runs live in the hub's own tables and
 *   never enter `NexusData`, so nothing local can say whether an id is good.
 *   Guessing here would put the screen's most important distinction — "not
 *   linked" versus "linked to a run that no longer exists" — behind a check
 *   that has no way to be right.
 */
import { uid } from "@/lib/nexus/format";
import type { Experiment, ExperimentStatus, NexusData } from "@/lib/nexus/types";
import { useData } from "@/store/data";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);
const find = (d: NexusData, id: string) => d.research.experiments.find((e) => e.id === id);

export const research = {
  add: (e: Omit<Experiment, "id">) =>
    update((d) => void d.research.experiments.push({ id: uid(), ...e })),

  edit: (id: string, patch: Partial<Omit<Experiment, "id">>) =>
    update((d) => {
      const e = find(d, id);
      if (e) Object.assign(e, patch);
    }),

  setStatus: (id: string, status: ExperimentStatus) =>
    update((d) => {
      const e = find(d, id);
      if (e) e.status = status;
    }),

  /** Clear the run link without touching anything else. */
  unlinkRun: (id: string) =>
    update((d) => {
      const e = find(d, id);
      if (e) e.runId = "";
    }),

  del: (id: string) =>
    update((d) => {
      d.research.experiments = d.research.experiments.filter((e) => e.id !== id);
    }),
};
