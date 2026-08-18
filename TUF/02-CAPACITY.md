# Capacity — what fits on this box, and what does not

Assume these numbers. **Do not re-derive them.**

---

## The machine

| | |
|---|---|
| **Box** | Asus TUF A17 |
| **GPU** | NVIDIA RTX 3050 Laptop — **4 GB VRAM**, Ampere (GA107, `sm_86`) |
| **CPU** | AMD Ryzen 7 4800H — 8 cores / 16 threads (Zen 2, x86-64) |
| **RAM** | **16 GB** system — **14 Gi usable**, the iGPU reserves ~2 GB (measured 2026-08-17) |
| **OS** | Ubuntu 26.04 LTS, ext4, no encryption |
| **Disks** | 512 GB ext4 root (`/`) — holds everything incl. `/data`. 1 TB is **NTFS**, 577 GB of unrelated data, not used by ULTRON (measured 2026-08-17) |
| **Network** | Realtek RTL8111/8168 Ethernet (`r8169`). Wi-Fi does not enumerate — see [01-SETUP.md](01-SETUP.md) Step 3 |
| **Role** | **The CUDA machine.** All GPU training happens here. |

**Ampere matters.** `sm_86` means bf16, TF32, and Flash Attention 2 all work. Use them.

### The two hard ceilings, in the order they bite

1. **16 GB system RAM** — usually the *actual* constraint. Dataset loading, dedup indices, and
   tokenization blow this before VRAM is touched. **Stream datasets; never `load_dataset(...)` a
   large corpus without `streaming=True`.**
2. **4 GB VRAM** — caps model size. Activations (`seq_len × batch`) dominate, not weights.

---

## What trains here

QLoRA + Unsloth, bf16, gradient checkpointing on.

> **0.5B is the dev loop; 1.5B is the ship target.** Build the pipeline and run every ablation at
> 0.5B where a run is 20–40 min. Re-run the settled recipe at 1.5B **once** (2–3 hours) and quantize
> to Q4_K_M. GRPO in particular is only comfortable at 0.5B on this card.

| Model | seq_len | batch | grad_accum | Status |
|---|---|---|---|---|
| **Qwen2.5-Coder-0.5B** | 1024 | 2 | 8 | Comfortable — **the dev loop.** 20–40 min/run |
| **Qwen2.5-Coder-0.5B** | 2048 | 1 | 16 | Fine |
| **Qwen2.5-Coder-1.5B** | 512 | 1 | 16 | Tight but works. **Unsloth required.** ← ship target |
| **Qwen2.5-Coder-1.5B** | 1024 | 1 | 16 | Marginal — expect to tune |
| **Qwen2.5-Coder-3B** | 256 | 1 | 32 | Marginal at best. Usually not worth it. |
| **Anything ≥ 7B** | — | — | — | **Does not train here. Do not propose it.** |

## What infers here

### Measured — 1.5B GGUF, llama.cpp, `-ngl 99` (2026-08-18)

| Model / format | VRAM loaded | VRAM @ 32K ctx | Decode (short) | Verdict |
|---|---|---|---|---|
| **1.5B Q4_K_M** (986 MB) | **1,394 MiB** | **2,124 MiB** | **116.4 tok/s** | Comfortable — ~1.8 GB spare even at 32K context |
| **1.5B Q8_0** (1.6 GB) | 2,024 MiB | 2,654 MiB | 91.2 tok/s | Fits, but Q4_K_M is faster *and* smaller. No reason to ship it. |

Full benchmark including prefill, long-context, and CPU-only figures is in [STATUS.md](STATUS.md).

### Still estimated — not yet measured

- **0.5B Q4_K_M ≈ 300–400 MB** — trivially fits. Even F16 (~1.0 GB) fits with room.
- **3B in 4-bit ≈ 1.8 GB** — fits with room for context.
- **7B in 4-bit ≈ 4 GB** — **does not fit** once you add KV cache. Use the Mac.

### Decode and prefill have different bottlenecks

This is the most useful thing the benchmark showed, and it is not obvious:

| | Bound by | Does quantization help? | Measured |
|---|---|---|---|
| **Decode** | Memory bandwidth | **Yes** — roughly in proportion to bytes read | Q4_K_M is **20–28% faster** than Q8_0 |
| **Prefill** | Compute | **No** — dequantization becomes pure overhead | Q8_0 is **3.9% faster** at 5k, tied at 20k |

Effective bandwidth achieved: **Q8_0 ~146 GB/s (76% of the 3050's ~192 GB/s peak)**, Q4_K_M
**~115 GB/s (60%)**. Q4_K_M gives up ~16% of peak to K-quant unpacking — which is why its speedup is
1.28×, not the 1.62× the file-size ratio would predict.

**Practical consequence:** long-prompt / short-completion workloads gain almost nothing in *speed*
from quantization, only footprint. GRPO rollouts (short prompt, 384-token completion) sit in the
decode-bound regime, so Q4 wins there.

> ⚠️ **llama.cpp decode speed does not transfer to the TRL training loop.** GRPO rollouts go through
> HF `generate`, which is substantially slower than llama.cpp unbatched. Do not use 116 tok/s to
> estimate GRPO wall-clock — measure that separately.

> **"Does not fit" means "gets slow", not "crashes".** llama.cpp offloads per-layer: `-ngl 20` puts
> 20 layers on the GPU and the rest on the Ryzen. Measured CPU-only decode is 24.8 tok/s (Q4_K_M) vs
> 116.4 on GPU — a 4.7× gap. Fine for a one-off check, useless for a bulk generation loop.

## The VRAM budget at 0.5B QLoRA

```
base weights (NF4)      0.28 GB
LoRA + grads + optim    0.03 GB
activations (512×1)     0.35 GB
CUDA context + frag     0.60 GB
                        --------
                      ~ 1.3 GB   → ~2.7 GB headroom on a clean card
```

Full line-by-line table including 1.5B is in [05-CONFIGS.md](05-CONFIGS.md).

> **Close the browser before training.** A few Chrome tabs is 400–800 MB — 10–20% of the budget.

---

## Freeing the card — the reason this box runs Linux

On a 4 GB card, half a gigabyte is 12% of your entire budget.

| Setup | Idle VRAM held | Usable for training | Notes |
|---|---|---|---|
| Windows 11 + browser open | 500–1000 MB | ~3.0–3.5 GB | DWM compositor + browser GPU process |
| Ubuntu, desktop on dGPU | 150–300 MB | ~3.7 GB | Avoid — no reason to drive the display from the 3050 |
| **Ubuntu, hybrid (display on iGPU)** | **5–20 MB** | **~3.95 GB** | The target. |
| **This box, as measured 2026-08-17** | ⚠️ **79 MiB** | ~3.87 GB | `display_active: Enabled` — something is on the dGPU. See STATUS open question 4. |
| Ubuntu, TTY only (Ctrl+Alt+F3) | ~5 MB | ~3.95 GB | Marginal further gain; useful for the longest runs |

```bash
nvidia-smi --query-gpu=memory.used,memory.total --format=csv
```

Verify before **every** long run. You want single-digit MB used, not 600.

- **Stay in Hybrid mode.** Do NOT switch to dGPU-only via `supergfxctl`. Hybrid is what keeps the
  3050 free. On this chassis the panel is physically wired to the Renoir iGPU — there is no MUX
  switch and nothing to configure.
- **Every VRAM table in the field guide assumes hybrid mode.**

> This is not a micro-optimization. On a 24 GB card nobody would notice; on 4 GB it is the
> difference between 1.5B being marginal and being routine.

---

## The dependency matrix

| Library | Purpose | TUF (Ubuntu + CUDA) | Mac (macOS + Metal) |
|---|---|---|---|
| `torch` | Everything | Yes — cu12x/cu13x wheels | Yes — MPS backend, partial op coverage |
| `transformers` | Model loading, generation | Yes | Yes |
| `datasets` | Data loading, streaming | Yes | Yes |
| `peft` | LoRA / adapters | Yes | Yes (slow on MPS) |
| `trl` | SFT / DPO / GRPO trainers | Yes | Partial — no vLLM backend |
| `bitsandbytes` | 4-bit / 8-bit quantization | **Yes — this is why QLoRA works** | **NO — CUDA only** |
| `unsloth` | 2× faster, ~50% less VRAM | **Yes — Triton native on Linux** | **NO — CUDA only** |
| `flash-attn` | Fused attention kernel | Yes (Ampere) — ~20 min build | **NO — CUDA only** |
| `triton` | Kernel compiler under Unsloth | Yes — first-class on Linux | NO |
| `vllm` | Fast batched inference / RL rollouts | Installs, but 4 GB caps it | NO — not practical |
| `deepspeed` | Multi-GPU sharding | Irrelevant (single GPU) | NO |
| `mlx` / `mlx-lm` | Apple-native training + serving | **NO** | Yes — the native path |
| `llama.cpp` | GGUF inference, accelerated | Yes (CUDA build) | Yes — excellent (Metal) |
| `docker` | Level-2 sandbox isolation | **Native — ~50 ms/container** | VM-backed — 1–3 s/container |
| `resource` / `os.setsid` | Level-1 sandbox limits | Yes — POSIX | Yes — POSIX |
| `evalplus` | HumanEval+ / MBPP+ harness | Yes | Yes |
| `mergekit` | Checkpoint merging | Yes | Yes (CPU) |

---

## Non-negotiable defaults on this box

- **`bf16=True` — never fp16.** fp16 NaNs on step 1 and Ampere supports bf16 natively.
- `gradient_checkpointing=True`
- `optim="paged_adamw_8bit"`
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
- **Unsloth at 1.5B is not optional** — it is the difference between training and OOM.

## Do not suggest these

- **Renting a GPU / cloud compute.** Learning on hardware you own. Plan around 4 GB.
- **Models ≥ 7B for training**, or ≥ 7B for inference on this box.
- **Full fine-tuning.** QLoRA only.
- **fp16.** bf16 always.
- **MLX / Metal / `mps`** — wrong machine.
- **vLLM-dependent workflows** on this box.
- **Loading a large dataset non-streamed** into 16 GB.

---

## Sandbox throughput — why bulk execution lives here

Single-threaded wall-clock. Divide by your worker count (8 physical cores here).

| Phase | Executions | L1 subprocess ~50 ms | L2 Docker, **TUF** ~100 ms | L2 Docker, Mac ~1.5 s |
|---|---|---|---|---|
| Baseline eval | ~5,000 | 4 minutes | 8 minutes | 2 hours |
| SFT eval loop | ~50,000 | 42 minutes | 1.4 hours | 21 hours |
| Rejection sampling | ~500,000 | 7 hours | 14 hours | 8+ days |
| GRPO training | ~2,000,000 | 28 hours | 56 hours | **impractical** |

> **Level 2 on Linux costs ~2× Level 1, not 30× as on the Mac** — which is what moves all bulk
> execution to this machine.

**Optimizations, in order of payoff:**

- **Parallelize with processes** — pool sized to physical cores (8 here), cutting every number above
  by ~8×. `preexec_fn` is not thread-safe, so threads are out.
- **Cache by content hash** — identical generated solutions are common at low temperature.
- **Fail fast on syntax** — `ast.parse()` before spawning. Rejects a meaningful fraction at ~0.1 ms
  instead of 50 ms.
- **Batch the container** at Level 2 — many solutions in one container, not one each.
- **Warm the interpreter** — process startup dominates at 50 ms.
- **Measure before optimizing** — log the `wall_ms` distribution. Your bottleneck may be the model
  generating, not the sandbox executing.

---

## Disk strategy

| Drive | Holds | Notes |
|---|---|---|
| **512 GB — `/` (ext4)** | Ubuntu, venvs, PyTorch, repos, swap, **and `/data`** — which is a plain directory here, not a mount | 53 GB used, **391 GB free** (measured 2026-08-17). Everything ULTRON touches lives here. |
| **1 TB — NTFS** | 577 GB of pre-existing unrelated data, auto-mounted at `/run/media/killerx8143/Storage` | **Not used by ULTRON.** NTFS breaks the HF cache's symlinks and degrades git. See [01-SETUP.md](01-SETUP.md) Step 6 amendment. |

| What | Rough size | Where | Policy |
|---|---|---|---|
| HF model cache | 150–400 GB on the Mac · **under 50 GB on the TUF** | Mac 3TB · TUF `/data/hf` (on the ext4 root) | **Set `HF_HOME` day one.** The big figure is Mac work; this box needs 0.5B (~1 GB), 1.5B (~3 GB), shards and adapters. |
| The Stack v2 subset | 50–200 GB | Mac, `data/raw/` | Download a language subset, not the whole thing |
| Instruction datasets | 5–20 GB | Mac, `data/raw/` | Small. Keep all versions. |
| `data/interim` + `processed` | 20–80 GB | Mac (authoritative) | Every version kept. This is your provenance chain. |
| Training shards synced to TUF | 1–10 GB per run | TUF `/data/datasets` | Copy only what a run needs. The Mac stays source of truth. |
| Generated rollouts | 10–100 GB | Mac | Grows fast during RFT and GRPO. Compress old ones. |
| LoRA adapters | 20–200 MB each | Both, synced back to Mac | Keep everything — they are tiny |
| Merged full models | 1–15 GB each | Mac | **Do NOT keep.** Regenerate from adapter + base. |
| Eval outputs / logs | 1–10 GB | Mac | Keep. This is your results record. |

- **The 512 GB rule, amended:** the root SSD now holds everything, because the 1 TB is NTFS and
  unavailable. Every large path still points at `/data` — that path just resolves to the root disk.
  **391 GB free is ample for this box's job, but it is no longer an unbounded budget.** Watch it.
- **The rule:** anything regenerable in under an hour gets deleted. Anything that took a day to
  produce gets kept forever.
- **The trap:** merged models. Large, and a pure function of adapter + base. Never store them.

---

## Environment variables — set these before any download

```bash
export HF_HOME=/data/hf
export HF_DATASETS_CACHE=$HF_HOME/datasets
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
```

> Setting `HF_HOME` **before the first download** is the single cheapest mistake to avoid.
> On this box the cache **is** on the root partition, so this is a live risk rather than a hypothetical
> one. `df -h /` before any large download.

## Smoke tests — all must pass before writing project code

```bash
python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
```

```bash
python -c "import torch; print(torch.cuda.get_device_capability())"   # expect (8, 6)
```

```bash
python -m bitsandbytes
```

```bash
python -c "from unsloth import FastLanguageModel; print('unsloth ok')"
```

Then a real **10-step LoRA run** on Qwen2.5-Coder-0.5B before you trust any of it. Ten steps proves
the whole chain: data → tokenizer → model → optimizer → backward → save.

| Test | What it proves |
|---|---|
| `torch.cuda.is_available()` | Must print True. If False: driver/torch CUDA mismatch. Reinstall with the matching `cuXXX` index URL. |
| `python -m bitsandbytes` | **The single most common broken install.** It fails silently at training time otherwise. |
| 4-bit load on 0.5B | If this OOMs on a 4 GB card, something else is holding VRAM. |
| 10-step LoRA run | End-to-end proof. Ten steps, two minutes. |
| `wandb.init()` + one metric | Confirms auth and network. Do this before a 6-hour run, not during. |
