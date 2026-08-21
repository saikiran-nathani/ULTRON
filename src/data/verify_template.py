#!/usr/bin/env python3
"""Slide 28 — verify the chat template before a single GPU-hour is spent.

    python src/data/verify_template.py --config configs/02-model-checks.yaml

Every check either prints PASS or raises. The load-bearing one is TRAIN PREFIX:
the training text must begin with exactly the bytes inference will feed. If that
fails, you have the train-not-equal-eval bug (slide 28) and no amount of
hyperparameter tuning will fix it.

Also prints the response_template string that loss masking will need later
(slides 69 and 99) -- it must match byte for byte or masking silently does
nothing.
"""
import argparse
import sys

import yaml
from transformers import AutoTokenizer

SPECIALS = ("<|im_start|>", "<|im_end|>")
INJECTION_MARKERS = ("<|im_start|>", "<|im_end|>", "<|endoftext|>", "<|fim_")

USER = "Write a function to reverse a list."
ASSISTANT = "def reverse(xs): return xs[::-1]"


def check(label, ok, detail=""):
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{'  ' + detail if detail else ''}")
    return ok


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", required=True)
    args = ap.parse_args()

    cfg = yaml.safe_load(open(args.config))
    model = cfg["base_model"]
    system = cfg["template"].get("system_prompt")

    tok = AutoTokenizer.from_pretrained(model)
    print(f"\nmodel     {model}")
    print(f"template  {cfg['template']['name']}")
    print(f"system    {'set' if system else 'NONE'}\n")

    base = ([{"role": "system", "content": system}] if system else [])
    msgs = base + [{"role": "user", "content": USER}]

    infer = tok.apply_chat_template(msgs, tokenize=False,
                                    add_generation_prompt=True)
    train = tok.apply_chat_template(
        msgs + [{"role": "assistant", "content": ASSISTANT}],
        tokenize=False, add_generation_prompt=False)

    print("INFERENCE TEXT (add_generation_prompt=True)")
    print(f"  {infer!r}\n")
    print("TRAINING TEXT (add_generation_prompt=False)")
    print(f"  {train!r}\n")

    ok = True
    print("checks")

    # The one that matters.
    ok &= check("TRAIN PREFIX  training text starts with the inference text",
                train.startswith(infer))

    # Special tokens must be single ids, not shredded into plain text.
    for t in SPECIALS:
        ids = tok(t, add_special_tokens=False).input_ids
        ok &= check(f"SPECIAL       {t} is one token", len(ids) == 1, f"ids={ids}")

    # A dangling assistant header teaches endless generation (slide 29).
    header = infer[len(tok.apply_chat_template(msgs, tokenize=False,
                                              add_generation_prompt=False)):]
    ok &= check("NO DANGLE     training text has no trailing assistant header",
                not train.endswith(header) or not header)

    # EOS must exist and be the turn terminator on an Instruct checkpoint.
    ok &= check("EOS           eos_token is set", tok.eos_token is not None,
                f"{tok.eos_token!r} id={tok.eos_token_id}")

    # pad == eos is the setup for the masked-EOS bug on slide 29.
    if tok.pad_token is not None and tok.pad_token == tok.eos_token:
        print("  WARN  pad_token == eos_token -- if you mask pads out of the "
              "loss you also mask EOS (slide 29)")

    # The string loss masking will key on later.
    print(f"\nresponse_template for slides 69/99:")
    print(f"  {header!r}")
    ok &= check("RESPONSE      appears exactly once in training text",
                train.count(header) == 1 if header else False)

    # Data hygiene: template tokens smuggled in via content (slide 27).
    print("\ninjection scan")
    dirty = [m for m in INJECTION_MARKERS if m in USER + ASSISTANT]
    ok &= check("CLEAN         sample content has no special-token strings",
                not dirty, f"found={dirty}" if dirty else "")
    print("  NOTE  run this scan over your real curated set, not just this sample")

    print(f"\n{'ALL CHECKS PASSED' if ok else 'FAILURES ABOVE -- fix before training'}\n")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
