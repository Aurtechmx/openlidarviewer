# OpenLiDARViewer v0.4.9

An honesty-and-polish release. The Analyse panel now leads with one plain
verdict, every surface reports the file's true scale instead of the display
sample, and the deploy is meaningfully leaner. Still browser-native, local-first,
nothing uploaded.

## Highlights

- **Data Fitness scorecard** — the Analyse panel opens with one plain-language
  verdict and a six-row traffic-light scorecard: Location & height, Coverage,
  Ground detail, Vertical accuracy, Classification, Integrity. Each row pairs a
  metaphor icon with a shape-distinct tone glyph (check / dash / triangle, never
  colour alone), the caveats can't be hidden, and the USGS Quality Level badge
  appears only when it's actually earned — georeferenced, density above the
  floor, and accuracy validated.
- **Panel de-duplication** — each fact now has exactly one home. The scorecard is
  the headline; the assessment block carries export readiness, terrain products,
  and "Why?"; and the collapsed Details holds the single composite score plus the
  validation detail nothing else shows.

## File-scale honesty

- **The numbers describe the file, not the display sample.** Large clouds are
  strided down for rendering, so the in-memory count is a subset. The Scan Report,
  the Engineering Inspection PDF, the Provenance density, and the Layers chip now
  report the file's true point count and areal density (back-scaled from the
  sample), with a "Loaded" row disclosing the subset — a dense survey no longer
  reads as several times sparser than it really is.
- **Capture type** — dense drone surveys (UAV LiDAR, ~100–1000 pts/m² over an open
  mapping footprint) are identified as drone-mounted LiDAR rather than Terrestrial
  Laser Scan, matching the cited density literature.
- **Honest height wording** — a horizontally-georeferenced scan with an undeclared
  vertical datum (common for drone LiDAR: absolute Z, no VerticalCRS) reads
  "elevation datum not declared" rather than "heights are relative." Its heights
  are absolute; only the datum is unverified. Truly floating scans still read
  "relative."
- **Honest classification + terrain wording** — a classification dimension
  carrying no assigned classes reads "Present, unclassified" instead of a bare
  "Yes," and the Terrain Intelligence Report labels its ground-point counts
  "Ground points / Used in DTM" rather than the misreadable "Source points."

## Fixes

- The point cloud no longer clips to a square on browser zoom-out.
- Contour GeoJSON exports carry 3D coordinates (elevation) and per-feature
  evidence grades.
- Vertical units are honoured — `VerticalUnitsGeoKey` (4099) and the WKT vertical
  `UNIT` are parsed, and Z is scaled to metres for accuracy bucketing.

## Deploy & hardening

- **~1.05 MB lighter.** The brand mark and favicon are re-rastered to display size
  (the 530 KB master moves out of the shipped bundle into `design/`, kept for
  regenerating share cards), so first paint carries a fraction of the previous
  brand weight.
- **Portable hardening** — a `_headers` file ships alongside `.htaccess` so the
  same deploy is hardened on Netlify / Cloudflare Pages-style hosts, the PWA
  manifest uses relative paths + scope for subpath hosting, and
  `X-Frame-Options: SAMEORIGIN` is set.

## Under the hood

- A tested orchestration seam for the full-cloud grade (plan → coverage →
  back-scaled grade) landed ahead of its streaming surface — consistent with the
  project's "tested core first, UI follows" pattern.

These confidence figures and quality grades describe the delivered data; they are
not a survey-grade certification. Treat terrain products and exports as
deliverable-ready only when the assessment reads **Good**, and validate against
ground control where survey-grade accuracy is required.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
