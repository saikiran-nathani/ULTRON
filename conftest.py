"""Repo-root pytest configuration.

Exists for one reason: `[tool.pytest.ini_options] testpaths = ["src"]` means a
bare `pytest` now collects both suites — src/sandbox/tests (the adversarial
suite) and src/trainwatch/tests. One case in the sandbox suite must not run on
macOS, and skipping it here rather than in the test file keeps that file
runnable standalone (`python src/sandbox/tests/test_adversarial.py`), which it
is designed to be — it imports no pytest and predates it being installed.
"""

from __future__ import annotations

import sys

import pytest

# test_fork_bomb_is_contained sizes RLIMIT_NPROC from current_user_threads(),
# which reads /proc. On macOS /proc is absent, the helper falls back to 4096,
# and the test would permit ~4,100 forked processes -- see BUILDING-ULTRON.md
# Part 3.5, "Do not run the fork-bomb test on the Mac".
LINUX_ONLY_TESTS = frozenset({"test_fork_bomb_is_contained"})


def pytest_collection_modifyitems(
    config: pytest.Config, items: list[pytest.Item]
) -> None:
    if sys.platform == "linux":
        return
    skip = pytest.mark.skip(
        reason="Linux only: sizes RLIMIT_NPROC from /proc, which macOS lacks"
    )
    for item in items:
        if item.name in LINUX_ONLY_TESTS:
            item.add_marker(skip)
