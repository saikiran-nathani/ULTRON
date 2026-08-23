"""Training-capacity benchmark — validates the table in CLAUDE.md section 2.

    python scripts/bench_train.py --out results/train-tuf.json

Every configuration runs in its own subprocess. That is not fussiness: peak-VRAM
statistics and allocator fragmentation both persist for the life of a process, so
measuring several geometries in one process makes each result depend on the ones
before it. A fresh process per row is the only way the numbers compare.

An OOM is a RESULT, not a crash. The point of the table is to find where the 4 GB
ceiling actually falls, so a configuration that does not fit is recorded as `oom`
and the sweep continues.

Reported per row:
    peak_vram_mib   torch.cuda.max_memory_allocated -- tensors only
    peak_reserved   what the caching allocator held from the driver; this is the
                    number that decides whether the NEXT allocation OOMs
    s_per_step      optimizer steps, so it already includes grad_accum
    tok_per_s       real tokens through the model per wall-clock second
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

# (label, model_id, seq_len, per_device_batch, grad_accum, claim from CLAUDE.md section 2)
GRID = [
    ("0.5B s512  b1 a16", "Qwen/Qwen2.5-Coder-0.5B-Instruct",  512, 1, 16, "VRAM budget baseline"),
    ("0.5B s1024 b2 a8",  "Qwen/Qwen2.5-Coder-0.5B-Instruct", 1024, 2,  8, "Comfortable - default workhorse"),
    ("0.5B s1024 b1 a16", "Qwen/Qwen2.5-Coder-0.5B-Instruct", 1024, 1, 16, "not in the table - isolates tokens/forward from seq_len"),
    ("0.5B s2048 b1 a16", "Qwen/Qwen2.5-Coder-0.5B-Instruct", 2048, 1, 16, "Fine"),
    ("1.5B s512  b1 a16", "Qwen/Qwen2.5-Coder-1.5B-Instruct",  512, 1, 16, "Tight but works. Unsloth required."),
    ("1.5B s1024 b1 a16", "Qwen/Qwen2.5-Coder-1.5B-Instruct", 1024, 1, 16, "Marginal - expect to tune"),
    ("3B   s256  b1 a32", "Qwen/Qwen2.5-Coder-3B-Instruct",    256, 1, 32, "Marginal at best"),
]

WORKER = r'''
import json, os, sys, time
import torch
from datasets import Dataset
from transformers import AutoModelForCausalLM, AutoTokenizer, BitsAndBytesConfig
from peft import LoraConfig, prepare_model_for_kbit_training
from trl import SFTTrainer, SFTConfig
import transformers
transformers.logging.set_verbosity_error()

cfg = json.loads(sys.argv[1])
MID, SEQ, BS, GA, STEPS = cfg["model"], cfg["seq"], cfg["bs"], cfg["ga"], cfg["steps"]
USE_UNSLOTH = cfg["unsloth"]

out = {"ok": False}
try:
    if USE_UNSLOTH:
        from unsloth import FastLanguageModel
        model, tok = FastLanguageModel.from_pretrained(
            MID, max_seq_length=SEQ, dtype=torch.bfloat16, load_in_4bit=True)
        model = FastLanguageModel.get_peft_model(
            model, r=16, lora_alpha=32, lora_dropout=0, random_state=0,
            use_gradient_checkpointing="unsloth",
            target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])
        peft_cfg = None
    else:
        tok = AutoTokenizer.from_pretrained(MID)
        model = AutoModelForCausalLM.from_pretrained(
            MID, dtype=torch.bfloat16, device_map={"": 0},
            quantization_config=BitsAndBytesConfig(
                load_in_4bit=True, bnb_4bit_quant_type="nf4",
                bnb_4bit_compute_dtype=torch.bfloat16, bnb_4bit_use_double_quant=True))
        model = prepare_model_for_kbit_training(model, use_gradient_checkpointing=True)
        peft_cfg = LoraConfig(r=16, lora_alpha=32, lora_dropout=0.05, task_type="CAUSAL_LM",
            target_modules=["q_proj","k_proj","v_proj","o_proj","gate_proj","up_proj","down_proj"])

    out["weights_mib"] = round(torch.cuda.memory_allocated() / 2**20)

    # Samples must actually REACH seq_len or the measurement under-reports activations,
    # which are the dominant term. Build from real code text, then verify the token count.
    unit = (
        "def process_records(records, key, reverse=False):\n"
        "    \"\"\"Sort records by key, resolving ties alphabetically by name.\"\"\"\n"
        "    buckets = {}\n"
        "    for r in records:\n"
        "        buckets.setdefault(r[key], []).append(r)\n"
        "    ordered = []\n"
        "    for k in sorted(buckets, reverse=reverse):\n"
        "        ordered.extend(sorted(buckets[k], key=lambda r: r['name']))\n"
        "    return ordered\n\n"
    )
    body = unit * (SEQ // 40 + 4)
    text = tok.apply_chat_template(
        [{"role": "user", "content": "Refactor this module and explain each change.\n\n" + body},
         {"role": "assistant", "content": "```python\n" + body + "```"}], tokenize=False)
    n_tok = len(tok(text)["input_ids"])
    out["sample_tokens"] = n_tok
    out["fills_seq_len"] = n_tok >= SEQ
    ds = Dataset.from_list([{"text": text} for _ in range(BS * GA * (STEPS + 1))])

    args = SFTConfig(
        output_dir=os.environ.get("ML_RUNS", "/tmp") + "/_bench", max_steps=STEPS,
        per_device_train_batch_size=BS, gradient_accumulation_steps=GA, max_length=SEQ,
        bf16=True, gradient_checkpointing=not USE_UNSLOTH, optim="paged_adamw_8bit",
        logging_strategy="no", report_to=[], save_strategy="no", seed=0,
        dataset_num_proc=1, warmup_steps=0, learning_rate=2e-4)
    kw = {"peft_config": peft_cfg} if peft_cfg is not None else {}
    tr = SFTTrainer(model=model, train_dataset=ds, args=args, **kw)

    assert next(tr.model.parameters()).device.type == "cuda", "model is not on the GPU"
    trainable = sum(p.numel() for p in tr.model.parameters() if p.requires_grad)
    total = sum(p.numel() for p in tr.model.parameters())
    out["trainable_pct"] = round(100 * trainable / total, 4)
    assert out["trainable_pct"] > 0, "0% trainable -- LoRA did not attach"

    torch.cuda.reset_peak_memory_stats()
    t0 = time.time()
    res = tr.train()
    dt = time.time() - t0

    out.update(ok=True,
        steps=res.global_step,
        loss=round(res.training_loss, 4),
        s_per_step=round(dt / max(res.global_step, 1), 3),
        tok_per_s=round(res.global_step * BS * GA * min(n_tok, SEQ) / dt, 1),
        peak_vram_mib=round(torch.cuda.max_memory_allocated() / 2**20),
        peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20))
except torch.cuda.OutOfMemoryError as e:
    out.update(ok=False, status="oom", error=str(e).split("\n")[0][:200],
               peak_reserved_mib=round(torch.cuda.max_memory_reserved() / 2**20))
except Exception as e:
    out.update(ok=False, status="error", error=f"{type(e).__name__}: {str(e)[:300]}")

print("@@RESULT@@" + json.dumps(out))
'''


def run_one(model, seq, bs, ga, steps, unsloth, venv_py, workdir):
    src = Path(workdir) / "_bench_worker.py"
    src.write_text(WORKER)
    cfg = json.dumps({"model": model, "seq": seq, "bs": bs, "ga": ga,
                      "steps": steps, "unsloth": unsloth})
    env = dict(os.environ, PYTORCH_CUDA_ALLOC_CONF="expandable_segments:True",
               TOKENIZERS_PARALLELISM="false")
    p = subprocess.run([venv_py, str(src), cfg], capture_output=True, text=True,
                       env=env, timeout=3600)
    for line in p.stdout.splitlines():
        if line.startswith("@@RESULT@@"):
            return json.loads(line[len("@@RESULT@@"):])
    tail = (p.stderr or p.stdout).strip().splitlines()
    return {"ok": False, "status": "crash", "error": " | ".join(tail[-3:])[:400]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="results/train-tuf.json")
    ap.add_argument("--steps", type=int, default=6)
    ap.add_argument("--unsloth", action="store_true",
                    help="use unsloth instead of plain peft+TRL (needs a C compiler)")
    ap.add_argument("--only", default=None, help="substring filter on the label")
    a = ap.parse_args()

    venv_py = sys.executable
    workdir = os.environ.get("TMPDIR", "/tmp")
    backend = "unsloth" if a.unsloth else "peft+trl"
    rows = []

    print(f"training-capacity benchmark — backend={backend}, {a.steps} optimizer steps/config\n")
    hdr = (f"{'config':<20} {'status':<7} {'tok/fwd':>8} {'logits':>7} "
           f"{'peak MiB':>9} {'reserved':>9} {'s/step':>7} {'tok/s':>8}")
    print(hdr); print("-" * len(hdr))

    for label, model, seq, bs, ga, claim in GRID:
        if a.only and a.only not in label:
            continue
        r = run_one(model, seq, bs, ga, a.steps, a.unsloth, venv_py, workdir)
        # The binding constraint on this box is not model size: it is the fp32 logits
        # tensor, vocab_size * tokens_per_forward * 4 B. Qwen's vocab is 151,936, so at
        # 2048 tokens/forward that single tensor is 1.16 GiB of a 4 GB card. Recording it
        # here is what makes an OOM row diagnosable instead of just red.
        tpf = seq * bs
        r.update(label=label, model=model, seq_len=seq, batch=bs, grad_accum=ga,
                 tokens_per_forward=tpf,
                 fp32_logits_gib=round(151936 * tpf * 4 / 2**30, 2),
                 claim=claim, backend=backend)
        rows.append(r)
        if r.get("ok"):
            print(f"{label:<20} {'ok':<7} {r['tokens_per_forward']:>8} "
                  f"{str(r['fp32_logits_gib'])+'G':>7} {r['peak_vram_mib']:>9} "
                  f"{r['peak_reserved_mib']:>9} {r['s_per_step']:>7} {r['tok_per_s']:>8}")
        else:
            print(f"{label:<20} {r.get('status','fail'):<7} {r['tokens_per_forward']:>8} "
                  f"{str(r['fp32_logits_gib'])+'G':>7} {'-':>9} "
                  f"{r.get('peak_reserved_mib','-'):>9} {'-':>7} {'-':>8}   {r.get('error','')[:55]}")

    import torch  # noqa: E402  -- imported late so a failed sweep still prints
    meta = {"gpu": torch.cuda.get_device_name(0),
            "vram_total_mib": round(torch.cuda.get_device_properties(0).total_memory / 2**20),
            "torch": torch.__version__, "backend": backend,
            "generated": time.strftime("%Y-%m-%dT%H:%M:%S%z")}
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    prev = {}
    if Path(a.out).exists():
        prev = json.loads(Path(a.out).read_text())
    prev.setdefault("host", meta)
    prev.setdefault("runs", {})[backend] = rows
    prev["generated"] = meta["generated"]
    Path(a.out).write_text(json.dumps(prev, indent=2))
    print(f"\nwrote {a.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
