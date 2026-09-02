# Method registry

`src/science/methodRegistry.ts` is the single catalogue of the scientific
methods OpenLiDARViewer runs. Every algorithm that produces a reported number
has one stable identifier and an integer version, so provenance and reports can
name the exact method and revision behind a figure and a reader can trace it to
the paper that specifies it.

## Identifier and versioning rules

- **Id form:** `olv.<area>.<method>` (e.g. `olv.validation.spatial-block`). The
  id never changes once published.
- **Version:** an integer, bumped only when the method's behaviour changes in a
  way that could move its numbers (a new threshold, a corrected estimator, a
  different formula). A pure refactor that leaves the output identical does not
  bump it.
- **Tag form:** `id@version`, e.g. `olv.validation.spatial-block@2`.
- **Citations are never fabricated.** An internal composition with no single
  source paper says so.

## Registered methods

| Id | Ver | Method | Citation |
|---|---|---|---|
| `olv.ground.smrf` | 1 | SMRF-derived ground extraction; the shipped opening rule is the project's own cut-surface variant, which diverges from the published object-mask (see `groundFilter.ts`) | after Pingel, Clarke & McBride (2013) |
| `olv.terrain.slope-horn` | 1 | Horn slope & aspect | Horn (1981) |
| `olv.terrain.vrm` | 1 | Vector Ruggedness Measure | Sappington et al. (2007) |
| `olv.terrain.tpi` | 1 | Topographic Position Index | Weiss (2001) |
| `olv.contour.analytical` | 1 | Analytical iso-contour geometry | internal (grid contour extraction) |
| `olv.contour.generalize` | 1 | Uniform contour generalization | Douglas & Peucker (1973) |
| `olv.contour.generalize.dp` | 1 | Douglas–Peucker contour simplification | Douglas & Peucker (1973) |
| `olv.contour.generalize.terrain-adaptive` | 1 | Terrain-adaptive contour generalization | internal (feature-scaled DP) |
| `olv.class.derived-heuristic` | 3 | Derived point classification (heuristic) | Zhang et al. (2003); internal composition |
| `olv.topology.linkage-record` | 1 | Source acquisition topology linkage record | internal (provenance record) |
| `olv.dtm.idw-fill` | 1 | DTM raster + void fill; the shipped fill is geodesic, an Euclidean IDW prefill only seeds it (see `methodRegistry.ts`) | internal |
| `olv.validation.holdout-rmse` | 2 | Hold-out vertical accuracy (classify-inside-fold) | ASPRS (2014) formulas, hold-out basis |
| `olv.validation.spatial-block` | 2 | Spatial-block cross-validation | Roberts et al. (2017) |
| `olv.validation.reliability-wilson` | 1 | Measured-cell reliability | Wilson (1927) |
| `olv.registration.icp-planar` | 1 | Planar rigid ICP | Besl & McKay (1992); Umeyama (1991) |
| `olv.registration.epoch-horizontal-icp` | 1 | Repeat-epoch horizontal alignment (yaw + XY, Z locked) | Besl & McKay (1992); Umeyama (1991) |
| `olv.volume.stockpile` | 1 | Stockpile cut-fill volume ±1σ | internal (prismatic cut-fill) |
| `olv.volume.stockpile-area-grid` | 2 | Area-weighted stockpile volume (grid integration) | internal (area-weighted DoD); Sutherland & Hodgman (1974) |
| `olv.change.dtm-difference` | 1 | DTM-of-difference cut/fill (thresholded gain/loss/net) | Anderson (2019), LoD thresholding |
| `olv.change.dtm-difference.raw-net` | 1 | DTM-of-difference cut/fill (raw net + thresholded gross) | Anderson (2019), thresholded gross vs raw net |
| `olv.feature.building-footprint` | 1 | Building footprint candidate extraction | internal (connected-component + boundary trace) |
| `olv.feature.conductor-fit` | 1 | Conductor centreline and sag fit | internal (parabolic small-sag approximation) |

## Honesty boundary

Registering a method names the algorithm; it does not upgrade the evidence
behind its output. The hold-out vertical accuracy uses the ASPRS 2014 formulas
on internally withheld points, not independent survey checkpoints, and the
evidence registry still governs whether any product may be presented as
validated. See `docs/validation/` and the evidence model.
