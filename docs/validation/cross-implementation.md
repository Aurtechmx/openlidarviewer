# Cross-implementation validation (E4)

The evidence model's load-bearing boundary is E3 → E4. Everything at or below
E3 is checked against our own code or our own synthetic data. **E4
(`E4_CROSS_IMPLEMENTATION_VALIDATED`) means a second, independent implementation
agrees with our output within a stated tolerance.** This page is the procedure
for producing that independent output.

Four products are at E4: **`SLOPE-RASTER`**, **`ASPECT-RASTER`**,
**`HILLSHADE`** and **`CONTOURS`**. Slope, aspect and hillshade were compared
against GDAL 3.13.1 on the same frozen analytic fixture, and against the
surface's closed-form gradient, in the same run; contours were compared against
GDAL `gdal_contour` on a separate frozen analytic tilted plane (where linear
interpolation is exact, so the tolerance measures agreement, not interpolation
noise).

| Product | Reference | Test | Cells | Max difference | Tolerance |
|---|---|---|---|---|---|
| `SLOPE-RASTER` | GDAL 3.13.1 Horn slope | `tests/slopeCrossCheck.test.ts` | 11,564 interior | under 0.001° | 0.5° |
| `ASPECT-RASTER` | GDAL 3.13.1 Horn aspect | `tests/aspectCrossCheck.test.ts` | 10,932 interior, slope above 2° | 0.0002° | 0.5° circular |
| `HILLSHADE` | GDAL 3.13.1 Horn hillshade, az 315 / alt 45 / z 1 | `tests/hillshadeCrossCheck.test.ts` | 11,564 interior | 1.00 level (8-bit); 0.0000643 vs closed form | 1.0 on 0–255 |
| `CONTOURS` | GDAL 3.13.1 `gdal_contour` | `tests/contourCrossCheck.test.ts` | 2,222 vertices | 2.9×10⁻⁵ m vs GDAL (2.0×10⁻⁷ vs closed form) | 0.05 m |

All four tolerances were registered in `REFERENCE_SLOTS` before the references
were generated. Each GDAL output, the exact command, the tool version and the
checksums are committed beside the input DEM. The three rasters share one DEM,
each pinning it by hash; contours use their own tilted-plane DEM, because on a
plane linear interpolation is exact and the tolerance measures cross-implementation
agreement rather than the interpolation error a curved surface would add.

This validates the slope, aspect, hillshade and contour *algorithms* against an
independent implementation on a known surface. It does not validate the
point-cloud-to-DTM pipeline, does not establish field or survey-grade accuracy,
and says nothing about the other terrain products — each carries its own claim
and its own evidence level.

## Hillshade agrees, but read its tolerance carefully

The hillshade figures carry a caveat the slope and aspect ones do not.

Both implementations compute the same illumination model,
`h = cos(zenith)·cos(slope) + sin(zenith)·sin(slope)·cos(azimuth − aspect)`,
over a Horn gradient, with the same compass-azimuth and altitude-above-horizon
conventions. They differ only in how they pack that intensity into a byte: we
write `round(255·h)`, GDAL writes `round(1 + 254·h)` and reserves level 0 for
nodata.

That difference is exactly `(1 − h)` levels. It is always under one level, for
any surface — which means it consumes most of a one-level tolerance budget by
itself. On this fixture it spends 0.900 of the 1.0, leaving about 0.1 of
headroom. **The ours-versus-GDAL leg on its own is therefore a weak instrument:
it would not catch a small shading error.**

What actually carries the hillshade claim is the other two results, which are
sharp:

- ours versus the closed form: max separation 0.0000643 of a level, RMSE
  0.0000072, over all 11,564 interior cells;
- and a zero-tolerance identity — re-encoding our intensity in GDAL's own scale,
  `round(1 + 254·h)`, reproduces the committed `hillshade-gdal.asc` **exactly**
  at every one of those cells.

The reported figures include the encoding difference rather than subtracting it,
so the headline number describes the two products as they ship. The application
writes `round(255·h)`; that is the encoding its rasters carry. Full detail in
`tests/fixtures/reference/hillshade/README.md`.

The check covers the single-direction model only. `computeMultiHillshade` is a
different illumination model with its own claim, unchanged by this.

Every remaining entry in `REFERENCE_SLOTS` still ships `pending`. No reference
output is bundled or fabricated; a product moves to E4 only after someone runs
the steps below and commits the real reference file.

## Aspect is a direction, and that changes the comparison

Slope is a magnitude; aspect is a bearing on a circle, undefined where the
ground is level. Three things must be handled or the comparison quietly
measures the wrong thing, and all three are handled in
`tests/aspectCrossCheck.test.ts`:

- **Circular difference.** 359° and 1° are 2° apart, not 358°. Every pair is
  folded to its shortest angular separation before any tolerance is applied.
- **Flat cells.** `gdaldem aspect` writes NODATA where it detects a flat; our
  kernel returns 0, which is a real direction (due north). Comparing those two
  would compare a value against a placeholder, so cells whose *closed-form*
  slope is at or below 2° are excluded on all three legs — and the test fails
  if GDAL wrote NODATA anywhere inside the surviving set.
- **Frame and row order.** Ours is radians in the math frame (CCW from east,
  π/2 = north) on a northing-up grid; GDAL is degrees clockwise from north;
  ASCII Grid writes the northern row first while our kernel treats row+1 as
  north. `(90 − mathDeg) mod 360` converts the frame, and the rows are flipped
  in and back out. Getting only half of either conversion right yields a
  mirrored grid that still looks like a plausible aspect raster — which is how
  the v0.4.3 north–south aspect mirror shipped (see
  `src/terrain/ground/terrainDerivatives.ts`).

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

### Slope / aspect / hillshade (GDAL)

1. Run GDAL against the **same** reference or source DEM:

   ```
   gdaldem slope reference_dtm.tif reference_slope.tif -compute_edges
   gdaldem aspect reference_dtm.tif reference_aspect.tif -alg Horn
   gdaldem hillshade reference_dtm.tif reference_hillshade.tif \
     -az 315 -alt 45 -z 1 -s 1 -alg Horn
   ```

2. Pass the sun parameters explicitly rather than relying on GDAL's defaults
   matching ours. They do today (315° / 45° / z 1), but a default that agrees
   today is not a comparison basis — if either side changed one, the two grids
   would be lit by different suns and the check would report a shading
   disagreement that is really a parameter disagreement. Then read both and
   compare with the slot tolerance (0.5° for slope, 0.5° circular for aspect,
   1 level for hillshade on 0–255).
3. For aspect, do not pass `-trigonometric` (it switches GDAL into our own
   frame and removes the conversion the check exists to test) and do not pass
   `-zero_for_flat` (it turns "no aspect" into "points north"). The full
   reasoning is in `tests/fixtures/reference/aspect/README.md`.
4. For hillshade, do not pass `-multidirectional`, `-combined` or `-igor`: each
   is a different illumination model. Note that GDAL's Byte band encodes the
   intensity as `1 + 254·h` with 0 reserved for nodata, while ours is `255·h` —
   compare the levels as they are and report the offset rather than removing
   it. See `tests/fixtures/reference/hillshade/README.md`.

### Contours (GDAL)

1. Generate the tilted-plane DEM, then run `gdal_contour` at the same interval
   the test uses:

   ```
   node scripts/make-contour-fixture.mjs
   gdal_contour -i 0.5 -a elev input-dem.asc contour-gdal.geojson
   ```

2. Use the plane fixture, not the quadratic slope DEM. Contour vertices are
   placed by linear edge interpolation on both sides, which is exact on a plane
   and only approximate on a curved surface — where the error is largest in
   low-gradient regions, so a curved DEM would fail contours for a reason that
   is not a bug. The comparison measures each of our vertices as its distance to
   the nearest GDAL contour of the same level, against the 0.05 m slot tolerance,
   and separately checks both against the analytic line so a wrong DEM or a
   half-cell georeferencing offset shows up rather than averaging into agreement.
   The full reasoning is in `tests/fixtures/reference/contour/README.md`.

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
