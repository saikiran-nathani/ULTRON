/**
 * Which devices sync, when each last pulled, and how to retire one.
 *
 * The interesting part of this panel is not the list, it is the button. Rule 4:
 * a tombstone may only be dropped once **every** active device has pulled past
 * it, so the collection watermark is `min(last_pull_seq)` across devices that
 * are not retired. A device that is never retired therefore pins that minimum
 * at whatever it last pulled — for ever. A phone replaced in 2027 quietly
 * stops deletions from ever being collectable, and the symptom is a database
 * that grows without a single error anywhere.
 *
 * So retiring is not a tidiness feature and the UI must not present it as one.
 * It says what the watermark is, names the devices sitting on it, and explains
 * what retiring changes — before the second tap, not after it.
 *
 * It is also reversible, and that is worth stating on screen: `Sync.register`
 * clears `retired_at` on every sync, so a retired device that comes back
 * un-retires itself. Retiring the wrong one costs nothing but a sync.
 *
 * The panel fetches its own state. Stage 4 places it; it does not need a
 * parent to feed it, and `onChange` exists only so a parent showing sync
 * status elsewhere can re-read after a retire.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Anchor,
  Laptop,
  Monitor,
  PowerOff,
  RefreshCw,
  Smartphone,
  Tablet,
  TriangleAlert,
} from "lucide-react";
import { Card } from "@/ui/Card";
import { Button, IconButton } from "@/ui/Button";
import { Chip } from "@/ui/Chip";
import { EmptyState } from "@/ui/EmptyState";
import { Stat } from "@/ui/Stat";
import { Reveal, Stagger } from "@/lib/motion";
import { cn } from "@/lib/cn";
import { dayClock, shortDuration } from "@/lib/format";
import {
  SyncApiError,
  syncApi,
  watermarkHolders,
  type SyncDevice,
  type SyncState,
} from "@/lib/syncApi";

type Load =
  | { status: "loading" }
  | { status: "failed"; error: unknown }
  | { status: "ready"; state: SyncState };

export function SyncDevices({
  className,
  onChange,
}: {
  className?: string;
  /** Called after a device is successfully retired. */
  onChange?: () => void;
}) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [reload, setReload] = useState(0);
  const [armed, setArmed] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    setLoad({ status: "loading" });

    syncApi
      .state(ac.signal)
      .then((state) => setLoad({ status: "ready", state }))
      .catch((e: unknown) => {
        // An abort is an unmount, not a failure — see the same note in
        // ConflictArchive.
        if (ac.signal.aborted) return;
        setLoad({ status: "failed", error: e });
      });

    return () => ac.abort();
  }, [reload]);

  const refresh = () => setReload((n) => n + 1);

  const retire = async (device: SyncDevice) => {
    setBusy(device.id);
    setActionError(null);
    try {
      await syncApi.retire(device.id);
      setArmed(null);
      onChange?.();
      // Re-read rather than patching the row locally: retiring moves the
      // watermark, which moves who is holding it, which is the whole point of
      // the panel. A local edit would leave those two facts disagreeing.
      refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card className={cn("overflow-hidden", className)}>
      <header className="flex items-start justify-between gap-3 border-b-[0.5px] border-line px-4 py-3.5">
        <div className="min-w-0">
          <div className="label mb-1.5 flex items-center gap-1.5 text-accent-dim">
            <Anchor size={11} strokeWidth={2.2} />
            sync devices
          </div>
          <div className="display truncate text-[15px] leading-tight text-fg">
            Devices on this account
          </div>
        </div>
        <IconButton
          icon={<RefreshCw size={13} className={cn(load.status === "loading" && "animate-spin")} />}
          label="Reload the device list"
          onClick={refresh}
        />
      </header>

      <div className="p-4">
        {load.status === "loading" && <Loading />}
        {load.status === "failed" && <Failed error={load.error} onRetry={refresh} />}
        {load.status === "ready" && (
          <Ready
            state={load.state}
            armed={armed}
            busy={busy}
            actionError={actionError}
            onArm={(id) => {
              setArmed(id);
              setActionError(null);
            }}
            onCancel={() => setArmed(null)}
            onRetire={retire}
          />
        )}
      </div>
    </Card>
  );
}

/* ── states ─────────────────────────────────────────────────────────────── */

function Loading() {
  return (
    <div role="status" aria-live="polite" className="flex flex-col gap-3 py-2">
      <div className="flex items-center gap-2.5">
        <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-accent shadow-[0_0_6px_var(--color-accent)]" />
        <span className="text-[12px] text-fg-dim">Asking the server which devices sync…</span>
      </div>
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="h-16 animate-pulse rounded-sm border-[0.5px] border-line bg-subtle/40" />
        <div className="h-16 animate-pulse rounded-sm border-[0.5px] border-line bg-subtle/25" />
      </div>
    </div>
  );
}

/**
 * Failed. Distinct in shape and words from "no devices have synced yet": an
 * empty list here would suggest nothing is syncing, which is a very different
 * and much more alarming claim than "we could not ask".
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
            Could not read the device list
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
            This does <span className="font-semibold text-fg-dim">not</span> mean nothing is
            syncing. It means the question went unanswered.
          </p>
          <Button
            variant="subtle"
            size="sm"
            icon={<RefreshCw size={12} />}
            onClick={onRetry}
            // 36px is under the 44px floor for fingers — see ui/CopyButton.tsx.
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
  state,
  armed,
  busy,
  actionError,
  onArm,
  onCancel,
  onRetire,
}: {
  state: SyncState;
  armed: string | null;
  busy: string | null;
  actionError: string | null;
  onArm: (id: string) => void;
  onCancel: () => void;
  onRetire: (device: SyncDevice) => void;
}) {
  const { devices, stats } = state;
  const holders = new Set(watermarkHolders(devices).map((d) => d.id));
  const active = devices.filter((d) => !d.retired).length;
  // The server's own number, not a recomputation: `gc_watermark` has a case
  // this panel cannot see (no active devices at all, where the watermark is
  // the head instead of a minimum).
  const stuck = active > 0 && stats.gc_watermark === 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="records" value={stats.records} size="sm" />
        <Stat
          label="tombstones"
          value={stats.tombstones}
          size="sm"
          color={stats.tombstones > 0 ? "var(--color-warn)" : undefined}
          sub="awaiting collection"
        />
        <Stat label="versions" value={stats.versions} size="sm" sub="archive rows" />
        <Stat label="seq head" value={stats.head} size="sm" />
        <Stat
          label="gc watermark"
          value={stats.gc_watermark}
          size="sm"
          color={stuck ? "var(--color-bad)" : "var(--color-accent)"}
          sub={stuck ? "pinned at zero" : `${active} active device${active === 1 ? "" : "s"}`}
        />
      </div>

      <p
        className="rounded-xs border-[0.5px] border-l-2 border-hairline bg-bg/40 px-2.5 py-2 text-[11.5px] leading-relaxed text-fg-muted"
        style={{ borderLeftColor: "var(--color-accent-dim)" }}
      >
        A deleted record leaves a tombstone, and a tombstone may only be dropped once every active
        device has pulled past it. The watermark is the lowest “last pulled” across devices that are
        not retired — so one device that never comes back holds it there for ever, and the
        tombstones accumulate with nothing on screen to say why.
        {stuck && (
          <>
            {" "}
            <span className="font-semibold" style={{ color: "var(--color-bad)" }}>
              It is at zero right now: an active device has never pulled, so nothing is collectable
              at all.
            </span>
          </>
        )}
      </p>

      {actionError && (
        <p
          role="alert"
          className="break-words rounded-xs border-[0.5px] border-l-2 border-line bg-card/60 px-2.5 py-2 text-[11.5px] leading-relaxed"
          style={{ color: "var(--color-bad)", borderLeftColor: "var(--color-bad)" }}
        >
          Could not retire that device: {actionError}
        </p>
      )}

      {devices.length === 0 ? (
        <EmptyState
          title="No device has synced yet"
          icon={<Smartphone size={22} strokeWidth={1.6} />}
          hint="A device appears here the first time it syncs, named by whatever it sent. Nothing is wrong — there is simply nothing enrolled to sync with."
        />
      ) : (
        <Stagger className="flex flex-col gap-2">
          {devices.map((d) => (
            <Reveal key={d.id}>
              <DeviceRow
                device={d}
                holdsWatermark={holders.has(d.id)}
                armed={armed === d.id}
                busy={busy === d.id}
                onArm={() => onArm(d.id)}
                onCancel={onCancel}
                onRetire={() => onRetire(d)}
              />
            </Reveal>
          ))}
        </Stagger>
      )}
    </div>
  );
}

/* ── one device ─────────────────────────────────────────────────────────── */

/**
 * `platform` is whatever the client put in the query string, so this is
 * decoration and never meaning. Anything unrecognised gets the generic glyph
 * rather than a guess.
 */
function platformIcon(platform: string) {
  const p = platform.toLowerCase();
  if (/ipad|tablet/.test(p)) return Tablet;
  if (/iphone|android|phone|ios/.test(p)) return Smartphone;
  if (/mac|darwin|laptop/.test(p)) return Laptop;
  return Monitor;
}

function DeviceRow({
  device,
  holdsWatermark,
  armed,
  busy,
  onArm,
  onCancel,
  onRetire,
}: {
  device: SyncDevice;
  holdsWatermark: boolean;
  armed: boolean;
  busy: boolean;
  onArm: () => void;
  onCancel: () => void;
  onRetire: () => void;
}) {
  const Icon = platformIcon(device.platform);
  const neverPulled = device.last_pull_seq === 0;
  const idle = Math.max(0, Date.now() / 1000 - device.last_seen);
  // A named device shows its name; an unnamed one falls back to the id rather
  // than to an empty heading.
  const title = device.name || device.id;

  return (
    <div
      className={cn(
        "rounded-sm border-[0.5px] border-l-2 border-line shadow-card",
        device.retired ? "bg-card/50" : "bg-card",
      )}
      style={{
        borderLeftColor: device.retired
          ? "var(--color-neutral-300)"
          : holdsWatermark
            ? "var(--color-warn)"
            : "var(--color-accent-dim)",
      }}
    >
      <div className="flex items-start gap-3 px-3.5 py-3">
        <span
          className={cn(
            "mt-0.5 shrink-0",
            device.retired ? "text-fg-muted/60" : "text-accent-dim",
          )}
        >
          <Icon size={16} strokeWidth={1.8} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
            <span
              className={cn(
                "truncate text-[13px] font-semibold",
                device.retired ? "text-fg-muted" : "text-fg",
              )}
            >
              {title}
            </span>
            {device.platform && (
              <Chip color="var(--color-fg-muted)">{device.platform}</Chip>
            )}
            {device.retired && <Chip color="var(--color-neutral-100)">retired</Chip>}
            {holdsWatermark && !device.retired && (
              <Chip color="var(--color-warn)" dot>
                holding the watermark
              </Chip>
            )}
          </div>

          <div className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <Meta label="last pulled">
              {neverPulled ? "never" : `#${device.last_pull_seq}`}
            </Meta>
            <Meta label="last seen">
              {dayClock(device.last_seen)}
              <span className="text-fg-muted"> · {shortDuration(idle)} ago</span>
            </Meta>
            <Meta label="first seen">{dayClock(device.first_seen)}</Meta>
          </div>

          <div className="nums mt-1 truncate text-[10px] text-fg-muted">{device.id}</div>

          {neverPulled && !device.retired && (
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: "var(--color-warn)" }}>
              This device has never pulled, so it may be holding records it has not reconciled.
              While that is true nothing is collectable at all — the watermark cannot rise above
              zero.
            </p>
          )}

          {device.retired ? (
            <p className="mt-2 text-[11px] leading-relaxed text-fg-muted">
              Retired, so it no longer holds the watermark. Its history is kept, and the next time
              it syncs it un-retires itself.
            </p>
          ) : (
            <div className="mt-2.5">
              <AnimatePresence initial={false} mode="wait">
                {armed ? (
                  <motion.div
                    key="armed"
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="rounded-sm border-[0.5px] border-line-active bg-accent/5 p-3">
                      <p className="text-[12px] leading-relaxed text-fg-dim">
                        Retire <span className="font-semibold text-fg">{title}</span>? It stops
                        counting towards the collection watermark, which lets tombstones below{" "}
                        <span className="nums">#{device.last_pull_seq}</span> be dropped.{" "}
                        <span className="text-fg">Nothing is deleted</span> and nothing is
                        permanent: the device keeps its history, and it un-retires itself the next
                        time it syncs. Only retire a device you do not expect back soon — a device
                        that is still in use will be handed tombstones it has already collected.
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                          variant="danger"
                          icon={<PowerOff size={13} />}
                          disabled={busy}
                          onClick={onRetire}
                        >
                          {busy ? "Retiring…" : `Retire ${title}`}
                        </Button>
                        <Button variant="ghost" disabled={busy} onClick={onCancel}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  </motion.div>
                ) : (
                  <motion.div
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.15 }}
                  >
                    {/* Two taps. The first one only explains. */}
                    <Button variant="subtle" icon={<PowerOff size={13} />} onClick={onArm}>
                      Retire this device…
                    </Button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
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
