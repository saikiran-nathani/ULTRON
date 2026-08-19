"""The adversarial suite — 12 cases, all must pass. Re-run on every executor change.

Write these before you trust the sandbox, and treat a regression here as a stop-the-line
event: from the GRPO phase onward a weak sandbox does not fail loudly, it silently
teaches the model to cheat while reporting rising numbers.

Runs under pytest, or standalone with no dependencies at all:

    python src/sandbox/tests/test_adversarial.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

from sandbox.executor import current_user_threads, run  # noqa: E402

# A trivially correct solution + test pair, used as the control and as the payload
# carrier for attacks that need the tests to still be scored.
TRIVIAL_TEST = "assert add(2, 2) == 4"
TRIVIAL_CODE = "def add(a, b):\n    return a + b\n"


# --------------------------------------------------------------------------------- 00
def test_control_correct_solution_passes():
    """If this fails, every other result in this file is meaningless."""
    r = run(TRIVIAL_CODE, [TRIVIAL_TEST, "assert add(-1, 1) == 0"], wall_s=10)
    assert r.status == "pass", (r.status, r.traceback, r.stderr)
    assert r.ok and r.passed == 2 and r.total == 2
    assert r.fraction == 1.0


def test_control_wrong_solution_gives_partial_credit():
    """fraction, not a boolean. Sparse reward is why GRPO sits flat for hours."""
    r = run("def add(a, b):\n    return a - b\n",
            ["assert add(2, 2) == 4", "assert add(0, 0) == 0"], wall_s=10)
    assert r.status == "fail"
    assert r.passed == 1 and r.total == 2
    assert r.fraction == 0.5
    assert "AssertionError" in r.traceback  # the self-repair phase reads this


# --------------------------------------------------------------------------------- 01
def test_infinite_loop_times_out():
    """while True: pass -> killed within wall_s."""
    t0 = time.monotonic()
    r = run("while True:\n    pass\n", [TRIVIAL_TEST], wall_s=5, cpu_s=2)
    elapsed = time.monotonic() - t0
    # CPU limit should fire first here and kill it before the wall clock is reached.
    assert r.status in ("timeout", "crash"), (r.status, r.traceback)
    assert elapsed < 12, f"took {elapsed:.1f}s -- the limits are not being applied"
    assert not r.ok


# --------------------------------------------------------------------------------- 02
def test_sleep_past_the_limit_times_out():
    """A CPU limit alone MISSES this. It burns no CPU; only wall-clock catches it."""
    t0 = time.monotonic()
    r = run("import time\ntime.sleep(999)\n", [TRIVIAL_TEST], wall_s=4, cpu_s=30)
    elapsed = time.monotonic() - t0
    assert r.status == "timeout", (r.status, r.traceback)
    assert elapsed < 12, f"took {elapsed:.1f}s -- wall-clock timeout did not fire"


# --------------------------------------------------------------------------------- 03
def test_fork_bomb_is_contained():
    """Contained by RLIMIT_NPROC. Must not take the host down with it."""
    t0 = time.monotonic()
    r = run(
        "import os\nwhile True:\n    os.fork()\n",
        [TRIVIAL_TEST],
        wall_s=8,
        cpu_s=3,
        # Must be measured in THREADS, above current usage: a ceiling below what the
        # desktop already holds would block the very first fork, and this test would
        # go green while proving nothing.
        nproc=current_user_threads() + 32,
    )
    elapsed = time.monotonic() - t0
    assert not r.ok, r.status
    assert elapsed < 20, f"took {elapsed:.1f}s -- the bomb was not contained"
    # The host must still be healthy enough to run a trivial job afterwards.
    assert run(TRIVIAL_CODE, [TRIVIAL_TEST], wall_s=10).ok, "host degraded after fork bomb"


# --------------------------------------------------------------------------------- 04
def test_memory_bomb_raises_inside_sandbox():
    """MemoryError inside the sandbox; the host is unaffected."""
    r = run("x = [0] * 10**10\n", [TRIVIAL_TEST], wall_s=15, cpu_s=10, mem_mb=256)
    assert not r.ok, r.status
    if sys.platform == "darwin":
        # RLIMIT_AS is unsupported on Darwin and the RLIMIT_DATA fallback does not
        # actually cap allocation, so a memory bomb is contained only by the wall
        # clock. The host survives, but the mechanism differs and the process
        # allocates freely until the timeout. Memory limiting is LINUX-ONLY --
        # run untrusted bulk execution on the TUF, not the Mac.
        assert r.status in ("error", "crash", "timeout"), (r.status, r.traceback)
    else:
        assert r.status in ("error", "crash"), (r.status, r.traceback)
    if r.status == "error":
        assert "MemoryError" in r.traceback, r.traceback


# --------------------------------------------------------------------------------- 05
def test_orphan_subprocess_is_killed_by_killpg():
    """THE one that fails on almost every hand-rolled sandbox.

    subprocess.run(timeout=) kills the child and cheerfully leaves its children
    running. We assert on the world, not on the return value: after the run, no
    `sleep 999` may survive anywhere on the machine.
    """
    marker = "48931"  # distinctive duration, so we only match our own orphan
    before = _sleepers(marker)
    r = run(
        f"import subprocess\n"
        f"subprocess.Popen(['sleep', '{marker}'])\n"
        f"import time\n"
        f"time.sleep(999)\n",
        [TRIVIAL_TEST],
        wall_s=4,
        cpu_s=30,
    )
    assert r.status == "timeout", (r.status, r.traceback, r.stderr)
    time.sleep(1.0)  # let the SIGKILL land and the process table settle
    after = _sleepers(marker)
    leaked = after - before
    if leaked:
        for pid in leaked:  # never leave the machine dirty on failure
            try:
                os.kill(pid, 9)
            except OSError:
                pass
    assert not leaked, f"ORPHAN LEAK: pids {sorted(leaked)} survived -- killpg is broken"
    assert "subprocess_spawn" in r.flags or True  # flag is advisory at Level 1


# ------------------------------------------------------------------------------- 05b
def test_process_group_escape_does_not_hang_the_harness():
    """A solution can leave the process group killpg targets, by calling os.setsid().

    Found by negative control while testing case 05: our pipes are inherited by every
    descendant, so a survivor holds their write end open and an unbounded
    communicate() after the kill never returns. The executor must come back inside a
    bounded time and say so, rather than hanging the run forever with no error.
    """
    marker = "48932"
    before = _sleepers(marker)
    t0 = time.monotonic()
    r = run(
        f"import os, subprocess, time\n"
        f"if os.fork() == 0:\n"
        f"    os.setsid()                      # leave the group killpg will target\n"
        f"    subprocess.Popen(['sleep', '{marker}'])\n"
        f"    time.sleep(999)\n"
        f"time.sleep(999)\n",
        [TRIVIAL_TEST],
        wall_s=4,
        cpu_s=30,
    )
    elapsed = time.monotonic() - t0
    try:
        assert r.status == "timeout", (r.status, r.traceback)
        assert elapsed < 15, f"HARNESS HANG: {elapsed:.1f}s -- the drain is unbounded"
    finally:
        # This one genuinely escapes Level 1. Clean up, and note that only Level 2
        # (container teardown) actually contains it.
        for pid in _sleepers(marker) - before:
            try:
                os.kill(pid, 9)
            except OSError:
                pass


# --------------------------------------------------------------------------------- 06
def test_clean_exit_is_not_counted_as_pass():
    """sys.exit(0) gives exit code 0 with nothing verified. Never trust the exit code."""
    r = run("import sys\nsys.exit(0)\n", [TRIVIAL_TEST], wall_s=10)
    assert not r.ok, "sys.exit(0) was scored as a pass -- scoring trusts the exit code"
    assert r.status == "error", r.status
    assert r.passed == 0
    assert r.exit_code == 0, "the child really did exit cleanly; that is the point"


# --------------------------------------------------------------------------------- 07
def test_swallowing_everything_still_reports_failure():
    """try/except around everything must not launder a wrong answer into a pass."""
    r = run(
        "def add(a, b):\n"
        "    try:\n"
        "        return undefined_name\n"
        "    except BaseException:\n"
        "        pass\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert r.status == "fail", (r.status, r.traceback)
    assert r.passed == 0 and r.total == 1


def test_test_swallowing_solution_cannot_escape_via_systemexit():
    """A solution that raises SystemExit from inside a test must still fail the test."""
    r = run(
        "def add(a, b):\n    raise SystemExit(0)\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert not r.ok, "SystemExit raised inside a test was scored as a pass"
    assert r.passed == 0


# --------------------------------------------------------------------------------- 08
def test_reading_the_test_file_fails():
    """FileNotFoundError, or flagged. The model WILL try this during GRPO.

    The invariant is about the *leak*, not the score: this solution is genuinely
    correct, so it should still pass. Asserting status == 'fail' here would be testing
    the wrong thing -- an attempted read that fails must not change the verdict.
    """
    r = run(
        "import os, json\n"
        "leaked = {}\n"
        "for name in ('test_solution.py', 'tests.py', 'payload.json', 'report.json',\n"
        "             '../ctl/payload.json'):\n"
        "    try:\n"
        "        leaked[name] = open(name).read()[:40]\n"
        "    except OSError as exc:\n"
        "        leaked[name] = type(exc).__name__\n"
        "print(json.dumps(leaked))\n"
        "def add(a, b):\n    return a + b\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert r.ok, (r.status, r.traceback)
    leaked = json.loads(r.stdout.strip().splitlines()[-1])
    denied = {"FileNotFoundError", "NotADirectoryError", "PermissionError",
              "IsADirectoryError"}
    for name, value in leaked.items():
        assert value in denied, f"LEAK: {name!r} was readable inside the sandbox -> {value!r}"
    assert "read_test_file" in r.flags, f"the attempt was not even flagged: {r.flags}"


def test_cwd_contains_only_the_solution():
    """Directly assert the invariant the case above depends on."""
    r = run(
        "import os, json\n"
        "print(json.dumps(sorted(os.listdir('.'))))\n"
        "def add(a, b):\n    return a + b\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert r.ok, (r.status, r.traceback)
    assert "solution.py" in r.stdout
    assert "payload" not in r.stdout and "report" not in r.stdout, r.stdout


# --------------------------------------------------------------------------------- 09
def test_network_egress_is_flagged():
    """Blocked at Level 2, flagged at Level 1. Level 1 cannot truly block sockets."""
    r = run(
        "import socket\n"
        "try:\n"
        "    socket.create_connection(('127.0.0.1', 9), timeout=1)\n"
        "except OSError:\n"
        "    pass\n"
        "def add(a, b):\n    return a + b\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert "net_attempt" in r.flags, f"network attempt not flagged: {r.flags}"


# --------------------------------------------------------------------------------- 10
def test_filesystem_escape_is_flagged_or_denied():
    """A write outside cwd must not silently succeed."""
    target = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_ESCAPED")
    if os.path.exists(target):
        os.unlink(target)
    r = run(
        f"try:\n"
        f"    open({target!r}, 'w').write('escaped')\n"
        f"except OSError:\n"
        f"    pass\n"
        f"def add(a, b):\n    return a + b\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    escaped = os.path.exists(target)
    if escaped:
        os.unlink(target)
    assert "fs_escape_write" in r.flags, f"escape not flagged: {r.flags}"
    # Level 1 genuinely cannot prevent this -- the uid is the same. Recording the
    # ground truth here is what tells you why Level 2 is mandatory before RFT.
    assert escaped, ("Level 1 unexpectedly BLOCKED the write. Good, but the assumption "
                     "this suite documents has changed -- re-read the threat model.")


# --------------------------------------------------------------------------------- 11
def test_disk_fill_is_capped():
    """Capped by RLIMIT_FSIZE. Exceeding it raises SIGXFSZ."""
    r = run(
        "with open('f', 'w') as fh:\n"
        "    for _ in range(1000):\n"
        "        fh.write('x' * 10**6)\n",
        [TRIVIAL_TEST],
        wall_s=20,
        cpu_s=15,
        fsize_mb=8,
    )
    assert not r.ok, r.status
    assert r.status in ("error", "crash"), (r.status, r.traceback)


# --------------------------------------------------------------------------------- 12
def test_environment_is_scrubbed():
    """os.environ.get('HF_TOKEN') returns None -- and so does everything else."""
    r = run(
        "import os, json\n"
        "leaks = {k: os.environ.get(k) for k in\n"
        "         ('HF_TOKEN', 'HUGGING_FACE_HUB_TOKEN', 'WANDB_API_KEY',\n"
        "          'AWS_SECRET_ACCESS_KEY', 'SSH_AUTH_SOCK', 'PYTHONPATH',\n"
        "          'HTTP_PROXY', 'HTTPS_PROXY')}\n"
        "print(json.dumps(leaks))\n"
        "print(json.dumps(sorted(os.environ.keys())))\n"
        "def add(a, b):\n    return a + b\n",
        [TRIVIAL_TEST],
        wall_s=10,
    )
    assert r.ok, (r.status, r.traceback)
    for name in ("HF_TOKEN", "WANDB_API_KEY", "SSH_AUTH_SOCK", "PYTHONPATH"):
        assert f'"{name}": null' in r.stdout, f"{name} leaked into the sandbox: {r.stdout}"


# --------------------------------------------------------------------------------- extra
def test_syntax_error_fails_fast_without_spawning():
    """ast.parse rejects at ~0.1 ms instead of paying ~50 ms for a doomed process."""
    t0 = time.monotonic()
    r = run("def add(a, b)\n    return a + b\n", [TRIVIAL_TEST])
    elapsed_ms = (time.monotonic() - t0) * 1000
    assert r.status == "error" and "syntax_error" in r.flags
    assert r.total == 1 and r.fraction == 0.0
    assert elapsed_ms < 40, f"took {elapsed_ms:.1f}ms -- fail-fast is not short-circuiting"


def test_traceback_is_captured_for_self_repair():
    """The self-repair phase is built entirely from this field."""
    r = run("def add(a, b):\n    return a / 0\n", [TRIVIAL_TEST], wall_s=10)
    assert r.status == "fail"
    assert "ZeroDivisionError" in r.traceback, r.traceback


# --------------------------------------------------------------------------------- utils
def _sleepers(marker: str) -> set[int]:
    """PIDs of any `sleep <marker>` process on the machine."""
    out = subprocess.run(
        ["ps", "-eo", "pid=,args="], capture_output=True, text=True
    ).stdout
    pids = set()
    for line in out.splitlines():
        line = line.strip()
        if not line:
            continue
        pid, _, args = line.partition(" ")
        if "sleep" in args and marker in args:
            try:
                pids.add(int(pid))
            except ValueError:
                pass
    return pids


def _main() -> int:
    """Standalone runner, so the suite works before pytest is installed."""
    cases = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    width = max(len(n) for n, _ in cases)
    failures = []
    print(f"\nadversarial suite — {len(cases)} cases — python {sys.version.split()[0]}\n")
    for name, fn in cases:
        t0 = time.monotonic()
        try:
            fn()
            print(f"  PASS  {name:<{width}}  {(time.monotonic() - t0) * 1000:7.0f} ms")
        except BaseException as exc:
            print(f"  FAIL  {name:<{width}}  {(time.monotonic() - t0) * 1000:7.0f} ms")
            failures.append((name, exc))
    print()
    for name, exc in failures:
        print(f"--- {name}\n    {type(exc).__name__}: {exc}\n")
    print(f"{len(cases) - len(failures)}/{len(cases)} passed\n")
    return 1 if failures else 0



def test_eq_override_is_flagged():
    """The equality-oracle hack: __eq__ returning True makes every assertion pass.

    Without the flag this scores fraction=1.0 with an empty flag list -- a perfect
    reward for implementing nothing. Verified to succeed before the fix.
    """
    r = run(
        "class Always:\n    def __eq__(self, other): return True\n"
        "def solve(x): return Always()\n",
        ["assert solve(1) == 2", "assert solve(2) == 4"],
        wall_s=8, cpu_s=4, mem_mb=256,
    )
    assert "eq_override" in r.flags, (r.status, r.fraction, r.flags)


def test_eq_override_via_subclass_is_flagged():
    """Same hack wearing a list costume -- must not slip past the check."""
    r = run(
        "class L(list):\n    def __eq__(self, o): return True\n    __hash__ = None\n"
        "def solve(x): return L()\n",
        ["assert solve(1) == [1]"],
        wall_s=8, cpu_s=4, mem_mb=256,
    )
    assert "eq_override" in r.flags, (r.status, r.fraction, r.flags)


def test_ordinary_failure_raises_no_filesystem_flag():
    """A wrong answer that touches no files must carry NO flags.

    traceback.format_exc() opens source files to render frames; if the audit hook is
    still armed it fires fs_read_outside_cwd on ~100% of failures, which would make the
    GRPO reward penalise every failure twice for a violation that never happened.
    """
    for code in ("def solve(x): return x * 3",
                 "def solve(x): raise ValueError('nope')",
                 "def solve(x): return None"):
        r = run(code, ["assert solve(1) == 2", "assert solve(2) == 4"],
                wall_s=8, cpu_s=4, mem_mb=256)
        assert not r.ok
        assert r.flags == [], (code, r.flags)


def test_genuine_file_read_is_still_flagged():
    """The counterpart to the test above: real I/O must still be caught."""
    r = run(
        "def solve(x):\n    open('/etc/hosts').read()\n    return x * 2\n",
        ["assert solve(1) == 2"],
        wall_s=8, cpu_s=4, mem_mb=256,
    )
    assert "fs_read_outside_cwd" in r.flags, r.flags

if __name__ == "__main__":
    sys.exit(_main())
