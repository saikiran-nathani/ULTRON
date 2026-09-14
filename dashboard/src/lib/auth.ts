/**
 * The client half of trainwatch's auth.
 *
 * The server half has been complete for a while — sessions, scrypt, scoped
 * tokens, CSRF, a hash-chained audit log — and this file did not exist. That
 * asymmetry is not a missing feature, it is a trap that springs on success:
 * `Auth.has_identities()` turns enforcement on the moment `users` gains a
 * row, so running `trainwatch user add` — a correct, desirable action — would
 * take the dashboard dark on every device at once, with no login form to
 * recover through and only the CLI as a way back.
 *
 * So the ordering rule, recorded because it generalises: for any feature that
 * self-activates on a condition, build its dependent surfaces FIRST.
 *
 * Three things here are easy to get wrong, and all three are silent:
 *
 * 1. There are THREE boot states, not two. "Authenticated" and "needs login"
 *    are obvious; the third is "this instance has nothing enrolled and is
 *    open on the tailnet", which the server reports as `enforcing: false`.
 *    Treating that as "needs login" would show a login form on a box with no
 *    accounts — a door with no key, in front of a room that is not locked.
 *
 * 2. Login is a POST to /api/, so ADR-0003 C3 applies to it like any other
 *    write: without `X-Trainwatch` it is refused with **403**, which reads
 *    exactly like a rejected password. Correct behaviour, extremely
 *    confusing, and worth an hour of anyone's time if it is not written down.
 *
 * 3. The session cookie has two possible names. `__Host-tw_session` over
 *    HTTPS or localhost, plain `tw_session` otherwise, because
 *    `http://100.69.221.23:8730` is not a secure context and a browser
 *    silently discards a `Secure` cookie there. Both are HttpOnly, so this
 *    file never reads either — it asks `/api/auth/whoami` instead, which is
 *    the only honest way to know.
 */

/** What the server will say when asked who is calling. */
export interface WhoAmI {
  authenticated: boolean;
  /** False only when `users` is empty: open on the tailnet, no login needed. */
  enforcing: boolean;
  kind?: "human" | "machine";
  name?: string;
  scopes?: string[];
}

export type AuthState =
  /** The first `whoami` has not landed. Render nothing that implies a verdict. */
  | { status: "unknown" }
  /** No identities enrolled. ADR-0003 posture only: Host- and Origin-bound. */
  | { status: "open" }
  /** Enforcing, and we are nobody. Show the login form. */
  | { status: "anonymous" }
  | {
      status: "signed-in";
      name: string;
      kind: "human" | "machine";
      scopes: string[];
    };

/** Names fixed by `server/auth_api.py`. Changing one here changes nothing there. */
const CSRF_COOKIE = "tw_csrf";
const CSRF_HEADER = "X-CSRF-Token";

/**
 * The CSRF token, read from a cookie that is deliberately NOT HttpOnly.
 *
 * This looks like a weakened cookie and is the opposite: double-submit works
 * precisely because the SPA can read the value and echo it in a header. An
 * attacker's page can cause the cookie to be *sent* (that is what CSRF is)
 * but same-origin policy stops it *reading* the value, so it cannot produce
 * the matching header. A token JS could not read could not defend anything.
 */
export function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const m = new RegExp(`(?:^|;\\s*)${CSRF_COOKIE}=([^;]*)`).exec(document.cookie);
  // m[1] is `string | undefined` under noUncheckedIndexedAccess even though a
  // match guarantees the group; `?? ""` satisfies the checker without a cast.
  return m ? decodeURIComponent(m[1] ?? "") : "";
}

/**
 * Headers every write must carry.
 *
 * `X-Trainwatch` is ADR-0003 C3 — it makes the request non-simple so a
 * browser is forced to preflight, and we never answer a preflight.
 * `X-CSRF-Token` is C12. They defend different things and are not
 * substitutes: C3 stops another origin *issuing* the write, C12 stops it
 * riding our cookie. The token is omitted when absent rather than sent empty,
 * because the server compares with `compare_digest` and an empty string is a
 * mismatch it would report as "CSRF token missing or mismatched" — the same
 * message, from a different cause.
 */
export function writeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = csrfToken();
  return {
    "X-Trainwatch": "1",
    ...(token ? { [CSRF_HEADER]: token } : {}),
    ...extra,
  };
}

/* ── the mid-session 401 ─────────────────────────────────────────────────
   A session can die under a screen that is already open: it expires, or it is
   revoked from the CLI, or the server restarts having lost it. Every fetch
   path in the app funnels through here so exactly one thing happens — the
   shell flips to the login form — instead of each screen inventing its own
   error state and several of them showing stale data as if it were live. */

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to "the server just told us we are nobody". Returns an unsubscribe. */
export function onUnauthorized(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Called by the fetch wrappers on a 401. Never call this for a 403. */
export function reportUnauthorized(): void {
  for (const fn of [...listeners]) fn();
}

/* ── the endpoints ──────────────────────────────────────────────────────── */

export class LoginError extends Error {
  /** Seconds to wait, when the server rate-limited us (HTTP 429). */
  readonly retryAfter?: number;
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = "LoginError";
    this.retryAfter = retryAfter;
  }
}

/**
 * Ask who we are. Public on the server, so it answers rather than 401s —
 * which is what makes it usable as the boot probe.
 */
export async function whoami(signal?: AbortSignal): Promise<WhoAmI> {
  const res = await fetch("/api/auth/whoami", {
    signal,
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`whoami failed: ${res.status} ${res.statusText}`);
  return (await res.json()) as WhoAmI;
}

export function stateFrom(who: WhoAmI): AuthState {
  if (who.authenticated) {
    return {
      status: "signed-in",
      name: who.name ?? "unknown",
      kind: who.kind ?? "human",
      scopes: who.scopes ?? [],
    };
  }
  return who.enforcing ? { status: "anonymous" } : { status: "open" };
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    // writeHeaders() and not a bare Content-Type: see note 2 in the module
    // docstring. There is no CSRF cookie yet on a first login, and that is
    // fine — /api/auth/login is public, so the guard never reaches C12 for it.
    headers: writeHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ username, password }),
  });

  if (res.ok) return;

  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: number };
    const secs = Math.ceil(body.retry_after ?? 60);
    throw new LoginError(
      `Too many attempts. Try again in ${secs}s.`,
      secs,
    );
  }

  const body = (await res.json().catch(() => ({}))) as { error?: string; why?: string };

  // The C3 case, spelled out rather than passed through. The server's own
  // message is accurate ("missing x-trainwatch header") but a 403 during
  // login reads as "wrong password" to anyone not holding the ADR, and that
  // misreading costs real time.
  if (res.status === 403) {
    throw new LoginError(
      body.error
        ? `Refused by the request guard: ${body.error}. This is not a password failure.`
        : "Refused by the request guard, not by your password (ADR-0003 C3).",
    );
  }

  // 401 is deliberately one message for unknown user, wrong password and
  // disabled account — anything more specific is a user-enumeration oracle.
  throw new LoginError(body.error ?? `Login failed (${res.status}).`);
}

/**
 * Log out on the server, not just in the browser.
 *
 * Sessions are server-side and revocable, so dropping local state while the
 * cookie stays valid is theatre: the session is still live and still usable
 * by anything holding it. The write headers are required here — unlike
 * /login, /logout is not public, so it passes through C3 and C12 both.
 */
export async function logout(): Promise<void> {
  await fetch("/api/auth/logout", { method: "POST", headers: writeHeaders() });
}
