# The private network, and the hub on top of it

Setting up a private network across a Linux box and Apple devices, with **no app
downloads**, and a dashboard where every operation happens.

---

## Read this first: the constraint that shapes everything

Two facts, both worth knowing before you start.

**1. "Private network" + "no app downloads" cannot both be literal.** A VPN
overlay needs a client on every device; on iPadOS/iOS that is an App Store
download and there is no built-in alternative. So the answer is not a VPN you
install per device — it is **one host running a service, with every client being
the browser that already ships on the device**.

In your case this is moot in the best way: **Tailscale is already installed on
all three machines**, so the download already happened. That is what makes the
rest of this easy, and it is why the recommended path below beats both a
Cloudflare Tunnel and a self-signed local CA.

**2. The clipboard API forces HTTPS.** `navigator.clipboard` only exists in a
*secure context* — HTTPS, or literally `localhost`. Over
`http://100.69.221.23:8730` Safari does not expose it at all, so one-tap copy
and paste silently do nothing. Text still syncs; you just have to select it by
hand. **That single constraint, not the networking, is what picks the
architecture.**

The dashboard tells you which mode you are in: a warning banner appears on the
Clip screen whenever the page is not a secure context.

---

## What this actually buys you

Be clear-eyed, because two thirds of it you already have:

| | Already covered by | The gap |
|---|---|---|
| Mac ↔ iPad ↔ iPhone text | **Universal Clipboard** (better: OS-level, no page to open) | — |
| Mac ↔ iPad ↔ iPhone files | **AirDrop** | — |
| **Anything ↔ the Asus** | nothing | **this** |
| **History** of what you copied | nothing | **this** |
| **Durability** (copy at 2am, paste at 9am) | nothing — Universal Clipboard is one item, ephemeral, both devices awake | **this** |

So: this is a **Linux↔Apple bridge with history**, not a replacement for
Universal Clipboard. Do not stop using ⌘C between your Apple devices.

---

## Setup

### 0. Confirm the tailnet (already done, in your case)

```bash
tailscale status
```

You should see all three machines. If not: `bash scripts/tailscale-up.sh`.

### 1. Choose the host

The hub is one process on one machine. Everything else is a browser.

| Host | Good | Bad |
|---|---|---|
| **MacBook** | where you already are | lid closed = no sync |
| **Asus (WSL2)** | awake whenever you are training; training telemetry is local to it | lid closed = no sync |
| Pi / always-on box | actually always there | you have to own one |

It is one env var to move, so do not agonise. Note that **training panels are
only populated on the machine the training runs on**, because the trainer writes
to a local SQLite file (ADR-0001) rather than posting over the network.

### 2. Start it

```bash
trainwatch serve
```

### 3. Give it a real certificate — the important step

```bash
trainwatch share
```

That runs `tailscale serve` behind the scenes and prints your HTTPS URL, e.g.
`https://sais-macbook-pro.tail1f999f.ts.net`. What you get:

- a **real, browser-trusted certificate** (Tailscale provisions it)
- **no domain to buy**, no Cloudflare, nothing to install on any device
- reachable **only from inside your tailnet**
- therefore a secure context → **the Clipboard API works**

If it errors, enable HTTPS certificates once at
<https://login.tailscale.com/admin/dns> → *HTTPS Certificates*. MagicDNS is
already on for your tailnet.

> **Never run `tailscale funnel` on this.** Funnel is the sibling command that
> publishes to the *public internet*. A clipboard history is the most
> credential-dense thing you own. This is the one footgun here.

### 4. Add it to the Home Screen

Safari → the `https://…ts.net` URL → Share → **Add to Home Screen**. Full
screen, no browser chrome, its own app-switcher card. Not a download.

### 5. Undo, if you want to

```bash
trainwatch share --off
```

---

## Using it

Everything is on the dashboard: **Clip**, **Drop**, **Notes**, **Train**.

On the Asus you are in a tmux pane, and reaching for a browser is friction, so
the same operations have a CLI:

```bash
echo "100.69.221.23" | trainwatch clip     # push stdin
trainwatch clip                             # print the latest
trainwatch clip --to-os                     # ...and into the OS clipboard
trainwatch clip --from-os                   # push the OS clipboard
trainwatch clip -l                          # history
trainwatch clip --secret --text "$TOKEN"    # redacted, expires in 15 min
trainwatch send plot.png                    # upload a file
trainwatch open https://arxiv.org/abs/...   # push a link
trainwatch hub                              # what is stored, who is online
```

On a machine that is a *client* rather than the host, point it at the hub:

```bash
# in .env on the Asus, if the hub runs on the MacBook
TRAINWATCH_HUB=https://sais-macbook-pro.tail1f999f.ts.net
```

### There is deliberately no clipboard-watching daemon

An `--auto` mode that mirrors your OS clipboard continuously would be the
convenient thing. It would also capture **every password you ever copy**, into
a searchable archive, forever. Pushes are explicit for that reason.

---

## Security

A shared clipboard history is a credential honeypot by construction — yours will
accumulate `WANDB_API_KEY`, your ntfy topic, tailnet addresses, GitHub tokens.
[ADR-0003](adr/0003-writable-hub-and-browser-threat-model.md) has the full threat
model; the short version:

**The threat is not the tailnet — it is any web page open in Safari**, because
its JavaScript can reach `http://100.x.y.z:8730` as easily as the dashboard can.

| Attack | Control |
|---|---|
| A page you visit POSTs to the hub and poisons your clipboard (CSRF) | `Origin` checked on every write; a custom `X-Trainwatch` header forces a preflight that is never answered |
| A page re-resolves its own domain to your tailnet IP and **reads** your history (DNS rebinding) | **`Host` header allowlist** — the one control that actually closes this. Auto-detected from Tailscale |
| An uploaded `.html`/`.svg` runs script on the dashboard's origin | only allowlisted raster images are served inline; everything else is forced to download as `octet-stream`, with `nosniff` and a locked CSP |
| Credentials sitting in history forever | `secret` entries are redacted in listings, excluded from search, never logged, and expire in 15 minutes. Everything expires unless pinned |

Optional, off by default because it is a one-person tailnet:

```bash
TRAINWATCH_TOKEN=$(python -c "import secrets; print(secrets.token_urlsafe(24))")
```

That gates **writes** only; reads stay open.

### If you see a 421

```json
{ "error": "unrecognised Host header", "got": "…", "allowed": [ … ] }
```

Working as designed — that is the rebinding guard. You reached the dashboard by
a name it does not know. Add it:

```bash
TRAINWATCH_ALLOWED_HOSTS=my-alias,another-name
```

---

## Verifying it properly

```bash
trainwatch doctor          # all four monitoring layers
trainwatch hub             # hub contents + who is online
```

Then the two tests that actually prove it:

1. **Load the dashboard on the iPad over cellular with wifi off.** Both devices
   on home wifi can succeed for the wrong reason.
2. **Copy on the Asus, paste on the iPad.** `echo hi | trainwatch clip` in a
   tmux pane, then tap Copy on the iPad. That is the leg nothing else does.
