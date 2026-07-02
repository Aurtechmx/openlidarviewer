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

## Correctness and honesty fixes

This release also lands a set of data-correctness fixes, each pinned by a
hand-computed regression test, and a set of labelling corrections where a
number was computed correctly but described too strongly. The math behind
the second group is unchanged — the labels now say exactly what is measured.

Data correctness:

- **EPT decoding** — 8-byte dimensions decode by their declared type
  (int64/uint64 included) instead of being read as Float64, and 16-bit RGB
  channels that actually carry 8-bit values are detected once per dataset
  (the same handling COPC already had), so those clouds no longer render
  black or split colour depth across tiles.
- **E57 multi-scan merges** — a scan without Cartesian X/Y/Z (for example a
  spherical-only scan) is now skipped cleanly: no phantom points at the
  origin, honest point counts and bounds, and a load warning in the Scan
  Report that names the skipped scan. Normals now rotate with each scan's
  pose, and malformed pose quaternions are normalised (or replaced by the
  identity) with a warning instead of silently distorting geometry.
- **Contours** — when an interval produces more levels than the cap, the
  levels are thinned evenly so the lowest AND highest contours survive
  (previously everything above the cap was dropped — summits vanished), and
  saddle cells are resolved with the exact bilinear rule, fixing mislinked
  contour topology around asymmetric ridges and cols.

Honest labels:

- Vertical-accuracy figures are labelled **NVA-style / VVA-style (hold-out)**
  with tooltips stating they come from internally withheld points via the
  ASPRS 2014 formulas — not independent survey checkpoints — and the USGS
  3DEP Quality Level chip and provenance stamp now read **"(estimated)"**.
- The stockpile volume band prints **"± N m³ (1σ)"** explicitly and carries a
  spatial-correlation caveat; the change-detection **"detectable"** verdict
  now requires the ~95% level of detection (1.96σ), matching the module's own
  LoD convention.
- The confidence check formerly called "calibration" is now the
  **confidence-ordering check** (the genuine isotonic calibration keeps its
  name), the measured polygon area is described as the **vector (Newell)
  area** rather than "true surface area", and geographic scans analysed
  without a known latitude now warn that east–west scaling is uncorrected.

## Declared source metadata, and an honest inspection PDF

Some files say what they are. A metadata-rich E57 can declare its creator,
licence, coordinate conventions, sensor fields, and even a custom
extension-namespace block — and until now the viewer surfaced almost none of
it, while the Engineering Inspection PDF confidently labelled such a scan
"Drone-mounted LiDAR (UAV ALS)" from density heuristics alone. This release
makes the file's own voice the primary source:

- **E57 declared metadata is captured end to end** — the standard root and
  per-scan provenance fields (guid, library version, creation time,
  coordinate metadata, sensor vendor / model / serial, acquisition times,
  environment readings, intensity/colour limits) plus any
  extension-namespace String/Integer/Float fields (any prefix), in document
  order with their namespace URI. Only *declared* values appear: the E57
  empty-element defaults (zero timestamps, blank strings) are omitted, never
  displayed as fabricated zeros, and malformed metadata degrades to omission
  with a load warning rather than a failed load.
- **The Inspector shows it** in a collapsible "Source metadata" section
  (with an "Extended metadata (file-declared)" subsection), and **the
  Engineering Inspection PDF gains a "Declared source metadata" section** —
  both verbatim, both under the disclosure *declared by the file, not
  verified by OpenLiDARViewer*, both absent when nothing is declared.
- **The capture-type verdict yields to the file.** When the declared
  metadata states a synthetic / procedural / reconstruction / reference
  origin, the verdict becomes "Declared: <value> (from file metadata)" and
  the density heuristic is demoted to a secondary, low-confidence line — no
  literature accuracy ribbon is attached to a source those citations do not
  describe. Files that declare nothing classify exactly as before.

The inspection PDF also had four rendering defects, all fixed and pinned by
a content-stream-parsing layout test: a page-1 overlap where a failed
provenance section let later headings draw over already-rendered text (a
citation glyph outside WinAnsi was the trigger; failed sections now also
resume on a fresh page as defence in depth); section-heading underlines that
stopped after the first few characters (now the measured text width); ASCII
fallbacks where WinAnsi has the real glyph (m² / — / 1.96 × now print as
themselves); and a pagination rule that could orphan a heading or leave a
near-empty trailing page (small sections now keep-with-next).

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
five test buckets green — 4,162 tests passed (30 skipped) across 360 test
files, with the index bundle at 755 KiB against its 760 KiB ceiling (the
declared-metadata keyword scan and its wording live in the lazy loader
chunk, so the startup shell stayed flat). The figure step of `npm run
repro` needs Python + matplotlib; the metrics table is written without it.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files. Host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files, 755 directories) and carries
`index.html` plus `assets/` at the archive root, along with `.htaccess` and
`_headers` for host-side security headers.
