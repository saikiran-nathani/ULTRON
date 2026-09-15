/**
 * Research — the track that only exists because the two apps merged.
 *
 * `types.ts` states the whole argument for this screen in four lines, so it is
 * quoted rather than restated:
 *
 * > `runId` is the reason this domain exists in *this* app rather than in a
 * > notebook: it names a trainwatch run, so an experiment is joined to the loss
 * > curve, the GPU trace and the checkpoint that came out of it. Two apps merged
 * > into one is otherwise just two apps sharing a URL.
 *
 * Two tabs: the experiments, and the reading list — which is the paper list,
 * since `READING_TYPES` now carries `"Paper"` and papers belong to the
 * research track. `config/nav.ts` removed Journal as a screen and named this
 * as where the reading list surfaces.
 *
 * ── Two sources of truth, and they fail independently ───────────────────
 *
 * The vault (`useData`) holds the experiments. The hub (`useLiveState`) holds
 * the runs. They are different servers' worth of state with different failure
 * modes, and the screen renders five distinct things rather than one
 * "something went wrong":
 *
 * | vault    | hub         | what you see                                     |
 * | -------- | ----------- | ------------------------------------------------ |
 * | loading  | any         | reading the cache                                |
 * | failed   | any         | a red callout; no experiment list at all         |
 * | fine     | asking      | the full list, plus "connecting — not judged yet" |
 * | fine     | unreachable | the full list, with run links marked uncheckable |
 * | fine     | reachable   | everything                                       |
 *
 * `asking` is a row in its own right and not a rounding of `unreachable` — see
 * the `hub` computation below for the defect that taught that.
 *
 * `useLiveState()` is used rather than a direct fetch because it is this app's
 * existing wiring for hub state: SSE with a polling fallback, a
 * `visibilitychange` rebuild for Safari's suspended tabs, and a `connection`
 * value that is precisely the "can we ask at all" signal this screen needs.
 * The cost is one more `EventSource` than `App.tsx` already holds — two of the
 * browser's six per origin — and it is the honest trade: the alternative is
 * this screen inventing its own idea of whether the box is up.
 *
 * ── The load gate ───────────────────────────────────────────────────────
 * Same as `Career.tsx`: every store slice reads `s.data!.x`, and nothing in
 * the app calls `useData.getState().load()` yet (`startNexusSync` in
 * `lib/nexus/bridge.ts` has no caller), so `data` is `null` and the `!` is a
 * crash. Three stable selectors, and `NexusData` handed down as a prop.
 */
import { useMemo, useState } from "react";
import { AlertTriangle, DatabaseZap } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Callout, Card, Chip, Tabs, type TabDef } from "@/components/ui";
import type { Connection, State } from "@/lib/api";
import type { NexusData } from "@/lib/nexus/types";
import { reconcile, type Finding } from "@/lib/sync/reconcile";
import { NEXUS_REGISTRY, flatten } from "@/lib/sync/registry";
import { useData } from "@/store/data";
import { Experiments } from "./research/Experiments";
import { Papers } from "./research/Papers";
import type { HubReach } from "./research/runlink";
import { useRunLinks } from "./research/useRunLinks";

type Tab = "experiments" | "papers";

/** Still asking is `info`, not `warn`: it is a pending question, not a fault. */
const HUB_CHIP: Record<HubReach, string> = {
  asking: "var(--color-info)",
  reachable: "var(--color-good)",
  unreachable: "var(--color-warn)",
};

/**
 * Dangling `projectId`s, keyed by experiment id — and taken from the
 * reconciler rather than recomputed.
 *
 * `research.experiments.projectId → projects` is a line in
 * `NEXUS_REFERENCES`, so a dangling one is already a `dangling-reference`
 * `Finding` carrying a sentence written for a person. A local
 * `projects.find(...)` check here would be a second implementation of the same
 * question, free to disagree with the app's own reconciler — and
 * `reconcile.ts` is explicit that a needs-attention list which disagrees with
 * the real behaviour is worse than no list.
 *
 * Gated on at least one experiment actually having a `projectId`, because
 * `flatten` and `rehydrate` each `structuredClone` the whole blob and there is
 * no reason to pay that when the answer is certainly empty.
 */
function useProjectFindings(data: NexusData | null): ReadonlyMap<string, Finding> {
  return useMemo(() => {
    const out = new Map<string, Finding>();
    if (data === null) return out;
    if (!data.research.experiments.some((e) => e.projectId)) return out;
    // `flatten` takes `Record<string, unknown>`; `NexusData` is an interface
    // with no index signature, hence the cast. It reads the blob and clones
    // before touching anything, so handing it the live object is safe.
    const snapshot = flatten(data as unknown as Record<string, unknown>, NEXUS_REGISTRY);
    for (const f of reconcile(snapshot)) {
      if (f.collection === "research.experiments" && f.field === "projectId") out.set(f.id, f);
    }
    return out;
  }, [data]);
}

export function ResearchScreen({
  state,
  connection,
  refresh,
}: {
  /** The live run snapshot, held by the shell. */
  state: State | null;
  connection: Connection;
  refresh: () => void;
}) {
  const [tab, setTab] = useState<Tab>("experiments");
  const data = useData((s) => s.data);
  const loaded = useData((s) => s.loaded);
  const error = useData((s) => s.error);

  // The stream arrives as props rather than from a second `useLiveState()`.
  // The shell already holds one, a browser allows six EventSources per origin,
  // and `api.ts` records that exhausting them stops the whole dashboard
  // loading — so one screen opening a duplicate spends two of six on one fact.
  /**
   * Three states, in the order they are decidable — and the order matters.
   *
   * `offline` is checked first because it is the only *established* verdict:
   * the stream tried and failed. Only then is a null snapshot meaningful, and
   * it means "still asking", not "cannot ask".
   *
   * This was a boolean (`state !== null && connection !== "offline"`) and that
   * was a real defect, caught against a live hub: on first mount `state` is
   * null and `connection` is `"connecting"`, so the boolean was false and the
   * Experiments tab announced "the hub is unreachable" about a hub that was
   * answering `/api/state` with 200. Claiming we could not ask, while asking,
   * is the same category error as reading a failed fetch as a deleted run.
   *
   * Note that `unreachable` can carry a populated `runs`: a snapshot that
   * arrived and then a stream that dropped. Those runs stay resolved —
   * `resolveRunLink` keeps trusting a run it has seen — while no *new* id can
   * be asked about.
   */
  const hub: HubReach =
    connection === "offline" ? "unreachable" : state === null ? "asking" : "reachable";
  const runs = state?.runs ?? [];

  const experiments = data?.research.experiments ?? [];
  const { probes, pending, retry } = useRunLinks(experiments, runs, hub);
  const findings = useProjectFindings(data);

  const TABS: TabDef[] = [
    { id: "experiments", label: "Experiments", count: experiments.length },
    { id: "papers", label: "Reading list", count: data?.journal.readingList.length ?? 0 },
  ];

  if (!loaded) {
    return (
      <ScreenShell eyebrow="Hypothesis → run → result" title="Research">
        <Card className="px-5 py-8">
          <div className="label">Reading the local cache</div>
          <div className="mt-3 h-px w-full overflow-hidden bg-line">
            <div className="h-full w-1/3 animate-pulse bg-accent" />
          </div>
        </Card>
      </ScreenShell>
    );
  }

  // The vault failing is a different fact from the hub failing, and this is
  // the loud one: without experiments there is nothing for a run link to be a
  // link *from*.
  if (error !== null || data === null) {
    return (
      <ScreenShell eyebrow="Hypothesis → run → result" title="Research">
        <Callout
          icon={<AlertTriangle size={12} aria-hidden />}
          label="The vault could not be read"
          tone="var(--color-bad)"
        >
          {error ??
            "Nothing has loaded the vault yet — no call has reached the sync bridge, so there is no blob to read."}{" "}
          Experiments and the reading list both live in it, so neither is shown: an empty list here
          would be a claim about your work, and this is the absence of an answer instead.
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-fg-muted">
            <span className="flex items-center gap-1.5">
              <DatabaseZap size={12} aria-hidden />
              Vault: unavailable
            </span>
            {/* The hub is reported separately even here, because the two are
                independent and reading one as the other is the confusion this
                screen is built against. `connection` is surfaced verbatim, so
                `connecting` shows as itself rather than as a failure. */}
            <Chip color={HUB_CHIP[hub]} dot>
              hub {hub === "reachable" ? "reachable" : connection}
            </Chip>
          </div>
        </Callout>
      </ScreenShell>
    );
  }

  return (
    <ScreenShell eyebrow="Hypothesis → run → result" title="Research">
      <Tabs
        tabs={TABS}
        active={tab}
        onChange={(id) => setTab(id as Tab)}
        layoutId="research-tabs"
      />
      {tab === "experiments" && (
        <Experiments
          data={data}
          ctx={{ runs, hub, probes }}
          findings={findings}
          pending={pending}
          hub={hub}
          onRetry={() => {
            // Both halves: the snapshot may have a fresher run list, and the
            // per-id probes need forgetting before they will be asked again.
            void refresh();
            retry();
          }}
        />
      )}
      {tab === "papers" && <Papers data={data.journal} />}
    </ScreenShell>
  );
}
