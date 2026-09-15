/** Shared constants ported from the legacy app. Single source of truth. */
import {
  Activity, Hammer, Brain, Compass, Users, Mountain, Archive,
  type LucideIcon,
} from "lucide-react";

export const GRADE_POINTS = {
  "A+": 4.0, A: 4.0, "A-": 3.7,
  "B+": 3.3, B: 3.0, "B-": 2.7,
  "C+": 2.3, C: 2.0, "C-": 1.7,
  "D+": 1.3, D: 1.0, "D-": 0.7,
  F: 0.0,
} as const;
export type Grade = keyof typeof GRADE_POINTS;
export const GRADES = Object.keys(GRADE_POINTS) as Grade[];

// `as const` + derived union = one source of truth; the union types below keep
// stored/rendered values in sync with these lists at compile time.
export const STATUSES = ["Not Started", "In Progress", "On Hold", "Completed"] as const;
export type AssignmentStatus = (typeof STATUSES)[number];

export const PRIORITIES = ["Low", "Medium", "High", "Critical"] as const;
export type Priority = (typeof PRIORITIES)[number];

export const PROJECT_STATUSES = ["Planning", "Active", "Paused", "Completed", "Archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/**
 * Spacing between adjacent task sort keys; leaves room to insert a task
 * between two others without renumbering either. Re-exported by
 * `@/store/projects`, which is where it lived and where screens import it.
 *
 * It moved down here to break a cycle the port would otherwise inherit:
 * `migrate.ts` needs this constant, and taking it from the store closes
 * `db → migrate → store/projects → store/data → db` into a real import loop.
 * That loop survived in nexus only because every edge in it was read at call
 * time rather than at module init — a property nobody was maintaining
 * deliberately, and one that breaks the first time a slice computes anything
 * at the top level.
 */
export const SORT_STEP = 1024;


export const JOB_STATUSES = [
  "Applied", "Phone Screen", "Technical", "Onsite", "Offer", "Rejected", "Withdrawn",
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export const CERT_STATUSES = ["Studying", "Scheduled", "Passed", "Expired"] as const;
export type CertStatus = (typeof CERT_STATUSES)[number];

export const READING_TYPES = ["Book", "Course", "Article", "Video", "Documentation"] as const;
export type ReadingType = (typeof READING_TYPES)[number];

export const READING_STATUSES = ["Queue", "Reading", "Done", "Paused"] as const;
export type ReadingStatus = (typeof READING_STATUSES)[number];

export interface Mood {
  val: number;
  emoji: string;
  label: string;
  color: string;
}
export const MOODS: Mood[] = [
  { val: 1, emoji: "😔", label: "Rough", color: "var(--color-bad)" },
  { val: 2, emoji: "😐", label: "Meh", color: "var(--color-amber)" },
  { val: 3, emoji: "🙂", label: "Okay", color: "var(--color-copper-lt)" },
  { val: 4, emoji: "😊", label: "Good", color: "var(--color-info)" },
  { val: 5, emoji: "🚀", label: "Great", color: "var(--color-good)" },
];

export interface Currency {
  code: string;
  symbol: string;
  name: string;
}
export const CURRENCIES: Currency[] = [
  { code: "USD", symbol: "$", name: "US Dollar" },
  { code: "INR", symbol: "₹", name: "Indian Rupee" },
  { code: "EUR", symbol: "€", name: "Euro" },
  { code: "GBP", symbol: "£", name: "British Pound" },
  { code: "CAD", symbol: "C$", name: "Canadian Dollar" },
  { code: "AUD", symbol: "A$", name: "Australian Dollar" },
  { code: "JPY", symbol: "¥", name: "Japanese Yen" },
  { code: "CNY", symbol: "¥", name: "Chinese Yuan" },
  { code: "AED", symbol: "د.إ", name: "UAE Dirham" },
  { code: "SGD", symbol: "S$", name: "Singapore Dollar" },
  { code: "CHF", symbol: "Fr", name: "Swiss Franc" },
  { code: "MXN", symbol: "Mex$", name: "Mexican Peso" },
];

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* ── Categorized journal (Reflections + The Room) ── */

export interface JournalCategory {
  id: string;
  label: string;
  blurb: string;
  icon: LucideIcon;
  prompts: string[]; // faint example prompts that prefill the fragment
}

export const JOURNAL_CATEGORIES: JournalCategory[] = [
  { id: "recreation", label: "Recreation & Rituals", icon: Activity, blurb: "Activities and rituals worth carrying for life.", prompts: ["A focus-zone I never want to lose", "A habit worth keeping for life"] },
  { id: "career", label: "Career & Craft", icon: Hammer, blurb: "Work, skills, what I'm building, the path.", prompts: ["The next thing to build", "A method to go deep on"] },
  { id: "mind", label: "Mind & Mentality", icon: Brain, blurb: "How I think and operate — models, toughness, openness.", prompts: ["A discomfort I walked toward today", "A model that clicked"] },
  { id: "character", label: "Character & Values", icon: Compass, blurb: "Who I am, what I stand for — the non-negotiables.", prompts: ["A principle to keep for life", "Who I'm becoming"] },
  { id: "people", label: "People & Relationships", icon: Users, blurb: "Family, partner, friends — how I show up.", prompts: ["The partner I want to build a life with", "How I want to show up for family"] },
  { id: "bucket", label: "Bucket List & Experiences", icon: Mountain, blurb: "Things to do, see, and feel.", prompts: ["A place or experience I want", "Something to try once"] },
  { id: "room", label: "The Room", icon: Archive, blurb: "Worth keeping forever — the gallery of who I am.", prompts: [] },
];

export interface FragmentTypeMeta {
  id: "seed" | "thread" | "principle" | "action";
  label: string;
  hint: string;
  color: string; // a design token (never a raw hex in components)
}

export const FRAGMENT_TYPES: FragmentTypeMeta[] = [
  { id: "seed", label: "Seed", hint: "raw idea", color: "var(--color-good)" },
  { id: "thread", label: "Thread", hint: "open question I'm living with", color: "var(--color-copper)" },
  { id: "principle", label: "Principle", hint: "a keeper", color: "var(--color-amber)" },
  { id: "action", label: "Action", hint: "do this", color: "var(--color-bad)" },
];
