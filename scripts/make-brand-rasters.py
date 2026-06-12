#!/usr/bin/env python3
"""
make-brand-rasters.py — rasterise every identity surface from the OFFICIAL
OpenLiDARViewer logo file, public/brand-logo.svg.

    public/favicon.svg          the official mark (downscaled crop of the
                                logo's own pixels) on the #0a0e1a brand
                                plate — written here so the vector favicon
                                and the rasters always derive from the
                                same source
    public/icon-192.png         web-manifest icon (rounded brand-dark
                                plate carrying the official mark)
    public/icon-512.png         web-manifest icon, same design
    public/apple-touch-icon.png 180 px, full-bleed #0a0e1a (iOS composites
                                transparency on white, so no alpha)
    public/favicon.ico          16 / 32 / 48 multi-size legacy favicon —
                                each size downscaled independently from
                                the high-resolution master
    public/og-card.jpg          1200x630 Open Graph / Twitter share card —
                                the full official logo lockup (mark +
                                wordmark, as delivered) on the deep-navy
                                brand field, tagline in cyan below

RASTERISE, DON'T REDRAW. This script replaces scripts/make-manifest-icons.py
(retired 2026-06-10), which *drew* placeholder geometry with Pillow. Nothing
here draws logo artwork: every output is produced by cropping, scaling and
compositing the pixels of the official asset. The only painted elements are
background plates (#0a0e1a squares / rounded squares, needed for contrast on
light UI and required without alpha by iOS) and the og-card tagline text —
neither is logo artwork.

HOW THE SOURCE IS READ. public/brand-logo.svg, as delivered, is an SVG
wrapper around a single full-resolution embedded PNG (910x706, RGBA) — so
"rasterising the SVG" reduces, losslessly, to decoding that embedded PNG and
resampling it (Lanczos). If a future revision of the logo arrives as true
vector art, switch the `load_logo()` step to a real SVG rasteriser
(resvg / headless Chromium) and keep everything downstream unchanged.

MARK CROP. The lockup carries the point-cloud-orb mark in its upper region
and a raster wordmark in its lower band. Icon surfaces use the mark-only
square crop — the SAME region public/brand-mark.svg exposes via its viewBox
(SVG units 178,-12 / 634x634 == PNG pixels x 138..772, y -52..582, the
negative rows padded transparent). Change one, change the other.

    python3 scripts/make-brand-rasters.py

Requires: Pillow. The og-card tagline prefers the app's own Inter face
(instanced to Bold from the variable woff2 in node_modules via fontTools,
when available) and falls back to DejaVu Sans Bold. Output is committed,
so end users / CI never need to run this.
"""

from __future__ import annotations

import base64
import pathlib
import re
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "public"
LOGO_SVG = OUT_DIR / "brand-logo.svg"

BRAND_DARK = (0x0A, 0x0E, 0x1A)
CYAN = (0x00, 0xF0, 0xFF)

# ── Mark-only crop, in source-PNG pixel coordinates ─────────────────────────
# Must stay in lockstep with public/brand-mark.svg's viewBox (which is in
# SVG units = PNG pixels + the wrapper's 40,40 image offset).
MARK_X0, MARK_Y0, MARK_SIDE = 138, -52, 634

# ── Tile design (icon surfaces): 64-unit canvas, plate + centred mark ──────
TILE_UNITS = 64.0
TILE_RADIUS = 14.0  # matches the previous favicon plate / app theme tiles
MARK_INSET = 5.0    # mark square spans units 5..59 (~84% — glow pads it)


def load_logo() -> Image.Image:
    """Decode the official logo's embedded full-resolution PNG (RGBA)."""
    svg = LOGO_SVG.read_text()
    m = re.search(r'xlink:href="data:image/png;base64,\s*([A-Za-z0-9+/=\s]+)"', svg)
    if not m:
        raise SystemExit(f"no embedded PNG found in {LOGO_SVG}")
    png = base64.b64decode(re.sub(r"\s", "", m.group(1)))
    img = Image.open(BytesIO(png)).convert("RGBA")
    return img


def crop_mark(logo: Image.Image) -> Image.Image:
    """The mark-only square crop, padded transparent where it overhangs."""
    side = MARK_SIDE
    out = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    src_y0 = max(MARK_Y0, 0)
    region = logo.crop((MARK_X0, src_y0, MARK_X0 + side, min(MARK_Y0 + side, logo.height)))
    out.paste(region, (0, src_y0 - MARK_Y0))
    return out


def render_tile(mark: Image.Image, master_px: int = 2048, *, rounded: bool,
                opaque: bool) -> Image.Image:
    """
    The icon tile: the #0a0e1a brand plate (rounded with transparent corners,
    or full-bleed opaque) carrying the official mark, centred. The plate is
    background, not logo artwork — the mark pixels come solely from `mark`.
    """
    ss = 4  # supersample the plate's rounded corners
    size = master_px * ss
    s = size / TILE_UNITS

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    if rounded and not opaque:
        draw.rounded_rectangle([0, 0, size - 1, size - 1],
                               radius=TILE_RADIUS * s, fill=BRAND_DARK + (255,))
    else:
        draw.rectangle([0, 0, size, size], fill=BRAND_DARK + (255,))

    mark_px = round((TILE_UNITS - 2 * MARK_INSET) * s)
    placed = mark.resize((mark_px, mark_px), Image.LANCZOS)
    off = round(MARK_INSET * s)
    img.alpha_composite(placed, (off, off))

    return img.resize((master_px, master_px), Image.LANCZOS)


# ── og-card tagline: Inter Bold (the app's own face) with DejaVu fallback ──

def load_tagline_font(size: int) -> ImageFont.FreeTypeFont:
    """
    Prefer Inter Bold, instanced from the variable woff2 the app already
    ships (node_modules/@fontsource-variable/inter) via fontTools; fall back
    to DejaVu Sans Bold (present wherever Pillow is).
    """
    import tempfile

    cache = pathlib.Path(tempfile.gettempdir()) / "olv-inter-bold.ttf"
    if not cache.exists():
        try:
            from fontTools.ttLib import TTFont
            from fontTools.varLib.instancer import instantiateVariableFont

            woff2 = (
                ROOT / "node_modules" / "@fontsource-variable" / "inter"
                / "files" / "inter-latin-wght-normal.woff2"
            )
            font = TTFont(str(woff2))
            font.flavor = None  # decompress woff2 → plain ttf
            instantiateVariableFont(font, {"wght": 700}, inplace=True)
            font.save(str(cache))
        except Exception as exc:  # noqa: BLE001 — any failure means fallback
            print(f"  (Inter unavailable: {exc!r} — falling back to DejaVu Sans Bold)")
    if cache.exists():
        return ImageFont.truetype(str(cache), size)
    return ImageFont.truetype("DejaVuSans-Bold.ttf", size)


def make_og_card(logo: Image.Image) -> Image.Image:
    """
    1200x630 share card: the FULL official lockup (mark + the asset's own
    raster wordmark — near-white, designed for dark fields, so it reads
    perfectly on the deep-navy brand background) centred, with the tagline
    in cyan below. Layout carried over from the previous card; the typeset
    Inter wordmark it used is replaced by the logo's own.
    """
    w, h = 1200, 630
    card = Image.new("RGB", (w, h), BRAND_DARK)
    draw = ImageDraw.Draw(card)

    tagline = "Visualize. Explore. Understand."
    tag_font = load_tagline_font(36)
    g_bbox = draw.textbbox((0, 0), tagline, font=tag_font)
    g_w, g_h = g_bbox[2] - g_bbox[0], g_bbox[3] - g_bbox[1]

    gap = 26
    logo_w = 600
    logo_h = round(logo_w * logo.height / logo.width)
    block_h = logo_h + gap + g_h
    y = (h - block_h) // 2

    lockup = logo.resize((logo_w, logo_h), Image.LANCZOS)
    card.paste(lockup, ((w - logo_w) // 2, y), lockup)
    draw.text(((w - g_w) // 2 - g_bbox[0], y + logo_h + gap - g_bbox[1]),
              tagline, font=tag_font, fill="#%02x%02x%02x" % CYAN)
    return card


FAVICON_SVG_TEMPLATE = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <!--
    OpenLiDARViewer favicon — the OFFICIAL brand mark on the brand-dark
    plate. GENERATED FILE: written by scripts/make-brand-rasters.py, which
    crops the mark region out of public/brand-logo.svg's full-resolution
    pixels and downscales it (Lanczos, {px} px) for embedding — the mark is
    the real asset's pixels, not redrawn artwork. The #0a0e1a rounded plate
    (matching theme-color / the app background) sits behind it for contrast
    on light browser chrome. Regenerate with:

        python3 scripts/make-brand-rasters.py
  -->
  <rect width="64" height="64" rx="14" fill="#0a0e1a"/>
  <image x="5" y="5" width="54" height="54" href="data:image/png;base64,{b64}"/>
</svg>
"""


def make_favicon_svg(mark: Image.Image, px: int = 256) -> str:
    """favicon.svg: brand plate + an embedded downscale of the real mark."""
    small = mark.resize((px, px), Image.LANCZOS)
    buf = BytesIO()
    small.save(buf, format="PNG", optimize=True)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    return FAVICON_SVG_TEMPLATE.format(px=px, b64=b64)


def main() -> None:
    logo = load_logo()
    mark = crop_mark(logo)

    # favicon.svg — vector wrapper: plate + the real mark, downscaled.
    out = OUT_DIR / "favicon.svg"
    out.write_text(make_favicon_svg(mark))
    print(f"wrote {out} ({out.stat().st_size} bytes)")

    # Manifest icons — rounded plate, transparency in the corners.
    plate = render_tile(mark, rounded=True, opaque=False)
    for size in (512, 192):
        out = OUT_DIR / f"icon-{size}.png"
        plate.resize((size, size), Image.LANCZOS).save(out, optimize=True)
        print(f"wrote {out} ({size}x{size})")

    # apple-touch-icon — 180 px, FULL-BLEED #0a0e1a (iOS composites alpha
    # on white, so the corners must be filled — no transparency).
    flat = render_tile(mark, rounded=False, opaque=True)
    out = OUT_DIR / "apple-touch-icon.png"
    flat.convert("RGB").resize((180, 180), Image.LANCZOS).save(out, optimize=True)
    print(f"wrote {out} (180x180, full-bleed)")

    # favicon.ico — 48/32/16, each downscaled from the 2048 master (not from
    # each other). At 16 px the dotted orbits blur into the glowing-orb
    # silhouette — that is the real asset downscaled, which is the contract;
    # nothing is redrawn to "help" legibility.
    ico_imgs = [plate.resize((s, s), Image.LANCZOS) for s in (48, 32, 16)]
    out = OUT_DIR / "favicon.ico"
    ico_imgs[0].save(out, format="ICO", append_images=ico_imgs[1:],
                     sizes=[(48, 48), (32, 32), (16, 16)])
    print(f"wrote {out} (48/32/16)")

    # og-card — 1200x630 share image: the full official lockup + tagline.
    out = OUT_DIR / "og-card.jpg"
    make_og_card(logo).save(out, quality=90, optimize=True, progressive=True)
    print(f"wrote {out} (1200x630)")


if __name__ == "__main__":
    main()
