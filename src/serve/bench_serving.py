"""Serving benchmark — decode, prefill, TTFT, and the context ceiling.

Runs against a local ollama daemon on either machine: the TUF (CUDA, 4 GB discrete)
or the Mac (Metal, unified memory). Everything here goes through ollama's HTTP API,
so there is no CUDA-only code path and nothing to port.

Stdlib only, deliberately -- same rule as src/eval/pass_at_k.py. This has to run on a
fresh box before the training stack is installed.

## Why the numbers come from the API, not a stopwatch

/api/generate returns nanosecond counters that separate the two phases:

    prompt_eval_count / prompt_eval_duration   prefill  -- compute-bound
    eval_count        / eval_duration          decode   -- memory-bandwidth-bound

Wall-clock conflates them, and they scale with completely different things. Decode
speed tracks quantization (fewer bytes per weight = more tokens/s); prefill barely
moves with quantization and can even get *worse*, because dequantizing to do matmuls
is pure overhead once you are compute-bound. Measuring them separately is the whole
point -- a single "tokens/sec" figure hides the tradeoff that decides a serving format.

## The trap this script exists to catch

When a model plus its KV cache does not fit in VRAM, ollama does not fail. It silently
leaves some layers on CPU and serves anyway, 3-6x slower, with no error and no warning
in the response. On the TUF this was measured at 116 tok/s (full offload) versus 24
tok/s (partial) for the same model -- easily mistaken for "this hardware is slow".

/api/ps reports `size` and `size_vram`. Their ratio is the portable equivalent of
llama.cpp's "offloaded N/M layers", and it works on Metal too. Every measurement below
is tagged with that ratio, and anything under 1.0 is reported as DEGRADED rather than
quietly averaged into a result. A benchmark that cannot tell you it was measuring the
CPU is worse than no benchmark.

## Usage

    python -m src.serve.bench_serving --models qwen2.5-coder:1.5b qwen2.5-coder:3b
    python -m src.serve.bench_serving --models qwen2.5-coder:3b --ctx-ceiling
    python -m src.serve.bench_serving --models qwen2.5-coder:1.5b --out results/serving.json

`--ctx-ceiling` finds the largest context that still holds full offload, which is the
number you actually need to configure a server. It is not derivable from the model file
size: KV cache grows linearly with context and, on a 4 GB card, is what pushes you over.
"""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import statistics
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict

DEFAULT_HOST = "http://127.0.0.1:11434"
MIB = 1024 * 1024

# A prompt built from repeated small functions. Deterministic, tokenizes like real code
# (~14 tokens per unit), and avoids the pathological compressibility of "lorem ipsum"
# repeated verbatim, which some tokenizers handle unrepresentatively well.
_UNIT = "def helper_{i}(xs):\n    return sorted(set(xs))[:10]\n\n"

_FIM = (
    "<|fim_prefix|>def binary_search(arr, target):\n"
    "    lo, hi = 0, len(arr) - 1\n"
    "    while lo <= hi:\n"
    "        <|fim_suffix|>\n"
    "    return -1<|fim_middle|>"
)


def build_prompt(approx_tokens: int) -> str:
    """Roughly `approx_tokens` worth of code-shaped text."""
    reps = max(1, approx_tokens // 14)
    return "".join(_UNIT.format(i=i) for i in range(reps)) + "\n# Explain the code above.\n"


@dataclass
class Sample:
    """One generation, with the offload state it was measured under."""

    prompt_tokens: int
    prefill_tps: float | None
    decode_tps: float | None
    ttft_ms: int | None
    offload_ratio: float
    vram_mib: int

    @property
    def degraded(self) -> bool:
        # 0.999 rather than 1.0: ollama's own accounting rounds, and a model sitting at
        # 0.9995 is fully resident. Anything meaningfully below that has layers on CPU.
        return self.offload_ratio < 0.999


@dataclass
class ModelResult:
    model: str
    weights_mib: int = 0
    decode_tps: list[float] = field(default_factory=list)
    ttft_ms: list[int] = field(default_factory=list)
    prompt_sweep: list[dict] = field(default_factory=list)
    ctx_ceiling: dict | None = None
    degraded_any: bool = False


class Client:
    """Minimal ollama client. Raises with actionable text rather than a bare URLError."""

    def __init__(self, host: str = DEFAULT_HOST, timeout: float = 900.0) -> None:
        self.host = host.rstrip("/")
        self.timeout = timeout

    def _open(self, path: str, body: dict | None = None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(
            self.host + path, data=data, headers={"Content-Type": "application/json"}
        )
        try:
            return urllib.request.urlopen(req, timeout=self.timeout)
        except urllib.error.URLError as exc:
            raise SystemExit(
                f"cannot reach ollama at {self.host} ({exc}).\n"
                "Start it with `ollama serve`, or pass --host if it listens elsewhere."
            ) from exc

    def get(self, path: str) -> dict:
        return json.loads(self._open(path).read())

    def post(self, path: str, body: dict) -> dict:
        return json.loads(self._open(path, body).read())

    def ps(self) -> list[dict]:
        return self.get("/api/ps").get("models", [])

    def unload(self, model: str) -> None:
        """Evict a model so the next one is measured alone.

        This matters more than it looks. With several models resident on a 4 GB card,
        a load can be squeezed into partial offload by whatever is *already* there --
        which makes results depend on the order you ran them in.
        """
        try:
            self.post("/api/generate", {"model": model, "keep_alive": 0})
        except SystemExit:
            raise
        except Exception:
            pass  # already unloaded, or never loaded

    def offload_state(self, model: str) -> tuple[float, int]:
        """(size_vram / size, size_vram in MiB) for `model`, or (0.0, 0) if not resident."""
        for m in self.ps():
            if m.get("name") == model or m.get("model") == model:
                size, in_vram = m.get("size", 0), m.get("size_vram", 0)
                if not size:
                    return 0.0, 0
                return in_vram / size, in_vram // MIB
        return 0.0, 0

    def generate(
        self,
        model: str,
        prompt: str,
        num_predict: int,
        num_ctx: int,
        stream: bool = False,
    ) -> tuple[dict, int | None]:
        """Returns (final response object, time-to-first-token in ms or None)."""
        body = {
            "model": model,
            "prompt": prompt,
            "stream": stream,
            "options": {
                "num_predict": num_predict,
                "num_ctx": num_ctx,
                "temperature": 0,
                "seed": 42,
            },
        }
        if not stream:
            return self.post("/api/generate", body), None

        start = time.time()
        ttft = None
        final: dict = {}
        with self._open("/api/generate", body) as resp:
            for line in resp:
                if not line.strip():
                    continue
                obj = json.loads(line)
                if ttft is None and obj.get("response"):
                    ttft = int((time.time() - start) * 1000)
                if obj.get("done"):
                    final = obj
        return final, ttft


def measure(
    client: Client, model: str, prompt: str, num_predict: int, num_ctx: int, stream: bool = True
) -> Sample:
    resp, ttft = client.generate(model, prompt, num_predict, num_ctx, stream=stream)
    ratio, vram = client.offload_state(model)
    ns = 1e9

    def rate(count_key: str, dur_key: str) -> float | None:
        n, dur = resp.get(count_key, 0), resp.get(dur_key, 0) / ns
        return round(n / dur, 1) if n and dur > 0 else None

    return Sample(
        prompt_tokens=resp.get("prompt_eval_count", 0),
        prefill_tps=rate("prompt_eval_count", "prompt_eval_duration"),
        decode_tps=rate("eval_count", "eval_duration"),
        ttft_ms=ttft,
        offload_ratio=round(ratio, 4),
        vram_mib=vram,
    )


def find_ctx_ceiling(
    client: Client, model: str, candidates: list[int]
) -> dict:
    """Largest context in `candidates` that still loads fully into VRAM.

    Walks upward and stops at the first failure rather than bisecting: offload is
    monotonic in context size, and the ascending walk also records *where* the cliff is
    rather than only the last good value.
    """
    ladder: list[dict] = []
    best: int | None = None
    for ctx in sorted(candidates):
        client.unload(model)
        time.sleep(1)
        sample = measure(client, model, build_prompt(400), num_predict=32, num_ctx=ctx)
        ladder.append(
            {
                "num_ctx": ctx,
                "offload_ratio": sample.offload_ratio,
                "vram_mib": sample.vram_mib,
                "decode_tps": sample.decode_tps,
                "full_offload": not sample.degraded,
            }
        )
        status = "ok" if not sample.degraded else "DEGRADED"
        print(
            f"    ctx {ctx:>6}: offload {sample.offload_ratio:.3f}  "
            f"vram {sample.vram_mib:>5} MiB  decode {sample.decode_tps:>6} tok/s  [{status}]",
            flush=True,
        )
        if sample.degraded:
            break
        best = ctx
    return {"ceiling": best, "ladder": ladder}


def host_info() -> dict:
    """Machine identity, so a results file is never ambiguous about where it came from."""
    info = {
        "platform": platform.platform(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "accelerator": "unknown",
    }
    if shutil.which("nvidia-smi"):
        try:
            out = subprocess.run(
                ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            info["accelerator"] = f"CUDA: {out}"
        except Exception:
            pass
    elif platform.system() == "Darwin":
        try:
            cpu = subprocess.run(
                ["sysctl", "-n", "machdep.cpu.brand_string"],
                capture_output=True, text=True, timeout=10,
            ).stdout.strip()
            mem = subprocess.run(
                ["sysctl", "-n", "hw.memsize"], capture_output=True, text=True, timeout=10
            ).stdout.strip()
            info["accelerator"] = f"Metal: {cpu}, {int(mem) // 1024**3} GB unified"
        except Exception:
            info["accelerator"] = "Metal"
    return info


def run_model(
    client: Client,
    model: str,
    all_models: list[str],
    reps: int,
    prompt_sizes: list[int],
    num_ctx: int,
    ctx_ceiling: list[int] | None,
) -> ModelResult:
    print(f"\n===== {model} =====", flush=True)
    for other in all_models:
        if other != model:
            client.unload(other)
    time.sleep(2)

    result = ModelResult(model=model)

    # Load, and refuse to proceed quietly if it did not fit.
    warm = measure(client, model, "hi", num_predict=1, num_ctx=num_ctx, stream=False)
    result.weights_mib = warm.vram_mib
    if warm.degraded:
        result.degraded_any = True
        print(
            f"  WARNING: only {warm.offload_ratio:.1%} of this model is in VRAM at "
            f"num_ctx={num_ctx}. Numbers below reflect a partly CPU-bound model.\n"
            f"           Lower --num-ctx, or use --ctx-ceiling to find what fits.",
            flush=True,
        )
    print(f"  offload {warm.offload_ratio:.3f}   VRAM {warm.vram_mib} MiB", flush=True)

    for _ in range(reps):
        s = measure(client, model, "Write a Python function to merge two sorted lists.",
                    num_predict=256, num_ctx=num_ctx)
        if s.decode_tps:
            result.decode_tps.append(s.decode_tps)
        result.degraded_any |= s.degraded
    if result.decode_tps:
        print(f"  decode ({reps}x256 tok): {result.decode_tps} -> "
              f"mean {statistics.mean(result.decode_tps):.1f} tok/s", flush=True)

    # TTFT: the first sample includes one-off cache warming, so discard it.
    for i in range(reps + 1):
        s = measure(client, model, _FIM, num_predict=32, num_ctx=num_ctx)
        if i and s.ttft_ms:
            result.ttft_ms.append(s.ttft_ms)
    if result.ttft_ms:
        print(f"  TTFT: {result.ttft_ms} ms -> mean {statistics.mean(result.ttft_ms):.0f} ms",
              flush=True)

    for size in prompt_sizes:
        ctx = max(num_ctx, size * 2)
        s = measure(client, model, build_prompt(size), num_predict=32, num_ctx=ctx)
        result.prompt_sweep.append(asdict(s) | {"num_ctx": ctx})
        result.degraded_any |= s.degraded
        flag = "  [DEGRADED]" if s.degraded else ""
        print(f"  prompt {s.prompt_tokens:>6} tok @ ctx {ctx:>6}: "
              f"prefill {s.prefill_tps:>7} tok/s  decode {s.decode_tps:>6} tok/s{flag}",
              flush=True)

    if ctx_ceiling:
        print("  context ceiling:", flush=True)
        result.ctx_ceiling = find_ctx_ceiling(client, model, ctx_ceiling)
        ceiling = result.ctx_ceiling["ceiling"]
        print(f"    -> largest context with full offload: "
              f"{ceiling if ceiling else 'none of the tested values'}", flush=True)

    return result


def markdown_table(results: list[ModelResult]) -> str:
    """A table shaped for pasting straight into TUF/02-CAPACITY.md."""
    lines = [
        "| Model | VRAM loaded | Decode (short) | TTFT | Prefill @~5k | Max ctx (full offload) |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for r in results:
        decode = f"{statistics.mean(r.decode_tps):.1f} tok/s" if r.decode_tps else "—"
        ttft = f"{statistics.mean(r.ttft_ms):.0f} ms" if r.ttft_ms else "—"
        prefill = "—"
        for row in r.prompt_sweep:
            if 3000 <= row["prompt_tokens"] <= 8000 and row["prefill_tps"]:
                prefill = f"{row['prefill_tps']:.0f} tok/s"
                break
        ceiling = "—"
        if r.ctx_ceiling and r.ctx_ceiling["ceiling"]:
            ceiling = f"{r.ctx_ceiling['ceiling']:,}"
        flag = " ⚠️" if r.degraded_any else ""
        lines.append(
            f"| `{r.model}`{flag} | {r.weights_mib} MiB | {decode} | {ttft} | {prefill} | {ceiling} |"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(
        description="Benchmark ollama serving: decode, prefill, TTFT, context ceiling.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--models", nargs="+", required=True, help="ollama model tags")
    ap.add_argument("--host", default=DEFAULT_HOST)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--num-ctx", type=int, default=8192)
    ap.add_argument("--prompt-sizes", type=int, nargs="+", default=[500, 5000, 16000])
    ap.add_argument(
        "--ctx-ceiling",
        nargs="*",
        type=int,
        default=None,
        metavar="CTX",
        help="find the largest context with full offload; optionally give the ladder "
             "(default: 4096 8192 16384 32768)",
    )
    ap.add_argument("--out", default=None, help="write JSON results here")
    args = ap.parse_args(argv)

    ladder = None
    if args.ctx_ceiling is not None:
        ladder = args.ctx_ceiling or [4096, 8192, 16384, 32768]

    client = Client(args.host)
    info = host_info()
    print(f"host: {info['platform']}")
    print(f"accelerator: {info['accelerator']}")

    results = [
        run_model(client, m, args.models, args.reps, args.prompt_sizes, args.num_ctx, ladder)
        for m in args.models
    ]

    print("\n" + markdown_table(results) + "\n")

    degraded = [r.model for r in results if r.degraded_any]
    if degraded:
        print(
            "WARNING: partial offload during measurement for: " + ", ".join(degraded) + "\n"
            "         Those figures are partly CPU-bound and are NOT comparable to\n"
            "         fully-resident runs. Re-run with a smaller --num-ctx.",
            file=sys.stderr,
        )

    if args.out:
        payload = {"host": info, "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                   "results": [asdict(r) for r in results]}
        with open(args.out, "w") as fh:
            json.dump(payload, fh, indent=2)
        print(f"wrote {args.out}")

    return 1 if degraded else 0


if __name__ == "__main__":
    raise SystemExit(main())
