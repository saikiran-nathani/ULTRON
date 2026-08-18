# Serving benchmark

`bench_serving.py` measures what a served model actually does on a given box: decode
throughput, prefill throughput, time-to-first-token, and the largest context that still
fits entirely in VRAM.

Runs on both machines. Everything goes through ollama's HTTP API, so there is no
CUDA-only path — the TUF (discrete 4 GB) and the Mac (unified memory) use identical code.

```bash
ollama serve &                       # if not already running

# throughput + latency
python -m src.serve.bench_serving --models qwen2.5-coder:1.5b qwen2.5-coder:3b

# find the context ceiling — the number you need to configure a server
python -m src.serve.bench_serving --models qwen2.5-coder:3b --ctx-ceiling

# record a result
python -m src.serve.bench_serving --models qwen2.5-coder:1.5b --out results/serving-mac.json
```

Stdlib only. No dependencies, so it runs before the training stack is installed.

## What it measures, and why separately

ollama returns nanosecond counters that split the two phases, and they have different
bottlenecks:

| Phase | Bound by | Effect of quantization |
|---|---|---|
| **Prefill** (prompt ingest) | compute | roughly neutral, sometimes *negative* — dequantizing to matmul is overhead |
| **Decode** (token generation) | memory bandwidth | strongly positive — fewer bytes per weight |

A single "tokens/sec" number averages these together and hides the tradeoff that decides
a serving format. On the TUF, Q4_K_M beats Q8_0 by 28% on decode while *losing* 3.9% on
prefill — you cannot see that with one figure.

**Time-to-first-token is reported separately because it barely moves with model size.**
Measured on the TUF: 263 ms at 1.5B, 267 ms at 3B — a 2× parameter increase costs 4 ms,
because TTFT is dominated by fixed request overhead. For autocomplete, this is the number
that matters, and it says the bigger model feels identically responsive.

## The trap: silent partial offload

When a model plus its KV cache does not fit, **ollama does not fail**. It leaves some
layers on CPU and serves anyway — 3–6× slower, no error, nothing in the response body.

Measured on the TUF, same model, same prompt:

| | Decode |
|---|---:|
| Full offload | 116 tok/s |
| Partial offload (2/29 layers on GPU) | 24 tok/s |

That is easy to misread as "this hardware is slow" rather than "this did not fit."

The script guards against it. `/api/ps` reports `size` and `size_vram`; their ratio is the
portable equivalent of llama.cpp's `offloaded N/M layers` and works on Metal too. Every
sample is tagged with it, degraded samples are marked `[DEGRADED]` rather than averaged
into a clean-looking mean, and the process exits non-zero so it fails a CI step instead of
quietly publishing a bad number.

Two habits that follow from this:

- **Measure one model at a time.** The script unloads the others first. With several
  resident on 4 GB, a load gets squeezed by whatever is already there, and results start
  depending on the order you ran them in.
- **Never trust a decode figure without its offload ratio.** That is why the JSON records
  the ratio on every sample rather than once per run.

## Context ceiling

KV cache grows linearly with context, and on a 4 GB card it — not the weights — is what
pushes you over. The ceiling is not derivable from the model file size, so `--ctx-ceiling`
walks a ladder upward and stops at the first context that fails to fully offload.

Measured on the TUF, Qwen2.5-Coder-3B Q4_K_M:

| Context | Offload | VRAM | Decode |
|---:|---:|---:|---:|
| 4,096 | 1.000 | 2,059 MiB | 64.5 tok/s |
| 8,192 | 1.000 | 2,207 MiB | 64.1 tok/s |
| 16,384 | 1.000 | 2,503 MiB | 59.8 tok/s |
| 32,768 | **0.814** | 2,570 MiB | 43.7 tok/s ⚠️ |

So 3B on the TUF is a **16K-context model**, not a 32K one. Configuring it for 32K costs
about a third of decode throughput — and with a genuinely long prompt it is far worse than
that: a 20k-token prompt at 32K context measured **9.4 tok/s**, roughly 6.6× slower than
the same model configured correctly.

## Reference results — TUF (RTX 3050 4 GB), 2026-08-18

Full method and caveats in `TUF/02-CAPACITY.md`.

| Model | VRAM loaded | Decode (short) | TTFT | Prefill @5k | Max ctx |
|---|---:|---:|---:|---:|---:|
| 1.5B Q4_K_M | 1,394 MiB | 116.4 tok/s | 263 ms | 4,326 tok/s | 32K |
| 1.5B Q8_0 | 2,024 MiB | 91.2 tok/s | 265 ms | 4,496 tok/s | 32K |
| 3B Q4_K_M | 2,207 MiB | 63.9–70.0 tok/s | 267 ms | ~2,100 tok/s | **16K** |

CPU-only fallback, for reference: 24.8 tok/s (1.5B Q4_K_M), 16.0 tok/s (1.5B Q8_0).

**F16 at 1.5B does not fit.** Weights alone are 2,950 MiB against a 3.1–3.5 GiB usable
ceiling that moves with desktop VRAM use, leaving no room for KV cache. Q8_0 is the
near-lossless point; F16 buys nothing measurable and costs roughly 45% of decode.
