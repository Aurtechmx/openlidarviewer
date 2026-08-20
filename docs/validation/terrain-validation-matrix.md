# Terrain Validation Matrix

This page maps each terrain product to **how it is validated** and to the
test that proves it. The goal is honesty: every claim about a terrain
product is backed by a deterministic, pure-data test against a known answer,
an interoperability check, or a documented manual step.

Validation methods used below:

- **Known-truth fixture**: a synthetic surface with an analytically known
  elevation function (`tests/fixtures/terrainScenes.ts`); the product is
  asserted against the closed-form answer within a documented tolerance.
- **Held-out RMSE / calibration**: ground returns are withheld, the
  vertical residual at the withheld points is measured, and the reported
  confidence is checked against that measured error.
- **Interop / format check**: the exported bytes are parsed back and the
  header, geo-tags, row order, and NODATA handling are asserted against the
  format spec.
- **Analytic check**: a closed-form value (e.g. Lambert shading, Horn
  slope) is pinned exactly.

All terrain tests are pure-data (no DOM, no three.js, no I/O) and
deterministic. Run them with `npx vitest run`.

The **Status** column has been replaced by an **evidence level** per
[`EVIDENCE_MODEL.md`](./EVIDENCE_MODEL.md) and the machine-readable
[`claim-register.yaml`](./claim-register.yaml). "Production" is no longer used as
a scientific-validation status, it conflated "the code works" with "the science
is validated". **Slope, aspect, hillshade, contours, the DSM, the DTM, the CHM and the cross-section profile are the products at E4+ in this matrix** (slope, aspect and hillshade each
independently cross-implemented against GDAL 3.13.1 on the same analytic fixture, contours against GDAL `gdal_contour`
on a frozen analytic tilted plane, the DSM, DTM and CHM grids against PDAL 2.10.2 `writers.gdal` on seeded synthetic clouds where the
reference radius is below half a cell, covering the cell gridding rather than ground classification, and the profile against OGR/SpatiaLite chainage reduced by R's type-7 quantile); every other product tops out at E3 synthetic known-truth,
with analytic checks E2 and interop/unit checks E1. Held-out RMSE is an INTERNAL diagnostic (points withheld from the same
scan), not independent checkpoint accuracy, optimistic relative to a
spatially-blocked or field checkpoint (research-hardening Phases 4 to 5).

## Matrix

| Terrain product | How it is validated | Test file(s) | Evidence level |
|---|---|---|---|
| Ground filter (SMRF-core progressive morphological) | Known-truth fixture: ground recall and non-ground (building/canopy) rejection bars, plus DTM RMSE on interior cells; a sparse + steep variant reports recall rather than gating it. Implements a SUBSET of SMRF (Pingel et al. 2013), no net-cutting refinement pass (see `groundFilter.ts`). | `tests/groundFilterValidation.test.ts`, `tests/groundFilter.test.ts` | E3 Synthetically validated · external pending |
| DTM (bare-earth grid) | Known-truth fixture: covered cells asserted against the analytic elevation (flat / slope / hill / pit / ridge / valley / terrace), gaps left empty or interpolated, never fabricated. PLUS cross-implementation against PDAL 2.10.2 `writers.gdal` (min return) on three seeded bare-earth clouds: OLV agrees over 7500 cells to a max Δ under 4×10⁻⁶ m within the preregistered 0.05 m tolerance. Reference radius below half a cell, so this covers the cell gridding, not the ground filter | `tests/terrainTruth.dtm.test.ts`, `tests/groundFilterPdalAgreement.test.ts` | **E4 Cross-implementation validated (PDAL), gridding on these clouds only, required bar E5, external field pending** |
| DSM (top surface) | Known-truth fixture: DSM equals the top surface (roof over building, canopy top over trees) on classified overlay scenes. PLUS cross-implementation against PDAL 2.10.2 `writers.gdal` (max return) on three seeded structure clouds: OLV agrees over 7500 cells to a max Δ under 4×10⁻⁶ m within the preregistered 0.05 m tolerance. Reference radius below half a cell, so this covers the cell gridding | `tests/terrainTruth.surface.test.ts`, `tests/groundFilterPdalAgreement.test.ts` | **E4 Cross-implementation validated (PDAL), gridding on these clouds only** |
| CHM (canopy height, DSM − DTM) | Known-truth fixture for the height-above-ground field; reconstruction logic (DSM = DTM + canopy, nodata preserved) checked directly. PLUS cross-implementation against PDAL 2.10.2 `writers.gdal` (max grid minus min grid) on three seeded structure clouds: OLV's `heightAboveGround` agrees over 7500 cells to a max Δ under 8×10⁻⁶ m within the preregistered 0.1 m tolerance. Rests on the two already-validated grids, so it covers the differencing arithmetic, not the ground filter | `tests/terrainTruth.surface.test.ts`, `tests/dsmChm.test.ts`, `tests/chmCrossCheck.test.ts` | **E4 Cross-implementation validated (PDAL), differencing on these clouds only** |
| Slope (Horn) | Analytic check (flat ≈ 0°, uniform slope = atan(gradient)) PLUS cross-implementation against GDAL 3.13.1 on the frozen analytic DEM: OLV, GDAL and the closed form agree over 11,564 interior cells within the preregistered 0.5° tolerance (max Δ < 0.001°) | `tests/terrainTruth.surface.test.ts`, `tests/slopeCrossCheck.test.ts` | **E4 Cross-implementation validated (GDAL), algorithm on this fixture only** |
| Aspect (Horn) | Cross-implementation against GDAL 3.13.1 on the same frozen analytic DEM, compared as a bearing (circular difference) and only where the closed-form slope exceeds 2°, because level ground has no aspect: OLV, GDAL and the closed form agree over 10,932 cells within the preregistered 0.5° circular tolerance (max separation about 0.0002°) | `tests/aspectCrossCheck.test.ts` | **E4 Cross-implementation validated (GDAL), algorithm on this fixture only** |
| Hillshade (ESRI illumination, single direction) | Analytic check (exact flat-plane Lambert value at a known sun altitude, and the brighter/darker ordering for N/E/S/W-facing slopes under a fixed azimuth) PLUS cross-implementation against GDAL 3.13.1 on the same frozen analytic DEM at az 315 / alt 45 / z 1: OLV, GDAL and the closed form agree over all 11,564 interior cells within the preregistered 1.0-level tolerance (ours vs closed form max Δ 0.0000643; ours vs GDAL max Δ 1.00 as 8-bit levels). Most of that one-level budget is GDAL's `1 + 254·h` encoding versus our `255·h`, not shading, our intensity re-encoded in GDAL's scale reproduces the reference exactly, at zero tolerance. Does NOT cover the multidirectional variant | `tests/terrainTruth.hillshade.test.ts`, `tests/hillshadeCrossCheck.test.ts` | **E4 Cross-implementation validated (GDAL), algorithm on this fixture only** |
| Hold-out RMSE / vertical accuracy (NVA/VVA-style) | Held-out RMSE against analytic surfaces where the true error is known; NVA/VVA-STYLE derivation (1.96 × RMSEz) on internal holdout, **not** independent checkpoint accuracy and not ASPRS NVA/VVA compliance | `tests/holdoutRmse.test.ts`, `tests/verticalAccuracy.test.ts` | E3 Synthetically validated · external pending |
| Confidence calibration | Fit + apply a monotonic calibration map; the check guards pass, fail, and not-assessable. Measured-cell empirical reliability and interpolated-cell model-based support are distinct concepts (Phase 5) | `tests/calibrateConfidence.test.ts`, `tests/calibrationCheck.test.ts` | E2 Analytically verified |
| Terrain Assessment (four statuses) | Exercised end to end through the contour pipeline and surface fixtures; statuses are derived purely from the quality report, score, metrics, and coverage so they cannot disagree with the numbers shown | `tests/analyseContours.test.ts`, `tests/contourPipeline.integration.test.ts` | E3 Synthetically validated |
| Contours (evidence-graded) | Known-truth + integration: marching-squares output, stitching, styling, and feature model on synthetic surfaces; grade (solid / dashed / gap) tracks supporting confidence. PLUS cross-implementation against GDAL `gdal_contour` on a frozen analytic tilted plane (linear interpolation exact): OLV's isolines agree to a maximum vertex separation of 2.9×10⁻⁵ m under a tolerance registered before the reference was generated | `tests/contoursAt.test.ts`, `tests/stitchContours.test.ts`, `tests/contourStyle.test.ts`, `tests/contourFeatureModel.test.ts`, `tests/contourPipeline.integration.test.ts`, `tests/contourCrossCheck.test.ts` | **E4 Cross-implementation validated (GDAL `gdal_contour`), map-sheet geometry on this fixture only** |
| DEM export, Esri ASCII Grid | Interop check: header fields, north-row-first ordering, NODATA for empty cells | `tests/demExport.test.ts` | E2 Interop-verified |
| DEM export, GeoTIFF | Interop check: valid little-endian TIFF, expected raster + geo tags, north-row-first, NODATA; EPSG propagated into every GeoTIFF; full package (DTM/DSM/CHM `.asc` + `.tif` + `.prj` + README) bundled | `tests/demExport.test.ts` | E2 Interop-verified |
| CRS / datum warnings (detection + propagation only) | Propagation check: known CRS+datum emit no warning and carry a GeoJSON `crs` member; unknown CRS/datum surface the exact pinned warning and propagate into export metadata; vertical-datum detection, compound-CRS WKT, LAS GeoKey fidelity, `.prj` sidecar. **Detection, unit conversion, recentering, metadata propagation, warnings only, no full reprojection or vertical-datum transformation.** | `tests/crsDatumWarnings.test.ts`, `tests/crsVerticalHardening.test.ts` | E1 Unit verified |
| Profiles (cross-section) | Known-truth fixture: sampled (distance, height) polyline asserted against the analytic surface; height sampler, civil stats, stationing, and chart bounds covered. PLUS cross-implementation against a corridor reference assembled from OGR/SpatiaLite 5.1.0 (`ST_Line_Locate_Point`, `ST_Distance`) and R 4.4.1 `quantile(type = 7)` on two committed clouds: OLV agrees over 751 stations to a max Δ of 3.6×10⁻¹⁵ m within the preregistered 1×10⁻⁶ m tolerance, with per-station corridor counts matching exactly, and both sides reproduce the ramp fixture's closed form. Synthetic clouds that hold every point clear of a bin boundary and of the corridor edge, so the tie-breaking there is not covered | `tests/profileAnalyticalFixtures.test.ts`, `tests/profileSampler.test.ts`, `tests/civilProfileStats.test.ts`, `tests/profileStations.test.ts`, `tests/profileCrossCheck.test.ts` | **E4 Cross-implementation validated (OGR/SpatiaLite + R), corridor sampling on these clouds only** |
| Measurements (distance / area / height / angle / slope / volume) | Analytic check: closed-form geometry (length, planar + horizontal area, angle at vertex, slope, volume) on known inputs | `tests/measureGeometry.test.ts`, `tests/measurementChains.test.ts` | E2 Analytically verified, visual-inspection grade, not survey-grade |

## What the matrix does and does not assert

- It asserts that each product behaves **correctly against a known answer**:
  the maths is right, gaps are not fabricated, exports are spec-valid, and
  warnings propagate.
- It does **not** assert survey-grade or certified accuracy on real-world
  data. Confidence and vertical accuracy are calibrated, data-quality
  estimates from the returns the analyser walked, not a survey
  certification. See
  [terrain-intelligence.md](../terrain-intelligence.md#what-confidence-means-and-what-it-does-not).
- Terrain products are **export-Ready only when the Terrain Assessment reads
  Good**. Preview / Limited / Blocked surfaces are for inspection and
  measurement; additional validation is recommended before relying on them.

## Manual pre-release checks

Automated tests cover correctness against synthetic truth. Before a release
that touches terrain export or georeferencing, also run these by hand:

1. **Open a DEM GeoTIFF in QGIS or GDAL** and confirm it is georeferenced, the raster lands in the right place over a basemap, the cell size and
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
