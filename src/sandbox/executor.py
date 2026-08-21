"""Level 1 sandbox — subprocess + resource.setrlimit.

The trust boundary of the whole project. In the GRPO phase this exact code becomes the
reward function, so every weakness here turns into a thing the policy is optimised to find.

Level 1 protects you from accidents. Only Level 2 (Docker, --network none) protects you
from a model that is actively searching. Residual Level 1 gaps are marked RESIDUAL below.

Design rules, from the field guide:
  * Two timeouts, always both. RLIMIT_CPU catches busy loops; wall-clock catches sleeps
    and blocking I/O. Neither alone is sufficient.
  * os.setsid() + os.killpg() — kill the process *group*. subprocess timeout kills the
    child and cheerfully leaves its grandchildren running.
  * Scrub the environment to an explicit allowlist. Inherited env leaks HF_TOKEN.
  * Tests never live in cwd. The model will open them.
  * Return fraction-of-tests-passed, not a boolean. Binary reward is sparse and GRPO
    barely moves on it.
  * Capture the traceback. The self-repair phase is built entirely from it.
  * Never trust exit code 0. sys.exit(0) defeats it.
"""

from __future__ import annotations

import ast
import json
import os
import resource
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field, asdict

_RUNNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_runner.py")

# Wall clock must sit above the CPU limit so that RLIMIT_CPU fires first when the
# program is genuinely burning CPU -- that path gives us a diagnosable signal instead
# of an opaque "timeout".
DEFAULT_CPU_S = 10
DEFAULT_WALL_S = 15
DEFAULT_MEM_MB = 512
DEFAULT_FSIZE_MB = 16

# RLIMIT_NPROC is per-UID and, on Linux, counts THREADS -- not processes, and not just
# this process group. Measured on this box: 175 processes but 2069 threads, because the
# desktop session and the IDE each hold hundreds. So the field guide's example value of
# 64 makes *every* fork fail instantly with BlockingIOError. That is the worst possible
# outcome, because it looks like containment: the fork-bomb test goes green while really
# nothing could ever have spawned, and legitimate subprocess use is broken too.
#
# Size the cap as "current thread usage + headroom" so the ceiling is real but only a
# bomb can reach it.
#
# RESIDUAL: because the limit is per-UID it is coupled to whatever else you happen to be
# running. A bomb also eats into the desktop's own budget while it climbs. The clean fix
# is Level 2's `--pids-limit`, which is per-container. Use Level 2 for unattended runs.
NPROC_HEADROOM = 512
_nproc_default: int | None = None


@dataclass
class ExecResult:
    """The result schema. Everything downstream reads this, so it is deliberately wide."""

    status: str  # pass | fail | timeout | error | crash
    passed: int = 0
    total: int = 0
    fraction: float = 0.0  # passed/total -> DENSE REWARD
    stdout: str = ""
    stderr: str = ""
    traceback: str = ""  # the self-repair phase depends on this
    exit_code: int | None = None
    wall_ms: int = 0
    cpu_ms: int = 0
    flags: list[str] = field(default_factory=list)  # 'read_test_file', 'net_attempt', ...

    @property
    def ok(self) -> bool:
        return self.status == "pass"

    def to_dict(self) -> dict:
        return asdict(self)


def current_user_threads() -> int:
    """Threads owned by this UID -- the unit RLIMIT_NPROC actually counts."""
    uid = os.getuid()
    total = 0
    try:
        for pid in os.listdir("/proc"):
            if not pid.isdigit():
                continue
            try:
                if os.stat(f"/proc/{pid}").st_uid != uid:
                    continue
                with open(f"/proc/{pid}/status") as fh:
                    for line in fh:
                        if line.startswith("Threads:"):
                            total += int(line.split()[1])
                            break
            except (OSError, ValueError, IndexError):
                continue
    except OSError:
        return 4096
    return total or 4096


def default_nproc() -> int:
    """Cached, because run() is called millions of times and this walks /proc.

    Bulk callers on a busy desktop should pass `nproc` explicitly rather than rely on a
    value measured once at first use.
    """
    global _nproc_default
    if _nproc_default is None:
        _nproc_default = current_user_threads() + NPROC_HEADROOM
    return _nproc_default


def _limits(mem_mb: int, cpu_s: int, nproc: int, fsize_mb: int):
    """Return the preexec_fn applied between fork and exec.

    preexec_fn is NOT thread-safe -- parallelise with multiprocessing, never threads.
    """

    def apply() -> None:
        os.setsid()  # NEW SESSION + PROCESS GROUP  <-- critical for killpg

        # Address space. Note RLIMIT_AS caps *virtual* address space and some
        # allocators over-reserve, so this is a blunt instrument; cgroups (Level 2)
        # are stricter. It is still what turns a 40 GB allocation into a MemoryError.
        try:
            resource.setrlimit(resource.RLIMIT_AS, (mem_mb << 20, mem_mb << 20))
        except (ValueError, OSError):
            # macOS/Darwin does not support RLIMIT_AS -- it raises "current limit
            # exceeds maximum limit" and every run() fails in preexec_fn. RLIMIT_DATA
            # is the nearest equivalent there. On Linux this branch never fires.
            # NOTE: RLIMIT_DATA does NOT actually cap allocation on Darwin, so memory
            # containment is Linux-only. Run untrusted bulk execution on the TUF.
            try:
                resource.setrlimit(resource.RLIMIT_DATA, (mem_mb << 20, mem_mb << 20))
            except (ValueError, OSError):
                pass

        # CPU seconds. Soft limit raises SIGXCPU, which the program is allowed to
        # catch and ignore; the higher hard limit guarantees a following SIGKILL.
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_s, cpu_s + 2))

        # Anti fork-bomb.
        resource.setrlimit(resource.RLIMIT_NPROC, (nproc, nproc))

        # Max bytes any single write may extend a file to. Stops a solution filling
        # the disk with a log file; exceeding it raises SIGXFSZ.
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize_mb << 20, fsize_mb << 20))

        # Core dumps from a killed memory bomb are pure noise on a 4 GB budget.
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

    return apply


def _scrubbed_env(workdir: str) -> dict[str, str]:
    """Explicit allowlist. Never pass os.environ through.

    An inherited environment is an information leak straight into generated code:
    HF_TOKEN, WANDB_API_KEY, AWS creds. It is also how proxy variables let a
    "network isolated" Level 1 sandbox reach the internet anyway.
    """
    return {
        "PATH": "/usr/bin:/bin",
        "HOME": workdir,
        "TMPDIR": workdir,
        "LC_ALL": "C.UTF-8",
        "LANG": "C.UTF-8",
        "PYTHONHASHSEED": "0",
        "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONIOENCODING": "utf-8",
        # Deliberately absent: HF_*, WANDB_*, *_PROXY, PYTHONPATH, SSH_AUTH_SOCK.
    }


def run(
    code: str,
    tests: str | list[str],
    *,
    wall_s: int = DEFAULT_WALL_S,
    cpu_s: int = DEFAULT_CPU_S,
    mem_mb: int = DEFAULT_MEM_MB,
    fsize_mb: int = DEFAULT_FSIZE_MB,
    nproc: int | None = None,
    python: str | None = None,
) -> ExecResult:
    """Execute `code` against `tests` under Level 1 isolation.

    `tests` is a list of independent source snippets, each counted separately so the
    result carries passed/total -- the dense reward. A bare string is treated as one
    test. Each snippet is exec'd with the solution module's namespace in scope, so it
    can call the solution's functions directly.
    """
    if isinstance(tests, str):
        tests = [tests]
    total = len(tests)
    python = python or sys.executable
    if nproc is None:
        nproc = default_nproc()

    # Fail fast on syntax: ~0.1 ms of ast.parse rejects a meaningful fraction of
    # generations instead of paying ~50 ms to spawn a process that cannot run.
    try:
        ast.parse(code)
    except SyntaxError as exc:
        return ExecResult(
            status="error",
            total=total,
            traceback=f"SyntaxError: {exc.msg} (line {exc.lineno})",
            flags=["syntax_error"],
        )

    # work/ and ctl/ are separate top-level temp dirs with independent random names.
    # If they were siblings, '../ctl/tests.json' would be a one-line read from the
    # solution. The runner additionally unlinks the test payload before importing the
    # solution, so by the time untrusted code executes there is nothing left on disk.
    workdir = tempfile.mkdtemp(prefix="ultron-work-")
    ctldir = tempfile.mkdtemp(prefix="ultron-ctl-")
    proc: subprocess.Popen | None = None
    try:
        with open(os.path.join(workdir, "solution.py"), "w") as fh:
            fh.write(code)

        payload = os.path.join(ctldir, "payload.json")
        report = os.path.join(ctldir, "report.json")
        with open(payload, "w") as fh:
            json.dump({"tests": tests, "report": report, "workdir": workdir}, fh)

        started = time.monotonic()
        proc = subprocess.Popen(
            [python, "-I", "-B", _RUNNER, payload],
            cwd=workdir,
            preexec_fn=_limits(mem_mb, cpu_s, nproc, fsize_mb),
            env=_scrubbed_env(workdir),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            errors="replace",
        )

        timed_out = False
        try:
            out, err = proc.communicate(timeout=wall_s)
        except subprocess.TimeoutExpired:
            timed_out = True
            _kill_group(proc)
            out, err, abandoned = _drain(proc)

        wall_ms = int((time.monotonic() - started) * 1000)

        if timed_out:
            return ExecResult(
                status="timeout",
                total=total,
                stdout=_clip(out),
                stderr=_clip(err),
                traceback=f"Wall-clock timeout after {wall_s}s"
                + (" (output abandoned: a process outlived the group kill)"
                   if abandoned else ""),
                exit_code=proc.returncode,
                wall_ms=wall_ms,
                flags=["group_escape"] if abandoned else [],
            )

        # Never trust the exit code. sys.exit(0) inside the solution produces a clean
        # 0 while nothing was verified, so scoring reads only the runner's report --
        # which is written to a path the solution was never shown.
        return _read_report(report, total, out, err, proc.returncode, wall_ms)
    finally:
        # Belt and braces: if we left by any path other than a clean communicate()
        # -- an exception in our own code included -- the group must still die, or we
        # leak the orphans this whole module exists to prevent.
        if proc is not None and proc.poll() is None:
            _kill_group(proc)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        shutil.rmtree(workdir, ignore_errors=True)
        shutil.rmtree(ctldir, ignore_errors=True)


def _kill_group(proc: subprocess.Popen) -> None:
    """SIGKILL the whole process group.

    This is the bug almost every hand-rolled sandbox ships. subprocess's own timeout
    kills the direct child only; anything it spawned survives as an orphan and they
    accumulate all night. os.setsid() in preexec_fn is what makes the group killable.
    """
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            proc.kill()
        except ProcessLookupError:
            pass


def _drain(proc: subprocess.Popen, grace: float = 2.0) -> tuple[str, str, bool]:
    """Collect whatever output survives the kill, without ever blocking forever.

    A plain communicate() here is a deadlock waiting to happen. Our pipes were
    inherited by every descendant, so any process that outlives the group kill still
    holds their write end open and EOF never arrives -- the harness hangs on a random
    step with no error, which is the single most expensive failure mode in the trap
    index. A solution can arrange this deliberately: call os.setsid() in a child and it
    leaves the process group that killpg targets.

    Verified by negative control: with the group kill replaced by a plain proc.kill(),
    an unbounded communicate() here hangs indefinitely.

    Returns (stdout, stderr, abandoned).
    """
    try:
        out, err = proc.communicate(timeout=grace)
        return out or "", err or "", False
    except subprocess.TimeoutExpired:
        # Something escaped. Drop the pipes rather than wait on a writer that will
        # never close, and flag it -- at Level 1 this is detectable, not preventable.
        for stream in (proc.stdout, proc.stderr):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        return "", "", True


def _clip(text: str | None, limit: int = 8000) -> str:
    if not text:
        return ""
    if len(text) <= limit:
        return text
    return text[:limit] + f"\n... [clipped {len(text) - limit} chars]"


def _read_report(
    report: str, total: int, out: str, err: str, rc: int | None, wall_ms: int
) -> ExecResult:
    try:
        with open(report) as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        # No structured report: the process died hard before it could write one --
        # SIGKILL from RLIMIT_CPU, SIGXFSZ from RLIMIT_FSIZE, an OOM at import, or a
        # crash in the interpreter itself. Distinct from 'error', which means the
        # runner survived and told us the solution blew up.
        return ExecResult(
            status="crash",
            total=total,
            stdout=_clip(out),
            stderr=_clip(err),
            traceback=_crash_reason(rc, err),
            exit_code=rc,
            wall_ms=wall_ms,
        )

    passed = int(data.get("passed", 0))
    reported_total = int(data.get("total", total)) or total
    flags = list(data.get("flags", []))
    import_error = data.get("import_error") or ""

    if import_error:
        status = "error"
    elif passed == reported_total and reported_total > 0:
        status = "pass"
    else:
        status = "fail"

    return ExecResult(
        status=status,
        passed=passed,
        total=reported_total,
        fraction=passed / reported_total if reported_total else 0.0,
        stdout=_clip(out),
        stderr=_clip(err),
        traceback=_clip(import_error or "\n".join(data.get("tracebacks", [])), 4000),
        exit_code=rc,
        wall_ms=wall_ms,
        cpu_ms=int(data.get("cpu_ms", 0)),
        flags=flags,
    )


def _crash_reason(rc: int | None, err: str) -> str:
    if rc is not None and rc < 0:
        sig = -rc
        name = signal.Signals(sig).name if sig in {s.value for s in signal.Signals} else str(sig)
        hint = {
            "SIGKILL": "hard RLIMIT_CPU limit, or the OOM killer",
            "SIGXCPU": "RLIMIT_CPU soft limit",
            "SIGXFSZ": "RLIMIT_FSIZE exceeded",
            "SIGSEGV": "segfault",
        }.get(name, "")
        return f"Killed by {name}" + (f" ({hint})" if hint else "")
    tail = (err or "").strip().splitlines()
    return tail[-1] if tail else f"No report written; exit code {rc}"
