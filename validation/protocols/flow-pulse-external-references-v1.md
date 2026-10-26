# Flow Pulse against TauDEM and GRASS on real terrain (pre-registration)

Status: preregistered on 2026-10-25. This file was written and committed
together with the three fixtures it names, before OpenLiDARViewer was run on
any of them. The parameters, cell selections, gates and decision rule below are
fixed and are not to be changed after results are seen. A gate that fails is
recorded as failed.

## How the thresholds were set

The thresholds were set after a feasibility run and before OpenLiDARViewer was
run on these data. The feasibility run used a separate scratch implementation
written in Python with numpy for this purpose only. It is not OpenLiDARViewer
code and is not committed. It gave these figures against the same references:

- Bear Creek: a plain Priority-Flood with NoData and the grid edge as outlets
  reproduced TauDEM's filled elevation on all 7,333,224 valid cells of the full
  grid, and on every valid cell of crops A and B.
- Réunion window: 0.9921 direction agreement on the G3 cell set, catchment
  Jaccard index 0.9990 from the mouth cell, and 0.952 of catchment cells within
  5% of the GRASS accumulation (0.870 exact).

So the thresholds were chosen knowing what a textbook implementation reaches
against these references. They are not blind to the references. They are blind
to OpenLiDARViewer's result, which did not exist when they were fixed.

## Claims under test

| Claim | Evidence before this study | Required |
| --- | --- | --- |
| `TERRAIN-FLOW-PULSE` | E3_SYNTHETICALLY_VALIDATED | E4_CROSS_IMPLEMENTATION_VALIDATED |
| `TERRAIN-FLOW-DEPRESSION-INVENTORY` | E2_ANALYTICALLY_VERIFIED | E3_SYNTHETICALLY_VALIDATED |

## References

**TauDEM 5.3.8 PitRemove** (`OLV-DS-117-BEAR-CREEK-TAUDEM-PITFILL`). Zenodo
10.5281/zenodo.8335853, CC-BY-4.0. Riverscapes TauDEM 1.2.3 ran
`mpiexec -n 2 pitremove -z inputs/dem.tif -fel intermediates/pitfill.tif` on a
USGS NED DEM in EPSG:4326 at 1/3 arc-second (5523 x 2396 cells). PitRemove
fills each depression to its spill level with no gradient, and treats NoData as
an outlet.

**GRASS GIS 8.3.2** (`OLV-DS-118-REUNION-GRASS-FLOW`). Zenodo
10.5281/zenodo.18790150, CC-BY-4.0, EPSG:2975, 25 m cells. The version is read
from the GeoTIFF software tag. The dataset does not name the module. The
direction code (k x 45 degrees anticlockwise from east, negative where flow
leaves the region) and the signed integer accumulation are those of
`r.watershed` in single-flow mode, which routes by least cost rather than by
steepest descent on a filled surface. Three properties of this reference bound
any agreement with it below 100%:

- `r.watershed` is a least-cost router, so where it crosses a depression it
  does not follow a filled surface's steepest descent.
- The file named `mnt_filled_GRASS.tif` still holds closed depressions (23,465
  cells across the island, up to 256 m deep).
- The published accumulation disagrees with the published directions on 0.14%
  of cells.

## Fixtures

All three live in `validation/field-simulation/external-references/`. Each
extends the format of `validation/field-simulation/fixtures/*.json` with a
`reference` block. Rows run north to south as in the source raster, and every
index in `reference` is row-major over `z` as stored.

| File | Dataset | Window (row0, col0, rows x cols) | sha256 |
| --- | --- | --- | --- |
| `bear-creek-taudem-fill-A.json` | `OLV-DS-119-BEAR-CREEK-TAUDEM-FILL-A` | 1946, 828, 256 x 256 | `575769bd4bef1b8f1e7c925e9835dbd60a0df79725ffa8546341727317432233` |
| `bear-creek-taudem-fill-B.json` | `OLV-DS-120-BEAR-CREEK-TAUDEM-FILL-B` | 2120, 2407, 256 x 256 | `61243e616b84082270420417e8561bad0edbf27b6f9443b7fc22bc13eff9b681` |
| `reunion-pluies-grass.json` | `OLV-DS-121-REUNION-PLUIES-GRASS-WINDOW` | 44, 996, 589 x 294 | `b43d8b737e4e706e12b567cd57d704415468b7752e58da813f600e16a08be9d2` |

Properties of the references, measured on the reference data alone:

- Crop A has 65,536 valid cells and no NoData. TauDEM raised 9,769 of them,
  in 62 depressions (8-connected), the deepest 8.357 m.
- Crop B has 53,583 valid cells and 11,953 NoData cells in two regions, both
  of which reach the crop border (4-connected), so none is enclosed. TauDEM
  raised 6,688 cells in 125 depressions, the deepest 3.413 m.
- On both crops every depression is filled to a single level, and that level
  equals the lowest raw elevation among the valid cells that touch the
  depression and were not raised.
- The crops were chosen, using only the DEM and TauDEM's output, as windows
  where a fill that drains to the crop edge reproduces TauDEM's whole-grid fill
  exactly. That keeps every compared depression inside its crop, and it means
  the crops are not a random sample of the grid.
- The Réunion window holds 169,684 valid cells. The rasterised catchment
  polygon covers 72,078 of them and does not touch the window border. The mouth
  cell is `[2, 191]` in fixture coordinates, the catchment cell with the
  largest absolute accumulation (72,077 cells, GRASS direction -3). 70,656
  catchment cells have a unique steepest descent as defined under G3.

The Bear Creek cell size in the fixtures (7.42 m east-west, 10.29 m
north-south) approximates one cell at the crop centre. No gate compares a
quantity that depends on distance, and the G2 area check uses the same cell
size on both sides.

## OpenLiDARViewer side, fixed before the run

Loading. Each fixture's `z` becomes a `FlowGrid` with `Float32Array`
elevations and a validity mask from the `null` entries. Rows are reversed, so
fixture row `r` becomes OpenLiDARViewer row `rows - 1 - r`, because
OpenLiDARViewer's row 0 is the southern row and its `D8_NEIGHBOURS` offsets
take `+drow` as north. Every reference index is mapped the same way.

Bear Creek (G1, G2). `priorityFlood(grid, { epsilon: 'float64-step', noData })`
from `src/simulation/flowPulse/priorityFlood.ts`, then `filledCells` and
`depressionInventory(grid, conditioned, filled, true)` from
`src/simulation/flowPulse/depressionInventory.ts`. The compared elevation is
`spillLevel`, which the module defines as the level each cell was reached at
without the epsilon gradient, so the epsilon setting cannot change it. This is
the same call sequence `runFlowPulse` makes.

Réunion (G3, G4, G5, exploratory). A `DtmGrid` with every non-null cell
measured, `cellSizeM` 25, under a projected, resolved horizontal scale with
`unitToMetres` 1, passed to `runFlowPulse` from
`src/simulation/flowPulse/flowPulseRunner.ts` with `FLOW_PULSE_DEFAULTS`
(`fillEpsilon: 'float64-step'`, `interpolated: 'route'`, `maxCells`
4,000,000) and these overrides:

- raw run: `conditioning: 'raw'`.
- conditioned run: `conditioning: 'priority-flood'`, `fillNoData: 'outlet'`.

Direction mapping. OpenLiDARViewer's direction index `d` (0 E, 1 NE, 2 N, 3 NW,
4 W, 5 SW, 6 S, 7 SE) maps to the GRASS code `k = 8` for `d = 0` and `k = d`
otherwise, once rows are reversed. It is compared with the absolute value of
the GRASS code.

## Gates

**G1, conditioned elevation** (`TERRAIN-FLOW-PULSE`, against TauDEM). On every
valid cell, `Math.fround(spillLevel)` equals TauDEM's filled elevation as
Float32. Three runs: crop A with NoData as outlet, crop B with NoData as
outlet, and crop B with NoData as a wall. The wall run is expected to be
identical because crop B's NoData all reaches the crop border, which
OpenLiDARViewer reads as outside the surface. 172,702 compared cells in total;
pass only if all of them are equal.

**G2, depression inventory, conditioned mode**
(`TERRAIN-FLOW-DEPRESSION-INVENTORY`, against TauDEM). From the NoData-as-outlet
runs. The reference depressions are the 8-connected components of the cells
where TauDEM's fill is above the DEM. Pass only if all of these hold on both
crops:

- OpenLiDARViewer's filled mask equals TauDEM's raised mask cell for cell.
- The depression count is 62 on crop A and 125 on crop B.
- Every reference depression has an OpenLiDARViewer depression with the same
  lowest member cell (`seedCell`) and the same cell count.
- For each such pair, `areaM2` equals the reference cell count times
  7.42 x 10.29; `maxFillDepth` equals the largest TauDEM fill minus DEM
  elevation over the component, computed in Float64 from the Float32 values;
  and `Math.fround(outletElevation)` equals the component's TauDEM fill level.

187 compared depressions in total.

**G3, D8 direction** (`TERRAIN-FLOW-PULSE`, against GRASS). Raw run. Cells: the
catchment cells where the steepest descent is unique, meaning the best drop per
metre to a valid neighbour is positive and exceeds the second best by more than
1e-9. Drops are computed in the test from the Float32 elevations over 25 m and
25 x sqrt(2) m, with NoData and off-grid neighbours excluded. Pass if at least
0.98 of these cells have OpenLiDARViewer's mapped direction equal to the
absolute GRASS code, with at least 50,000 cells compared.

**G4, catchment** (`TERRAIN-FLOW-PULSE`, against GRASS). Conditioned run.
`catchmentFrom(result, mouth)` against the rasterised GRASS catchment polygon.
Pass if the Jaccard index (cells in both over cells in either) is at least
0.99, with at least 50,000 cells in the union.

**G5, accumulation** (`TERRAIN-FLOW-PULSE`, against GRASS). Conditioned run.
On catchment cells, `upstreamCells` against the absolute GRASS accumulation.
Pass if at least 0.90 of catchment cells are within 5% of the GRASS value, with
at least 50,000 cells compared. The exact-match fraction is reported with no
threshold.

**Exploratory, not a gate.** OpenLiDARViewer's `edgeContamination` flag on the
conditioned run against GRASS's negative accumulation, as a 2 x 2 count over
valid cells and over catchment cells. It decides nothing.

## Decision rule

- `TERRAIN-FLOW-PULSE` is recorded at E4_CROSS_IMPLEMENTATION_VALIDATED only
  if G1, G3, G4 and G5 all pass. Otherwise it stays at E3 and the failure is
  recorded.
- `TERRAIN-FLOW-DEPRESSION-INVENTORY` is recorded as meeting its required E3,
  with conditioned mode at E4, only if G1 and G2 both pass. Raw mode, which
  lists D8 sinks as one-cell candidates, is not tested here.
- A failed gate is not re-run with a different threshold, parameter, cell
  selection or code. If investigation finds a defect in OpenLiDARViewer, the
  fix lands in its own commit with its own test, and this study's result stays
  as first measured.
- Agreement with GRASS is stated as agreement with a least-cost single-flow
  router within these tolerances, not as exact agreement. Agreement with
  TauDEM is stated as identical conditioning on these two crops.
- Neither claim can reach E5 from these data. Both datasets were published
  before this protocol existed, so the field-study rules refuse them as E5
  evidence on ordering alone.

## Not covered

- D8 tie order and flat resolution: G3 excludes every tied cell, and the
  conditioned surfaces are compared through the catchment and accumulation
  only.
- Flow length and the Rational-method peak-flow estimate.
- The raw-mode depression inventory.
- Anything on Bear Creek that depends on distance, since its cell size is an
  approximation.
- Accuracy against the ground. Two programs can agree and both be wrong about
  the terrain.

## Machine-readable records

When the result exists, it will be recorded in `PROTO-*.protocol.json` records
under this directory and study manifests under
`validation/cross-implementation/studies/`, with this commit as the freeze
witness and these metrics:

| Protocol | Claim | toleranceAbs | Unit | minimumComparableCells | requiredWithinToleranceFraction |
| --- | --- | --- | --- | --- | --- |
| `PROTO-FLOW-PITREMOVE-TAUDEM-BEAR-CREEK` | `TERRAIN-FLOW-PULSE` (G1) | 0 | metre, after casting both sides to Float32 | 172702 | 1 |
| `PROTO-FLOW-PITREMOVE-TAUDEM-BEAR-CREEK` | `TERRAIN-FLOW-DEPRESSION-INVENTORY` (G2) | 0 | depressions matching on every listed field | 187 | 1 |
| `PROTO-FLOW-D8-GRASS-REUNION` | `TERRAIN-FLOW-PULSE` (G3) | 0 | D8 direction code | 50000 | 0.98 |
| `PROTO-FLOW-CATCHMENT-GRASS-REUNION` | `TERRAIN-FLOW-PULSE` (G4) | 0 | catchment membership; the fraction is the Jaccard index | 50000 | 0.99 |
| `PROTO-FLOW-ACCUMULATION-GRASS-REUNION` | `TERRAIN-FLOW-PULSE` (G5) | 0.05 | relative to the absolute GRASS accumulation | 50000 | 0.9 |

## Result

Recorded after the run. Nothing above this section was changed. The test is
`tests/flowPulseExternalReferences.test.ts`, run at the commit after this
protocol's (`e964ebe`), and the measured values are in
`validation/field-simulation/external-references/results/flow-pulse-external-references-v1.json`.
Every gate passed on the first run.

| Gate | Measured | Threshold | Outcome |
| --- | --- | --- | --- |
| G1, conditioned elevation | 0 mismatches in 172,702 cells (crop A outlet 65,536; crop B outlet 53,583; crop B wall 53,583); no cell unreachable in any run | 0 mismatches | pass |
| G2, depression inventory | 62 of 62 on crop A and 125 of 125 on crop B match on cell count, area, maximum fill depth and spill level; filled mask differs on 0 cells; every reference depression has one fill level | all 187, counts 62 and 125 | pass |
| G3, D8 direction | 70,098 of 70,656 cells agree, 0.99210 | at least 0.98, at least 50,000 cells | pass |
| G4, catchment | Jaccard 0.99897: Flow Pulse 72,072 cells, GRASS 72,078, both 72,038, union 72,112 (34 only in Flow Pulse's, 40 only in GRASS's) | at least 0.99, at least 50,000 cells | pass |
| G5, accumulation | 68,627 of 72,078 catchment cells within 5%, 0.95212; exact 62,693, 0.86979 | at least 0.90, at least 50,000 cells | pass |

The G3 to G5 values equal the feasibility figures of the scratch
implementation to the precision those were noted at, which is what two
steepest-descent D8 routers over the same Priority-Flood surface should give.

Of the 558 G3 disagreements, the largest groups are Flow Pulse east against
GRASS north-west (214), Flow Pulse west against GRASS north-east (118) and
Flow Pulse north against GRASS south-east (114). In each, GRASS took a
neighbour other than the unique steepest descent, as a least-cost router may.
The largest relative accumulation difference is 17,457, on a cell where Flow
Pulse routes a large upstream area through a cell to which GRASS gives a small
one.

Exploratory edge contamination (no gate). Over the 169,684 valid cells,
Flow Pulse flags 5,112 cells from 1,619 inward edge cells. All 356 cells with
negative GRASS accumulation are among them, and 4,756 flagged cells have
positive GRASS accumulation. That difference is expected: the window's edges
are a cut through a larger raster, so Flow Pulse treats ground past
them as unseen, while GRASS ran on the whole island and saw it. In the
catchment the two agree on every cell: 3 flagged by both, none by one only.

Recorded evidence, under the decision rule: `TERRAIN-FLOW-PULSE` at
E4_CROSS_IMPLEMENTATION_VALIDATED; `TERRAIN-FLOW-DEPRESSION-INVENTORY` at its
required E3_SYNTHETICALLY_VALIDATED, with conditioned mode at E4 and raw mode
not compared. No defect in Flow Pulse was found.

## Note, 2026-10-25

The count "172,702 compared cells" above and in the records counts crop B twice.
It is 172,702 cell comparisons across three runs (crop A with NoData as outlet,
65,536; crop B with NoData as outlet, 53,583; crop B with NoData as wall,
53,583), which is 119,119 distinct cells. Two scope statements follow from the
protocol text above. The Bear Creek crops were selected so that a fill computed
on the crop alone reproduces TauDEM's whole-grid fill, so they are not a random
sample of terrain. The three GRASS comparisons rest on a single window of one
catchment. The GRASS module is inferred from the output encoding, as the
references section says; the dataset does not name it. No gate, threshold,
expectation or measured value changed.
