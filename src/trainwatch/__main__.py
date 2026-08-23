"""`python -m src.trainwatch ...` — the trainwatch CLI.

trainwatch used to be an installed distribution with a `trainwatch` console
script. It is now part of ULTRON rather than a package on its own, so there is
no entry point to install; this module is what replaces it. `scripts/trainwatch`
is a one-line wrapper over this, so the documented `trainwatch serve` still
works from the repo root.

Run from the repository root — `src` is a package there, and both the .env
lookup and the default `var/` paths resolve against the working directory.
"""

from __future__ import annotations

import sys

from .cli import main

if __name__ == "__main__":
    sys.exit(main())
