import { useCallback, useEffect, useRef, useState } from "react";
import { onUnauthorized, stateFrom, whoami, type AuthState } from "./auth";
import { fetchGpu, fetchGroups, fetchSeries, fetchSystem, type Gpu, type Series, type SystemInfo } from "./api";

/**
 * Metric series for a run.
 *
 * Kept out of the SSE payload deliberately: series are the heavy part, the
 * user only looks at a handful of keys at a time, and re-sending 240 points
 * per key every 2 seconds would be wasteful on a cellular link. Polled on its
 * own slower cadence while the run is live.
 */
export function useSeries(
  runId: string | undefined,
  keys: string[],
  { live = false, points = 240, intervalMs = 5000 } = {},
) {
  const [series, setSeries] = useState<Series>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyStr = keys.join(",");

  useEffect(() => {
    if (!runId || keys.length === 0) {
      setSeries({});
      setError(null);
      return;
    }
    let cancelled = false;
    // One controller per in-flight request. The old `cancelled` flag only
    // guarded across effect re-runs, so two polls from the SAME run could
    // overlap on a slow link and the older response could land last —
    // rewinding the chart to an earlier tail.
    let inflight: AbortController | null = null;

    const load = async () => {
      inflight?.abort();
      const ctl = new AbortController();
      inflight = ctl;
      try {
        const s = await fetchSeries(runId, keyStr.split(","), points, ctl.signal);
        if (!cancelled && !ctl.signal.aborted) {
          setSeries(s);
          setError(null);
        }
      } catch (e) {
        if (ctl.signal.aborted) return; // superseded, not a failure
        // Do NOT swallow. /api/runs/{id}/series 404s independently of
        // /api/stream, so "the banner reports connectivity" was never true —
        // the tiles just read "—" with no explanation.
        if (!cancelled) setError(e instanceof Error ? e.message : "series unavailable");
      } finally {
        if (!cancelled && !ctl.signal.aborted) setLoading(false);
      }
    };

    setLoading(true);
    void load();
    if (!live) {
      return () => {
        cancelled = true;
        inflight?.abort();
      };
    }

    const t = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      inflight?.abort();
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, keyStr, live, points, intervalMs]);

  return { series, loading, error };
}

export function useGroups(runId: string | undefined) {
  const [groups, setGroups] = useState<Record<string, string[]>>({});
  useEffect(() => {
    if (!runId) {
      setGroups({});
      return;
    }
    let cancelled = false;
    fetchGroups(runId)
      .then((g) => !cancelled && setGroups(g))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId]);
  return groups;
}

export function useGpuHistory(seconds = 1800, intervalMs = 10000) {
  const [data, setData] = useState<{ latest: Gpu[]; history: Gpu[] }>({ latest: [], history: [] });
  const secRef = useRef(seconds);
  secRef.current = seconds;

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchGpu(secRef.current)
        .then((d) => !cancelled && setData(d))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, [seconds, intervalMs]);

  return data;
}

export function useSystem() {
  const [system, setSystem] = useState<SystemInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetchSystem()
        .then((s) => !cancelled && setSystem(s))
        .catch(() => undefined);
    void load();
    const t = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(t);
    };
  }, []);
  return system;
}

/**
 * Who we are, resolved once at boot and again whenever the server says 401.
 *
 * `reachable` is separate from the auth state on purpose. If /whoami cannot
 * be reached at all, the honest answer is not "logged out" — it is "we do not
 * know", and showing a login form for a server that is down invites someone
 * to type a password at a box that cannot check it. Absence of evidence must
 * not render as a verdict, which is the same rule the rest of this project
 * runs on.
 */
export function useAuth() {
  const [auth, setAuth] = useState<AuthState>({ status: "unknown" });
  const [reachable, setReachable] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setAuth(stateFrom(await whoami()));
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // A session can die under an open screen — expiry, revocation from the
  // CLI, or a server restart. Every fetch path reports a 401 here, so the
  // shell flips to the login form exactly once no matter how many requests
  // were in flight when it happened.
  useEffect(() => onUnauthorized(() => setAuth({ status: "anonymous" })), []);

  // Safari suspends a backgrounded tab, so a session can expire while the app
  // is not running and the first thing the user sees on return is a screen of
  // stale numbers. Re-probing on return costs one request.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  return { auth, reachable, refresh };
}
