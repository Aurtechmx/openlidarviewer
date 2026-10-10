# Terrain Intelligence

This document describes the Terrain Intelligence stack under `src/terrain/`.
It centres on the confidence-aware DTM and contour pipeline (added in
v0.4.0): ground classification, a gridded DTM with per-cell confidence,
hold-out validation with confidence calibration, surface models, and
evidence-graded contour export. Two supporting pieces sit alongside it: a
small set of shared type contracts (`TerrainContracts.ts`) and the
informational Dataset Intelligence card (`datasetIntelligence.ts`).

Current capability. The Analyse panel (`src/ui/AnalysePanel.ts`) is
mounted and surfaces the confidence-aware pipeline end to end. It is
reachable any time via the "Analyse" tool-dock button and renders, top to
bottom:

- a single top-level Terrain Assessment with two axes, Surface
  Quality (Good / Preview / Limited / Blocked) and Export Readiness
  (Ready / Preview / Blocked); a folded 0 to 100 quality score, a one-line
  reason, and a short list of supporting metrics;
- readiness indicators, coverage mode, and per-cell confidence;
- surface models: DSM (digital surface model), canopy height (CHM),
  slope, and a multi-directional hillshade with an adjustable sun and
  click-to-sample;
- exports: evidence-graded contours (GeoJSON / SVG / DXF), a printable
  map sheet, and a georeferenced DEM package (Esri ASCII Grid + GeoTIFF).

A DTM quality gate governs whether the terrain-product (contour/DEM) export is
offered: export availability keys off Export Readiness (Surface Quality
gated by a known CRS + vertical datum), not Surface Quality alone.
The panel speaks to data quality and fitness-for-use, not survey
certification (see [What confidence means](#what-confidence-means-and-what-it-does-not)).

These products are powered by the confidence-aware pipeline under
`src/terrain/contour/`, `ground/`, `surface/`, `validate/`, and `export/`.
Alongside the pipeline, `TerrainContracts.ts` holds the shared type
contracts every stage reads, and the Dataset Intelligence card surfaces a
cheap, header-derived summary in the Inspector. Both are described below.

## Shared contracts and the Dataset Intelligence card

Two small, live pieces support the pipeline without being part of it.

- Contracts (`TerrainContracts.ts`). Stable type contracts every
  consumer reads (`TerrainPoint`, `TerrainCoverageMode`, and the result
  envelope). Every result carries `coverage` / `sourcePointCount` /
  `analyzedPointCount` / `confidence` / `warnings`, so analyses never imply
  full-cloud certainty when only resident streaming nodes were walked. All five
  stages import these types (ground, contour, surface, validate, quality).
- Dataset Intelligence card (`src/ui/DatasetIntelligenceCard.ts`,
  `src/terrain/datasetIntelligence.ts`). Inspector card whose rows are Point
  Density, Terrain Complexity and Ground Visibility, plus Streaming Coverage
  and Terrain Confidence. It is informational only and header-derived: it
  computes a cheap summary from declared point count, bounding-box volume,
  optional resident-neighbour density, and an optional terrain suggestion. It
  never performs ground classification and renders `—` rather than
  fabricating a bucket when no signal is available.

## The live pipeline (confidence-aware DTM, surface models, contours)

Added in v0.4.0 and surfaced through the Analyse panel today. All of the
following are pure-data leaves (no DOM, no three.js), unit-tested, and
composed by the `analyseContours` orchestrator
(`src/terrain/contour/analyseContours.ts`).

- Ground classification (`ground/groundFilter.ts`). Simple Morphological
  Filter (SMRF core): minimum-elevation grid with a low-percentile despike,
  progressive morphological opening with a slope-scaled threshold, and
  slope-scaled point classification.
- DTM rasterisation (`ground/rasterizeDtm.ts`). Ground returns aggregated
  to a regular grid; empty cells stay `NaN` (no invented data).
- Per-cell confidence (`ground/cellConfidence.ts`). Produces the
  confidence-aware DTM: every cell carries an elevation, a 0..100
  confidence, coverage provenance, and interpolation distance. Void cells are
  filled by geodesic-distance propagation (`ground/geodesicFill.ts`, seeded by
  an IDW prefill from `ground/idwFill.ts`); slope for
  the roughness penalty uses Horn's method (`ground/terrainDerivatives.ts`);
  measured-cell confidence combines relative and absolute sample adequacy.
- Validation + calibration (`validate/`). Hold-out cross-validation
  (`holdoutRmse.ts`) measures vertical residual at withheld ground points;
  ground classification is re-run on the training points only
  (`validate/trainOnlyReclassify.ts`, same SMRF parameters as the main pass),
  so a withheld point never helps decide its own ground membership
  (classify-inside-fold: the classify-before-split optimism disclosed in
  v0.5.9 is removed, not just stated);
  `calibrateConfidence.ts` fits a monotonic map from heuristic confidence to
  measured reliability and recalibrates the reported confidence, so a cell's
  percentage reflects the probability its elevation is within the measured
  vertical tolerance. An NVA/VVA-style vertical statistic (1.96 x RMSEz on internal hold-out, not ASPRS checkpoints) is reported via
  `verticalAccuracy.ts`.
- Evidence-graded contours (`contour/`). Marching-squares contouring,
  density-gated intervals, stitching, styling, honesty-preserving smoothing,
  label placement, hypsometric colouring, and a shared feature model that
  exports to GeoJSON, SVG, and DXF, with each run graded solid /
  dashed / gap by its supporting confidence.
- Surface models (`surface/`). From the classified returns and the DTM:
  a DSM (top-surface elevation, `buildDsm.ts`), a CHM / canopy
  height as height-above-ground (CHM = DSM − DTM), slope in degrees
  (Horn's method), and a hillshade (single-sun or multi-directional,
  with an adjustable sun azimuth/altitude) using the ESRI illumination
  model (`hillshade.ts`). Empty cells stay nodata; nothing is synthesised
  where the DTM has no ground.
- Trust overlays (`surface/coverageHeatmap.ts`,
  `surface/confidenceOverlay.ts`). Two projections of the per-cell DTM
  confidence onto the Analyse panel's 2D preview tile and the 3D point cloud
  ("Coverage" / "Confidence" colour modes): the same strong / moderate / weak
  buckets (`gradeForConfidence`) rendered as the conventional traffic-light
  ramp, and as exact Cividis stops for colour-blind-safe reading. Empty cells
  stay transparent (2D) or neutral grey (3D): a hole is never painted as a
  confidence.
- Georeferenced DEM export (`export/`). The DTM, DSM, and CHM are
  written as an Esri ASCII Grid (`demAsciiGrid.ts`) and a Float32
  GeoTIFF (`demGeoTiff.ts`), bundled by `demPackage.ts` with a `.prj`
  sidecar (when WKT is available) and a README that records coverage, the
  quality-gate outcome, and provenance. Empty cells are written as NODATA;
  CRS/datum warnings travel with the package. The DTM and DSM GeoTIFFs carry
  the vertical CRS as an EPSG code whose own unit is the unit of the heights:
  NAVD88 heights in US survey feet are written as EPSG:6360, in international
  feet as EPSG:8228 and in metres as EPSG:5703. A file with a vertical CRS
  declares GeoTIFF 1.1 (GeoKey MinorRevision 1), which GDAL reads as a
  compound CRS by default. When the source's code and height unit give no
  such EPSG code (no code in that unit, a code the writer has no unit for, an
  unknown height unit, a code defined in a different unit, or a depth CRS),
  no vertical CRS is written, the height unit is kept as the band unit (GDAL UNITTYPE),
  and the README says why. The CHM is a height above ground and carries no
  vertical CRS. Every raster declares one NoData value: -9999, unless a
  written height reads back equal to it as a float32 or as three-place ASCII
  text. Then the package uses the first of -99999, -999999 and -9999999 below
  every height, or the most negative float32, and the README states it.
- Cross-section profiles (`render/measure/`). A lower-percentile corridor
  estimator (`profileSampler.ts`) and a full-page PDF profile sheet
  (`profilePdf.ts`) with a scaled chart, station/elevation/grade table, and
  civil summary.

## Honesty contract

Terrain results carry the coverage envelope the analyser walked:

```ts
interface TerrainCoverageMeta {
  coverage: 'full' | 'resident-only' | 'sampled';
  sourcePointCount: number;
  analyzedPointCount: number;
  confidence: number; // 0..100
  warnings: ReadonlyArray<string>;
}
```

The analyser populates these honestly. The Dataset Intelligence card attaches
a streaming caveat ("Analysis is based on currently loaded data. Results may
change as additional points stream.") to any non-`full` row. The DTM/contour
pipeline extends the same contract: empty cells render as gaps rather than
fabricated heights, contour exports carry their evidence grade, and the
confidence figure is calibrated against measured hold-out error rather than
asserted.

## How the DTM is generated

The bare-earth DTM is built in stages, each a pure-data leaf:

1. Ground classification (`ground/groundFilter.ts`). A Simple
   Morphological Filter (SMRF core) separates ground from non-ground
   returns: a minimum-elevation grid with a low-percentile despike,
   progressive morphological opening with a slope-scaled threshold, then
   slope-scaled point classification. Where the source file already carries
   classification, non-ground classes can be excluded directly
   (`ground/classificationFilter.ts`).
2. Rasterisation (`ground/rasterizeDtm.ts`). Ground returns are
   aggregated onto a regular grid. Cells with no ground return stay `NaN`:
   no invented heights.
3. Confidence-aware grid (`ground/cellConfidence.ts`). Each cell gets an
   elevation, a 0 to 100 confidence, coverage provenance, and an interpolation
   distance. Void cells are filled by geodesic-distance propagation
   (`ground/geodesicFill.ts`, seeded by an IDW prefill); the roughness penalty uses slope from Horn's
   method (`ground/terrainDerivatives.ts`). A measured cell, an interpolated
   cell, and an empty cell are always distinguishable downstream.

## How DSM and CHM are generated

The DSM (digital surface model) is the *top* surface (the highest
returns per cell, including buildings and canopy) built by
`surface/buildDsm.ts`. The CHM (canopy height model) is height above
ground, computed as CHM = DSM − DTM, so it reads ~0 over bare earth and
rises to the structure/canopy height over footprints. Cells where either
input is nodata produce no DSM/CHM value (`reconstructDsmChm` in
`export/demPackage.ts` preserves nodata rather than synthesising a surface
where there is no ground). Slope and hillshade are derived from the same
grid (see the live-pipeline list above).

## Terrain Assessment

`src/terrain/contour/terrainAssessment.ts` collapses a full analysis into a
single, plain-language verdict: the line a non-specialist should read
first, above the detailed metrics. It is pure-data: derived entirely
from the existing quality report, quality score, cell metrics, accuracy
standards, and coverage, so it never disagrees with the numbers shown
beneath it.

It reports two independent axes, deliberately not conflated:

- Surface Quality: *is the terrain surface internally valid?* Derived
  purely from surface metrics (coverage, interpolation, edge risk, density,
  ground visibility, hold-out RMSE) and independent of CRS / vertical
  datum. A dense, clean, well-covered scan with an unknown datum still has
  good Surface Quality.
- Export Readiness: *is it georeferenced enough to hand off?* Equals
  Surface Quality, further gated by a known CRS and vertical datum. An
  unknown CRS or datum caps Export Readiness to Preview (with an explicit
  reason such as "vertical datum unknown"), even when Surface Quality is good.

Surface Quality has four statuses, never collapsed:

| Status | Meaning |
|---|---|
| Good | Surface is internally valid; suitable for terrain workflows. |
| Preview | Suitable for inspection and measurement; additional validation recommended before deliverable use. |
| Limited | Insufficient data quality for reliable terrain products. |
| Blocked | The quality gate blocked it, or there is no usable DTM at all. |

Surface Quality is derived in two passes. A baseline comes from the gate's
surface readiness (ready → Good, previewOnly → Preview, blocked / no usable
DTM → Blocked). Then a set of surface caps can only ever pull the status
*down*: high interpolation, resident-only or sampled coverage, high empty-cell
or edge-risk fractions, and low ground density or ground visibility each cap
the verdict below Good and stay visible in the supporting metrics. A further
"Limited" cap lowers an already weak surface when the score is very low,
several metrics rate poor, or the grid is severely gappy. CRS and vertical
datum do not enter this axis: they belong to Export Readiness.

Export Readiness then takes the Surface Quality verdict and gates it on
georeferencing: a Blocked surface blocks export; otherwise it reads Ready
only when the surface is Good *and* the CRS + vertical datum are both known,
else Preview with a reason naming the gap. The user-facing line reads, for
example, `Surface Quality: Good · Export Readiness: Preview — vertical datum
unknown`. DEM, contour, and printable-map exports key off Export Readiness:
a good surface with an unknown datum can still be inspected and measured, but
the georeferenced hand-off stays gated, and the DEM/map deliverables carry a
preliminary caveat naming the georeferencing gap.

Terrain Assessment speaks to fitness-for-use, not certification. Where a
value is genuinely unknown it is shown as "unknown" with an unknown rating:
never fabricated, and never read as `0/100`.

## Terrain complexity metrics (v0.5.4)

Alongside the assessment, the terrain core computes two literature-defined
complexity descriptors (`src/terrain/complexity/`), summarised once per run,
off the interactive path, alongside the heavy core in the worker (or its
main-thread fallback), never eagerly at scan attach:

- Vector Ruggedness Measure (VRM): Sappington, Longshore & Thompson
  (2007), *J. Wildl. Manage.* 71(5), doi:10.2193/2005-723. Each cell
  contributes a unit surface normal (decomposed from the existing Horn
  slope/aspect grids: nothing is recomputed); over a moving window of n
  valid cells, VRM = 1 − R/n ∈ [0, 1]. Window: 3×3 cells (Sappington's
  neighbourhood), always stated with its ground-metre size. VRM is
  dimensionless and unit-independent: the same surface in feet or metres
  scores identically. Reported as median + IQR over valid cells, banded
  for display (Low / Moderate / High / Very High) with the numbers always
  alongside the label.
- Topographic Position Index (TPI) and the six-class slope position:
  Weiss (2001), ESRI User Conference poster. TPI is the cell's elevation
  minus its neighbourhood mean; classes come from TPI standardised to the
  neighbourhood SD, with tan(5°) splitting flat from mid-slope on the same
  rise/run slope the rest of the stack uses. Radius: chosen per grid to
  target a ~10 m neighbourhood, clamped to 2 to 10 cells, and the ACHIEVED
  radius is reported in cells and ground metres. TPI is expressed in the
  grid's own Z units (it scales linearly with Z; stdTPI and classes are
  unit-free); the unit is always stated. The summary reports the dominant
  class with its share of valid cells.

Why VRM and not a slope-conflating measure. Surface-area rugosity
(Jenness 2004) and TRI-style total-curvature measures score a smooth, steep
plane as "rugged": steepness masquerades as complexity. VRM is
slope-decoupled by construction: a constant 45° plane scores ≈ 0 while an
alternating surface with the same face slope scores high. That
slope-independence is CI-guarded (`npm run repro`, metric M5) with analytic
fixtures, alongside a hand-computed TPI ridge-crest check. The arc to chord
ratio (Du Preez 2015) achieves slope-decoupling differently and remains on
the deferred list below.

Honesty envelope. Both metrics carry the standard `TerrainCoverageMeta`
fields; the confidence is derived from data support only (valid-cell
fraction × mean window support: border truncation and NoData holes lower
it), never asserted, and the summary takes the more conservative of the two
cores' envelopes. Cells with no coverage are NoData: windows shrink, never
wrap, and never invent a neighbourhood.

Density-reliability caveat (cited). When the scan-scaled ground density
is below 4 pts/m², the summary attaches: *"point density N pts/m² is
below the ≥4 pts/m² reliability threshold reported for detailed
terrain/vegetation complexity (Münzinger et al. 2022,
doi:10.1016/j.ufug.2022.127637); treat complexity as indicative."* It is a
warning, never a block. LaRue et al. (doi:10.5281/zenodo.6463393) provide
the sensitivity evidence that lidar structural-complexity metrics degrade
with point density.

Where it renders. The Dataset Intelligence "Terrain Complexity" row is
backed by the real VRM band after a run (numeric median + IQR, window and
units in the hover/details; ": " until then); the Analyse panel adds a
derived-metrics line under the Terrain Assessment; the terrain report and
every export's provenance record the metric names, window/radius in cells
AND ground units, Z units, the Horn slope/aspect convention note, the
derived confidence, and the caveats: reproducible parameters, worded
identically everywhere.

Licensing note. pyTopoComplexity (Lai et al. 2025,
doi:10.5194/esurf-13-417-2025) is prior art for several of these measures
but is AGPL-licensed: no code was read or ported. The cores are implemented
from the primary literature only.

### Deferred planned methods

Evaluated and deliberately deferred (kept here so the roadmap is explicit):

- multi-scale TPI with the ten-class landform scheme (Weiss 2001);
- Booth et al. (2009) wavelet/spectral curvature for landslide-texture
  mapping;
- fractal dimension by variogram;
- arc to chord ratio rugosity (Du Preez 2015);
- PROTECT-style topographic cross-section profiles;
- an optional MCC ground filter (Evans & Hudak 2007) alongside SMRF;
- per-segment lasso IDs for complexity-by-region (prior art: Papucci &
  Yrttimaa 2026, doi:10.5281/zenodo.20395900);
- archaeological local-relief workflows (cf. Niculiță 2020,
  doi:10.3390/s20041192).

## Terrain core cache on this device

The heavy half of the pipeline (classification, ground filtering, DTM,
validation, calibration, gate, quality, surface) is computed once as a terrain
core and reused. Beyond the in-memory reuse inside one session, the core is
also written to the browser's origin-private file system, in a directory named
`olv-terrain-core`. Re-opening the same data after a reload restores the core
from there instead of recomputing it.

An entry is keyed by a SHA-256 of the analysed position bytes, a
SHA-256 of the per-point classification, the exact core parameters (cell size,
CRS and vertical frame, unit factors, excluded classes, ground filter settings,
hold-out seed, aggregation, sample scale), and the method generation, which is
the `id@version` tag of every registered method whose output is baked into the
core. All four must match. Any mismatch, a failed integrity check on the stored
bytes, or an unreadable payload recomputes the core rather than serving what was
stored.

The key identifies the analysed input, not the file it came from. A different
sample of the same file (a different stride, a different resident subset, a
different class exclusion) is a different input and recomputes.

The store holds at most 512 MiB across all entries. When a write does not fit,
the least recently used entries are removed until it does. Only cores whose
compute took at least one second are written; cheaper ones stay in memory for
the session and are recomputed afterwards. Nothing in this store reaches the
point-cloud tile caches or the source file, and nothing leaves the device.

## What the analysis was built from

A terrain run reads the points the viewer holds, so its basis is stated wherever
a result appears. The coverage is `full`, `sampled` (a display sample) or
`resident-only` (the streaming set in memory), and every artifact prints an
analysed-basis line such as "2,899,049 of 47,170,656 points (display sample);
whole-dataset support not claimed". Points flagged Withheld are left out of the
surface and counted, and they do not turn a full read into a sample. When a
Withheld-aware recovery rebuilds the surface from the source file, the status says
the source was read again at the point budget, taking every Nth point, so the
surface is still a sample.

The USGS ground-return density reference is not stated when the coverage is not a
full read, or when points are missing for a reason other than Withheld exclusion.
The Analyse panel, the contour map sheet, the terrain report and the export
provenance leave it out, and the map sheet prints "not stated on a sample" in its
place. The sheet titles the accuracy block "Hold-out accuracy (preview)" and states
that the figures come from a sample of the points.

## What confidence means (and what it does not)

The per-cell confidence is calibrated against measured error, not
asserted. Hold-out cross-validation (`validate/holdoutRmse.ts`) withholds a
share of ground returns and measures the vertical residual at those
withheld points. `validate/calibrateConfidence.ts` then fits a monotonic map
from the heuristic confidence to that measured reliability and recalibrates
the reported figure, so a cell's percentage reflects the probability that
its elevation is within the measured vertical tolerance. An NVA/VVA-style vertical statistic (hold-out, not ASPRS
checkpoints) (NVA/VVA) is reported via `validate/verticalAccuracy.ts`.

The blocked hold-out RMSE carries a 95% confidence interval from a bootstrap over
the scored blocks. With only one scored block, a disabled bootstrap, or no held-out
points, no interval is computed. The Analyse panel and the report then show
"Confidence interval unavailable" with that reason and keep the point RMSE. They do
not print the RMSE as both endpoints.

Confidence does not mean survey certification. It is a calibrated,
data-quality estimate from the returns the analyser actually walked. It does
not stand in for a licensed surveyor, a ground-control network, datum
validation, or regulatory acceptance: all of which are out of scope. Treat
terrain products as preview unless you have independently validated them
against survey-grade data and procedures.

## Scope note

The live pipeline above is what produces every terrain product in the
Analyse panel. Contours are drawn into the scene as their own layer, and the
Coverage and Confidence colour modes grade the point cloud from the DTM. The DTM
itself is not drawn as a surface in the scene. It appears as the 2D preview
tiles in the Analyse panel and as the exported rasters.

For how each terrain product is validated (and the manual pre-release
checks) see
[validation/terrain-validation-matrix.md](validation/terrain-validation-matrix.md).
