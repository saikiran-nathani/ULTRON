/**
 * `brain` — ULTRON's slot: status panel plus action rail.
 *
 * Everything trainwatch used to put at the top level lives in here. That is
 * the plan's own arrangement, and the reason is arithmetic: the merged app has
 * eight domains and eight monitoring surfaces, and a phone bottom bar cannot
 * hold sixteen. Monitoring is what you open when a run is going; the tracks
 * are what you open the rest of the time.
 *
 * Two levels of tabs, which is one more than anywhere else in the app and is
 * deliberate: `Status` keeps its own Watch/Metrics/Machine/Alerts strip
 * because those are four views of one run, not four destinations. Clip, Drop
 * and Notes are the device hub — the reason the phone can hand a file to the
 * TUF at all — and they are siblings of the status panel, not views of it.
 */
import { useState } from "react";
import { Tabs, type TabDef } from "@/components/ui";
import { ClipScreen } from "./Clip";
import { DropScreen } from "./Drop";
import { NotesScreen } from "./Notes";

type Panel = "status" | "clip" | "drop" | "notes";

const PANELS: TabDef[] = [
  { id: "status", label: "Status" },
  { id: "clip", label: "Clip" },
  { id: "drop", label: "Drop" },
  { id: "notes", label: "Notes" },
];

interface BrainProps {
  /** The training status panel, already composed by the shell — it owns the
   *  live state and the run picker, and passing the element rather than the
   *  state keeps this container from growing a second copy of that wiring. */
  status: React.ReactNode;
  hub: Parameters<typeof ClipScreen>[0]["hub"];
  refresh: () => void;
  /** Unread counts, so a tab that has something waiting says so. */
  badges?: Partial<Record<Panel, number>>;
}

export function BrainScreen({ status, hub, refresh, badges }: BrainProps) {
  const [panel, setPanel] = useState<Panel>("status");
  const tabs = PANELS.map((t) => ({ ...t, count: badges?.[t.id as Panel] }));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-3 md:px-6">
        <Tabs tabs={tabs} active={panel} onChange={(id) => setPanel(id as Panel)} layoutId="brain-panel" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {panel === "status" && status}
        {panel === "clip" && <ClipScreen hub={hub} refresh={refresh} />}
        {panel === "drop" && <DropScreen hub={hub} refresh={refresh} />}
        {panel === "notes" && <NotesScreen hub={hub} refresh={refresh} />}
      </div>
    </div>
  );
}
