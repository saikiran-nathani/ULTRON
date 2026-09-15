import { CURRENCIES } from "./constants";

/** Short unique id — same scheme as legacy `uid`. */
export const uid = (): string =>
  Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

/** A Date → YYYY-MM-DD in the *local* calendar (not UTC — avoids the after-8pm
 *  "tomorrow" bug where an evening in a negative-offset zone rolls to next day). */
export const toDayStr = (d: Date): string => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

/** Today's local calendar date as YYYY-MM-DD. */
export const todayStr = (): string => toDayStr(new Date());

/** Current month as YYYY-MM (local). */
export const nowMonth = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

export const monthLabel = (ym: string): string => {
  if (!ym) return "";
  const [y, m] = ym.split("-");
  const idx = Number(m) - 1;
  return `${MONTH_NAMES[idx] ?? m} ${y}`;
};

const WEEKDAY_FULL = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];
const MONTH_FULL = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const ordinal = (n: number): string => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** YYYY-MM-DD → "Thursday, 25th June, 2026" (parsed as local date). */
export const longDate = (dateStr: string): string => {
  if (!dateStr) return "";
  // Bound and guarded rather than destructured straight into `new Date`: this
  // app's tsconfig has `noUncheckedIndexedAccess`, so every element of a split
  // is `number | undefined`. The guard is the same one `daysFromToday` below
  // already carries, and it turns a malformed date from "Invalid Date NaN"
  // rendered into a label into an empty string.
  const parts = dateStr.split("-").map(Number);
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];
  if (!y || !m || !d) return "";
  const dt = new Date(y, m - 1, d);
  return `${WEEKDAY_FULL[dt.getDay()]}, ${ordinal(d)} ${MONTH_FULL[m - 1]}, ${y}`;
};

/** mm:ss from seconds. */
export const fmtTime = (seconds = 0): string => {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

/** "2h 15m" / "45m" from minutes. */
export const fmtDuration = (mins = 0): string => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
};

export const currencySymbol = (code = "USD"): string =>
  CURRENCIES.find((c) => c.code === code)?.symbol ?? code + " ";

/** Money formatter — no FX conversion; renders in the given currency's symbol. */
export const money = (amount: number, code = "USD"): string => {
  const sym = currencySymbol(code);
  const n = Math.abs(Number(amount) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${amount < 0 ? "-" : ""}${sym}${n}`;
};

/** Whole calendar days from today (negative = past, 0 = today), compared in
 *  LOCAL time. Parsing "YYYY-MM-DD" with `new Date()` yields UTC midnight, which
 *  vs. local `now` mis-reports today as −1 in the evening in negative-UTC zones
 *  (e.g. US Eastern after ~8pm). Diffing local-midnight to local-midnight and
 *  rounding is timezone- and DST-safe. */
export const daysFromToday = (date: string): number => {
  if (!date) return 0;
  const [y, m, d] = date.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return 0;
  const target = new Date(y, m - 1, d).getTime();
  const now = new Date();
  const todayLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((target - todayLocal) / 86400000);
};

/** Relative due label, ported from legacy `relDue`. */
export const relDue = (date: string): string => {
  if (!date) return "";
  const diff = daysFromToday(date);
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  if (diff === 1) return "tomorrow";
  return `in ${diff} days`;
};
