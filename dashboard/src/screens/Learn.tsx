/**
 * Self-learning — nexus's `study` domain, ported.
 *
 * Source: `nexus/src/screens/Study.tsx` + `screens/study/`.
 * Data: `academics.studyPlanner` — `plans`, `sessions`, `pomodoroSettings`,
 * `weeklyGoalMinutes`, `streakFreezeDate`.
 *
 * The live pomodoro clock is **not** in that list and must not join it. It
 * lives in `store/timer.ts`, a plain zustand store with no persistence: a
 * half-finished countdown is not a fact about the user's work, and putting one
 * in the synced blob would have five devices arguing about whose 14:32 is
 * authoritative. Only the completed session is a record, and the timer writes
 * that through the `study` slice.
 *
 * Which is also why the tab state is local `useState` and the panels are
 * unmounted rather than hidden: the clock keeps running in its store while the
 * Progress tab is on screen, because the clock was never this component's
 * state to begin with.
 *
 * Reads are defensive. `useStudy()` is `useData((s) => s.data!.academics…)` —
 * a non-null assertion on a field that is `null` until something calls
 * `load()`, and nothing in this build does yet (`startNexusSync` has no
 * caller), so calling that hook would throw during render. The planner is
 * selected with `?.` instead and the not-success states are explicit.
 */
import { useState } from "react";
import { DatabaseZap, TriangleAlert } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Button, Callout, Tabs, type TabDef } from "@/components/ui";
import { useData } from "@/store/data";
import { Focus } from "./learn/Focus";
import { Plans } from "./learn/Plans";
import { Progress } from "./learn/Progress";

const EYEBROW = "Vault";
const TITLE = "Self-learning";

const TABS: TabDef[] = [
  { id: "focus", label: "Focus" },
  { id: "plans", label: "Plans" },
  { id: "progress", label: "Progress" },
];

export function LearnScreen() {
  // Three selectors rather than one object: zustand v5 compares by identity,
  // so a selector returning a fresh `{...}` re-renders on every store write.
  const loaded = useData((s) => s.loaded);
  const cacheError = useData((s) => s.error);
  const sp = useData((s) => s.data?.academics.studyPlanner ?? null);
  const [tab, setTab] = useState("focus");

  // State 1 of 3 — the vault is not open. Distinct from empty (a finished
  // screen with nothing in it) and from the error banner below (which sits
  // over real, editable data).
  if (!loaded || !sp) return <VaultClosed />;

  return (
    <ScreenShell eyebrow={EYEBROW} title={TITLE}>
      {/* State 2 of 3 — something went wrong, but the data underneath is
          usable. A banner over a working screen, not instead of one. */}
      {cacheError && (
        <Callout
          className="mb-4"
          tone="var(--color-bad)"
          icon={<TriangleAlert size={12} />}
          label="Local cache"
        >
          {cacheError}. Sessions and plans logged before this device last synced may be
          missing — the streak and the XP total are folds over that list, so both read low
          until sync catches up.
        </Callout>
      )}

      <Tabs tabs={TABS} active={tab} onChange={setTab} />
      {/* State 3 of 3 — empty — belongs to each panel, because "no plans yet"
          and "no sessions yet" are different screens with different ways out. */}
      {tab === "focus" && <Focus sp={sp} />}
      {tab === "plans" && <Plans sp={sp} />}
      {tab === "progress" && <Progress sp={sp} />}
    </ScreenShell>
  );
}

/**
 * The vault has not been read yet.
 *
 * Deliberately not a spinner. `load()` is app-boot wiring — `startNexusSync`
 * owns it, because it is the only caller that can carry `cacheHit` through to
 * the bridge, and a screen that quietly called `load()` on mount would be boot
 * wiring hiding in a screen. Nothing calls it in this build, so this state is
 * currently what the screen shows; the button makes it recoverable in one tap
 * instead of leaving a dead screen.
 */
function VaultClosed() {
  return (
    <ScreenShell eyebrow={EYEBROW} title={TITLE}>
      <Callout
        tone="var(--color-info)"
        icon={<DatabaseZap size={12} />}
        label="Vault not open"
        actions={
          <Button size="sm" variant="subtle" onClick={() => void useData.getState().load()}>
            Open
          </Button>
        }
      >
        Plans, sessions and the streak all read the local vault, and nothing has opened it
        in this session yet — sync boots it once{" "}
        <span className="nums">startNexusSync</span> is wired into the app shell. Open it
        now to work offline against the cache.
      </Callout>
    </ScreenShell>
  );
}
