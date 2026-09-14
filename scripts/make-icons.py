#!/usr/bin/env python3
"""Rasterize dashboard/public/icon.svg into the PNGs the platforms require.

Run from the repo root after changing the icon:

    python scripts/make-icons.py

Writes dashboard/public/{icon-192,icon-512,icon-maskable-512,apple-touch-icon}.png.

Why this script exists at all
-----------------------------
Before it, the manifest declared exactly one icon — `icon.svg` at
`"sizes": "any"` — and `<link rel="apple-touch-icon">` pointed at the same SVG.
Two separate consequences, both silent:

* **Chrome would not offer to install the app.** Its install criteria require a
  registered service worker *and* PNG icons at 192 and 512. An SVG at "any"
  satisfies neither, so the install prompt simply never appeared and there was
  nothing in the console to say why.
* **iOS does not support SVG for `apple-touch-icon`.** It does not fall back to
  the manifest; it screenshots the page and uses that. So "Add to Home Screen"
  produced a home-screen tile showing a tiny picture of the dashboard.

That second one matters more than it sounds, because installation is
load-bearing here rather than cosmetic: iOS evicts script-writable storage —
IndexedDB, Cache Storage, service worker registrations — after seven days of
no interaction with a site in a Safari tab, and home-screen-installed web apps
are exempt. An uninstalled app therefore loses the device's whole dataset
after a fortnight's neglect, with no prompt. An ugly icon is what stops
someone installing it.

Three variants, not one resize
-------------------------------
The platforms want genuinely different images, and the differences are not
scale:

* **`icon-192` / `icon-512`** — `purpose: "any"`. The source as-drawn,
  rounded corners and all, because nothing masks these.
* **`apple-touch-icon` (180)** — full-bleed square, `rx=0`. iOS applies its
  own corner mask, so shipping our own rounding leaves dark transparent
  wedges *inside* Apple's rounding. The classic double-rounded tile.
* **`icon-maskable-512`** — `purpose: "maskable"`. Android may crop to any
  shape within a safe zone of the centre 80%, so the artwork is inset to 80%
  on a full-bleed background. Feeding an unpadded icon here is how Android
  adaptive icons end up with the edges shaved off.

The variants are *derived* from icon.svg rather than kept as three files on
disk, because three hand-maintained copies of one drawing is a drift bug with
a delay fuse — change the accent colour once and two of them stay teal.

Rasterizing without a dependency
---------------------------------
macOS ships `qlmanage` (Quick Look) and `sips`, which between them do this
without adding cairo, ImageMagick or a node toolchain to the build. The
tradeoff is that this script is macOS-only — acceptable because the icon
changes roughly never and the output is committed, so the Linux host never
runs it. It refuses loudly rather than writing a broken file if either tool is
missing.
"""

from __future__ import annotations

import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "dashboard" / "public"
SRC = PUBLIC / "icon.svg"

# The source is a 192-unit square; every geometry number below is in those units.
VIEW = 192.0

# name -> (pixel size, corner radius, content scale)
VARIANTS: dict[str, tuple[int, float, float]] = {
    "icon-192": (192, 42.0, 1.0),
    "icon-512": (512, 42.0, 1.0),
    # Full bleed: iOS masks it itself, so our own rounding would double up.
    "apple-touch-icon": (180, 0.0, 1.0),
    # Safe zone is the centre 80%; anything outside it may be cropped away.
    "icon-maskable-512": (512, 0.0, 0.8),
}

# Matches the background rect, whatever its current radius or fill.
_BG = re.compile(r'<rect\s+width="192"\s+height="192"[^>]*/>')


def variant_svg(source: str, *, radius: float, scale: float) -> str:
    """Rebuild the icon with a different corner radius and content inset.

    The background rect keeps the full canvas; everything drawn on top of it is
    wrapped in one transform. Splitting on the rect rather than editing
    attributes in place means a maskable icon insets the *artwork* and not the
    backdrop, which is the whole point of a maskable icon.
    """
    m = _BG.search(source)
    if m is None:
        raise SystemExit(
            f"{SRC}: could not find the 192x192 background rect.\n"
            "The icon was restructured; update _BG in this script to match."
        )

    bg = f'<rect width="192" height="192" rx="{radius:g}" fill="url(#abyss)" />'
    head, tail = source[: m.start()], source[m.end() :]

    # Everything after the rect is artwork, up to the closing tag.
    close = tail.rindex("</svg>")
    art, end = tail[:close], tail[close:]

    if scale == 1.0:
        return f"{head}{bg}{art}{end}"

    # Scale about the centre: translate by half the space the shrink frees up.
    offset = VIEW * (1.0 - scale) / 2.0
    return (
        f"{head}{bg}"
        f'<g transform="translate({offset:g} {offset:g}) scale({scale:g})">{art}</g>'
        f"{end}"
    )


# Render at this before downsampling: the strokes are hairlines at 192 and
# survive a downsample far better than an upscale.
_RENDER_AT = 1024

_SIZE_ATTRS = re.compile(r'width="192"\s+height="192"')


def rasterize(svg_text: str, out: pathlib.Path, size: int) -> None:
    """SVG text -> PNG at `size`, via Quick Look then sips.

    The intrinsic size matters and is the trap here. Quick Look renders an SVG
    at the size its `width`/`height` attributes declare and then *pads* to the
    square requested with -s; it does not scale to fit. So the source's
    `width="192"` produced a 192px drawing sitting in the top-left corner of a
    1024px transparent canvas, which downsampled to a perfectly valid 512x512
    PNG whose artwork occupied the top-left 19% — and `file` reported
    "PNG image data, 512 x 512, 8-bit/color RGBA", which is true and useless.

    Setting width/height to the render size makes the drawing fill the canvas.
    The viewBox is untouched, so no geometry changes.
    """
    scaled, n = _SIZE_ATTRS.subn(
        f'width="{_RENDER_AT}" height="{_RENDER_AT}"', svg_text, count=1
    )
    if n != 1:
        raise SystemExit(
            f"{SRC}: expected width=\"192\" height=\"192\" on the root <svg>.\n"
            "Without it Quick Look renders small and pads, which looks like success."
        )

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = pathlib.Path(tmp)
        svg = tmpdir / "in.svg"
        svg.write_text(scaled, encoding="utf-8")

        subprocess.run(
            ["qlmanage", "-t", "-s", str(_RENDER_AT), "-o", str(tmpdir), str(svg)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        rendered = tmpdir / "in.svg.png"
        if not rendered.exists():
            raise SystemExit(f"Quick Look produced no thumbnail for {out.name}")

        subprocess.run(
            ["sips", "-z", str(size), str(size), str(rendered), "--out", str(out)],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def _read_rgba(path: pathlib.Path) -> tuple[int, int, bytes]:
    """Decode an 8-bit RGBA PNG to raw pixels. stdlib only.

    Exists so the check below can look at actual pixels. `sips -g pixelWidth`
    and `file` both report the canvas, and the canvas was never what was
    wrong -- so neither tool could see the bug they were being used to rule
    out. Roughly the same shape as scraping a tool's stdout instead of
    reading its exit code.
    """
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path.name}: not a PNG")

    pos, idat, width, height = 8, bytearray(), 0, 0
    while pos < len(data):
        length = int.from_bytes(data[pos : pos + 4], "big")
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width = int.from_bytes(body[0:4], "big")
            height = int.from_bytes(body[4:8], "big")
            depth, colour = body[8], body[9]
            if (depth, colour) != (8, 6):
                raise SystemExit(
                    f"{path.name}: expected 8-bit RGBA, got depth={depth} colour={colour}"
                )
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
        pos += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = width * 4
    out = bytearray(height * stride)
    prev = bytearray(stride)
    src = 0
    for y in range(height):
        filt = raw[src]
        src += 1
        line = bytearray(raw[src : src + stride])
        src += stride
        if filt == 1:  # Sub
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 0xFF
        elif filt == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filt == 3:  # Average
            for i in range(stride):
                left = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filt == 4:  # Paeth
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pred) & 0xFF
        elif filt != 0:
            raise SystemExit(f"{path.name}: unknown PNG filter {filt}")
        out[y * stride : (y + 1) * stride] = line
        prev = line

    return width, height, bytes(out)


def verify_fills_canvas(path: pathlib.Path) -> None:
    """Fail if the artwork does not reach every edge of the image.

    Every variant here is drawn on a full-canvas background rect, so opaque
    pixels must touch all four edges -- rounded corners included, because a
    rounded rect still spans the full width at its vertical midpoint. An icon
    floating in a transparent field fails this, which is the whole point.
    """
    width, height, px = _read_rgba(path)
    alpha_at = lambda x, y: px[(y * width + x) * 4 + 3]  # noqa: E731

    mid_x, mid_y = width // 2, height // 2
    edges = {
        "left": alpha_at(0, mid_y),
        "right": alpha_at(width - 1, mid_y),
        "top": alpha_at(mid_x, 0),
        "bottom": alpha_at(mid_x, height - 1),
    }
    empty = [name for name, a in edges.items() if a < 250]
    if empty:
        raise SystemExit(
            f"{path.name}: transparent at the {', '.join(empty)} edge(s).\n"
            f"The image is {width}x{height} and technically valid, but the artwork "
            "does not fill it -- the icon would render as a small drawing in a "
            "corner. Check the root <svg> width/height rewrite in rasterize()."
        )


def main() -> int:
    if sys.platform != "darwin":
        print("This script needs macOS (qlmanage + sips).", file=sys.stderr)
        print("The PNGs are committed, so only re-run it when icon.svg changes.", file=sys.stderr)
        return 2
    for tool in ("qlmanage", "sips"):
        if shutil.which(tool) is None:
            print(f"missing {tool}", file=sys.stderr)
            return 2
    if not SRC.exists():
        print(f"missing {SRC}", file=sys.stderr)
        return 2

    source = SRC.read_text(encoding="utf-8")
    for name, (size, radius, scale) in VARIANTS.items():
        out = PUBLIC / f"{name}.png"
        rasterize(variant_svg(source, radius=radius, scale=scale), out, size)
        verify_fills_canvas(out)
        print(f"  + {out.relative_to(ROOT)}  {size}x{size}  fills canvas \u2713")

    print(f"\nWrote {len(VARIANTS)} icons. Rebuild the dashboard to publish them.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
