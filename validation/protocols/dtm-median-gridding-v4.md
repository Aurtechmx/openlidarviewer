# DTM median gridding over a range of cell sizes: protocol v4

Written and committed, with the fixture generator and the fixtures it writes,
before any reference grid for this study was generated or compared. Protocols
v2 and v3 covered five fixed cell sizes. This study asks whether the same
agreement holds over the continuous range 0.1 m to 10 m, on random origins and
on both small and large (UTM-style) coordinates.

## Question

Does `rasterizeDtm` with `aggregation: 'median'`, given only a cell size and
deriving its own grid from the data minimum, give the same per-cell median as
R terra and SciPy on the same grid, for measured cells, at every drawn cell
size?

## Draws

`scripts/dtm-median-range-fixtures.py` generates everything from one seed. It
uses its own SplitMix64 generator in pure Python, so the draws depend only on
the seed.

- Seed 20261026.
- 50 draws. Draws 0 to 47 take a cell size s = 0.1 · 100^u with u uniform on
  [0, 1), which is log-uniform on [0.1, 10) m. Draw 48 is 0.1 m and draw 49 is
  10 m, so both ends of the range are tested exactly.
- Even draws use large coordinates: easting 500000 + 1000·u m, northing
  4000000 + 1000·u m. Odd draws use small coordinates: 100·u m on each axis.
  The fractional base is a random origin offset for every draw.
- Each draw fills a nominal 30 × 30 block of cells of size s from that base.
  A 6 × 6 block at a random position is left empty. Every other nominal cell
  gets 0 returns with probability 0.15, otherwise 1 to 5 returns (uniform),
  placed uniformly in the cell. Elevation is
  100 + 8 sin(i/7) + 5 cos(j/5) plus uniform noise of ±0.25 m. The grid OLV
  builds starts at the data minimum, not at the nominal block, so its cells
  hold several returns, single returns and none.

## Ingest rule

The coordinates are put through OLV's LAS ingest (`src/io/lasDataOrigin.ts`,
`loadLas.ts`). Each world value is stored as an integer at a 0.001 m scale with
an integer offset, decoded as int · 0.001 + offset in float64. The load origin
is the floored minimum on each axis, and the local coordinate is
float32(world − origin). The fixture files hold those local values exactly.
OLV and both references grid the same local values, which is what the terrain
pipeline receives.

## Grid rule, edge rule, tolerance

As in v2:

- Origin at the minimum local x and y, cols = floor((max − min)/s) + 1, and
  likewise for rows. OLV gets only `cellSizeM` and builds the grid itself. The
  references are given the extent from that rule.
- Any cell sharing an interior edge on which an input return lies within 1e-9
  cell widths is left out of every leg. The set is fixed from the input, and the
  count left out is reported. On these fixtures the count is 0.
- Per cell: |OLV − fround(reference)| ≤ 1e-6 m. Occupancy of the compared
  cells must match exactly.
- Every draw must compare at least 600 cells. The fewest any draw has, counted
  from the input before any run, is 715.

## Decision rule

The study passes only if every one of the 50 draws passes against R terra,
passes against SciPy, and the two references agree with each other under the
same rule. If any draw fails, the scope is not widened. The failing draws are
reported with their numbers, and the cause is diagnosed (an edge tie or a float
index difference). The tolerance is never widened.

If the study passes, the DTM claim's measured-cell scope becomes a continuous
range: cell sizes 0.1 m to 10 m inclusive, data-minimum origin, measured cells
only.

## References

R terra 1.9.46 on R 4.6.1 and SciPy 1.17.1 with NumPy 2.4.6, called as in v2.

## Independence limits

As in v2. The fixtures, the ingest emulation, the grid rule given to the
references and the comparison harness are this project's own. Agreement over
50 draws is evidence about the range. It does not prove every size in the range,
and it is not accuracy against ground truth.
