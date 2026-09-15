/**
 * Shared scratchpads. Debounced autosave, because a note you have to remember
 * to save is a note you will lose.
 */
import { useEffect, useRef, useState } from "react";
import { Check, FileText, Plus, Trash2 } from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { dayClock } from "@/lib/format";
import { type HubState, hubApi } from "@/lib/hub";
import { Button, Card, EmptyState, IconButton } from "@/components/ui";

const SAVE_DEBOUNCE = 700;

/**
 * Mirror of `_slug` in src/trainwatch/hub.py. Must stay byte-for-byte
 * identical: the client selects the new note by predicting the id the server
 * will assign, so any divergence selects a note that does not exist — empty
 * textarea, no delete button, and typing creates a *second* duplicate note.
 *
 * The three things the previous inline version dropped, all load-bearing:
 *   - trailing/leading dash strip  ("Runs!" → server `runs`, client `runs-`)
 *   - the 64-char cap
 *   - the "scratch" fallback for a name that slugs to nothing
 *
 * Truncation deliberately happens AFTER the dash strip, matching the server,
 * so a >64-char name can still end in a dash on both sides.
 */
function slug(name: string): string {
  const out = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return out.slice(0, 64) || "scratch";
}

export function NotesScreen({ hub, refresh }: { hub: HubState | null; refresh: () => void }) {
  const notes = hub?.notes ?? [];
  const [activeId, setActiveId] = useState<string | null>(null);
  const id = activeId ?? notes[0]?.id ?? "scratch";
  const note = notes.find((n) => n.id === id);

  const [draft, setDraft] = useState(note?.body ?? "");
  const [saved, setSaved] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);
  // The save the debounce is holding, tagged with the note it belongs to, so
  // switching notes can flush it instead of silently dropping it.
  const pending = useRef<{ id: string; body: string } | null>(null);
  const loadedFor = useRef<string | null>(null);
  // Whether the body currently in the textarea came from the user rather than
  // from the server. Load-bearing: see the second branch below.
  const userEdited = useRef(false);

  // Only reset the textarea when the *selected note* changes — not on every
  // SSE push, or your cursor jumps mid-sentence whenever another device writes.
  useEffect(() => {
    if (loadedFor.current !== id) {
      // Flush before swapping the draft out. `pending` carries the id it
      // belongs to, so this saves to the note being left, not the new one.
      flushPending();
      loadedFor.current = id;
      userEdited.current = false;
      setDraft(note?.body ?? "");
      setSaved("idle");
      setError(null);
      return;
    }

    // Same id, but the note only just arrived. This happens on first paint:
    // `hub` is null, so `note` is undefined and `id` falls back to "scratch" —
    // which is also the backend's slug fallback, i.e. a real note's id. The
    // branch above then marks "scratch" as loaded with an empty draft, and
    // because `id` never changes it would never re-sync. The user sees a blank
    // editor above a "last edited …" line, and one keystroke debounce-PUTs
    // that single character as the entire body. No undo, no revision history.
    //
    // Adopt the server body only while the draft is still untouched, so this
    // can never clobber something the user typed before the snapshot landed.
    if (!userEdited.current && note !== undefined && draft === "" && note.body !== "") {
      setDraft(note.body);
    }
  }, [id, note, draft]);

  // Leaving the screen inside the debounce window used to drop the save and
  // then setState on an unmounted component. Flush instead.
  useEffect(() => {
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
      const p = pending.current;
      pending.current = null;
      if (p) void hubApi.putNote(p.id, p.body).catch(() => undefined);
    };
  }, []);

  // Flush any pending save for the note we are leaving, then clear the timer.
  // The debounce timer is shared across notes, so switching mid-window used to
  // clearTimeout() a save belonging to a *different* note — the text was gone
  // and nothing ever retried it.
  const flushPending = () => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    pending.current = null;
    if (p) void save(p.id, p.body);
  };

  const save = async (noteId: string, body: string) => {
    try {
      await hubApi.putNote(noteId, body);
      setSaved("saved");
      setError(null);
      refresh();
      window.setTimeout(() => setSaved("idle"), 1500);
    } catch (e) {
      setSaved("idle");
      setError(e instanceof Error ? e.message : "could not save");
    }
  };

  const onChange = (value: string) => {
    userEdited.current = true;
    setDraft(value);
    setSaved("saving");
    if (timer.current) window.clearTimeout(timer.current);
    pending.current = { id, body: value };
    timer.current = window.setTimeout(() => {
      pending.current = null;
      void save(id, value);
    }, SAVE_DEBOUNCE);
  };

  const create = async () => {
    const name = window.prompt("Note name", "notes")?.trim();
    if (!name) return;
    // Both of these used to be bare awaits with no catch and no error state,
    // so a 421 or a dropped tailnet looked exactly like "nothing happened".
    try {
      flushPending();
      await hubApi.putNote(name, "");
      setActiveId(slug(name));
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create the note");
    }
  };

  return (
    <ScreenShell
      eyebrow="shared scratchpad"
      title="Notes"
      actions={
        <Button variant="ghost" icon={<Plus size={13} />} onClick={create}>
          New
        </Button>
      }
    >
      <Stagger className="flex flex-col gap-4">
        {notes.length > 1 && (
          <Reveal>
            <div className="flex flex-wrap gap-2">
              {notes.map((n) => (
                <button
                  key={n.id}
                  onClick={() => setActiveId(n.id)}
                  className={cn(
                    "min-h-[38px] rounded-sm border px-3 text-[12px] font-medium transition-all active:scale-[0.97]",
                    n.id === id
                      ? "border-line-active bg-accent/10 text-accent-lt"
                      : "border-line bg-card text-fg-muted hover:text-fg-dim",
                  )}
                >
                  {n.id}
                </button>
              ))}
            </div>
          </Reveal>
        )}

        <Reveal>
          <Card className="p-4">
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <span className="label">{id}</span>
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "flex items-center gap-1 text-[10.5px] transition-opacity",
                    saved === "idle" && "opacity-0",
                  )}
                  style={{
                    color: saved === "saved" ? "var(--color-good)" : "var(--color-fg-muted)",
                  }}
                >
                  {saved === "saved" ? <Check size={11} /> : null}
                  {saved === "saving" ? "saving…" : saved === "saved" ? "saved" : ""}
                </span>
                {note && (
                  <IconButton
                    icon={<Trash2 size={13} />}
                    label="Delete note"
                    danger
                    className="h-9 w-9"
                    onClick={async () => {
                      try {
                        // Drop the pending save first — flushing it would
                        // re-create the note we are deleting.
                        if (timer.current) window.clearTimeout(timer.current);
                        pending.current = null;
                        await hubApi.deleteNote(id);
                        setActiveId(null);
                        loadedFor.current = null;
                        setError(null);
                        refresh();
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "could not delete the note");
                      }
                    }}
                  />
                )}
              </div>
            </div>
            <textarea
              value={draft}
              onChange={(e) => onChange(e.target.value)}
              aria-label="Note body"
              placeholder="Anything you want on every device — hyperparameters, a todo, an ssh one-liner"
              rows={16}
              className="w-full resize-y rounded-sm border-[0.5px] border-line bg-bg px-3 py-2.5 text-[13px] leading-relaxed text-fg outline-none transition-colors placeholder:text-fg-muted/60 focus:border-line-strong"
            />
            {error && (
              <p role="alert" className="mt-2 text-[11px]" style={{ color: "var(--color-bad)" }}>
                {error}
              </p>
            )}
            {note && (
              <p className="mt-2 text-[10.5px] text-fg-muted">
                last edited {dayClock(note.updated_at)}
                {note.device ? ` on ${note.device}` : ""}
              </p>
            )}
          </Card>
        </Reveal>

        {notes.length === 0 && (
          <Reveal>
            <EmptyState
              title="One scratchpad, everywhere"
              icon={<FileText size={22} strokeWidth={1.6} />}
              hint="Start typing above — it saves itself and shows up on every device."
            />
          </Reveal>
        )}
      </Stagger>
    </ScreenShell>
  );
}
