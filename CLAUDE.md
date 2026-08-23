# Machine + Project Context — Asus TUF A17

Paste this at the repo root as `CLAUDE.md`, or at `~/.claude/CLAUDE.md` to make it global on this box.
It exists so a fresh session is calibrated **before** it suggests anything that cannot run here.

---

## 1. What this machine is

| | |
|---|---|
| **Box** | Asus TUF A17 |
| **GPU** | NVIDIA RTX 3050 Laptop — **4 GB VRAM**, Ampere (GA107, `sm_86`) |
| **CPU** | AMD Ryzen 7 4800H — 8 cores / 16 threads (Zen 2, x86-64) |
| **RAM** | **16 GB** system |
| **Role** | The **CUDA machine**. All GPU training happens here. |

**Ampere matters.** `sm_86` means bf16, TF32, and Flash Attention 2 all work. Use them.

**The two hard ceilings, in order of which bites first:**

1. **16 GB system RAM** — usually the *actual* constraint. Dataset loading, dedup indices, and tokenization blow this before VRAM is touched. Stream datasets; never `load_dataset(...)` a large corpus without `streaming=True`.
2. **4 GB VRAM** — caps model size. Activations (seq_len × batch) dominate, not weights.

---

## 2. What fits — assume these numbers, don't re-derive them

### Training (QLoRA + Unsloth, bf16, gradient checkpointing on)

| Model | seq_len | batch | grad_accum | Status |
|---|---|---|---|---|
| **Qwen2.5-Coder-0.5B** | 1024 | 2 | 8 | Comfortable — the default workhorse |
| **Qwen2.5-Coder-0.5B** | 2048 | 1 | 16 | Fine |
| **Qwen2.5-Coder-1.5B** | 512 | 1 | 16 | Tight but works. **Unsloth required.** |
| **Qwen2.5-Coder-1.5B** | 1024 | 1 | 16 | Marginal — expect to tune |
| **Qwen2.5-Coder-3B** | 256 | 1 | 32 | Marginal at best. Usually not worth it. |
| **Anything ≥ 7B** | — | — | — | **Does not train here.** Do not propose it. |

### Inference on this box

- 3B in 4-bit ≈ 1.8 GB — fits with room for context.
- 7B in 4-bit ≈ 4 GB — **does not fit** once you add KV cache. Use the Mac.

### Rough VRAM budget at 0.5B QLoRA

```
base weights (NF4)      0.28 GB
LoRA + grads + optim    0.03 GB
activations (512×1)     0.35 GB
CUDA context + frag     0.60 GB
                        --------
                      ~ 1.3 GB   → ~2.7 GB headroom on a clean card
```

**Close the browser before training.** A few Chrome tabs is 400–800 MB — 10–20% of the budget.

---

## 3. What runs here, and what does not

**Works (this is the point of this machine):**
`torch` (cu12x/cu13x wheels — driver reports CUDA 13.2) · `bitsandbytes` · **`unsloth`** · `trl` · `peft` · `transformers` · `datasets` · `accelerate` · `flash-attn` (compiles on Ampere, ~20 min, worth it once) · `wandb` · `mergekit`

**Does not run / not applicable here:**
- `mlx`, `mlx-lm` — Apple only. That is the Mac.
- `vllm` — technically installs, but 4 GB makes it impractical. Don't plan around it.
- `deepspeed` — single GPU, irrelevant.
- Anything assuming multi-GPU.

**Non-negotiable defaults on this box:**
- `bf16=True` — **never fp16.** fp16 NaNs on step 1 and Ampere supports bf16 natively.
- `gradient_checkpointing=True`
- `optim="paged_adamw_8bit"`
- `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
- Unsloth at 1.5B is not optional — it is the difference between training and OOM.

---

## 4. Division of labour — TUF vs MacBook

There is a second machine: **MacBook Pro M5 Pro, 48 GB unified, 3 TB.** No CUDA.

| Work | Machine | Why |
|---|---|---|
| QLoRA training, all phases | **TUF** | only CUDA box |
| DPO / GRPO runs | **TUF** | needs bitsandbytes + TRL kernels |
| Data pipeline: dedup, decontamination, filtering | **Mac** | RAM-bound; 48 GB beats 16 GB |
| Teacher generation (14B quantized) | **Mac** | 4 GB cannot hold a 14B model |
| Eval harness + sandbox execution | **Mac** | CPU-bound, and keeps the GPU free |
| Merging / quantization | **Mac** | CPU work |

**If a task is RAM-hungry or needs a big model for inference, say "do this on the Mac" rather than trying to squeeze it onto 4 GB.**

---

## 5. The projects

### ULTRON — post-training curriculum (this repo)
A **learning curriculum**, not a product. Goal: acquire post-training engineering skills on open-weight code models.

Pipeline order (do not reorder):
```
sandbox → eval harness → baseline → data curation → SFT → RFT → DPO → GRPO → self-repair → merge → serve
```

- Domain: **code** — chosen because tests give a free, objective verifier.
- **Dev loop: Qwen2.5-Coder-0.5B.** Pipeline development and every ablation. 20–40 min per SFT run.
- **Ship target: Qwen2.5-Coder-1.5B**, served as Q4_K_M GGUF (986 MB · 1,394 MiB VRAM · 116 tok/s, measured 2026-08-18).
- Build at 0.5B for loop speed; re-run the settled recipe at 1.5B **once**. Do not iterate at 1.5B —
  SFT there is 2–3 hours, and GRPO on 4 GB is only comfortable at 0.5B.
- Endpoint: a 1.5B model running on-device via GGUF.
- Full 190-slide field guide + manifest lives in `docs/` (`node build.js` regenerates).

### DSA-Python — separate repo
203-slide DSA field guide at `../DSA-Python/deck/`. Unrelated to ULTRON; don't cross-reference them.

---

## 6. How I want you to work

- **Depth over summary.** When I ask for reference material, exhaustive beats concise. Don't self-limit length unless I ask.
- **Order by workflow**, not by taxonomy. Present things in the sequence I'd actually do them.
- **State assumptions and proceed.** Don't stop to ask about things a careful engineer would just decide.
- **Numbers, not adjectives.** "seq_len 512, batch 1, accum 16" beats "use a small batch size".
- **Flag the trap.** If a step has a silent failure mode, say so at that step — not in a summary at the end.
- **Say when something won't work here.** Don't hedge. "That needs 24 GB; it won't run on this box" is the useful answer.

---

## 7. Debugging playbook

### CUDA OOM — try in this order
1. `nvidia-smi` → kill browsers and stray Python processes
2. **Lower `seq_len`** (biggest lever; activations scale linearly with it)
3. `gradient_checkpointing=True`
4. Switch to Unsloth if not already
5. `optim="paged_adamw_8bit"`
6. `batch=1`, raise `grad_accum` (effective batch preserved, only slower)
7. `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`
8. Lower LoRA rank *(rarely the real problem)*

### System RAM OOM / process killed
Almost always dataset loading. Use `streaming=True`, or move the step to the Mac.

### Loss is NaN
fp16 → switch to bf16. If already bf16, LR is too high; check `grad_norm` (it climbs before the loss breaks).

### Training suspiciously slow
Assert the device — `assert next(model.parameters()).device.type == "cuda"`. Then check thermal throttling (laptop), then dataloader `num_workers`.

### Eval score won't move
In this order: `model.print_trainable_parameters()` (is it 0.0%?) → optimizer step count (is `grad_accum` actually applied?) → decode a batch and inspect labels (is loss masking on?) → diff the train vs eval chat template. Hyperparameters are the *last* thing to suspect.

---

## 8. Do not suggest these

- ❌ **Renting a GPU / cloud compute.** I'm learning on hardware I own. Money comes later. Plan around 4 GB.
- ❌ **Models ≥ 7B for training**, or ≥ 7B for inference *on this box*.
- ❌ **Full fine-tuning.** QLoRA only.
- ❌ **fp16.** bf16 always.
- ❌ **MLX / Metal / `mps`** — wrong machine.
- ❌ **vLLM-dependent workflows** on this box.
- ❌ Loading a large dataset non-streamed into 16 GB.

---

## 9. First-run environment setup

**Already done on this box (2026-08-22).** This section is the record of what was built,
not a to-do. Re-run only when rebuilding the machine.

### Storage split — `~/.config/ml-storage.sh` owns it

Sourced from `~/.bashrc`, so every shell gets it. Do not re-export these anywhere else.

| Drive | Holds | Why |
|---|---|---|
| `/` — nvme1n1p2, ext4, 476 GB | interpreters, venvs, **uv/pip caches**, IDEs, source repos | millions of small files; all reconstructible from `requirements/` + git |
| `/data` — nvme0n1p1, ext4, 916 GB | model weights, datasets, checkpoints, run outputs, GGUF | few files, enormous, expensive to re-download |

```
/data/hf        HF_HOME           /data/datasets  ML_DATASETS   curated JSONL
/data/hf/datasets HF_DATASETS_CACHE  /data/runs   ML_RUNS       adapters, logs, ckpts
/data/torch     TORCH_HOME        /data/models    ML_MODELS     merged / GGUF exports
/data/ollama    OLLAMA_MODELS     /data/projects  ML_PROJECTS
```

**The uv/pip caches stay on `/` deliberately.** uv hardlinks packages out of its cache into
each venv, and hardlinks cannot cross filesystems — move `~/.cache/uv` to `/data` and every
install silently degrades into a full copy.

`/data` was NTFS until 2026-08-22; the dirty bit dropped it on every reboot, and
`huggingface_hub` cannot symlink on NTFS so it copies instead, doubling disk use per model.
Now ext4, mounted by UUID from `/etc/fstab` with `nofail`. **Verify with `findmnt /data`
before a long run** — unmounted, the paths resolve to a root-owned dir on `/` and writes fail
loudly with EACCES rather than quietly filling the OS disk. That is the intended failure mode.

### The environment

`uv` + **Python 3.12**, venv at the repo root. Not conda. Not 3.14 — bitsandbytes and unsloth
have no wheels for it, forcing source builds on the machine least able to afford them.

```bash
sudo apt install -y build-essential tmux    # gcc is NOT optional: Triton JIT-compiles
                                            # unsloth's kernels at runtime and needs cc
curl -LsSf https://astral.sh/uv/install.sh | sh

cd ~/projects/ULTRON
uv venv --python 3.12 .venv && source .venv/bin/activate   # or just: ultron
uv pip install torch --index-url https://download.pytorch.org/whl/cu128
python -c "import torch; print(torch.cuda.get_device_capability())"   # must be (8, 6)
uv pip install -r requirements/cuda.txt     # torch is deliberately absent from this file
```

⚠️ **`cuda.txt` protects `torch` from being clobbered by the PyPI CPU wheel, but not
`torchvision`.** It resolves to the plain PyPI build, whose compiled ops will not load against
`torch+cu128` — unsloth then fails to import with `operator torchvision::nms does not exist`.
Fix, every time you rebuild the venv:

```bash
uv pip install --reinstall --no-deps --index-url https://download.pytorch.org/whl/cu128 "torchvision==0.26.0"
```

### The gate

```bash
python scripts/smoke_test.py                              # 10/10, exit 0
python -m pytest src/sandbox/tests/test_adversarial.py -q # 23 passed
```

Measured 2026-08-22: torch 2.11.0+cu128 · transformers 4.57.6 · trl 0.24.0 · peft 0.20.0 ·
unsloth 2026.8.19 · bitsandbytes 0.50.1. Qwen2.5-Coder-0.5B-Instruct in NF4 loads at **436 MiB,
peak 471 MiB of 4096**.

⚠️ **`trl 0.24.0` has no `DataCollatorForCompletionOnlyLM`** — it was removed during the 0.2x
line. Loss masking (the bug that silently wastes a week) now goes through
`SFTConfig(assistant_only_loss=True)`, which requires a chat template carrying `{% generation %}`
markers. `docs/BUILDING-ULTRON.md` Step 7.3 still documents the old collator; verify masking by
decoding `labels != -100` regardless of which path you take.
