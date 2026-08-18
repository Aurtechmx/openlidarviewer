# Validation report: OpenLiDARViewer v0.6.6

This report states what v0.6.6 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`).

v0.6.6 is a focused evidence release on top of v0.6.5. It promotes three grades and changes no algorithm. The application, its interactive surfaces and every other evidence grade are inherited from v0.6.5 unchanged, and their evidence carries over intact and is not restated here. This report covers the three grades that moved and the boundary of the evidence behind them.

## What moved

`DSM`, `DTM` and `CHM` reach `E4_CROSS_IMPLEMENTATION_VALIDATED`. All three were already checked against known analytic surfaces at E3. This release adds an independent-implementation comparison against PDAL 2.10.2 `writers.gdal`: each surface grid is recomputed from its point cloud and compared to the PDAL grid, and the canopy height is compared to the PDAL grids differenced.

**DSM (top surface).** OLV's max-return grid was compared against PDAL's `writers.gdal` maximum output on three seeded structure clouds (`OLV-DS-015`, `OLV-DS-016`, `OLV-DS-017`). The two agree over 7,500 cells to a maximum difference under 4×10⁻⁶ m, within the 0.05 m tolerance registered in `REFERENCE_SLOTS` before the reference existed. Recorded in the study manifest `DSM-PDAL-WRITERS-GDAL-CELL-CENTRED`.

**DTM (bare-earth grid).** OLV's min-return grid was compared against PDAL's `writers.gdal` minimum output on three seeded bare-earth clouds (`OLV-DS-012`, `OLV-DS-013`, `OLV-DS-014`). The two agree over 7,500 cells to a maximum difference under 4×10⁻⁶ m, within the same registered 0.05 m tolerance. Recorded in the study manifest `DTM-PDAL-WRITERS-GDAL-CELL-CENTRED`.

Both recomputes run on every gate through `tests/groundFilterPdalAgreement.test.ts`, which also asserts that a row-order flip or an axis mirror breaks the agreement, so a coincidental match cannot pass.

**CHM (canopy height).** CHM is DSM minus DTM per cell, clamped at zero. With both parents at E4, OLV's `heightAboveGround` was compared against the PDAL max grid minus the PDAL min grid on the same three structure clouds, where every cell carries a ground return so the minimum is the ground and the maximum is the top surface. The two agree over 7,500 cells to a maximum difference under 8×10⁻⁶ m, within a 0.1 m tolerance registered before the difference was run. Recorded in the study manifest `CHM-PDAL-WRITERS-GDAL-DIFFERENCE`, checked on every gate by `tests/chmCrossCheck.test.ts`, which also breaks under a row flip.

Ten products are now at E4: `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` against GDAL, `DSM`, `DTM` and `CHM` against PDAL, and the terrain descriptors `TPI` (against gdaldem 3.13.1) and `VRM` (against SAGA 7.8.2), each also checked against the closed form on a controlled analytic fixture.

## The boundary of the DSM and DTM evidence

The comparison isolates the cell gridding. The reference radius is 0.45 m, below half a cell, so each cell reduces to the returns placed at its centre and both implementations take the maximum or minimum over the same point set: the agreement measures the gridding arithmetic, not a divergent neighbourhood search. The DTM clouds are bare-earth by construction, so it does not touch ground classification either. `GROUND-FILTER` stays at E3 in this release, because its agreement with PDAL's `filters.smrf` holds on low-relief terrain (0.99985 of 95,005 returns on the Estonian crop) but falls on steep terrain (0.983 at Coconino, 0.61 to 0.77 on the synthetic rolling and ridge scenes), and a grade that only holds on gentle ground cannot be written as unconditional E4.

Three more things sit outside the check. Void interpolation across real gaps is not exercised. The supporting clouds are single-unit metre grids, so the mixed-unit ground-filter threshold path is not exercised. And the DTM's required bar for field validation stays at E5: none of this is survey-grade accuracy, and no product here is field-validated.

## What was tested for v0.6.6

Whole-suite evidence for this release comes from the release-mode gate run at the tagged commit, with an exit marker per blocking stage in the shipped `gate.log`. The authoritative record is the release asset `test-evidence-v0.6.6.json`; its SHA-256 is in `SHA256SUMS`, and `release-manifest-v0.6.6.json` binds the tag to the full 40-character commit and to every artifact hash, which `npm run release:verify` walks. Published totals are read from `docs/validation/test-evidence.json` rather than entered by hand, and `npm run lint:evidence` checks the documents against it.

The two promoted grades are covered by the recompute-and-compare test above, by the study manifests the study verifier walks (`npm run validation:study:verify`), and by the reference-slot honesty tests (`tests/crossCheck.test.ts`, `tests/crossImplementationManifest.test.ts`) that pin which slots are supplied and confirm the rest stay pending.

## What was NOT tested (and is not claimed)

Real-terrain DSM and DTM accuracy, ground-classification accuracy, void interpolation, mixed-unit gridding, and any field-grade or survey-grade figure. The DTM checkpoint results reported below the grade line in v0.6.5 remain external agreement on found public data, not a preregistered field campaign, and do not move the grade. Everything staged but not shipped in v0.6.5 (the feature-extraction and registration interactive surfaces) remains staged and is not claimed here.
