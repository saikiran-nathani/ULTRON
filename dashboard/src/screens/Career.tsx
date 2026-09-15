/**
 * Career — and the roadmap, which is now a tab here rather than a screen.
 *
 * The plan is emphatic about why this screen is not peripheral, so it is
 * quoted rather than summarised:
 *
 * > `career` stays, and is not peripheral — it is the point. The four tracks
 * > exist to produce a career outcome; jobs, certifications and the roadmap are
 * > where learning becomes evidence of learning. That also makes `career` the
 * > natural place the four tracks *terminate* — a course that never surfaces on
 * > the career side is a course whose value was never banked.
 *
 * Which is why the first tab is `Evidence` and not `Pipeline`. A port of
 * nexus's `Career.tsx` and `Roadmap.tsx` laid side by side gives you the
 * career side and the roadmap and no way to see the sentence above being
 * violated. `Evidence` is that view: every finished thing from the four
 * tracks, and whether anything on the career side names it. Its tab badge
 * carries the unbanked count, so the number is visible from the other four
 * tabs too — a warning only reachable by navigating to it is a warning nobody
 * reads.
 *
 * Folding the roadmap in also pays for itself in the nav: twelve candidate
 * screens do not fit a phone's bottom bar, and `roadmap` was the clearest
 * merge candidate because it was already about the career side.
 *
 * ── The load gate, which is not decoration ──────────────────────────────
 * Every ported store slice reads `useData((s) => s.data!.x)`. That `!` is a
 * lie until something calls `useData.getState().load()` — and at the time of
 * writing **nothing does**: `startNexusSync()` exists in `lib/nexus/bridge.ts`
 * and has no caller, so `data` is `null` and any screen that trusts the `!`
 * throws on mount. So this screen selects `data`, `loaded` and `error`
 * separately (three stable selectors — one selector returning a fresh object
 * would re-render forever under `useSyncExternalStore`) and renders three
 * visibly different things: loading, no-data, and the app. The children then
 * take `NexusData` as a prop and never touch the `!` at all.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, DatabaseZap } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Callout, Card, Tabs, type TabDef } from "@/components/ui";
import { useData } from "@/store/data";
import { Certifications } from "./career/Certifications";
import { Evidence } from "./career/Evidence";
import { Pipeline } from "./career/Pipeline";
import { Plan } from "./career/Plan";
import { Stack } from "./career/Stack";
import { ledger, tally } from "./career/banking";

type Tab = "evidence" | "pipeline" | "certs" | "plan" | "stack";

export function CareerScreen() {
  const [tab, setTab] = useState<Tab>("evidence");
  // Three separate selectors, deliberately. See the module note.
  const data = useData((s) => s.data);
  const loaded = useData((s) => s.loaded);
  const error = useData((s) => s.error);

  // Folded once here rather than inside the tab, so the badge and the tab
  // cannot disagree about how much is unbanked.
  const rows = useMemo(
    () =>
      data === null
        ? []
        : ledger({
            courses: data.academics.courses,
            projects: data.projects,
            experiments: data.research.experiments,
            plans: data.academics.studyPlanner.plans,
            jobs: data.career.jobs,
            certifications: data.career.certifications,
            phases: data.roadmap.phases,
            layers: data.roadmap.layers,
            throughLine: data.roadmap.throughLine,
          }),
    [data],
  );
  const counts = useMemo(() => tally(rows), [rows]);

  const TABS: TabDef[] = [
    // The only count that is a warning rather than a size, which is why it is
    // the only one here: a badge on "Pipeline" reading 7 tells you nothing you
    // could act on.
    { id: "evidence", label: "Evidence", count: counts.unbanked },
    { id: "pipeline", label: "Pipeline" },
    { id: "certs", label: "Certifications" },
    { id: "plan", label: "Plan" },
    { id: "stack", label: "Stack" },
  ];

  if (!loaded) {
    return (
      <ScreenShell eyebrow="Where the tracks terminate" title="Career">
        <Card className="px-5 py-8">
          <div className="label">Reading the local cache</div>
          <div className="mt-3 h-px w-full overflow-hidden bg-line">
            <div className="h-full w-1/3 animate-pulse bg-accent" />
          </div>
        </Card>
      </ScreenShell>
    );
  }

  // A cache that could not be read is not an empty career. Distinguished from
  // both success and emptiness, and loudly, because the alternative is that
  // the screen renders zeroes that look like facts.
  if (error !== null || data === null) {
    return (
      <ScreenShell eyebrow="Where the tracks terminate" title="Career">
        <Callout
          icon={<AlertTriangle size={12} aria-hidden />}
          label="This screen has no data to show"
          tone="var(--color-bad)"
        >
          {error ??
            "The vault has not been loaded — nothing has called into the sync bridge yet, so there is no blob to read."}{" "}
          Nothing below would be a fact about your career; it would be the absence of an answer. So
          applications, certifications and the roadmap are all withheld until the store loads.
          <div className="mt-3 flex items-center gap-1.5 text-[11px] text-fg-muted">
            <DatabaseZap size={12} aria-hidden />
            The fix is a <code className="nums">startNexusSync()</code> call at boot, not a retry
            here.
          </div>
        </Callout>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell eyebrow="Where the tracks terminate" title="Career">
      <Tabs tabs={TABS} active={tab} onChange={(id) => setTab(id as Tab)} layoutId="career-tabs" />
      {tab === "evidence" && <Evidence data={data} rows={rows} counts={counts} />}
      {tab === "pipeline" && <Pipeline data={data.career} />}
      {tab === "certs" && <Certifications data={data.career} />}
      {tab === "plan" && <Plan data={data.roadmap} />}
      {tab === "stack" && <Stack data={data.roadmap} />}
    </ScreenShell>
  );
}
