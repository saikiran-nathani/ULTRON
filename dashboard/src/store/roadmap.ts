import { useData } from "./data";
import { uid, todayStr } from "@/lib/nexus/format";
import type {
  NexusData,
  Proficiency,
  RoadmapPhase,
  RoadmapLayer,
  LayerToolGroup,
  LayerResource,
} from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);
const findPhase = (d: NexusData, id: string) => d.roadmap.phases.find((p) => p.id === id);
const findLayer = (d: NexusData, id: string) => d.roadmap.layers.find((l) => l.id === id);
const sortPhases = (d: NexusData) => d.roadmap.phases.sort((a, b) => a.start.localeCompare(b.start));

export const roadmap = {
  /* Phases */
  addPhase: (p: { title: string; period: string; goal: string; start: string; end: string }) =>
    update((d) => {
      d.roadmap.phases.push({ id: uid(), tasks: [], ...p });
      sortPhases(d);
    }),
  editPhase: (id: string, patch: Partial<Pick<RoadmapPhase, "title" | "period" | "goal" | "start" | "end">>) =>
    update((d) => {
      const p = findPhase(d, id);
      if (p) Object.assign(p, patch);
      sortPhases(d);
    }),
  delPhase: (id: string) =>
    update((d) => {
      d.roadmap.phases = d.roadmap.phases.filter((p) => p.id !== id);
    }),

  /* Tasks */
  addTask: (phaseId: string, text: string) =>
    update((d) => {
      const p = findPhase(d, phaseId);
      if (p) p.tasks.push({ id: uid(), text, done: false });
    }),
  toggleTask: (phaseId: string, taskId: string) =>
    update((d) => {
      const t = findPhase(d, phaseId)?.tasks.find((t) => t.id === taskId);
      if (t) t.done = !t.done;
    }),
  editTask: (phaseId: string, taskId: string, text: string) =>
    update((d) => {
      const t = findPhase(d, phaseId)?.tasks.find((t) => t.id === taskId);
      if (t) t.text = text;
    }),
  delTask: (phaseId: string, taskId: string) =>
    update((d) => {
      const p = findPhase(d, phaseId);
      if (p) p.tasks = p.tasks.filter((t) => t.id !== taskId);
    }),

  /* Layers */
  setProficiency: (layerId: string, level: Proficiency) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) l.proficiency = level;
    }),
  editLayer: (layerId: string, patch: Partial<Pick<RoadmapLayer, "name" | "tag" | "target" | "what" | "role">>) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) Object.assign(l, patch);
    }),
  addLayer: (l: { name: string; tag: string; target: string; what: string; role: string }) =>
    update((d) =>
      void d.roadmap.layers.push({
        id: uid(),
        proficiency: "none",
        tools: [],
        methods: [],
        resources: [],
        demo: { name: "", tree: "", flow: [] },
        ...l,
      }),
    ),
  delLayer: (layerId: string) =>
    update((d) => {
      d.roadmap.layers = d.roadmap.layers.filter((l) => l.id !== layerId);
    }),
  setTools: (layerId: string, tools: LayerToolGroup[]) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) l.tools = tools;
    }),
  setMethods: (layerId: string, methods: string[]) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) l.methods = methods;
    }),
  setResources: (layerId: string, resources: LayerResource[]) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) l.resources = resources;
    }),
  setDemo: (layerId: string, demo: { name: string; tree: string; flow: string[] }) =>
    update((d) => {
      const l = findLayer(d, layerId);
      if (l) l.demo = demo;
    }),

  /* Narrative blocks */
  setLane: (text: string) => update((d) => void (d.roadmap.lane = text)),
  setRealityCheck: (text: string) => update((d) => void (d.roadmap.realityCheck = text)),
  setThroughLine: (text: string) => update((d) => void (d.roadmap.throughLine = text)),
  setDeadline: (date: string) => update((d) => void (d.roadmap.deadline = date)),
};

export function useRoadmap() {
  const rm = useData((s) => s.data!.roadmap);
  return { rm, ...roadmap };
}

/** Overall task progress across all phases. */
export function roadmapProgress(phases: RoadmapPhase[]) {
  const all = phases.flatMap((p) => p.tasks);
  const done = all.filter((t) => t.done).length;
  return { done, total: all.length, pct: all.length ? (done / all.length) * 100 : 0 };
}

/** Index of the current phase: earliest phase that hasn't ended yet. */
export function currentPhaseIndex(phases: RoadmapPhase[]): number {
  const today = todayStr();
  const idx = phases.findIndex((p) => p.end >= today);
  return idx === -1 ? phases.length - 1 : idx;
}
