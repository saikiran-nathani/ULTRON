import { BellOff, BellRing } from "lucide-react";
import { Card } from "@/ui/Card";
import { EmptyState } from "@/ui/EmptyState";
import { Stagger, Reveal } from "@/lib/motion";
import { levelColor } from "@/lib/status";
import { dayClock } from "@/lib/format";
import type { TwEvent } from "@/lib/api";

export function EventList({
  events,
  limit,
  emptyHint,
}: {
  events: TwEvent[];
  limit?: number;
  emptyHint?: string;
}) {
  const shown = limit ? events.slice(0, limit) : events;

  if (shown.length === 0) {
    return (
      <EmptyState
        title="Nothing has gone wrong"
        hint={
          emptyHint ??
          "Watchdog verdicts land here — grad-norm spikes, entropy collapse, activation drift, and the liveness check. An empty list is the good outcome."
        }
        icon={<BellOff size={22} strokeWidth={1.6} />}
      />
    );
  }

  return (
    <Stagger className="flex flex-col gap-2">
      {shown.map((e) => (
        <Reveal key={e.id}>
          <EventRow event={e} />
        </Reveal>
      ))}
    </Stagger>
  );
}

function EventRow({ event }: { event: TwEvent }) {
  const color = levelColor(event.level);
  return (
    <Card active accent={color} className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="text-[13px] font-semibold" style={{ color }}>
              {event.title}
            </span>
            <span className="label">{event.rule}</span>
            {event.step != null && (
              <span className="nums text-[10.5px] text-fg-muted">step {event.step}</span>
            )}
          </div>
          <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">{event.body}</p>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <span className="nums text-[10.5px] text-fg-muted">{dayClock(event.ts)}</span>
          <span
            title={event.notified ? "pushed to your phone" : "recorded only — not pushed"}
            className="text-fg-muted"
          >
            {event.notified ? (
              <BellRing size={12} className="text-accent-dim" />
            ) : (
              <BellOff size={12} />
            )}
          </span>
        </div>
      </div>
    </Card>
  );
}
