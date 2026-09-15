/**
 * The merged app's navigation, and the one boundary that keeps it coherent.
 *
 * Two apps became one, which means twelve candidate top-level screens: nexus's
 * eight domains plus trainwatch's Train, Metrics, Machine, Watch, Alerts,
 * Clip, Drop, Notes. No phone bottom bar survives twelve, and a nav that needs
 * a scroll is a nav where the last item is never pressed.
 *
 * The plan already answered it. `brain` is ULTRON's slot — "status panel +
 * action rail" — so every trainwatch surface lives *inside* `brain` rather
 * than beside the tracks. And the home is a launcher, not a report:
 *
 *   > Home answers "what do I have open right now." Live, ephemeral,
 *   > glanceable. The vault answers "how is my work going." Accumulated,
 *   > narrative, across weeks.
 *
 * The test, applied to every widget and every screen here: **if its content
 * would still be true next week, it belongs in the vault.** That is what stops
 * the home drifting back into being the thing the vault is for — which is the
 * overlap this merge exists to remove.
 *
 * Journal is deliberately absent. Its narrative entries drain to the vault
 * through Capture; the parts that are daily rather than accumulated — habit
 * ticks, the reading list — surface as a home widget and inside Research.
 */
import {
  Activity,
  BookMarked,
  BrainCircuit,
  FlaskConical,
  FolderKanban,
  GraduationCap,
  Inbox,
  LayoutDashboard,
  Target,
} from "lucide-react";

export type ScreenId =
  | "home"
  | "capture"
  | "courses"
  | "projects"
  | "research"
  | "learn"
  | "career"
  | "brain";

export interface NavItem {
  id: ScreenId;
  label: string;
  icon: typeof Activity;
  /** Shown in the phone's bottom bar. Everything else is reached from Home.
   *
   * Four, because five is where a 375px bar starts eliding labels and an
   * unlabelled icon is a guess. These four are the ones with a reason to be
   * one tap away: the launcher, the capture box, the work, and ULTRON. */
  bar?: boolean;
}

export const NAV: NavItem[] = [
  { id: "home", label: "Home", icon: LayoutDashboard, bar: true },
  { id: "capture", label: "Capture", icon: Inbox, bar: true },
  { id: "courses", label: "Courses", icon: BookMarked },
  { id: "projects", label: "Projects", icon: FolderKanban, bar: true },
  { id: "research", label: "Research", icon: FlaskConical },
  { id: "learn", label: "Self-learning", icon: GraduationCap },
  { id: "career", label: "Career", icon: Target },
  { id: "brain", label: "brain", icon: BrainCircuit, bar: true },
];

/** The four tracks, in the order they feed each other.
 *
 * Named separately from NAV because "the four tracks" is a real grouping the
 * home renders as a set — and because `career` is where they terminate rather
 * than a fifth track. A course that never surfaces on the career side is a
 * course whose value was never banked.
 */
export const TRACKS: ScreenId[] = ["courses", "projects", "research", "learn"];

export const BAR: NavItem[] = NAV.filter((n) => n.bar);
