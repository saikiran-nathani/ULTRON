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
- Target model: **Qwen2.5-Coder-0.5B**. 1.5B is the stretch.
- Endpoint: a 0.5B model running on-device via GGUF.
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

```bash
# One-time: put caches on the big drive, not ~
export HF_HOME=/path/to/big/drive/hf
export HF_DATASETS_CACHE=$HF_HOME/datasets
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True

conda create -n ultron python=3.11 -y && conda activate ultron
pip install torch --index-url https://download.pytorch.org/whl/cu128
pip install transformers datasets accelerate peft trl bitsandbytes unsloth wandb

# Smoke tests — all must pass before writing project code
python -c "import torch; assert torch.cuda.is_available(); print(torch.cuda.get_device_name(0))"
python -m bitsandbytes
python -c "from unsloth import FastLanguageModel; print('unsloth ok')"
```

Setting `HF_HOME` **before the first download** is the single cheapest mistake to avoid — otherwise the model cache silently fills the home partition.
