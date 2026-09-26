# EvidenceDEM sensitivity ensemble, v1

This record fixes the model ensemble behind the DEM sensitivity raster
(`terrain_sensitivity.tif`). It was written and committed before any
sensitivity raster was computed, so no result could shape which members are
in it. A member is not added, dropped or changed after results are seen. A
change to the ensemble is a new version of this record, with the reason
written here.

## What the raster measures

For each cell, the spread of the terrain height across the members below,
each run over the same input points and the same grid.

- Band 1 `sensitivity_range`: the highest member height minus the lowest, in
  the vertical unit of the DEM.
- Band 2 `sensitivity_members`: how many members produced a height for the
  cell.

This is model sensitivity. A low value means the listed choices agree at that
cell. It does not mean the height there is correct, and the raster makes no
claim about how close any height is to the ground.

## Members

| Member | Configuration |
| --- | --- |
| 0 | The canonical configuration: the same settings that produced the DEM. |
| 1 | The canonical configuration with the ground filter slope parameter set to 0.15. |
| 2 | The canonical configuration with the ground filter slope parameter set to 0.2. |
| 3 | The canonical configuration with inverse distance weighting as the void fill rule, in place of the canonical geodesic fill. |

No member changes the cell size.

The ground filter documents its slope parameter only as non-negative, with no
upper bound. Members 1 and 2 therefore use the two slope values the viewer
already ships as defaults in its own code paths, 0.15 and 0.2, rather than
end points chosen for this raster. The terrain analysis default is 0.2, so
member 2 repeats member 0 unless the analysis ran with a different slope.

When the analysis uses the source ground classification instead of the
ground filter, the slope parameter has no effect, so members 1 and 2 repeat
member 0 and only member 3 can differ.

## Default

Off. The DEM package includes the raster only when it is requested, because
it costs three extra terrain runs. The evidence raster (`terrain_evidence.tif`)
stays on by default and is not affected by this record.

## Refusal

Every member must produce a grid with the same origin, cell size, column and
row count as member 0. If any member does not, no sensitivity raster is
written and the reason is stated. A run that is cancelled writes nothing.
