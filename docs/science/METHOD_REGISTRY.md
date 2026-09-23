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
| `olv.contour.generalize` | 1 | Uniform contour generalization; the shipped pass is Douglas–Peucker followed by Chaikin corner-cutting, which also moves vertices (see `methodRegistry.ts`) | Douglas & Peucker (1973); Chaikin (1974) |
| `olv.contour.generalize.dp` | 1 | Douglas–Peucker contour simplification | Douglas & Peucker (1973) |
| `olv.contour.generalize.terrain-adaptive` | 1 | Terrain-adaptive contour generalization; feature-scaled Douglas–Peucker followed by the same Chaikin corner-cutting | internal (feature-scaled DP, then Chaikin) |
| `olv.class.derived-heuristic` | 3 | Derived point classification (heuristic) | Zhang et al. (2003); internal composition |
| `olv.topology.linkage-record` | 1 | Source acquisition topology linkage record | internal (provenance record) |
| `olv.dtm.idw-fill` | 1 | DTM raster + void fill; the shipped fill is geodesic, an Euclidean IDW prefill only seeds it (see `methodRegistry.ts`) | internal |
| `olv.validation.holdout-rmse` | 2 | Hold-out vertical accuracy (classify-inside-fold) | ASPRS (2014) formulas, hold-out basis |
| `olv.validation.spatial-block` | 2 | Spatial-block cross-validation | Roberts et al. (2017) |
| `olv.validation.reliability-wilson` | 1 | Measured-cell reliability | Wilson (1927) |
| `olv.registration.icp-planar` | 1 | Planar rigid ICP | Besl & McKay (1992); Umeyama (1991) |
| `olv.registration.epoch-horizontal-icp` | 1 | Repeat-epoch horizontal alignment (yaw + XY, Z locked) | Besl & McKay (1992); Umeyama (1991) |
| `olv.volume.stockpile` | 1 | Stockpile cut-fill volume with model sensitivity band | internal (prismatic cut-fill) |
| `olv.volume.stockpile-area-grid` | 2 | Area-weighted stockpile volume (grid integration) | internal (area-weighted DoD); Sutherland & Hodgman (1974) |
| `olv.change.dtm-difference` | 1 | DTM-of-difference cut/fill (thresholded gain/loss/net) | Anderson (2019), LoD thresholding |
| `olv.change.dtm-difference.raw-net` | 1 | DTM-of-difference cut/fill (raw net + thresholded gross) | Anderson (2019), thresholded gross vs raw net |
| `olv.feature.building-footprint` | 1 | Building footprint candidate extraction | internal (connected-component + boundary trace) |
| `olv.feature.conductor-fit` | 1 | Conductor centreline and sag fit | internal (parabolic small-sag approximation) |
| `olv.simulation.terrain-flow.d8` | 1 | D8 single-flow-direction routing, by steepest descent per metre | O'Callaghan & Mark (1984) |
| `olv.simulation.terrain-flow.priority-flood` | 2 | Priority-Flood depression conditioning onto a second surface, seeded at the grid boundary; NoData is a wall and cells it encloses are counted | Barnes, Lehman & Mulla (2014) |
| `olv.simulation.terrain-flow.priority-flood.gap-outlet` | 1 | The same conditioning with NoData gaps read as drainage exits, declared for gaps that are open water | Barnes, Lehman & Mulla (2014) |
| `olv.simulation.terrain-flow.accumulation` | 1 | Cells draining through each cell; metric area withheld when the scale is unresolved | internal (dependency-ordered pass over the D8 graph) |
| `olv.simulation.terrain-flow.catchment` | 1 | Cells draining to a selected outlet | internal (reverse D8 traversal) |
| `olv.simulation.terrain-flow.depression-inventory` | 1 | Groups raised cells into 8-connected depressions with cell count, area, deepest fill and outlet elevation; raw mode lists sink candidates instead | internal (connected-component grouping over Priority-Flood's output) |

## Honesty boundary

Registering a method names the algorithm; it does not upgrade the evidence
behind its output. The hold-out vertical accuracy uses the ASPRS 2014 formulas
on internally withheld points, not independent survey checkpoints, and the
evidence registry still governs whether any product may be presented as
validated. See `docs/validation/` and the evidence model.

Naming those formulas is not a conformance statement. They are the edition-1
(2014) forms, reproduced as diagnostics on withheld observations; ASPRS has
published later editions of the positional-accuracy standards, and OLV does not
claim conformance with any edition of them. The claim register prohibits
"ASPRS NVA/VVA compliance" outright, because conformance presumes independent
checkpoints this project does not have.
