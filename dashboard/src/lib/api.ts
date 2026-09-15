/** Types mirroring trainwatch's read-only API, plus the live-state hook. */
import { useCallback, useEffect, useRef, useState } from "react";
import { reportUnauthorized } from "./auth";

export type RunStatus = "running" | "finished" | "failed" | "dead" | "stopped";
export type Verdict =
  | "healthy"
  | "throttled"
  | "stale"
  | "failed"
  | "dead"
  | "finished"
  | "stopped"
  | "no-run";

export interface Run {
  id: string;
  name: string;
  started_at: number;
  ended_at: number | null;
  status: RunStatus;
  last_step: number;
  last_beat: number | null;
  meta: Record<string, unknown>;
}

export interface TwEvent {
  id: number;
  run_id: string | null;
  ts: number;
  level: "info" | "warn" | "critical";
  rule: string;
  title: string;
  body: string;
  step: number | null;
  notified: number;
}

export interface Gpu {
  ts: number;
  gpu_index: number;
  name: string;
  util: number | null;
  mem_used: number | null;
  mem_total: number | null;
  temp: number | null;
  power: number | null;
  clock_sm: number | null;
  throttle: string;
}

export interface Heartbeat {
  ts: number;
  age: number;
  timeout: number;
}

export interface State {
  now: number;
  version: string;
  run: Run | null;
  runs: Run[];
  events: TwEvent[];
  gpu: Gpu[];
  heartbeat: Heartbeat | null;
  status: Verdict;
  metric_keys: string[];
  headline: Record<string, number>;
  throttled: boolean;
  notify: { enabled: boolean; server: string };
}

export interface SystemInfo {
  hostname: string;
  tmux: { name: string; windows: number; attached: boolean; created: number }[];
  tailscale: string[];
  wsl: boolean;
  heartbeat_path: string;
  db_size: number;
  gpu_sampler: { available: boolean; samples: number; error: string | null };
}

export type Series = Record<string, [number, number][]>;

/** A failed response, with the status as a field rather than only in prose.
 *
 * The message keeps its exact shape, because things already read it. But a
 * caller that needs to branch on the status had to parse it back out with a
 * regex over an error string — which is a contract nobody declared and the
 * next person to improve the wording would silently break. The Research
 * screen's run-link probe does exactly that branch: 404 means "the hub says
 * no such run", anything else means "we could not ask", and confusing those
 * two is the distinction that screen exists to preserve.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export async function getJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: "application/json" } });
  if (!res.ok) {
    // A 401 is not an error this caller can do anything about, and it is not
    // a transient network fault either — the session died under a screen that
    // is already open. Tell the shell once, centrally, so it flips to the
    // login form; otherwise every screen invents its own error state and the
    // ones that swallow errors keep rendering stale numbers as if they were
    // live, which is the failure mode this whole project is about.
    if (res.status === 401) reportUnauthorized();
    throw new HttpError(res.status, `${res.status} ${res.statusText} — ${path}`);
  }
  return (await res.json()) as T;
}

/**
 * Must match MAX_SERIES_KEYS in src/trainwatch/server/app.py. The server
 * truncates past this; we chunk so it never has to.
 */
const SERIES_KEY_CHUNK = 64;

/**
 * Fetch series, splitting into chunks the server will not truncate.
 *
 * Previously this sent every key in one request and the server silently
 * dropped everything past the 64th, so an 80-layer model rendered 16 tiles
 * that read "—" forever — indistinguishable from layers that logged nothing.
 */
export async function fetchSeries(
  runId: string,
  keys: string[],
  points = 240,
  signal?: AbortSignal,
): Promise<Series> {
  const chunks: string[][] = [];
  for (let i = 0; i < keys.length; i += SERIES_KEY_CHUNK) {
    chunks.push(keys.slice(i, i + SERIES_KEY_CHUNK));
  }
  const parts = await Promise.all(
    chunks.map((chunk) =>
      getJSON<{ series: Series }>(
        `/api/runs/${encodeURIComponent(runId)}/series?keys=${encodeURIComponent(
          chunk.join(","),
        )}&points=${points}`,
        signal,
      ).then((r) => r.series),
    ),
  );
  return Object.assign({}, ...parts) as Series;
}

export const fetchGroups = (runId: string) =>
  getJSON<Record<string, string[]>>(`/api/runs/${encodeURIComponent(runId)}/groups`);

export const fetchGpu = (seconds = 1800) =>
  getJSON<{ latest: Gpu[]; history: Gpu[] }>(`/api/gpu?seconds=${seconds}`);

export const fetchSystem = () => getJSON<SystemInfo>("/api/system");

export type Connection = "connecting" | "live" | "offline";

/**
 * Live state over SSE, with a polling fallback and iPad-aware recovery.
 *
 * Safari suspends timers and sockets in a backgrounded tab, so returning to
 * the app can leave a stream that looks open but is dead. We therefore refetch
 * and rebuild the EventSource on `visibilitychange`, rather than trusting
 * EventSource's own reconnect to notice.
 */
export function useLiveState(runId?: string) {
  const [state, setState] = useState<State | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const url = runId ? `/api/stream?run_id=${encodeURIComponent(runId)}` : "/api/stream";
  const snapshotUrl = runId ? `/api/state?run_id=${encodeURIComponent(runId)}` : "/api/state";

  const refresh = useCallback(async () => {
    try {
      setState(await getJSON<State>(snapshotUrl));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [snapshotUrl]);

  const connect = useCallback(() => {
    esRef.current?.close();
    setConnection("connecting");

    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("state", (ev) => {
      try {
        setState(JSON.parse((ev as MessageEvent<string>).data) as State);
        setConnection("live");
        setError(null);
      } catch {
        /* a malformed tick is not worth tearing the stream down */
      }
    });
    es.onerror = () => {
      // EventSource retries on its own; surface the gap without spamming.
      // Must move "connecting" → "offline" too, not just "live" → "offline":
      // on a cold start the state is "connecting", so gating on "live" left it
      // stuck there forever and Boot's "Can't reach the box — check Tailscale"
      // branch was unreachable in exactly the situation it was written for.
      setConnection("offline");
    };
    return es;
  }, [url]);

  useEffect(() => {
    void refresh();
    const es = connect();

    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if (esRef.current?.readyState !== EventSource.OPEN) connect();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Belt and braces: if the stream is wedged, a slow poll keeps the screen
    // honest rather than silently showing a stale run as "healthy".
    const poll = window.setInterval(() => {
      if (esRef.current?.readyState !== EventSource.OPEN) void refresh();
    }, 15000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(poll);
      // Close what is CURRENT, not just the handle captured at setup.
      // onVisible replaces the stream after a background/return, so closing
      // only `es` orphans the live socket — unreferenced and unclosable. Five
      // background + run-switch cycles then exhaust the browser's six
      // connections per origin and the whole dashboard stops loading.
      // close() on an already-closed EventSource is a no-op, so close both.
      es.close();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect, refresh]);

  return { state, connection, error, refresh };
}
