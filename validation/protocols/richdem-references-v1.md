# Flow Pulse against RichDEM's own test grids (pre-registration)

Status: preregistered on 2026-10-25. This file was written and committed
together with the six RichDEM files it names, before Flow Pulse was run on any
of them. The semantics, checks and decision rule below are fixed and are not to
be changed after results are seen. A check that fails is recorded as failed.

## What RichDEM is here

RichDEM (Richard Barnes, <https://github.com/r-barnes/richdem>, GPL-3.0) is the
library the Priority-Flood paper (Barnes, Lehman and Mulla 2014) was released
with, so for depression filling it is the original-algorithm reference that
Flow Pulse's `priorityFlood.ts` follows. It is a third implementation beside
TauDEM and GRASS GIS. Its files are used as data only: nothing from RichDEM is
built or run here. The six files, their sizes and sha256 are listed in
`validation/field-simulation/richdem-references/README.md` and registered as
`OLV-DS-122` to `OLV-DS-127`, all at commit
`9a1c97bb2529e386451a7dd54768b8b74bb4d620`.

## Semantics, read from RichDEM's tests at that commit

- `tests/tests.cpp`, "Checking depression filling", loads
  `depressions/testdem1.dem`, runs `PriorityFlood_Original`,
  `PriorityFlood_Barnes2014`, `PriorityFlood_Zhou2016`, `PriorityFlood_Wei2018`
  and `FillDepressions` (D8 topology) in turn, and requires each result to
  equal `depressions/testdem1.all.out` as a whole grid. So `testdem1.all.out`
  is a filled elevation at the exact spill level, with no gradient, and the
  grid edge drains. `NODATA_value` is 9 and no cell holds 9, so NoData plays
  no part.
- "Checking flow accumulation" runs `d8_flow_accum` on every `.d8` file in
  `flow_accum/` and requires the result to equal the matching `.out` as a
  whole grid. In `include/richdem/methods/d8_methods.hpp` each cell adds 1 for
  itself, a cell with no flow keeps what it has, flow to a cell off the grid
  is dropped, and NoData cells are NoData. That is the convention of Flow
  Pulse's `flowAccumulation`: upstream cells including the cell itself.
- `include/richdem/common/constants.hpp` gives the D8 layout `2 3 4 / 1 0 5 /
  8 7 6` with `d8x = {0,-1,-1,0,1,1,1,0,-1}` and `d8y = {0,0,-1,-1,-1,0,1,1,1}`,
  y increasing down the grid. Code 3 is therefore north, and 0 is `NO_FLOW`.
- `data/garbrecht.dem` and `data/pit.dem` are example grids that no test at
  this commit reads, and no RichDEM output for them was fetched.

## Measured characteristics of the references (reference data only)

- `testdem1.dem` to `testdem1.all.out`: 9 cells raised, none lowered, in three
  8-connected depressions of 2, 6 and 1 cells. Every one is raised from 0 to 2,
  has a single fill level of 2, and its lowest unraised neighbour is 2.
- `testdem1.d8`: every cell holds code 3 (north). `testdem1.out` holds 10 on
  the northern row, falling by one per row to 1 on the southern row.

## Flow Pulse side, fixed before the run

Grids are read with the test's own Esri ASCII parser. Rows are reversed so that
Flow Pulse's row 0 is the southern row; every index below is in Flow Pulse
order unless it says otherwise. Cell size 3 m on both axes.

## Checks against RichDEM

**R1, filled elevation.** `priorityFlood(grid, { epsilon: 'float64-step',
noData })` on `testdem1.dem`, for `noData` `wall` and `outlet` (the grid has no
NoData, so both must give the same result). `spillLevel` equals
`testdem1.all.out` on all 100 cells, and `filledCells` marks exactly the 9
cells the reference raises.

**R2, depression inventory.** From the same run, `depressionInventory(grid,
conditioned, filled, true)` lists exactly the three reference depressions:
for each, the same lowest member cell, cell count, area (cells x 9 m2),
maximum fill depth 2 and outlet elevation equal to its fill level 2.

**R3, accumulation.** A D8 routing result is built from `testdem1.d8` (code k
sends a cell to the neighbour at `d8x[k]`, `d8y[k]` in the file's
orientation; a neighbour off the grid or code 0 means no receiver) and passed
to `flowAccumulation`. `upstreamCells` equals `testdem1.out` on all 100 cells.
This checks Flow Pulse's accumulation given RichDEM's directions; it does not
check how Flow Pulse would choose the directions.

## Hand-derived checks on the example grids (not a RichDEM comparison)

**H1, `pit.dem`.** Conditioned as in R1 with NoData as a wall: one depression,
8 cells (the two rows of 5 inside the ring), each raised by 1 to a spill level
of 6, maximum fill depth 1, outlet elevation 6, area 72 m2, fill volume
(`fillDepthSum` x 9 m2) 72 m3.

**H2, `garbrecht.dem`.** Raw D8: 22 flat cells (the interior cells at 6 that
do not touch the lower edge cell at 5), 0 sinks. Conditioned as in R1: 0 flats,
0 sinks, and the one lower edge cell (row 6, column 2 counted from the north
and west) accumulates all 49 cells.

## Not matched, and why

- Garbrecht and Martz (1997) flat resolution. RichDEM implements it; Flow
  Pulse does not, and reports flats as unresolved in raw mode or tilts them by
  a Float64 step after Priority-Flood. This is a scope boundary, not a
  failure, and H2 checks only Flow Pulse's own behaviour on the grid.
- `tests/depressions/testdem1.1.out` and `testdem1.2.out`, from
  `PriorityFlood_Barnes2014_max_dep` with a depth limit. Flow Pulse has no
  depth-limited fill, and the files were not fetched.
- RichDEM's breaching test grids, from Lindsay (2016) breaching. Flow Pulse does not breach.
- The other `tests/flow_accum/test_*.d8` direction grids (one per compass
  direction). Their semantics match R3's, but they were not fetched; they would
  extend R3 without changing what it checks.
- D-infinity and the other flow metrics RichDEM offers. Flow Pulse is D8 only.

## Decision rule

- If R1, R2 and R3 pass, the result is recorded as corroboration in the claim
  register: for `TERRAIN-FLOW-PULSE`, conditioning and accumulation agree with
  RichDEM's own test expectations; for `TERRAIN-FLOW-DEPRESSION-INVENTORY`,
  the conditioned inventory matches the depressions in RichDEM's expected
  fill. No evidence level moves on these grids: they are three 10 x 10 test
  grids, and the levels already rest on larger comparisons.
- H1 and H2 are this project's hand derivations. They are recorded with the
  result and support nothing about RichDEM.
- A failed check is not re-run with a different parameter or code. A defect in
  Flow Pulse is fixed in its own commit with its own test, and this result
  stays as first measured.

## Result

Recorded after the run. Nothing above this section was changed. The test is
`tests/flowPulseRichDemReferences.test.ts`, run at the commit after this
protocol's (`d099197`). Every check passed on the first run.

| Check | Measured | Outcome |
| --- | --- | --- |
| R1, filled elevation | 0 of 100 cells differ from `testdem1.all.out`, with NoData as a wall and as an outlet; the filled mask differs on 0 cells (9 filled) | pass |
| R2, depression inventory | 3 depressions on both sides: 6, 1 and 2 cells (lowest cells 35, 43, 62 in Flow Pulse order), areas 54, 9 and 18 m2, maximum fill depth 2 and outlet elevation 2 for each, equal to the single fill level | pass |
| R3, accumulation | 0 of 100 cells differ from `testdem1.out`; no unresolved cell; 10 cells drain off the northern edge | pass |
| H1, `pit.dem` (hand) | 1 depression, 8 cells, area 72 m2, maximum fill depth 1, outlet 6, fill volume 72 m3 | pass |
| H2, `garbrecht.dem` (hand) | raw: 22 flats, 0 sinks; conditioned: 0 flats, 0 sinks, 49 cells accumulate at the lower edge cell | pass |

Recorded as corroboration under the decision rule. No evidence level moved. No
defect in Flow Pulse was found.

## Note, 2026-10-25

The first line of the "Not matched, and why" list that names RichDEM's breaching
tests (from Lindsay (2016) breaching; Flow Pulse does not breach) was reworded
after the result was recorded, in commit `bf1a4b8c0`. It named the breaching
test directory as a path, which the link check reads as a path in this
repository, and now names it in words. No check, expectation, threshold or
result changed.
