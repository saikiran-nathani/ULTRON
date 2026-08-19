"""Runs inside the sandbox. Imports the solution, scores the tests, writes the report.

This file lives OUTSIDE the child's cwd on purpose. It is invoked by absolute path with
`python -I` (isolated mode: no cwd on sys.path, no user site-packages, env ignored).

Ordering here is load-bearing:
    1. read the test payload
    2. UNLINK the payload, scrub argv and env
    3. arm the audit hook
    4. only then import the untrusted solution

By step 4 the tests exist only in this process's memory and their path is not in argv,
env, or on disk. A solution that opens every file it can find has nothing to find.
"""

from __future__ import annotations

import io
import json
import os
import resource
import sys
import traceback

_STATE = {"armed": False, "flags": set(), "workdir": ""}


def _flag(name: str) -> None:
    _STATE["flags"].add(name)


def _audit(event: str, args) -> None:
    """Flag suspicious behaviour. Level 1 detects; Level 2 prevents.

    RESIDUAL: an audit hook cannot be removed, but this module is reachable as
    sys.modules['__main__'], so a determined solution could flip _STATE['armed'].
    Flags are evidence, not enforcement. Real prevention is `docker run --network none
    --read-only`. Treat a flagged rollout as a reward-hacking lead, not a verdict.
    """
    if not _STATE["armed"]:
        return
    try:
        if event == "open":
            path = args[0]
            if not isinstance(path, (str, bytes, os.PathLike)):
                return  # fd-based open; nothing to classify
            p = os.fsdecode(path)
            base = os.path.basename(p).lower()
            if "test" in base or "payload" in base or "report" in base:
                _flag("read_test_file")
            resolved = os.path.realpath(p)
            if not resolved.startswith(os.path.realpath(_STATE["workdir"])):
                mode = args[1] if len(args) > 1 else "r"
                if isinstance(mode, str) and any(c in mode for c in "wax+"):
                    _flag("fs_escape_write")
                else:
                    _flag("fs_read_outside_cwd")
        elif event in ("socket.connect", "socket.getaddrinfo", "socket.create_connection"):
            _flag("net_attempt")
        elif event == "urllib.Request":
            _flag("net_attempt")
        elif event in ("os.fork", "os.forkpty", "os.posix_spawn"):
            _flag("fork_attempt")
        elif event == "subprocess.Popen":
            _flag("subprocess_spawn")
        elif event in ("os.system", "os.exec"):
            _flag("exec_attempt")
    except Exception:
        # An exception raised inside an audit hook propagates into whatever the
        # solution was doing and would be indistinguishable from a real failure.
        pass


def _cpu_ms() -> int:
    ru = resource.getrusage(resource.RUSAGE_SELF)
    ch = resource.getrusage(resource.RUSAGE_CHILDREN)
    total = ru.ru_utime + ru.ru_stime + ch.ru_utime + ch.ru_stime
    return int(total * 1000)


def _write(report_path: str, data: dict) -> None:
    _STATE["armed"] = False  # our own writes are not the solution's behaviour
    data["cpu_ms"] = _cpu_ms()
    data["flags"] = sorted(_STATE["flags"])
    try:
        with open(report_path, "w") as fh:
            json.dump(data, fh)
    except OSError:
        pass


def main() -> int:
    with open(sys.argv[1]) as fh:
        payload = json.load(fh)
    tests = payload["tests"]
    report_path = payload["report"]
    _STATE["workdir"] = payload["workdir"]

    # Nothing on disk, nothing in argv. The solution cannot read what is not there.
    try:
        os.unlink(sys.argv[1])
    except OSError:
        pass
    sys.argv = ["solution"]

    sys.addaudithook(_audit)
    _STATE["armed"] = True

    # Import the untrusted solution. Its cwd is the work dir and holds only itself.
    sys.path.insert(0, _STATE["workdir"])
    ns: dict = {}
    try:
        with open(os.path.join(_STATE["workdir"], "solution.py")) as fh:
            src = fh.read()
        ns = {"__name__": "solution", "__file__": "solution.py"}
        exec(compile(src, "solution.py", "exec"), ns)
    except SystemExit as exc:
        # `import sys; sys.exit(0)` -- a clean exit code with nothing verified. This is
        # exactly why scoring reads the report and never the exit status.
        _STATE["armed"] = False
        _write(report_path, {
            "passed": 0, "total": len(tests),
            "import_error": f"Solution called sys.exit({exc.code}) at import time; "
                            f"no tests were executed.",
            "tracebacks": [],
        })
        return 0
    except BaseException:
        _STATE["armed"] = False
        _write(report_path, {
            "passed": 0, "total": len(tests),
            "import_error": traceback.format_exc(limit=6),
            "tracebacks": [],
        })
        return 0

    # Each test runs independently against a fresh copy of the solution namespace, so
    # one failure cannot cascade and passed/total stays a meaningful dense reward.
    passed = 0
    tracebacks: list[str] = []
    for i, test_src in enumerate(tests):
        buf_out, buf_err = io.StringIO(), io.StringIO()
        real_out, real_err = sys.stdout, sys.stderr
        try:
            sys.stdout, sys.stderr = buf_out, buf_err
            _STATE["armed"] = True
            exec(compile(test_src, f"<test{i}>", "exec"), dict(ns))
            passed += 1
        except BaseException:
            # BaseException, not Exception: a test must still count as failed when the
            # solution raises SystemExit or KeyboardInterrupt to escape it.
            # Disarm FIRST: traceback.format_exc() opens source files to render frames,
            # which otherwise raises a spurious fs_read_outside_cwd on EVERY ordinary
            # test failure -- poisoning the GRPO reward with a phantom violation.
            _STATE["armed"] = False
            tracebacks.append(f"[test {i}] " + traceback.format_exc(limit=6))
        finally:
            _STATE["armed"] = False
            sys.stdout, sys.stderr = real_out, real_err

    # A solution that defines __eq__/__ne__ makes `assert f(x) == expected` true for ANY
    # return value -- a perfect 1.0 having implemented nothing. It is among the first
    # things a GRPO policy discovers, and the assertion itself cannot detect it.
    # Flag it here; the reward function must treat eq_override as a hard zero.
    for _obj in ns.values():
        if isinstance(_obj, type) and ("__eq__" in vars(_obj) or "__ne__" in vars(_obj)):
            _flag("eq_override")
            break

    _write(report_path, {
        "passed": passed,
        "total": len(tests),
        "import_error": "",
        "tracebacks": tracebacks,
    })
    return 0


if __name__ == "__main__":
    # Catch Exception, NOT BaseException: sys.exit() raises SystemExit, so a bare
    # BaseException handler here catches our own clean exit, prints a spurious
    # traceback, and replaces the real exit code with 70 on every single run.
    try:
        _rc = main()
    except Exception:
        # Never let the runner die silently -- a missing report is scored as 'crash'
        # and we would rather see why on stderr.
        traceback.print_exc()
        _rc = 70
    sys.exit(_rc)
