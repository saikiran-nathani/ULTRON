/**
 * The shared clipboard — the screen this whole hub exists for.
 *
 * Framing that drove the design: Universal Clipboard already handles
 * Mac<->iPad<->iPhone, and handles it better (OS-level, no page to open). What
 * it cannot do is include a Linux box, and what it does not do at all is keep
 * history. So this screen optimises for exactly those two things.
 */
import { useMemo, useState } from "react";
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  Lock,
  Pin,
  PinOff,
  Search,
  ShieldAlert,
  Trash2,
  Upload,
} from "lucide-react";
import { ScreenShell } from "@/components/ScreenShell";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { bytes, dayClock } from "@/lib/format";
import {
  type Clip,
  type HubState,
  hubApi,
  canReadClipboard,
  isSecureContext,
  readClipboard,
} from "@/lib/hub";
import { Button, Card, Chip, CopyButton, EmptyState, IconButton } from "@/components/ui";

export function ClipScreen({ hub, refresh }: { hub: HubState | null; refresh: () => void }) {
  const [draft, setDraft] = useState("");
  const [secret, setSecret] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<Record<number, string>>({});
  const [warned, setWarned] = useState(false);

  const clips = useMemo(() => {
    const all = hub?.clips ?? [];
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter(
      (c) => !c.secret && (c.preview.toLowerCase().includes(q) || c.device.toLowerCase().includes(q)),
    );
  }, [hub?.clips, query]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const push = async () => {
    const body = draft;
    if (!body.trim()) return;
    // `busy` is set inside act(), which runs *after* the inspect await below,
    // so the button stayed enabled during the pre-flight. Double-tapping on a
    // slow link fired two inspects then two pushes, and the server's digest
    // dedupe only compares against the single most recent row — so both saw
    // the old head and both inserted. Guard before the first await.
    if (busy) return;
    setBusy(true);
    try {
      // Nudge, never silently reclassify: guessing wrong either way is worse
      // than asking. Only nudge once per draft so it cannot become noise.
      if (!secret && !warned) {
        try {
          const { looks_secret } = await hubApi.inspect(body);
          if (looks_secret) {
            setWarned(true);
            setError(
              "That looks like a credential — mark it secret, or push again to send as-is.",
            );
            return;
          }
        } catch {
          /* the nudge is optional; never block a push on it */
        }
      }
      await hubApi.pushClip(body, { secret });
      setDraft("");
      setSecret(false);
      setWarned(false);
      setError(null);
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not push");
    } finally {
      setBusy(false);
    }
  };

  const pasteAndPush = async () => {
    const text = await readClipboard();
    if (text == null) {
      setError(
        canReadClipboard()
          ? "Paste was declined. iOS asks permission each time — tap Allow Paste."
          : "This browser will not expose the clipboard here. See the banner above.",
      );
      return;
    }
    setDraft(text);
  };

  // How long a revealed secret stays on screen before it re-hides itself.
  const REVEAL_TTL = 30_000;

  const hide = (id: number) =>
    setRevealed((r) => {
      if (!(id in r)) return r;
      const next = { ...r };
      delete next[id];
      return next;
    });

  const reveal = async (c: Clip) => {
    const body = await hubApi.clipBody(c.id).catch(() => null);
    if (body == null) return;
    setRevealed((r) => ({ ...r, [c.id]: body }));
    // Revealed plaintext used to live in this map forever: the Eye button is
    // hidden once revealed, so there was no way back short of leaving the tab,
    // and the secret outlived the clip's own server-side expiry. Auto-hide,
    // and make the toggle reversible (see the button below).
    window.setTimeout(() => hide(c.id), REVEAL_TTL);
  };

  return (
    <ScreenShell eyebrow="shared clipboard" title="Clip">
      <Stagger className="flex flex-col gap-4">
        {!isSecureContext() && (
          <Reveal>
            <InsecureBanner />
          </Reveal>
        )}

        {/* composer */}
        <Reveal>
          <Card className="p-4">
            <textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setWarned(false);
                setError(null);
              }}
              onPaste={(e) => {
                // Pasting an image straight into the composer is the
                // iPhone-screenshot-to-Linux path; hand it to the uploader.
                const file = Array.from(e.clipboardData.files)[0];
                if (file) {
                  e.preventDefault();
                  void act(() => hubApi.upload(file));
                }
              }}
              aria-label="Clip text to share"
              placeholder="Paste or type anything — it appears on every device"
              rows={4}
              className={cn(
                "w-full resize-y rounded-sm border-[0.5px] border-line bg-bg px-3 py-2.5",
                "text-[13px] leading-relaxed text-fg outline-none transition-colors",
                "placeholder:text-fg-muted/60 focus:border-line-strong",
                secret && "font-mono",
              )}
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant="primary"
                onClick={push}
                disabled={busy || !draft.trim()}
                icon={<Upload size={13} />}
              >
                Push
              </Button>
              <Button
                variant="ghost"
                onClick={pasteAndPush}
                icon={<ClipboardPaste size={13} />}
                title="Read the device clipboard into the box"
              >
                Paste
              </Button>
              <button
                onClick={() => setSecret((s) => !s)}
                className={cn(
                  "inline-flex min-h-[44px] items-center gap-1.5 rounded-sm border px-3 text-[12px] font-medium transition-all active:scale-[0.97]",
                  secret
                    ? "border-[color-mix(in_srgb,var(--color-bad)_40%,transparent)] bg-[color-mix(in_srgb,var(--color-bad)_12%,transparent)] text-[var(--color-bad)]"
                    : "border-line bg-card text-fg-muted hover:text-fg-dim",
                )}
              >
                <Lock size={12} />
                {secret ? "Secret" : "Mark secret"}
              </button>
              <span className="ml-auto nums text-[11px] text-fg-muted">
                {draft ? bytes(new Blob([draft]).size) : ""}
              </span>
            </div>
            {secret && (
              <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
                Hidden in the list, excluded from search, never logged, and gone in 15 minutes.
              </p>
            )}
            {error && (
              <p className="mt-2 flex items-start gap-1.5 text-[11.5px] leading-relaxed text-[var(--color-warn)]">
                <ShieldAlert size={13} className="mt-0.5 shrink-0" />
                {error}
              </p>
            )}
          </Card>
        </Reveal>

        {/* search + clear */}
        {(hub?.clips.length ?? 0) > 0 && (
          <Reveal>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search
                  size={13}
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-fg-muted"
                />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  aria-label="Search clipboard history"
                  placeholder="Search history"
                  className="min-h-[44px] w-full rounded-sm border-[0.5px] border-line bg-bg pl-9 pr-3 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg-muted/60 focus:border-line-strong"
                />
              </div>
              <Button
                variant="ghost"
                onClick={() => act(hubApi.clearClips)}
                icon={<Trash2 size={13} />}
                title="Delete everything except pinned items"
              >
                Clear
              </Button>
            </div>
          </Reveal>
        )}

        {/* history */}
        <Reveal>
          {clips.length === 0 ? (
            <EmptyState
              title={query ? "Nothing matches" : "Nothing copied yet"}
              icon={<ClipboardPaste size={22} strokeWidth={1.6} />}
              hint={
                query
                  ? "Secrets are excluded from search on purpose — matching on a redacted entry would leak it a character at a time."
                  : "Push from here, or from a terminal on any device: echo hello | trainwatch clip"
              }
            />
          ) : (
            <div className="flex flex-col gap-2">
              {clips.map((c) => (
                <ClipRow
                  key={c.id}
                  clip={c}
                  revealed={revealed[c.id]}
                  onReveal={() => (revealed[c.id] ? hide(c.id) : reveal(c))}
                  onPin={() => act(() => hubApi.pinClip(c.id, !c.pinned))}
                  onDelete={() => act(() => hubApi.deleteClip(c.id))}
                />
              ))}
            </div>
          )}
        </Reveal>
      </Stagger>
    </ScreenShell>
  );
}

function ClipRow({
  clip,
  revealed,
  onReveal,
  onPin,
  onDelete,
}: {
  clip: Clip;
  revealed?: string;
  onReveal: () => void;
  onPin: () => void;
  onDelete: () => void;
}) {
  const shown = revealed ?? clip.preview;
  return (
    <Card
      active={clip.pinned || clip.secret}
      accent={clip.secret ? "var(--color-bad)" : "var(--color-accent)"}
      className="px-4 py-3"
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <pre
            className={cn(
              "nums max-h-24 overflow-hidden whitespace-pre-wrap break-all text-[12px] leading-relaxed",
              clip.secret && !revealed ? "text-fg-muted" : "text-fg-dim",
            )}
          >
            {shown}
          </pre>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1">
            {clip.secret && (
              <Chip color="var(--color-bad)" dot>
                secret
              </Chip>
            )}
            {clip.pinned && <Chip color="var(--color-accent)">pinned</Chip>}
            <span className="label">{clip.device || "unknown"}</span>
            <span className="nums text-[10.5px] text-fg-muted">{dayClock(clip.ts)}</span>
            <span className="nums text-[10.5px] text-fg-muted">{bytes(clip.bytes)}</span>
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          {/* For a secret, the body is fetched at the moment of copying —
              it never sits in the page waiting to be scraped. */}
          <CopyButton
            size="sm"
            resolve={clip.secret ? () => hubApi.clipBody(clip.id) : undefined}
            text={clip.secret ? undefined : clip.body}
          />
          <div className="flex items-center gap-1">
            {clip.secret && (
              <IconButton
                icon={revealed ? <EyeOff size={13} /> : <Eye size={13} />}
                label={revealed ? "Hide" : "Reveal"}
                onClick={onReveal}
                className="h-9 w-9"
              />
            )}
            <IconButton
              icon={clip.pinned ? <PinOff size={13} /> : <Pin size={13} />}
              label={clip.pinned ? "Unpin" : "Pin (never expires)"}
              onClick={onPin}
              className="h-9 w-9"
            />
            <IconButton
              icon={<Trash2 size={13} />}
              label="Delete"
              danger
              onClick={onDelete}
              className="h-9 w-9"
            />
          </div>
        </div>
      </div>
    </Card>
  );
}

function InsecureBanner() {
  return (
    <Card active accent="var(--color-warn)" className="flex items-start gap-3 px-4 py-3">
      <ShieldAlert size={15} className="mt-0.5 shrink-0 text-[var(--color-warn)]" />
      <div className="text-[12px] leading-relaxed text-fg-dim">
        <span className="text-[var(--color-warn)]">Not a secure context.</span> Safari only exposes{" "}
        <span className="nums">navigator.clipboard</span> over HTTPS, so one-tap copy and paste are
        unavailable here — text still syncs, you just have to select it by hand. Fix it in one
        command on the host:
        <div className="nums mt-2 rounded-sm border-[0.5px] border-line bg-bg px-2.5 py-1.5 text-[11.5px] text-fg">
          trainwatch share
        </div>
        <span className="mt-1.5 block text-[11px] text-fg-muted">
          That puts the dashboard behind Tailscale&apos;s own certificate. Nothing to install on any
          device.
        </span>
      </div>
    </Card>
  );
}
