/* PART IV — THE SANDBOX  (Phase 3) */

module.exports = function (pres, T) {
  const { C, HEAD, BODY, MONO } = T;

  T.num(T.divider("SANDBOX", "Phase 3", "Building the Executor",
    "Three to five days. This is the trust boundary of the entire project, and the\nsame component becomes your reward function in Phase 9. Build it once, properly."));

  /* ---- Threat model ---- */
  {
    const s = T.slide("Sandbox", "The threat model — what you are actually defending against");
    s.addText(
      "You are about to run millions of lines of code written by a model that is being actively optimized to make your " +
      "tests pass. It is not malicious. It is worse than malicious: it is a search process with an objective, and your " +
      "sandbox is part of the search space.",
      { x: 0.55, y: 1.4, w: 12.2, h: 0.8, fontFace: BODY, fontSize: 13.5, color: C.ink, margin: 0, valign: "top" }
    );
    T.grid(s, 2.3, [
      ["Accidental damage", "A generated rm -rf, an infinite loop, a fork bomb, a 40GB allocation. No intent, full impact.", C.amber],
      ["Resource exhaustion", "The most common real failure. One bad sample hangs a training run for hours with no error.", C.amber],
      ["Test-file access", "The model reads the test file and returns expected values. Passes every test. Learns nothing.", C.rust],
      ["Network egress", "pip install during evaluation, or a solution that fetches the answer from an API.", C.rust],
      ["Filesystem escape", "Writing outside the temp dir. Corrupts your dataset, or worse, your source tree.", C.rust],
      ["Sandbox escape proper", "Rare on a laptop, catastrophic in production. Assume your Level-1 sandbox is not escape-proof.", C.rust],
    ], { cols: 3, h: 1.6 });
    T.banner(s, 5.55, "Design assumption: every generated program is trying to make tests pass by any means available to it.", C.rust);
    T.fieldNote(s, 0.55, 6.35, 12.2, 0.85,
      "This is not paranoia. In Phase 9 I watched a model discover that opening the test file was easier than solving the problem.");
    T.num(s);
  }

  /* ---- Escalation ladder ---- */
  {
    const s = T.slide("Sandbox", "The escalation ladder");
    T.steps(s, 1.4, [
      ["Level 0 — exec() in-process", "Never. A generated sys.exit() kills your training run; a memory bomb takes the whole process down. Listed only so you recognize it as wrong."],
      ["Level 1 — subprocess + resource.setrlimit", "Separate process, hard limits on CPU time, address space, file size, and process count. Fast (~10ms overhead). This is where you start and where most of your experiments will run."],
      ["Level 2 — Docker container per execution", "Real isolation of filesystem and network. ~50–100ms on Linux (host kernel), 1–3s on macOS (VM). Use for large batches and anything unattended."],
      ["Level 3 — gVisor / nsjail / Firecracker", "Kernel-level isolation. Correct answer for production, overkill for a learning project on your own laptop."],
      ["Level 4 — hosted (E2B, Modal)", "Someone else's problem, billed per second. Genuinely worth it when you are generating hundreds of thousands of samples and do not want to babysit."],
    ], { h: 1.0, bottom: 6.3 });
    T.banner(s, 6.45, "Start at Level 1. Move to Level 2 before the first unattended overnight generation run.", C.moss);
    T.num(s);
  }

  /* ---- Level 1 code ---- */
  {
    const s = T.slide("Sandbox", "Level 1, annotated — and the bug almost everyone ships");
    T.codeBlock(s, 0.55, 1.4, 7.3, 4.9, [
      "import os, resource, subprocess, signal, tempfile",
      "",
      "def _limits(mem_mb=512, cpu_s=10, nproc=64):",
      "    def apply():",
      { t: "        os.setsid()          # NEW PROCESS GROUP  <-- critical", c: C.moss, b: true },
      "        resource.setrlimit(resource.RLIMIT_AS,",
      "            (mem_mb << 20, mem_mb << 20))     # address space",
      "        resource.setrlimit(resource.RLIMIT_CPU,",
      "            (cpu_s, cpu_s))                   # CPU seconds",
      "        resource.setrlimit(resource.RLIMIT_NPROC,",
      "            (nproc, nproc))                   # anti fork-bomb",
      "        resource.setrlimit(resource.RLIMIT_FSIZE,",
      "            (16 << 20, 16 << 20))             # max file write",
      "    return apply",
      "",
      "def run(code, tests, wall_s=15):",
      "    with tempfile.TemporaryDirectory() as d:",
      "        ...  # write solution.py + test file into d",
      "        p = subprocess.Popen(",
      "            ['python', 'test_solution.py'],",
      "            cwd=d, preexec_fn=_limits(),",
      "            stdout=subprocess.PIPE, stderr=subprocess.PIPE,",
      { t: "            env={'PATH': '/usr/bin'},   # scrubbed env", c: C.moss },
      "        )",
      "        try:",
      "            out, err = p.communicate(timeout=wall_s)",
      "        except subprocess.TimeoutExpired:",
      { t: "            os.killpg(p.pid, signal.SIGKILL)  # KILL THE GROUP", c: C.amber, b: true },
      "            return Result(status='timeout')",
    ], "executor.py — the core");

    T.grid(s, 1.4, [
      ["The bug everyone ships", "subprocess timeout kills the child, NOT its grandchildren. A solution that spawns a subprocess leaves an orphan running forever. os.setsid() + os.killpg() is the fix.", C.rust],
      ["Scrub the environment", "Pass an explicit minimal env. Inherited env vars leak API keys, HF tokens, and paths into generated code.", C.rust],
      ["Two different timeouts", "RLIMIT_CPU catches busy loops. Wall-clock catches sleeps and blocking I/O. You need both — neither alone is sufficient.", C.amber],
      ["RLIMIT_AS is not perfect", "It limits virtual address space, which some allocators over-reserve. Tune it, and use cgroups if you need precision.", C.ink],
      ["preexec_fn is not thread-safe", "Fine for a process pool, dangerous with threads. Use multiprocessing, not threading, for parallel execution.", C.amber],
    ], { cols: 1, x: 8.05, w: 4.7, h: 0.95, gapY: 0.1 });
    T.num(s);
  }

  /* ---- Timeouts ---- */
  {
    const s = T.slide("Sandbox", "Timeouts — the single most important setting");
    T.compare(s, 1.4, 2.6,
      { title: "CPU TIME (RLIMIT_CPU)", items: [
        "Counts actual CPU seconds burned",
        "Catches: while True, runaway recursion, O(2^n) brute force",
        "Does NOT catch: time.sleep(), blocked network read, deadlock",
        "Delivered as SIGXCPU — the process may catch and ignore it",
        "Set to roughly 5-10x your slowest legitimate solution",
      ]},
      { title: "WALL CLOCK (communicate timeout)", items: [
        "Counts real elapsed time",
        "Catches: sleeps, blocking I/O, deadlocks, anything hung",
        "Enforced by YOUR process, so it cannot be ignored",
        "Must be followed by killpg, or orphans survive it",
        "Set slightly above CPU limit so CPU fires first when relevant",
      ]}
    );
    T.accentRows(s, 4.25, [
      ["Too tight", "wall_s = 2", "Legitimate slow solutions get marked as failures. Your training data now teaches that correct code is wrong.", C.rust],
      ["Too loose", "wall_s = 300", "One pathological sample stalls a batch for five minutes. Across 50k generations, that is days.", C.rust],
      ["Right", "wall_s = 10-15", "Measure your dataset's honest solutions first. Set the limit from the p99, not from a guess.", C.moss],
    ], { h: 0.66, labelW: 2.0 });
    T.fieldNote(s, 0.55, 6.3, 12.2, 0.9,
      "My first sandbox had no timeout at all. A generated while True: sat there eating a core while I made coffee and " +
      "wondered why step 40 was slow. Ninety minutes, one missing keyword argument.");
    T.num(s);
  }

  /* ---- Isolation: fs + network ---- */
  {
    const s = T.slide("Sandbox", "Filesystem and network isolation");
    T.accentRows(s, 1.4, [
      ["Fresh temp dir per run", "tempfile.TemporaryDirectory()", "New directory every execution, deleted after. cwd is set to it. No state survives between runs — this also prevents cross-contamination between samples.", C.moss],
      ["Never place the test file where it can be read", "separate dir, or inline", "If solution.py and test_solution.py sit in the same directory, open('test_solution.py') is trivially available. Put tests outside cwd, or inject them via stdin.", C.rust],
      ["Scrub the environment", "env={'PATH': '/usr/bin'}", "Inherited env is an information leak: HF_TOKEN, WANDB_API_KEY, AWS creds. Pass an explicit allowlist.", C.rust],
      ["Kill network at Level 1 (best effort)", "unset proxies, block DNS", "Level 1 cannot truly block sockets. You can remove proxy vars and rely on RLIMIT, but real network isolation needs Level 2.", C.amber],
      ["Kill network at Level 2 (real)", "docker run --network none", "Actual isolation. This is the main reason to move to Docker for unattended runs.", C.moss],
      ["Cap file writes", "RLIMIT_FSIZE", "Stops a solution filling your 3TB disk with a log file. Cheap insurance.", C.moss],
    ], { h: 0.82, labelW: 3.4, bottom: 6.38 });
    T.banner(s, 6.5, "Level 1 protects you from accidents. Only Level 2+ protects you from a model that is actively searching.", C.amber);
    T.num(s);
  }

  /* ---- Docker level 2 ---- */
  {
    const s = T.slide("Sandbox", "Level 2 — Docker, and where it is cheap",
      "Same command on both machines, ~30x different cost. That asymmetry decides where batch work runs.");
    T.codeBlock(s, 0.55, 1.62, 7.0, 2.75, [
      "docker run --rm \\",
      { t: "  --network none \\           # real network isolation", c: C.moss },
      { t: "  --memory 512m \\            # enforced by cgroups", c: C.moss },
      { t: "  --cpus 1.0 \\               # hard CPU cap", c: C.moss },
      { t: "  --pids-limit 64 \\          # anti fork-bomb", c: C.moss },
      "  --read-only \\",
      "  --tmpfs /work:rw,size=64m \\",
      "  --user 65534:65534 \\           # nobody",
      "  -v $PWD/run:/work/run:ro \\",
      { t: "  python:3.11-slim \\        # build ONCE, reuse", c: C.amber },
      "  timeout 15 python /work/run/test_solution.py",
    ], "PER-EXECUTION CONTAINER · IDENTICAL ON BOTH MACHINES");
    T.grid(s, 1.62, [
      ["cgroups beat rlimits", "--memory is enforced by the kernel cgroup — stricter than RLIMIT_AS.", C.moss],
      ["On the Asus this is nearly free", "Containers run on the host kernel: ~50ms. A reasonable default here, not a last resort.", C.moss],
      ["On the Mac it costs 1–3s", "Docker Desktop runs a Linux VM — roughly 30x the overhead. Batch, or stay on Level 1.", C.amber],
    ], { cols: 1, x: 7.75, w: 5.0, h: 0.85, gapY: 0.09 });
    T.accentRows(s, 4.55, [
      ["Level 1, Mac", "iterating", "Interactive development, small eval runs, anything you are watching. Speed over isolation.", C.moss],
      ["Level 2, Asus", "unattended + bulk", "Overnight generation, rejection sampling, GRPO reward execution. 8 cores and cheap containers make this the batch machine.", C.amber],
    ], { h: 0.62, labelW: 2.2, bottom: 5.9 });
    T.fieldNote(s, 0.55, 5.98, 12.2, 1.05,
      "The same docker run is a rounding error on the Asus and a real tax on the Mac — so unattended execution lives on the Asus, " +
      "which already runs GRPO. On either machine, build the image once and reuse it; pulling per execution destroys throughput.");
    T.num(s);
  }

  /* ---- Result schema ---- */
  {
    const s = T.slide("Sandbox", "The result schema — design this carefully, you will use it everywhere");
    T.codeBlock(s, 0.55, 1.4, 6.6, 4.0, [
      "@dataclass",
      "class ExecResult:",
      { t: "    status: str        # pass|fail|timeout|error|crash", c: C.moss },
      "    passed: int        # tests that passed",
      "    total: int         # tests attempted",
      { t: "    fraction: float    # passed/total -> DENSE REWARD", c: C.moss, b: true },
      "    stdout: str",
      "    stderr: str",
      { t: "    traceback: str     # <-- Phase 10 depends on this", c: C.amber, b: true },
      "    exit_code: int",
      "    wall_ms: int",
      "    cpu_ms: int",
      { t: "    flags: list[str]   # 'read_test_file','net_attempt'", c: C.rust },
      "",
      "    @property",
      "    def ok(self) -> bool:",
      "        return self.status == 'pass'",
    ], "ExecResult");

    T.grid(s, 1.4, [
      ["fraction, not just a boolean", "In Phase 9, binary pass/fail is a sparse reward and training barely moves. passed/total gives the model a gradient to climb. Capture it now.", C.moss],
      ["traceback is not optional", "Phase 10 (self-repair) is built entirely from tracebacks. If you discard them now, you rebuild and re-run everything later.", C.amber],
      ["flags catch cheating", "Add a flag whenever the solution touched something suspicious. This becomes your reward-hacking detector in Phase 9.", C.rust],
      ["Distinguish error from fail", "A syntax error and a wrong answer are different signals and deserve different rewards. Collapsing them loses information.", C.ink],
      ["Timings help you tune", "wall_ms and cpu_ms tell you whether your timeout is well calibrated. Log the distribution.", C.ink],
    ], { cols: 1, x: 7.35, w: 5.4, h: 0.92, gapY: 0.1 });
    T.num(s);
  }

  /* ---- Throughput ---- */
  {
    const s = T.slide("Sandbox", "Throughput — you will run millions of executions",
      "Single-threaded wall-clock. Divide by your worker count — see the note below.");
    T.table(s, 1.62,
      ["Phase", "Executions", "L1 subprocess\n~50ms", "L2 Docker, Asus\n~100ms (host kernel)", "L2 Docker, Mac\n~1.5s (VM)"],
      [
        ["Phase 4 — baseline eval", "~5,000", "4 minutes", "8 minutes", "2 hours"],
        ["Phase 6 — SFT eval loop", "~50,000", "42 minutes", "1.4 hours", "21 hours"],
        ["Phase 7 — rejection sampling", "~500,000", "7 hours", "14 hours", "8+ days"],
        ["Phase 9 — GRPO training", "~2,000,000", "28 hours", "56 hours", "impractical"],
      ],
      [3.1, 1.7, 2.2, 2.9, 2.3], { size: 10.5, rowH: 0.44 });
    T.banner(s, 3.9, "Level 2 on Linux costs ~2x Level 1, not 30x as on the Mac — which is what moves all bulk execution to the Asus.", C.moss);
    T.grid(s, 4.55, [
      ["Parallelize with processes", "Pool sized to physical cores — 8 on the Asus, cutting every number above by ~8x. preexec_fn is not thread-safe, so threads are out.", C.moss],
      ["Cache by content hash", "Identical generated solutions are common, especially at low temperature. Hash the code and skip re-execution.", C.moss],
      ["Fail fast on syntax", "ast.parse() before spawning a process. Rejects a meaningful fraction at ~0.1ms instead of 50ms.", C.moss],
      ["Batch the container", "At Level 2, run many solutions in ONE container rather than one each. Matters far more on the Mac.", C.amber],
      ["Warm the interpreter", "Process startup dominates at 50ms. A persistent worker pool with fork-per-task amortizes it.", C.ink],
      ["Measure before optimizing", "Log wall_ms distribution. Your bottleneck may be the model generating, not the sandbox executing.", C.ink],
    ], { cols: 3, h: 1.12 });
    T.num(s);
  }

  /* ---- Adversarial suite ---- */
  {
    const s = T.slide("Sandbox", "The adversarial suite — test your sandbox before you trust it",
      "Write these as real pytest cases. Re-run them every time the executor changes.");
    T.table(s, 1.68,
      ["Attack", "Payload", "Expected result"],
      [
        ["Infinite loop", "while True: pass", "status='timeout', killed within wall_s"],
        ["Sleep past the limit", "import time; time.sleep(999)", "status='timeout' (CPU limit alone would MISS this)"],
        ["Fork bomb", "while True: os.fork()", "Contained by RLIMIT_NPROC / --pids-limit"],
        ["Memory bomb", "x = [0] * 10**10", "MemoryError inside sandbox, host unaffected"],
        ["Orphan subprocess", "subprocess.Popen(['sleep','999'])", "Killed by killpg — this is the one that usually fails"],
        ["Clean exit", "import sys; sys.exit(0)", "NOT counted as pass — must check test output, not exit code"],
        ["Swallow everything", "try: main() except: pass", "Tests must still report failure"],
        ["Read the test file", "open('test_solution.py').read()", "FileNotFoundError, or flagged"],
        ["Network egress", "urllib.request.urlopen('http://...')", "Blocked (L2) or flagged (L1)"],
        ["Filesystem escape", "open('../../secrets','w')", "PermissionError or contained in tmpfs"],
        ["Disk fill", "open('f','w').write('x'*10**10)", "Capped by RLIMIT_FSIZE"],
        ["Env leak", "os.environ.get('HF_TOKEN')", "Returns None — env was scrubbed"],
      ],
      [2.6, 4.6, 5.0], { size: 10.5, rowH: 0.335 });
    T.fieldNote(s, 0.55, 5.9, 12.2, 1.05,
      "The orphan-subprocess test is the one that fails on almost every hand-rolled sandbox, including my first three. " +
      "subprocess.run(timeout=) kills the child and cheerfully leaves its children running. Write this test.");
    T.num(s);
  }

  /* ---- Sandbox traps ---- */
  {
    T.num(T.ptn("Sandbox", "Sandbox — path and traps",
      [
        "Start at Level 1, move to Level 2 before the first unattended run",
        "Two timeouts: CPU-time and wall-clock. Always both",
        "os.setsid() + os.killpg() — kill the process group, not the process",
        "Scrub the environment to an explicit allowlist",
        "Return fraction-of-tests-passed, not a boolean",
        "Capture the traceback — Phase 10 is built from it",
        "Write the adversarial suite and re-run it on every change",
      ],
      [
        "No timeout: the classic. Hangs runs silently for hours",
        "Only CPU timeout: sleeps and blocking I/O sail straight through",
        "Killing the process but not the group: orphans accumulate all night",
        "Test file readable from cwd: the model will find it in Phase 9",
        "Inheriting env: leaks your HF and W&B tokens into generated code",
        "Trusting exit code 0 as success: sys.exit(0) defeats it",
        "Boolean-only results: you cannot build a dense reward later",
      ],
      "This phase feels like a detour from machine learning. It is not — it is the reward function. " +
      "Every hour spent here is repaid in Phase 9, where a weak sandbox does not merely fail, it silently teaches your " +
      "model to cheat and reports rising numbers while doing it.",
      { noteH: 1.35, size: 11.8 }));
  }
};
