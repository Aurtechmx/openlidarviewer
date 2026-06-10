# Changelog

The format is based on Keep a Changelog and the project follows Semantic Versioning.

## [0.4.4] - 2026-06-09

Final release. Sections below fold in the post-audit hardening batch.

### Added

- Dropping several files at once now says what happened: the first file opens
  as before, and a toast names it and reports how many companions were
  ignored, pointing at the batch converter — instead of silently discarding
  everything past the first file.

- The batch converter can write LAS 1.4 (point data record formats 6/7), and
  it is now the default output format. The extended records carry the full
  8-bit classification, so classes above 31 — class 64, vendor codes up to
  255 — survive conversion intact where LAS 1.2's 5-bit field destroyed them
  (the audit defect). Format 7 is picked automatically when the cloud has
  colour (RGB upscaled 8→16 bit losslessly), format 6 otherwise; up to 15
  returns are tallied into the extended uint64 by-return counts. When the
  source carries a WKT CRS and coordinates are kept, the WKT travels into the
  1.4 file with the global-encoding WKT bit set (as the spec requires for
  formats 6+); when only an EPSG is known, the GeoKey tag is written instead
  and the log says so. These extended records are also what COPC requires, so
  this writer is the foundation for future COPC output.

### Changed

- The previous LAS output is now labelled "LAS 1.2" (next to "LAS 1.4") so the
  version choice is explicit, and it warns per file — instead of staying
  silent — when its 5-bit classification field clamps classes above 31,
  pointing at LAS 1.4 as the lossless choice.
- The Export panel now defaults to LAS 1.4, matching the batch converter's
  recommended format instead of pre-selecting the lossy LAS 1.2 legacy choice.
- Faint UI text (`--text-faint`) is lighter in the dark theme and darker in
  the light theme so hints, captions and placeholders clear WCAG AA contrast;
  the high-contrast theme already passed and is unchanged.
- The tool dock's toggle buttons (Measure, Inspect, Probe, Annotate, Analyse)
  keep a stable label and expose their on/off state through `aria-pressed`
  instead of swapping to "Measuring…"-style text — screen readers now hear
  the toggle state, and the dock no longer shifts layout on every toggle.
- The synchronous main-thread terrain fallback (used only when the analysis
  worker fails) now has a 1 M-point ceiling. Every production caller strides
  the analysis sample to ≤ 300 000 points, so the ceiling never fires today —
  it protects future full-resolution callers from a silent main-thread freeze
  by failing with a clear message instead.

### Fixed

- The Dataset Intelligence card — and every provenance stamp fed from the same
  constant: terrain reports, DEM-package READMEs, contour exports, space
  reports — no longer claims "Metric Version v0.4.1". The shared
  `TERRAIN_METRIC_VERSION` was not bumped when 0.4.4 changed the metric
  definitions (the aspect north–south mirror fix, cell-centre contour
  registration, and the compound-WKT horizontal-unit fix all change what the
  metrics report for the same cloud); it now reads v0.4.4 and its doc comment
  records why.
- The Dataset Intelligence card's "Analyzed Points" row no longer reads "0"
  forever on streamed COPC / EPT scans. The attach-time summary honestly
  starts at 0 (nothing analysed yet), but nothing ever updated it; a finished
  terrain run now folds its real analysed-point count — the same
  `dtm.analyzedPointCount` the terrain report's "Analysed points" row prints —
  back into the card, so the card and the PDF agree.
- The Help overlay's shortcut list no longer drifts from the actual bindings:
  it now lists the T / O / P camera presets, L (lasso volume), H (controls
  HUD) and Cmd/Ctrl-K (command palette), and the `?` entry says what `?`
  really does — open the keyboard shortcut sheet, which owns that key.
- Load-status announcements for screen readers now come from two permanently
  rendered, visually hidden live regions (polite status + assertive alert)
  instead of the toast itself — a toast hidden with `display:none` leaves the
  accessibility tree, so its announcements fired unreliably or not at all.
- The `?debug=1` overlay's frame stats now include streamed COPC / EPT
  clouds: resident points fold into the displayed count and GPU byte
  estimate, and the source's total point count folds into the total —
  previously a streamed scan reported zero points while clearly on screen.
- Contour exports from a streamed COPC / EPT scan keep their world origin
  and EPSG stamp: the map context now falls back to the streaming source's
  render origin and CRS when no static cloud is active, instead of silently
  degrading to a local frame.
- The scalar sRGB → linear EOTF copies in the photometric patch view and the
  colour-provenance card now delegate to the shared seam in `colorEncode.ts`,
  so the curve can no longer drift from what the GPU pipeline applies.
- Eye Dome Lighting obscurance is no longer computed in the wrong depth space.
  The renderer draws with a logarithmic depth buffer, but the EDL pass was
  inverting its depth samples with the standard perspective formula
  (`perspectiveDepthToViewZ`) — decoding log-encoded values as if they were
  perspective depth, so the depth cue read far too weak up close and erratic
  at range, silently defeating the unit-tested EDL maths. The pass now applies
  the matching logarithmic inversion,
  `eyeDist = near′ · 2^(depth · log2(far / near′))` with `near′ = max(near,
  1e-6)` — the exact inverse of three.js's near-anchored log-depth encoding on
  both the WebGPU backend and the WebGL 2 fallback — and keeps the perspective
  path for a renderer built without log depth. The depth mode is read back off
  the renderer at construction rather than assumed, and the inversion is
  pinned CPU-side by new unit tests (`logDepthToEyeDistance` in `edl.ts`),
  following the same mirrored-math pattern as the splat shader.
- Clicking Cancel on an in-flight "Open from URL" load no longer instantly
  restarts the very load it just aborted. The cancel handler flipped the
  button back to `type="submit"` while the click event was still
  dispatching, so the browser evaluated the click's default action against
  the new type and re-submitted the form — Cancel aborted the stream and
  then immediately kicked off the same request again. The handler now
  suppresses the click's default action before cancelling, so Cancel means
  cancel.

### Notes

- New regression tests pin provenance consistency across every exporter — the
  DEM README, contour GeoJSON / DXF / SVG, map-sheet PDF and terrain report
  are driven from one analysis run and must agree word-for-word on the
  surface-quality and export-readiness verdicts, CRS, datum, accuracy and
  software stamps — and pin the terrain-core fallback's stale-result
  (abort-during-worker-failure) and oversize (`MAX_FALLBACK_POINTS`) guards.
- A static-analysis guard now pins every `unsafeHtml` call site to a
  hand-reviewed allowlist — all seven current sites carry only literal SVG
  icons or chart markup composed from numeric inputs — and fails on any new
  site, any stale entry, or any argument naming user-shaped data (scan / file
  / dataset names, URL params, message payloads), so the `innerHTML` escape
  hatch in `dom.ts` cannot silently regress into an XSS sink.

### Earlier in this release

A correctness and hardening release driven by a full-codebase audit. Every fix
below was verified against the v0.4.3 source before being applied.

### Fixed — survey-output correctness

- The point Inspector no longer applies the world origin twice. World
  coordinates, and the Geographic / UTM rows derived from them, were shifted by
  a full extra origin (e.g. ~+500 000 E / +4 500 000 N on a UTM scan). The
  card now shows the true World position, and a separate Local group (renderer
  frame) only when an origin exists.
- Contour vector exports (GeoJSON, DXF, SVG) are now georeferenced. They
  previously wrote origin-recentred local coordinates while stamping a real
  EPSG CRS, landing hundreds of kilometres from truth in GIS software; contour
  elevation values were offset by the vertical origin as well. Exports now
  shift geometry and levels to world coordinates — and when no origin is
  available, the EPSG stamp is omitted and a "local frame" warning is attached
  instead of claiming a CRS.
- Horizontal linear units are read from the horizontal CRS only. A compound
  WKT (projected + vertical) in US survey feet was previously measured as
  metres because the vertical axis's UNIT won the scan (~3.28× error in every
  derived measure).
- Aspect (and therefore hillshade lighting) is no longer mirrored north–south
  on the northing-up analysis grids; a north-facing slope now reports north,
  and the default 315° sun lights from the northwest as labelled.
- Contours are registered to cell centres, removing a systematic half-cell
  southwest shift relative to the exported DEM GeoTIFF of the same surface.

### Fixed — stability and behaviour

- Malformed or hostile files can no longer trigger runaway allocations: LAZ,
  COPC, EPT and E57 decoders now validate file-declared point/record counts
  against the actual bytes available before allocating (a shared
  `validateDeclaredPointCount` guard), failing with a typed malformed-file error.
- Recoloring after the initial upload (color-mode switches, coverage grids,
  height trims, classification edits, streaming recolors) now applies the same
  sRGB→linear conversion as the first upload, through one shared seam —
  switching Elevation → RGB no longer washes out the cloud.
- Removing a cloud releases its classification and selection snapshots
  (previously retained for the session — up to ~5 MB per edited scan).
- The URL field's Cancel button actually cancels the in-flight download (the
  abort signal is now threaded through to the loader), and submitting an empty
  URL explains what is expected instead of silently doing nothing.
- Concurrent open requests are rejected race-free (the loading flag is set
  synchronously), with a toast — "Already loading — cancel the current load
  first." — instead of silence.
- Pressing `I` no longer fires the Inspect tool and the Iso camera preset on
  the same keystroke: bare `I` belongs to Inspect (as the help advertises);
  the Iso preset remains on the view chips and command palette. All bare-key
  handlers now honour and set `defaultPrevented` so collisions cannot recur.
- Panel-width persistence no longer throws (and blocks boot) when browser
  storage is unavailable; all storage access goes through one guarded helper.

### Added

- Load progress, errors, and toasts are announced to screen readers
  (`role="status"` / `role="alert"` with polite live regions).
- Share metadata (Open Graph / Twitter card), an SVG favicon, an
  apple-touch-icon link, and a web app manifest.
- A commented production `.htaccess` (long-lived immutable caching for hashed
  assets, HSTS, nosniff, referrer and permissions policies, WASM MIME type,
  and a Content-Security-Policy draft in report-only form for testing).

### Notes

- Aspect/hillshade truth-test fixtures that encoded the mirrored convention
  were corrected alongside the fix; new regression tests cover the Inspector
  origin, contour world-origin shift, compound-WKT units, cell-centre
  registration, and the decoder allocation guards.

## [0.4.3] - 2026-06-09

### Added

- Manual scan-type override: a "Treat as" control (Auto / Terrain / Object /
  Interior) in both the terrain Analyse panel and the Space / Object panel lets
  you correct a misjudged scan in one click. A non-auto choice takes precedence
  over auto-detection, stays pinned while the cloud streams in, and resets to
  Auto on each new scan. Metrics are still computed honestly for the chosen
  type; the panel notes when the type was set manually.

### Changed

- Export provenance is unified: GeoJSON, DXF, SVG, the printable map sheet, and
  the DEM package now all stamp the same provenance, derived once from the run —
  software and metric version, date, source, CRS, vertical datum, coverage,
  contour interval and style, Surface Quality and Export Readiness (with the
  reason), and the measured accuracy (RMSEz / NVA / VVA / USGS Quality Level) —
  so no two exported artifacts can disagree, and every one carries the
  not-survey-grade note.
- Scan-type detection re-evaluates once the streaming cloud has fully settled
  ("Streaming ready"), so a type decided on a sparse early frame (which could
  misread a 360 / interior scan) is corrected on the representative geometry.

### Fixed

- Terrain density and slope now respect the scan's real horizontal units. On a
  foot-based projected coordinate system, ground density is reported as genuine
  points per square metre (previously it was measured in square feet but
  labelled per square metre, understating density by ~10.8×) and the slope used
  for surface-quality checks is computed over a metre run. Metric (metre) data
  is unchanged. This matches the existing handling of the vertical axis.
- A surface rated "Limited" now states a Limited reason instead of borrowing the
  preview-tier wording, and the "% of the surface is interpolated" figure is
  consistent everywhere it appears — it always means the share of the captured
  surface that is interpolated rather than measured, no longer diluted by empty
  cells in some views.
- Export honesty wording is tighter: a georeferencing gap (unknown CRS / datum)
  is only listed as an export reason when it actually holds the export back
  below the surface quality, and when a surface is both below grade AND not
  georeferenced the export reason now names both, rather than only the
  coordinate-system gap.
- The Space / Object report now respects the scan's real horizontal units, so
  dimensions, area, and volume read correctly (and convert correctly between
  metres and feet) for foot-based and other non-metre coordinate systems
  instead of assuming metres.
- Interior floor / ceiling / storey detection is more robust: floor and ceiling
  planes are found from density-weighted height peaks (so a cluttered floor or a
  sparsely captured ceiling is still detected), and a second storey is only
  counted when there is a real floor-to-floor gap with mass between the levels —
  it stays clearly labelled as approximate.

## [0.4.2] - 2026-06-05

### Added

- Classification legend: a "Classes" panel lists one row per ASPRS class
  actually present in the loaded scan, each with the renderer's class colour
  swatch, the class name, and a live count of the points currently shown — so
  the legend reads as the true colour key for the view, not a static table.
- Per-class show/hide, isolate, and show-all: untick a class to drop it from
  the view, use "Solo" to isolate a single class, and "Show all" to bring
  everything back. A persistent "Filtered — showing N of M classes" banner
  stays up the whole time a filter is active, so a partial view can never be
  mistaken for the full cloud. Picking and inspection honour the filter too —
  you can only pick points in the classes you can see.
- Metrics follow the visible classes: when classes are hidden, the scan
  report recomputes over just the visible subset (ground, density, coverage,
  and the rest), and every filtered readout is stamped with the class scope it
  was measured under, so no filtered number is ever shown unqualified. Clearing
  the filter restores the full-cloud figures and removes the stamps.
- Streaming header metrics that can't be re-derived from the resident view are
  shown for the full cloud and clearly labelled "not class-scoped", rather than
  silently mixing a full-cloud figure into an otherwise filtered report.
- Filtered exports carry their scope: copied points, the PDF report, and the
  image and snapshot exports are all stamped with the active class filter, so a
  filtered artifact is self-describing — anyone opening it later can see exactly
  which classes it represents.
- Contour map PDF, pre-export dialog: the MAP PDF action now opens a dialog to
  set the title, "prepared by", a free Project / Notes block, the sheet size and
  orientation, the final contour interval, and the output filename — each
  pre-filled with a sensible default from the scan. A re-picked interval
  regenerates the contours from the already-computed surface (no re-analysis).
  The measured fields (CRS, vertical datum, scale, NVA / VVA / RMSEz, USGS
  Quality Level, date) are shown read-only and stay computed from the scan, so a
  deliverable can be titled and described freely without ever hand-editing the
  accuracy figures.
- Interface polish: a consistent button system across the app with clearer
  primary actions, accessible focus rings, and an obvious, rotating expand /
  collapse chevron on the collapsible panel headers (Analyse, Export / Convert).
- Contour shape style, selectable on export: a "Contour style" picker (in the
  Analyse export section and the map-PDF dialog) chooses how the contour lines
  are shaped — As measured (crisp), Smooth, Rounded, Generalized, or
  Semi-geometric — and applies to every contour export (PDF, SVG, DXF, GeoJSON).
  Smoothing stays honesty-gated: it never moves a low-confidence vertex or
  bridges a data gap, so a dashed / uncertain run can't be reshaped into a
  confident line, and each exported file is stamped with the style it was made
  with. The on-screen contours are unchanged (the default matches the previous
  smoothing).
- Non-terrain scan detection: indoor / 360 / phone-LiDAR room and object scans
  are now recognised as non-terrain (a floor-plus-ceiling enclosure, or a
  compact object) instead of being pushed through the terrain contour pipeline,
  which is a category error for them. Such scans get a Space / Object report —
  overall dimensions (L x W x H, in metres and feet), floor area, ceiling
  height, enclosed volume, floor / wall / ceiling plane detection, storey count,
  and a capture-quality block (point count, density, coverage, RGB) — with the
  same honesty caveats as terrain (figures are based on the loaded / streamed
  data, ceilings are often sparsely captured, nothing is survey-certified).
  Terrain contour analysis stays one click away for any scan. Object scans get a
  matching report at the same depth — oriented and axis-aligned dimensions
  (metres and feet), largest dimension, bounding-envelope volume (m³ and ft³),
  an approximate bounding-box surface area, and the same capture-quality block —
  with the figures honestly labelled as bounding envelopes, not solid or mesh
  measurements. Scan-type detection is more robust: an interior is recognised
  from its floor plus wall / floor-to-ceiling columns (so a real multi-room or
  360 house with a partial, occluded ceiling is no longer mistaken for terrain),
  and when a scan carries classification a vegetation-dominated canopy keeps a
  forested drone scan as terrain rather than reading the canopy as a ceiling.
  Streaming scans re-evaluate their type as more of the cloud arrives.
- Contour export, simplified: the redundant contour-interval picker and the
  contour-style selector were removed from the Analyse panel — both are now
  chosen in the export dialog — and the "MAP PDF" button is renamed
  "Export Contours" to read as the primary contour-deliverable action.

### Changed

- Terrain DTM now aggregates each grid cell by the MEDIAN of its ground returns
  instead of the arithmetic mean. The median (50% breakdown point) is resistant
  to outliers: a single high return (vegetation, a parked vehicle) or low return
  (multipath) in a cell no longer pulls the cell's elevation, so the bare-earth
  surface tracks the true ground more faithfully. This changes elevation values
  in cells that previously had a skewed mix of returns. The hold-out RMSE
  validation rebuilds its DTM with the same median aggregation, so the reported
  accuracy continues to measure the surface that ships, and the DEM export
  README's "Generation parameters" now records the cell aggregation used.
- Terrain quality is now reported on TWO independent axes instead of one
  conflated verdict: **Surface Quality** (is the terrain surface internally
  valid?) and **Export Readiness** (is it georeferenced enough to hand off?).
  Surface Quality is derived purely from surface metrics (coverage,
  interpolation, edge risk, density, ground visibility, hold-out RMSE) and is
  INDEPENDENT of the coordinate system and vertical datum — a dense, clean,
  well-covered scan with an unknown datum now reads as a good surface. Export
  Readiness equals Surface Quality further gated by georeferencing: an unknown
  CRS or vertical datum caps it to "preview" (with an explicit reason such as
  "vertical datum unknown"), even when the surface itself is good. The Analyse
  panel shows both axes; DEM and contour/map exports key off Export Readiness;
  and the DEM/map deliverables still carry their preliminary caveat whenever the
  georeferenced hand-off is not export-ready. The honesty contract is unchanged
  — an unknown datum still blocks an export-ready verdict and nothing claims
  survey-grade.

## [0.4.1] - 2026-06-04

### Added

- Terrain Assessment: a single top-level verdict — Good / Preview / Limited —
  at the top of the Analyse panel, with the 0–100 terrain quality score folded
  into the headline (e.g. "Preview · 64/100"), a one-line reason, what the
  surface is best for, and a caution where relevant. The detailed metrics
  (quality breakdown, coverage, confidence, RMSE, NVA/VVA, readiness,
  recommended grid) now sit behind a collapsed "Details" expander, so a
  non-specialist reads the bottom line first and drills in only on demand. The
  verdict speaks to data quality and fitness-for-use — it does not claim
  survey-grade or survey-certified output.
- DEM export: a one-click "DEM (ZIP)" button in the Analyse panel downloads the
  elevation rasters — bare-earth DTM, top-surface DSM, and canopy height (CHM) —
  each as both an Esri ASCII Grid (.asc) and a georeferenced Float32 GeoTIFF
  (.tif), with a .prj CRS sidecar when known and a metadata README (CRS,
  vertical datum, cell size, units, RMSEz / NVA / VVA, USGS Quality Level, and
  coverage). GeoTIFF carries its CRS by EPSG GeoKeys and a north-up
  ModelTiepoint, so it drops straight into QGIS / ArcGIS / GDAL. The raster
  writers ride a lazy chunk, and the export stays available even when the
  contour quality gate would block the vector exports.
- An "Analyse" button in the tool dock toggles the terrain analysis panel, so
  it can always be re-opened after it's closed — including when selecting the
  Profile tool tucks it away, or when an object scan demotes it behind the
  Object panel. On phones it lives in the dock's "More" (•••) menu, and the
  bottom-centre navigation control always stays clickable where the two meet.
- Multi-directional relief: the Analyse panel's hillshade is now a soft
  multi-directional shaded relief by default, with a toggle to a single sun and
  an adjustable sun azimuth and altitude. Re-lighting is instant — it reuses the
  cached slope/aspect grids — and the current relief exports as a PNG.
- Click-to-sample: clicking any analysed preview raster (relief or canopy)
  reports the bare-earth elevation, slope, and above-ground height at that cell,
  turning the static surface into a point-query tool. The sampled point is
  marked with a crosshair, the readout is announced to screen readers, and the
  relief tile carries a shaded-relief legend and clearer sun-off state.
- Canopy Height Model (CHM): the Analyse panel now renders above-ground height
  (DSM − DTM) as its own north-up preview on a green canopy ramp with a height
  legend, exportable as a print-resolution PNG — alongside the hillshade, which
  shares the same preview/export controls.
- Bare-earth elevation histogram: a compact distribution of the DTM's ground
  elevations in the Analyse panel, with the value range and cell count, for a
  quick read of the terrain's hypsometry.
- Distance measurements now report a compass bearing (zero-padded azimuth,
  e.g. "15.2 m · 042°") alongside the length; purely vertical pairs show length
  only. Bearing is measured in the map plane and handles non-Z-up scans.
- Typography refresh: the interface now uses Manrope for text and JetBrains
  Mono for figures and labels (both self-hosted, no external font requests),
  and the data panels render tabular figures so columns of numbers line up.
- Cross-section profile chart, professional numbers pass: the elevation axis
  now labels rounded "nice" values (e.g. 120 · 125 · 130) with matching
  gridlines instead of the raw min/max, and every numeral renders in JetBrains
  Mono with tabular figures from a positioned overlay — so the axis text no
  longer inherits the chart's horizontal stretch and reads crisply at any
  chart height. Units are spaced (e.g. "120 m") and decimals are consistent.
- Selecting the Profile measurement now clears the Analyse panel and brings
  the Measurements panel forward automatically, so the cross-section chart has
  room and the workflow focus is unambiguous.
- Readiness cards redesigned: ground confidence, DTM quality and contour
  readiness now read as a row each — the label and supporting line on the
  left, a large figure with its unit and a colour-coded rating pill on the
  right — so the headline number and its rating are scannable at a glance.

- Point cloud format converter: batch-convert files from the start screen, plus
  an in-project Export panel. Reads LAS, LAZ, XYZ and ASC; writes LAS, XYZ and
  ASC with a CRS assign or reproject step and an optional full-resolution pass.
- Vertical datum detection from LAS GeoTIFF / WKT, and LAS RGB reading so colour
  point clouds now display in colour. Wider reprojection CRS coverage.
- Terrain quality: a 0–100 quality score (surfaced in the Analyse panel) built
  from per-cell density, completeness and edge metrics, outlier-rejection DTM
  hardening, and hold-out RMSE stratified by slope and surface zone.
- DTM extrapolation guard: a filled cell whose supporting ground data lies only
  on one side is an extrapolation, not a bracketed interpolation, so its
  confidence is now demoted toward dashed/gap rather than reading as trusted.
  The guard scans eight rays and measures the angular spread of nearby data; a
  cell whose support is confined to an arc under 180° is treated as one-sided.
- Surface models in the Analyse panel: a top-surface DSM with above-ground
  height (canopy and structures), slope, and an exportable hillshade preview.
- Unit-correct terrain analysis: slope, roughness and hillshade convert
  geographic (degree) grids to metres, and the hold-out RMSE and quality score
  are reported in metres for foot-based CRSs.
- The Measurements panel is now width-resizable (drag the south-east handle)
  so the cross-section profile chart can be widened to read; the chosen width
  is remembered. The hillshade preview also exports at full resolution (~2048
  px) instead of the raw grid size.
- Cross-section profiles honour classification: when the cloud carries ASPRS
  classes, vegetation / building / noise returns are dropped before the
  bare-earth percentile, so trees no longer pull the profile floor up.
- Object-scan detection now finds the up axis from geometry (handles Y-up
  phone / glTF scans), instead of assuming Z-up.
- Object scans get object analysis: a scan that reads as a compact 3-D object
  (a phone scan of a sculpture, a chair, a room) is detected from its geometry,
  and an Object panel surfaces the right measurements — oriented dimensions
  (L×W×H), envelope volume, scan resolution, and capture completeness — instead
  of misleading contours. Terrain analysis stays one click away ("run anyway").
- Splash reorganized for clarity: the primary Open button now sits beside a
  peer Convert chip, and the location picker, location search and streaming demo
  are consolidated into one "Explore public LiDAR" card.
- Performance: the 2D tool overlays (measure / inspect / annotate) are
  re-projected only on rendered frames rather than every animation frame, so a
  static scene no longer does continuous overlay DOM work — lower idle CPU.
- Printable map-sheet PDF — a field deliverable: contours rendered as a framed
  map with a UTM coordinate graticule, scale bar, north arrow, a legend keying
  the line types, and a title block carrying the CRS, vertical datum, scale, and
  the NVA / VVA / USGS Quality Level accuracy with a survey-grade / preview note.
- Geodesic (surface-aware) void interpolation: empty DTM cells are filled by
  inverse-distance weighting along the terrain surface rather than in a
  straight line, so a gap in a valley is no longer filled from across a ridge —
  more accurate bare-earth heights near breaklines.
- DEM accuracy in survey standards: the Analyse panel reports NVA (95%
  confidence = RMSEz × 1.96), VVA (95th-percentile vegetated accuracy), and the
  USGS 3DEP Quality Level (QL0–QL3) the surface meets on point density and
  RMSEz together.
- Classification-aware contours: when the cloud carries ASPRS classification
  (from the file or the lasso editor), vegetation, building and noise returns
  are dropped before ground filtering so the bare-earth surface and contours
  can't anchor to canopy or rooftops. Above-ground height still uses the full
  cloud. The ground filter's slope-scaled tolerance is also capped so steep
  terrain can't admit low buildings or vehicles as ground.

## [0.4.0] - 2026-06-03

### Added

- Terrain analysis (preview): a confidence-aware DTM and contour pipeline with
  a mounted Analyse panel. Classifies ground, validates the surface, gates a
  professional export behind quality (CRS, vertical datum, coverage), and
  exports evidence-graded contours as GeoJSON, SVG, and DXF.
- Cross-section profiles export a full-page, scaled PDF with a
  station / elevation / grade table and civil summary.

### Fixed

- Long measurement readings and dataset/layer names no longer overflow their
  panels.

## [0.3.10] - 2026-06-02

Browser-based LiDAR and point-cloud viewer. Loads LAS, LAZ, E57, PLY, PCD,
PTS, PTX and streams COPC, EPT, and 3D Tiles, entirely client-side on WebGPU
with a WebGL2 fallback. Includes measurement, annotation, classification,
cross-section profiles, volume, PDF reporting, and image export.
