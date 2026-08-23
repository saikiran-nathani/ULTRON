/** Device-hub client: shared clipboard, files, links, notes, presence. */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Connection } from "./api";

export interface Clip {
  id: number;
  ts: number;
  kind: "text" | "link";
  body: string;
  preview: string;
  bytes: number;
  device: string;
  pinned: boolean;
  secret: boolean;
  expires_at: number | null;
}

export interface HubFile {
  id: string;
  ts: number;
  name: string;
  size: number;
  mime: string;
  device: string;
  pinned: boolean;
  is_image: boolean;
  expires_at: number | null;
}

export interface HubLink {
  id: number;
  ts: number;
  url: string;
  title: string;
  target: string;
  device: string;
  opened_at: number | null;
}

export interface Note {
  id: string;
  title: string;
  body: string;
  updated_at: number;
  device: string;
}

export interface HubDevice {
  name: string;
  kind: string;
  last_seen: number;
  age: number;
  online: boolean;
  address: string;
}

export interface HubState {
  revision: number;
  clips: Clip[];
  files: HubFile[];
  links: HubLink[];
  notes: Note[];
  devices: HubDevice[];
  stats: Record<string, number>;
  limits: { max_upload: number };
}

/* ── device identity ──────────────────────────────────────────────────────
   The browser cannot know its own Tailscale name, so we derive a sensible
   default from the platform and let it be renamed. Persisted, because
   "who copied this" is only useful if the answer is stable. */

const DEVICE_KEY = "trainwatch.device";

function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const touch = navigator.maxTouchPoints > 1;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && touch)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Macintosh|Mac OS/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/Linux|X11/.test(ua)) return "Linux";
  if (/Windows/.test(ua)) return "Windows";
  return "browser";
}

export function deviceName(): string {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const guess = guessDeviceName();
  localStorage.setItem(DEVICE_KEY, guess);
  return guess;
}

export function setDeviceName(name: string): void {
  localStorage.setItem(DEVICE_KEY, name.trim().slice(0, 48) || guessDeviceName());
}

/* ── requests ─────────────────────────────────────────────────────────── */

/**
 * ADR-0003 C3: writes must carry X-Trainwatch. That makes the request
 * "non-simple", so a browser is forced to preflight it — and we never answer
 * a preflight, which is what stops another origin writing to the hub.
 */
function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "X-Trainwatch": "1",
    "X-Trainwatch-Device": deviceName(),
    ...extra,
  };
}

export class HubError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: headers(init.headers as Record<string, string> | undefined),
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const j = (await res.json()) as { error?: string };
      if (j.error) detail = j.error;
    } catch {
      /* non-JSON error body */
    }
    if (res.status === 421) {
      detail =
        "the server refused this hostname (DNS-rebinding guard). Add it to " +
        "TRAINWATCH_ALLOWED_HOSTS, or use the Tailscale name.";
    }
    throw new HubError(detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const hubApi = {
  get: () => req<HubState>("/api/hub"),
  pushClip: (body: string, opts: { secret?: boolean; pinned?: boolean } = {}) =>
    req<Clip>("/api/clip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, ...opts }),
    }),
  clipBody: async (id: number): Promise<string> => {
    const res = await fetch(`/api/clip/${id}/body`, { headers: headers() });
    if (!res.ok) throw new HubError(`could not read clip ${id}`);
    return res.text();
  },
  inspect: (body: string) =>
    req<{ looks_secret: boolean }>("/api/clips/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    }),
  pinClip: (id: number, pinned: boolean) =>
    req<unknown>(`/api/clip/${id}/pin?pinned=${pinned}`, { method: "POST" }),
  deleteClip: (id: number) => req<void>(`/api/clip/${id}`, { method: "DELETE" }),
  clearClips: () => req<{ deleted: number }>("/api/clips/clear", { method: "POST" }),

  upload: (file: File) => {
    const fd = new FormData();
    fd.append("file", file);
    // No Content-Type: the browser must set the multipart boundary itself.
    return req<HubFile>("/api/files", { method: "POST", body: fd });
  },
  deleteFile: (id: string) => req<void>(`/api/files/${id}`, { method: "DELETE" }),
  pinFile: (id: string, pinned: boolean) =>
    req<unknown>(`/api/files/${id}/pin?pinned=${pinned}`, { method: "POST" }),

  pushLink: (url: string, title = "", target = "") =>
    req<HubLink>("/api/links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, title, target }),
    }),
  openLink: (id: number) => req<unknown>(`/api/links/${id}/opened`, { method: "POST" }),
  deleteLink: (id: number) => req<void>(`/api/links/${id}`, { method: "DELETE" }),

  putNote: (id: string, body: string, title = "") =>
    req<Note>(`/api/notes/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, title }),
    }),
  deleteNote: (id: string) => req<void>(`/api/notes/${encodeURIComponent(id)}`, { method: "DELETE" }),
};

/* ── the OS clipboard ─────────────────────────────────────────────────────
   navigator.clipboard only exists in a secure context (HTTPS, or literal
   localhost). Over http:// on a tailnet IP it is simply absent — so the
   one-tap buttons must degrade rather than throw, and the UI has to say why.
   `trainwatch share` (Tailscale Serve) is the fix. */

export const canWriteClipboard = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.clipboard?.writeText;

export const canReadClipboard = (): boolean =>
  typeof navigator !== "undefined" && !!navigator.clipboard?.readText;

export const isSecureContext = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext;

/** Copy, with a documented fallback for insecure contexts. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (canWriteClipboard()) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* denied or not in a user gesture — fall through */
    }
  }
  // Legacy path: still works in Safari over plain http, where the modern API
  // does not exist at all. Deprecated, deliberately kept as the only option
  // that functions without TLS.
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export async function readClipboard(): Promise<string | null> {
  if (!canReadClipboard()) return null;
  try {
    return await navigator.clipboard.readText();
  } catch {
    // iOS shows a Paste permission prompt; declining lands here.
    return null;
  }
}

/* ── live state ───────────────────────────────────────────────────────── */

/**
 * Hub state over SSE. The server only pushes when its revision counter moves,
 * so an idle tab costs a keepalive comment every 20s rather than a full
 * clipboard list every 2s — which matters on cellular.
 */
export function useHub() {
  const [state, setState] = useState<HubState | null>(null);
  const [connection, setConnection] = useState<Connection>("connecting");
  const esRef = useRef<EventSource | null>(null);

  const refresh = useCallback(async () => {
    try {
      setState(await hubApi.get());
      setConnection("live");
    } catch {
      // The old comment claimed "the connection chip already communicates
      // this" — it did not. `connection` was only ever written by the SSE
      // handlers, so a failed snapshot left hub === null with the chip still
      // reading "connecting", and Clip rendered "Nothing copied yet" —
      // indistinguishable from a genuinely empty hub.
      setConnection("offline");
    }
  }, []);

  const connect = useCallback(() => {
    esRef.current?.close();
    setConnection("connecting");
    const es = new EventSource(`/api/hub/stream?d=${encodeURIComponent(deviceName())}`);
    esRef.current = es;
    es.addEventListener("hub", (ev) => {
      try {
        setState(JSON.parse((ev as MessageEvent<string>).data) as HubState);
        setConnection("live");
      } catch {
        /* a malformed tick is not worth tearing the stream down */
      }
    });
    // "connecting" must reach "offline" too — see the note in api.ts.
    es.onerror = () => setConnection("offline");
    return es;
  }, []);

  useEffect(() => {
    void refresh();
    const es = connect();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      void refresh();
      if (esRef.current?.readyState !== EventSource.OPEN) connect();
    };
    document.addEventListener("visibilitychange", onVisible);

    // Same wedged-stream fallback useLiveState has. Without it the hub half —
    // "the half you interact with" — could go stale indefinitely with no
    // recovery except a visibility change.
    const poll = window.setInterval(() => {
      if (esRef.current?.readyState !== EventSource.OPEN) void refresh();
    }, 15000);

    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(poll);
      // Same leak as useLiveState: onVisible may have replaced the stream, so
      // the captured `es` is not necessarily the live one.
      es.close();
      esRef.current?.close();
      esRef.current = null;
    };
  }, [connect, refresh]);

  return { hub: state, connection, refresh };
}
