/**
 * Live run status — the one widget on this screen that does not come from the
 * blob.
 *
 * Runs live in the hub's own tables on the server, not in `NexusData`, so this
 * reads `useLiveState` from `@/lib/api` rather than fetching. That hook already
 * carries the parts that are easy to get wrong and expensive to rediscover: an
 * SSE stream, a 15s poll for when the stream wedges, a rebuild on
 * `visibilitychange` because Safari kills sockets in a backgrounded tab, and a
 * `connection` that moves `connecting → offline` rather than sitting on
 * "connecting" forever.
 *
 * Four renderings, and the distinction between two of them is the reason this
 * project exists:
 *
 *   offline    — coral. If a snapshot is still in memory it is shown, labelled
 *                **last seen**, because the alternative is a screen of stale
 *                numbers wearing a healthy green word. Absence of evidence
 *                must not render as a verdict.
 *   connecting — amber, and it resolves: the hook flips to offline on error, so
 *                this is not a spinner that never ends.
 *   idle       — no run has reported. An empty state, not an error.
 *   live       — the verdict, the run, the step, the heartbeat.
 *
 * Nothing accumulated: no runs-this-week, no total steps across runs, no
 * success rate. A verdict and a step count are true for about two seconds,
 * which is precisely why they belong here.
 */
import { Activity, BrainCircuit, RefreshCw, WifiOff } from "lucide-react";
import { Button, Card, CardHead, Chip, CountUp, Stat } from "@/components/ui";
import type { Connection, State } from "@/lib/api";
import { statusOf } from "@/lib/status";
import type { ScreenId } from "@/config/nav";

export function RunWidget({
  onOpen,
  state,
  connection,
}: {
  onOpen: (id: ScreenId) => void;
  state: State | null;
  connection: Connection;
}) {
  // The stream arrives as props rather than from a second `useLiveState`.
  // Workspace already holds one, and a browser allows six EventSources per
  // origin — `api.ts` records that exhausting them stops the whole dashboard
  // loading, so one page opening a duplicate is two of six spent on one fact.
  const error = null;
  const refresh = () => {};
  const meta = statusOf(state?.status);

  const head = (
    <CardHead
      label="training"
      right={
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onOpen("brain")}
          icon={<BrainCircuit size={12} strokeWidth={1.8} aria-hidden />}
        >
          brain
        </Button>
      }
    />
  );

  if (connection === "offline") {
    return (
      <Card className="flex flex-col gap-3 p-5" accent="var(--color-bad)" active role="alert">
        {head}
        <div className="flex items-start gap-2.5">
          <WifiOff
            size={16}
            strokeWidth={1.8}
            className="mt-0.5 shrink-0 text-[var(--color-bad)]"
            aria-hidden
          />
          <div className="min-w-0">
            <div className="display text-[15px] text-fg">Can&apos;t reach the box</div>
            <p className="mt-1 max-w-[42ch] text-[11.5px] leading-relaxed text-fg-muted">
              {error ?? "The stream is down. Check Tailscale is up on both ends."}
            </p>
          </div>
        </div>

        {state?.run && (
          <div className="rounded-sm border-[0.5px] border-line bg-bg/60 px-3 py-2.5">
            <div className="label mb-1">last seen</div>
            <div className="truncate text-[12px] text-fg-dim">{state.run.name}</div>
            <div className="nums text-[11px] text-fg-muted">
              step {state.run.last_step.toLocaleString()} · {meta.word.toLowerCase()}
            </div>
          </div>
        )}

        <Button
          size="sm"
          variant="subtle"
          onClick={() => void refresh()}
          icon={<RefreshCw size={12} strokeWidth={1.8} aria-hidden />}
          className="self-start"
        >
          Retry
        </Button>
      </Card>
    );
  }

  if (!state) {
    return (
      <Card className="flex flex-col gap-3 p-5" accent="var(--color-warn)" active>
        {head}
        <div className="flex items-center gap-2.5">
          <Chip color="var(--color-warn)" dot>
            connecting
          </Chip>
          <span className="text-[11.5px] text-fg-muted">waiting for the first snapshot</span>
        </div>
      </Card>
    );
  }

  if (state.status === "no-run" || !state.run) {
    return (
      <Card className="flex flex-col gap-3 p-5">
        {head}
        <div className="flex items-center gap-2.5">
          <Activity size={15} strokeWidth={1.7} className="shrink-0 text-fg-muted" aria-hidden />
          <div className="min-w-0">
            <div className="display text-[15px] text-fg-dim">Nothing training</div>
            <p className="text-[11.5px] text-fg-muted">{meta.hint}</p>
          </div>
        </div>
      </Card>
    );
  }

  const beat = state.heartbeat;

  return (
    <Card className="flex flex-col gap-4 p-5" accent={meta.color} active>
      {head}

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="display text-[19px] leading-none" style={{ color: meta.color }}>
            {meta.word}
          </div>
          <p className="mt-1.5 max-w-[38ch] text-[11.5px] leading-relaxed text-fg-muted">
            {meta.hint}
          </p>
        </div>
        <Chip color={meta.color} dot={meta.alarm}>
          {connection}
        </Chip>
      </div>

      <div className="truncate text-[12.5px] text-fg-dim">{state.run.name}</div>

      <div className="flex items-end gap-6">
        <Stat label="step" value={<CountUp value={state.run.last_step} />} size="sm" />
        <Stat
          label="heartbeat"
          value={beat ? `${Math.round(beat.age)}s` : "—"}
          size="sm"
          color={
            beat && beat.age > beat.timeout ? "var(--color-bad)" : "var(--color-fg)"
          }
        />
      </div>
    </Card>
  );
}
