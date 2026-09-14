/**
 * Navigation, in two forms.
 *
 * Landscape iPad (>=1024px) gets a sidebar; portrait gets a bottom tab bar,
 * because that is where thumbs are — a sidebar in portrait puts the primary
 * control at the far top-left of a 12-inch slab.
 *
 * Four slots, not seven: the hub is what you open constantly, monitoring is
 * what you open when a run is going, so Watch/Metrics/Machine/Alerts collapse
 * into tabs inside `Train` rather than competing for a thumb target.
 *
 * Both trees exist in the DOM at once (hidden by CSS, not unmounted), hence
 * two distinct layoutIds for the sliding indicator.
 */
import { useState } from "react";
import { motion } from "framer-motion";
import { Activity, ClipboardList, FileText, LogOut, PencilLine, Send, UserRound } from "lucide-react";
import { cn } from "@/lib/cn";
import type { Connection } from "@/lib/api";

export type Screen = "clip" | "drop" | "notes" | "train";

export const SCREENS: { id: Screen; label: string; icon: typeof Activity }[] = [
  { id: "clip", label: "Clip", icon: ClipboardList },
  { id: "drop", label: "Drop", icon: Send },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "train", label: "Train", icon: Activity },
];

const CONN: Record<Connection, { text: string; color: string }> = {
  live: { text: "live", color: "var(--color-good)" },
  connecting: { text: "connecting", color: "var(--color-warn)" },
  offline: { text: "offline", color: "var(--color-bad)" },
};

interface NavProps {
  screen: Screen;
  onChange: (s: Screen) => void;
  connection: Connection;
  badges?: Partial<Record<Screen, number>>;
}

export function Sidebar({
  screen,
  onChange,
  connection,
  badges,
  hostname,
  device,
  onRenameDevice,
  peers,
  identity,
  onSignOut,
}: NavProps & {
  hostname?: string;
  device: string;
  onRenameDevice: () => void;
  peers: { name: string; online: boolean }[];
  /** null when the instance has no accounts enrolled — nothing to sign out of. */
  identity: string | null;
  onSignOut: () => void;
}) {
  const conn = CONN[connection];
  return (
    <aside className="safe-l hidden w-[var(--spacing-sidebar)] shrink-0 flex-col border-r-[0.5px] border-line bg-panel/80 backdrop-blur-xl lg:flex">
      <div className="px-5 pb-6 pt-[max(env(safe-area-inset-top),1.75rem)]">
        <div className="display text-[17px] leading-none text-fg">trainwatch</div>
        <div className="label mt-2 text-accent-dim">{hostname ?? "tailnet"}</div>
      </div>

      <nav className="flex flex-col gap-1 px-3">
        {SCREENS.map((s) => {
          const on = s.id === screen;
          const Icon = s.icon;
          const badge = badges?.[s.id] ?? 0;
          return (
            <button
              key={s.id}
              onClick={() => onChange(s.id)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "group/nav relative flex items-center gap-3 rounded-sm px-3 py-2.5 text-[12.5px] font-medium",
                "transition-colors duration-150 ease-[var(--ease-signature)] active:scale-[0.98]",
                on ? "text-accent-lt" : "text-fg-muted hover:text-fg-dim",
              )}
            >
              {on && (
                <motion.span
                  layoutId="nav-active-side"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="absolute inset-0 -z-0 rounded-sm border-[0.5px] border-line-active bg-accent/10 shadow-[var(--shadow-glow)]"
                />
              )}
              <span
                className={cn(
                  "relative z-10 grid h-6 w-6 place-items-center rounded-xs border-[0.5px]",
                  on ? "border-line-active bg-accent/10" : "border-hairline",
                )}
              >
                <Icon size={13} strokeWidth={1.9} />
              </span>
              <span className="relative z-10">{s.label}</span>
              {badge > 0 && (
                <span className="nums relative z-10 ml-auto rounded-full bg-[color-mix(in_srgb,var(--color-bad)_18%,transparent)] px-1.5 py-0.5 text-[10px] text-[var(--color-bad)]">
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* Who else is on the hub. Presence is what makes "push to a device"
          make sense — otherwise you are naming something you cannot see. */}
      {peers.length > 0 && (
        <div className="mt-6 flex flex-col gap-1.5 px-5">
          <div className="label">devices</div>
          {peers.slice(0, 6).map((p) => (
            <div key={p.name} className="flex items-center gap-2">
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  background: p.online ? "var(--color-good)" : "var(--color-neutral-300)",
                  boxShadow: p.online ? "0 0 6px var(--color-good)" : "none",
                }}
              />
              <span
                className={cn(
                  "truncate text-[11.5px]",
                  p.name === device ? "text-fg-dim" : "text-fg-muted",
                )}
              >
                {p.name}
                {p.name === device && <span className="text-fg-muted"> (this)</span>}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto border-t-[0.5px] border-line px-5 pt-4 pb-[max(env(safe-area-inset-bottom),1rem)]">
        {/* Sign out calls the server. Sessions are server-side and revocable,
            so clearing only local state would leave a live, usable cookie —
            a logout that logs nothing out. */}
        {identity && (
          <div className="mb-3 flex items-center justify-between gap-2 border-b-[0.5px] border-hairline pb-3">
            <span className="flex min-w-0 items-center gap-1.5">
              <UserRound size={11} className="shrink-0 text-fg-muted" />
              <span className="truncate text-[11px] text-fg-dim">{identity}</span>
            </span>
            <button
              onClick={onSignOut}
              title="Sign out"
              aria-label="Sign out"
              className="shrink-0 p-1 text-fg-muted transition-colors hover:text-[var(--color-bad)]"
            >
              <LogOut size={12} />
            </button>
          </div>
        )}
        <button
          onClick={onRenameDevice}
          className="mb-2 block max-w-full truncate text-left text-[11px] text-fg-muted transition-colors hover:text-fg-dim"
          title="Rename this device"
        >
          this device: <span className="text-fg-dim">{device}</span>
        </button>
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: conn.color, boxShadow: `0 0 6px ${conn.color}` }}
          />
          <span className="label" style={{ color: conn.color }}>
            {conn.text}
          </span>
        </div>
      </div>
    </aside>
  );
}

export function BottomBar({ screen, onChange, connection, badges }: NavProps) {
  const conn = CONN[connection];
  return (
    <nav className="safe-b fixed inset-x-0 bottom-0 z-40 border-t-[0.5px] border-line bg-panel/90 backdrop-blur-xl lg:hidden">
      <div className="mx-auto flex max-w-[560px] items-stretch justify-around px-2 pt-1">
        {SCREENS.map((s) => {
          const on = s.id === screen;
          const Icon = s.icon;
          const badge = badges?.[s.id] ?? 0;
          return (
            <button
              key={s.id}
              onClick={() => onChange(s.id)}
              aria-current={on ? "page" : undefined}
              className={cn(
                "relative flex min-h-[54px] flex-1 flex-col items-center justify-center gap-1 rounded-sm px-2 py-1.5",
                "transition-colors duration-150 active:scale-[0.94]",
                on ? "text-accent-lt" : "text-fg-muted",
              )}
            >
              {on && (
                <motion.span
                  layoutId="nav-active-bottom"
                  transition={{ type: "spring", stiffness: 380, damping: 32 }}
                  className="absolute inset-x-1 inset-y-0.5 -z-0 rounded-sm border-[0.5px] border-line-active bg-accent/10"
                />
              )}
              <span className="relative z-10">
                <Icon size={17} strokeWidth={1.9} />
                {badge > 0 && (
                  <span
                    className="absolute -right-1.5 -top-1 h-2 w-2 rounded-full"
                    style={{ background: "var(--color-bad)", boxShadow: "0 0 6px var(--color-bad)" }}
                  />
                )}
              </span>
              <span className="relative z-10 text-[9.5px] font-semibold uppercase tracking-[0.12em]">
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
      <div className="flex items-center justify-center gap-1.5 pb-1">
        <span className="h-1 w-1 rounded-full" style={{ background: conn.color }} />
        <span className="label text-[8.5px]" style={{ color: conn.color }}>
          {conn.text}
        </span>
      </div>
    </nav>
  );
}

/**
 * Account controls for portrait, where there is no sidebar.
 *
 * Sign-out and device-rename both lived only in the sidebar, which is
 * `hidden ... lg:flex` — so on the iPhone and the Realme they did not exist
 * at all. That is the same class of defect as the `hover:`-only controls the
 * plan calls out: an action that is present in the code and unreachable with
 * a thumb is an action the app does not have.
 *
 * Floated clear of the tab bar rather than added to it. The bar has four
 * slots chosen deliberately, and ScreenShell already reserves 104px of
 * bottom padding, so this sits over empty space instead of over content.
 */
export function AccountPill({
  identity,
  device,
  onRenameDevice,
  onSignOut,
}: {
  identity: string | null;
  device: string;
  onRenameDevice: () => void;
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      {open && (
        <>
          {/* Tap-away, and it must be under the sheet but over everything
              else — z-40 is the tab bar, so 44/45 rather than the grain's 60. */}
          <button
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[44] bg-bg/60 backdrop-blur-sm"
          />
          <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+118px)] right-4 z-[45] w-[216px] overflow-hidden rounded-sm border-[0.5px] border-line bg-panel/95 shadow-[var(--shadow-pop)] backdrop-blur-xl">
            {identity && (
              <div className="border-b-[0.5px] border-hairline px-3.5 py-2.5">
                <div className="label mb-0.5">signed in as</div>
                <div className="truncate text-[12px] text-fg-dim">{identity}</div>
              </div>
            )}
            <button
              onClick={() => {
                setOpen(false);
                onRenameDevice();
              }}
              className="flex min-h-[44px] w-full items-center gap-2.5 px-3.5 text-left text-[12px] text-fg-dim transition-colors active:bg-card-hover"
            >
              <PencilLine size={12} className="shrink-0 text-fg-muted" />
              <span className="truncate">
                rename <span className="text-fg-muted">({device})</span>
              </span>
            </button>
            {identity && (
              <button
                onClick={() => {
                  setOpen(false);
                  onSignOut();
                }}
                className="flex min-h-[44px] w-full items-center gap-2.5 border-t-[0.5px] border-hairline px-3.5 text-left text-[12px] text-[var(--color-bad)] transition-colors active:bg-card-hover"
              >
                <LogOut size={12} className="shrink-0" />
                sign out
              </button>
            )}
          </div>
        </>
      )}

      <button
        onClick={() => setOpen((o) => !o)}
        aria-label="Account and device"
        aria-expanded={open}
        className={cn(
          "fixed bottom-[calc(env(safe-area-inset-bottom)+66px)] right-4 z-[46]",
          "grid h-11 w-11 place-items-center rounded-full border-[0.5px] border-line",
          "bg-panel/90 text-fg-muted shadow-[var(--shadow-card)] backdrop-blur-xl",
          "transition-all duration-150 ease-[var(--ease-signature)] active:scale-[0.94]",
          open && "border-line-active text-fg",
        )}
      >
        <UserRound size={15} strokeWidth={1.9} />
      </button>
    </div>
  );
}
