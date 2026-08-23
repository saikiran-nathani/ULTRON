# Hardware capacity — Asus TUF A17, measured 2026-08-23

What this box actually does, on the real project models. Not estimates.
Both tables are regenerable from the two commands below; nothing here was typed by hand.

| | |
|---|---|
| GPU | NVIDIA RTX 3050 Laptop, sm_86 — **3,770 MiB usable**, not 4,096 (the display reserves the rest) |
| Stack | torch 2.11.0+cu128 · transformers 4.57.6 · trl 0.24.0 · peft 0.20.0 · bitsandbytes 0.50.1 |
| Python | 3.12.14, venv at the repo root |
| Backend measured | **plain peft + TRL**. The unsloth arm is not measured yet — see "Not yet measured" |

```bash
python -m src.serve.bench_serving --models qwen2.5-coder:0.5b qwen2.5-coder:1.5b \
    qwen2.5-coder:1.5b-instruct-q8_0 qwen2.5-coder:3b \
    --reps 3 --prompt-sizes 500 5000 16000 --ctx-ceiling --out results/serving-tuf.json
python scripts/bench_train.py --out results/train-tuf.json --steps 6
```

---

## Serving — GGUF via ollama

| Model | VRAM | Decode (short) | TTFT | Prefill @~5k | Max ctx, full offload |
|---|---:|---:|---:|---:|---:|
| `qwen2.5-coder:0.5b` | 553 MiB | 238.0 tok/s | 247 ms | 9,567 tok/s | 32,768 |
| **`qwen2.5-coder:1.5b` Q4_K_M** — ship target (D3) | 1,297 MiB | **115.0 tok/s** | 253 ms | 3,975 tok/s | 32,768 |
| `qwen2.5-coder:1.5b-instruct-q8_0` | 1,927 MiB | 89.0 tok/s | 259 ms | 4,232 tok/s | 32,768 |
| `qwen2.5-coder:3b` ⚠️ | 2,291 MiB | 71.8 tok/s | 268 ms | 2,193 tok/s | **16,384** |

**The ship target reproduces.** 115.0 tok/s against 116.4 measured 2026-08-18 — within noise.
VRAM is 1,297 MiB against the 1,394 MiB quoted in `CLAUDE.md` §5; the doc is ~100 MiB pessimistic.

**Q8_0 costs 23% of decode for 630 MiB and buys nothing.** 115.0 → 89.0 tok/s. Prefill *rises*
slightly (3,975 → 4,232), which is the expected shape: prefill is compute-bound, and dequantizing
Q4 to do matmuls is overhead you stop paying at Q8. Q4_K_M remains correct. Confirms D3.

**3B fails silently, not loudly.** At ctx 32,768 offload drops to 0.814 and decode falls to
45.5 tok/s; with a 20k prompt it collapses to **10.6 tok/s** — a 7x cliff with no error and
nothing in the response to indicate it. Its real ceiling is 16,384, half what the 1.5B sustains.
This is the exact trap `src/serve/bench_serving.py` was written to catch, and it caught it.

---

## Training — QLoRA (NF4, bf16, gradient checkpointing, paged_adamw_8bit)

| Config | tok/fwd | fp32 logits | peak | reserved | s/step | tok/s | `CLAUDE.md` §2 said |
|---|---:|---:|---:|---:|---:|---:|---|
| 0.5B s512 b1 a16 | 512 | 0.29 G | 1,473 | 1,658 | 6.33 | 1,295 | budget baseline ✓ |
| 0.5B s1024 **b2** a8 | 2048 | 1.16 G | — | — | — | **OOM** | "Comfortable — the default workhorse" ✗ |
| **0.5B s1024 b1 a16** | 1024 | 0.58 G | 2,406 | 3,036 | 11.78 | **1,391** | not in the table — *the actual workhorse* |
| 0.5B s2048 b1 a16 | 2048 | 1.16 G | — | — | — | **OOM** | "Fine" ✗ |
| 1.5B s512 b1 a16 | 512 | 0.29 G | 2,239 | 2,468 | 14.12 | 580 | "Tight. **Unsloth required**" — ✗, runs without it |
| 1.5B s1024 b1 a16 | 1024 | 0.58 G | 3,215 | 3,592 | 26.58 | 617 | "Marginal — expect to tune" ✓ but it fits |
| 3B s256 b1 a32 | 256 | 0.14 G | 2,821 | 3,378 | 28.07 | 292 | "Marginal at best" ✓ but it fits |

### What actually binds: the logits tensor, not the model

Qwen's vocabulary is **151,936** and the loss upcasts logits to fp32, so one tensor of
`vocab x tokens_per_forward x 4 B` sits on the card:

```
2048 tok/forward -> 1.16 GiB      <- both OOM rows; matches "Tried to allocate 1.16 GiB" exactly
1024 tok/forward -> 0.58 GiB
 512 tok/forward -> 0.29 GiB
```

This is why a **0.5B** model OOMs at a geometry where a **1.5B** model succeeds. `1024x2` and
`2048x1` both push 2,048 tokens through one forward pass; `1.5B s1024 b1` pushes 1,024. Proven by
holding seq_len fixed and halving batch — `0.5B s1024 b1` runs at 2,406 MiB and turns in the best
throughput in the sweep.

**Consequences for every config you write:**

1. The workhorse geometry is **`seq_len 1024, batch 1, grad_accum 16`** — not `1024x2x8`. Same
   effective batch of 16, ~1.3 GB of headroom, and the highest tok/s measured.
2. **`seq_len x batch` is the number to hold under ~1024**, not seq_len alone. Raising batch is
   not free here the way it is on a big card; it is exactly as expensive as raising seq_len.
3. `CLAUDE.md` §7's OOM playbook says "lower seq_len (biggest lever)". On this stack **batch is
   the same lever** — the two multiply into the term that dominates.

### Throughput is not monotonic in seq_len

`0.5B s512` = 1,295 tok/s vs `0.5B s1024` = 1,391 tok/s. The longer context is *faster* per token,
because per-step fixed overhead amortizes over more tokens. Do not pick 512 thinking it is cheaper;
it is only cheaper in memory, and it is slower per token of training signal.

---

## Not yet measured

**The unsloth arm.** `scripts/bench_train.py --unsloth` runs the identical grid, but unsloth
cannot train on this box yet: Triton JIT-compiles its kernels at runtime and there is no C
compiler installed. Verified directly —

```
RuntimeError: Failed to find C compiler. Please specify via CC environment variable
```

`import unsloth` succeeds and `scripts/smoke_test.py` reports `ok unsloth`, so **a green gate
does not mean unsloth will train.** Compilation only happens at the first step.

Unblock with `sudo apt install -y build-essential`, then re-run the sweep with `--unsloth`. The
prediction to test: unsloth's fused cross-entropy never materializes the full fp32 logits tensor,
so the two OOM rows above should pass. If they do, that — not the speedup — is why
`CLAUDE.md` §3 calls unsloth non-negotiable, and §2's table was almost certainly derived with it.
