/**
 * Capture — one box, one tap, lands in an inbox, triaged later.
 *
 * The gate for this screen is a week of capturing from a phone with nothing
 * lost and nothing typed twice, so the composition is deliberately thin: the
 * box is the first thing on the screen and the only thing above the fold, and
 * everything else is the inbox it lands in. There is no capture flow, no
 * category picker at capture time and no confirmation step, because each of
 * those is a decision standing between having a thought and having recorded it.
 *
 * Why the inbox is `journal.fragments` rather than a new collection is argued
 * in `@/store/capture`; the short version is that fragments are already a
 * registered per-record sync collection and a new one could not be, so a new
 * collection would put the entire inbox under one last-writer-wins blob.
 *
 * Four states, and they are four different renderings on purpose. A screen
 * that shows an empty list for a failed load, or a spinner for a store nobody
 * ever asked to load, is the failure this project exists to remove:
 *
 *   not loaded  — amber, names the cause, offers the one action that fixes it,
 *                 and the box still accepts text (the draft is device-local,
 *                 so typing is never wasted).
 *   load failed — the error text itself, over whatever defaults are renderable.
 *   inbox empty — a finished, reassuring empty state. Success, not absence.
 *   inbox full  — the list.
 */
import { useEffect, useState } from "react";
import { Inbox, RefreshCw, WifiOff } from "lucide-react";
import { Button, Card, Chip } from "@/components/ui";
import { ScreenShell } from "@/components/ScreenShell";
import { Reveal } from "@/lib/motion";
import { inboxOf, useBlob } from "@/store/capture";
import { useData } from "@/store/data";
import { CaptureBox } from "./capture/CaptureBox";
import { Inbox as InboxList } from "./capture/Inbox";

/**
 * Whether the browser thinks it has a network.
 *
 * Presented as "held on this device", never as a sync verdict: `navigator.
 * onLine` is true behind a captive portal and true on a tailnet that cannot
 * reach the hub, so it can only be trusted in the negative direction. A false
 * here does mean the capture is going nowhere yet, which is worth saying —
 * queueing silently is how someone re-types a thought they already had.
 */
function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  return online;
}

export function CaptureScreen() {
  const { data, loaded, error } = useBlob();
  const online = useOnline();
  const [loading, setLoading] = useState(false);

  const waiting = data === null;
  const count = data ? inboxOf(data.journal.fragments).length : 0;

  const retry = () => {
    setLoading(true);
    void useData
      .getState()
      .load()
      .catch(() => undefined)
      .finally(() => setLoading(false));
  };

  return (
    <ScreenShell
      title="Capture"
      eyebrow="inbox"
      actions={
        <>
          {!online && (
            <Chip color="var(--color-warn)">
              <WifiOff size={10} strokeWidth={2} aria-hidden />
              held on this device
            </Chip>
          )}
          {count > 0 && (
            <Chip color="var(--color-accent)" dot>
              {count} to triage
            </Chip>
          )}
        </>
      }
    >
      <div className="mx-auto flex w-full max-w-[720px] flex-col gap-5">
        <Reveal>
          <Card className="p-4 sm:p-5">
            <CaptureBox
              autoFocus
              blocked={
                waiting
                  ? loaded
                    ? "The data store could not be read, so a capture has nowhere to land yet. Your text is kept on this device — retry below, then capture again."
                    : "The data store has not been loaded yet, so a capture has nowhere to land. Your text is kept on this device; load below and it will still be here."
                  : null
              }
            />
          </Card>
        </Reveal>

        {error && (
          <Reveal style={{ ["--i" as string]: 1 }}>
            <Card className="p-4" accent="var(--color-bad)" active role="alert">
              <div className="label mb-1.5 text-[var(--color-bad)]">load error</div>
              <p className="text-[12px] leading-relaxed text-fg-dim">{error}</p>
            </Card>
          </Reveal>
        )}

        {waiting ? (
          <Reveal style={{ ["--i" as string]: 2 }}>
            {/* Not a spinner. A spinner says "wait", and nothing here is waiting
                on anything — nothing asked the store to load. The honest render
                names that and offers the action. */}
            <Card className="flex flex-col items-start gap-3 p-5" accent="var(--color-warn)" active>
              <div className="label text-[var(--color-warn)]">store not loaded</div>
              <p className="max-w-[52ch] text-[12px] leading-relaxed text-fg-dim">
                The inbox lives in the synced data blob, and nothing has asked for it yet. This is
                app-boot wiring rather than a network problem — the shell has to call the data
                store&apos;s <span className="nums">load()</span> and start the sync bridge.
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
          </Reveal>
        ) : (
          <Reveal style={{ ["--i" as string]: 2 }} className="flex flex-col gap-3">
            <div className="flex items-center gap-2">
              <Inbox size={13} strokeWidth={1.8} className="text-accent-dim" aria-hidden />
              <span className="label">inbox</span>
              <span className="h-px flex-1 bg-line" />
            </div>
            <InboxList data={data} />
          </Reveal>
        )}
      </div>
    </ScreenShell>
  );
}
