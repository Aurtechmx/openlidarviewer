# Artifact evaluation

This guide lets a reviewer evaluate the OpenLiDARViewer software artifact without special hardware or private data. It complements `REVIEWER_QUICKSTART.md` (fast start) and `docs/releases/VALIDATION_REPORT_v0.6.7.md` (what is and is not validated for this release; the terrain and measurement algorithms are inherited from `VALIDATION_REPORT_v0.5.9.md`).

## What the artifact is

A local-first, browser-native LiDAR and point-cloud viewer with terrain analysis, validation-aware exports, and (as of v0.5.9) a Contour Studio deliverable workflow. Local files stay on the reviewer's device; no upload or account is required. Remote datasets (COPC and EPT over HTTP) are the exception: the viewer fetches only the tiles it needs from the URL the reviewer supplies, and nothing is uploaded to OpenLiDARViewer.

## Requirements

- Node.js 22 (see `.nvmrc` / `package.json` `engines`).
- A Chromium-based browser with WebGPU for the interactive and end-to-end portions (a WebGL2 fallback exists). The unit/integration suite and the reproduction pack need only Node.

## Reproduce (no device beyond Node)

```bash
nvm use
npm ci
npm run typecheck
npm run test:unit && npm run test:export && npm run test:terrain && npm run test:ui && npm run test:slow
npm run repro          # regenerates the analytic figures under benchmarks/out/
npm run build:live && npm run check:bundle
```

`npm run test:release` runs the whole gate in one command.

## Claims and their evidence

- Every scientific claim is registered in `docs/validation/claim-register.yaml` with its current evidence level, the level required to be called validated, the tests that support it, and the wording that is allowed or prohibited. `scripts/lint-claim-register.mjs` fails the build if the runtime registry drifts from that file or if prohibited wording appears.
- The evidence ladder (E0–E6) is defined in `docs/validation/EVIDENCE_MODEL.md`. Seventeen products are at E4. Five are algorithm checks against GDAL: the slope raster, the aspect raster and the hillshade were cross-implementation validated against GDAL 3.13.1 on one analytic fixture (see `tests/slopeCrossCheck.test.ts`, `tests/aspectCrossCheck.test.ts` and `tests/hillshadeCrossCheck.test.ts`), the contour set against GDAL `gdal_contour` on a frozen analytic tilted plane (see `tests/contourCrossCheck.test.ts`), and polygon area against GDAL/OGR `OGR_GEOM_AREA` on a committed planar-polygon fixture (see `tests/measureAreaCrossCheck.test.ts`). Three are surface-gridding checks against PDAL 2.10.2 `writers.gdal`: the DSM (max return) and the DTM (min return) each agree over 7500 cells on three seeded synthetic clouds (see `tests/groundFilterPdalAgreement.test.ts`), and the CHM (clamped DSM minus DTM) agrees with the PDAL max grid minus the PDAL min grid over 7500 cells (see `tests/chmCrossCheck.test.ts`); these cover the cell gridding, not ground classification or real-terrain void interpolation. The other two are the terrain descriptors, each checked three ways against an independent tool and the closed form on a controlled analytic fixture: TPI against gdaldem 3.13.1 (see `tests/tpiCrossCheck.test.ts`) and VRM against SAGA 7.8.2 (see `tests/vrmCrossCheck.test.ts`), with OLV reproducing the closed-form Sappington VRM to under 1×10⁻⁹. The eleventh is the section profile, checked against a reference assembled from OGR/SpatiaLite 5.1.0 chainage and R 4.4.1 `quantile(type = 7)` over 751 stations on two committed point clouds, and against the closed form on the ramp fixture (see `tests/profileCrossCheck.test.ts`). The twelfth is E57 ingestion, checked point for point against PDAL 2.10.2 `readers.e57` over all 1,788,994 points of a public CC-BY terrestrial scan across nine dimensions, compared as an exact quantised integer sum at a 1×10⁻⁶ quantum (see `tests/e57PdalCrossDecode.test.ts`). The thirteenth is the UTM projection, checked against PROJ 9.8.1 `cs2cs` and GeographicLib 2.7 `GeoConvert` over 36 frozen WGS-84 coordinates (see `tests/geodesyOracleAgreement.test.ts`): zone and hemisphere match GeographicLib on every fixture, and easting and northing agree with both stacks to under a millimetre under a 1.5 mm tolerance, with the two references agreeing with each other to 2×10⁻⁹ m. That check covers projection within one datum, so it exercises no datum transformation, no PROJ transformation grid, no vertical reference and no ECEF conversion. The fourteenth and fifteenth are the two accuracy statistics, `HOLDOUT-RMSE` and `NVA-VVA`, recomputed in base R 4.6.1 over six frozen residual vectors (see `tests/statisticsRAgreement.test.ts`): bias, RMSE and the maximum absolute residual agree to about 4.4×10⁻¹⁶ over eighteen comparisons, and the 95 percent figure, 1.96 times that RMSE, agrees to about 8.9×10⁻¹⁶ over six, both under a 1×10⁻¹² tolerance. That establishes the formula is computed correctly outside TypeScript, including that RMSE is the raw second moment rather than a standard deviation. It establishes nothing about accuracy: both claims still require E5, the held-out points still come from the same source as the interpolated ones, and the tolerance was adopted alongside the result rather than preregistered. Median, NMAD and P95 are excluded because R interpolates at type 7 while `checkpointAccuracy` takes the nearest rank, a difference the study records rather than resolves. The sixteenth and seventeenth are the change pair, `CHANGE-RASTER` and `CHANGE-VOLUME`, compared against GRASS 8.5.0 `r.mapcalc` and `r.univar` over eight frozen synthetic epoch pairs at one metre (see `tests/changeGrassAgreement.test.ts`): every case agrees with GRASS and with the closed-form volume the pair was built from, on gain volume, loss volume, gained cells, lost cells and comparable cells, with both sides selecting the same 3007 comparable cells and a largest relative difference of 7×10⁻⁶ under a 1×10⁻⁵ gate. Truth is scored first and implementation agreement second, because two programs summing the same wrong cells agree perfectly. Only one-metre metre-CRS grids were compared, agreement with GRASS on synthetic epoch pairs is not accuracy against surveyed field change, and the protocol freeze is `adopted-with-result` rather than a preregistration, because it landed in the same commit as the first result. Every other product tops out at E3 (synthetic known-truth checks).
- `docs/releases/VALIDATION_REPORT_v0.6.7.md` lists exactly what was and was not tested for this release (inheriting the terrain and measurement algorithms from `VALIDATION_REPORT_v0.5.9.md`); `docs/validation/THREATS_TO_VALIDITY.md` aggregates the limitations.

## Integrity

Release archives are produced by `npm run package`, which emits `SHA256SUMS` and a `release-manifest-vX.json` (version, commit, node, per-zip SHA256). A checksum verifies file integrity only; it does not prove authorship.

## Data availability

No proprietary dataset is required. Bundled fixtures are synthetic or explicitly licensed (`docs/project/THIRD_PARTY_NOTICES.md`); external point clouds are user-supplied or streamed from third-party open-data hosts and are not redistributed here (`DATA_AVAILABILITY.md`).

## Scope of evaluation

Evaluable in this artifact: build, type safety, the full unit/integration suite, deterministic analytic reproduction, bundle budget, and the honesty lints. Not evaluable here without a device or external reference data: GPU performance figures, the full browser end-to-end suite, and cross-implementation / field accuracy comparisons.
