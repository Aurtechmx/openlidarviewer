# OpenLiDARViewer v0.4.6

A redesigned, icon-driven interface, standard CAD-style views, and a
GPU terrain-compute path — all still browser-native, local-first, nothing
uploaded.

## Highlights

- **Six standard views + parallel projection** — snap the camera straight at a
  face with Top / Bottom / Front / Back / Left / Right, and toggle an
  orthographic (parallel) projection that removes perspective so walls and
  floors read flat for measuring. Lives beside the Orbit / Walk / Fly controls.
- **Icon-driven tool surfaces** — the bottom dock, the measurement toolbar, the
  Layers list, and the Export panel get a consistent line-icon set, each keeping
  its visible text label. Inspect and Probe are drawn as distinct tools. A
  full-screen toggle sits in the header. On phones, every panel folds into one
  bottom sheet with View / Analyse / Layers tabs, and the measurement tools
  reflow into a left-edge rail.
- **GPU terrain compute (equivalence-gated)** — terrain derivative and scatter
  passes can run on WebGPU, but the CPU stays the reference: the GPU path must
  pass a per-session equivalence probe before it is trusted, and falls back to
  the CPU silently otherwise. Correctness first, speed where it is proven.
- **Interior floor plan — experimental PREVIEW** — the wall trace is rebuilt from
  an explicit wall graph with flood-fill room segmentation and classified
  doorways, and a "Floor plan confidence" summary reports rooms, walls, openings,
  and the share of wall evidence that was interpolated. It is an approximate
  sketch for inspection, not a measured floor plan.
- **Design pass** — the Analyse verdict (Good / Preview / Limited / Blocked) is
  the unmistakable hero of the panel, the stacked side panels read in two tiers
  of emphasis, typography is quieter, and the mobile layout reflows for
  thumb-friendly targets. Dark, Light, and High-contrast themes are checked for
  WCAG AA contrast.
- **Map sheet & honest labels** — the printable contour map sheet no longer
  overlaps its title with the legend on long filenames, the contour-interval unit
  matches the scale bar (m / ft), and an ungeoreferenced sheet drops the E/N
  graticule and north arrow rather than implying a compass frame it does not
  have. Several label-vs-value drift fixes land alongside it.

## Polish

- The streaming loader shows a determinate resident-node progress bar instead of
  indeterminate text.
- "Solo" in the Layers list is disabled when only one class is present.
- The `?debug` overlay labels the load total as wall-clock time, reports the
  CPU / GPU terrain compute path, and no longer prints a misleading "0 draw
  calls" on backends that do not report it.
- Floor-plan export options (wall snapping, adaptive band) get a small UI; the
  preview stays an experimental PREVIEW.
- Input-escaping hardening across the new icon controls — labels never carry
  markup; only trusted static icons are injected.

Measurement and the floor-plan preview are for visual inspection and research,
not survey-grade use. Treat any output as survey-grade only after validating it
against survey-grade data and procedures.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
