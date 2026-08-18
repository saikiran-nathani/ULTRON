# STATUS — living state of the project

**Update this at the end of every session.** It is the first thing the next session reads.

Last updated: **2026-08-18** · Updated by: serving benchmark logged (TUF)

---

## Where we actually are

**Week 0. Nothing is built yet.**

The repository currently contains documentation only:

| Path | State |
|---|---|
| `CLAUDE.md` | Machine + project context. Present. |
| `docs/` | 190-slide field guide, built (`ULTRON-Field-Guide.pptx`) + `OUTLINE.md` manifest + `sections/*.js` source |
| `TUF/` | This handoff pack. Present. |
| `src/` | **Does not exist** |
| `configs/` | **Does not exist** |
| `results/` | **Does not exist** |
| `data/` | **Does not exist** |
| `checkpoints/` | **Does not exist** |

Git: one commit (`init`), plus this handoff branch.

**One thing has been measured on real hardware:** a GGUF serving benchmark at 1.5B (see results log).
That is hardware characterization, not a pipeline phase — it does not move the project off Week 0,
and it does not substitute for the sandbox and eval harness that still gate everything.

---

## TUF machine state — MOSTLY UNVERIFIED

The 2026-08-18 serving benchmark confirms the GPU path end to end: the driver reports VRAM, a GGUF
model loaded with `-ngl 99`, and it decoded at full speed. That ticks the driver row and implies a
working llama.cpp CUDA build. **Everything else below is still unconfirmed — verify before trusting.**

| Item | Expected | Verified? |
|---|---|---|
| Ubuntu 26.04 installed | Yes | ☐ |
| MOK enrolled, `nvidia-smi` works | RTX 3050, 4096 MiB | ☑ implied by 2026-08-18 benchmark |
| Hybrid mode, display on Renoir iGPU | idle VRAM 5–20 MB | ☐ |
| Wi-Fi | Known absent — Ethernet only. See [01-SETUP.md](01-SETUP.md) Step 3 | ☐ |
| `/data` mounted from the 1 TB, in `/etc/fstab` by UUID | ext4, owned by `$USER` | ☐ |
| Swap enlarged to 16 GB | `swapon --show` | ☐ |
| SSH + `tuf.local` reachable from the Mac | `ssh tuf` | ☐ |
| Lid-close suspend disabled | `HandleLidSwitch=ignore` | ☐ |
| `HF_HOME=/data/hf` set **before any download** | `echo $HF_HOME` | ☐ |
| conda env `ultron` (python 3.11) | — | ☐ |
| torch + CUDA | `get_device_capability()` → `(8, 6)` | ☐ |
| `python -m bitsandbytes` passes | — | ☐ |
| `unsloth` imports | — | ☐ |
| Docker installed, `hello-world` runs | ~50 ms/container | ☐ |
| llama.cpp CUDA build works | `-ngl 99` offload, GGUF loads | ☑ 2026-08-18 benchmark |
| W&B authenticated | `wandb.init()` + one metric | ☐ |
| flash-attn (optional) | `MAX_JOBS=4 pip install flash-attn --no-build-isolation` | ☐ |
| `/data/baseline.txt` captured | See [01-SETUP.md](01-SETUP.md) Step 12 | ☐ |

---

## Next actions, in order

Per [04-WORK-QUEUE.md](04-WORK-QUEUE.md). **Nothing on this list trains a model — that is the point.**

1. ☐ Work through [01-SETUP.md](01-SETUP.md) end to end on the TUF; tick every box in the table above
2. ☐ Create the repo directory structure (`data/ src/ configs/ results/ checkpoints/`) and commit it empty
3. ☐ Confirm both environments pass smoke tests — CUDA on the TUF, MLX on the Mac
4. ☐ Write `src/sandbox/executor.py` + the 12-case adversarial suite (Mac writes, TUF runs bulk)
5. ☐ Write `src/eval/harness.py`, produce `results/00-baseline.md` — one command, one number, three seeds
6. ☐ Only then download a training dataset

**Do not start SFT until step 5 is done.** Everything after the baseline is "better than that number";
if the number is wrong, every later claim is wrong.

---

## Results log

### Training / eval results

**Nothing measured yet.** When results exist they live in `results/NN-phase.md` and this table indexes them.

| Phase | Config | Data version | HumanEval+ pass@1 | Seeds | Date | Notes |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | No runs yet |

### Serving benchmark — MEASURED on the TUF, 2026-08-18

**Model: Qwen2.5-Coder-1.5B** — inferred from the artifact sizes (986 MB / 1.6 GB match 1.5B, not
0.5B). As of 2026-08-18 this is the **ship target**; 0.5B remains the dev-loop model. These numbers
describe the shipped artifact, not the iteration model — do not file them under 0.5B.

llama.cpp / GGUF, `-ngl 99`.

| Metric | Q4_K_M (986 MB) | Q8_0 (1.6 GB) | Q4 advantage |
|---|---|---|---|
| Decode, short prompt | **116.4 tok/s** | 91.2 tok/s | **+27.6%** |
| Decode, 5k prompt | 108.8 | 86.6 | +25.6% |
| Decode, 20k prompt | 84.5 | 70.3 | +20.2% |
| Prefill, 5k prompt | 4,326 tok/s | 4,496 tok/s | −3.9% |
| Prefill, 20k prompt | 2,934 | 2,949 | −0.5% (tie) |
| VRAM loaded | **1,394 MiB** | 2,024 MiB | **−630 MiB** |
| VRAM @ 32K context | **2,124 MiB** | 2,654 MiB | −530 MiB |
| CPU-only decode | 24.8 tok/s | 16.0 tok/s | **+55%** |

**Derived — effective memory bandwidth**

| Format | Bytes/token × tok/s | Effective BW | % of ~192 GB/s peak |
|---|---|---|---|
| Q4_K_M | 986 MB × 116.4 | ~115 GB/s | 60% |
| Q8_0 | 1,600 MB × 91.2 | ~146 GB/s | **76%** |

CPU-only lands at ~25 GB/s for both — roughly half of dual-channel DDR4-3200's ~51 GB/s theoretical.
The two agreeing within 5% is a good signal the measurements are clean.
**GPU speedup over CPU: 4.7× (Q4), 5.7× (Q8)** — modest, because this is a bandwidth-bound workload
on a bandwidth-modest card.

**Conclusions**

- **Ship Q4_K_M.** Faster decode, 630 MiB less VRAM, 55% faster CPU fallback. It loses prefill by an
  amount inside run-to-run noise. There is no axis where Q8_0's extra 630 MB buys anything measurable.
- **Decode is bandwidth-bound; prefill is compute-bound.** Quantization only helps decode. Q8_0's
  marginal prefill win is Q4_K's dequantization overhead showing up where weights are reused across
  many tokens.
- **Q8_0 is nearly bandwidth-saturated (76% of peak). Q4_K_M gives up ~16% of peak to dequant cost**
  — which is why the speedup is 1.28× rather than the 1.62× the file-size ratio predicts.
- **Quality was NOT measured.** These are speed and footprint only. See open question 5.

---

## Open questions / blockers

| # | Question | Status |
|---|---|---|
| 1 | Is the TUF's Wi-Fi genuinely dead, or disabled in BIOS? | Open — see [01-SETUP.md](01-SETUP.md) Step 3. Not a blocker; Ethernet is adequate. |
| 2 | Did the 1 TB get reformatted to ext4, or is it still NTFS? | Open — decides whether `HF_HOME` points at `/data` or the 512 GB root |
| 3 | Real measured VRAM headroom vs the estimated tables | **Partly closed** — 1.5B GGUF inference measured (see results log). Training-side VRAM still estimated; capture `/data/baseline.txt` to finish. |
| 4 | KV cache delta differs between quants: 730 MiB (Q4_K_M) vs 630 MiB (Q8_0) at 32K | **Open — anomaly.** KV cache is a function of architecture and context, not weight quantization. These deltas should match. Re-run with identical `--cache-type-k/v` and context flags before trusting either figure. |
| 5 | Quality of Q4_K_M vs Q8_0 — unmeasured | **Open.** Speed says ship Q4_K_M; nothing yet confirms the quality cost is inside noise. Run `harness.py` against the served endpoint, both quants, three seeds. This is the "eval the checkpoint, ship the quant" trap. |

---

## Decisions already made — do not relitigate

- **QLoRA only.** No full fine-tuning.
- **bf16 only.** Never fp16 on this card.
- **No rented GPUs / cloud compute.** Learning on owned hardware. Plan around 4 GB.
- **Two models, two jobs** (decided 2026-08-18). **0.5B is the dev loop** — pipeline development and
  every ablation, 20–40 min per SFT run. **1.5B is the ship target**, served as Q4_K_M GGUF. Build at
  0.5B; re-run the settled recipe at 1.5B once. Do not iterate at 1.5B. 7B+ is out of scope entirely.
- **Serving format is Q4_K_M** (decided 2026-08-18, on measured evidence): faster decode, 630 MiB
  less VRAM, 55% faster CPU fallback than Q8_0. Quality confirmation still outstanding — open question 5.
- **The Mac owns data and eval. The TUF owns training.**
- **Pipeline order is fixed** and not up for discussion.

---

## How to update this file

At the end of a session, edit in place:

1. Bump the "Last updated" line and say which machine you were on
2. Tick verified boxes; add anything newly discovered about the hardware
3. Move completed items out of "Next actions" and add the next ones
4. Add any measured number to the results log **with its config and seeds**
5. Add blockers as you hit them; close them as you resolve them

> A results file with only successes is a marketing document. **Write down what failed.**
