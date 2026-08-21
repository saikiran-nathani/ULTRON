#!/usr/bin/env python3
"""Slide 27 — measure token-length percentiles before setting seq_len.

Measures the TEMPLATED length (chat template applied), because that is what has
to fit inside seq_len -- not the raw text length.

    python src/data/measure_lengths.py --config configs/02-model-checks.yaml

Reads a local JSONL or streams an HF dataset. Prints a percentile table, the
chars/token ratio, and a truncation table for the candidate seq_lens. Copy the
summary block into results/02-model.md by hand (slide 12: results/ is written
by hand).
"""
import argparse
import json
import sys

import numpy as np
import yaml
from transformers import AutoTokenizer


def iter_rows(src, prompt_field, response_field, limit):
    """Yield (prompt, response) pairs from a JSONL path or an HF dataset id."""
    if src.endswith((".jsonl", ".json")):
        with open(src) as fh:
            for i, line in enumerate(fh):
                if i >= limit:
                    return
                row = json.loads(line)
                yield row[prompt_field], row[response_field]
    else:
        from datasets import load_dataset

        ds = load_dataset(src, split="train", streaming=True)
        for i, row in enumerate(ds):
            if i >= limit:
                return
            yield row[prompt_field], row[response_field]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    ap.add_argument("--limit", type=int, default=2000)
    args = ap.parse_args()

    cfg = yaml.safe_load(open(args.config))
    tok = AutoTokenizer.from_pretrained(cfg["base_model"])
    src = cfg["measure"]["source"]
    pf = cfg["measure"]["prompt_field"]
    rf = cfg["measure"]["response_field"]
    candidates = cfg["measure"]["seq_len_candidates"]

    lens, chars = [], []
    for prompt, response in iter_rows(src, pf, rf, args.limit):
        msgs = [{"role": "user", "content": prompt},
                {"role": "assistant", "content": response}]
        text = tok.apply_chat_template(msgs, tokenize=False,
                                       add_generation_prompt=False)
        lens.append(len(tok(text, add_special_tokens=False).input_ids))
        chars.append(len(text))

    if not lens:
        sys.exit("no rows read -- check source and field names")

    lens = np.array(lens)
    ratio = sum(chars) / lens.sum()

    print(f"\nsource   {src}")
    print(f"model    {cfg['base_model']}")
    print(f"rows     {len(lens)}\n")

    print("templated token length")
    for p in (50, 90, 95, 99):
        print(f"  p{p:<3} {int(np.percentile(lens, p)):>6}")
    print(f"  max  {lens.max():>6}")
    print(f"\nchars/token  {ratio:.2f}   (slide 27: expect ~3 for code, not 4)\n")

    print("truncation at candidate seq_len")
    print(f"  {'seq_len':>8} {'over':>7} {'% over':>8}")
    for s in candidates:
        over = int((lens > s).sum())
        print(f"  {s:>8} {over:>7} {100 * over / len(lens):>7.1f}%")

    p95 = int(np.percentile(lens, 95))
    pick = min((c for c in candidates if c >= p95), default=max(candidates))
    print(f"\np95 = {p95}  ->  smallest candidate covering p95: {pick}")
    print("DROP rows over seq_len; never truncate them (slide 27 field note).\n")

    print("--- paste into results/02-model.md ---")
    print(f"- source: `{src}` (n={len(lens)})")
    print(f"- p50/p90/p95/p99: "
          f"{'/'.join(str(int(np.percentile(lens, p))) for p in (50, 90, 95, 99))}")
    print(f"- chars/token: {ratio:.2f}")
    print(f"- seq_len chosen: {pick} "
          f"(drops {100 * (lens > pick).sum() / len(lens):.1f}% of rows)")


if __name__ == "__main__":
    main()
