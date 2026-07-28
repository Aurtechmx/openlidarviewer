# OpenLiDARViewer v0.4.7

A classification, reporting, and honesty release — derive a usable
classification for clouds that ship without one, get a clearer client PDF, and
read a grade you can trust. Still browser-native, local-first, nothing uploaded.

## Highlights

- **Classify — derive a classification for unclassified clouds** — a one-click
  action assigns a coarse, ASPRS-aligned class (ground, low/medium/high
  vegetation, building) to scans that carry no classification channel — raw XYZ,
  photogrammetry, unclassified LAS. It runs a progressive morphological
  ground filter, builds a bare-earth surface, measures height-above-ground and
  local roughness, and labels each point from those geometry cues. It runs off
  the main thread with live progress, and the result feeds the Classes legend,
  the colour-by-class mode, GPU class filtering, and exports. It is a **heuristic,
  not a producer's classification** — the legend, the toasts, and the export
  provenance all say so, and it is always tagged "derived" so it can never be
  mistaken for survey-grade.
- **Inspection summary in every PDF report** — each template opens with a
  synthesised findings card: a headline capture type and scale, scannable
  findings tiered by status, a point-density read, and an explicit list of what
  the report does **not** establish. The density-tier call only invokes the USGS
  QL bands when they actually apply to the capture; vertical accuracy that
  wasn't measured stays unmeasured.
- **Honest preview grading** — a surface-quality score computed on a partial or
  still-streaming sample now reads as provisional (`Preview · ~57/100`) in both
  the headline verdict and the detailed score, so a complete, good file no longer
  shows a low preview number as if it were the file's grade. A streaming COPC
  that finishes streaming in now earns a real grade instead of being capped at
  "Preview" forever.
- **Colourblind-safe classification palette** — a toggle in the Classes panel
  recolours the classes with an Okabe-Ito categorical palette so ground,
  vegetation, buildings, and water stay distinguishable under the common
  colour-vision deficiencies. The class label and count stay on every row, so
  colour is never the only cue.
- **Workflow recorder returns** — record a sequence of camera moves and tool
  actions and replay it on the same scan. A settings popup tunes the file format
  (readable / compact), the save destination (download or a native save-as
  dialog), the start/stop shortcut, replay speed (0.5× / 1× / 2× / instant), a
  pre-record countdown, which action families are captured, and loop replay. It
  records actions only — never scan data — so a recipient needs the same scan
  open to replay it.
- **Annotation grouping** — the Annotations panel and the PDF report open with a
  one-line summary of the notes: totals, the per-category breakdown (notes /
  info / warnings / issues), and how many areas they fall across, so a dense set
  reads at a glance.

## Reporting & analysis

- The PDF dataset summary discloses how much of a streaming COPC/EPT scan was
  actually resident at export time — a "Loaded" row reading, e.g.,
  `4.2M of 15.7M pts (27%) — streaming preview` — so a mid-stream report is never
  read as covering the whole cloud.
- Cross-section profiles export as a real vector chart in the PDF with a
  vertical-exaggeration disclosure, station chainage, and slope summary; the 3D
  scene marks each station.
- Metric labels are disambiguated so two different things never share a name:
  scan scope (full / resident / sampled) reads as **"Scan scope"** instead of
  colliding with the measured **"Coverage"** figure, and the readiness card's
  measured fraction reads as **"Measured coverage"** instead of clashing with the
  composite **"DTM quality"** score.
- The Classes legend discloses that streaming per-class counts are a running
  tally over decoded nodes, not full-file totals.
- The deep "All metrics" breakdown is collapsed by default; the decisive chips
  carry the headline.
- Below-grade surfaces are described by fitness-for-use ("usable for inspection
  and measurement, not yet for terrain-product export") rather than a
  deliverable / non-deliverable binary.

## Viewer

- A freshly opened scan frames to its full extent (extent-aware fit), centred and
  a little larger, so it reads on first open without a manual zoom.
- The Rendering panel shows the point size in pixels and defaults to adaptive
  sizing.
- The Classes panel widened so class names don't truncate.
- An honesty cue on the Dataset Intelligence card: a quiet coloured dot marks
  each row's qualitative tier; terrain complexity stays neutral (it is
  descriptive, not a quality), and a missing signal is muted to match the `—`.

## Correctness & honesty fixes

- The ASPRS class table is complete through codes 0–22 (Reserved, Overlap,
  Overhead structure, Ignored ground, Snow, Temporal exclusion), in both the
  point readout and the colour palettes.
- Loading a second scan adds it as a separate layer again, rather than replacing
  the first — restoring multi-scan loading.
- Empty files are rejected with a clear message instead of opening a blank,
  unframable scene.
- Reprojection never ships non-finite coordinates — a transform outside the
  target projection's valid area fails honestly and leaves the source untouched.
- NAD83 against the WGS84-coincident datum family is flagged as an identity
  shift (~1–2 m), alongside the existing NAD27 and GDA94↔GDA2020 caveats.
- A measured area reads the same in the PDF report as on screen.
- Unknown point density shows `—` rather than a fabricated "Sparse".
- Streaming sources close their reader on detach; the colour-recompute timer is
  cleared on teardown.
- A worker-fallback diagnostic no longer claims "fell back to main thread"
  before the safety check that can refuse the fallback — the log now states only
  what actually happened.

## Under the hood

- A performance pass across the load, streaming, and analysis paths to keep the
  browser responsive on large clouds.
- The unit test suite is split into four coverage-complete buckets
  (`test:unit` / `test:terrain` / `test:ui` / `test:slow`) that always union to
  the whole suite, so it can run in parallel.
- Packaging now verifies every release archive (`unzip -t`) and fails rather than
  shipping a truncated or corrupt zip, and a bundle-budget check guards the
  shipped build against silent size growth.

Measurement, derived classification, and the floor-plan preview are for visual
inspection and research, not survey-grade use. Treat any output as survey-grade
only after validating it against survey-grade data and procedures.

See [CHANGELOG.md](./CHANGELOG.md) for the full list.

## Deploy

Static files — host anywhere (GitHub Pages, Netlify, any CDN). The deploy zip
extracts with web-safe permissions (644 files / 755 directories) and carries
`index.html` plus `assets/` at the archive root.
