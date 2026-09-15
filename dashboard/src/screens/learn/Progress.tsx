/**
 * Streak, weekly goal, XP level, the 13-week heatmap, and the session log.
 *
 * Ported from nexus's `screens/study/Progress.tsx`. The important change is
 * the heatmap.
 *
 * nexus put each day's minutes in a `title` attribute and scaled the cell on
 * hover. A `title` tooltip does not exist on a touch screen and neither does
 * hover, so on the phone and the iPad — three of this app's five devices — the
 * entire readout was unreachable: 91 coloured squares and no way to learn what
 * any of them meant. The cells are buttons now, a tap pins the day's figure as
 * text above the grid, and the figure is in each cell's accessible name so a
 * screen reader gets it too. The `title` stays for the desktop, where it
 * worked.
 *
 * The rest: XP is folded over the sessions rather than read from the deleted
 * `StudyPlanner.xp` counter, the session list is ordered by date with an id
 * tiebreak, the day list is built once by `heatmapDays` instead of twice by
 * two loops that had to agree about the range, and the dense session row wraps
 * below `md:`.
 */
import { useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { CalendarDays, Flame, Pencil, Snowflake, Trash2 } from "lucide-react";
import {
  Button,
  Card,
  CountUp,
  EmptyState,
  FormModal,
  IconButton,
  ProgressBar,
  ProgressRing,
  ScrollList,
} from "@/components/ui";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { fmtDuration, longDate, todayStr } from "@/lib/nexus/format";
import { study } from "@/store/study";
import type { StudyPlanner, StudySession } from "@/lib/nexus/types";
import {
  calculateStreak,
  getRollingWeekMinutes,
  getXPLevel,
  heatmapDays,
  levelPct,
  sortedSessions,
  totalXp,
} from "./studyMath";

const HEATMAP_DAYS = 91;
const LEGEND_STOPS = [0.25, 0.5, 0.75, 1];

function Heatmap({ sessions }: { sessions: StudySession[] }) {
  const [picked, setPicked] = useState<string | null>(null);
  const days = heatmapDays(sessions, HEATMAP_DAYS);
  // 60 as the floor, so a single light week does not make one 20-minute day
  // look like a maximum-intensity one.
  const max = Math.max(60, ...days.map((d) => d.mins));
  const shown = picked ? days.find((d) => d.date === picked) : undefined;

  return (
    <div>
      {/* The readout the `title` attribute used to hold, as text. Always
          present — a line that appears only once something is selected makes
          the grid jump by its own height on the first tap. */}
      <div className="mb-2 min-h-4 text-[11px] text-fg-muted" aria-live="polite">
        {shown ? (
          <>
            <span className="text-fg-dim">{longDate(shown.date)}</span>
            {" · "}
            <span className="nums">{shown.mins === 0 ? "nothing logged" : fmtDuration(shown.mins)}</span>
          </>
        ) : (
          "Tap a day for its total."
        )}
      </div>

      <div className="grid grid-flow-col grid-rows-7 gap-1">
        {days.map((d) => {
          const intensity = d.mins === 0 ? 0 : 0.2 + 0.8 * (d.mins / max);
          const strong = intensity > 0.7;
          const on = picked === d.date;
          return (
            <button
              key={d.date}
              title={`${d.date} · ${fmtDuration(d.mins)}`}
              aria-label={`${d.date}: ${d.mins === 0 ? "nothing logged" : fmtDuration(d.mins)}`}
              aria-pressed={on}
              onClick={() => setPicked(on ? null : d.date)}
              // 91 cells cannot each be 44px, so the target stays small and the
              // *information* is what moved out of hover. The coarse bump to
              // 16px plus the gap gives a ~20px pitch, which is thumb-hittable
              // for a picker where a near miss costs one more tap.
              className={cn(
                "h-3 w-3 rounded-[2px] transition-transform duration-150 hover:scale-[1.6] pointer-coarse:h-4 pointer-coarse:w-4",
                on && "scale-[1.5] ring-1 ring-[var(--color-line-strong)]",
              )}
              style={{
                background:
                  d.mins === 0
                    ? "var(--color-subtle)"
                    : `color-mix(in srgb, var(--color-accent) ${Math.round(intensity * 100)}%, transparent)`,
                boxShadow: strong
                  ? "0 0 6px color-mix(in srgb, var(--color-accent-lt) 55%, transparent)"
                  : undefined,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export function Progress({ sp }: { sp: StudyPlanner }) {
  const [modal, setModal] = useState<ReactNode>(null);
  const close = () => setModal(null);

  const rolling = getRollingWeekMinutes(sp.sessions, 7);
  const goalPct = sp.weeklyGoalMinutes > 0 ? (rolling / sp.weeklyGoalMinutes) * 100 : 0;
  const streak = calculateStreak(sp.sessions, sp.streakFreezeDate);
  // Folded from `sessions` rather than read from a stored total — the counter
  // is gone from the schema, and `lib/nexus/types.ts` says why.
  const xp = totalXp(sp.sessions);
  const lvl = getXPLevel(xp);
  const lvlPct = levelPct(xp, lvl);
  const frozenToday = sp.streakFreezeDate === todayStr();
  const recent = sortedSessions(sp.sessions);

  const editGoal = () =>
    setModal(
      <FormModal
        title="Weekly study goal"
        onClose={close}
        initial={{ minutes: sp.weeklyGoalMinutes }}
        fields={[{ key: "minutes", label: "Minutes per week", type: "number", min: 0, full: true }]}
        onSubmit={(v) => study.setWeeklyGoal(Math.max(0, Math.round(Number(v.minutes)) || 0))}
      />,
    );

  return (
    // The modal sits outside `Stagger`, not inside it: `Stagger` hands each
    // child an `--i` index, so a modal in the list would take a slot and shift
    // every card's entrance delay by one the moment a form opened.
    <>
      {modal}
      <Stagger className="flex flex-col gap-5 pt-5">
        <Reveal>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Card interactive className="flex items-center gap-4 p-5">
              <ProgressRing value={goalPct} size={72} className="shrink-0">
                <span className="nums text-[12px] text-fg">{Math.round(goalPct)}%</span>
              </ProgressRing>
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center justify-between gap-2">
                  <span className="label">Weekly goal</span>
                  <IconButton icon={<Pencil size={12} />} label="Edit weekly goal" onClick={editGoal} />
                </div>
                <div className="nums text-[16px] text-fg">{fmtDuration(rolling)}</div>
                <div className="text-[11px] text-fg-muted">
                  {sp.weeklyGoalMinutes > 0 ? `of ${fmtDuration(sp.weeklyGoalMinutes)}` : "no goal set"}
                </div>
              </div>
            </Card>

            <Card interactive className="flex flex-col justify-between p-5">
              <div className="flex items-start justify-between">
                <div>
                  <div className="label">Streak</div>
                  <CountUp
                    value={streak}
                    suffix="d"
                    className="nums mt-1 block text-[25px] leading-none text-accent-lt"
                  />
                </div>
                <motion.div
                  animate={streak > 0 ? { scale: [1, 1.14, 1], opacity: [0.85, 1, 0.85] } : {}}
                  transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
                >
                  <Flame
                    size={22}
                    aria-hidden
                    style={{
                      color: streak > 0 ? "var(--color-accent-lt)" : "var(--color-accent-dim)",
                      filter:
                        streak > 0
                          ? "drop-shadow(0 0 6px color-mix(in srgb, var(--color-accent-lt) 60%, transparent))"
                          : "none",
                    }}
                  />
                </motion.div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                icon={<Snowflake size={12} />}
                onClick={study.freezeStreak}
                disabled={frozenToday}
                className="mt-3 self-start"
              >
                {frozenToday ? "Frozen today" : "Freeze streak"}
              </Button>
            </Card>

            <Card interactive className="flex flex-col justify-between p-5">
              <div>
                <div className="label" style={{ color: lvl.color }}>
                  Level {lvl.level} · {lvl.title}
                </div>
                <CountUp
                  value={xp}
                  suffix=" XP"
                  className="nums mt-1 block text-[25px] leading-none"
                />
              </div>
              <div className="mt-3">
                <ProgressBar value={lvlPct} color={lvl.color} />
                <div className="mt-1 text-[10.5px] text-fg-muted">
                  {lvl.next !== null ? `${lvl.next - xp} XP to next level` : "Max level"}
                </div>
              </div>
            </Card>
          </div>
        </Reveal>

        <Reveal>
          <Card className="p-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="label">Last 13 weeks</div>
              <div className="flex items-center gap-1.5">
                <span className="label text-fg-muted">less</span>
                {LEGEND_STOPS.map((v) => (
                  <span
                    key={v}
                    aria-hidden
                    className="h-2.5 w-2.5 rounded-[2px]"
                    style={{
                      background: `color-mix(in srgb, var(--color-accent) ${v * 100}%, transparent)`,
                    }}
                  />
                ))}
                <span className="label text-fg-muted">more</span>
              </div>
            </div>
            <Heatmap sessions={sp.sessions} />
          </Card>
        </Reveal>

        <Reveal>
          <div>
            <div className="label mb-2">Recent sessions</div>
            {recent.length === 0 ? (
              <EmptyState
                icon={<CalendarDays size={22} strokeWidth={1.6} />}
                title="No sessions yet"
                hint="Run a focus block on the Focus tab to log your first session — 2 XP per minute."
              />
            ) : (
              <ScrollList maxH={360} className="flex flex-col gap-1">
                {recent.map((s) => (
                  <Card key={s.id} interactive className="flex flex-col gap-1 px-3.5 py-2.5 md:flex-row md:items-center md:gap-3">
                    {/* `md:contents` dissolves both wrappers from `md:` up, so
                        the desktop row is nexus's five flex children at nexus's
                        `gap-3`. Below `md:` they are two lines, which is the
                        only way a date, a topic, a duration, an XP figure and a
                        delete button all fit across 375px. */}
                    <div className="flex min-w-0 items-center gap-3 md:contents">
                      <span className="nums w-20 shrink-0 text-[11px] text-fg-muted">
                        {s.date.slice(0, 10)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-fg-dim">
                        {s.topic}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 md:contents">
                      <span className="nums text-[11.5px] text-fg-muted">{fmtDuration(s.duration)}</span>
                      <span className="nums text-[11.5px] text-accent-lt">+{s.xp} XP</span>
                      <IconButton
                        icon={<Trash2 size={13} />}
                        label={`Delete session: ${s.topic}`}
                        danger
                        onClick={() => study.delSession(s.id)}
                        className="ml-auto md:ml-0"
                      />
                    </div>
                  </Card>
                ))}
              </ScrollList>
            )}
          </div>
        </Reveal>
      </Stagger>
    </>
  );
}
