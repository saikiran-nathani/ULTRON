# STATUS — living state of the project

**Update this at the end of every session.** It is the first thing the next session reads.

Last updated: **2026-08-17** · Updated by: initial handoff prep (Mac)

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

---

## TUF machine state — UNVERIFIED

Nothing below has been confirmed on the actual hardware from this session. **Verify each line and
update it before trusting any of it.**

| Item | Expected | Verified? |
|---|---|---|
| Ubuntu 26.04 installed | Yes | ☐ |
| MOK enrolled, `nvidia-smi` works | RTX 3050, 4096 MiB | ☐ |
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

Nothing measured yet. When results exist, they live in `results/NN-phase.md` and this table indexes them.

| Phase | Config | Data version | HumanEval+ pass@1 | Seeds | Date | Notes |
|---|---|---|---|---|---|---|
| — | — | — | — | — | — | No runs yet |

---

## Open questions / blockers

| # | Question | Status |
|---|---|---|
| 1 | Is the TUF's Wi-Fi genuinely dead, or disabled in BIOS? | Open — see [01-SETUP.md](01-SETUP.md) Step 3. Not a blocker; Ethernet is adequate. |
| 2 | Did the 1 TB get reformatted to ext4, or is it still NTFS? | Open — decides whether `HF_HOME` points at `/data` or the 512 GB root |
| 3 | Real measured VRAM headroom vs the estimated tables | Open — capture `/data/baseline.txt` and reconcile |

---

## Decisions already made — do not relitigate

- **QLoRA only.** No full fine-tuning.
- **bf16 only.** Never fp16 on this card.
- **No rented GPUs / cloud compute.** Learning on owned hardware. Plan around 4 GB.
- **Qwen2.5-Coder-0.5B is the target.** 1.5B is the stretch, 7B+ is out of scope for training here.
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
