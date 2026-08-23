/**
 * The watchdog's log.
 *
 * Also the place to notice the failure mode the guide lists last: "alerts never
 * arrive — iOS killed the ntfy app's background refresh". Every row shows
 * whether it was actually *pushed* or only recorded, so a silently-broken
 * notify layer is visible here rather than inferred from your phone staying
 * quiet.
 */
import { useMemo, useState } from "react";
import { BellOff } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { EventList } from "@/components/EventList";
import { Tabs } from "@/ui/Tabs";
import { Card } from "@/ui/Card";
import { Reveal, Stagger } from "@/lib/motion";
import type { State } from "@/lib/api";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "critical", label: "Critical" },
  { id: "warn", label: "Warnings" },
  { id: "unpushed", label: "Not pushed" },
];

export function Alerts({ state, actions }: { state: State; actions?: React.ReactNode }) {
  const [filter, setFilter] = useState("all");

  const events = useMemo(() => {
    switch (filter) {
      case "critical":
        return state.events.filter((e) => e.level === "critical");
      case "warn":
        return state.events.filter((e) => e.level === "warn");
      case "unpushed":
        return state.events.filter((e) => !e.notified);
      default:
        return state.events;
    }
  }, [state.events, filter]);

  const unpushed = state.events.filter((e) => !e.notified).length;

  const counts: Record<string, number> = {
    all: state.events.length,
    critical: state.events.filter((e) => e.level === "critical").length,
    warn: state.events.filter((e) => e.level === "warn").length,
    unpushed,
  };

  return (
    <ScreenShell eyebrow="watchdog" title="Alerts" actions={actions}>
      <Stagger className="flex flex-col gap-4">
        <Reveal>
          <Tabs
            tabs={FILTERS.map((f) => ({ ...f, count: counts[f.id] }))}
            active={filter}
            onChange={setFilter}
            layoutId="alerts-filter"
          />
        </Reveal>

        {/* Layer 3 not configured is a real fault and gets a real warning.
            Alerts merely deduped by the rate limiter are the system working,
            and get a quiet footnote — conflating the two trains you to ignore
            the banner that matters. */}
        {!state.notify.enabled ? (
          <Reveal>
            <Card active accent="var(--color-bad)" className="flex items-start gap-3 px-4 py-3">
              <BellOff size={14} className="mt-0.5 shrink-0 text-[var(--color-bad)]" />
              <div className="text-[12px] leading-relaxed text-fg-dim">
                <span className="text-[var(--color-bad)]">Layer 3 is not armed.</span>{" "}
                <span className="nums">TRAINWATCH_NTFY_TOPIC</span> is unset, so nothing here has
                ever reached your phone — you are still watching a dashboard. Set it in{" "}
                <span className="nums">.env</span>, then run{" "}
                <span className="nums">trainwatch doctor --send-test</span>.
              </div>
            </Card>
          </Reveal>
        ) : (
          unpushed > 0 &&
          filter !== "unpushed" && (
            <Reveal>
              <p className="px-1 text-[11.5px] leading-relaxed text-fg-muted">
                <span className="nums">{unpushed}</span> of these weren&apos;t pushed — the rate
                limiter collapsing repeats of the same rule, which is what stops a diverging run
                buzzing your phone a thousand times. Filter to{" "}
                <span className="text-fg-dim">Not pushed</span> to inspect them.
              </p>
            </Reveal>
          )
        )}

        <Reveal>
          <EventList
            events={events}
            emptyHint={
              filter === "all"
                ? undefined
                : "Nothing matches this filter — try All."
            }
          />
        </Reveal>
      </Stagger>
    </ScreenShell>
  );
}
