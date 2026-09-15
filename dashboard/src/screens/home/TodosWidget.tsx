/**
 * Today's todos — overdue, due today, undated. Nothing further out.
 *
 * A todo due next Friday would still be due next week, so by the plan's own
 * test it is the track screen's content, not the home screen's. The date
 * narrowing in `todayTodos` is what keeps this a widget rather than a list of
 * everything.
 *
 * There is no "add" box here, and that is a boundary rather than an omission:
 * the app has exactly one place a thought enters, and it is Capture. A second
 * input on Home would be a second inbox to remember to drain. Filing a capture
 * as a todo is the documented path in.
 *
 * Ticking keeps the row visible for the rest of the visit. `DashboardTodo` has
 * no `doneAt`, so "done today" cannot be answered from the model — a done todo
 * held by a date rule would sit here forever, and a row that vanishes on tap
 * leaves you wondering whether it registered. Session state is the only honest
 * middle: it cannot survive to next week.
 */
import { useState } from "react";
import { Check, ListChecks } from "lucide-react";
import { Card, CardHead, EmptyState, ScrollList } from "@/components/ui";
import { cn } from "@/lib/cn";
import { relDue, todayStr } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";
import { dashboard } from "@/store/dashboard";
import { todayTodos } from "./selectors";

export function TodosWidget({ data }: { data: NexusData }) {
  // Ids ticked during this visit, so the acknowledgement is visible without
  // inventing a completion date the model does not store.
  const [ticked, setTicked] = useState<ReadonlySet<string>>(() => new Set());
  const today = todayStr();
  const items = todayTodos(data.dashboard.todos, today, ticked);
  const open = items.filter((t) => !t.done).length;

  const toggle = (id: string, done: boolean) => {
    dashboard.toggleTodo(id);
    setTicked((prev) => {
      const next = new Set(prev);
      if (done) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Card className="flex flex-col gap-3.5 p-5">
      <CardHead
        label="due today"
        right={
          open > 0 ? <span className="nums text-[12px] text-fg-dim">{open}</span> : undefined
        }
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<ListChecks size={20} strokeWidth={1.6} />}
          title="Nothing due today"
          hint="Overdue, due-today and undated todos land here. Anything dated further out lives on its track."
          className="py-8"
        />
      ) : (
        <ScrollList maxH={232} className="-mx-1 px-1">
          <ul className="flex flex-col gap-1">
            {items.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => toggle(t.id, t.done)}
                  aria-pressed={t.done}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-sm px-1.5 py-2 text-left transition-colors",
                    "hover:bg-card-hover pointer-coarse:min-h-[44px]",
                  )}
                >
                  {/* A drawn box at rest, not a hover reveal: on a coarse
                      pointer there is no hover, and a checkbox you cannot see
                      until you touch it is a checkbox nobody finds. */}
                  <span
                    aria-hidden
                    className={cn(
                      "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-xs border",
                      t.done ? "border-accent bg-accent/20 text-accent-lt" : "border-line",
                    )}
                  >
                    {t.done && <Check size={11} strokeWidth={2.6} />}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-[12.5px]",
                      t.done ? "text-fg-muted line-through" : "text-fg",
                    )}
                  >
                    {t.text}
                  </span>
                  {t.dueDate && (
                    <span
                      className="nums shrink-0 text-[10.5px]"
                      style={{
                        color:
                          t.dueDate < today ? "var(--color-bad)" : "var(--color-fg-muted)",
                      }}
                    >
                      {relDue(t.dueDate)}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </ScrollList>
      )}
    </Card>
  );
}
