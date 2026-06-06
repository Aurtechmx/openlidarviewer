# Terrain Validation Matrix

This page maps each terrain product to **how it is validated** and to the
test that proves it. The goal is honesty: every claim about a terrain
product is backed by a deterministic, pure-data test against a known answer,
an interoperability check, or a documented manual step.

Validation methods used below:

- **Known-truth fixture** — a synthetic surface with an analytically known
  elevation function (`tests/fixtures/terrainScenes.ts`); the product is
  asserted against the closed-form answer within a documented tolerance.
- **Held-out RMSE / calibration** — ground returns are withheld, the
  vertical residual at the withheld points is measured, and the reported
  confidence is checked against that measured error.
- **Interop / format check** — the exported bytes are parsed back and the
  header, geo-tags, row order, and NODATA handling are asserted against the
  format spec.
- **Analytic check** — a closed-form value (e.g. Lambert shading, Horn
  slope) is pinned exactly.

All terrain tests are pure-data (no DOM, no three.js, no I/O) and
deterministic. Run them with `npx vitest run`.

## Matrix

| Terrain product | How it is validated | Test file(s) | Status |
|---|---|---|---|
| Ground filter (SMRF) | Known-truth fixture: ground recall and non-ground (building/canopy) rejection bars, plus DTM RMSE on interior cells; a sparse + steep variant reports recall rather than gating it | `tests/groundFilterValidation.test.ts`, `tests/groundFilter.test.ts` | Production |
| DTM (bare-earth grid) | Known-truth fixture: covered cells asserted against the analytic elevation (flat / slope / hill / pit / ridge / valley / terrace), gaps left empty or interpolated — never fabricated | `tests/terrainTruth.dtm.test.ts` | Production |
| DSM (top surface) | Known-truth fixture: DSM equals the top surface (roof over building, canopy top over trees) on classified overlay scenes | `tests/terrainTruth.surface.test.ts` | Production |
| CHM (canopy height, DSM − DTM) | Known-truth fixture for the height-above-ground field; reconstruction logic (DSM = DTM + canopy, nodata preserved) checked directly | `tests/terrainTruth.surface.test.ts`, `tests/dsmChm.test.ts` | Production |
| Slope (Horn) | Analytic check: flat ≈ 0°, uniform slope = atan(gradient) on interior cells | `tests/terrainTruth.surface.test.ts` | Production |
| Hillshade (ESRI illumination) | Analytic check: exact flat-plane Lambert value at a known sun altitude, and the brighter/darker ordering for N/E/S/W-facing slopes under a fixed azimuth | `tests/terrainTruth.hillshade.test.ts` | Production |
| Hold-out RMSE / vertical accuracy | Held-out RMSE against analytic surfaces where the true error is known; ASPRS NVA/VVA derivation and honest formatting | `tests/holdoutRmse.test.ts`, `tests/verticalAccuracy.test.ts` | Production |
| Confidence calibration | Fit + apply a monotonic calibration map; the calibration check guards both pass and fail directions plus the not-assessable case | `tests/calibrateConfidence.test.ts`, `tests/calibrationCheck.test.ts` | Production |
| Terrain Assessment (four statuses) | Exercised end to end through the contour pipeline and surface fixtures; statuses are derived purely from the quality report, score, metrics, and coverage so they cannot disagree with the numbers shown | `tests/analyseContours.test.ts`, `tests/contourPipeline.integration.test.ts` | Production |
| Contours (evidence-graded) | Known-truth + integration: marching-squares output, stitching, styling, and feature model on synthetic surfaces; grade (solid / dashed / gap) tracks supporting confidence | `tests/contoursAt.test.ts`, `tests/stitchContours.test.ts`, `tests/contourStyle.test.ts`, `tests/contourFeatureModel.test.ts`, `tests/contourPipeline.integration.test.ts` | Production |
| DEM export — Esri ASCII Grid | Interop check: header fields, north-row-first ordering, NODATA for empty cells | `tests/demExport.test.ts` | Production |
| DEM export — GeoTIFF | Interop check: valid little-endian TIFF, expected raster + geo tags, north-row-first, NODATA; EPSG propagated into every GeoTIFF; full package (DTM/DSM/CHM `.asc` + `.tif` + `.prj` + README) bundled | `tests/demExport.test.ts` | Production |
| CRS / datum warnings | Propagation check: known CRS+datum emit no warning and carry a GeoJSON `crs` member; unknown CRS/datum surface the exact pinned warning and propagate into export metadata; vertical-datum detection, compound-CRS WKT, LAS GeoKey fidelity, `.prj` sidecar | `tests/crsDatumWarnings.test.ts`, `tests/crsVerticalHardening.test.ts` | Production |
| Profiles (cross-section) | Known-truth fixture: sampled (distance, height) polyline asserted against the analytic surface; height sampler, civil stats, stationing, and chart bounds covered | `tests/profileAnalyticalFixtures.test.ts`, `tests/profileSampler.test.ts`, `tests/civilProfileStats.test.ts`, `tests/profileStations.test.ts` | Production |
| Measurements (distance / area / height / angle / slope / volume) | Analytic check: closed-form geometry (length, planar + horizontal area, angle at vertex, slope, volume) on known inputs | `tests/measureGeometry.test.ts`, `tests/measurementChains.test.ts` | Production — visual-inspection grade, not survey-grade |

## What the matrix does and does not assert

- It asserts that each product behaves **correctly against a known answer**:
  the maths is right, gaps are not fabricated, exports are spec-valid, and
  warnings propagate.
- It does **not** assert survey-grade or certified accuracy on real-world
  data. Confidence and vertical accuracy are calibrated, data-quality
  estimates from the returns the analyser walked — not a survey
  certification. See
  [terrain-intelligence.md](../terrain-intelligence.md#what-confidence-means-and-what-it-does-not).
- Terrain products are **fit for final deliverables only when the Terrain
  Assessment reads Good**. Preview / Limited / Blocked surfaces are for
  inspection and measurement; validate independently before relying on them.

## Manual pre-release checks

Automated tests cover correctness against synthetic truth. Before a release
that touches terrain export or georeferencing, also run these by hand:

1. **Open a DEM GeoTIFF in QGIS or GDAL** and confirm it is georeferenced —
   the raster lands in the right place over a basemap, the cell size and
   origin match the source, and `gdalinfo` reports the expected CRS/EPSG and
   value range (with NODATA honoured, not rendered as 0).
2. **Open the Esri ASCII Grid (`.asc`)** in the same tool and confirm it
   aligns with the GeoTIFF and that NODATA cells stay empty.
3. **Check the `.prj` sidecar** matches the intended CRS, and that a dataset
   with unknown CRS/datum surfaces the warning in the UI and in the export
   README rather than exporting a silently ungeoreferenced file.
4. **Spot-check DSM vs DTM vs CHM** over a known building or tree stand: the
   DSM should sit above the DTM by roughly the structure/canopy height, and
   the CHM should read near zero on bare ground.
5. **Eyeball the hillshade** for a plausible sun direction, and confirm the
   contour grade (solid / dashed / gap) degrades where coverage and
   confidence are weak.

Mark any product **preview** or **experimental** in the matrix above if a
manual check is failing or has not been run for the current release.
