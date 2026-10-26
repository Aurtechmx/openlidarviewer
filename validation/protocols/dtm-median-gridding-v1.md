# DTM median gridding on measured cells: protocol v1

Written and committed before any reference grid was generated or compared.
The JSON protocol records and study manifests that follow cite the commit that
adds this file as the freeze witness.

## Question

Does `rasterizeDtm` with `aggregation: 'median'` (the live DTM setting,
`LIVE_DTM_AGGREGATION`) give the same per-cell median as two independent
implementations, on the same points and the same grid, for cells that hold at
least one return?

## Scope

- Measured cells only: cells that received at least one return.
- Interpolated (IDW fill) cells are out of scope. `rasterizeDtm` does not fill;
  the fill runs later, and nothing here says anything about it.
- Ground classification is out of scope. The scattered scenes use the ground
  labels the generator wrote (`.truth`), not the ground filter.

## Datasets

All are the committed seeded fixtures under
`validation/cross-implementation/pdal-pipeline/fixtures/`, unchanged.

| datasetId | file | input |
| --- | --- | --- |
| OLV-DS-012-PC-BARE-PLANE | pc-06-bare-plane.csv | all returns (one per cell) |
| OLV-DS-013-PC-BARE-ROLLING | pc-07-bare-rolling.csv | all returns (one per cell) |
| OLV-DS-014-PC-BARE-RIDGE | pc-08-bare-ridge.csv | all returns (one per cell) |
| OLV-DS-007-PC-PLANE-BUILDINGS | pc-01-plane-buildings.csv | ground-labelled returns |
| OLV-DS-008-PC-ROLLING-BUILDINGS | pc-02-rolling-buildings.csv | ground-labelled returns |
| OLV-DS-009-PC-RIDGE-BUILDINGS | pc-03-ridge-buildings.csv | ground-labelled returns |
| OLV-DS-010-PC-PLANE-LOWBLUNDERS | pc-04-plane-lowblunders.csv | ground-labelled returns |
| OLV-DS-011-PC-PLANE-GAP | pc-05-plane-gap.csv | ground-labelled returns |

The three cell-centred scenes repeat the grid check of the min-return study
with one return per cell, where the median is that return. The five scattered
scenes carry several returns per cell (even and odd counts) and empty cells
(under buildings and in the pc-05 gap), so they exercise the median itself and
the occupancy mask.

## Parameter set PS-DTM-MEDIAN-CELL1-ORIGIN0

- Cell size 1 m. Grid origin (0, 0). 50 columns by 50 rows. Vertical axis z.
- Cell index: `col = floor((x - 0) / 1)`, `row = floor((y - 0) / 1)`. A return
  on an interior cell edge belongs to the cell with the higher index. A return
  on the far edge (x = 50 or y = 50) belongs to the last cell.
- Median of an even count is the mean of the two middle values.
- An empty cell is NoData on every side.

## References

1. **R terra 1.9.46 on R 4.6.1.** `terra::rasterize(vect(points), rast(ext,
   res, crs), field = 'z', fun = median)` with extent (0, 50, 0, 50) and
   resolution 1. terra builds the grid from the extent and resolution and
   assigns each point to a cell with its own lookup, so the binning and the
   median are both terra's. This is the independent reference.
2. **SciPy 1.17.1 with NumPy 2.4.6.**
   `scipy.stats.binned_statistic_2d(x, y, z, statistic='median', bins=[edges,
   edges])`, with edges 0, 1, ..., 50 supplied by this project. SciPy computes
   the median and the bin assignment, but the bin edges, the fixtures and the
   comparison harness are this project's own. It is the weaker reference.

Each reference is compared with OLV separately. Each must pass on its own.
The two references are also compared with each other under the same rule.

terra numbers rows from the top, so its rule for a return lying exactly on an
interior horizontal edge may differ from the rule above. That is an edge
convention, not a median question. For the terra leg only, any cell sharing an
edge on which some input return lies exactly (fixed from the input before any
run) is left out of both the value and the occupancy comparison, and the number
left out is reported. The SciPy leg compares every cell.

## Tolerance and decision rule

- Per cell: `|OLV - fround(reference)| <= 1e-6 m`, where `fround` rounds the
  reference to float32. OLV stores the DTM as float32; at 100 to 115 m one
  float32 step is about 7.6e-6 m, so comparing against the unrounded value would
  measure storage, not the median. The raw difference `|OLV - reference|` is
  reported alongside.
- Occupancy: the set of cells with data must match exactly. Any mismatch fails.
- `requiredWithinToleranceFraction` 1: every compared cell must pass.
- `minimumComparableCells` 15000 per reference, summed over the eight datasets.
- Pass on both references, and the references agreeing with each other: the
  study reports agree. Anything else reports the failure with its numbers and
  the claim register is not changed. The tolerance is never widened.

## Independence limits

The fixtures and the comparison harness are this project's own for both legs.
terra does its own binning and median. SciPy does its own median and bin
assignment over edges this project supplies. Agreement with either is not
accuracy against ground truth.
