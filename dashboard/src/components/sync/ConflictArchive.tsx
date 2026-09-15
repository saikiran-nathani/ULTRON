/**
 * Every version of one record — winners, losers, and a way back.
 *
 * This screen exists to turn *"your edit was silently overwritten"* into
 * *"replaced by MacBook-Pro at 14:02 — view / restore"*. Everything here
 * follows from that sentence, and three consequences are worth writing down
 * because each is easy to get subtly wrong:
 *
 * **The live version must be unmistakable.** A version list you cannot read
 * the winner off is worse than no list at all — it shows the user their data
 * exists somewhere without telling them which copy is real. So "live" is
 * carried three ways at once (a green rule, a dotted chip, brighter type) and
 * the role comes from `archiveOf`, which derives it from the HLC rather than
 * from the order rows happened to arrive in.
 *
 * **Absence of evidence must not render as success.** "Only ever one version"
 * and "could not read the history" are the same empty list to a naive
 * implementation, and one of them is a lie that reassures. They get different
 * shapes, different colours and different words here, and a request still in
 * flight gets a third. This is the failure mode the whole sync project is
 * about; it would be a poor joke to reproduce it on the screen built to expose
 * it.
 *
 * **Restore is a write, not a rewind.** It pushes the old body back as a new
 * version, from this device, now — the current version does not disappear, it
 * loses the next comparison exactly as any edit would. The copy says that in
 * those words, because a user who thinks Restore erases something will not
 * press it, and a user who thinks it is free will press it without reading.
 * The push itself is the engine's (`lib/sync/`), never this component's: one
 * code path writes records, and it is not the one drawing pictures of them.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  History,
  RefreshCw,
  RotateCcw,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { dayClock } from "@/lib/format";
import {
  HISTORY_LIMIT_DEFAULT,
  SyncApiError,
  archiveOf,
  diffBodies,
  stableJson,
  syncApi,
  type ArchivedVersion,
  type SyncHistory,
  type SyncVersion,
  type VersionRole,
} from "@/lib/syncApi";
import { Button, Card, Chip, EmptyState, IconButton } from "@/components/ui";

/** What the caller is handed when the user confirms a restore. */
export interface RestoreRequest {
  collection: string;
  id: string;
  version: SyncVersion;
}

/**
 * The three roles, in the user's words rather than the log's.
 *
 * `accepted` and `rejected` are not "won" and "lost" — an accepted version
 * that has since been replaced *did* reach the other devices before it was
 * replaced, while a rejected one never existed anywhere. Different sentence,
 * different fix, so different words.
 */
const ROLE: Record<VersionRole, { word: string; hint: string; colour: string }> = {
  live: {
    word: "live now",
    hint: "This is the version every device holds.",
    colour: "var(--color-good)",
  },
  superseded: {
    word: "overwritten",
    hint: "It was stored and did reach your other devices, then a later edit replaced it.",
    colour: "var(--color-warn)",
  },
  refused: {
    word: "never landed",
    hint: "It arrived behind the version already stored, so it was never applied anywhere.",
    colour: "var(--color-bad)",
  },
};

type Load =
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; history: SyncHistory };

export function ConflictArchive({
  collection,
  recordId,
  label,
  limit = HISTORY_LIMIT_DEFAULT,
  onRestore,
  className,
}: {
  collection: string;
  recordId: string;
  /** A human name for the record. The id is always shown underneath. */
  label?: string;
  limit?: number;
  /**
   * Push this body back as a new version. Optional: without it the archive is
   * read-only, which is a legitimate placement — the engine owns every write,
   * and a screen with no engine behind it should not pretend otherwise.
   */
  onRestore?: (request: RestoreRequest) => void | Promise<void>;
  className?: string;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  // Row state is keyed by index, not by HLC. The same HLC can appear twice in
  // one archive — a device whose push was accepted, then re-pushed after
  // losing to another device, is logged once accepted and once rejected.
  const [open, setOpen] = useState<number | null>(null);
  const [armed, setArmed] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: "loading" });
    setOpen(null);
    setArmed(null);
    setRestoreError(null);

    syncApi
      .history(collection, recordId, limit, ac.signal)
      .then((history) => setLoad({ status: "ready", history }))
      .catch((e: unknown) => {
        // An abort is a record change or an unmount, not a failure. Rendering
        // it as one would flash "could not read the history" every time the
        // caller switched records — training the user to ignore the one
        // message that must never be ignored.
        if (ac.signal.aborted) return;
        setLoad({ status: "failed", error: e });
      });

    return () => ac.abort();
  }, [collection, recordId, limit, reload]);

  const refresh = () => setReload((n) => n + 1);

  return (
    <Card className={cn("overflow-hidden", className)}>
      <header className="flex items-start justify-between gap-3 border-b-[0.5px] border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="label mb-1.5 flex items-center gap-1.5 text-accent-dim">
            <History size={11} strokeWidth={2.2} />
            conflict archive
          </div>
          <div className="display truncate text-[15px] leading-tight text-fg">
            {label ?? recordId}
          </div>
          <div className="nums mt-1 truncate text-[10.5px] text-fg-muted">
            {label ? `${collection} · ${recordId}` : collection}
          </div>
        </div>
        <IconButton
          icon={<RefreshCw size={13} className={cn(load.status === "loading" && "animate-spin")} />}
          label="Reload the archive"
          onClick={refresh}
        />
      </header>

      <div className="p-4">
        {load.status === "loading" && <Loading />}
        {load.status === "failed" && <Failed error={load.error} onRetry={refresh} />}
        {load.status === "ready" && (
          <Ready
            history={load.history}
            limit={limit}
            open={open}
            armed={armed}
            busy={busy}
            restoreError={restoreError}
            onToggle={(i) => {
              setOpen((cur) => (cur === i ? null : i));
              setArmed(null);
              setRestoreError(null);
            }}
            onArm={(i) => {
              setArmed(i);
              setRestoreError(null);
            }}
            onCancel={() => setArmed(null)}
            onConfirm={
              onRestore &&
              (async (version) => {
                setBusy(true);
                setRestoreError(null);
                try {
                  await onRestore({ collection, id: recordId, version });
                  setArmed(null);
                  // The archive has a new head now: this version is live and
                  // the one that beat it has become "overwritten". Re-reading
                  // is what makes the claim in the confirmation copy visible
                  // rather than merely asserted.
                  refresh();
                } catch (e) {
                  setRestoreError(e instanceof Error ? e.message : String(e));
                } finally {
                  setBusy(false);
                }
              })
            }
          />
        )}
      </div>
    </Card>
  );
}

/* ── the three answers ──────────────────────────────────────────────────── */

/**
 * In flight. Deliberately not a bare spinner: a spinner that never resolves is
 * the exact silent failure this project exists to remove, so the state says
 * what it is doing in words as well as in motion.
 */
function Loading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent shadow-[0_0_6px_var(--color-accent)]" />
        <span className="text-[12px] text-fg-dim">Reading the archive…</span>
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-11 animate-pulse rounded-sm border-[0.5px] border-line bg-subtle/40" />
        <div className="h-11 animate-pulse rounded-sm border-[0.5px] border-line bg-subtle/25" />
      </div>
    </div>
  );
}

/**
 * Failed. Must never be mistakable for "no conflicts" — that mistake is the
 * whole bug class, so the difference is stated in words and not left to the
 * colour of a border.
 */
function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const api = error instanceof SyncApiError ? error : undefined;
  const message = error instanceof Error ? error.message : String(error);

  return (
    <div
      role="alert"
      className="rounded-sm border-[0.5px] border-l-2 border-line bg-card/60 px-3.5 py-3"
      style={{ borderLeftColor: "var(--color-bad)" }}
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert
          size={14}
          strokeWidth={2}
          className="mt-0.5 shrink-0"
          style={{ color: "var(--color-bad)" }}
        />
        <div className="min-w-0 flex-1">
          <p className="text-[12.5px] font-semibold" style={{ color: "var(--color-bad)" }}>
            Could not read the history
          </p>
          <p className="mt-1 break-words text-[11.5px] leading-relaxed text-fg-dim">{message}</p>
          {api?.why && (
            <p className="mt-1 break-words text-[11.5px] leading-relaxed text-fg-muted">
              {api.why}
            </p>
          )}
          {api?.fix && (
            <code className="nums mt-2 inline-block rounded-xs border-[0.5px] border-line bg-bg px-2 py-1 text-[11px] text-accent-lt">
              {api.fix}
            </code>
          )}
          <p className="mt-2.5 text-[11px] leading-relaxed text-fg-muted">
            This is <span className="font-semibold text-fg-dim">not</span> the same as “nothing has
            overwritten this record”. Nothing has been checked.
          </p>
          <Button
            variant="subtle"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={onRetry}
            // `sm` is 36px, under this repo's 44px floor for fingers. See the
            // note in ui/CopyButton.tsx: the question is the input device, not
            // the screen width.
            className="mt-3 pointer-coarse:min-h-[44px]"
          >
            Try again
          </Button>
        </div>
      </div>
    </div>
  );
}

function Ready({
  history,
  limit,
  open,
  armed,
  busy,
  restoreError,
  onToggle,
  onArm,
  onCancel,
  onConfirm,
}: {
  history: SyncHistory;
  limit: number;
  open: number | null;
  armed: number | null;
  busy: boolean;
  restoreError: string | null;
  onToggle: (index: number) => void;
  onArm: (index: number) => void;
  onCancel: () => void;
  onConfirm?: (version: SyncVersion) => Promise<void>;
}) {
  const { versions, live, truncated } = archiveOf(history.versions, limit);

  if (versions.length === 0) {
    return (
      <EmptyState
        title="Only ever one version"
        icon={<History size={22} strokeWidth={1.6} />}
        hint="Nothing has overwritten this record. If two devices ever edit it while apart, the losing version is kept here — with the device that replaced it, and a way to put it back."
      />
    );
  }

  const overwritten = versions.filter((v) => v.role === "superseded").length;
  const refused = versions.filter((v) => v.role === "refused").length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-1.5">
        {live ? (
          <Chip color="var(--color-good)" dot>
            1 live
          </Chip>
        ) : (
          <Chip color="var(--color-fg-muted)">no live version here</Chip>
        )}
        {overwritten > 0 && <Chip color="var(--color-warn)">{overwritten} overwritten</Chip>}
        {refused > 0 && <Chip color="var(--color-bad)">{refused} never landed</Chip>}
      </div>

      {/* Two honest limits of the window, rather than a list that quietly
          implies it is the whole story. */}
      {!live && (
        <Note tone="var(--color-warn)">
          The live version is not in this window — it is older than the newest {versions.length}{" "}
          shown, so none of these is the copy your devices hold.
        </Note>
      )}
      {truncated && (
        <Note tone="var(--color-fg-muted)">
          Showing the newest {versions.length}. Older versions exist behind this window.
        </Note>
      )}

      <Stagger className="flex flex-col gap-2">
        {versions.map((v, i) => (
          <Reveal key={`${v.hlc}:${v.outcome}:${i}`}>
            <VersionRow
              version={v}
              live={live}
              expanded={open === i}
              armed={armed === i}
              busy={busy}
              restoreError={armed === i ? restoreError : null}
              onToggle={() => onToggle(i)}
              onArm={() => onArm(i)}
              onCancel={onCancel}
              onConfirm={onConfirm}
            />
          </Reveal>
        ))}
      </Stagger>
    </div>
  );
}

function Note({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <p
      className="rounded-xs border-[0.5px] border-l-2 border-hairline bg-bg/40 px-2.5 py-2 text-[11px] leading-relaxed text-fg-muted"
      style={{ borderLeftColor: tone }}
    >
      {children}
    </p>
  );
}

/* ── one version ────────────────────────────────────────────────────────── */

function VersionRow({
  version,
  live,
  expanded,
  armed,
  busy,
  restoreError,
  onToggle,
  onArm,
  onCancel,
  onConfirm,
}: {
  version: ArchivedVersion;
  live: ArchivedVersion | undefined;
  expanded: boolean;
  armed: boolean;
  busy: boolean;
  restoreError: string | null;
  onToggle: () => void;
  onArm: () => void;
  onCancel: () => void;
  onConfirm?: (version: SyncVersion) => Promise<void>;
}) {
  const role = ROLE[version.role];
  const isLive = version.role === "live";
  // A tombstone has no body to push back, and "restore a deletion" is a delete
  // dressed up as an undo. Refused elsewhere rather than explained away here.
  const restorable = !isLive && !version.deleted && version.body !== null;

  return (
    <div
      className={cn(
        "rounded-sm border-[0.5px] border-l-2 border-line shadow-card transition-colors",
        isLive ? "bg-card-hover" : "bg-card",
      )}
      style={{ borderLeftColor: role.colour }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex min-h-[44px] w-full items-start gap-3 px-3.5 py-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <Chip color={role.colour} dot={isLive}>
              {role.word}
            </Chip>
            {version.deleted && (
              <Chip color="var(--color-fg-muted)">
                <Trash2 size={9} strokeWidth={2.4} />
                deleted
              </Chip>
            )}
            <span
              className={cn("text-[12.5px]", isLive ? "font-semibold text-fg" : "text-fg-dim")}
            >
              {version.device_name}
            </span>
            <span className="nums text-[11px] text-fg-muted">at {dayClock(version.ts)}</span>
          </div>

          {/* The sentence this whole surface was built to be able to say. */}
          {!isLive && live && (
            <p className="mt-1.5 text-[12px] leading-relaxed text-fg-dim">
              {version.role === "superseded" ? "Replaced by " : "Already behind "}
              <span className="font-semibold text-fg">{live.device_name}</span> at{" "}
              <span className="nums">{dayClock(live.ts)}</span>.
            </p>
          )}
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">{role.hint}</p>
        </div>

        <ChevronDown
          size={14}
          aria-hidden
          className={cn(
            "mt-1 shrink-0 text-fg-muted transition-transform duration-200 ease-[var(--ease-signature)]",
            expanded && "rotate-180",
          )}
        />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="border-t-[0.5px] border-hairline px-3.5 py-3">
              <Detail
                version={version}
                live={live}
                armed={armed}
                busy={busy}
                restorable={restorable}
                restoreError={restoreError}
                onArm={onArm}
                onCancel={onCancel}
                onConfirm={onConfirm}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Detail({
  version,
  live,
  armed,
  busy,
  restorable,
  restoreError,
  onArm,
  onCancel,
  onConfirm,
}: {
  version: ArchivedVersion;
  live: ArchivedVersion | undefined;
  armed: boolean;
  busy: boolean;
  restorable: boolean;
  restoreError: string | null;
  onArm: () => void;
  onCancel: () => void;
  onConfirm?: (version: SyncVersion) => Promise<void>;
}) {
  const isLive = version.role === "live";
  const diff = !isLive && live ? diffBodies(live.body, version.body) : undefined;
  const changed = diff?.fields.filter((f) => f.changed) ?? [];
  const identical = (diff?.fields.length ?? 0) - changed.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <Meta label="clock">{version.hlc}</Meta>
        <Meta label="device id">{version.device_id}</Meta>
        <Meta label="outcome">{version.outcome}</Meta>
      </div>

      {version.deleted ? (
        <Note tone="var(--color-fg-muted)">
          This version is a deletion, so there is no body to put back. Restoring it would delete the
          record again rather than undo anything.
        </Note>
      ) : diff ? (
        <div>
          <div className="label mb-2">
            {changed.length > 0 ? `${changed.length} field${changed.length === 1 ? "" : "s"} differ from live` : "identical to the live version"}
          </div>
          {changed.length === 0 ? (
            <Note tone="var(--color-good)">
              Nothing was lost: this version's body matches the one that is live. The two devices
              agreed on the content and only the clock decided the order.
            </Note>
          ) : (
            <div className="flex flex-col gap-2">
              {changed.map((f) => (
                <div
                  key={f.key}
                  className="rounded-xs border-[0.5px] border-hairline bg-bg/50 px-2.5 py-2"
                >
                  <div className="label mb-1.5">{diff.byField ? f.key : "whole body"}</div>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    <Side tag="live now" colour="var(--color-good)" value={f.live} />
                    <Side tag="this version" colour={ROLE[version.role].colour} value={f.version} />
                  </div>
                </div>
              ))}
              {identical > 0 && (
                <p className="text-[10.5px] text-fg-muted">
                  {identical} other field{identical === 1 ? "" : "s"} identical.
                </p>
              )}
            </div>
          )}
        </div>
      ) : null}

      {/* The body in full, always, not behind another tap: a restore is only an
          informed choice if the thing being restored is on screen. */}
      {!version.deleted && (
        <div>
          <div className="label mb-1.5">{isLive ? "live body" : "this version's body"}</div>
          <pre className="nums max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-xs border-[0.5px] border-hairline bg-bg px-2.5 py-2 text-[11px] leading-relaxed text-fg-dim">
            {stableJson(version.body, 2)}
          </pre>
        </div>
      )}

      {restorable && onConfirm && (
        <div className="border-t-[0.5px] border-hairline pt-3">
          {armed ? (
            <div className="rounded-sm border-[0.5px] border-line-active bg-accent/5 p-3">
              <p className="text-[12px] leading-relaxed text-fg-dim">
                This pushes this body back as a <span className="font-semibold text-fg">new</span>{" "}
                version, from this device, now. Nothing is erased
                {live ? ` — ${live.device_name}'s current version` : " — the current version"} stays
                in this archive and will lose to this one, exactly as any ordinary edit would.
              </p>
              {restoreError && (
                <p
                  role="alert"
                  className="mt-2 break-words text-[11.5px]"
                  style={{ color: "var(--color-bad)" }}
                >
                  The push failed: {restoreError}
                </p>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Button
                  variant="primary"
                  icon={<Undo2 size={13} />}
                  disabled={busy}
                  onClick={() => void onConfirm(version)}
                >
                  {busy ? "Pushing…" : "Push this version"}
                </Button>
                <Button variant="ghost" disabled={busy} onClick={onCancel}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            // Two taps, not one. The first only explains; nothing is sent
            // until the second, and the explanation is what sits between them.
            <Button variant="subtle" icon={<RotateCcw size={13} />} onClick={onArm}>
              Restore this version…
            </Button>
          )}
        </div>
      )}

      {restorable && !onConfirm && (
        <p className="text-[11px] leading-relaxed text-fg-muted">
          Restoring is unavailable here — this archive was placed without a write path, and it will
          not invent one.
        </p>
      )}
    </div>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="label">{label}</span>
      <span className="nums truncate text-[10.5px] text-fg-dim">{children}</span>
    </span>
  );
}

function Side({
  tag,
  colour,
  value,
}: {
  tag: string;
  colour: string;
  value: string | undefined;
}) {
  return (
    <div className="min-w-0">
      <div className="mb-1 text-[9.5px] font-semibold uppercase tracking-[0.18em]" style={{ color: colour }}>
        {tag}
      </div>
      <pre
        className={cn(
          "nums max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xs border-[0.5px] border-hairline bg-bg px-2 py-1.5 text-[11px] leading-relaxed",
          value === undefined ? "italic text-fg-muted" : "text-fg-dim",
        )}
      >
        {/* Absent is not the same as empty, and not the same as null. */}
        {value === undefined ? "field absent" : value}
      </pre>
    </div>
  );
}
