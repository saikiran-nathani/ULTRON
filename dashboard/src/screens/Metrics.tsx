/**
 * Every scalar, grouped by its slash prefix.
 *
 * This is the payoff for the source guide's insistence on structured keys:
 * `resid_rms/layer_0..N` arrives as a group with no configuration, so the
 * per-layer panels lay themselves out. Tap any tile to expand it to a full
 * scrubable chart.
 */
import { useMemo, useState } from "react";
import { Activity } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Card } from "@/ui/Card";
import { Tabs } from "@/ui/Tabs";
import { LineChart, Sparkline } from "@/ui/Chart";
import { EmptyState } from "@/ui/EmptyState";
import { Stagger, Reveal } from "@/lib/motion";
import { useGroups, useSeries } from "@/lib/hooks";
import { metric as fmtMetric, shortKey, titleKey } from "@/lib/format";
import type { State } from "@/lib/api";

const GROUP_COLOR: Record<string, string> = {
  scalars: "var(--color-accent)",
  resid_rms: "var(--color-info)",
  attn_logit_max: "var(--color-warn)",
};

const GROUP_NOTE: Record<string, string> = {
  resid_rms: "Per-layer activation scale. Sustained drift here precedes the loss blowing up.",
  attn_logit_max: "Attention logit peaks. Sharp spikes mean an unstable head.",
};

export function Metrics({ state, actions }: { state: State; actions?: React.ReactNode }) {
  const run = state.run;
  const live = run?.status === "running";
  const groups = useGroups(run?.id);
  const names = useMemo(
    () => Object.keys(groups).sort((a, b) => (a === "scalars" ? -1 : b === "scalars" ? 1 : a.localeCompare(b))),
    [groups],
  );
  const [tab, setTab] = useState<string>("");
  const active = tab && names.includes(tab) ? tab : (names[0] ?? "");
  const keys = groups[active] ?? [];
  const [expanded, setExpanded] = useState<string | null>(null);

  const { series } = useSeries(run?.id, keys, { live, points: 220 });

  if (!run || names.length === 0) {
    return (
      <ScreenShell eyebrow="metrics" title="Metrics" actions={actions}>
        <EmptyState
          className="mt-6"
          title="No scalars yet"
          icon={<Activity size={22} strokeWidth={1.6} />}
          hint="Log with structured keys — resid_rms/layer_0, attn_logit_max/layer_0 — and each prefix becomes its own group here automatically."
        />
      </ScreenShell>
    );
  }

  const color = GROUP_COLOR[active] ?? "var(--color-accent)";

  return (
    <ScreenShell eyebrow={run.name} title="Metrics" actions={actions}>
      <Tabs
        tabs={names.map((n) => ({ id: n, label: titleKey(n), count: groups[n]?.length }))}
        active={active}
        onChange={(id) => {
          setTab(id);
          setExpanded(null);
        }}
        className="mb-4"
      />

      {GROUP_NOTE[active] && (
        <p className="mb-4 max-w-[62ch] text-[12px] leading-relaxed text-fg-muted">
          {GROUP_NOTE[active]}
        </p>
      )}

      <Stagger className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {keys.map((key) => {
          const data = series[key] ?? [];
          const latest = data.length ? data[data.length - 1]![1] : undefined;
          const isOpen = expanded === key;
          return (
            <Reveal key={key} className={isOpen ? "sm:col-span-2 xl:col-span-3" : undefined}>
              <Card
                interactive
                className="h-full px-4 py-3.5"
                onClick={() => setExpanded(isOpen ? null : key)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setExpanded(isOpen ? null : key);
                  }
                }}
              >
                <div className="flex items-baseline justify-between gap-3">
                  <span className="label truncate">{shortKey(key)}</span>
                  <span className="nums text-[15px] font-medium" style={{ color }}>
                    {fmtMetric(latest, key)}
                  </span>
                </div>
                {isOpen ? (
                  <LineChart
                    data={data}
                    color={color}
                    height={220}
                    metricKey={key}
                    log={key === "loss"}
                    className="mt-3"
                  />
                ) : (
                  <Sparkline
                    data={data}
                    color={color}
                    height={40}
                    log={key === "loss"}
                    className="mt-3"
                  />
                )}
              </Card>
            </Reveal>
          );
        })}
      </Stagger>
    </ScreenShell>
  );
}
