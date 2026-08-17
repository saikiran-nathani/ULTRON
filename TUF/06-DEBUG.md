# Debugging Playbooks — TUF

Five playbooks, in the order you will need them. Work top to bottom within each; the order is
the point. Hyperparameters are always the *last* thing to suspect.

---

## 1. CUDA out of memory

Try the levers **in this order**. The first two do almost all the work.

| # | Lever | Memory saved | Cost |
|---|---|---|---|
| 1 | Close other GPU processes | 0.3–0.8 GB | None — `nvidia-smi` first, always |
| 2 | Lower `max_seq_length` | Large — scales linearly | Truncates long examples |
| 3 | `gradient_checkpointing=True` | Large | ~30% slower |
| 4 | Use Unsloth | 50–70% | CUDA-only; should already be on |
| 5 | `per_device_batch=1` + accumulation | Moderate | Slower wall clock, quality unaffected |
| 6 | `paged_adamw_8bit` | Small, but survives spikes | Slight slowdown |
| 7 | `expandable_segments:True` | Fragmentation relief | None — env var, free |
| 8 | Lower LoRA rank | Small | Less capacity — rarely the real problem |
| 9 | Smaller model | Large | You are here to learn — last resort |

```python
# Find out where the memory actually went
print(torch.cuda.memory_allocated()/1e9, torch.cuda.memory_reserved()/1e9)
print(torch.cuda.memory_summary())   # detailed per-allocator breakdown
```

```bash
export PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True   # helps a lot on 4GB
```

> **Close the browser before training.** A few Chrome tabs is 400–800 MB — 10–20% of the budget.
> Verify with `nvidia-smi --query-gpu=memory.used,memory.total --format=csv`; you want
> **single-digit MB** idle, not 600.

---

## 2. System RAM OOM / process killed

Almost always dataset loading. 16 GB is the real ceiling on this box, and it bites before VRAM does.

- Use `streaming=True` — never `load_dataset(...)` a large corpus without it
- Or move the step to the Mac (48 GB)
- Confirm swap is 16 GB: `swapon --show` / `free -h`

---

## 3. NaN, loss spikes, and divergence

| Symptom | Most likely cause | Diagnostic | Fix |
|---|---|---|---|
| NaN on step 1 | fp16 overflow in attention | Check dtype config | **Use bf16** — your card supports it |
| NaN after many steps | LR too high; gradient explosion | Plot `grad_norm` — it climbs first | Lower LR 3×; add `max_grad_norm=1.0` |
| Loss spikes then recovers | A single bad batch | Log the batch index at the spike | Usually benign; inspect that data slice |
| Loss spikes and stays high | Optimizer state corrupted | Check for `inf` in the data | Restart from the last good checkpoint |
| Loss slowly climbing | LR too high for this stage | `grad_norm` trending up | Lower LR; check the schedule is decaying |
| GRPO reward → NaN | Extreme advantage; std near zero | Log reward std per group | Clip advantages; add eps to the denominator |
| Everything NaN after resume | Optimizer state not restored | Compare LR and step count | Resume properly, or restart the schedule |

> **`grad_norm` is your early-warning system.** It rises before the loss does. Log it every step,
> in every phase.

**fp16 NaN on step 1 is so common it is almost a rite of passage.** Ampere supports bfloat16,
which has fp32's exponent range. There is no reason to use fp16 on this card, and one very good
reason not to.

---

## 4. Training is mysteriously slow

- **Silently on CPU** — assert the device, do not assume
- MPS fallback on the Mac: many ops go to CPU with no warning
- Gradient checkpointing on when you no longer need it (~30%)
- Dataloader starved — raise `num_workers`
- Padding instead of packing: up to 60% wasted compute
- Flash Attention not installed
- **Thermal throttling on a laptop** — check clocks under load

```python
# The three assertions that catch most of this
assert next(model.parameters()).device.type == 'cuda',  'training on CPU!'
assert model.config.torch_dtype == torch.bfloat16
print(f'{tokens_per_sec:.0f} tok/s')   # baseline it on run 1, watch for regressions
```

---

## 5. Model outputs garbage

- Chat template mismatch between train and inference
- Wrong EOS token: generation never terminates
- Loss masking wrong: learned to predict prompts
- LR far too high: collapsed into repetition
- Adapter not actually loaded at inference
- Quantization applied twice
- Sampling params differ from evaluation defaults

---

## 6. The eval score will not move

**In this order.** Hyperparameters are step 7, not step 1.

1. **Confirm anything is training at all.** `model.print_trainable_parameters()`. If it says
   `0.0%`, your `target_modules` string is wrong and every run so far has been a no-op.
2. **Confirm the effective batch size.** Log the optimizer step count. If accumulation was
   silently ignored, your effective batch is 1 and training is pure noise.
3. **Confirm masking is applied.** Decode one batch and inspect the labels. If the whole sequence
   is unmasked, you are training on prompts too.
4. **Confirm train and eval use the SAME template.** Print both rendered strings and diff them.
   This is the single most common cause of a fine-tune scoring worse than its base.
5. **Confirm the data is not junk.** Read fifty random training examples with your eyes. Not a
   sample of five — fifty. Problems are usually visible immediately.
6. **Confirm the eval is sensitive enough.** Evaluate the BASE model and a deliberately-broken
   model. If they score the same, your harness is not measuring anything.
7. **Only then tune hyperparameters.**

---

## Reading training curves

| Signal | Healthy | Warning | Action |
|---|---|---|---|
| `train/loss` | Smooth decline, then flattening | Oscillation, spikes, NaN | Lower LR; raise effective batch |
| `eval/pass@1` | Rises, peaks, then declines | Flat from the start | Check trainable %, masking, template |
| `grad_norm` | Stable or slowly declining | Steady climb | **Lower LR now** — before the loss shows it |
| `learning_rate` | Warms up then decays as configured | Flat at peak | Scheduler misconfigured |
| output length | Roughly stable | Doubling (DPO) or collapsing | Verbosity bias, or truncation gaming |
| reward mean (GRPO) | Gradual rise | Step-function jump | A shortcut was found — read rollouts |
| reward std (GRPO) | Non-zero, stable | Trending to zero | Dead groups — refilter your problem set |
| KL from reference | Slow rise, then plateau | Unbounded growth | Raise beta; the leash is too loose |
| tokens/sec | Constant | Dropping over time | Thermal throttling, or a memory leak |

> The loss curve describes optimization. Only the eval curve describes capability.
> **Never confuse the two.**

---

## Environment failures — the ones you hit in the first hour

| Symptom | Real cause | Fix |
|---|---|---|
| `nvidia-smi`: "couldn't communicate with the NVIDIA driver" | Secure Boot rejected the unsigned kernel module | Enroll the MOK key at the blue boot screen — see [01-SETUP.md](01-SETUP.md) Step 1 |
| Black screen after installing the driver | Wrong driver branch for the card | Boot with `nomodeset`, then `sudo ubuntu-drivers autoinstall` |
| `/data` is empty after a reboot | Second SSD not in `/etc/fstab` | Add by UUID; test with `sudo mount -a` **before** rebooting |
| Permission denied writing to `/data` | Mount owned by root | `sudo chown -R $USER:$USER /data` |
| `torch.cuda.is_available()` is False | CPU-only torch wheel installed by default | Reinstall from the matching `cuXXX` index URL |
| `bitsandbytes: CUDA Setup failed` | Library can't find libcudart | Match bnb version to torch CUDA; run `python -m bitsandbytes` |
| OOM immediately on a 0.5B model | Something else holds the card, or you left hybrid mode | `nvidia-smi` first; expect single-digit MB idle |
| `flash-attn` install hangs forever | Compiling from source, single-threaded | `MAX_JOBS=4 --no-build-isolation`, or skip it |
| Disk fills up in a week | HF cache defaulting to the 512 GB root disk | `export HF_HOME=/data/hf` early, not later |
| Unsloth import error | Installed on the Mac | CUDA-only. TUF only. |
| Dataset load kills the process | 16 GB RAM, non-streaming load | `streaming=True`, or do it on the Mac |
| NaN loss on step 1 with fp16 | fp16 overflow in attention | Use bf16 — Ampere supports it |
