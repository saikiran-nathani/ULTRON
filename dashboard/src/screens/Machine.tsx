/**
 * Hardware signal, on its own screen.
 *
 * "Step time drifts upward across runs → thermal throttle, not your code" is
 * the failure mode the source guide calls out, and it is only diagnosable if
 * temperature and clock are on the same time axis as the run. So: temp, SM
 * clock, power and utilisation over the last window, plus the box itself —
 * tmux sessions and tailnet address, so you know what to reattach to.
 */
import { useState } from "react";
import { Boxes, Cpu, Network, Terminal } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { GpuStrip } from "@/components/GpuStrip";
import { Stagger, Reveal } from "@/lib/motion";
import { useGpuHistory, useSystem } from "@/lib/hooks";
import { bytes, clock, dayClock } from "@/lib/format";
import type { Gpu, State } from "@/lib/api";
import type { Point } from "@/components/ui";
import { Card, CardHead, Chip, EmptyState, LineChart, Tabs } from "@/components/ui";

const WINDOWS = [
  { id: "900", label: "15m" },
  { id: "3600", label: "1h" },
  { id: "21600", label: "6h" },
  { id: "86400", label: "24h" },
];

const TRACES = [
  { key: "temp" as const, label: "temperature", unit: "°C", color: "var(--color-bad)" },
  { key: "clock_sm" as const, label: "sm clock", unit: "MHz", color: "var(--color-accent)" },
  { key: "power" as const, label: "power draw", unit: "W", color: "var(--color-warn)" },
  { key: "util" as const, label: "utilisation", unit: "%", color: "var(--color-info)" },
];

export function Machine({ state, actions }: { state: State; actions?: React.ReactNode }) {
  const [win, setWin] = useState("3600");
  const { latest, history } = useGpuHistory(Number(win));
  const system = useSystem();

  const indices = [...new Set(history.map((h) => h.gpu_index))].sort();

  return (
    <ScreenShell eyebrow={system?.hostname ?? "machine"} title="Machine" actions={actions}>
      <Stagger className="flex flex-col gap-4">
        <Reveal>
          <GpuStrip gpus={latest.length ? latest : state.gpu} />
        </Reveal>

        <Reveal>
          <Tabs
            tabs={WINDOWS}
            active={win}
            onChange={setWin}
            layoutId="machine-window"
            className="mt-1"
          />
        </Reveal>

        {history.length < 2 ? (
          <Reveal>
            <EmptyState
              title="Not enough history yet"
              icon={<Cpu size={22} strokeWidth={1.6} />}
              hint="The sampler polls nvidia-smi every 5 seconds while the server runs. Give it a minute, or pick a longer window."
            />
          </Reveal>
        ) : (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            {TRACES.map((trace) => (
              <Reveal key={trace.key}>
                <Card className="px-5 py-4">
                  <CardHead
                    label={trace.label}
                    right={<span className="label">{trace.unit}</span>}
                  />
                  <LineChart
                    data={seriesFor(history, indices[0] ?? 0, trace.key)}
                    color={trace.color}
                    height={170}
                    xFormat={clock}
                    xPrefix=""
                    className="mt-2"
                  />
                </Card>
              </Reveal>
            ))}
          </div>
        )}

        {/* the box */}
        <Reveal>
          <Card className="px-5 py-4">
            <CardHead label="the box" />
            <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div className="label mb-2 flex items-center gap-1.5">
                  <Terminal size={11} /> tmux sessions
                </div>
                {system?.tmux.length ? (
                  <div className="flex flex-col gap-1.5">
                    {system.tmux.map((s) => (
                      <div key={s.name} className="flex items-center gap-2">
                        <Chip color={s.attached ? "var(--color-good)" : "var(--color-fg-muted)"} dot>
                          {s.attached ? "attached" : "detached"}
                        </Chip>
                        <span className="nums text-[12px] text-fg-dim">{s.name}</span>
                        <span className="text-[10.5px] text-fg-muted">
                          {s.windows} window{s.windows === 1 ? "" : "s"} · since{" "}
                          {dayClock(s.created)}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-[11.5px] leading-relaxed text-fg-muted">
                    No tmux sessions. A run started outside tmux dies with the SSH pipe — that is
                    layer 1.
                  </p>
                )}
              </div>

              <div>
                <div className="label mb-2 flex items-center gap-1.5">
                  <Network size={11} /> reach
                </div>
                <div className="flex flex-col gap-1.5 text-[12px] text-fg-dim">
                  {system?.tailscale.length ? (
                    system.tailscale.map((ip) => (
                      <span key={ip} className="nums">
                        {ip}
                      </span>
                    ))
                  ) : (
                    <span className="text-[11.5px] text-fg-muted">Tailscale address unknown.</span>
                  )}
                  <span className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-muted">
                    <Boxes size={11} />
                    {system?.wsl ? "WSL2" : "native"} · store {bytes(system?.db_size)}
                  </span>
                </div>
              </div>
            </div>
          </Card>
        </Reveal>
      </Stagger>
    </ScreenShell>
  );
}

function seriesFor(
  history: Gpu[],
  index: number,
  key: "temp" | "clock_sm" | "power" | "util",
): Point[] {
  return history
    .filter((h): h is Gpu & Record<typeof key, number> => h.gpu_index === index && h[key] != null)
    .map((h) => [h.ts, h[key]] as Point);
}
