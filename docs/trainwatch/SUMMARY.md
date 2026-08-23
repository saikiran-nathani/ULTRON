# trainwatch — project summary

> **Folded into ULTRON.** This was trainwatch's own status document when it was a
> separate repository at `Monitoring/`. It is kept for its architecture and
> threat-model reasoning, which is unchanged. Commands read `trainwatch <cmd>`
> throughout — that is now `scripts/trainwatch <cmd>`. The WSL2 bootstrap script
> it references was dropped in the move: the TUF runs native Ubuntu, and there is
> nothing left to bootstrap because trainwatch is no longer separately installed.
> See `docs/trainwatch/README.md` for the full mapping.

Written 2026-08-21. A handoff document: what this is, what state it is in, what
needs your attention, and what to do next.

---

## 1. Context — what this is and why

It started as an implementation of [`remote-training-monitoring.md`](remote-training-monitoring.md):
a guide for watching a training run on a headless CUDA box from an iPad, built
in four layers (Reach → Persist → Emit → Notify). It grew a second half — a
private device hub — because the same tailnet that carries telemetry can carry
a clipboard.

**Two halves, one dashboard, sharing a tailnet and a SQLite file and nothing else.**

```
Clip  ·  Drop  ·  Notes          Train (Watch/Metrics/Machine/Alerts)
└──── the device hub ────┘       └────────── telemetry ──────────┘
        read / write                         read-only
```

### Why the hub exists (the honest version)

Universal Clipboard and AirDrop already handle Mac ↔ iPad ↔ iPhone, and handle
it **better** — they are OS-level with no page to open. Do not stop using ⌘C.

Three things they cannot do, which is the entire justification:

1. **Include a Linux box.** `killerx8143` participates in neither.
2. **Keep history.** Universal Clipboard holds exactly one item, destroyed the
   moment you copy anything else.
3. **Survive sleep.** It needs both devices awake, same iCloud, within ~2 min.

So this is a **Linux↔Apple bridge with history and durability**, not a
clipboard replacement.

### Your actual hardware

| Device | Tailnet | Role |
|---|---|---|
| `sais-macbook-pro` | `100.102.190.111` | primary dev; **currently the hub host** |
| `killerx8143` | `100.69.221.23` | the Asus — Windows → WSL2 + CUDA, training box |
| `ipad173` | `100.65.186.103` | the thin client |

Hub URL: **`https://sais-macbook-pro.tail1f999f.ts.net`** (tailnet-only).

---

## 2. The one non-obvious constraint that shaped everything

`navigator.clipboard` **only exists in a secure context** — HTTPS, or literally
`localhost`. Over `http://100.102.190.111:8730` Safari does not expose it at
all. Verified empirically, not assumed:

| | over `http://100.x` | over `https://…ts.net` |
|---|---|---|
| `isSecureContext` | `false` | `true` |
| `navigator.clipboard.writeText` | **absent** | present |
| Service workers (PWA/offline) | unavailable | available |
| Web Push | unavailable | available |

That is why `trainwatch share` (which wraps `tailscale serve`) is not optional.
It gets a real Let's Encrypt certificate for the MagicDNS name with **nothing to
install on any device** — which also happens to satisfy the original "no app
downloads" requirement, since Tailscale was already on all three machines.

**HTTPS certificates had to be enabled once** in the Tailscale admin console
(done 2026-08-21). Current cert expires **Nov 19 2026** and Tailscale renews it.

---

## 3. Current state

### Verified working

- Full monitoring chain: `trainwatch demo` diverges on cue and the escalation
  reads correctly — activation drift → attn logit spike → grad norm → NaN abort.
- Hub live sync: `echo … | trainwatch clip` on the CLI appeared in an open
  browser with no reload.
- Real clipboard write: clicked Copy in the dashboard, `pbpaste` returned the
  exact clip.
- HTTPS: cert verified by `curl` with no `-k`; a write over TLS landed; the Host
  allowlist auto-detected the MagicDNS name with 0 rejections.
- Security controls: cross-origin write → 403, unknown Host → 421, uploaded
  `.html`/`.svg` → forced to `attachment` + `octet-stream`.

### Not verified

- **The iPad itself.** The in-app browser used for testing blocks all network
  for non-localhost origins (`ERR_BLOCKED_BY_CLIENT`, even `fetch()` to its own
  origin), so the HTTPS dashboard could not be driven from here. Ruled out a
  bundle problem by rendering the identical build over localhost. **Your iPad is
  the real test.**
- **The GPU/throttle path against your actual 4070.** Tested against mocked
  `nvidia-smi` output only, including the WSL2 `[N/A]` field cases.
- **Anything on the Asus (TUF).** Never exercised there — and the WSL2
  bootstrap path it assumed is gone; the TUF runs native Ubuntu.

### Quality gates (all green)

| Gate | Result |
|---|---|
| `ruff check` + `ruff format --check` | clean |
| `mypy` (strict, 17 modules) | clean |
| `pytest` | **239 passed**, 84% coverage |
| `tsc -b` (strict) | clean |
| `npm audit` | 0 vulnerabilities |
| zero-dependency core guard | passes on a bare interpreter |

~4,900 lines Python · ~4,000 lines TS/TSX (32 files) · ~1,340 lines docs.

---

## 4. ⚠ Needs your attention

Ordered by consequence.

### 4.1 Nothing is committed — 108 files, 0 commits

The entire project is staged but never committed. One power cut and it is gone.

```bash
git commit -m "trainwatch: remote training monitoring + private device hub"
```

There is no remote either. Consider a private GitHub repo — but note `.env` is
gitignored by design, so the ntfy topic and any token stay local.

### 4.2 The liveness cron is not installed

**This is the most important alert in the system and it is unarmed.** Value-based
alerts cannot fire when nothing is running — a hang, an OOM kill or a SIGKILL
produces no error because no code is left to produce one. Only an out-of-process
check catches those.

```bash
bash scripts/install-liveness-cron.sh
```

On WSL2, cron is frequently installed but **not running** (no systemd). An
installed cron entry that never fires is worse than none, because you believe
you are covered. `trainwatch doctor` checks both.

### 4.3 Layer 3 is unarmed — no `.env` on this Mac

No `.env` exists, so `TRAINWATCH_NTFY_TOPIC` is unset and **nothing has ever
reached your phone.** You are still watching a dashboard, which is precisely
what the source guide says is not the point.

```bash
cp .env.example .env
python -c "import secrets; print('trainwatch-' + secrets.token_urlsafe(18))"   # paste into .env
trainwatch doctor --send-test    # should buzz the iPad
```

Then walk the iOS notification permissions in
[docs/ipad-client.md](docs/ipad-client.md#alerts-the-part-that-silently-doesnt-work) —
iOS killing ntfy's background refresh is a real failure mode whose only symptom
is silence.

### 4.4 The Asus has never been set up

Everything so far runs on the MacBook. The training box needs:

```bash
# on killerx8143, inside WSL2
git clone <repo> ~/trainwatch && cd ~/trainwatch
cp .env.example .env && scripts/trainwatch doctor
# then, since the hub lives on the Mac:
echo 'TRAINWATCH_HUB=https://sais-macbook-pro.tail1f999f.ts.net' >> .env
```

It is reachable right now (`tailscale ping killerx8143` → 4ms, direct), so this
is doable immediately.

### 4.5 The hub host is a laptop

`tailscale serve` currently proxies to the **MacBook**. Closed lid = no clipboard
sync. Two consequences worth internalising:

- Mid-training the Asus is the more-awake machine.
- **Training panels only populate on the machine the training runs on**, because
  the trainer writes to a local SQLite file (ADR-0001) rather than posting over
  the network. Hosting the hub on the Mac means Train stays empty while the Asus
  trains.

If that split annoys you, move the hub to the Asus — it is one env var plus
running `trainwatch share` there instead.

### 4.6 WSL2 performance work is unapplied

You mentioned the box being slow and starting a cleanup. Nothing has been
applied yet. The top two are worth more than everything else combined:

1. **Nothing that matters should live on `/mnt/c`** — 9p makes many-small-file
   access 10–50× slower, which is exactly what Python imports are.
2. **Your cleanup did not return the space.** `ext4.vhdx` historically only
   grew. `wsl --manage <distro> --set-sparse true` reclaims it.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\Tune-WSL.ps1
```

Read-only; add `-Apply` (elevated) once you have read what it wants to change.
(The WSL2 performance notes were dropped when trainwatch moved into ULTRON —
the TUF runs native Ubuntu now. See `docs/WINDOWS-TO-UBUNTU.md`.)

### 4.7 Test data is still in `var/`

6 clips, 3 files, 1 note, 3 links — seeded by me for screenshots. Gitignored, so
harmless, but it is not yours.

```bash
rm -rf var/        # recreated empty on next start
```

### 4.8 Never run this

```bash
tailscale funnel 8730     # ← publishes your clipboard to the public internet
```

`serve` is tailnet-only. `funnel` is not. No control in ADR-0003 is designed for
public exposure, and a clipboard history is the most credential-dense thing you
own.

---

## 5. Future actions

### Now cheap, because HTTPS is in place

| | Why it is now possible |
|---|---|
| **Web Push** — "clip arrived", "run diverged" as native iOS notifications | Requires a secure context + PWA installed to the Home Screen. Would let you drop ntfy for hub events. |
| **Service worker / offline PWA** | The dashboard could open and show last-known state with no connection. |
| **QR pairing** via `getUserMedia` | If device onboarding ever needs to be less manual. |

### Worth doing when it starts to hurt

- **Move the hub to an always-on host** (Pi, old machine, cheap VPS on the
  tailnet). Solves 4.5 permanently.
- **Self-host ntfy** on the tailnet (`docker run binwiederhier/ntfy serve`) so
  no alert content leaves your network. Point `TRAINWATCH_NTFY_SERVER` at it.
- **Tailscale ACLs** to restrict which devices can reach :8730 at all — belt
  and braces on top of ADR-0003.
- **Wire `TrainMonitor` into the real projects.** It is currently only used by
  `examples/train_with_trainwatch.py`. `FORGE`, `ATLAS`, `BRAIN`, `MedAI` etc.
  each get the watchdog for four lines of code.
- **A `graphify` bridge** — Drop already accepts a PDF; having it kick off a
  knowledge-graph run would close that loop.

### Deliberately not built

- **A clipboard-watching daemon.** An `--auto` mode mirroring the OS clipboard
  continuously would be convenient and would also build a searchable archive of
  every password you ever copy. Pushes are explicit for that reason.
- **Encryption at rest.** Without a key-management story it is theatre; the
  SQLite file is covered by FileVault and your user account.
- **Multi-user / sharing.** This is one person's three devices.

---

## 6. Reference

### Commands

```bash
# monitoring
trainwatch serve                 # dashboard + API on :8730
trainwatch share                 # ...behind Tailscale HTTPS  (share --off to undo)
trainwatch doctor                # every layer + the hub; non-zero if broken
trainwatch doctor --send-test    # actually push a test alert
trainwatch liveness              # one-shot dead-run check (the cron entry)
trainwatch demo                  # synthetic run that diverges on purpose
trainwatch gpu                   # one-shot GPU snapshot
trainwatch tensorboard           # bound 0.0.0.0 for remote access
trainwatch prune --days 30

# the hub, from any terminal
echo "100.69.221.23" | trainwatch clip
trainwatch clip                  # print the latest
trainwatch clip --to-os          # ...into the OS clipboard
trainwatch clip --from-os        # push the OS clipboard
trainwatch clip -l               # history
trainwatch clip --secret --text "$TOKEN"
trainwatch send plot.png
trainwatch open https://arxiv.org/abs/...
trainwatch hub                   # contents + who is online
```

### The watchdog

| Rule | Fires when | Priority |
|---|---|---|
| `nonfinite` | any scalar is NaN/inf | **urgent**, aborts the run |
| `grad_norm` | above the ceiling | high |
| `entropy` | below the floor (RL collapse) | high |
| `resid_rms` | peak per-layer activation drifts ≥3× **its own baseline** | high |
| `attn_logit_max` | logits spike past the ceiling | high |
| `step_time` | rolling median ≥1.5× **the run's own baseline** | default |
| *liveness* | no heartbeat in the timeout — **from cron, out of process** | urgent |

The last two need a baseline rather than a threshold: there is no universal
"normal" step time for a given model on a given GPU at a given batch size. When
step time drifts, the alert tells you to check GPU clock before blaming your
code — on a laptop chassis it is usually thermal throttle.

Deduped per rule (120s cooldown), globally capped at 12/min.

### Layout

```
src/trainwatch/          zero third-party deps — the training loop imports this
  monitor.py             TrainMonitor: the one object you put in the loop
  rules.py  notify.py    watchdog · async non-blocking ntfy
  store.py  hub.py       SQLite (telemetry) · SQLite (clipboard/files/notes)
  security.py            ADR-0003's guards
  client.py  cli.py      hub HTTP client (urllib) · argparse CLI
  gpu.py  liveness.py  heartbeat.py  emit.py  config.py
  server/                needs the `server` extra
    app.py  hub_api.py   read API + static host · hub write API
    static/              the committed dashboard build
dashboard/               Vite + React + Tailwind v4 + Framer Motion
scripts/                 trainwatch · tailscale-up · train-session · trainwatch-liveness-cron
                         install-liveness-cron · vendor-fonts · windows/Tune-WSL.ps1
docs/                    private-network · ipad-client · wsl2-performance · runbook · adr/
```

### Key design decisions

- **Zero-dependency core** ([ADR-0001](docs/adr/0001-stack-and-architecture.md)).
  Everything the training loop imports is stdlib-only, enforced in CI on a bare
  interpreter. A monitoring library must never be why a 6-hour run fails to start.
- **SQLite in WAL as the bus.** One writer, many readers, no daemon, whole
  history is one file you can `scp`.
- **Fonts self-hosted**, not CDN — so the dashboard renders on a box with no
  internet and an iPad behind a captive portal, and the CSP can stay tight.
- **Mount animations in CSS, not Framer.** Safari suspends backgrounded tabs,
  stopping `requestAnimationFrame`; a JS tween interrupted at 40% opacity stays
  there. CSS animations always settle on their last keyframe.

### Security posture ([ADR-0003](docs/adr/0003-writable-hub-and-browser-threat-model.md))

ADR-0002 recorded "no authn/authz" as an accepted risk with an explicit
trip-wire: *any write endpoint is added*. Adding the hub fired it, so the posture
was re-derived rather than extended.

**The threat is not the tailnet — it is any page open in Safari**, which can
reach `100.x.y.z:8730` exactly as easily as the dashboard can.

| Attack | Control |
|---|---|
| Cross-origin POST poisons your clipboard (CSRF) | `Origin` checked on writes; required `X-Trainwatch` header forces a preflight that is never answered |
| DNS rebinding **reads** your history | **`Host` allowlist** — the only control that closes this. Auto-detected from Tailscale (10 names) |
| Uploaded `.html`/`.svg` runs on our origin | only allowlisted raster images inline; everything else `attachment` + `octet-stream` + `nosniff` + locked CSP |
| Credentials living forever | `secret` entries redacted in listings, excluded from search, never logged, 15-min TTL. Everything expires unless pinned |

Optional `TRAINWATCH_TOKEN` gates writes only; off by default.

A test enforces the remaining invariant: **training routes must stay read-only.**

---

## 7. Bugs found while building (for the record)

Each was found by testing, not review — worth knowing because several were
silent.

| Bug | Why it mattered |
|---|---|
| `liveness` exited non-zero with no runs | cron would email every 10 min on a fresh install — the fastest way to learn to ignore your one dead-run alert |
| Every hub write attributed to `unknown` | `Header()` alias declared function-locally; `from __future__ import annotations` made FastAPI resolve it against module globals, so the marker was silently dropped |
| Presence pings bumped the SSE revision | each device's poll pushed a full snapshot to every other device — the counter doing the exact opposite of its job |
| `WANDB_API_KEY=…` not flagged as a credential | `\b(api_key)` needs a word boundary, but `_` is a word character. The most common shape in a `.env` |
| `trainwatch share` hung 3 minutes | `tailscale serve` blocks forever waiting for a cert it may never get. Now probes first, fails in 0.09s with the fix |
| Log-scale chart axis mislabelled | gridlines lerped linearly, so a log midpoint read 2.994 where the line sat at 1.156 |
| Sub-ms step times rendered `0ms` | made the drift alert unreadable on exactly the fast synthetic runs used to test alerting |
| Run picker silently did nothing | mapped `runs[0]` to "no override", but the server's default is *live-preferred*, not newest-first |
| `add_file` returned `{}` for short TTLs | re-read through the expiry filter it had just bypassed |

---

## 8. The two tests that actually matter

Everything else is secondary to these.

```bash
# 1. Reach. Both devices on home wifi can succeed for the wrong reason.
#    Turn wifi OFF on the iPad and load the dashboard over cellular.
open https://sais-macbook-pro.tail1f999f.ts.net

# 2. The leg nothing else does. On the Asus:
echo "hello from the asus" | trainwatch clip
#    ...then tap Copy on the iPad.
```
