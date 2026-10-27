# DTM median gridding at other cell sizes: protocol v2

Written and committed before any reference grid for these parameter sets was
generated or compared. It extends protocol v1 (`dtm-median-gridding-v1.md`),
whose parameter set PS-DTM-MEDIAN-CELL1-ORIGIN0 uses a 1 m cell with the origin
at (0, 0). The live DTM uses the cell size the user picks, and `rasterizeDtm`
places the origin at the minimum x and y of the ground returns. This protocol
covers that grid rule at four more cell sizes.

## Question

Does `rasterizeDtm` with `aggregation: 'median'`, given only a cell size and
deriving its own grid from the returns, give the same per-cell median as R terra
and SciPy on the same grid, for cells that hold at least one return?

## Scope

Measured cells only. Interpolated cells and ground classification are out of
scope, as in v1.

## Datasets

The same eight fixtures and the same input selection as v1 (all returns for
pc-06 to pc-08, ground-labelled returns for pc-01 to pc-05).

Every input x is shifted by +0.37 m and every y by +0.61 m (float64 addition)
before gridding, on every side. The shift moves the data minimum, and so the
grid origin, off the integer lattice.

## Grid rule (the rasterizeDtm rule)

For cell size s:

- originX = min(x), originY = min(y) over the shifted input.
- cols = floor((max(x) - originX) / s) + 1, rows = floor((max(y) - originY) / s) + 1.
- col = floor((x - originX) / s), row = floor((y - originY) / s), with an index
  equal to cols (or rows) put in the last cell.
- Extent: originX to originX + cols * s, originY to originY + rows * s.

OLV's side calls `rasterizeDtm` with `cellSizeM: s` and no grid, so its own
origin and extent logic builds the grid. The references are given the extent
and resolution computed by the rule above.

## Parameter sets

| parameterSetId | cell size | minimumComparableCells |
| --- | --- | --- |
| PS-DTM-MEDIAN-CELL0.25-ORIGINMIN | 0.25 m | 35000 |
| PS-DTM-MEDIAN-CELL0.5-ORIGINMIN | 0.5 m | 25000 |
| PS-DTM-MEDIAN-CELL2-ORIGINMIN | 2 m | 2500 |
| PS-DTM-MEDIAN-CELL5-ORIGINMIN | 5 m | 400 |

Each is summed over the eight datasets. The minimums were set from the input
alone (occupied cells less the excluded cells below), before any run.

## Edge cells

With the origin at the data minimum, returns on a lattice (pc-06 to pc-08) lie
on interior cell edges, and float rounding of `(x - originX) / s` decides their
cell differently in each implementation. That is an edge convention, not a
median question. For every leg (SciPy, terra, and the two references against
each other), any cell sharing an interior edge on which some input return lies
within 1e-9 cell widths is left out of both the value and the occupancy
comparison. The set is fixed from the input before any run, and the number left
out is reported.

## Tolerance and decision rule

Unchanged from v1, per parameter set:

- Per cell: `|OLV - fround(reference)| <= 1e-6 m`; the raw difference is
  reported alongside.
- Occupancy of the compared cells must match exactly.
- Every compared cell must pass, and at least the minimum above must be
  compared.
- A parameter set passes only when OLV agrees with terra, OLV agrees with SciPy,
  and the references agree with each other. A set that fails is reported with
  its numbers and stays out of the DTM claim's scope. The tolerance is never
  widened.

## References

R terra 1.9.46 on R 4.6.1 (`terra::rasterize`, `fun = median`) and SciPy 1.17.1
with NumPy 2.4.6 (`binned_statistic_2d`, `statistic = 'median'`, edges
originX + k * s supplied by this project), as in v1.

## Independence limits

As in v1. The grid rule given to the references is this project's rule;
agreement shows the median and binning agree under it, not that the rule is the
right one, and not accuracy against ground truth.
