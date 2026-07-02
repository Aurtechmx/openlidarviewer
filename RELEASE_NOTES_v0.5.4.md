# OpenLiDARViewer v0.5.4

A terrain-science hardening release. The "Terrain Complexity" reading is no
longer a heuristic: it is backed by two literature-defined metrics computed
from the analysed DTM — with their windows, units, a derived confidence, and
a cited density caveat carried everywhere the number appears. Still
browser-native and local-first. Nothing is uploaded.

## Complexity you can cite

The terrain core now computes the Vector Ruggedness Measure (VRM —
Sappington, Longshore & Thompson 2007, doi:10.2193/2005-723) and the
Topographic Position Index with the Weiss (2001) six-class slope position,
implemented from the primary literature (no third-party implementation was
consulted; pyTopoComplexity is AGPL prior art and was not read). Both ride
the existing Horn slope/aspect grids and run alongside the heavy core in the
worker — off the interactive path, never eagerly at scan attach.

VRM was chosen deliberately because it is slope-decoupled: a smooth 45°
plane scores ~0 ruggedness while an equally steep rough surface scores high,
so steepness is never mistaken for complexity. Surface-area and TRI-style
measures, which conflate the two, were evaluated and rejected.

Every figure states its parameters: VRM as median + IQR over a 3×3-cell
window (ground-metre size stated), dimensionless; TPI in the grid's own Z
units with the dominant landform class, over a radius reported in cells and
ground metres. The confidence is derived from data support (valid-cell
fraction × window support) — never asserted.

## Where it shows up

- **Dataset Intelligence** — the "Terrain Complexity" row is engine-fed after
  a run: the band of the real VRM median, with the numeric median + IQR,
  window and units one hover away (and in the Details panel). Until a run
  measures something the row still reads "—".
- **Analyse panel** — a compact derived-metrics line under the Terrain
  Assessment: VRM median [IQR] with its window, the dominant TPI class with
  its radius, units always stated, standard caveat treatment.
- **Reports and exports** — the terrain report and every export's provenance
  record the metric names, window/radius in cells AND ground units, Z units,
  the Horn slope/aspect convention note, the derived confidence, and the
  caveats — reproducible parameters, stamped word-for-word identically
  across README/DXF/SVG/GeoJSON/report, with the provenance-consistency
  suite pinning the new fields.

## A cited density caveat

When the scan-scaled ground density is below 4 pts/m², the complexity
outputs carry: *"point density N pts/m² is below the ≥4 pts/m² reliability
threshold reported for detailed terrain/vegetation complexity (Münzinger et
al. 2022, doi:10.1016/j.ufug.2022.127637); treat complexity as indicative."*
It is a warning, never a block — tested present at 2 pts/m² and absent at 6.

## Known limitations

- The display bands (Low / Moderate / High / Very High) are a coarse banding
  of the observed VRM range in the literature, not a standard classification
  — which is why the numeric median + IQR always accompanies the label.
- Complexity describes the analysed DTM grid: on a still-streaming scan it
  reflects the resident subset and carries that caveat; a run that measured
  nothing renders "—", never a fabricated band.
- The metrics are descriptive, not a quality judgement — a rugged site is
  not "worse" than a flat one, and the row is never coloured good/bad.

## Verify this release

```bash
npm ci
npm test          # the full unit + integration suite
npm run repro     # writes benchmarks/out/metrics.md and the reliability figures
```

`npm run repro` includes the analytic terrain-complexity checks (metric M5):
VRM on a constant 45° plane vs. an alternating rough surface with the same
face slope (slope-independence, plane median < 1e-12), and a hand-computed
TPI ridge-crest value (+5 exactly, classified `ridge`) — each with the
derived confidence envelope. Unit fixtures prove VRM is identical across
feet/metre CRSs and that TPI scales exactly with the Z unit.

The release gate for this build ran the type check, the lint guards, both
builds, the bundle budget, the post-build chunk-isolation contract, and all
five test buckets green — 4,081 tests passed (30 skipped) across 354 test
files, with the index bundle at 755 KiB against its 760 KiB ceiling (smaller
than v0.5.3: the contour serialisers and provenance builder moved to a lazy
chunk). The figure step of `npm run repro` needs Python + matplotlib; the
metrics table is written without it.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files. Host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files, 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
