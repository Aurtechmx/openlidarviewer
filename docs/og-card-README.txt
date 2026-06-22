Binary share/icon assets — how they are generated
==================================================

EVERY identity asset in this directory derives from the OFFICIAL
OpenLiDARViewer logo file:

    design/brand-logo.svg     the logo as delivered (2026-06-10): an SVG
                              wrapper around one full-resolution embedded
                              PNG — the point-cloud-orb mark plus the
                              raster wordmark band. Source of truth.
    public/brand-mark.svg     the mark-only crop of the master, DOWNSCALED to
                              256 px and re-embedded (~82 KB, not the full-res
                              master) — it renders at the 28 px header / 104 px
                              hero, so display resolution is all it needs.
                              Rendered in-app by src/ui/Stage.ts via
                              <img src> (top bar + empty-state hero).

index.html / manifest.webmanifest reference binary assets that cannot be
committed as text. ALL of them are RASTERISED from brand-logo.svg — the
real pixels cropped, scaled, and composited, never redrawn — by one script:

    python3 scripts/make-brand-rasters.py

which writes, into this public/ directory (Vite copies public/ verbatim
to the dist root):

1. favicon.svg               — the mark (downscaled crop of the asset's
                               own pixels) on the #0a0e1a brand plate for
                               contrast on light browser chrome.

2. icon-192.png / icon-512.png — web-manifest icons (the mark on the
                               rounded brand-dark plate, declared in
                               manifest.webmanifest, "any maskable").

3. apple-touch-icon.png      — 180x180 PNG, full-bleed #0a0e1a, no
                               transparency (iOS composites alpha on
                               white otherwise).

4. favicon.ico               — multi-size 16/32/48 legacy favicon, each
                               size downscaled from the 2048 px master.

5. og-card.jpg               — the Open Graph / Twitter share image,
                               1200x630: the FULL official lockup (mark +
                               the asset's own wordmark) on the deep-navy
                               field, tagline in cyan (Inter Bold,
                               instanced from node_modules via fontTools
                               when available; DejaVu Sans Bold fallback).

Requires Pillow (maintainer machine only — output is committed, so end
users / CI never run this). If a new revision of the logo arrives,
replace design/brand-logo.svg, re-derive public/brand-mark.svg's viewBox
crop if the geometry moved, and re-run the script.
