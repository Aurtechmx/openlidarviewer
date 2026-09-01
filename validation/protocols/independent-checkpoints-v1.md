# Independent-checkpoint vertical accuracy, v1

This is a narrative protocol note, not a `.protocol.json` record: it documents
`tests/support/checkpointGdb.ts` and `tests/independentCheckpointHarness.test.ts`,
the harness that pairs a point-cloud tile against USGS 3DEP survey checkpoints.
It does not itself gate a frozen claim comparison (see
`validation/protocols/README.md` for that machinery); it is the reference for
what the harness checks and reports.

## Why this is the path to E5

Every DTM accuracy figure this project has produced so far is either synthetic
(ground truth known by construction) or cross-implementation agreement against
another algorithm (PDAL, GDAL). Both are useful and neither is physical
accuracy: two programs computing the same wrong answer agree perfectly.
Independent survey checkpoints (145,299 of them, public domain, in the USGS
3DEP checkpoint database) are observations nothing in this project produced or
tuned against. Comparing OLV's output to them is the one comparison that can
move a claim from "consistent with another implementation" to "consistent with
where the ground actually is."

## Inputs

- A point-cloud tile (LAS/LAZ) with a known horizontal and vertical EPSG.
- The 3DEP checkpoint FileGDB, queried by `ogr2ogr` for the rows whose
  `project_id` covers that tile's flight project.
- Per checkpoint: `source_easting`/`source_northing`/`source_elevation`,
  `source_horizontal_epsg`/`source_vertical_epsg`, `accuracy`, `point_type`.

## Fail-closed prerequisites

`checkpointPrerequisites()` refuses to report a figure unless, in order:

1. at least one project checkpoint falls inside the tile's horizontal extent;
2. of those, at least one shares the tile's horizontal AND vertical EPSG (a
   checkpoint surveyed in a different datum is excluded rather than silently
   reprojected);
3. of those, the checkpoint states an accuracy/uncertainty value;
4. of those, the checkpoint states a `point_type` (NVA/VVA), the field marking
   it as an independent survey observation;
5. the surviving count is at least `MIN_CHECKPOINT_SAMPLE_SIZE` (20).

Every failing check is reported with its own reason string; the gate does not
stop at the first failure, and nothing partial is computed when it is closed.

## Statistics reported

Once the gate passes, `src/validation/checkpointAccuracy.ts` (the existing,
already-tested accuracy engine, reused here rather than reimplemented) computes
the following pooled and per-stratum, over signed residuals `measured − reference`:
bias (mean residual), RMSE (root mean square residual), median, NMAD
(1.4826 × median absolute deviation from the median), P90 and P95 of the
absolute residual, the maximum absolute residual, and a 95% confidence interval
on the bias (normal approximation).

`tests/support/checkpointGdb.ts` adds MAE (mean absolute residual), which
`checkpointAccuracy()` does not report, computed directly from the same
residuals.

## Two separate pathways

Pathway A rasterises the official (producer) class-2 ground returns directly
into an OLV DTM via `DtmSurfaceModel`, sampled at each checkpoint. This measures
OLV's surface builder against survey truth, holding the ground labelling fixed
to a source OLV did not classify.

Pathway B runs raw, unclassified points through OLV's own ground classifier,
then rasterises the same way.

The gap between pathway A and pathway B accuracy figures is the ground
classifier's own accuracy penalty, isolated from the surface builder's. The
harness currently exercises pathway A; pathway B is future work using the same
gate and the same statistics.

## Reference fixture

`USGS_LPC_OR_RogueSiskiyouNF_2019_B19_10TDM3746.laz` (project_id `182543`) has
0 of that project's 70 checkpoints inside its own extent, verified by direct
query. Running the harness against it exercises the fail-closed
"insufficient checkpoints" branch, not a reported accuracy figure.
