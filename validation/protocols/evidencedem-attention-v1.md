# EvidenceDEM attention raster, reconstruction residual and evidence tiers, v1

This record fixes every value that decides the attention level, the dominant
reason and the evidence tier of a DEM package. It was written and committed
before any attention raster or residual was computed, so no result could
shape these values. A value is not changed after results are seen. A change
is a new version of this record, with the reason written here.

## Reconstruction residual

For a measured cell (one with at least one ground return), the residual is
the absolute difference between the cell's height and the height rebuilt
without it:

- The cell is held out and rebuilt by the canonical void fill rule (the
  geodesic fill) from its measured 8-neighbours only: the fill runs on the
  window of the cell and its neighbours inside the grid, with a search
  radius of one cell.
- A cell with no measured 8-neighbour has no residual (NoData).
- Interpolated cells have no residual.
- Sampling: when the grid has 250,000 measured cells or fewer, every measured
  cell is rebuilt. Otherwise every k-th measured cell in row-major order is
  rebuilt, starting with the first, where k = ceil(n / 250,000) and n is the
  number of measured cells. k is recorded in the passport. Cells not sampled
  have no residual.

The residual is in the vertical unit of the DEM. It shows how well a cell's
height is predicted by its neighbours. It is not a measure of how close the
height is to the ground.

## Attention inputs

Each input is normalised to a score between 0 and 1, clipped at both ends.

| Input | Score |
| --- | --- |
| `LONG_INTERPOLATION` | interpolation distance in cells / 3 (3 is the existing edge risk distance) |
| `LOW_SUPPORT` | 1 - cell confidence / 33, confidence on its 0 to 100 scale (33 is the existing low confidence threshold) |
| `EDGE_AFFECTED` | 1 when the cell state is edge affected, else 0 |
| `MODEL_SENSITIVITY` | sensitivity range / R, only when the sensitivity raster was requested |
| `RECONSTRUCTION_RESIDUAL` | residual / R |

R = 0.30 m. When the vertical unit is feet, R is 0.30 m expressed in feet.
When the vertical unit is unresolved, R has no value in the file's unit, so
`MODEL_SENSITIVITY` and `RECONSTRUCTION_RESIDUAL` are not scored.

`TERRAIN_COMPLEXITY` and `CLASSIFICATION_AMBIGUITY` are not scored in v1.

## Attention level

The score of a cell is the highest of its input scores. There is no weighted
blend.

| Score | Level |
| --- | --- |
| below 0.33 | 0 none |
| 0.33 to below 0.67 | 1 low |
| 0.67 to below 1.0 | 2 medium |
| 1.0 | 3 high |

## Dominant reason

The input that set the highest score. Ties go to the input listed first in
this order: `LONG_INTERPOLATION`, `LOW_SUPPORT`, `EDGE_AFFECTED`,
`MODEL_SENSITIVITY`, `RECONSTRUCTION_RESIDUAL`, `TERRAIN_COMPLEXITY`,
`CLASSIFICATION_AMBIGUITY`, `UNRESOLVED`.

A cell at level 0 has no dominant reason, except on a package whose vertical
unit or CRS is unresolved, where a level 0 cell carries `UNRESOLVED`: the
vertical inputs could not be scored there.

## Evidence tiers

A tier states what the package contains. It reflects only evidence that was
actually computed.

| Tier | The package contains |
| --- | --- |
| T0 | the DEM raster |
| T1 | T0 and a passport binding source, method, parameters and build |
| T2 | T1 and the terrain evidence raster |
| T3 | T2, the sensitivity raster and the attention raster with the residual |

The sensitivity raster is off by default, so a default export is T2. T3 is
reached only when the sensitivity raster was requested. The passport then
states how many ensemble members produced a grid different from the
canonical run, because a member can repeat the canonical run (see
`evidencedem-sensitivity-ensemble-v1.md`), and T3 should not be read as a
stronger test than was run.

T4 (independent checkpoints) is not reachable from the point cloud and is not
part of this record.
