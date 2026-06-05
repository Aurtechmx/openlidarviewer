# Changelog

The format is based on Keep a Changelog and the project follows Semantic Versioning.

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
