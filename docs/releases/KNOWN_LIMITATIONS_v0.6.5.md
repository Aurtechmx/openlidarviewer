# Known limitations: OpenLiDARViewer v0.6.5

This release sharpens classification, hardens the report and export surfaces against unknown coordinate units, and finishes interface work from v0.6.3. The limits below are the v0.6.3 limits with the classification note updated for the new building ground-support gate, plus what this cycle newly named as uncovered.

## The two monoliths are still monoliths

`src/main.ts` is 5,818 lines and `src/render/Viewer.ts` is 6,336, against stated targets of 2,500 and 2,000. This cycle lifted more blocks out of `Viewer.ts` (the streaming session assembly moved behind a `StreamingHost`, and report and scan-open paths moved behind structural dependency objects), and shared domain/application state is owned by AppContext/services, with the composition root retaining only explicitly bounded shell-local composition and lifecycle state. That is continued decomposition, not its completion. The remaining blocks to lift, and the measured dependency surface of the first one, are in `docs/architecture/architecture-map.md`.

## Building classification: the ground-support gate is evaluated on synthetic scenes only

Building classification now requires firmer ground support beneath a candidate roof (`buildingMinSupport`, default 0.66, in `src/render/class/deriveClassification.ts`). The gate exists to drop scan-edge void artifacts, where a one-cell roof column sits over empty neighbours and its bilinear footprint reaches two measured and two unmeasured corners, so ground support reads exactly 0.5.

`docs/validation/building-support-gate-eval.md` records a synthetic evaluation. On one labelled synthetic corpus the gate removes 480 of 528 artifact roof points while keeping every real-building point, so precision rises and recall holds. That is a synthetic corpus with hand-placed geometry, not a field survey. It does not measure behaviour on real airborne or photogrammetric point clouds, on mixed support values, or on a real building at a genuine coverage edge whose ground support is itself 0.5. That last case would lose real-building recall and is not covered. The result supports the change on the failure mode it targets and does not generalise beyond it.

## Automatic classification is return-number aware, not a validated classifier

Automatic classification reads the return number, so a multi-return point is treated as vegetation rather than as a single hard surface. This is a heuristic over the return metadata the source carries. It is not a validated land-cover classifier, and it inherits whatever the source's return numbering encodes.

## Multi-layer mounting: enabled, with one precision refinement outstanding

Physical multi-layer mounting is enabled in v0.6.5. Two georeferenced layers that declare the same projected CRS mount into one shared project frame at their real separation, non-destructively: the placement is a Float64 transform on the mesh, the source vertices are never rewritten, and each boundary recovers the world coordinate in the frame it names (picking and inspection through `worldXYZ`, reclassify and the project-frame estimators through the placement fold, exporters through each layer's own source origin). That per-boundary invariance under a non-identity mount is pinned by `tests/frameWorldCoords.test.ts`. The browser mount is pinned by `tests/e2e/twoScanMount.spec.ts`: real separation, source geometry untouched, and a layer that does not move when a sibling is added or removed.

One item is a precision refinement rather than a correctness defect. For far-apart mounts the renderer should fold `renderOrigin` out on the CPU per mesh so the Float32 GPU residual stays small. It is bounded and refused past 1 mm by the mount-precision gate (geographic frames refused outright), so a placement that cannot hold a millimetre never mounts. One acceptance-battery item is still open: a dedicated browser assertion that picks and measures a point on a mounted non-anchor tile, rather than exercising that path only through the full application e2e. The underlying coordinate is already the value `frameWorldCoords` proves. Incompatible layers (a different or absent CRS) carry no placement and stay in their own frame, so combined estimators refuse rather than average unlike frames.

## Cross-layer results require proven frame compatibility

Each layer carries what it has established about the project frame: `verified` (horizontal and vertical both proven), `horizontal-only` (horizontal proven; vertical undeclared or different), `unknown` (no declared CRS), or `incompatible` (a different frame). Only `verified` layers are merged into a combined estimator, and only `verified` layers are aligned in Z. Loading an unreferenced mesh (PLY/OBJ/GLB) beside a georeferenced scan leaves it out of combined results rather than merging frames that were never shown to correspond. A single layer is `verified` by definition, so single-scan work is unaffected.

## Report and UI surfaces fail closed on an unknown unit

Four report and UI surfaces now refuse to present a length when the CRS linear unit cannot be resolved, rather than showing a number in an unstated unit. This is deliberate: a figure whose unit is unknown is withheld with the reason, not rendered as if it were metres. A scan whose unit does resolve is unaffected.

## Contour GeoJSON ships in two frames

`<name>.geojson` is RFC 7946: WGS 84 longitude/latitude, no `crs` member, with the source CRS recorded in `metadata` as provenance. `<name>-native-EPSG<code>.geojson` carries the scan's own projected coordinates and the pre-RFC `crs` member for GIS that wants the survey grid, and its filename says so. When the source CRS cannot be converted to lon/lat, the RFC file is refused rather than written with projected numbers in degree fields, and only the native file is produced. Antimeridian-crossing geometry is emitted whole: RFC 7946 §3.1.9 says a LineString crossing 180 degrees longitude should be split at the antimeridian, which is a SHOULD rather than a MUST, and only a scan footprint straddling 180 degrees reaches it.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is opt-in and not wired into the live scheduler. Some budget-boundary regions may still pulse in this build. Remote COPC streaming replacement is transactional in this release, so a failed swap no longer leaves the previous session partly torn down.

## Startup bundle above the early-warning line

The live entry chunk is measured into `docs/validation/test-evidence.json` and checked by `lint:evidence`, against a hard ceiling and an early-warning threshold below it. The figure is machine-derived rather than typed in, because three documents once quoted a size for a build that produced a different one.

## Mutation and coverage evidence is advisory, not archived

`npm run coverage` and `npm run mutation` both pass. Coverage is a blocking stage of the release-mode gate and its output ships inside `gate.log`. Mutation runs on its own schedule, and the release record cites that run, its score and the commit it was measured at, refusing the release outright when no result exists. Ordinary branch CI runs neither, so between releases treat the figures as a working measurement rather than a preserved claim.

## Evidence ceiling: four cross-implemented products, no field validation

Four products have been compared against an independent implementation. Slope, aspect and hillshade each agreed with GDAL 3.13.1, and with the surface's closed-form gradient, on one frozen analytic DEM, within tolerances registered before the references were generated. Contours agreed with GDAL `gdal_contour` on a frozen analytic tilted plane, where linear interpolation is exact, to a maximum vertex separation of 2.9×10⁻⁵ m, again under a tolerance registered before the reference was generated. `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE` and `CONTOURS` are at E4 on that basis. Every other terrain product tops out at E3, which is synthetic known-truth against this project's own implementation. E5 is unreached, and nothing here is field-validated. This release does not claim survey-grade accuracy, standards compliance or independent field validation.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).

## Axis and compound-unit handling is correct but not yet uniform

An explicit model spanning up-axis, horizontal unit, vertical unit and CRS now exists as `SpatialContext` (`src/geo/SpatialContext.ts`), but not every metric path consumes it yet, so an unusual combination can still be silently plausible where a caller reads the raw fields instead of the model. A box measurement is stored as axis-aligned min/max corners and throws on a genuinely tilted up vector rather than reporting the extent along the nearest axis. No scan the viewer sets can currently trigger that, so the refusal guards the contract rather than gating a feature. Threading `SpatialContext` through every remaining metric path is ongoing hardening across the v0.6 series; the fail-closed refusal above bounds the risk until it is complete, so it is not a v0.6.5 runtime blocker.

## Compatibility fallback verified against a forced configuration, not every device

WebGPU falls back to WebGL 2 when no adapter is present, which fixes an open crash on iOS WebKit. The fallback is verified against a browser forced onto WebGL 2, not against every affected iOS device or version.

## The in-memory reconstruction is less precise than the file it came from

Points are held as Float32 local to a render origin, so what the application reconstructs from a LAS file displaces further than the file's own quantisation bound allows. Over a 50 km extent at millimetre scale the file round-trips with zero displacement while the application's read-back reaches 1.9 mm. The written file is unaffected either way. A wide-area cloud is the case to watch.

## Cross-platform reproducibility covers two little-endian platforms

The two-platform result is tracked at `docs/validation/evidence/portability-v0.6.2/`: platforms darwin-arm64 and linux-x64, both little-endian, one commit, one synthetic seeded fixture. Windows is untested, no big-endian host has run a leg, and no real scan data is in the comparison. What holds is that the same arithmetic returns the same values on a second architecture.
