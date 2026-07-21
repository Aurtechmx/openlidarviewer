# Known limitations — OpenLiDARViewer v0.6.0-alpha.2

This is an alpha for evaluation. The items below are known and deliberate — recorded here rather than hidden, in keeping with the project's honesty contract.

## The two monoliths are still monoliths

`src/main.ts` is 7,574 lines and `src/render/Viewer.ts` is 7,297, against stated targets of 2,500 and 2,000. alpha.2 finished the composition root (no module-level mutable application state remains in `main.ts`) and wrote the architecture down with a drift check, but that is the scaffolding for the decomposition, not the decomposition. The ten blocks to lift, and the measured dependency surface of the first one, are in `docs/architecture/architecture-map.md`.

## Shared project frame is applied to static layers; browser confirmation pending

`ProjectSpatialFrame` / `LayerSpatialTransform` (value types + pure transform math) are tested and documented (`docs/architecture/project-spatial-frame.md`). alpha.2 lands **step 1** of the wiring plan: the app now owns a live project frame (`src/app/projectFrame.ts`, on `AppContext`), reseeded from the loaded layer set on every change, choosing one shared origin and deriving each layer's translation into it. A single layer anchors the frame at its own origin, so its transform is the identity and the single-scan path is unchanged.

Static layers now mount by REBASING THEIR DATA onto the shared project origin (`PointCloud.rebaseOrigin`), so rendering, picking, terrain analysis, lasso, profiles, volumes, combined bounds and exports all read the same project-local coordinates — one mechanism, no render/CPU split. An earlier mesh-translation mount had exactly that split (layers looked aligned while calculations used cloud-local frames); an external audit caught it and the mount was rebuilt at the data level. A lone layer rebases to its own origin — the identity — so the single-scan path is unchanged by construction and the full e2e suite passes untouched. Still staged for this alpha:

- **Two-scan placement is verified in Node, not yet in a browser** with real georeferenced fixtures — treat multi-layer placement as needing that one visual confirmation.
- **Mounting spends Float32 precision in proportion to how far apart layers sit.** Positions are Float32, and the mount adds the project offset to them, so the residual precision a layer keeps depends on its distance from the shared anchor — not on its absolute coordinate. Measured via `PointCloud.rebaseQuantum`: a single georeferenced scan anchors on its own origin and loses nothing (~1e-8 m); two tiles 1 km apart cost ~0.02 mm; 100 km apart costs a full millimetre. Millimetre-critical work across widely separated tiles should be done per-layer for this alpha. Keeping vertices source-local behind a Float64 transform is the tracked fix (coordinate-integrity roadmap, P1 item 2).
- Elevation colour ramps are normalised PER LAYER (each layer's own min/max), so a frame offset cancels in the normalisation and per-layer colours are correct — verified empirically. What ramps do NOT do is share one scale across layers, so the same colour on two layers does not mean the same absolute height; that is a pre-frame design choice, and a scene-shared ramp is the open step-5 decision. The measurement datum DOES follow the frame when every loaded layer is in it (step 4), and falls back to the pre-frame unanimity rule otherwise.

For this alpha:

- Cross-layer operations still require a shared CRS: a layer whose declared CRS disagrees is excluded from the frame and mounts where it always did.
- **Multi-dataset comparison is experimental.** Compare Studio, cross-layer measurement, shared clipping and elevation ramps do not yet read the frame's offsets (steps 3–5 of the plan).
- Results that depend on a common frame should be treated as indicative when common-frame compatibility can't be established.
- Integrated Spatial Workflows are **not** claimed complete.
- A layer whose declared CRS disagrees with the project's is excluded from the shared origin and reported as unaligned; it is never silently reprojected. Reprojection remains a downstream tool's job.

## Multi-layer mounting is OFF in this alpha

`MULTI_LAYER_MOUNT_ENABLED` is `false`. Layers are classified, the project
frame is computed, and every transform is tested — but no layer's geometry is
physically moved onto a shared origin.

The mount writes the project offset into the Float32 position array, which
permanently edits the only copy of the source values. The precision gate below
bounds that and refuses anything past a millimetre, but bounding a destructive
edit is not the same as not making one, and it is the wrong default for a
research tool before the transform is held in Float64 beside source-local
vertices (coordinate-integrity roadmap, P1 item 2).

Turning it off is only safe because a combined estimator requires BOTH proven
compatibility and an actual mount. Without that second condition, disabling the
mount would have left two `verified` layers sitting at their own origins and
still eligible to be averaged together — a worse error than the precision cost
being avoided.

**What this means in practice:** single-scan work is completely unaffected — a
lone layer's mount was always the identity. Multiple layers load, display and
can each be analysed on their own; they are not co-registered and are not
combined into one estimate. Treat the project frame as a tested foundation
being carried, not a feature being claimed.

## Cross-layer results require PROVEN frame compatibility

Each layer carries what it has established about the project frame:
`verified` (horizontal and vertical both proven), `horizontal-only`
(horizontal proven; vertical undeclared or different), `unknown` (no declared
CRS), or `incompatible` (a different frame).

Only `verified` layers are merged into a combined estimator — terrain/DTM,
profile, cut/fill volume, lasso — and only `verified` layers are aligned in Z.
A `horizontal-only` pair is placed in plan, where the agreement is real, and
keeps its own heights, because orthometric and ellipsoidal references differ by
tens of metres and metre against foot by a factor of three. Undeclared is
treated as unproven, not as agreement.

**This is a deliberate refusal, not a limitation of the maths.** Loading an
unreferenced mesh (PLY/OBJ/GLB) beside a georeferenced scan will now leave it
out of combined results rather than merging frames that were never shown to
correspond. A single layer is `verified` by definition, so single-scan work is
unaffected.

A mount is additionally refused when it would cost more than a millimetre of
Float32 resolution. The step is judged **per axis group** — horizontal through
the horizontal unit, vertical through the vertical one — because a compound CRS
can be feet across and metres up, and putting a Z step through the horizontal
factor understated a 1.95 mm error as 0.6 mm. Either axis alone can refuse. An
undeclared unit refuses rather than borrowing the other axis's, and
**geographic (degree) frames are refused outright** — a degree is not a length,
and what it stands for depends on latitude.

**Streaming sources meet the same bar.** COPC/EPT resident nodes are gated
exactly as static clouds are, with the same single-source carve-out.

**The vertical anchor comes only from verified layers.** A horizontal-only
layer helps set the horizontal origin and never the Z origin.

**Excluded layers say so** in the layer panel, with the reason — a silent
exclusion would leave a figure computed from fewer inputs than it appears.

**Single layers are exempt.** Proof of a shared frame is required to MERGE
layers; one visible layer is analysed in its own frame, whatever its
compatibility state, because no combination is taking place.

**Still open:** the transform is applied by rewriting the Float32 positions
rather than held in Float64 beside source-local vertices. Within the gates
above that is bounded and disclosed, but it is not the end state; see
coordinate-integrity roadmap P1 item 2.

## Contour GeoJSON ships in two frames

`<name>.geojson` is RFC 7946: WGS 84 longitude/latitude, no `crs` member, with
the source CRS recorded in `metadata` as provenance. `<name>-native-EPSG<code>.geojson`
carries the scan's own projected coordinates and the pre-RFC `crs` member for
GIS that wants the survey grid — it is deliberately NOT RFC 7946, and its
filename says so.

Earlier builds wrote projected coordinates into `<name>.geojson` and declared
them with the `crs` member. A compliant reader discards that member and reads
an easting as a longitude without erroring, so files exported before this
change should be treated as native-frame regardless of their name.

When the source CRS cannot be converted to lon/lat, the RFC file is refused
rather than written with projected numbers in degree fields, and only the
native file is produced.

The RFC file's geometry is **2D unless the vertical reference is proven to be
WGS 84 ellipsoidal height**, which is the only thing RFC 7946 permits in a
position's third element. Elevations always ride as `elevation`,
`elevationUnit` and `elevationDatum` properties. KML geometry is **2D unless the vertical reference is a
known metric orthometric one** (NAVD88, MSL height, EGM2008, EGM96), since
KML `absolute` means metres above mean sea level specifically — a WGS 84
ellipsoidal height is not that, and a depth axis is sign-flipped as well. The
source elevation, its unit and its datum are disclosed in each placemark
description, so the omitted ordinate is stated rather than lost.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is **opt-in and not wired** into the live scheduler — enabling it must first reconcile with the scheduler's ancestor-protection and be verified visually in a browser. Some budget-boundary "regions pulsing" may remain in this build.

## Startup bundle above the early-warning line

The live entry chunk measures 715 KiB against a hard 720 KiB ceiling — **5 KiB of margin**, and above the 680 KiB early-warning threshold. It was 693 KiB in alpha.1; the correctness gates added this cycle cost the difference. Treat the ceiling as effectively reached: shed weight before adding any, and do not raise it. The figure is machine-derived into `release/test-evidence.json` and checked by `lint:evidence`, because three documents once quoted 699 KiB for a build that produced 715.

## Mutation and coverage evidence is advisory, not archived

`npm run coverage` and `npm run mutation` both pass locally (the numeric-core mutation score was 87.23 % at the time of writing), but neither runs in CI and neither retains an artifact. Treat the figures as a working measurement, not a preserved claim, until a job publishes the reports. `terrainRunnerDensityWiring.test.ts` is excluded from the coverage run only — v8 instrumentation makes it take about 75 s per test — and still runs in the release buckets.

## Evidence ceiling: internal self-consistency

Scientific evidence tops out at E3 — synthetic known-truth checks against our own implementation. No terrain product has been compared against an independent implementation (PDAL / GDAL / CloudCompare); every `REFERENCE_SLOT` in `docs/validation/cross-implementation.md` still ships `pending`. This alpha does not claim survey-grade accuracy, standards compliance, or independent field validation.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).

## Axis and compound-unit handling is correct but not yet uniform

alpha.2 fixed the two places where an axis or unit assumption produced a wrong number: box dimensions now follow the scan's up-axis (they previously hardcoded Z as height, which also mis-applied the vertical unit factor on a Y-up frame), and the Scan Report footprint follows the source up-axis. There is still no single explicit model spanning up-axis, horizontal unit, vertical unit and CRS, so an unusual combination is more likely to be silently plausible than loudly refused. That model is a stable-v0.6 requirement.

**Boxes require an axis-aligned frame, and now say so.** A box measurement is stored as min/max corners, so it is axis-aligned by construction and its height can only be an extent along X, Y or Z. Given a genuinely tilted up vector the geometry used to fall back to the *dominant* component — reporting the extent along the nearest axis as the height, and carrying that into the footprint ring, the exported GeoJSON and KML polygons, and the compound-CRS vertical conversion. It now throws instead. No scan can currently trigger this: every world-up the viewer sets is exactly (0, ±1, 0) or (0, 0, ±1), chosen by source format, so the refusal guards the contract rather than gating a feature. Genuinely oriented boxes need a stored basis instead of an axis index, which is a stable-v0.6 item alongside the project frame — the two are the same "arbitrary frames" problem.
