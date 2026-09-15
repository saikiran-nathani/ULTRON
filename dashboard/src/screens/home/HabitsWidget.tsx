/**
 * Today's habit ticks. A tick is a today thing, so it lives here.
 *
 * What is missing is the point of the widget: **no streak.** `habitStreak`
 * exists in `@/store/journal` and this deliberately does not call it. A streak
 * is accumulated narrative — it would still be true next week, and the plan's
 * test sends it to the vault. So this answers exactly one question, "have I
 * done these today", and the row is a switch rather than a readout.
 *
 * The tick goes through `journal.toggleHabit`, which writes or removes one
 * `HabitCompletion` whose id comes from `completionId(habitId, date)`. That id
 * is derived rather than random on purpose: two devices ticking the same habit
 * on the same day mint the *same* record and converge onto one, instead of
 * merging into two identical ticks. Nothing here builds that key by hand.
 */
import { CheckCircle2, Circle, Sprout } from "lucide-react";
import { Card, CardHead, EmptyState } from "@/components/ui";
import { cn } from "@/lib/cn";
import { todayStr } from "@/lib/nexus/format";
import type { NexusData } from "@/lib/nexus/types";
import { journal } from "@/store/journal";
import { habitsToday } from "./selectors";

export function HabitsWidget({ data }: { data: NexusData }) {
  const today = todayStr();
  const ticks = habitsToday(data.journal.habits, data.journal.habitCompletions, today);
  const done = ticks.filter((t) => t.done).length;

  return (
    <Card className="flex flex-col gap-3.5 p-5">
      <CardHead
        label="today's habits"
        right={
          ticks.length > 0 ? (
            <span className="nums text-[12px] text-fg-dim">
              {done}/{ticks.length}
            </span>
          ) : undefined
        }
      />

      {ticks.length === 0 ? (
        <EmptyState
          icon={<Sprout size={20} strokeWidth={1.6} />}
          title="No habits to tick"
          hint="Habits are created in the journal. Once one exists, today's tick is one tap from here."
          className="py-8"
        />
      ) : (
        <ul className="flex flex-col gap-1">
          {ticks.map(({ habit, done: on }) => (
            <li key={habit.id}>
              <button
                onClick={() => journal.toggleHabit(habit.id, today)}
                aria-pressed={on}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-sm px-1.5 py-2 text-left transition-colors",
                  "hover:bg-card-hover pointer-coarse:min-h-[44px]",
                )}
              >
                {/* The accent, not `habit.color`. That field is a free string
                    in the model and may hold anything a previous build wrote;
                    an unreadable or empty value would render the tick state
                    invisible, and the tick state is the entire widget. */}
                {on ? (
                  <CheckCircle2
                    size={17}
                    strokeWidth={1.9}
                    className="shrink-0 text-accent-lt"
                    aria-hidden
                  />
                ) : (
                  <Circle
                    size={17}
                    strokeWidth={1.6}
                    className="shrink-0 text-fg-muted"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-[12.5px]",
                    on ? "text-fg" : "text-fg-dim",
                  )}
                >
                  {habit.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
