/**
 * Home — a launcher, not a report.
 *
 * > Home answers "what do I have open right now." Live, ephemeral, glanceable.
 * > The vault answers "how is my work going." Accumulated, narrative, across
 * > weeks.
 *
 * That boundary is the thing keeping this merge from re-creating the overlap it
 * exists to remove, and the operative test is applied to every widget here:
 * **if its content would still be true next week, it belongs in the vault.**
 * Which is why there is no streak next to the habits, no "logged 6 hours this
 * week" next to the timer, no gate tally, and no count on a launcher tile. Each
 * of those was available and each was left out; the reasoning sits on the
 * widget it applies to.
 *
 * What is here, and what makes it a today fact:
 *
 *   quick capture — an empty box. The thought you are holding right now.
 *   due today     — overdue / due-today / undated only; next Friday is a track.
 *   right now     — a countdown and whatever stopwatch is running.
 *   habits        — ticked or not ticked, today. No streak.
 *   training      — a live verdict from the hub, true for about two seconds.
 *   launcher      — five doors, no numbers.
 *
 * Two of those need the synced blob and three do not, so the gate is partial on
 * purpose: training and the launcher render whether or not `NexusData` loaded.
 * A launcher that stops launching because a cache read failed is a worse
 * failure than the one it is reporting.
 */
import { useState } from "react";
import { Compass, Inbox, RefreshCw } from "lucide-react";
import { Button, Card, Chip } from "@/components/ui";
import { ScreenShell } from "@/components/ScreenShell";
import { Reveal } from "@/lib/motion";
import { longDate, todayStr } from "@/lib/nexus/format";
import type { ScreenId } from "@/config/nav";
import type { Connection, State } from "@/lib/api";
import { inboxOf, useBlob } from "@/store/capture";
import { useData } from "@/store/data";
import { CaptureBox } from "./capture/CaptureBox";
import { HabitsWidget } from "./home/HabitsWidget";
import { Launcher } from "./home/Launcher";
import { NowWidget } from "./home/NowWidget";
import { RunWidget } from "./home/RunWidget";
import { TodosWidget } from "./home/TodosWidget";

export function HomeScreen({
  onOpen,
  state,
  connection,
}: {
  onOpen: (id: ScreenId) => void;
  /** The live run, held by the shell. See RunWidget for why it is a prop. */
  state: State | null;
  connection: Connection;
}) {
  const { data, loaded, error } = useBlob();
  const [loading, setLoading] = useState(false);

  const waiting = data === null;
  const pending = data ? inboxOf(data.journal.fragments).length : 0;

  const retry = () => {
    setLoading(true);
    void useData
      .getState()
      .load()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  return (
    <ScreenShell title="Home" eyebrow={longDate(todayStr())}>
      <div className="flex flex-col gap-4">
        {/* ── quick capture ──────────────────────────────────────────────── */}
        <Reveal>
          <Card className="flex flex-col gap-3 p-5">
            <div className="flex items-center justify-between gap-3">
              <span className="label">capture</span>
              {pending > 0 && (
                <button
                  onClick={() => onOpen("capture")}
                  aria-label={`Triage ${pending} captures`}
                  className="rounded-full pointer-coarse:inline-flex pointer-coarse:min-h-[44px] pointer-coarse:items-center"
                >
                  {/* The one borderline number on this screen, and it earns its
                      place: the inbox is meant to be empty, so a non-zero count
                      is an obligation for today. If it is still true next week
                      that is the signal, not a bug. */}
                  <Chip color="var(--color-accent)" dot>
                    <Inbox size={10} strokeWidth={2} aria-hidden />
                    {pending} to triage
                  </Chip>
                </button>
              )}
            </div>
            <CaptureBox
              compact
              blocked={
                waiting
                  ? loaded
                    ? "The data store could not be read, so a capture has nowhere to land. Your text is kept on this device."
                    : "The data store has not been loaded yet. Your text is kept on this device and will still be here."
                  : null
              }
            />
          </Card>
        </Reveal>

        {/* ── the blob-backed widgets, or one honest explanation ───────────
            `RunWidget` sits in this grid unconditionally, and outside the
            branch, for a concrete reason: it owns an `EventSource`, and
            mounting it in two arms of a ternary would tear the stream down and
            rebuild it every time the blob's readiness changed. */}
        <Reveal style={{ ["--i" as string]: 1 }} className="grid gap-4 lg:grid-cols-2">
          {data ? (
            <NowWidget data={data} />
          ) : (
            <Card
              className="flex flex-col items-start gap-3 p-5"
              accent={error ? "var(--color-bad)" : "var(--color-warn)"}
              active
              role={error ? "alert" : undefined}
            >
              <div
                className="label"
                style={{ color: error ? "var(--color-bad)" : "var(--color-warn)" }}
              >
                {error ? "load failed" : "store not loaded"}
              </div>
              <p className="max-w-[56ch] text-[12px] leading-relaxed text-fg-dim">
                {error ??
                  "Todos, habits and the timer's settings all live in the synced data blob, and nothing has asked for it yet. This is app-boot wiring rather than a network problem — the shell has to call the data store's load() and start the sync bridge. Training and the launcher work regardless."}
              </p>
              <Button
                variant="primary"
                onClick={retry}
                disabled={loading}
                icon={<RefreshCw size={13} strokeWidth={1.8} aria-hidden />}
              >
                {loading ? "Loading…" : "Load the store"}
              </Button>
            </Card>
          )}
          <RunWidget onOpen={onOpen} state={state} connection={connection} />
        </Reveal>

        {data && (
          <Reveal style={{ ["--i" as string]: 2 }} className="grid gap-4 lg:grid-cols-2">
            <TodosWidget data={data} />
            <HabitsWidget data={data} />
          </Reveal>
        )}

        {/* ── the launcher ───────────────────────────────────────────────── */}
        <Reveal style={{ ["--i" as string]: 3 }} className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Compass size={13} strokeWidth={1.8} className="text-accent-dim" aria-hidden />
            <span className="label">the work</span>
            <span className="h-px flex-1 bg-line" />
          </div>
          <Launcher onOpen={onOpen} />
        </Reveal>
      </div>
    </ScreenShell>
  );
}
