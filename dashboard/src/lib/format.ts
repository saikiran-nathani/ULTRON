/** Formatting for instrument-grade numerals. */

/** Human duration: 42s · 7m 12s · 3h 04m · 2d 6h */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  if (s < 86400)
    return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

/** Compact duration for tight spaces: 42s · 7m · 3h · 2d */
export function shortDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Metric values span learning rates (3e-4) and losses (4.21) and grad norms
 * (128.4). One formatter, chosen by magnitude, so a column of numbers stays
 * the same visual width.
 */
export function metric(value: number | null | undefined, key = ""): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "step_time") return seconds(value);
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 1e-3 || abs >= 1e6) return value.toExponential(2).replace("e", "e");
  if (abs < 1) return value.toFixed(4);
  if (abs < 100) return value.toFixed(3);
  if (abs < 10000) return value.toFixed(1);
  return value.toFixed(0);
}

/**
 * A duration in seconds, readable across six orders of magnitude. Formatting a
 * sub-millisecond step as `(v*1000).toFixed(0)ms` renders "0ms", which is
 * exactly what you see on the fast synthetic runs used to test alerting.
 */
export function seconds(value: number): string {
  const ms = value * 1000;
  if (ms >= 1000) return `${value.toFixed(2)}s`;
  if (ms >= 10) return `${ms.toFixed(0)}ms`;
  if (ms >= 0.1) return `${ms.toFixed(2)}ms`;
  return `${(ms * 1000).toFixed(0)}µs`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)}${units[i]}`;
}

export function clock(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export function dayClock(ts: number | null | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false })
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
}

/** `resid_rms/layer_3` → `layer 3` — the group prefix is already the heading. */
export function shortKey(key: string): string {
  const tail = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  return tail.replace(/_/g, " ");
}

export function titleKey(key: string): string {
  return key.replace(/_/g, " ");
}
