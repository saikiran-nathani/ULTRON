"""The core must import on a bare interpreter, with no third-party module loaded.

This is trainwatch's central promise and the reason it is safe to put in the
training environment: the training loop imports it, and a monitoring library
must never be the reason a six-hour run fails to start. Every module below is
reachable from `src.train.monitor`, so any third-party import that appears here
becomes a new failure mode for ULTRON's SFT / DPO / GRPO runs.

This test used to be a step in trainwatch's own GitHub Actions workflow. That
workflow was dropped when trainwatch was folded into ULTRON; the check was not.
Here it runs on every `pytest`, which is strictly more often than CI did.

It must run in a subprocess: pytest itself lives in site-packages, so an
in-process check would be measuring the wrong interpreter.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]

# The hub half is core too: `trainwatch clip` has to run on the training box
# without dragging FastAPI into that environment.
CORE_MODULES = (
    "config",
    "emit",
    "heartbeat",
    "monitor",
    "notify",
    "rules",
    "store",
    "client",
    "cli",
    "gpu",
    "hub",
    "liveness",
    "security",
    # ADR-0004 phase C. Both are reachable from `cli`, which is already listed,
    # so they are core whether or not they are named -- naming them makes the
    # constraint visible at the point someone would add an import. `progress`
    # touches PyYAML, which is why it does so inside seed_from_yaml() rather
    # than at module scope.
    "curriculum",
    "progress",
    # Replication uses urllib.request rather than requests, precisely so it can
    # sit in the training environment.
    "ship",
    # Password hashing is hashlib.scrypt precisely so this stays true; see the
    # "Why scrypt and not Argon2id" note in auth.py.
    "auth",
)

PROBE = """
import sys


def third_party():
    return {{
        name.split(".")[0]
        for name, mod in sys.modules.items()
        if getattr(mod, "__file__", None) and "site-packages" in str(mod.__file__)
    }}


# Baseline BEFORE importing anything of ours. A venv's site-packages .pth files
# (_virtualenv, _distutils_hack) are executed at interpreter start-up, so they
# are already loaded and are not trainwatch's doing. The invariant is about what
# the import ADDS, not the absolute count -- that is what makes this test
# independent of how the environment was built.
before = third_party()

import src.trainwatch
from src.trainwatch import {modules}

added = sorted(third_party() - before)
if added:
    sys.exit("core grew third-party deps: " + ", ".join(added))
print("clean")
""".format(modules=", ".join(CORE_MODULES))


def test_core_imports_without_third_party_packages() -> None:
    proc = subprocess.run(  # noqa: S603 - argv is literal; sys.executable is us
        [sys.executable, "-c", PROBE],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, (
        f"the zero-dependency core is no longer zero-dependency:\n"
        f"{proc.stdout}{proc.stderr}"
    )
    assert "clean" in proc.stdout


def test_server_is_not_reachable_from_the_core() -> None:
    """Importing the core must not pull in FastAPI by a side door.

    `src.trainwatch.server` is the one subpackage allowed third-party deps. It
    is imported lazily inside `cli.cmd_serve`, so the training box never pays
    for it -- assert that stays true.
    """
    probe = (
        "import sys\n"
        "import src.trainwatch\n"
        "from src.trainwatch import cli, monitor\n"
        "assert 'src.trainwatch.server' not in sys.modules, "
        "'server subpackage imported eagerly'\n"
        "assert 'fastapi' not in sys.modules, 'fastapi imported by the core'\n"
        "print('clean')\n"
    )
    proc = subprocess.run(  # noqa: S603 - argv is literal; sys.executable is us
        [sys.executable, "-c", probe],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert proc.returncode == 0, f"{proc.stdout}{proc.stderr}"
