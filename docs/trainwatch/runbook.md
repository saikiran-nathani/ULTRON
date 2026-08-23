# Runbook

Every failure mode in `remote-training-monitoring.md`, plus the ones this
implementation adds, with the diagnostic that tells them apart.

**Start here, always:**

```bash
trainwatch doctor
```

It checks all four layers and exits non-zero if any is broken. Fix from
layer 0 upward — each layer needs the one below it.

---

## Reach (layer 0)

### SSH works at home, not on campus

**Cause.** Campus wifi almost always enables client isolation: two devices on
the same SSID cannot see each other. Nothing is wrong with your box.

**Fix.** Tailscale routes around it — the tailnet is an overlay, not a LAN.

**Verify properly.** Turn wifi *off* on the iPad and connect over cellular.
That is the only test that proves reach; both devices on home wifi can succeed
for the wrong reason (they're on the same subnet).

```bash
tailscale status          # is the iPad listed and recently seen?
tailscale ping ipad       # does traffic actually flow?
```

### Dashboard loads at the desk but not remotely

Bound to `127.0.0.1` instead of `0.0.0.0`. `trainwatch serve` binds `0.0.0.0`
by default; if you overrode `TRAINWATCH_HOST`, that's why.

```bash
ss -tlnp | grep 8730      # want 0.0.0.0:8730, not 127.0.0.1:8730
```

### Tailscale drops after a WSL restart

WSL2 has no systemd, so `tailscaled` doesn't come back on its own.

```bash
pgrep -x tailscaled || sudo nohup tailscaled --state=/var/lib/tailscale/tailscaled.state >/var/log/tailscaled.log 2>&1 &
sudo tailscale up --ssh
```

Add that guard to `~/.bashrc` so opening a shell repairs it.

---

## Persist (layer 1)

### The run died when the iPad slept

It wasn't in tmux, or it was launched in a subshell that got SIGHUP.

```bash
tmux ls                                  # was there ever a session?
tmux new -A -s train                     # attach-or-create, always safe
```

Launch *inside* the session, not by SSHing a command from outside. Use
`scripts/train-session.sh`, which also splits out `nvidia-smi` and the
dashboard and tees the log.

### I lost the output I wanted to read

tmux scrollback is comfort, not storage. Always tee:

```bash
set -o pipefail
python train.py 2>&1 | tee -a logs/run_$(date +%Y%m%d_%H%M).log
```

`set -o pipefail` matters: without it a crashed `train.py` still exits 0
because `tee` succeeded, and any wrapper you build on top sees success.

---

## Emit (layer 2)

### Dashboard shows the run but no metrics

The store buffers rows and flushes every ~2s or 512 rows. If you killed the
process hard, the last couple of seconds are gone — by design; a fsync per
step would slow the loop.

If *nothing* is arriving, the sink was never built:

```bash
trainwatch doctor         # "sink:tensorboard  configured but not importable"
```

`build_emitter` always forces the `store` sink on, so the dashboard should
never be empty because of a `TRAINWATCH_SINKS` typo.

### Machine panels are empty

```bash
trainwatch gpu
```

`nvidia-smi` isn't on PATH. On WSL2 it lives at `/usr/lib/wsl/lib`:

```bash
export PATH=$PATH:/usr/lib/wsl/lib
```

If it's still missing, you likely installed a Linux NVIDIA driver inside WSL,
which breaks passthrough. Only the Windows driver should be installed.

### Step time drifts upward across runs

**This is usually thermal throttle, not your code.** Open **Machine** in the
dashboard. If the SM clock has a sawtooth starting when temperature crosses
~87 °C, the machine slowed down.

The `step_time` rule compares against the run's *own* warmed-up baseline
rather than a fixed threshold, because there is no universal "normal" step
time. See [wsl2-performance.md](wsl2-performance.md#5-thermals) for fixes.

---

## Notify (layer 3)

### Alerts never arrive

Work down this list — each step eliminates one layer:

```bash
trainwatch doctor --send-test    # 1. does a push leave the box at all?
```

- **`ntfy topic  fail`** → `TRAINWATCH_NTFY_TOPIC` is unset or still the
  placeholder. Nothing has ever been sent. The Alerts screen says so too.
- **`test push  fail`** → the POST failed. No egress, or a wrong server URL.
  `curl -d hi https://ntfy.sh/<topic>` by hand.
- **`test push  ok` but the iPad is silent** → it's the phone, not the box.
  iOS killed ntfy's background refresh. See
  [ipad-client.md](ipad-client.md#alerts-the-part-that-silently-doesnt-work).

### I got one alert but the problem repeated 500 times

Working as intended. Each rule has a 120s cooldown and there's a global cap of
12 alerts/minute. Every occurrence is still recorded — the dashboard's
**Alerts** screen shows the full history and marks which were pushed.

Tune with `Notifier(cooldown=..., burst=...)` if you want it chattier.

### No alert on a dead run

The liveness check isn't installed or cron isn't running. This is the most
important alert in the system and the easiest to leave half-armed.

```bash
crontab -l | grep trainwatch      # is the entry there?
pgrep -x cron || sudo service cron start
trainwatch liveness               # force one check now
```

On WSL2 cron is frequently installed but not started, because there's no
systemd. An installed cron entry that never fires is worse than none — you
believe you're covered. `trainwatch doctor` checks both.

### The liveness check paged me about a run I finished on purpose

It shouldn't — it only fires for runs still marked `running`. If it did, the
process died without `finish()` being called (SIGKILL, or the `with` block was
bypassed). Use the context manager:

```python
with TrainMonitor("run") as tw:  # marks failed/stopped on the way out
    ...
```

---

## The dashboard (layer 4)

### "connecting" or "offline" in the corner

The SSE stream is down. The client falls back to polling every 15s, so data
still updates — just slower. Usually the server restarted; it reconnects on
its own within ~5s.

If it stays offline: `curl http://<ip>:8730/healthz` from another device on
the tailnet.

### Blank page / 503 `dashboard bundle not built`

The static bundle isn't there.

```bash
cd dashboard && npm ci && npm run build
```

The build output is committed, so this should only happen in a dev checkout
where it was cleaned.

### The store is getting big

```bash
du -h var/trainwatch.db
trainwatch prune --days 30
```

Metrics from finished runs older than the cutoff are dropped; the run rows
stay so history is still listed.

---

## Recovering

| Situation | Do |
|---|---|
| Server is wedged | `Ctrl-C` in pane 2, `trainwatch serve`. The trainer is unaffected — it writes to SQLite, not to the server. |
| Store is corrupt | `mv var/trainwatch.db{,.bad}` and restart. It's derived telemetry; your checkpoints are the real artifact. |
| Everything is confusing | `scripts/trainwatch doctor` — it checks all four layers and exits non-zero on the first one that is actually broken. |

Nothing in this system can take the training run down with it. The trainer
writes to a local file and fires HTTP in a daemon thread; the server, the
dashboard and ntfy can all be absent and the run keeps going. That's the
property worth preserving if you extend this.


---

## The device hub (clipboard / files / links / notes)

### One-tap copy and paste do nothing

You are not on HTTPS. `navigator.clipboard` only exists in a secure context, so
Safari does not expose it over `http://` on a tailnet IP. The Clip screen shows
a banner when this is the case.

```bash
trainwatch share          # real cert via Tailscale, nothing to install
```

Then open the `https://…ts.net` URL instead of the IP.

### 421 "unrecognised Host header"

Working as designed — that is the DNS-rebinding guard (ADR-0003 C1). You reached
the dashboard by a hostname the server does not know. The response lists what it
accepts. To add one:

```bash
TRAINWATCH_ALLOWED_HOSTS=my-alias,another-name
```

### 403 on a write, but reads work

Either the `X-Trainwatch` header is missing (the dashboard and CLI send it; a
hand-rolled `curl` must too), or an `Origin` header arrived from another origin.
Both are CSRF controls.

```bash
curl -H "X-Trainwatch: 1" -H "Content-Type: application/json" \
     -d '{"body":"hi"}' http://127.0.0.1:8730/api/clip
```

### 401 on a write

`TRAINWATCH_TOKEN` is set on the host. Set the same value on the client.

### A secret I pushed has vanished

By design: secret entries expire after 15 minutes. Pin it if you need it to
persist — pinning is the only way to opt out of expiry.

### An uploaded file downloads instead of opening

Also by design. Only allowlisted raster image types are served inline; anything
that could carry script — `.html`, `.svg`, even `.txt` — is forced to download
as `application/octet-stream`. An uploaded file must never execute on the
dashboard's origin.

### Files are eating disk

```bash
curl -X POST -H "X-Trainwatch: 1" http://127.0.0.1:8730/api/hub/purge
```

Runs hourly on its own; this forces it. It also reaps blobs whose row is gone
(an interrupted upload), which would otherwise leak invisibly.

### The clipboard is empty on one device but not another

They are talking to different hubs. The hub is one process on one host; check
`TRAINWATCH_HUB` on the client machines.

### Never do this

```bash
tailscale funnel 8730     # ← publishes your clipboard to the public internet
```

`serve` is tailnet-only. `funnel` is not. No control in ADR-0003 is designed for
public exposure.
