import { useData } from "./data";
import { uid } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";

const update = (recipe: (d: NexusData) => void) => useData.getState().update(recipe);

/** The next `order` for a new todo: one past the highest in use.
 *
 * Never `todos.length`. Array length is array position wearing another name,
 * and array position does not survive per-record sync — records arrive one at
 * a time and each array is rebuilt in ascending id order. Two devices adding a
 * todo offline both read the same length, both claim the same slot, and after
 * the merge the tie is broken by id, which is arbitrary; neither user sees
 * what they arranged. Length is also simply wrong after a delete, when it
 * reissues an order already taken.
 *
 * Exported so its test can bind to this function rather than restate the
 * arithmetic. A test that reimplements the rule passes while the caller is
 * broken — which happened on the first attempt at this one.
 */
export function nextTodoOrder(todos: { order: number }[]): number {
  return todos.reduce((n, t) => Math.max(n, t.order), -1) + 1;
}

export const dashboard = {
  addTodo: (text: string, dueDate: string | null = null) =>
    update((d) => {
      // See `nextTodoOrder`.
      //
      // Array length is array position wearing another name, and array
      // position does not survive per-record sync: records arrive one at a
      // time and each array is rebuilt in ascending id order. Two devices
      // adding a todo offline both read the same length and both claim the
      // same slot, so after the merge the order is decided by id — which is
      // arbitrary — and neither device shows what its user arranged.
      const order = nextTodoOrder(d.dashboard.todos);
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
