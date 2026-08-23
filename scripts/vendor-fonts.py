#!/usr/bin/env python3
"""Re-vendor the dashboard's three font families as local latin-subset woff2.

Run from the repo root when changing the type stack:

    python scripts/vendor-fonts.py

Writes dashboard/public/fonts/*.woff2 and regenerates dashboard/src/fonts.css.

Self-hosting is deliberate. The dashboard has to render correctly on a training
box with no outbound internet, on an iPad behind a captive portal, and over
cellular where a CDN round-trip is real latency — and it keeps the tailnet the
only thing the client ever talks to.
"""

from __future__ import annotations

import pathlib
import re
import sys
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "dashboard" / "public" / "fonts"
CSS = ROOT / "dashboard" / "src" / "fonts.css"

UA = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
    )
}
BLOCK = re.compile(r"/\*\s*([\w\-\[\]]+)\s*\*/\s*(@font-face\s*\{.*?\})", re.S)

# slug → Google Fonts css2 family spec
FAMILIES = [
    ("bricolage", "Bricolage+Grotesque:opsz,wght@12..96,400..600"),
    ("manrope", "Manrope:wght@400..700"),
    ("plex", "IBM+Plex+Mono:wght@400;500;600"),
]

HEADER = """/* Self-hosted latin subsets — vendored by scripts/vendor-fonts.py.
   Self-hosted on purpose: the dashboard must render correctly on a box
   with no internet and an iPad on a captive network, and it keeps the
   tailnet the only thing the client talks to. */
"""


def fetch(url: str) -> bytes:
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60).read()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    blocks: list[str] = []
    for slug, family in FAMILIES:
        css = fetch(f"https://fonts.googleapis.com/css2?family={family}&display=swap").decode()
        for subset, block in BLOCK.findall(css):
            if subset != "latin":  # skip cyrillic / greek / vietnamese / latin-ext
                continue
            src = re.search(r"url\((https://[^)]+\.woff2)\)", block)
            weight = re.search(r"font-weight:\s*([^;]+);", block)
            if not (src and weight):
                continue
            name = f"{slug}-{weight.group(1).strip().replace(' ', '-')}.woff2"
            data = fetch(src.group(1))
            (OUT / name).write_bytes(data)
            print(f"  {name:28} {len(data) / 1024:6.1f} KiB")
            blocks.append(
                re.sub(
                    r"src:\s*url\([^)]+\)\s*format\('woff2'\);",
                    f"src: url('/fonts/{name}') format('woff2');",
                    block,
                ).strip()
            )
    CSS.write_text(HEADER + "\n" + "\n\n".join(blocks) + "\n", encoding="utf-8")
    print(f"\n{len(blocks)} faces → {CSS.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
