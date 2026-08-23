/**
 * Machine health, kept visually separate from training scalars.
 *
 * The source guide's reason: when step time degrades you need to know whether
 * it is the model or the machine. So the throttle state is a banner, not a
 * footnote — on a laptop chassis it is the usual explanation for a run that
 * "got slower" between two identical configs.
 */
import { Thermometer, Zap, Gauge, MemoryStick, TriangleAlert } from "lucide-react";
import { Card } from "@/ui/Card";
import { ProgressBar } from "@/ui/Ring";
import { Chip } from "@/ui/Chip";
import { tempColor } from "@/lib/status";
import { cn } from "@/lib/cn";
import type { Gpu } from "@/lib/api";

const THROTTLE_LABEL: Record<string, string> = {
  sw_thermal: "thermal (software)",
  hw_thermal: "thermal (hardware)",
  hw_slowdown: "hardware slowdown",
  sw_power_cap: "power cap",
  hw_power_brake: "power brake",
};

export function GpuStrip({ gpus, compact }: { gpus: Gpu[]; compact?: boolean }) {
  if (gpus.length === 0) {
    return (
      <Card className="px-5 py-4">
        <div className="text-[12px] text-fg-muted">
          No GPU telemetry. <span className="nums">nvidia-smi</span> isn&apos;t reachable — on WSL2
          add <span className="nums">/usr/lib/wsl/lib</span> to PATH.
        </div>
      </Card>
    );
  }
  return (
    <div className={cn("grid gap-3", gpus.length > 1 ? "sm:grid-cols-2" : "")}>
      {gpus.map((g) => (
        <GpuCard key={g.gpu_index} gpu={g} compact={compact} />
      ))}
    </div>
  );
}

function GpuCard({ gpu, compact }: { gpu: Gpu; compact?: boolean }) {
  const reasons = gpu.throttle ? gpu.throttle.split(",").filter(Boolean) : [];
  const memPct =
    gpu.mem_used != null && gpu.mem_total ? (gpu.mem_used / gpu.mem_total) * 100 : 0;

  return (
    <Card className="overflow-hidden px-5 py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="label">gpu {gpu.gpu_index}</div>
          <div className="mt-1 truncate text-[13px] font-medium text-fg-dim">{gpu.name}</div>
        </div>
        {reasons.length > 0 ? (
          <Chip color="var(--color-warn)" dot>
            throttled
          </Chip>
        ) : (
          <Chip color="var(--color-good)" dot>
            nominal
          </Chip>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3.5 sm:grid-cols-4">
        <Metric icon={<Gauge size={12} />} label="util" value={gpu.util} unit="%" />
        <Metric
          icon={<Thermometer size={12} />}
          label="temp"
          value={gpu.temp}
          unit="°"
          color={tempColor(gpu.temp)}
        />
        <Metric icon={<Zap size={12} />} label="power" value={gpu.power} unit="W" />
        <Metric icon={<Gauge size={12} />} label="sm clock" value={gpu.clock_sm} unit="MHz" />
      </div>

      {!compact && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="label flex items-center gap-1.5">
              <MemoryStick size={11} /> vram
            </span>
            <span className="nums text-[11px] text-fg-dim">
              {gpu.mem_used != null ? `${(gpu.mem_used / 1024).toFixed(1)}` : "—"} /{" "}
              {gpu.mem_total != null ? `${(gpu.mem_total / 1024).toFixed(1)} GiB` : "—"}
            </span>
          </div>
          <ProgressBar
            value={memPct}
            color={memPct > 92 ? "var(--color-warn)" : "var(--color-accent)"}
          />
        </div>
      )}

      {reasons.length > 0 && (
        <div className="mt-4 flex items-start gap-2 rounded-sm border-[0.5px] border-[color-mix(in_srgb,var(--color-warn)_30%,transparent)] bg-[color-mix(in_srgb,var(--color-warn)_8%,transparent)] px-3 py-2.5">
          <TriangleAlert size={13} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
          <div className="text-[11.5px] leading-relaxed text-fg-dim">
            <span className="text-[var(--color-warn)]">
              {reasons.map((r) => THROTTLE_LABEL[r] ?? r).join(", ")}
            </span>
            {" — "}step times are being distorted by the machine, not your code.
          </div>
        </div>
      )}
    </Card>
  );
}

function Metric({
  icon,
  label,
  value,
  unit,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  unit: string;
  color?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="label flex items-center gap-1.5">
        <span className="text-fg-muted/70">{icon}</span>
        {label}
      </span>
      <span
        className="nums text-[17px] font-medium leading-none"
        style={{ color: color ?? "var(--color-fg)" }}
      >
        {value != null ? value.toFixed(0) : "—"}
        <span className="ml-0.5 text-[10px] text-fg-muted">{value != null ? unit : ""}</span>
      </span>
    </div>
  );
}
