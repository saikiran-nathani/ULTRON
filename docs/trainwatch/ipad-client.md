# The iPad side

Layer 4. Steps 1–3 give you a remote terminal; this is what lets you stop
looking at it.

---

## What to install

| Need | App | Notes |
|---|---|---|
| Reach | **Tailscale** | Free tier, same account as the box. Non-negotiable, everything else rides on it. |
| SSH / tmux | **Blink Shell** (paid) or **Termius** (free tier) | See the Mosh note below — it's the reason Blink is worth the money. |
| Alerts | **ntfy** | Free, open source. This is layer 3 arriving. |
| Dashboards | Safari | `http://<tailscale-ip>:8730`, installed to the Home Screen. |
| At the desk | **Sidecar** | The iPad as a second display for the Mac. Different tool, different job. |

---

## Mosh, and why standard SSH is annoying on a tablet

Standard SSH is a TCP connection bound to your IP. Switch from wifi to
cellular, or let the iPad sleep, and the connection is dead — you reattach to
tmux and lose your scrollback position.

**Mosh** is UDP and roams: it survives IP changes and sleep, and shows you
local echo while the link catches up. On a device you pick up and put down
twenty times a day, this is the single biggest quality-of-life difference.

Blink supports Mosh natively. On the box:

```bash
sudo apt-get install -y mosh
```

Then in Blink: `mosh <tailscale-ip>` (or `mosh asus` with MagicDNS on).

> Mosh needs UDP 60000–61000. Over Tailscale this Just Works, because the
> tailnet carries UDP — one more reason layer 0 comes first.

A Blink host entry pointing at `asus`, with tmux auto-attach, means opening
the app puts you straight back in the run:

```bash
# Blink → Settings → Hosts → asus
#   HostName: asus          (MagicDNS)
#   User:     yourname
#   Moshcommand: tmux new -A -s train
```

`tmux new -A -s train` attaches if the session exists and creates it if not,
so one command always does the right thing.

---

## Install the dashboard to the Home Screen

It's a PWA. Installing it is worth the ten seconds:

1. Safari → `http://<tailscale-ip>:8730`
2. Share → **Add to Home Screen**
3. Open it from the icon, not from Safari.

You get: full screen with no browser chrome, its own app-switcher card, and
the layout using the whole display including under the status bar.

The dashboard is touch-first — bottom tab bar in portrait, sidebar in
landscape, 44 px targets, and every chart scrubs with a finger drag. There are
no hover-only affordances.

**Fonts and assets are served from the box**, not a CDN, so the dashboard
renders correctly on hotel wifi, behind a captive portal, or on a box with no
outbound internet.

---

## Alerts: the part that silently doesn't work

The MD's failure table lists it, and it's the one people lose a night to:

> Alerts never arrive → iOS killed the ntfy app's background refresh

Set it up properly once:

1. Install **ntfy** from the App Store.
2. Subscribe to your exact topic (it's in
   `.env` as `TRAINWATCH_NTFY_TOPIC`).
3. **Settings → Notifications → ntfy**: Allow Notifications **on**, Lock
   Screen **on**, Banners **Persistent**, and **Time Sensitive** allowed.
4. **Settings → General → Background App Refresh**: on, and on for ntfy.
5. Make sure ntfy is **not** in Low Power Mode's crosshairs — Low Power Mode
   suspends background refresh. If you train overnight with the iPad on
   charge, this doesn't bite; on battery it can.
6. If you use a Focus mode overnight, add ntfy to its allowed list, or urgent
   alerts will be delivered silently — which is the same as not delivered.

Then prove the whole chain end to end:

```bash
trainwatch doctor --send-test
```

If that buzzes your iPad, layer 3 works. If it doesn't, `doctor` tells you
which of the four layers is broken rather than leaving you to guess.

The dashboard also shows you: the **Alerts** screen marks every event as
pushed or not, and warns loudly if `TRAINWATCH_NTFY_TOPIC` is unset — because
the symptom of an unarmed notify layer is silence, which is indistinguishable
from everything being fine.

### Topic privacy

Public ntfy topics are readable by **anyone who knows the string**. The
bootstrap script generates a 24-character random topic for this reason. Don't
paste it into a screenshot, an issue, or a chat.

Alert bodies contain step numbers and loss values — not secrets — so the
default is a reasonable trade. If you'd rather nothing leaves the tailnet at
all, self-host ntfy on the box and point `TRAINWATCH_NTFY_SERVER` at it:

```bash
docker run -d --name ntfy -p 8080:80 binwiederhier/ntfy serve
# .env:  TRAINWATCH_NTFY_SERVER=http://<tailscale-ip>:8080
```

Then the iPad app subscribes to that server over the tailnet, and the whole
system — metrics, dashboard, alerts — is local.

---

## TensorBoard from the iPad

```bash
trainwatch tensorboard
```

Binds `0.0.0.0` deliberately, which is safe **only** because Tailscale is the
network boundary. `--host 127.0.0.1` (the default) is the reason a remote
TensorBoard page comes up blank; the MD lists it as a failure mode.

Do not port-forward 6006 or 8730 on your router. The whole point of layer 0 is
that you don't have to.

---

## A realistic evening

1. Start the run in tmux from the Mac, detach.
2. Close the laptop. The run doesn't care.
3. On the sofa: glance at the Home Screen dashboard. **Healthy**, ring most of
   the way full, loss curve heading down. Put the iPad down.
4. 01:40 — phone buzzes: `run_042 · Grad norm spike — grad_norm 144.4 > ceiling 100 @ step 900`.
5. Open the dashboard. Metrics → `resid_rms` shows the drift started 200 steps
   earlier. Machine shows the GPU is fine, so it's the model, not the box.
6. Blink → `mosh asus` → already attached to tmux → Ctrl-C, adjust, relaunch.
7. Back to sleep. If it dies instead of complaining, the liveness cron pages
   you within ten minutes.
