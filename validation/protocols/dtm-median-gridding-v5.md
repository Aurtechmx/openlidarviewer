# DTM median gridding over a range of cell sizes: protocol v5

Written and committed before any v5 run. It reruns protocol v4
(`dtm-median-gridding-v4.md`) with the reference input and output changed and
nothing else changed.

## Why v4 failed

Protocol v4 failed its registered rule on all 50 draws. 1580 of 37012 compared
cells differed from the float32-rounded reference by one float32 step
(1.9e-6 m). Every unrounded difference was under 1e-6 m, occupancy matched,
and R terra and SciPy agreed with each other. There were two causes, both in
the reference I/O and not in the median:

1. Float32 ingest makes every even-count median the exact midpoint of two
   float32 values, a float32 tie. The reference grids were written to 9
   decimals, which moves the value just off the tie, so rounding it to float32
   could pick the neighbouring value.
2. R read the 17-digit decimal inputs with its CSV parser, which does not round
   every decimal correctly. In 10 draws, terra's grid origin was one ulp off
   OLV's.

The v4 record and its result stay as they are.

## What changes

- **Inputs to R.** `scripts/dtm-median-range-binary.py` writes each draw's
  local coordinates as little-endian float64 (`draw-NN.f64`), and checks that
  every value read back is bit-identical to the decimal it came from. R reads
  this binary with `readBin`. SciPy reads it too. The vitest checks that the
  CSV, as JavaScript parses it, is bit-identical to the binary, so all three
  sides grid the same doubles.
- **Reference outputs.** Every value, including the header origin and cell
  size, is written as a C99 hexadecimal float (`%a` in R, `float.hex` in
  Python), which is exact. The harness parses hex floats exactly and checks
  each value against the double it should equal.

## What stays the same

As in v4: the seed (20261026), the 50 draws and their sizes (log-uniform from
0.1 to 10 m, plus 0.1 m and 10 m), small and large coordinates, the committed
fixtures, the ingest rule, the grid rule, the edge rule, the tolerance
`|OLV - fround(reference)| <= 1e-6 m`, exact occupancy match, the minimum of
600 compared cells per draw, and the pass rule. Every draw must pass against R
terra and against SciPy, and the two must agree with each other.

If v5 passes, the DTM claim's measured-cell scope becomes continuous: 0.1 m to
10 m, data-minimum origin, measured cells only, including the float32 ties that
real LAS data produce. If it fails, the scope is not widened and the numbers are
reported.
