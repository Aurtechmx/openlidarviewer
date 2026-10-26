# Depression inventory across the TF fixture set (pre-registration)

Status: preregistered on 2026-10-25. This file, the five constructed grids,
the Python oracle and its expected records were committed together, before the
depression inventory was run on the constructed grids or compared with the
records. The expected values, checks and decision rule below are fixed and are
not to be changed after results are seen. A check that fails is recorded as
failed.

## Why

`TERRAIN-FLOW-DEPRESSION-INVENTORY` was checked against hand-derived values on
one fixture (the TF-2 notched bowl) and a constructed two-depression grid. Its
`requiredEvidenceNote` names the missing step: the whole TF-1 to TF-8 fixture
set the routing claim already uses. The TauDEM comparison in
`flow-pulse-external-references-v1.md` has since met the required E3 for
conditioned mode on real terrain. This study is the synthetic-suite check the
note asked for, and adds the edge cases that real crops did not contain: nested
depressions, corner-only contact, a depression open to the border, an enclosed
NoData hole, non-square cells, an unresolved horizontal scale, and the exported
raster's orientation.

## Grids

- The eight fixtures in `validation/field-simulation/fixtures/`: TF-1
  `plane-east`, TF-2 `bowl-notched`, TF-3 `ridge`, TF-4 `valley-v`, TF-5
  `flat-plateau-outlet`, TF-6 `anisotropic`, TF-7 `nodata-barrier`, TF-8
  `sl-field-real-terrain`.
- Five constructed grids in `validation/field-simulation/depression-cases/`:
  `nested-saddle`, `diagonal-contact`, `boundary-opening`, `nodata-hole`,
  `anisotropic-bowl`.

Grids are used as stored. The fill and the inventory do not depend on which row
is south, and every index is row-major over the stored grid.

## Expected values

For every grid, `validation/field-simulation/oracle/depression_oracle.py`
computes the expected figures from the definition, with NoData read as a wall
and as an outlet, and writes them to
`validation/field-simulation/expected-depressions/`. It is written in Python
from the published method and the documented conventions, not from the
TypeScript. It is still this project's code: agreement checks the arithmetic
and the bookkeeping, and a misreading of the method shared by both would
survive it.

Every grid except TF-8 was also derived by hand, and the oracle reproduces each
of these:

| Grid | Depressions (wall) | Lowest cell, cells, deepest fill, spill = outlet | Fill volume | Outlet mode |
| --- | --- | --- | --- | --- |
| TF-1 `plane-east`, TF-3 `ridge`, TF-4 `valley-v`, TF-6 `anisotropic`, TF-7 `nodata-barrier` | 0 | | 0 | 0 |
| TF-5 `flat-plateau-outlet` | 0: the interior is level with its spill level, not below it | | 0 | 0 |
| TF-2 `bowl-notched` | 1 | 12, 1 cell, 4, 4 | 4 m3 | same |
| `nested-saddle` | 1: both pits, the saddle and the ring fill to the notch | 8, 15 cells, 5, 6 | 23 m3 | same |
| `diagonal-contact` | 1: corner contact joins under 8-connectivity | 5, 2 cells, 8, 9 | 16 m3 | same |
| `boundary-opening` | 0: water leaves over the border cell at 1 | | 0 | 0 |
| `nodata-hole` | 1: the eight cells around the hole fill to the rim | 6, 8 cells, 6, 9 | 34 m3 | 0: every cell beside the hole is an exit |
| `anisotropic-bowl` (2 m x 3 m cells) | 1 | 12, 1 cell, 4, 6 | 24 m3 (area 6 m2) | same |

TF-8 has no hand derivation. The oracle gives 34 depressions holding 123 cells
with NoData as a wall, and 8 holding 12 cells with NoData as an outlet. Every
TF-8 depression has one fill level, equal to its outlet elevation.

## Checks

Per grid and per NoData reading, with `priorityFlood(grid, { epsilon:
'float64-step', noData })`, `filledCells` and `depressionInventory(grid,
conditioned, filled, true)`:

1. Unreachable cells, depression count and filled cell count equal the record,
   and `cellsRaised` equals the filled cell count.
2. Extent: for each expected depression, the 8-connected component of the
   filled mask that contains its lowest cell has exactly the expected members.
3. Cell count equals the record; `areaM2` equals cell count times
   `cellMetresX x cellMetresY`.
4. `maxFillDepth` equals the record exactly.
5. The set of `spillLevel` values over the depression's cells equals the
   record exactly.
6. `outletElevation` equals the record exactly.
7. Fill volume: `fillDepthSum` times the cell area equals the record's total
   within 1e-9. The inventory reports no per-depression volume, so the per
   depression volumes in the records are a reference for a later change, not
   compared here.

Also:

8. Unresolved horizontal scale: `runFlowPulse` on TF-2 with a projected scale
   whose `resolved` is false reports the depression with its cell count and
   depth, and `areaM2`, `largestAreaM2` and `contributingAreaM2` are null.
9. Round trip: a 3 x 4 grid with distinct values, run raw and written with
   `buildFlowPulsePackage` at world origin (1000, 2000) and grid frame offset
   (10, 20) with 2 m cells, gives an accumulation `.asc` whose header reads
   `ncols 4`, `nrows 3`, `cellsize 2`, `xllcorner 1010`, `yllcorner 2020` (the
   lower-left corner of the lower-left cell, not its centre), and whose first
   text row holds the northern row (Flow Pulse's last row), cell for cell.

## Decision rule

- If every check passes, `TERRAIN-FLOW-DEPRESSION-INVENTORY` keeps
  E3_SYNTHETICALLY_VALIDATED with this study added to its support, and its
  approvedClaim states what was checked here. The claim is already at its
  required E3 from the TauDEM comparison, so this study cannot raise it
  further; it closes the gap its `requiredEvidenceNote` names.
- If any check fails, the failure is recorded, the cause is investigated, and
  nothing in this file is changed. A defect in Flow Pulse is fixed in its own
  commit with its own test.

## Not covered

- Raw mode beyond the sink count: the raw inventory lists D8 sinks, which the
  routing claim's fixtures already check.
- A depression whose filled component holds more than one fill level. None of
  these grids has one, so the reported outlet elevation for such a component is
  untested.
- Per-depression fill volume, which the inventory does not report.
- Accuracy against the ground. Every grid here is synthetic or this project's
  own crop.

## Result

Recorded after the run. Nothing above this section was changed. The test is
`tests/flowDepressionInventorySuite.test.ts`, run at the commit after this
protocol's (`ac2fc67`). All checks passed on the first run (41 test cases).

| Grid | Wall: depressions, cells, fill volume | Outlet: depressions, cells, fill volume |
| --- | --- | --- |
| TF-1, TF-3, TF-4, TF-5, TF-6, TF-7 | 0 | 0 |
| TF-2 `bowl-notched` | 1, 1, 4 m3 | 1, 1, 4 m3 |
| TF-8 `sl-field-real-terrain` | 34, 123, 6.905701 m3 | 8, 12, 0.298096 m3 |
| `nested-saddle` | 1, 15, 23 m3 | 1, 15, 23 m3 |
| `diagonal-contact` | 1, 2, 16 m3 | 1, 2, 16 m3 |
| `boundary-opening` | 0 | 0 |
| `nodata-hole` | 1, 8, 34 m3 | 0 |
| `anisotropic-bowl` | 1, 1, 24 m3 (area 6 m2) | 1, 1, 24 m3 |

On every grid and in both readings the extent of each depression, its cell
count, area, deepest fill, spill level and outlet elevation equal the record
exactly, no cell is unreachable, and `cellsRaised` equals the filled cell count.

Unresolved horizontal scale: TF-2 reports one depression of 1 cell, deepest
fill 4 and outlet 4, with `areaM2`, `largestAreaM2` and `contributingAreaM2`
all null.

Round trip: the accumulation `.asc` reads `ncols 4`, `nrows 3`, `cellsize 2`,
`xllcorner 1010`, `yllcorner 2020`, with text rows `1 1 1 1`, `2 2 2 2` and
`12 9 6 3`, which are Flow Pulse's rows 2, 1 and 0. The northern row comes
first and the corner is the cell edge, so there is no flip and no half-cell
shift.

Recorded evidence, under the decision rule: `TERRAIN-FLOW-DEPRESSION-INVENTORY`
stays at E3_SYNTHETICALLY_VALIDATED, now with the full fixture set behind it.
No defect in Flow Pulse was found.
