# DTM median gridding at 1 m with the data-minimum origin: protocol v3

Written and committed before any reference grid for this parameter set was
generated or compared. It adds one parameter set to protocol v2
(`dtm-median-gridding-v2.md`): the default 1 m cell with the grid origin at the
data minimum, as `rasterizeDtm` builds it. Protocol v1 covered 1 m cells only
with the origin at (0, 0), which no live DTM uses.

Everything else is v2 unchanged: the eight fixtures and input selection, the
(+0.37, +0.61) m input shift, the grid rule, the edge-cell rule applied to every
leg, the references (R terra 1.9.46 on R 4.6.1, SciPy 1.17.1 with NumPy 2.4.6),
the tolerance `|OLV - fround(reference)| <= 1e-6 m`, exact occupancy match,
every compared cell passing, and both references agreeing with each other.

## Parameter set

| parameterSetId | cell size | minimumComparableCells |
| --- | --- | --- |
| PS-DTM-MEDIAN-CELL1-ORIGINMIN | 1 m | 10000 |

The minimum is summed over the eight datasets and was set from the input alone
(occupied cells less the excluded edge cells), before any run. If the set
fails, it is reported with its numbers and stays out of the DTM claim's scope;
the tolerance is never widened.
