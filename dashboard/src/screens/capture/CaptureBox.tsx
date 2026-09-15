/**
 * One box, one tap — and the three ways it refuses to lose what you typed.
 *
 * 1. **The draft is persisted on every keystroke**, to its own localStorage key
 *    outside `NexusData`. The app being killed mid-typing is the likeliest way
 *    a phone loses a thought, and the blob is the wrong place to hold an
 *    uncommitted one: it would sync a half-written sentence to four other
 *    devices, one request per character.
 * 2. **The box clears only when the commit returns true.** `capture.add`
 *    answers false for blank text and for a blob that has not loaded, and both
 *    of those used to be the same visual outcome as success — a cleared box
 *    over a capture that went nowhere.
 * 3. **A storage refusal is said out loud.** localStorage throws on a full
 *    quota and in some embedded contexts, and the app keeps working from
 *    memory — which looks identical to working, right up until the tab is
 *    discarded. That is the exact failure this project exists to remove, so it
 *    gets the loudest surface on the screen rather than a console line.
 *
 * Return commits and Shift+Return makes a new line. That is chosen for the
 * phone: the software keyboard's return key is the one-tap commit, and a
 * second capture therefore needs no navigation and no reach for a button. The
 * button is still there, because a control that only exists as a keystroke
 * does not exist on a touch screen.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, CornerDownLeft, Inbox } from "lucide-react";
import { Button, Chip, inputCls } from "@/components/ui";
import { cn } from "@/lib/cn";
import { capture, clearDraft, readDraft, useBlob, writeDraft } from "@/store/capture";

/** How long the "captured" acknowledgement stays up. */
const ACK_MS = 1600;

interface CaptureBoxProps {
  /**
   * Why capturing is impossible right now, or null. Non-null disables the
   * commit and keeps the text — it must never clear the box.
   */
  blocked?: string | null;
  autoFocus?: boolean;
  /** Fewer rows and no keyboard hint, for the home widget. */
  compact?: boolean;
  /** Fired after a capture lands, so a host can react (a count, a scroll). */
  onCaptured?: () => void;
  className?: string;
}

export function CaptureBox({
  blocked = null,
  autoFocus = false,
  compact = false,
  onCaptured,
  className,
}: CaptureBoxProps) {
  const { saveStatus } = useBlob();
  // Seeded from storage, so a kill mid-typing costs nothing.
  const [text, setText] = useState(() => readDraft());
  const [draftSafe, setDraftSafe] = useState(true);
  const [ack, setAck] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const ackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (ackTimer.current) clearTimeout(ackTimer.current);
    },
    [],
  );

  const change = (v: string) => {
    setText(v);
    setDraftSafe(writeDraft(v));
  };

  const commit = useCallback(() => {
    if (blocked) return;
    if (!capture.add(text)) return;
    setText("");
    clearDraft();
    setDraftSafe(true);
    setAck(true);
    if (ackTimer.current) clearTimeout(ackTimer.current);
    ackTimer.current = setTimeout(() => setAck(false), ACK_MS);
    // Back to the box, not to a confirmation screen: the second capture is the
    // one the gate is really about.
    box.current?.focus();
    onCaptured?.();
  }, [blocked, onCaptured, text]);

  const ready = text.trim().length > 0 && !blocked;

  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <textarea
        ref={box}
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => change(e.target.value)}
        onKeyDown={(e) => {
          // Only swallowed when there is somewhere for the capture to go.
          // Blocked, Return has to keep inserting a newline — otherwise the
          // key does nothing at all and the box feels broken on the exact
          // screen that is asking the user to keep typing.
          if (e.key === "Enter" && !e.shiftKey && !blocked) {
            e.preventDefault();
            commit();
          }
        }}
        aria-label="Capture a thought"
        placeholder={compact ? "Capture a thought…" : "What is in your head right now?"}
        // `inputCls` carries the 16px coarse-pointer size that stops iOS
        // zooming the page on focus and never zooming back out.
        className={cn(inputCls, "resize-none leading-relaxed", compact ? "min-h-[72px]" : "min-h-[104px]")}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          onClick={commit}
          disabled={!ready}
          icon={<Inbox size={13} strokeWidth={1.8} aria-hidden />}
          className="grow sm:grow-0"
        >
          Capture
        </Button>

        {ack && (
          <Chip color="var(--color-good)" dot>
            <Check size={10} strokeWidth={2.4} aria-hidden />
            in the inbox
          </Chip>
        )}

        {!compact && !ack && (
          <span className="flex items-center gap-1.5 text-[11px] text-fg-muted">
            <CornerDownLeft size={11} strokeWidth={1.8} aria-hidden />
            Return captures · Shift+Return for a second line
          </span>
        )}

        {text && !ack && draftSafe && (
          <span className="ml-auto text-[11px] text-fg-muted">draft kept on this device</span>
        )}
      </div>

      {/* Three warnings, deliberately different in tone and in wording, because
          they are three different problems: the blob is not there yet, the
          draft could not be stored, and committed captures are not reaching
          disk at all. A single generic banner would flatten them. */}
      {blocked && <Note tone="var(--color-warn)">{blocked}</Note>}

      {!draftSafe && text && (
        <Note tone="var(--color-warn)">
          This device refused to store the draft, so closing the app now would lose it. Capture it
          instead — a committed capture takes a different path.
        </Note>
      )}

      {saveStatus === "error" && (
        <Note tone="var(--color-bad)">
          Captures are not reaching this device&apos;s storage — they exist only in memory and will
          be lost if the app closes before they sync. Free up space, or leave private browsing.
        </Note>
      )}
    </div>
  );
}

function Note({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <p
      className="flex items-start gap-2 rounded-sm border-[0.5px] px-2.5 py-2 text-[11.5px] leading-relaxed"
      style={{
        color: tone,
        borderColor: `color-mix(in srgb, ${tone} 34%, transparent)`,
        background: `color-mix(in srgb, ${tone} 9%, transparent)`,
      }}
    >
      <AlertTriangle size={13} strokeWidth={1.8} className="mt-px shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}
