"""ULTRON environment smoke test. All checks must pass before writing project code.

    python scripts/smoke_test.py

Detects the machine and asserts only what that machine is supposed to do
(CLAUDE.md §4). On the Mac it asserts MLX + MPS and asserts CUDA is ABSENT;
on the TUF it asserts CUDA + bitsandbytes + unsloth.
"""

from __future__ import annotations

import importlib.metadata
import platform
import sys

FAILED: list[str] = []


def _version(dist: str) -> str:
    """Version from package metadata — several of these expose no __version__."""
    try:
        return importlib.metadata.version(dist)
    except importlib.metadata.PackageNotFoundError:
        return "?"


def check(name: str, fn) -> None:
    try:
        detail = fn()
    except Exception as exc:  # noqa: BLE001 - a smoke test reports, it does not raise
        FAILED.append(name)
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")
    else:
        print(f"  ok    {name}" + (f" — {detail}" if detail else ""))


def check_optional(name: str, fn, why: str) -> None:
    """Like check(), but a missing package is a skip, not a failure."""
    try:
        detail = fn()
    except ImportError:
        print(f"  skip  {name} — not installed ({why})")
    except Exception as exc:  # noqa: BLE001
        FAILED.append(name)
        print(f"  FAIL  {name}: {type(exc).__name__}: {exc}")
    else:
        print(f"  ok    {name}" + (f" — {detail}" if detail else ""))


def main() -> int:
    is_mac = platform.system() == "Darwin"
    machine = "MacBook Pro (arm64, no CUDA)" if is_mac else "TUF A17 (CUDA)"
    print(f"ULTRON smoke test — {machine}")
    print(f"python {sys.version.split()[0]} @ {sys.executable}\n")

    print("core:")

    def _torch():
        import torch

        return f"torch {torch.__version__}"

    def _transformers():
        import transformers

        return f"transformers {transformers.__version__}"

    def _tokenizer_roundtrip():
        # Pure-python tokenizer path, no model download, no network.
        from transformers import AutoTokenizer  # noqa: F401

        return "AutoTokenizer importable"

    def _datasets():
        import datasets

        return f"datasets {datasets.__version__} (always use streaming=True)"

    def _peft_trl():
        import peft
        import trl

        return f"peft {peft.__version__} / trl {trl.__version__}"

    def _dedup():
        from datasketch import MinHash, MinHashLSH

        lsh = MinHashLSH(threshold=0.8, num_perm=64)
        a, b = MinHash(num_perm=64), MinHash(num_perm=64)
        for tok in b"def solve(): pass".split():
            a.update(tok)
            b.update(tok)
        lsh.insert("a", a)
        assert lsh.query(b) == ["a"], "MinHashLSH failed to match an identical doc"
        return "MinHash LSH dedup works"

    check("torch", _torch)
    check("transformers", _transformers)
    check("tokenizers", _tokenizer_roundtrip)
    check("datasets", _datasets)
    check("peft + trl", _peft_trl)
    check("datasketch dedup", _dedup)

    if is_mac:
        print("\nmac-only (inference, merge, quantize, serve):")

        def _mlx():
            import mlx.core as mx

            # matmul is float-only in MLX; int32 operands raise.
            x = mx.arange(6, dtype=mx.float32).reshape(2, 3)
            got = (x @ x.T).tolist()
            assert got == [[5.0, 14.0], [14.0, 50.0]], f"MLX matmul wrong: {got}"
            return f"mlx {_version('mlx')}, matmul on Metal ok"

        def _mlx_lm():
            from mlx_lm import generate, load  # noqa: F401

            return "mlx_lm.load / generate importable"

        def _mps():
            import torch

            assert torch.backends.mps.is_available(), "MPS backend unavailable"
            t = torch.ones(4, device="mps") * 2
            assert t.sum().item() == 8.0
            return "torch MPS tensor op ok"

        def _no_cuda():
            import torch

            assert not torch.cuda.is_available(), (
                "CUDA reported available on the Mac — wrong machine or wrong wheel"
            )
            return "CUDA correctly absent"

        def _mergekit():
            from mergekit.config import MergeConfiguration  # noqa: F401

            return "mergekit importable"

        def _gguf():
            from gguf import GGUFWriter  # noqa: F401

            return f"gguf {_version('gguf')}"

        def _llama_cpp():
            from llama_cpp import Llama  # noqa: F401

            return f"llama-cpp-python {_version('llama-cpp-python')}, GGUF serve ok"

        check("mlx", _mlx)
        check("mlx-lm", _mlx_lm)
        check("torch MPS", _mps)
        check("no CUDA here", _no_cuda)
        check("mergekit", _mergekit)
        check("gguf", _gguf)
        check_optional("llama-cpp-python", _llama_cpp, "requirements/mac-gguf.txt")

    else:
        print("\ncuda-only (training):")

        def _cuda():
            import torch

            assert torch.cuda.is_available(), "CUDA unavailable — check the cu12x wheel"
            name = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info()
            return f"{name}, {free / 1e9:.1f}/{total / 1e9:.1f} GB free"

        def _bf16():
            import torch

            assert torch.cuda.is_bf16_supported(), (
                "bf16 unsupported — never fall back to fp16"
            )
            return "bf16 supported (sm_86)"

        def _bnb():
            import bitsandbytes as bnb

            return f"bitsandbytes {bnb.__version__}"

        def _unsloth():
            from unsloth import FastLanguageModel  # noqa: F401

            return "unsloth ok"

        check("cuda", _cuda)
        check("bf16", _bf16)
        check("bitsandbytes", _bnb)
        check("unsloth", _unsloth)

    print()
    if FAILED:
        print(f"{len(FAILED)} check(s) FAILED: {', '.join(FAILED)}")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
