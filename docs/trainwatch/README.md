# trainwatch

> **Folded into ULTRON.** trainwatch was its own repository at `Monitoring/`,
> installed editable as a distribution. It is now first-party ULTRON source at
> `src/trainwatch/`, and this document is kept as its reference manual. Three
> things changed, and nothing else:
>
> | Was | Now |
> |---|---|
> | `pip install -e ./Monitoring` | nothing to install — it is source in this repo |
> | `from trainwatch import TrainMonitor` | `from src.trainwatch import TrainMonitor`, or `from src.train.monitor import ultron_monitor` (preferred — see `docs/BUILDING-ULTRON.md` Step 7.2b) |
> | `trainwatch <cmd>` (console script) | `scripts/trainwatch <cmd>`, or `python -m src.trainwatch <cmd>` |
>
> Bare `trainwatch <cmd>` in the examples below still works if you put the
> wrapper on your PATH: `export PATH="$PWD/scripts:$PATH"`.
>
> Also dropped in the move: the WSL2/Windows bootstrap scripts and
> `docs/wsl2-performance.md` (the TUF runs native Ubuntu now — see
> `docs/WINDOWS-TO-UBUNTU.md`), and the GitHub Actions workflow. The one CI check
> worth keeping, that the core stays free of third-party imports, is now a test:
> `src/trainwatch/tests/test_zero_dependency_core.py`.

Watch a training run on a headless Windows/CUDA box from an iPad — and move
text, files and links between a Linux box and Apple devices — without
babysitting a terminal or installing anything on the clients.

This is a working implementation of [`remote-training-monitoring.md`](remote-training-monitoring.md) —
its four layers (Reach → Persist → Emit → Notify), built in dependency order, plus
the thing the guide says is the entire point on a tablet: **a client you can be
interrupted by rather than one you have to stare at.**

```
 Asus (Windows → WSL2 + CUDA)                              iPad
┌──────────────────────────────────┐                    ┌──────────────┐
│ tmux: python train.py            │                    │ Safari       │
│   └─ TrainMonitor ──┬─ store ────┼── sqlite (WAL) ──┐ │  dashboard   │
│                     ├─ tensorboard│                 │ │              │
│                     └─ wandb      │   ┌─────────────▼─┼─ :8730       │
│                                   │   │ trainwatch    │ │            │
│ heartbeat ──────────────────────► │   │  serve        │ └──────────────┘
│                                   │   │  + gpu sampler│    ntfy app  ◄── alerts
│ cron: trainwatch liveness ────────┼───┴───────────────┘        ▲
└───────────────────────────────────┘                            │
                    all of it over Tailscale ────────────────────┘
```

---

## Two halves

**Monitoring** (read-only) implements the guide's four layers. **The device hub**
(read/write) is a private clipboard, file drop, link push and scratchpad across
every device — the thing that makes the Linux box a first-class member of an
otherwise Apple-only ecosystem.

They share a tailnet and a SQLite file, and nothing else.

```
Clip  ·  Drop  ·  Notes        Train
└──── the device hub ────┘     └─ telemetry ─┘
      read / write               read-only
```

Universal Clipboard and AirDrop already cover Mac↔iPad↔iPhone, and cover it
better. What they cannot do is include a Linux box, and what they do not do at
all is keep **history** or survive a sleeping device. That is the gap this fills
— see [docs/private-network.md](docs/private-network.md).

## What you get

| Layer | The guide says | What's here |
|---|---|---|
| **0 · Reach** | Tailscale everywhere | [`scripts/tailscale-up.sh`](scripts/tailscale-up.sh), verified-over-cellular checklist |
| **1 · Persist** | tmux, and log to disk | [`scripts/train-session.sh`](scripts/train-session.sh) — 3-pane session, `tee`'d logs, survives disconnect |
| **2 · Emit** | scalars + machine health, kept separate | `TrainMonitor.log()` fans out to SQLite + TensorBoard + W&B; a GPU sampler records temp/clock/power alongside |
| **3 · Notify** | ntfy + watchdog + **heartbeat** | Async non-blocking notifier, 6 watchdog rules, atomic heartbeat, out-of-process liveness cron |
| **4 · Client** | SSH, dashboards, alerts | A touch-first dashboard built for the iPad, served from the box over Tailscale |
| **+ Hub** | — | Shared clipboard with history, file/image drop, link push, notes, device presence — over Tailscale HTTPS, no client app |

**The core imports nothing outside the standard library.** FastAPI, TensorBoard
and W&B are optional extras. Your training environment installs nothing it
doesn't already have, and a monitoring library can never be the reason a 6-hour
run fails to start. See [ADR-0001](adr/0001-stack-and-architecture.md).

---

## Quickstart

### On the training box

Nothing to install beyond ULTRON's own environment — trainwatch's core has no
dependencies, and the dashboard's three (`fastapi`, `uvicorn`,
`python-multipart`) are in `requirements/cuda.txt`, because the server runs on
the box doing the training.

```bash
cp .env.example .env          # then set TRAINWATCH_DB and TRAINWATCH_NTFY_TOPIC
scripts/trainwatch doctor     # diagnoses all four layers, non-zero if broken
```

Generate an unguessable ntfy topic — a public one is readable by anyone who
knows the string:

```bash
python -c "import secrets; print('trainwatch-' + secrets.token_urlsafe(16))"
```

### In your training loop

In ULTRON, go through `src/train/monitor.py` rather than constructing a
`TrainMonitor` directly — it adds phase-aware run naming, the HF/TRL callback,
and the degrade-to-no-op fallback. The raw API, for reference:

```python
from src.trainwatch import TrainMonitor

with TrainMonitor("run_042", meta={"model": "gpt-small", "bs": 32}) as tw:
    for step in range(total_steps):
        loss, grad_norm = train_step()
        tw.log(
            {
                "loss": loss,
                "grad_norm": grad_norm,
                "lr": scheduler.get_last_lr()[0],
                **{f"resid_rms/layer_{i}": v for i, v in enumerate(resid_rms)},
                "entropy": policy_entropy,
            },
            step=step,
        )
```

That one call writes every sink, runs the watchdog, emits the heartbeat, and
pushes alerts. `step_time` is measured for you. The `with` block catches CUDA
OOM / dataloader crashes / NCCL timeouts and pages you instead of leaving a dead
tmux pane.

### Start the dashboard

```bash
scripts/trainwatch serve
```

Then on the iPad: `http://<tailscale-ip>:8730`. Add it to the Home Screen — it's
a PWA, so it opens full-screen with no browser chrome.

### Arm the liveness check

```bash
bash scripts/install-liveness-cron.sh
```

Every 10 minutes, out of process, it asks *"has this run made progress?"* — the
only check that can fire when the trainer is hung, OOM-killed, or dead.

---

## Build order

The guide's order, because each layer is worthless without the one below it:

1. **Tailscale on all devices** → verify SSH from the iPad **over cellular, wifi off**. If that fails, nothing downstream matters.
2. **tmux on the box** → verify a run survives a disconnect.
3. **SSH client on the iPad** → *useful capability starts here.*
4. **Emit** → `TrainMonitor` in the loop; `trainwatch serve` for the dashboard.
5. **ntfy + watchdog + heartbeat** → *hands-off starts here.*

Steps 1–3 give you a remote terminal. Steps 4–5 are what let you stop looking at it.

### 20-minute version

```bash
tmux new -s train
python train.py 2>&1 | tee logs/run.log
# + wrap the loop in TrainMonitor  + install the liveness cron
```

Covers the two failures that actually cost you a night: divergence and silent death.

---

## The watchdog

| Rule | Fires when | Priority |
|---|---|---|
| `nonfinite` | any scalar is NaN/inf | **urgent** — aborts the run by default |
| `grad_norm` | above `TRAINWATCH_GRAD_NORM_CEIL` | high |
| `entropy` | below `TRAINWATCH_ENTROPY_FLOOR` (RL collapse) | high |
| `resid_rms` | peak per-layer activation scale drifts ≥3× its own baseline | high |
| `attn_logit_max` | attention logits spike past the ceiling | high |
| `step_time` | rolling median drifts ≥1.5× the run's baseline | default |
| *liveness* | no heartbeat in `TRAINWATCH_HEARTBEAT_TIMEOUT` — **runs from cron** | urgent |

The last two are the ones fixed thresholds can't express. Step time has no
universal "normal", so it's measured against the run's own warmed-up baseline;
and when it drifts, the alert tells you to check GPU clock before blaming your
code — because on a laptop chassis it's usually thermal throttle.

Alerts are deduped per rule (120s cooldown) and globally capped at 12/minute, so
a diverging run buzzes your phone once, not a thousand times.

---

## Commands

```bash
trainwatch serve                # dashboard + API on :8730
trainwatch share                # ...behind Tailscale's HTTPS cert (needed for clipboard)
trainwatch doctor               # diagnose all four layers, exit non-zero if broken
trainwatch doctor --send-test   # ...and actually push a test alert to your iPad
trainwatch liveness             # one-shot heartbeat check (this is the cron entry)
trainwatch demo                 # synthetic run that diverges, to test the whole chain
trainwatch gpu                  # one-shot GPU snapshot (temp, clock, throttle)
trainwatch tensorboard          # tensorboard bound correctly for remote access
trainwatch prune --days 30      # trim old telemetry

echo "100.69.221.23" | trainwatch clip     # push to the shared clipboard
trainwatch clip --to-os                     # pull the latest into the OS clipboard
trainwatch clip -l                          # history
trainwatch send plot.png                    # upload a file
trainwatch open https://arxiv.org/abs/...   # push a link to a device
trainwatch hub                              # what's stored, who's online
```

`trainwatch share` matters more than it looks: `navigator.clipboard` only exists
in a secure context, so without HTTPS the one-tap copy buttons silently do
nothing. Tailscale issues a real certificate for your MagicDNS name — no domain,
nothing to install on any device.

Start with `trainwatch doctor` whenever something isn't arriving. `trainwatch demo`
is the fastest way to prove the whole chain works before you trust it with a real
run — it diverges on purpose and should light up your phone.

---

## Documentation

| | |
|---|---|
| **[SUMMARY.md](SUMMARY.md)** | **Start here** — project state, what needs your attention, what to do next |
| [ipad-client.md](ipad-client.md) | Blink/Termius, Mosh vs SSH, PWA install, iOS notification permissions |
| [private-network.md](private-network.md) | The private network + hub: setup, what it actually buys you, and the browser threat model |
| [runbook.md](runbook.md) | Every failure mode in the guide, with the diagnostic that distinguishes them |
| [adr/](adr/) | Why it's built this way, and which risks were accepted |

---

## Development

Run from the ULTRON repository root, in ULTRON's venv:

```bash
pytest src/trainwatch/tests            # 248 tests
ruff check src/trainwatch              # strict set, via src/trainwatch/ruff.toml
mypy                                   # strict, scoped to src/trainwatch
cd dashboard && npm ci && npm run build   # rebuilds the committed static bundle
```

The dashboard is committed pre-built to `src/trainwatch/server/static/`, so the
training box never needs Node. **There is no CI any more** — the check that the
bundle is stale went with the workflow, so if you change `dashboard/` you must
re-run the build and commit the diff yourself.

Fonts are vendored locally (`dashboard/public/fonts/`) rather than pulled from a
CDN, so the dashboard renders identically on a box with no outbound internet and
on an iPad behind a captive portal. Re-vendor with:

```bash
python scripts/vendor-fonts.py
```

### Quality gates

| Gate | Command | State |
|---|---|---|
| Lint + format | `uv run ruff check . && uv run ruff format --check .` | clean |
| Types | `uv run mypy` (strict) | clean |
| Tests | `uv run pytest --cov` | 239 passing, 84% |
| Dashboard types | `npm run typecheck` | clean |
| Dependencies | `npm audit` | 0 vulnerabilities |

Decisions and accepted risks live in [docs/adr/](docs/adr/). The one to read is
[ADR-0003](docs/adr/0003-writable-hub-and-browser-threat-model.md): adding write
endpoints tripped a trip-wire written into ADR-0002, so the security posture was
re-derived rather than extended. Its conclusion is that for a private-IP service
**the browser is the threat model, not the tailnet** — any page open in Safari
can reach `100.x.y.z:8730` too.

## License

MIT
