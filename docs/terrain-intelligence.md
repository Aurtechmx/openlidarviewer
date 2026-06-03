# Terrain Intelligence

This document describes the Terrain Intelligence foundation that ships
in OpenLiDARViewer v0.3.9. The foundation lives under `src/terrain/`
and powers the Inspector's Dataset Intelligence card. Higher-level
analyses (ground classification, DTM, DSM, contours, hillshade, slope
maps, height-above-ground) are not part of v0.3.9.

## What v0.3.9 ships

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
- **Partitioning** (`TerrainPartition.ts`). Grid + tile partition
  builders, radius queries, bounding-box queries, neighborhood
  builders, and a resident-aware filter for streaming clouds.
- **Cache** (`TerrainCache.ts`). LRU cache for analysis results
  keyed by dataset fingerprint + tile + parameters + coverage mode.
  Recency is tracked through `Map` insertion order; eviction is
  O(k).
- **Worker infrastructure** (`TerrainWorker.ts`). Job lifecycle
  with abortable cancellation, progress reporting, typed errors,
  and clean teardown.
- **Engine** (`TerrainEngine.ts`). Orchestrator that holds the
  per-scan partition, routes analysis requests to the worker (or
  main-thread analyser), and caches results.
- **Feature flags** (`TerrainFeatureFlags.ts`). Engine + worker on
  by default. `terrainExperimentalUiEnabled` is off in production.
- **Dataset Intelligence card** (`src/ui/DatasetIntelligenceCard.ts`,
  `src/terrain/datasetIntelligence.ts`). Inspector card that reads
  the foundation outputs and renders Point Density, Terrain
  Complexity, Ground Visibility, Streaming Coverage, and Terrain
  Confidence. Informational only. The card never claims to perform
  ground classification.

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

The analyser populates these honestly. The UI surfaces them as a
quality badge alongside every terrain result chip, and the Dataset
Intelligence card attaches a streaming caveat ("Analysis is based on
currently loaded data. Results may change as additional points
stream.") to any non-`full` row.

## What is not in v0.3.9

The following are deliberately not shipped: ground classification,
DTM / DSM generation, contour extraction, hillshade rendering, slope
maps, height-above-ground analysis, vegetation detection, building
detection, and a terrain quality report. The foundation gives a
single envelope (`TerrainAnalysisResult`) that any future producer
can populate; v0.3.9 itself ships only the metrics + scoring +
informational card surface described above.
