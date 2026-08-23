# Remote Training Monitoring — Setup Guide

Monitoring a training run on a headless box (Asus TUF / CUDA node) from a thin client (iPad, phone), without babysitting a terminal.

---

## The Pattern

Every remote monitoring setup is four layers. Build them in dependency order, not in the order they seem interesting.

| Layer | Question it answers | Fails if you skip it |
|---|---|---|
| **Reach** | Can the client address the box from any network? | LAN-locked; dies when you leave the apartment |
| **Persist** | Does the run survive the SSH session dying? | Wifi hiccup kills a 6-hour run |
| **Emit** | What is the run telling me? | You have a terminal but no signal |
| **Notify** | How do I learn it broke without watching? | You sit staring at a dashboard |

Most setups build 1–3 and stop. On a tablet, **layer 4 is the entire point** — the device is for being interrupted, not for staring.

---

## Layer 0 — Reach

**Tailscale** on every device: MacBook, Asus, iPad, iPhone.

- Free tier covers personal use
- Native iPadOS/iOS app
- Every machine gets a stable `100.x.y.z` that works on campus wifi, home, or cellular
- No port forwarding, no dynamic DNS, no chasing a changing IP

```bash
# On the Asus (Linux / WSL2)
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
tailscale ip -4        # note this address
```

Optional but worth it: enable MagicDNS so you address the box as `asus` instead of memorizing an IP.

**Verify before moving on:** SSH from the iPad over *cellular*, wifi off. If that fails, nothing downstream matters.

---

## Layer 1 — Persist

`tmux` on the training box. Detach the session from the connection so the run outlives the SSH pipe.

```bash
tmux new -s train          # create
python train.py            # launch inside it
# Ctrl-b then d            # detach — run keeps going

tmux a -t train            # reattach from anywhere
tmux ls                    # list live sessions
```

Useful split for a single session:

```bash
# Ctrl-b then %   → vertical split
# pane 0: training output
# pane 1: watch -n 2 nvidia-smi
```

**Windows note:** if the Asus is on Windows, do all of this inside **WSL2 with CUDA passthrough**. Native Windows Python has no clean tmux equivalent and you will spend the afternoon fighting it instead of training.

**Persist the logs too** — tmux scrollback is not storage:

```bash
python train.py 2>&1 | tee -a logs/run_$(date +%Y%m%d_%H%M).log
```

---

## Layer 2 — Emit

Two independent streams. Conflating them is a common mistake — when step time degrades you need to know whether it's the model or the machine.

### 2a. Scalars — training signal

W&B or TensorBoard. Log with **structured keys** so per-layer series group correctly in the dashboard:

```python
wandb.log(
    {
        "loss": loss.item(),
        "grad_norm": total_norm,
        "lr": scheduler.get_last_lr()[0],
        # per-layer — grouped by prefix
        **{f"resid_rms/layer_{i}": v for i, v in enumerate(resid_rms)},
        **{f"attn_logit_max/layer_{i}": v for i, v in enumerate(logit_max)},
        "entropy": policy_entropy,
    },
    step=global_step,
)
```

For a training-dynamics track, the minimum viable panel set:

- `loss`, `grad_norm`, `lr`
- `resid_rms/*` — per-layer activation scale (drift = instability incoming)
- `attn_logit_max/*` — spike detection
- `entropy` — collapse detection on RL runs
- `step_time` — the canary for everything else

TensorBoard alternative if you want zero external services (local-first):

```bash
tensorboard --logdir runs/ --host 0.0.0.0 --port 6006
# reach it at http://<tailscale-ip>:6006 from the iPad browser
```

Tailscale makes `--host 0.0.0.0` safe here — the port is only exposed on the tailnet, not the public internet.

### 2b. Machine health — hardware signal

```bash
nvidia-smi dmon -s pucvmet     # Asus: power, util, clocks, mem, temp
asitop                          # Mac: unified memory + power + throttle state
```

Thermal throttling on a laptop chassis will silently distort step-time comparisons across runs. If you're benchmarking anything, log GPU temp and clock alongside the metrics — otherwise "the change made it slower" may just mean "the room got warmer."

---

## Layer 3 — Notify

The layer that makes this usable from a tablet.

### ntfy.sh — cheapest version

iOS app, one HTTP call, self-hostable if you want it fully local.

```bash
curl -d "NaN loss @ step 4200" \
     -H "Title: run_042 FAILED" \
     -H "Priority: urgent" \
     -H "Tags: warning" \
     ntfy.sh/your-private-topic-name
```

Pick an unguessable topic name — public ntfy topics are readable by anyone who knows the string.

### Watchdog — what to fire on

```python
import requests

TOPIC = "https://ntfy.sh/your-private-topic-name"


def alert(msg, priority="default"):
    try:
        requests.post(TOPIC, data=msg.encode(), headers={"Priority": priority}, timeout=5)
    except Exception:
        pass  # never let the alerter kill the run


# inside the training loop
if not torch.isfinite(loss):
    alert(f"NaN/inf loss @ step {step}", "urgent")
    raise RuntimeError("loss diverged")

if total_norm > GRAD_NORM_CEIL:
    alert(f"grad norm {total_norm:.1f} @ step {step}", "high")

if entropy < ENTROPY_FLOOR:
    alert(f"entropy collapse {entropy:.3f} @ step {step}", "high")
```

### The alert people forget: the heartbeat

Catches hangs, OOM kills, and dead processes — failure modes that produce *no* error because nothing is running to produce one.

```python
# emit every N steps
open("/tmp/heartbeat", "w").write(str(time.time()))
```

```bash
# external cron — checks liveness, every 10 min
*/10 * * * * [ $(( $(date +%s) - $(cat /tmp/heartbeat) )) -gt 900 ] \
  && curl -d "no heartbeat in 15min — run may be dead" ntfy.sh/your-topic
```

Alert on **absence of progress**, not just on bad values. Most silent failures are silent.

### If already on W&B

```python
wandb.alert(title="Grad norm spike", text=f"{total_norm:.1f} @ {step}", level=wandb.AlertLevel.WARN)
```

Same idea, one less service to run.

---

## Layer 4 — Client

On the iPad:

| Need | Tool |
|---|---|
| SSH / tmux | Blink Shell or Termius |
| Dashboards | Safari → `http://<tailscale-ip>:6006` or wandb.ai |
| Alerts | ntfy iOS app |
| Second display at desk | Sidecar |

Blink is worth the money for one feature: **Mosh support**, which survives network changes. Standard SSH drops when you switch from wifi to cellular; Mosh doesn't.

---

## Build Order

1. Tailscale on all devices → verify SSH from iPad over cellular
2. tmux on the training box → verify a run survives disconnect
3. SSH client on iPad → **useful capability starts here**
4. W&B / TensorBoard emit
5. ntfy + watchdog + heartbeat → **hands-off starts here**

Steps 1–3 give you a remote terminal. Steps 4–5 are what let you stop looking at it.

---

## Failure Modes to Expect

| Symptom | Likely cause |
|---|---|
| SSH works at home, not on campus | Campus wifi client isolation → Tailscale fixes; verify on cellular |
| Run dies when iPad sleeps | Not in tmux, or launched in a subshell that got SIGHUP |
| Dashboard blank remotely | Bound to `127.0.0.1` instead of `0.0.0.0` |
| Alerts never arrive | iOS killed the ntfy app's background refresh — check notification permissions |
| Step time drifts upward across runs | Thermal throttle, not your code — check logged GPU clock |
| No alert on a dead run | Missing heartbeat check; value-based alerts can't fire if nothing runs |

---

## Minimum Viable Version

If you want this working in 20 minutes and nothing more:

```bash
# 1. Tailscale on Asus + iPad
# 2.
tmux new -s train
python train.py 2>&1 | tee logs/run.log
# 3. add three lines to the loop:
#    - NaN check       → alert()
#    - heartbeat write → /tmp/heartbeat
#    - cron liveness check
```

That covers the two failures that actually cost you a night: divergence and silent death.
