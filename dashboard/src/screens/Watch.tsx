/**
 * The glance screen. Everything here answers "do I need to get up?"
 * Ordered by that question: verdict → the four numbers → the loss curve →
 * the machine → what the watchdog has said.
 */
import { ArrowRight, Radar } from "lucide-react";
import { Pulse } from "@/components/Pulse";
import { GpuStrip } from "@/components/GpuStrip";
import { EventList } from "@/components/EventList";
import { ScreenShell } from "@/components/ScreenShell";
import { Stagger, Reveal } from "@/lib/motion";
import { metric as fmtMetric, titleKey } from "@/lib/format";
import { useSeries } from "@/lib/hooks";
import type { State } from "@/lib/api";
import { Button, Card, CardHead, EmptyState, LineChart, TimeSeriesSparkline } from "@/components/ui";

const HEADLINE = ["loss", "grad_norm", "lr", "step_time"] as const;

const HEADLINE_COLOR: Record<string, string> = {
  loss: "var(--color-accent)",
  grad_norm: "var(--color-info)",
  lr: "var(--color-fg-dim)",
  step_time: "var(--color-warn)",
};

export function Watch({
  state,
  onNavigate,
  actions,
}: {
  state: State;
  /** Jump to the alerts pane. Owned by Train, which holds the tab state. */
  onNavigate: () => void;
  actions?: React.ReactNode;
}) {
  const run = state.run;
  const live = run?.status === "running";
  const present = HEADLINE.filter((k) => state.metric_keys.includes(k));
  const { series } = useSeries(run?.id, present, { live, points: 200 });

  if (!run) {
    return (
      <ScreenShell eyebrow="watch" title="trainwatch" actions={actions}>
        <EmptyState
          className="mt-10"
          title="No run has reported yet"
          icon={<Radar size={24} strokeWidth={1.5} />}
          hint="Wrap your training loop in TrainMonitor and this fills in. Until then the box is reachable but silent — which is exactly what layer 3 exists to tell you about."
        />
      </ScreenShell>
    );
  }

  return (
    <ScreenShell actions={actions}>
      <Stagger className="flex flex-col gap-4 pt-8 lg:pt-12">
        <Reveal>
          <Pulse status={state.status} run={run} heartbeat={state.heartbeat} />
        </Reveal>

        {/* the four numbers */}
        <Reveal>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {present.map((key) => {
              const color = HEADLINE_COLOR[key] ?? "var(--color-accent)";
              const value = state.headline[key];
              return (
                <Card key={key} className="overflow-hidden px-4 py-3.5">
                  <div className="label truncate">{titleKey(key)}</div>
                  <div
                    className="nums mt-1.5 text-[21px] font-medium leading-none"
                    style={{ color }}
                  >
                    {fmtMetric(value, key)}
                  </div>
                  <TimeSeriesSparkline
                    data={series[key] ?? []}
                    color={color}
                    height={28}
                    log={key === "loss"}
                    className="mt-2.5"
                  />
                </Card>
              );
            })}
            {present.length === 0 && (
              <Card className="col-span-full px-5 py-4 text-[12px] text-fg-muted">
                No scalars logged yet for this run.
              </Card>
            )}
          </div>
        </Reveal>

        {/* the curve */}
        {series["loss"] && series["loss"].length > 1 && (
          <Reveal>
            <Card className="px-5 py-4">
              <CardHead label="loss" />
              <LineChart
                data={series["loss"]}
                color="var(--color-accent)"
                height={200}
                log
                metricKey="loss"
                className="mt-2"
              />
              <p className="mt-1 text-[10.5px] text-fg-muted">
                Drag across the chart to read a value at a step.
              </p>
            </Card>
          </Reveal>
        )}

        {/* the machine */}
        <Reveal>
          <div className="flex flex-col gap-3">
            <div className="label px-0.5">machine</div>
            <GpuStrip gpus={state.gpu} compact />
          </div>
        </Reveal>

        {/* what the watchdog said */}
        <Reveal>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between px-0.5">
              <span className="label">recent alerts</span>
              {state.events.length > 3 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={onNavigate}
                  icon={<ArrowRight size={12} />}
                  className="flex-row-reverse"
                >
                  all {state.events.length}
                </Button>
              )}
            </div>
            <EventList events={state.events} limit={3} />
          </div>
        </Reveal>
      </Stagger>
    </ScreenShell>
  );
}
