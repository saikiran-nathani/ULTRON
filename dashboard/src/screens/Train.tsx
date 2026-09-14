/**
 * Training monitoring, grouped behind one nav slot.
 *
 * Four screens became too many for a thumb-reachable bottom bar once the hub
 * arrived, and the hub is what you open twenty times a day while monitoring is
 * what you open when something is running. So monitoring collapses into tabs
 * rather than competing for primary navigation.
 */
import { useState } from "react";
import type { ReactNode } from "react";
import { Tabs } from "@/ui/Tabs";
import { ScreenShell } from "@/components/ScreenShell";
import { Watch } from "./Watch";
import { Metrics } from "./Metrics";
import { Machine } from "./Machine";
import { Alerts } from "./Alerts";
import type { State } from "@/lib/api";

type Pane = "watch" | "metrics" | "machine" | "alerts";

export function Train({ state, actions }: { state: State; actions?: ReactNode }) {
  const [pane, setPane] = useState<Pane>("watch");
  const alertCount = state.events.filter((e) => e.level !== "info").length;

  return (
    <div className="flex min-h-full flex-col">
      <div className="mx-auto w-full max-w-[1160px] px-5 pt-[max(env(safe-area-inset-top),1.5rem)] sm:px-8 lg:pt-[max(env(safe-area-inset-top),2rem)]">
        <Tabs
          tabs={[
            { id: "watch", label: "Watch" },
            { id: "metrics", label: "Metrics" },
            { id: "machine", label: "Machine" },
            { id: "alerts", label: "Alerts", count: alertCount || undefined },
          ]}
          active={pane}
          onChange={(id) => setPane(id as Pane)}
          layoutId="train-tabs"
        />
      </div>
      {/* Keyed so each pane replays its own entrance rather than cross-fading
          into whatever the previous pane's layout was. */}
      <div key={pane} className="page-in-fwd flex-1">
        {pane === "watch" && <Watch state={state} onNavigate={() => setPane("alerts")} actions={actions} />}
        {pane === "metrics" && <Metrics state={state} actions={actions} />}
        {pane === "machine" && <Machine state={state} actions={actions} />}
        {pane === "alerts" && <Alerts state={state} actions={actions} />}
      </div>
    </div>
  );
}

export function TrainEmpty() {
  return <ScreenShell eyebrow="training" title="Train" />;
}
