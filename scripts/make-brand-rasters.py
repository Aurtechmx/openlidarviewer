#!/usr/bin/env python3
"""
make-brand-rasters.py: write every identity surface from one vector emblem.

    design/brand-logo.svg       horizontal lockup: emblem, wordmark and
                                tagline as outlined vector paths (master)
    public/brand-mark.svg       the emblem (top bar, empty-state hero)
    public/brand-mark-light.svg the emblem in deeper blues for the light theme
    public/favicon.svg          simplified emblem on a rounded #030817 plate
    public/icon-192.png         web-manifest icons, full-bleed plate with the
    public/icon-512.png         emblem inside the maskable safe zone
    public/apple-touch-icon.png 180 px, full-bleed (iOS needs no alpha)
    public/favicon.ico          16 / 32 / 48, from the simplified emblem
    public/og-card.jpg          1200x630 share card: emblem, wordmark,
                                tagline and a dotted terrain field

The emblem is geometry: a central sphere with a short horizontal flare, four
flat dotted elliptical rings and a mirror-symmetric vertical axis of dots.
Palette #030817 #0F172A #00B2FF #00F0FF #C9F6FF #FFFFFF.

Text is set in Olv Font (src/fonts/olv-font), Medium for the wordmark with
-0.02em tracking and the font's own pair kerning, Regular for the tagline.
Glyphs are converted to paths with fontTools, so no output needs the font.

    python3 scripts/make-brand-rasters.py

Requires: fontTools, Pillow, and rsvg-convert (librsvg) on PATH. Output is
committed, so CI never runs this.
"""

from __future__ import annotations

import io
import math
import pathlib
import subprocess

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
PUBLIC = ROOT / "public"
FONTS = ROOT / "src" / "fonts" / "olv-font"

NIGHT = "#030817"
MIDNIGHT = "#0F172A"
BLUE = "#00B2FF"
CYAN = "#00F0FF"
ICE = "#C9F6FF"
WHITE = "#FFFFFF"

WORDMARK = "OpenLiDARViewer"
# Set as separate lines; each is shrunk to fit if it would run past the edge.
TAGLINE = ("LiDAR and point-cloud viewer that runs in the browser.", "Local files stay on your device.")

# (centre offset, rx, ry) in a 100-unit box centred on the sphere.
RINGS = [(-18, 30, 5.5), (-6.5, 44, 7.5), (5, 48, 8.5), (16, 46, 8.0)]
# (offset from centre, radius), mirrored above and below the sphere.
AXIS = [(19, 3.0), (28, 2.2), (37, 1.2), (44.5, 0.85)]

# Spacing scale (8 px base). Every gap and margin in the lockup and the share
# card is one of these steps.
SPACE = {"xs": 4, "sm": 8, "md": 16, "lg": 24, "xl": 32, "2xl": 48, "3xl": 64, "4xl": 80}
# Ink extents of the emblem in its 100-unit box: the widest ring (rx 48) and
# the outermost axis dots (offset 44.5, radius 0.85).
EMBLEM_INK = (2.0, 50 - 44.5 - 0.85, 98.0, 50 + 44.5 + 0.85)


# The light-background lockup: the same emblem in deeper blues, so it holds on
# near-white surfaces.
LIGHT = {"blue": "#0A6FD6", "cyan": "#0091E6", "ice": "#7FD3FF", "core": "#0057B8"}


def emblem_defs(p: str, light: bool = False) -> str:
    if light:
        return (
            f'<radialGradient id="{p}s" cx="0.38" cy="0.34" r="0.7">'
            f'<stop offset="0" stop-color="{WHITE}"/><stop offset="0.3" stop-color="{LIGHT["ice"]}"/>'
            f'<stop offset="0.65" stop-color="{LIGHT["cyan"]}"/><stop offset="1" stop-color="{LIGHT["core"]}"/></radialGradient>'
            f'<radialGradient id="{p}g"><stop offset="0" stop-color="{LIGHT["cyan"]}" stop-opacity="0.25"/>'
            f'<stop offset="1" stop-color="{LIGHT["cyan"]}" stop-opacity="0"/></radialGradient>'
            f'<linearGradient id="{p}f"><stop offset="0" stop-color="{LIGHT["blue"]}" stop-opacity="0"/>'
            f'<stop offset="0.5" stop-color="{LIGHT["cyan"]}"/><stop offset="1" stop-color="{LIGHT["blue"]}" stop-opacity="0"/></linearGradient>'
        )
    return (
        f'<radialGradient id="{p}s" cx="0.38" cy="0.34" r="0.7">'
        f'<stop offset="0" stop-color="{WHITE}"/><stop offset="0.35" stop-color="{ICE}"/>'
        f'<stop offset="0.7" stop-color="{CYAN}"/><stop offset="1" stop-color="{BLUE}"/></radialGradient>'
        f'<radialGradient id="{p}g"><stop offset="0" stop-color="{CYAN}" stop-opacity="0.55"/>'
        f'<stop offset="1" stop-color="{BLUE}" stop-opacity="0"/></radialGradient>'
        f'<linearGradient id="{p}f"><stop offset="0" stop-color="{BLUE}" stop-opacity="0"/>'
        f'<stop offset="0.5" stop-color="{ICE}"/><stop offset="1" stop-color="{BLUE}" stop-opacity="0"/></linearGradient>'
    )


def emblem_body(p: str, dot: float = 1.5, gap: float = 3.1, light: bool = False) -> str:
    """The emblem in a 100x100 box. Dotted rings are dashed strokes with round
    caps; the far half of each ring is dimmer so the stack reads as depth."""
    blue, cyan = (LIGHT["blue"], LIGHT["cyan"]) if light else (BLUE, CYAN)
    out = [f'<circle cx="50" cy="50" r="15" fill="url(#{p}g)"/>']
    dash = f'stroke-width="{dot}" stroke-linecap="round" stroke-dasharray="0 {gap}" fill="none"'
    for dy, rx, ry in RINGS:
        cy = 50 + dy
        back = f"M{50 - rx} {cy}A{rx} {ry} 0 0 1 {50 + rx} {cy}"
        front = f"M{50 + rx} {cy}A{rx} {ry} 0 0 1 {50 - rx} {cy}"
        out.append(f'<path d="{back}" stroke="{blue}" opacity="0.7" {dash}/>')
        out.append(f'<path d="{front}" stroke="{cyan}" {dash}/>')
    for off, r in AXIS:
        fill = cyan if r > 1.5 else blue
        out.append(f'<circle cx="50" cy="{50 - off}" r="{r}" fill="{fill}"/>')
        out.append(f'<circle cx="50" cy="{50 + off}" r="{r}" fill="{fill}"/>')
    out.append(f'<rect x="22" y="49.4" width="56" height="1.2" rx="0.6" fill="url(#{p}f)"/>')
    out.append(f'<circle cx="50" cy="50" r="7" fill="url(#{p}s)"/>')
    return "".join(out)


def brand_mark_svg(light: bool = False) -> str:
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="256" height="256">'
        f"<defs>{emblem_defs('m', light)}</defs>{emblem_body('m', 2.8, 3.4, light) if light else emblem_body('m', 2.3, 4.0)}</svg>\n"
    )


def favicon_svg() -> str:
    """Simplified for 16-32 px: two solid rings and four axis dots."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">'
        f"<defs>{emblem_defs('f')}</defs>"
        f'<rect width="32" height="32" rx="7" fill="{NIGHT}"/>'
        f'<ellipse cx="16" cy="13.2" rx="11.5" ry="3" fill="none" stroke="{BLUE}" stroke-width="1.3"/>'
        f'<ellipse cx="16" cy="18.8" rx="11.5" ry="3" fill="none" stroke="{CYAN}" stroke-width="1.3"/>'
        f'<circle cx="16" cy="5" r="1.3" fill="{CYAN}"/><circle cx="16" cy="27" r="1.3" fill="{CYAN}"/>'
        f'<circle cx="16" cy="1.9" r="0.8" fill="{BLUE}"/><circle cx="16" cy="30.1" r="0.8" fill="{BLUE}"/>'
        f'<circle cx="16" cy="16" r="4.6" fill="url(#fs)"/></svg>\n'
    )


def app_icon_svg(px: int, safe: float) -> str:
    """Full-bleed plate; the emblem fills `safe` of the side (maskable safe zone)."""
    s = px * safe
    o = (px - s) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {px} {px}" width="{px}" height="{px}">'
        f"<defs>{emblem_defs('a')}"
        f'<radialGradient id="ap" cx="0.5" cy="0.45" r="0.75"><stop offset="0" stop-color="{MIDNIGHT}"/>'
        f'<stop offset="1" stop-color="{NIGHT}"/></radialGradient></defs>'
        f'<rect width="{px}" height="{px}" fill="url(#ap)"/>'
        f'<g transform="translate({o} {o}) scale({s / 100})">{emblem_body("a", 1.9, 3.3)}</g></svg>\n'
    )


# ── text as paths ─────────────────────────────────────────────────────────


def load_font(weight: str) -> TTFont:
    return TTFont(str(FONTS / f"OlvFont-{weight}-Latin.woff2"))


def pair_kerning(font: TTFont) -> dict[tuple[str, str], int]:
    """Glyph-pair x-advance adjustments from the GPOS kern feature (PairPos)."""
    kern: dict[tuple[str, str], int] = {}
    gpos = font["GPOS"].table
    idx = {i for fr in gpos.FeatureList.FeatureRecord if fr.FeatureTag == "kern" for i in fr.Feature.LookupListIndex}
    for i in sorted(idx):
        lk = gpos.LookupList.Lookup[i]
        subs = [s.ExtSubTable for s in lk.SubTable] if lk.LookupType == 9 else lk.SubTable
        for st in subs:
            if not hasattr(st, "Coverage") or not (hasattr(st, "PairSet") or hasattr(st, "Class1Record")):
                continue
            first = st.Coverage.glyphs
            if st.Format == 1:
                for g1, ps in zip(first, st.PairSet):
                    for pvr in ps.PairValueRecord:
                        v = getattr(pvr.Value1, "XAdvance", 0) if pvr.Value1 else 0
                        kern.setdefault((g1, pvr.SecondGlyph), v)
            elif st.Format == 2:
                c1 = st.ClassDef1.classDefs
                c2 = st.ClassDef2.classDefs
                for g1 in first:
                    rec = st.Class1Record[c1.get(g1, 0)]
                    for g2, k2 in c2.items():
                        v = rec.Class2Record[k2].Value1
                        x = getattr(v, "XAdvance", 0) if v else 0
                        if x:
                            kern.setdefault((g1, g2), x)
    return kern


def _draw_text(font: TTFont, text: str, size: float, x: float, baseline: float, tracking_em: float, pen) -> float:
    cmap = font.getBestCmap()
    gs = font.getGlyphSet()
    upm = font["head"].unitsPerEm
    kern = pair_kerning(font)
    scale = size / upm
    cx = 0.0
    names = [cmap[ord(c)] for c in text]
    for i, g in enumerate(names):
        gs[g].draw(TransformPen(pen, (scale, 0, 0, -scale, x + cx * scale, baseline)))
        cx += gs[g].width
        if i + 1 < len(names):
            cx += kern.get((g, names[i + 1]), 0) + tracking_em * upm
    return cx * scale


def text_path(font: TTFont, text: str, size: float, x: float, baseline: float, tracking_em: float = 0.0) -> tuple[str, float]:
    """SVG path data for `text` and its advance width, in output units."""
    pen = SVGPathPen(font.getGlyphSet())
    width = _draw_text(font, text, size, x, baseline, tracking_em, pen)
    return pen.getCommands(), width


def ink_bounds(font: TTFont, text: str, size: float, x: float = 0.0, baseline: float = 0.0, tracking_em: float = 0.0) -> tuple[float, float, float, float]:
    """(left, top, right, bottom) of the drawn outlines, in output units."""
    pen = BoundsPen(font.getGlyphSet())
    _draw_text(font, text, size, x, baseline, tracking_em, pen)
    return pen.bounds


def lockup_text(left: float, right: float, centre_y: float, word_size: float, tag_size: float) -> tuple[str, str]:
    """Wordmark and tagline as one block, laid out from the outlines' ink bounds.

    Inline: the block's ink runs from `left` to `right`; the wordmark is scaled
    to fill that width and the tagline is never wider than the wordmark.
    Stack: the tagline's first line starts SPACE["md"] below the wordmark's
    lowest ink (the descender of "p"), and tagline baselines are a whole number
    of SPACE["sm"] steps apart, at least 1.3 x the tagline size.
    The block is centred on `centre_y` (the emblem's centre), measured from the
    wordmark's cap top to the last tagline baseline, so descenders hang below
    as they do in set type. Returns (wordmark path, tagline path).
    """
    medium, regular = load_font("Medium"), load_font("Regular")
    tracking = -0.02
    wl, _, wr, _ = ink_bounds(medium, WORDMARK, word_size, 0, 0, tracking)
    word_size *= (right - left) / (wr - wl)
    wl, wt, wr, wb = ink_bounds(medium, WORDMARK, word_size, 0, 0, tracking)
    def width(line: str, size: float) -> float:
        b = ink_bounds(regular, line, size)
        return b[2] - b[0]
    widest = max(width(line, tag_size) for line in TAGLINE)
    if widest > wr - wl:
        tag_size *= (wr - wl) / widest
    step = SPACE["sm"]
    pitch = math.ceil(tag_size * 1.3 / step) * step
    tag_top = min(ink_bounds(regular, TAGLINE[0], tag_size)[1], 0.0)
    first_base = wb + SPACE["md"] - tag_top
    last_base = first_base + pitch * (len(TAGLINE) - 1)
    shift = centre_y - (wt + last_base) / 2
    word, _ = text_path(medium, WORDMARK, word_size, left - wl, shift, tracking)
    tag = "".join(
        text_path(regular, line, tag_size, left - ink_bounds(regular, line, tag_size)[0], shift + first_base + i * pitch)[0]
        for i, line in enumerate(TAGLINE)
    )
    return word, tag


def brand_logo_svg() -> str:
    """Horizontal lockup on the #030817 field, all vector.

    Margins are SPACE["2xl"] on every side of the emblem and text ink; the text
    starts SPACE["2xl"] past the emblem's widest ring. The canvas is as wide as
    the wordmark at its set size needs.
    """
    scale = 3.0
    margin = SPACE["2xl"]
    ex0, ey0, ex1, ey1 = EMBLEM_INK
    tx, ty = margin - ex0 * scale, margin - ey0 * scale
    h = math.ceil(2 * margin + (ey1 - ey0) * scale)
    left = margin + (ex1 - ex0) * scale + SPACE["2xl"]
    medium = load_font("Medium")
    wl, _, wr, _ = ink_bounds(medium, WORDMARK, 118, 0, 0, -0.02)
    right = left + (wr - wl)
    w = math.ceil(right + margin)
    word, tag = lockup_text(left, right, h / 2, 118, 38)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f"<defs>{emblem_defs('l')}</defs>"
        f'<rect width="{w}" height="{h}" fill="{NIGHT}"/>'
        f'<g transform="translate({tx:g} {ty:g}) scale({scale:g})">{emblem_body("l")}</g>'
        f'<path d="{word}" fill="{WHITE}"/><path d="{tag}" fill="{CYAN}"/></svg>\n'
    )


def terrain_dots(w: int, h: int) -> str:
    """A dotted wave field across the lower card, perspective-foreshortened."""
    out = []
    rows = 34
    for r in range(rows):
        t = r / (rows - 1)
        y0 = 430 + t * t * 230
        spacing = 3 + t * 13
        rad = 0.6 + t * 1.6
        op = 0.25 + 0.6 * t
        for c in range(int(w / spacing) + 2):
            x = c * spacing - spacing
            u = x / w
            y = y0 - (38 - 26 * t) * (math.sin(u * 5.2 + t * 2.1) * 0.6 + math.sin(u * 11.0 - t * 3.0) * 0.25 + (u**3) * 1.3)
            if y > h + 4 or y < 330:
                continue
            col = CYAN if (c + r) % 5 == 0 else BLUE
            out.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{rad:.2f}" fill="{col}" opacity="{op:.2f}"/>')
    return "".join(out)


def og_card_svg() -> str:
    """1200 x 630 share card.

    Left and right margins are SPACE["4xl"] (80); the emblem's top is
    SPACE["4xl"] + SPACE["2xl"] (128) from the top edge so the block sits
    above the terrain field; the text starts SPACE["2xl"] past the widest ring
    and the wordmark is sized to end at the right margin.
    """
    w, h = 1200, 630
    scale = 2.8
    margin = SPACE["4xl"]
    ex0, ey0, ex1, ey1 = EMBLEM_INK
    tx, ty = margin - ex0 * scale, SPACE["4xl"] + SPACE["2xl"] - ey0 * scale
    centre_y = ty + 50 * scale
    left = margin + (ex1 - ex0) * scale + SPACE["2xl"]
    word, tag = lockup_text(left, w - margin, centre_y, 92, 31)
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">'
        f"<defs>{emblem_defs('o')}"
        f'<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{NIGHT}"/>'
        f'<stop offset="1" stop-color="{MIDNIGHT}"/></linearGradient></defs>'
        f'<rect width="{w}" height="{h}" fill="url(#bg)"/>{terrain_dots(w, h)}'
        f'<g transform="translate({tx:g} {ty:g}) scale({scale:g})">{emblem_body("o")}</g>'
        f'<path d="{word}" fill="{WHITE}"/><path d="{tag}" fill="{CYAN}"/></svg>\n'
    )


def rasterise(svg: str, px_w: int, px_h: int | None = None) -> Image.Image:
    args = ["rsvg-convert", "-w", str(px_w)] + (["-h", str(px_h)] if px_h else []) + ["-f", "png"]
    png = subprocess.run(args, input=svg.encode(), capture_output=True, check=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA")


def main() -> None:
    (ROOT / "design" / "brand-logo.svg").write_text(brand_logo_svg())
    (PUBLIC / "brand-mark.svg").write_text(brand_mark_svg())
    (PUBLIC / "brand-mark-light.svg").write_text(brand_mark_svg(light=True))
    fav = favicon_svg()
    (PUBLIC / "favicon.svg").write_text(fav)
    for size in (192, 512):
        rasterise(app_icon_svg(size, 0.62), size).convert("RGB").save(PUBLIC / f"icon-{size}.png", optimize=True)
    rasterise(app_icon_svg(180, 0.74), 180).convert("RGB").save(PUBLIC / "apple-touch-icon.png", optimize=True)
    ico = [rasterise(fav, s) for s in (48, 32, 16)]
    ico[0].save(PUBLIC / "favicon.ico", format="ICO", sizes=[(48, 48), (32, 32), (16, 16)], append_images=ico[1:])
    rasterise(og_card_svg(), 1200, 630).convert("RGB").save(PUBLIC / "og-card.jpg", quality=88, optimize=True, progressive=True)
    for f in ("brand-mark.svg", "brand-mark-light.svg", "favicon.svg", "icon-192.png", "icon-512.png", "apple-touch-icon.png", "favicon.ico", "og-card.jpg"):
        print(f"{f}: {(PUBLIC / f).stat().st_size} bytes")
    print(f"design/brand-logo.svg: {(ROOT / 'design' / 'brand-logo.svg').stat().st_size} bytes")


if __name__ == "__main__":
    main()
