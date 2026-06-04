# Terrain Intelligence

This document describes the Terrain Intelligence stack under `src/terrain/`.
It has two layers:

1. The **foundation** (metrics, scoring, partitioning, caching, worker
   infrastructure, and the Dataset Intelligence card) introduced in v0.3.9.
2. The **confidence-aware DTM and contour pipeline** added in v0.4.0:
   ground classification, a gridded DTM with per-cell confidence, hold-out
   validation with confidence calibration, and evidence-graded contour
   export.

Scope note (current, v0.4.1): the Analyse panel (`src/ui/AnalysePanel.ts`)
is **mounted** and surfaces the validated pipeline end to end — a single
top-level Terrain Assessment verdict (Good / Preview / Limited), a 0–100
quality score, readiness indicators, coverage/confidence, surface models
(DSM, canopy height, slope, multi-directional hillshade with adjustable
sun, click-to-sample), and exports: evidence-graded contours (GeoJSON /
SVG / DXF), a printable map sheet, and a georeferenced DEM package (ASCII
Grid + GeoTIFF). It is reachable any time via the "Analyse" tool-dock
button, and a DTM quality gate still governs whether a professional contour
export is offered (the panel speaks to data quality and fitness-for-use, not
survey certification). Note: these products are powered by the confidence-aware
pipeline under `src/terrain/contour/`, `ground/`, and `surface/` — the
older `src/terrain/` *foundation* (engine, metrics, partitioning, cache)
remains an internal seam behind a feature flag.

## What v0.3.9 shipped (foundation)

- **Contracts** (`TerrainContracts.ts`). Stable type contracts every
  consumer reads. Every result carries `coverage` /
  `sourcePointCount` / `analyzedPointCount` / `confidence` /
  `warnings`, so analyses never imply full-cloud certainty when
  only resident streaming nodes were walked.
- **Metrics** (`TerrainMetrics.ts`). Deterministic per-neighborhood
  metrics: local slope (degrees), roughness (RMS residual), mean
  curvature, elevation variance, point density, height above local
  surface, neighborhood elevation range, and local planarity. The
  metrics module honours an explicit `worldUp` axis and a
  `linearUnitToMetres` scale so results are reported in metres
  regardless of the source CRS unit.
- **Ground confidence scaffold** (`computeGroundScore`). Pure
  scoring framework that combines slope / roughness / variance /
  density into a `confidence: 0..100` score with a `reasons` array.
  No threshold, no class assignment.
- **Partitioning** (`TerrainPartition.ts`), **Cache** (`TerrainCache.ts`),
  **Worker infrastructure** (`TerrainWorker.ts`), **Engine**
  (`TerrainEngine.ts`), and **Feature flags** (`TerrainFeatureFlags.ts`).
- **Dataset Intelligence card** (`src/ui/DatasetIntelligenceCard.ts`,
  `src/terrain/datasetIntelligence.ts`). Inspector card that renders Point
  Density, Terrain Complexity, Ground Visibility, Streaming Coverage, and
  Terrain Confidence. Informational only; it never claims to perform ground
  classification.

## What v0.4.0 adds (confidence-aware DTM + contour pipeline)

All of the following are pure-data leaves (no DOM, no three.js), unit-tested,
and composed by the `analyseContours` orchestrator
(`src/terrain/contour/analyseContours.ts`).

- **Ground classification** (`ground/groundFilter.ts`). Simple Morphological
  Filter (SMRF core): minimum-elevation grid with a low-percentile despike,
  progressive morphological opening with a slope-scaled threshold, and
  slope-scaled point classification.
- **DTM rasterisation** (`ground/rasterizeDtm.ts`). Ground returns aggregated
  to a regular grid; empty cells stay `NaN` (no invented data).
- **Per-cell confidence** (`ground/cellConfidence.ts`). Produces the
  confidence-aware DTM — every cell carries an elevation, a 0..100
  confidence, coverage provenance, and interpolation distance. Void cells are
  filled by **inverse-distance weighting** (`ground/idwFill.ts`); slope for
  the roughness penalty uses **Horn's method** (`ground/terrainDerivatives.ts`);
  measured-cell confidence combines relative and absolute sample adequacy.
- **Validation + calibration** (`validate/`). Hold-out cross-validation
  (`holdoutRmse.ts`) measures vertical residual at withheld ground points;
  `calibrateConfidence.ts` fits a monotonic map from heuristic confidence to
  measured reliability and recalibrates the reported confidence, so a cell's
  percentage reflects the probability its elevation is within the measured
  vertical tolerance. ASPRS vertical accuracy is reported via
  `verticalAccuracy.ts`.
- **Evidence-graded contours** (`contour/`). Marching-squares contouring,
  density-gated intervals, stitching, styling, honesty-preserving smoothing,
  label placement, hypsometric colouring, and a shared feature model that
  exports to **GeoJSON, SVG, and DXF**, with each run graded solid /
  dashed / gap by its supporting confidence.
- **Cross-section profiles** (`render/measure/`). A bare-earth percentile
  estimator (`profileSampler.ts`) and a full-page **PDF profile sheet**
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

## Not yet shipped

Deliberately still out of scope: a ground/vegetation/building
classification UI, a DSM, slope and hillshade maps, 3D DTM and contour
overlays, and an automatic terrain quality report. The pipeline produces
the data these would consume; surfacing them is future work.
