# Handoff Protocol — TUF ⇄ Mac

Neither machine can do the whole job. **Together they cover all of it.**

---

## The two machines

### THE CLASSROOM — Asus TUF A17 · Ubuntu 26.04 · RTX 3050 4 GB

- CUDA — the real industry stack runs here
- bitsandbytes, Unsloth, TRL, PEFT, Flash Attention 2
- Linux keeps ~3.95 of the 4 GB free — no compositor tax
- 0.5B QLoRA comfortably; 1.5B workable with Unsloth
- 512 GB root + 1 TB `/data` · **16 GB RAM is the real ceiling**

### THE WORKSHOP — MacBook Pro · M5 Pro · 48 GB unified · 3 TB

- Data pipeline, eval harness, sandbox — CPU/RAM bound
- 14B–30B quantized inference: **the teacher model**
- MLX for local training and serving
- No CUDA: no bitsandbytes, Unsloth, vLLM, or DeepSpeed
- 48 GB unified runs teachers most single GPUs cannot

### The three rules

1. **The Mac owns data.** 16 GB will not hold a deduplication index.
2. **The TUF owns training.** It is the only CUDA you have.
3. **Prototype at 0.5B before anything else.** Always.

---

## Division of labour

| Work | Machine | Why |
|---|---|---|
| QLoRA training, all phases | **TUF** | Only CUDA box |
| DPO / GRPO runs | **TUF** | Needs bitsandbytes + TRL kernels |
| Bulk / unattended sandbox execution | **TUF** | Docker is ~50 ms on Linux vs 1–3 s on the Mac VM |
| Data pipeline: dedup, decontamination, filtering | **Mac** | RAM-bound; 48 GB beats 16 GB |
| Teacher generation (14B quantized) | **Mac** | 4 GB cannot hold a 14B model |
| Eval harness + interactive sandbox work | **Mac** | CPU-bound, and keeps the GPU free |
| Merging / quantization | **Mac** | CPU work |

> **If a task is RAM-hungry or needs a big model for inference, it goes to the Mac.**
> Do not try to squeeze it onto 4 GB.

---

## The distillation rig

Your two machines are already a verified-distillation pipeline.

| Stage | Machine | What happens |
|---|---|---|
| **GENERATE** | **Mac** | 14B teacher, 4-bit, produces N candidates per problem. **Runs overnight.** |
| **VERIFY** | **Mac** | Sandbox executes all candidates. Keeps only verified passers. |
| **CURATE** | **Mac** | Dedup, stratify, cap per problem, write a new data version. |
| **TRAIN** | **TUF** | 0.5B student, QLoRA, on the verified set. **Twenty minutes.** |
| **EVAL** | **Mac** | Harness scores the student on held-out problems. |

- **The teacher never trains.** It only needs to be occasionally right. All the quality comes from
  the verifier, not the teacher.
- **Why it beats plain SFT:** every training example is known-correct, not merely plausible. No noisy
  labels at all.
- **Why it beats the teacher:** the student learns the teacher's successes without its failures.
  The filter is the whole trick.
- **Same tokenizer family matters** — Qwen teacher, Qwen student.

> **Generation is the bottleneck, not training.** A 20-minute training run consumes data that took
> **eight hours** to generate. Plan around that asymmetry.

**The daily rhythm:** kick off generation before bed · curate over coffee · train before lunch ·
evaluate after · read rollouts in the evening.

**Never leave one machine idle waiting on the other.** The Mac generates while the TUF trains and executes.

---

## Remote access — drive the TUF from the Mac

The TUF's job is to sit on the desk and train. You sit at the Mac.

### On the TUF

```bash
sudo apt install -y openssh-server avahi-daemon
```

```bash
sudo hostnamectl set-hostname tuf
```

```bash
sudo systemctl enable --now ssh && systemctl status ssh --no-pager
```

`avahi-daemon` publishes `tuf.local` over mDNS, which macOS resolves natively via Bonjour — no
static IP, no router config.

### On the Mac

```bash
ssh-copy-id <user>@tuf.local
```

Add to `~/.ssh/config`:

```
Host tuf
    HostName tuf.local
    User <user>
    ServerAliveInterval 30
    ServerAliveCountMax 6
```

### ⚠️ Stop the laptop suspending — the trap that kills training runs

**Closing the lid suspends it** — and takes your 8-hour GRPO run with it.

```bash
sudo sed -i 's/^#*HandleLidSwitch=.*/HandleLidSwitch=ignore/' /etc/systemd/logind.conf
```

```bash
sudo sed -i 's/^#*HandleLidSwitchExternalPower=.*/HandleLidSwitchExternalPower=ignore/' /etc/systemd/logind.conf
```

Reboot to apply. Then **Settings → Power → Automatic Suspend → Off**. Screen blanking is fine;
*suspend* is what must be disabled. Verify you get `'nothing'`:

```bash
systemctl status sleep.target --no-pager && gsettings get org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type
```

### tmux — the single most important habit

If you SSH in, launch a training run, and close the Mac, **the run dies with the session.**

```bash
ssh tuf -t 'tmux new -A -s train'
```

`new -A` means attach-if-exists, create-if-not. Detach with **Ctrl+B** then **D**. Close the Mac,
walk away, reattach tomorrow with the same command and the run is still going.

> Get this wrong once on a GRPO run and you lose a night.

---

## Moving data

**Datasets out (Mac → TUF):**

```bash
rsync -avz --partial --progress ~/ULTRON/data/processed/ tuf:/data/datasets/
```

**Adapters back (TUF → Mac):**

```bash
rsync -avz --partial --progress tuf:/data/runs/ ~/ULTRON/results/runs/
```

LoRA adapters are 20–200 MB, so pulling checkpoints back is cheap and you should do it often — the
Mac is where eval and merging happen.

### The rules of exchange

| Artifact | Direction | Mechanism | Notes |
|---|---|---|---|
| Code | Mac → TUF | **git** (push from Mac, pull on TUF) | Never rsync code both ways |
| Training shards | Mac → TUF | `rsync` | Copy only what a run needs. Mac stays source of truth. |
| LoRA adapters | TUF → Mac | `rsync` | Pull often. Tens of MB. |
| Rollouts / logs | TUF → Mac | `rsync` | Compress old ones |
| Conda environments | **Never** | — | Recreate from `requirements.txt` |
| `.git` directories | **Never** | — | Use git remotes |
| Merged full models | **Never stored** | — | Regenerate from adapter + base |

> **Never rsync conda environments or `.git` directories between machines.** Environments contain
> absolute paths and platform-specific binaries. For code, use git — push from the Mac, pull on the
> TUF — or edit directly on the TUF with a remote IDE. **Rsyncing code in both directions creates
> divergence you will not notice until it costs you an experiment.**

---

## Editing code on the TUF

| Tool | Works? |
|---|---|
| **VS Code Remote-SSH** | Yes, free. Full IDE against the TUF's filesystem, integrated terminal, automatic port forwarding. **The default recommendation.** |
| **PyCharm Professional** | Yes — SSH interpreter or JetBrains Gateway. |
| **PyCharm Community** | **No.** Remote interpreters are Professional-only. |

Given these projects live under `PycharmProjects`, that last row matters: on Community, VS Code
Remote-SSH is the free path to remote development.

---

## Monitoring a run

**W&B is the real answer** — metrics land in the browser on the Mac with no SSH session open at all.

```bash
ssh tuf -t nvtop
```

```bash
ssh -L 8888:localhost:8888 tuf
```

That forward lets Jupyter or TensorBoard on the TUF open in the Mac's browser at `localhost:8888`.

**Remote desktop is rarely needed.** Ubuntu 26.04 has RDP built in (Settings → Sharing → Remote
Desktop), but a remote desktop session puts load on the GPU you are trying to keep free.

---

## Repo structure — identical on both machines

```
ULTRON/
├── data/
│   ├── raw/          downloaded, never modified
│   ├── interim/      filtered, deduped, decontam.
│   └── processed/    templated, versioned v1..vN
├── src/
│   ├── sandbox/      executor.py  ← trust boundary
│   ├── data/         download filter dedup synth
│   ├── eval/         harness.py  pass_at_k.py
│   ├── train/        sft rft dpo grpo repair
│   └── serve/        mlx / llama.cpp entrypoints
├── configs/          ONE YAML PER EXPERIMENT
├── results/          NN-phase.md  numbers + seeds
├── checkpoints/      adapters only, not full models
└── notebooks/        scratch only, never canonical
```

- **`data/` is append-only.** `raw/` is never edited. Every transformation writes a new directory.
  Disk is cheap; a lost provenance chain is not.
- **`configs/` IS the lab notebook.** If an experiment is not a committed config file, it did not
  happen and cannot be reproduced.
- **`results/` is written by hand.** One markdown file per phase, with numbers, seeds, and what
  failed. Your future self reads only this.
- **`checkpoints/` holds adapters.** Never commit merged full models.

> Two directories carry the whole project: **`configs/` tells you what you ran, `results/` tells you
> what happened.** Everything else is regenerable.

### One config per experiment

```yaml
# configs/06-sft-r16-lr2e4.yaml
base_model: Qwen/Qwen2.5-Coder-0.5B
data_version: v3-curated-10k
template: qwen-chatml-v1

lora:
  r: 16
  alpha: 32
  dropout: 0.05
  target: all-linear

train:
  lr: 2.0e-4
  epochs: 2
  seq_len: 512
  batch: 1
  grad_accum: 16
  seed: [0, 1, 2]
```

- **Every field matters.** `data_version` and `template` are as load-bearing as the learning rate.
- **Seeds are a list.** Three seeds is the minimum honest experiment. Bake it into the config so you
  cannot forget.
- **Name files by what changed.** `06-sft-r16-lr2e4` names the phase and the variable. You will have
  two hundred of these.
- **Commit before running.** A config committed after the fact is a reconstruction, not a record.

---

## One OS family, one codebase

Both machines are POSIX, so the sandbox and harness run **unmodified** on either.
No branch, no WSL, no second code path.
