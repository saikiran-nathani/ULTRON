/* PART II — ENVIRONMENT  (Phase 1: SETUP) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("SETUP", "Phase 1", "Getting Both Machines Working",
    "Two days, and it is genuinely the least fun part. Do it properly once —\nevery hour spent here is repaid in not debugging phantom problems later."));

  /* ---- Dependency matrix ---- */
  {
    const s = T.slide("Setup", "What runs where — the dependency matrix",
      "Print this. It answers 90% of the 'why doesn't this work on my Mac' questions.");
    T.table(s, 1.62,
      ["Library", "Purpose", "Asus (Ubuntu + CUDA)", "Mac (macOS + Metal)"],
      [
        ["torch", "Everything", "Yes — cu12x/cu13x wheels", "Yes — MPS backend, partial op coverage"],
        ["transformers", "Model loading, generation", "Yes", "Yes"],
        ["datasets", "Data loading, streaming", "Yes", "Yes"],
        ["peft", "LoRA / adapters", "Yes", "Yes (slow on MPS)"],
        ["trl", "SFT / DPO / GRPO trainers", "Yes", "Partial — no vLLM backend"],
        ["bitsandbytes", "4-bit / 8-bit quantization", "Yes — this is why QLoRA works", "NO — CUDA only"],
        ["unsloth", "2x faster, ~50% less VRAM", "Yes — Triton native on Linux", "NO — CUDA only"],
        ["flash-attn", "Fused attention kernel", "Yes (Ampere) — ~20 min build", "NO — CUDA only"],
        ["triton", "Kernel compiler under Unsloth", "Yes — first-class on Linux", "NO"],
        ["vllm", "Fast batched inference / RL rollouts", "Installs, but 4GB caps it", "NO — not practical"],
        ["deepspeed", "Multi-GPU sharding", "Irrelevant (single GPU)", "NO"],
        ["mlx / mlx-lm", "Apple-native training + serving", "NO", "Yes — the native path"],
        ["llama.cpp", "GGUF inference, accelerated", "Yes (CUDA build)", "Yes — excellent (Metal)"],
        ["docker", "Level-2 sandbox isolation", "Native — ~50ms/container", "VM-backed — 1–3s/container"],
        ["resource / os.setsid", "Level-1 sandbox limits", "Yes — POSIX", "Yes — POSIX"],
        ["evalplus", "HumanEval+ / MBPP+ harness", "Yes", "Yes"],
        ["mergekit", "Checkpoint merging", "Yes", "Yes (CPU)"],
      ],
      [1.9, 3.4, 3.3, 3.6], { size: 10, rowH: 0.3 });
    T.num(s);
  }

  /* ---- Asus setup ---- */
  {
    const s = T.slide("Setup", "The Asus — your CUDA classroom", "Ubuntu 26.04 LTS. Windows was removed — see TUF/01-SETUP.md.");
    T.codeBlock(s, 0.55, 1.62, 6.5, 4.3, [
      { t: "# 1. NVIDIA driver (the ONLY system-level piece)", c: C.moss },
      "ubuntu-drivers devices",
      "sudo ubuntu-drivers autoinstall && sudo reboot",
      "nvidia-smi        # RTX 3050, 4096MiB",
      "",
      { t: "# 2. Build tools + environment", c: C.moss },
      "sudo apt install -y build-essential git",
      "conda create -n ultron python=3.11 -y",
      "conda activate ultron",
      "",
      { t: "# 3. Torch — CUDA runtime ships INSIDE the wheel", c: C.moss },
      "pip install torch --index-url \\",
      "  https://download.pytorch.org/whl/cu128",
      "",
      { t: "# 4. The training stack", c: C.moss },
      "pip install transformers datasets accelerate",
      "pip install peft trl bitsandbytes unsloth wandb",
      "",
      { t: "# 5. Optional — ~20 min to compile, worth it once", c: C.moss },
      "pip install flash-attn --no-build-isolation",
    ], "ASUS TUF A17 · UBUNTU 26.04 LTS · RTX 3050 4GB");

    T.grid(s, 1.62, [
      ["Linux buys you ~0.5–1 GB of VRAM", "Windows' desktop compositor held 500–1000 MB permanently — 12–25% of a 4GB card. With the display on the integrated Radeon, idle dGPU usage is single-digit MB. That reclaimed headroom is what makes 1.5B comfortable.", C.moss],
      ["You do NOT need the CUDA Toolkit", "PyTorch's wheels bundle their own CUDA runtime; only the DRIVER is system-wide. Most guides tell you to install the full toolkit — a large download you do not need.", C.moss],
      ["Unsloth is not optional here", "On 4GB it is the difference between 1.5B training and 1.5B OOM-ing. Roughly 2x faster and ~50% less VRAM. Triton (its dependency) is native on Linux.", C.moss],
      ["16GB system RAM is the real ceiling", "You hit host-RAM limits during dataset loading long before VRAM limits. Stream, don't load. Keep 16GB of swap.", C.amber],
    ], { cols: 1, x: 7.3, w: 5.45, h: 1.04, gapY: 0.11 });
    T.num(s);
  }

  /* ---- Free the card ---- */
  {
    const s = T.slide("Setup", "Freeing the card — the Linux-specific win");
    s.addText(
      "On a 4GB card, half a gigabyte is 12% of your entire budget. This is the single most " +
      "concrete reason the Asus runs Ubuntu rather than Windows.",
      { x: 0.55, y: 1.35, w: 12.2, h: 0.6, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" });
    T.table(s, 2.05,
      ["Setup", "Idle VRAM held", "Usable for training", "Notes"],
      [
        ["Windows 11 + browser open", "500–1000 MB", "~3.0–3.5 GB", "DWM compositor + browser GPU process"],
        ["Ubuntu, desktop on dGPU", "150–300 MB", "~3.7 GB", "avoid this — no reason to drive the display from the 3050"],
        ["Ubuntu, hybrid (display on iGPU)", "5–20 MB", "~3.95 GB", "the default. This is what you want."],
        ["Ubuntu, TTY only (Ctrl+Alt+F3)", "~5 MB", "~3.95 GB", "marginal further gain; useful for the longest runs"],
      ],
      [3.9, 2.3, 2.7, 3.3], { size: 11, rowH: 0.42 });
    T.codeBlock(s, 0.55, 4.3, 7.4, 1.35, [
      { t: "# Verify before every long run", c: C.moss },
      "nvidia-smi --query-gpu=memory.used,memory.total --format=csv",
      { t: "# want single-digit MB used, not 600", c: C.amber },
    ]);
    T.grid(s, 4.3, [
      ["Stay in Hybrid mode", "Do NOT switch to dGPU-only. Hybrid is what keeps the 3050 free.", C.moss],
      ["The budgets assume a clean card", "Every VRAM table in this deck assumes hybrid mode.", C.amber],
    ], { cols: 1, x: 8.15, w: 4.6, h: 0.62, gapY: 0.11 });
    T.fieldNote(s, 0.55, 5.85, 12.2, 0.95,
      "This is not a micro-optimization. On a 24GB card nobody would notice; on 4GB it is the difference between 1.5B being marginal and being routine.");
    T.num(s);
  }

  /* ---- Mac setup ---- */
  {
    const s = T.slide("Setup", "The Mac — your workshop");
    T.codeBlock(s, 0.55, 1.35, 6.5, 4.5, [
      { t: "# 1. Environment", c: C.moss },
      "conda create -n ultron python=3.11 -y",
      "conda activate ultron",
      "",
      { t: "# 2. Torch (MPS backend ships by default)", c: C.moss },
      "pip install torch",
      "python -c \"import torch; \\",
      "  print(torch.backends.mps.is_available())\"",
      "",
      { t: "# 3. Apple-native training + serving", c: C.moss },
      "pip install mlx mlx-lm",
      "",
      { t: "# 4. Data + eval (the Mac's real job)", c: C.moss },
      "pip install transformers datasets evalplus",
      "pip install datasketch      # MinHash dedup",
      "pip install sentence-transformers",
      "",
      { t: "# 5. GGUF inference", c: C.moss },
      "brew install llama.cpp",
    ], "MACBOOK PRO M5 PRO · 48GB");

    T.grid(s, 1.35, [
      ["48GB unified is the superpower", "You can hold a 14B model in 4-bit AND a dedup index in RAM simultaneously. Most rented GPUs cannot.", C.moss],
      ["MPS is a trap for training", "It works, but many ops silently fall back to CPU. You get correct results at 1/10th the speed and no warning. Use MLX instead.", C.rust],
      ["MLX is the native path", "mlx_lm.lora trains, mlx_lm.generate serves, mlx_lm.convert quantizes. Fast, but Apple-specific — not transferable knowledge.", C.ink],
      ["This machine owns the data pipeline", "Dedup, decontamination, and synthetic generation are all RAM-bound. They belong here, not on the Asus.", C.moss],
    ], { cols: 1, x: 7.3, w: 5.45, h: 1.08, gapY: 0.12 });
    T.num(s);
  }

  /* ---- Smoke tests ---- */
  {
    const s = T.slide("Setup", "Smoke tests — catch 90% of setup bugs in 5 minutes",
      "Run every one of these before you write a single line of project code.");
    T.accentRows(s, 1.62, [
      ["CUDA visible", "torch.cuda.is_available()", "Must print True on the Asus. If False: driver/torch CUDA version mismatch. Reinstall torch with the matching cuXXX index URL.", C.moss],
      ["bitsandbytes works", "python -m bitsandbytes", "Runs a self-test. This is the single most common broken install — it fails silently at training time otherwise.", C.moss],
      ["4-bit load succeeds", "load_in_4bit=True on 0.5B", "Loads Qwen2.5-Coder-0.5B in NF4. If this OOMs on a 4GB card, something else is holding VRAM.", C.moss],
      ["A 10-step LoRA run completes", "trl SFTTrainer, max_steps=10", "End-to-end proof: data → tokenizer → model → optimizer → backward → save. Ten steps, two minutes.", C.moss],
      ["MPS available", "torch.backends.mps.is_available()", "On the Mac. True means the backend exists — it does not mean every op is implemented.", C.lightMoss],
      ["MLX generates", "mlx_lm.generate --model ...", "Confirms the Apple path works and the model downloads correctly.", C.lightMoss],
      ["W&B logs", "wandb.init() + one metric", "Confirms auth and network. Do this before a 6-hour run, not during.", C.lightMoss],
    ], { h: 0.72, labelW: 2.7 });
    T.num(s);
  }

  /* ---- Common setup failures ---- */
  {
    const s = T.slide("Setup", "The setup failures you will actually hit",
      "The first four are Ubuntu-specific and all happen in your first hour.");
    T.table(s, 1.62,
      ["Symptom", "Real cause", "Fix"],
      [
        ["nvidia-smi: 'couldn't communicate with the NVIDIA driver'", "Secure Boot rejected the unsigned kernel module", "Enroll the MOK key at the blue boot screen, or disable Secure Boot in BIOS"],
        ["Black screen after installing the driver", "Wrong driver branch for the card", "Boot with nomodeset, then sudo ubuntu-drivers autoinstall"],
        ["/data is empty after a reboot", "Second SSD not in /etc/fstab", "Add it by UUID; test with sudo mount -a BEFORE rebooting"],
        ["Permission denied writing to /data", "Mount owned by root", "sudo chown -R $USER:$USER /data"],
        ["torch.cuda.is_available() is False", "CPU-only torch wheel installed by default", "Reinstall from the matching cuXXX index URL"],
        ["bitsandbytes: 'CUDA Setup failed'", "Library can't find libcudart", "Match bnb version to torch CUDA; run python -m bitsandbytes"],
        ["OOM immediately on a 0.5B model", "Something else holds the card, or you left hybrid mode", "nvidia-smi first; expect single-digit MB idle"],
        ["Training is 20x slower than expected", "Silently running on CPU (Mac MPS fallback)", "Assert device in code; watch it, don't assume"],
        ["flash-attn install hangs forever", "Compiling from source, single-threaded", "MAX_JOBS=4, --no-build-isolation, or skip it"],
        ["Disk fills up in a week", "HF cache defaulting to the 512GB root disk", "export HF_HOME=/data/hf early, not later"],
        ["Unsloth import error", "Installed on the Mac", "It is CUDA-only. Asus only."],
        ["Dataset load kills the process", "16GB RAM, non-streaming load", "streaming=True, or do it on the Mac"],
        ["NaN loss on step 1 with fp16", "fp16 overflow in attention", "Use bf16 — Ampere supports it"],
      ],
      [4.0, 3.9, 4.3], { size: 9.5, rowH: 0.30 });
    T.fieldNote(s, 0.55, 5.95, 12.2, 1.0,
      "HF_HOME is the one that bites hardest on this machine. The OS SSD is only 512GB and the default cache lands in your home " +
      "directory — a 200GB download will fill the root partition and take the desktop down with it. Set HF_HOME=/data/hf in " +
      "~/.bashrc before you download a single model.");
    T.num(s);
  }

  /* ---- W&B ---- */
  {
    const s = T.slide("Setup", "Experiment tracking — what to actually log");
    T.compare(s, 1.4, 3.1,
      { title: "LOG THESE, ALWAYS", items: [
        "train/loss and eval/loss per step",
        "learning rate (verify your schedule is real)",
        "grad_norm — spikes precede divergence",
        "GPU memory allocated and reserved",
        "tokens/sec — your throughput baseline",
        "The full config as a run artifact",
        "Git SHA of the code that ran",
        "Data version tag",
      ]},
      { title: "PHASE-SPECIFIC, EASY TO FORGET", items: [
        "SFT: mean completion length",
        "DPO: implicit reward margin, chosen/rejected logps",
        "DPO: output length before and after (verbosity)",
        "GRPO: mean reward, reward std within group",
        "GRPO: KL from the reference model",
        "GRPO: a sample of raw rollouts as a text table",
        "All: held-out pass@1 at every checkpoint",
        "All: a general benchmark, to catch forgetting",
      ]}
    );
    T.banner(s, 4.7, "If a number is not logged, it did not happen. If a rollout is not sampled to the dashboard, you will never read it.", C.moss);
    T.fieldNote(s, 0.55, 5.55, 12.2, 1.4,
      "Logging raw rollouts as a W&B table felt like overkill until GRPO. That table is where I found every single reward hack — " +
      "not in the loss curve, not in the reward curve, but in twenty lines of generated text that I only saw because I had " +
      "made them easy to look at.");
    T.num(s);
  }

  /* ---- Disk strategy ---- */
  {
    const s = T.slide("Setup", "Disk strategy across three volumes",
      "Mac 3TB · Asus 512GB root + 1TB /data. Sounds like plenty. It is not, once checkpoints accumulate.");
    T.table(s, 1.62,
      ["What", "Rough size", "Where", "Policy"],
      [
        ["HF model cache", "150–400 GB", "Mac 3TB · Asus /data/hf", "Set HF_HOME day one. NEVER let it sit on the 512GB root."],
        ["The Stack v2 subset", "50–200 GB", "Mac, data/raw/", "Download a language subset, not the whole thing"],
        ["Instruction datasets", "5–20 GB", "Mac, data/raw/", "Small. Keep all versions."],
        ["data/interim + processed", "20–80 GB", "Mac (authoritative)", "Every version kept. This is your provenance chain."],
        ["Training shards synced to Asus", "1–10 GB per run", "Asus /data/datasets", "Copy only what a run needs. The Mac stays the source of truth."],
        ["Generated rollouts", "10–100 GB", "Mac", "Grows fast during RFT and GRPO. Compress old ones."],
        ["LoRA adapters", "20–200 MB each", "Both, synced back to Mac", "Keep everything — they are tiny"],
        ["Merged full models", "1–15 GB each", "Mac", "Do NOT keep. Regenerate from adapter + base."],
        ["Eval outputs / logs", "1–10 GB", "Mac", "Keep. This is your results record."],
      ],
      [3.2, 1.9, 3.0, 4.1], { size: 10.5, rowH: 0.355 });
    T.grid(s, 5.28, [
      ["The 512GB rule", "The Asus root SSD holds the OS and conda envs — nothing else. Every large path points at /data.", C.moss],
      ["The rule", "Anything regenerable in under an hour gets deleted. Anything that took a day to produce gets kept forever.", C.moss],
      ["The trap", "Merged models. Large, and a pure function of adapter + base. Never store them.", C.rust],
    ], { cols: 3, h: 1.15 });
    T.num(s);
  }
};
