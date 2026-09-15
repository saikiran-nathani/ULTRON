import { useData } from "./data";
import { uid } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);

export const dashboard = {
  addTodo: (text: string, dueDate: string | null = null) =>
    update((d) => {
      const order = d.dashboard.todos.length;
      d.dashboard.todos.push({
        id: uid(),
        text,
        done: false,
        dueDate,
        order,
        createdAt: new Date().toISOString(),
      });
    }),
  toggleTodo: (id: string) =>
    update((d) => {
      const t = d.dashboard.todos.find((t) => t.id === id);
      if (t) t.done = !t.done;
    }),
  delTodo: (id: string) =>
    update((d) => {
      d.dashboard.todos = d.dashboard.todos.filter((t) => t.id !== id);
    }),
  clearDone: () =>
    update((d) => {
      d.dashboard.todos = d.dashboard.todos.filter((t) => !t.done);
    }),
};

export function useDashboard() {
  const dash = useData((s) => s.data!.dashboard);
  return { dash, ...dashboard };
}
