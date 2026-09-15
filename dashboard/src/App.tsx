/**
 * App shell — two halves that share a tailnet and a SQLite file.
 *
 *   Clip / Drop / Notes  → the device hub (read/write, ADR-0003)
 *   Train                → training telemetry (read-only)
 *
 * Atmosphere is composed here: a sidebar in landscape, a bottom tab bar in
 * portrait, a keyed directional page transition, and film grain over
 * everything without ever blocking input.
 *
 * The auth gate and the workspace are deliberately two components rather than
 * one with conditional JSX. `Workspace` owns the data hooks, so while we are
 * unauthenticated it is not mounted and those hooks never run — otherwise the
 * login screen would sit in front of a `useLiveState` and a `useHub` politely
 * re-polling a server that is 401ing them, every fifteen seconds, forever.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { WifiOff } from "lucide-react";
import { AccountPill, BottomBar, SCREENS, Sidebar, type Screen } from "@/components/Nav";
import { RunPicker } from "@/components/RunPicker";
import { startNexusSync, type NexusSync } from "@/lib/nexus/bridge";
import { BrainScreen } from "@/screens/Brain";
import { CaptureScreen } from "@/screens/Capture";
import { CareerScreen } from "@/screens/Career";
import { CoursesScreen } from "@/screens/Courses";
import { HomeScreen } from "@/screens/Home";
import { LearnScreen } from "@/screens/Learn";
import { ProjectsScreen } from "@/screens/Projects";
import { ResearchScreen } from "@/screens/Research";
import { InstallHint, Login, OpenNotice } from "@/screens/Login";
import { Train } from "@/screens/Train";
import { useLiveState } from "@/lib/api";
import { logout } from "@/lib/auth";
import { deviceName, setDeviceName, useHub } from "@/lib/hub";
import { dismissInstallHint, shouldShowInstallHint } from "@/lib/pwa";
import { useAuth, useSystem } from "@/lib/hooks";

export default function App() {
  const { auth, reachable, refresh: refreshAuth } = useAuth();
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  // Evaluated once at mount: the answer cannot change within a session, and
  // re-checking would make the banner flicker on a re-render.
  const [showInstall, setShowInstall] = useState(() => shouldShowInstallHint());

  const signOut = useCallback(async () => {
    // Await the server call before flipping the UI. A local-only sign-out
    // would show "signed out" while the cookie stayed live and usable, which
    // is the most reassuring possible way to not be logged out.
    try {
      await logout();
    } finally {
      await refreshAuth();
    }
  }, [refreshAuth]);

  // Boot: no verdict has arrived yet. Distinguish "still asking" from "cannot
  // ask" — a login form in front of an unreachable server invites someone to
  // type a password at a box that cannot check it.
  if (auth.status === "unknown") {
    return (
      <div className="relative h-full w-full text-fg">
        <Boot connection={reachable ? "connecting" : "offline"} />
      </div>
    );
  }

  if (auth.status === "anonymous") {
    return (
      <div className="relative h-full w-full text-fg">
        <Login onSignedIn={refreshAuth} />
      </div>
    );
  }

  // "open" (nothing enrolled, open on the tailnet) and "signed-in" both get
  // the app. The difference is the banner, which says the posture out loud
  // instead of leaving it invisible.
  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden text-fg">
      {auth.status === "open" && !noticeDismissed && (
        <OpenNotice onDismiss={() => setNoticeDismissed(true)} />
      )}
      {showInstall && (
        <InstallHint
          onDismiss={() => {
            dismissInstallHint();
            setShowInstall(false);
          }}
        />
      )}
      <Workspace
        identity={auth.status === "signed-in" ? auth.name : null}
        onSignOut={signOut}
      />
    </div>
  );
}

function Workspace({
  identity,
  onSignOut,
}: {
  identity: string | null;
  onSignOut: () => void;
}) {
  const [screen, setScreen] = useState<Screen>("home");
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [device, setDevice] = useState(() => deviceName());

  const { hub, connection: hubConn, refresh: refreshHub } = useHub();
  const { state, connection: trainConn } = useLiveState(runId);
  const system = useSystem();

  // Boot the local-first store and wire sync to it — here, inside Workspace,
  // because Workspace only mounts once past the auth gate. Started any earlier
  // and every cycle would 401 against an enrolled hub, on a timer, forever.
  //
  // `startNexusSync` and not `load()` plus `createNexusSync`: the two steps
  // share `cacheHit`, and a caller that splits them has to carry that boolean
  // between them. The value someone defaults when they forget is the
  // tombstone catastrophe — an evicted device concluding the whole dataset was
  // deleted and pushing a tombstone for every record. See the bridge.
  //
  // Nothing called this until now, which meant `useData.data` stayed null and
  // every ported slice threw on `s.data!.x`. The screens were built; the app
  // never turned them on.
  useEffect(() => {
    let sync: NexusSync | undefined;
    let cancelled = false;
    void startNexusSync({ label: { name: deviceName(), platform: navigator.userAgent } }).then(
      (s) => {
        if (cancelled) s.stop();
        else sync = s;
      },
    );
    return () => {
      cancelled = true;
      sync?.stop();
    };
  }, []);

  // Direction for the page transition: which way did we travel through the nav?
  const index = SCREENS.findIndex((s) => s.id === screen);
  const prev = useRef(index);
  const dir = index >= prev.current ? 1 : -1;
  useEffect(() => {
    prev.current = index;
  }, [index]);

  // The tab title is the fastest status check on the desk Mac.
  useEffect(() => {
    const v = state?.status;
    document.title = v && v !== "no-run" ? `${v} · trainwatch` : "trainwatch";
  }, [state?.status]);

  const renameDevice = () => {
    const next = window.prompt("Name this device", device);
    if (next?.trim()) {
      setDeviceName(next);
      setDevice(deviceName());
      refreshHub();
    }
  };

  // Keyed on the nav's ids, and `drop` is no longer one of them — it is a
  // panel inside `brain` now. Both counts therefore roll up to `brain`, which
  // is the only place a badge can still be seen: a badge on a screen the nav
  // does not render is a badge nobody will ever read.
  const unopenedLinks = hub?.links.filter((l) => !l.opened_at).length ?? 0;
  const runEvents = state?.events.filter((e) => e.level !== "info").length ?? 0;
  const badges: Partial<Record<Screen, number>> = {
    brain: runEvents + unopenedLinks,
  };
  const brainBadges = { drop: unopenedLinks };

  // The hub is the half you interact with, so its connection drives the chip;
  // the training stream only matters while a run exists.
  const connection = screen === "brain" ? trainConn : hubConn;

  const runPicker = state ? (
    <RunPicker runs={state.runs} selected={state.run} onSelect={setRunId} />
  ) : null;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <Sidebar
        screen={screen}
        onChange={setScreen}
        connection={connection}
        badges={badges}
        hostname={system?.hostname}
        device={device}
        onRenameDevice={renameDevice}
        peers={(hub?.devices ?? []).map((d) => ({ name: d.name, online: d.online }))}
        identity={identity}
        onSignOut={onSignOut}
      />

      <main className="relative flex-1 overflow-hidden">
        <div
          key={screen}
          className={`relative z-10 h-full overflow-y-auto ${
            dir >= 0 ? "page-in-fwd" : "page-in-back"
          }`}
        >
          {/* `state` and `connection` are passed down rather than let Home call
              `useLiveState` itself: that would be a second EventSource for one
              page, and a browser allows six per origin — `api.ts` records that
              exhausting them stops the whole dashboard loading. */}
          {screen === "home" && (
            <HomeScreen onOpen={setScreen} state={state} connection={trainConn} />
          )}
          {screen === "capture" && <CaptureScreen />}
          {screen === "courses" && <CoursesScreen />}
          {screen === "projects" && <ProjectsScreen />}
          {screen === "research" && <ResearchScreen />}
          {screen === "learn" && <LearnScreen />}
          {screen === "career" && <CareerScreen />}
          {screen === "brain" && (
            <BrainScreen
              hub={hub}
              refresh={refreshHub}
              badges={brainBadges}
              status={
                state ? <Train state={state} actions={runPicker} /> : <Boot connection={trainConn} />
              }
            />
          )}
        </div>
      </main>

      {/* Portrait has no sidebar, so sign-out and device-rename would
          otherwise be unreachable with a thumb. */}
      <AccountPill
        identity={identity}
        device={device}
        onRenameDevice={renameDevice}
        onSignOut={onSignOut}
      />

      <BottomBar
        screen={screen}
        onChange={setScreen}
        connection={connection}
        badges={badges}
      />

      {/* Film grain — over everything, never blocks input. */}
      <div
        aria-hidden
        className="grain pointer-events-none absolute inset-0 z-[60] opacity-[0.035] mix-blend-soft-light"
      />
    </div>
  );
}

/** Wordmark + a pulsing accent hairline while the first snapshot lands. */
function Boot({ connection }: { connection: string }) {
  const offline = connection === "offline";
  return (
    <div className="grid h-full place-items-center px-8">
      <div className="flex flex-col items-center gap-5 text-center">
        <div className="display text-[22px] text-fg-dim">trainwatch</div>
        <div className="relative h-px w-40 overflow-hidden bg-line">
          <motion.div
            className="absolute inset-y-0 w-1/3 bg-accent"
            animate={{ x: ["-100%", "300%"] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          />
        </div>
        {offline ? (
          <div className="flex max-w-[38ch] flex-col items-center gap-2">
            <WifiOff size={16} className="text-[var(--color-bad)]" />
            <p className="text-[12px] leading-relaxed text-fg-muted">
              Can&apos;t reach the box. Check Tailscale is up on both devices — and remember the
              real test is loading this over cellular with wifi off.
            </p>
          </div>
        ) : (
          <p className="label">connecting</p>
        )}
      </div>
    </div>
  );
}
