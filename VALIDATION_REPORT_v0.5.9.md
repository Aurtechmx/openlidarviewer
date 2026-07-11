# Validation report — OpenLiDARViewer v0.5.9

This report states, soberly, what v0.5.9 validates and what it does not. It is the human-readable companion to the machine-readable claim register (`docs/validation/claim-register.yaml`), the evidence model (`docs/validation/EVIDENCE_MODEL.md`), and the threats-to-validity summary (`docs/validation/THREATS_TO_VALIDITY.md`).

## Evidence ceiling

No product is validated above internal evidence. On the E0–E6 ladder, nothing is at or above E4 (cross-implementation independence). Synthetic known-truth checks reach E3 (self-consistency against an analytic surface), which is not accuracy against an independent reference. The cross-implementation harness exists (`src/validation/crossCheck.ts`) but every reference slot is `pending` because the external reference outputs are not available in this environment and were not fabricated.

## What was tested

Terrain and contour correctness is exercised by the automated suite (run with `npm run test:terrain` and `npm run test:unit`):

- Analytic contour geometry. `tests/contourAnalyticValidation.test.ts` extracts contours from surfaces whose isolines are known in closed form and checks the geometry: a cone yields concentric circles at the correct radius, a paraboloid yields circles at radius sqrt(L/a), and a tilted plane spaces parallel contours by interval/gradient. `tests/contoursAt.test.ts` pins every marching-squares vertex to the analytic iso-line and to cell-centre registration.
- Unit safety. `tests/contourLevelDefinition.test.ts` and `tests/contourIntervalUnits.test.ts` confirm intervals carry both source and metre values, that an unknown vertical unit produces no metre value and no metric claim, and that metric support is gated on a projected CRS.
- Hold-out validation. `tests/holdoutRmse.test.ts`, `tests/spatialBlockHoldout.test.ts`, and `tests/dtmSurfaceModel.test.ts` verify the internal accuracy estimator on analytic surfaces and disclose the classify-before-split limitation; `tests/calibrateConfidence.test.ts` verifies confidence calibration is scored out-of-fold.
- Geometry split and generalization. `tests/contourGeometryProduct.test.ts` and `tests/contourAdaptiveGeneralize.test.ts` verify analytical geometry is immutable under cartographic settings, cartographic geometry references the analytical hash, gaps are not bridged, and terrain-aware tolerance preserves fidelity where support is weak.
- Evidence gating. `tests/exportManifest.test.ts` verifies the export-decision resolver's downgrade-only invariant (a registered exporter is capped to exploratory when the launch context isn't fully supported, never upgraded), and `tests/contourExportPermit.test.ts` verifies the single authoritative permit that mints each contour export through it. The resolver is ENFORCED in v0.5.9 for the Contour Studio contour file exports: GeoJSON, DXF, SVG and the contour map-PDF are each minted through `resolveContourExportPermit` → the resolver, the writer refuses a blocked permit, and the decision (validated / exploratory + watermark) is stamped into the exported file's provenance. NOT yet routed through this resolver: the DEM raster package and the terrain intelligence report, which still use the older `evidenceStatus` gate (folding them in is a follow-up). `tests/contourDeliverablePdfModel.test.ts` and `tests/contourPackageManifest.test.ts` verify a blocked product yields no polished deliverable, an exploratory product is watermarked, and no survey-grade / certified / standards-compliant wording is asserted; these PDF/package MODELS are tested but not yet wired to the dedicated multipage PDF / complete-ZIP emitters (the current Studio PDF/package products bridge to the existing map-sheet PDF and DEM ZIP).
- Registration. `tests/icpRegister.test.ts` verifies trimmed ICP recovers a known transform under injected outliers without collapsing.

## What was NOT tested

- Cross-implementation independence (E4). No comparison against an independent contour/DTM implementation (for example PDAL/GDAL) has been run; the harness slots are pending external reference data.
- Field accuracy (E5+). No comparison against surveyed checkpoints.
- Sensor and terrain generalization. Results are demonstrated on synthetic fixtures and a limited set of open datasets; behaviour across other sensors, densities, and terrain types is not independently characterized.
- The full browser end-to-end suite and GPU performance figures require a device and are not part of this in-environment report.

## Reproducing

See `REPRODUCIBILITY.md`. The gate is `npm run test:release`; analytic figures regenerate deterministically with `npm run repro`.

## Verdict

CONDITIONAL: v0.5.9 is internally validated (E3) and honestly scoped. It is suitable for inspection, planning, and reproducible research deliverables that state their internal-only evidence. It is not survey-grade and makes no independent-accuracy claim.
