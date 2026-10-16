# Method registry

`src/science/methodRegistry.ts` is the single catalogue of the scientific
methods OpenLiDARViewer runs. Every algorithm that produces a reported number
has one stable identifier and an integer version, so provenance and reports can
name the exact method and revision behind a figure and a reader can trace it to
the paper that specifies it.

## Identifier and versioning rules

- Id form: `olv.<area>.<method>` (e.g. `olv.validation.spatial-block`). The
  id never changes once published.
- Version: an integer, bumped only when the method's behaviour changes in a
  way that could move its numbers (a new threshold, a corrected estimator, a
  different formula). A pure refactor that leaves the output identical does not
  bump it.
- Tag form: `id@version`, e.g. `olv.validation.spatial-block@2`.
- Citations are never fabricated. An internal composition with no single
  source paper says so.

## Registered methods

| Id | Ver | Method | Citation |
|---|---|---|---|
| `olv.ground.smrf` | 1 | SMRF-derived ground extraction; the shipped opening rule is the project's own cut-surface variant, which diverges from the published object-mask (see `groundFilter.ts`) | after Pingel, Clarke & McBride (2013) |
| `olv.terrain.slope-horn` | 1 | Horn slope & aspect | Horn (1981) |
| `olv.terrain.vrm` | 1 | Vector Ruggedness Measure | Sappington et al. (2007) |
| `olv.terrain.tpi` | 1 | Topographic Position Index | Weiss (2001) |
| `olv.contour.analytical` | 2 | Analytical iso-contour geometry; v2 places levels on multiples of the interval in world elevation (local origin added back) where v1 used the recentred local frame | internal (grid contour extraction) |
| `olv.contour.generalize` | 1 | Uniform contour generalization; the shipped pass is Douglas to Peucker followed by Chaikin corner-cutting, which also moves vertices (see `methodRegistry.ts`) | Douglas & Peucker (1973); Chaikin (1974) |
| `olv.contour.generalize.dp` | 1 | Douglas to Peucker contour simplification | Douglas & Peucker (1973) |
| `olv.contour.generalize.terrain-adaptive` | 1 | Terrain-adaptive contour generalization; feature-scaled Douglas to Peucker followed by the same Chaikin corner-cutting | internal (feature-scaled DP, then Chaikin) |
| `olv.class.derived-heuristic` | 3 | Derived point classification (heuristic) | Zhang et al. (2003); internal composition |
| `olv.render.draw-precision-bound` | 1 | Per-draw eye-space precision bound: upper bound on the binary32 error of `modelView * vec4(p, 1.0)` for the active cloud at the current camera, compared with 1 mm; a diagnostic, not a draw gate, and NOT_TESTED where the shader contract is not verified (see `docs/architecture/draw-precision-contract.md`); projection, divide by w and survey accuracy not covered | A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU"; checker SHA-256 `53229a0e2682fb103097eaef028079a40b6fa1a5f0c78fbf1da2b0b3c4598b6b` |
| `olv.topology.linkage-record` | 1 | Source acquisition topology linkage record | internal (provenance record) |
| `olv.provenance.source-interpretation` | 1 | Source interpretation and data basis record | internal (provenance record) |
| `olv.dtm.idw-fill` | 1 | DTM raster + void fill; the shipped fill is geodesic, an Euclidean IDW prefill only seeds it (see `methodRegistry.ts`) | internal |
| `olv.terrain.evidence.support` | 2 | DTM cell support raster: ground-return count, interpolation distance, cell evidence state (v2 adds 5 edge affected, 6 unresolved), nearest-support distance, vertical dispersion (MAD of the cell's returns) and survey-edge distance on the DEM grid; describes support, not accuracy | internal (export of the DTM cell-confidence grid) |
| `olv.terrain.evidence.sensitivity` | 1 | DTM model sensitivity raster, written only on request: per-cell highest minus lowest height over a fixed four-member ensemble (canonical, ground filter slope 0.15, slope 0.2, inverse distance weighting void fill) and the number of members with a height; describes model sensitivity, not accuracy | internal (ensemble recorded in `validation/protocols/evidencedem-sensitivity-ensemble-v1.md`) |
| `olv.terrain.evidence.residual` | 1 | DTM leave-local-out reconstruction residual: each measured cell held out and rebuilt by the canonical geodesic fill from its measured 8-neighbours; every measured cell up to 250,000, otherwise every k-th; shows how well neighbours predict a cell, not accuracy | internal (rules recorded in `validation/protocols/evidencedem-attention-v1.md`, version 2 section) |
| `olv.terrain.evidence.attention` | 2 | DTM attention raster: level 0 to 3 and one dominant reason per cell; each input normalised to 0 to 1 by a fixed rule, level is the highest score banded at 0.33, 0.67 and 1, no weighted blend; v2 writes a measured cell skipped by residual sampling, that no other input flags, as NoData with reason 8 (unresolved) where v1 wrote level 0; written only on request; the reason code table is part of this version; describes where to look, not accuracy | internal (rules recorded in `validation/protocols/evidencedem-attention-v1.md`) |
| `olv.validation.holdout-rmse` | 2 | Hold-out vertical accuracy (classify-inside-fold) | ASPRS (2014) formulas, hold-out basis |
| `olv.validation.spatial-block` | 2 | Spatial-block cross-validation | Roberts et al. (2017) |
| `olv.validation.reliability-wilson` | 1 | Measured-cell reliability | Wilson (1927) |
| `olv.registration.icp-planar` | 1 | Planar rigid ICP | Besl & McKay (1992); Umeyama (1991) |
| `olv.registration.epoch-horizontal-icp` | 2 | Repeat-epoch horizontal alignment (yaw + XY, Z locked); v2 starts epochs that declare one CRS at the identity pose, minimises point-to-plane distances over pairs within 3 mean point spacings (best 90 % kept), measures the overlap at that distance, and withholds a fit with overlap under 50 %, a residual over 0.75 spacings, or an RMS move beyond the correspondence distance; v1 started from the centroid and measured overlap at the caller residual limit, so epochs of different extent were shifted | Besl & McKay (1992); Chen & Medioni (1992), point-to-plane; Umeyama (1991) |
| `olv.volume.stockpile` | 3 | Stockpile cut-fill volume with model sensitivity band; v3 integrates over a horizontal grid (footprint-clipped cell area times median cell height, cells without points interpolated inside the covered extent and excluded outside it, the interpolated share reported, low-confidence above 25% and withheld above 50%) instead of the point-weighted sum of v1 and v2, and the lasso footprint is the drawn lasso on the horizontal plane instead of the selection's convex hull; v2 leaves LAS Withheld points out of the polygon Volume tool and records points read, Withheld excluded (or unknown) and points analysed, and keeps Overlap; v1 read every point | internal (area-weighted prismatic cut-fill); Sutherland & Hodgman (1974) |
| `olv.volume.stockpile-area-grid` | 4 | Area-weighted stockpile volume (grid integration); v4 interpolates unsupported cells inside the convex extent of the covered cell centres by inverse-distance weighting (w = 1/d², d between cell centres): a cell within 8 cells of cover (Chebyshev) uses every covered cell on the nearest square ring holding any plus the next ring; a cell deeper in a void uses the first covered cell along each of the 8 grid directions plus its nearest covered cell, so the fill is O(cells); cells outside the extent are excluded, nothing is zero-filled, and the figure is graded by the interpolated share (interpolated heights are not computed when that share exceeds the 50% withhold limit) | internal (area-weighted DoD); Sutherland & Hodgman (1974) |
| `olv.change.dtm-difference` | 4 | DTM-of-difference cut/fill (thresholded gain/loss/net); v4 compares a cell only where both DTMs hold a measured height and reports how many cells were left out because either surface is interpolated or extrapolated there; v3 takes σreg only from an independent stable-area vertical assessment (never an alignment fit residual, so it is unavailable in the app today), uses max(1.96·√(Σ known σ²), 0.1 m) labelled incomplete when some terms are missing, keeps the assumed 0.1 m only when none is known, and requires the grids' origin and cell size to agree to a few float64 ulps (capped at 1e-6 cell); v2 thresholded at the propagated minimum level of detection 1.96·√(σz_before² + σz_after² + σreg²) from hold-out RMSEz and the alignment 3-D RMS, falling back to an assumed 0.1 m when a term is missing; v1 used a fixed 0.1 m | Anderson (2019), LoD thresholding; Wheaton et al. (2010), propagated level of detection |
| `olv.change.dtm-difference.raw-net` | 4 | DTM-of-difference cut/fill (raw net + thresholded gross); v4 sums only cells measured in both epochs; v3 applies the dtm-difference v3 threshold rule and grid check to the gross figures (the raw net is unthresholded); v2 used the propagated minimum level of detection for the gross figures; v1 used a fixed 0.1 m | Anderson (2019), thresholded gross vs raw net; Wheaton et al. (2010), propagated level of detection |
| `olv.feature.building-footprint` | 1 | Building footprint candidate extraction | internal (connected-component + boundary trace) |
| `olv.feature.conductor-fit` | 1 | Conductor centreline and sag fit | internal (parabolic small-sag approximation) |
| `olv.profile.corridor-percentile` | 2 | Corridor-percentile profile; v2 leaves LAS Withheld points out and records points read, Withheld excluded (or unknown) and points analysed, and keeps Overlap; v1 read every point | internal (corridor binning, Hyndman & Fan (1996) type-7 quantile) |
| `olv.density.scan-report` | 2 | Scan report point density and spacing; v2 leaves LAS Withheld points out of the count and records points counted, Withheld excluded (or unknown) and points analysed, and keeps Overlap; v1 counted every point | internal (count over footprint) |
| `olv.simulation.terrain-flow.d8` | 1 | D8 single-flow-direction routing, by steepest descent per metre | O'Callaghan & Mark (1984) |
| `olv.simulation.terrain-flow.priority-flood` | 3 | Priority-Flood depression conditioning onto a second surface, seeded at the grid boundary; NoData is a wall and cells it encloses are counted; v3 counts a cell as filled only when its original height is strictly below its spill level, so a flat lifted by the epsilon alone is not fill, and fill depth excludes the epsilon | Barnes, Lehman & Mulla (2014) |
| `olv.simulation.terrain-flow.priority-flood.gap-outlet` | 2 | The same conditioning with NoData gaps read as drainage exits, declared for gaps that are open water; v2 takes the v3 fill definition above | Barnes, Lehman & Mulla (2014) |
| `olv.simulation.terrain-flow.accumulation` | 1 | Cells draining through each cell; metric area withheld when the scale is unresolved | internal (dependency-ordered pass over the D8 graph) |
| `olv.simulation.terrain-flow.catchment` | 1 | Cells draining to a selected outlet | internal (reverse D8 traversal) |
| `olv.simulation.terrain-flow.depression-inventory` | 2 | Groups filled cells (original height strictly below the spill level) into 8-connected depressions with cell count, area, deepest fill (spill level minus original height) and outlet elevation; v2 no longer counts a level flat as a depression; raw mode lists sink candidates instead | internal (connected-component grouping over Priority-Flood's output) |
| `olv.simulation.terrain-access.local-step` | 1 | Local step-height metric (3×3 footprint maximum + pairwise edge form) | internal (footprint-maximum finite difference) |
| `olv.simulation.terrain-access.directional-grade` | 1 | Directional longitudinal grade and cross slope, decomposed from the Horn gradient by heading | internal (vector decomposition of Horn 1981) |
| `olv.simulation.terrain-access.cost-map` | 3 | Terrain access hard eligibility (node/edge split) and soft traversability cost; v3 adds the evidence-gap policy (conservative blocks cells whose slope used a synthesised Horn neighbour and, under an evaluated obstruction limit, cells with no above-ground return; exploratory allows them and reports their route share); v2 gates and costs an edge on the largest of the directional Horn grade at either endpoint and the edge's own rise/run, and the larger endpoint cross slope | internal (declared multi-term utilization cost) |
| `olv.simulation.terrain-access.astar` | 2 | Deterministic 8-connected A* over eligible terrain cells; v2 takes moves through the cost map's transition rule, which refuses a diagonal that cuts an unsupported corner or sweeps the declared width over unsupported area, with width clearance measured to cell rectangles | Hart, Nilsson & Raphael (1968) |

### Observatory (reserved v0.7, docs/observatory/SPEC.md)

Registered early, ahead of the code, under the decision rules
(`docs/observatory/SPEC.md` §4 OB-INT-04). Every row below except
`olv.observation.states` names a method with no implementation in the tree;
the id and version are reserved so a later phase's first commit cannot
collide with a name someone already used informally. Full status,
assumptions and the implementing phase are in `docs/observatory/methods.md`,
one section per id.

| Id | Ver | Method | Citation |
|---|---|---|---|
| `olv.observation.rays` | 1 | Observation ray builder, not implemented, planned for phase O3 | internal (grid and posed-ray parameterisation) |
| `olv.observation.ledger` | 1 | Voxel evidence ledger and traversal, not implemented, planned for phase O4 | Amanatides & Woo (1987) |
| `olv.observation.states` | 1 | Observation state table; the pure decision function is implemented and tested (O1), not yet wired to a live ledger | internal (state-transition rules, SPEC §2.2-§2.4) |
| `olv.observation.strength` | 1 | Observation strength components, not implemented, planned for phase O6 | internal (strength components, SPEC §2.5) |
| `olv.observation.shadow-frontier` | 1 | Shadow frontier, not implemented, planned for phase O5 | Curless & Levoy (1996) |
| `olv.observation.coverage-gain` | 1 | Coverage Gain over candidate stations, with every term reported (O10) | Scott, Roth & Rivest (2003) |
| `olv.observation.station-suggestion` | 1 | Next-station suggestion by greedy selection against a hypothetical ledger copy (O10) | Scott, Roth & Rivest (2003) |

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
