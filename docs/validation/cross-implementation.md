# Cross-implementation validation (E4)

The evidence model's load-bearing boundary is E3 → E4. Everything at or below
E3 is checked against our own code or our own synthetic data. **E4
(`E4_CROSS_IMPLEMENTATION_VALIDATED`) means a second, independent implementation
agrees with our output within a stated tolerance.** This page is the procedure
for producing that independent output.

One product is at E4: **`SLOPE-RASTER`**. Our Horn slope was compared against
GDAL 3.13.1's Horn slope on the frozen analytic fixture in
`tests/fixtures/reference/slope/`, and against the surface's closed-form
gradient, in the same run (`tests/slopeCrossCheck.test.ts`). All three agreed
to within a maximum of 0.001 degree over 11,564 interior cells, well inside the
0.5 degree tolerance registered before the reference was generated. The GDAL
raster, the exact command, the tool version and the checksums are committed
beside the input DEM.

This validates the slope *algorithm* against an independent implementation on a
known surface. It does not validate the point-cloud-to-DTM pipeline, does not
establish field or survey-grade accuracy, and says nothing about the other
terrain products — each carries its own claim and its own evidence level.

Every other entry in `REFERENCE_SLOTS` still ships `pending`. No reference
output is bundled or fabricated; a product moves to E4 only after someone runs
the steps below and commits the real reference file.

## Why this is not automated in CI

PDAL, GDAL, and CloudCompare are native tools with heavy dependencies; they do
not run in the browser or in the pure-data test sandbox. The comparison maths
runs in CI (the `crossCheck` unit tests); generating the reference output is a
manual, documented step run once per fixture on a workstation.

## What you need

- A small, public, redistributable point cloud with known provenance (for
  example a USGS 3DEP tile). Record its source and licence next to the fixture.
- PDAL (`pdal`) and GDAL (`gdalinfo`, `gdaldem`) on the workstation, or
  CloudCompare for the ground-filter comparison.

## Procedure per product

The goal is a reference raster on the **same grid** as ours (same origin, cell
size, extent, and row order), so the two can be compared cell for cell.

### DTM / DSM (PDAL)

1. Export our DTM/DSM for the fixture as an Esri ASCII Grid or GeoTIFF, and note
   its origin, cell size, and dimensions.
2. Produce the reference on the identical grid, e.g. for a DTM:

   ```
   pdal translate input.laz reference_dtm.tif \
     --writers.gdal.resolution=<cell_m> \
     --writers.gdal.output_type=idw \
     --writers.gdal.origin_x=<x0> --writers.gdal.origin_y=<y0> \
     --writers.gdal.width=<cols> --writers.gdal.height=<rows>
   ```

3. Read both grids in row order, align NODATA, and pass them to `crossCheck`
   with the tolerance from the product's `ReferenceSlot` (0.05 m for DTM/DSM).

### Slope / hillshade (GDAL)

1. Run GDAL against the **same** reference or source DEM:

   ```
   gdaldem slope reference_dtm.tif reference_slope.tif -compute_edges
   gdaldem hillshade reference_dtm.tif reference_hillshade.tif -az 315 -alt 45
   ```

2. Match GDAL's azimuth/altitude to ours (315° / 45° by default), read both, and
   compare with the slot tolerance (0.5° for slope, 1 DN for hillshade on 0–255).

### Ground filter (CloudCompare or PDAL SMRF)

1. Run an independent ground classifier (PDAL `filters.smrf`, or CloudCompare's
   CSF) on the fixture.
2. Compare the per-point ground/non-ground labels against ours. Tolerance is 0
   (exact class), reported as agreement fraction rather than RMSE.

## Recording the result

When a reference is generated:

1. Commit the reference file under `tests/fixtures/reference/` with a short
   `README` naming the tool, version, command, and the source cloud's licence.
2. Flip that slot's `status` from `pending` to `supplied` in `REFERENCE_SLOTS`.
3. Add a test that loads both grids and asserts the `crossCheck` verdict.
4. If the verdict is `agree`, raise the claim's `currentEvidence` to
   `E4_CROSS_IMPLEMENTATION_VALIDATED` and set `externalValidationStatus:
   partial` in `claim-register.yaml`, citing the reference tool and version.
   If it is `disagree`, leave the claim where it is and open an issue with the
   `crossCheck` report; do not promote.

## What E4 does and does not mean

E4 means two independent implementations agree. It does **not** mean either one
is correct against the physical world; that is E5 (field ground truth). A DTM
that matches PDAL within 5 cm still carries no survey certification. Keep the
field-validation caveats in place after any E4 promotion.
