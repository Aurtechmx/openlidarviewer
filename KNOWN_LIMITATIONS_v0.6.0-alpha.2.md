# Known limitations — OpenLiDARViewer v0.6.0-alpha.2

This is an alpha for evaluation. The items below are known and deliberate — recorded here rather than hidden, in keeping with the project's honesty contract.

## The two monoliths are still monoliths

`src/main.ts` is 7,574 lines and `src/render/Viewer.ts` is 7,297, against stated targets of 2,500 and 2,000. alpha.2 finished the composition root (no module-level mutable application state remains in `main.ts`) and wrote the architecture down with a drift check, but that is the scaffolding for the decomposition, not the decomposition. The ten blocks to lift, and the measured dependency surface of the first one, are in `docs/architecture/architecture-map.md`.

## Shared project frame is applied to static layers; browser confirmation pending

`ProjectSpatialFrame` / `LayerSpatialTransform` (value types + pure transform math) are tested and documented (`docs/architecture/project-spatial-frame.md`). alpha.2 lands **step 1** of the wiring plan: the app now owns a live project frame (`src/app/projectFrame.ts`, on `AppContext`), reseeded from the loaded layer set on every change, choosing one shared origin and deriving each layer's translation into it. A single layer anchors the frame at its own origin, so its transform is the identity and the single-scan path is unchanged.

Step 2 has landed: static layers now MOUNT at their `sourceToProject` translation, so two same-CRS georeferenced scans with different origins place at their true relative positions. A lone layer is the identity (single-scan path unchanged by construction; the full e2e suite passes untouched). Still staged for this alpha:

- **Two-scan placement is verified in Node, not yet in a browser** with real georeferenced fixtures — treat multi-layer placement as needing that one visual confirmation.
- Elevation colour ramps do not yet account for per-layer offsets; with offset layers loaded, treat elevation-coloured views as indicative. The measurement datum DOES follow the frame when every loaded layer is in it (step 4), and falls back to the pre-frame unanimity rule otherwise.

For this alpha:

- Cross-layer operations still require a shared CRS: a layer whose declared CRS disagrees is excluded from the frame and mounts where it always did.
- **Multi-dataset comparison is experimental.** Compare Studio, cross-layer measurement, shared clipping and elevation ramps do not yet read the frame's offsets (steps 3–5 of the plan).
- Results that depend on a common frame should be treated as indicative when common-frame compatibility can't be established.
- Integrated Spatial Workflows are **not** claimed complete.
- A layer whose declared CRS disagrees with the project's is excluded from the shared origin and reported as unaligned; it is never silently reprojected. Reprojection remains a downstream tool's job.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is **opt-in and not wired** into the live scheduler — enabling it must first reconcile with the scheduler's ancestor-protection and be verified visually in a browser. Some budget-boundary "regions pulsing" may remain in this build.

## Startup bundle above the early-warning line

The live entry chunk measures 699 KiB — within the hard 720 KiB ceiling but above the 680 KiB early-warning threshold, which the bundle-budget guard flags. It grew from 693 KiB in alpha.1: the new services and gates cost bytes. Trimming it (e.g. deferring the session-import fact-building off the eager path) is a follow-up, and the ceiling should not be raised to absorb the growth.

## Mutation and coverage evidence is advisory, not archived

`npm run coverage` and `npm run mutation` both pass locally (the numeric-core mutation score was 87.23 % at the time of writing), but neither runs in CI and neither retains an artifact. Treat the figures as a working measurement, not a preserved claim, until a job publishes the reports. `terrainRunnerDensityWiring.test.ts` is excluded from the coverage run only — v8 instrumentation makes it take about 75 s per test — and still runs in the release buckets.

## Evidence ceiling: internal self-consistency

Scientific evidence tops out at E3 — synthetic known-truth checks against our own implementation. No terrain product has been compared against an independent implementation (PDAL / GDAL / CloudCompare); every `REFERENCE_SLOT` in `docs/validation/cross-implementation.md` still ships `pending`. This alpha does not claim survey-grade accuracy, standards compliance, or independent field validation.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).

## Axis and compound-unit handling is correct but not yet uniform

alpha.2 fixed the two places where an axis or unit assumption produced a wrong number: box dimensions now follow the scan's up-axis (they previously hardcoded Z as height, which also mis-applied the vertical unit factor on a Y-up frame), and the Scan Report footprint follows the source up-axis. There is still no single explicit model spanning up-axis, horizontal unit, vertical unit and CRS, so an unusual combination is more likely to be silently plausible than loudly refused. That model is a stable-v0.6 requirement.

**Boxes require an axis-aligned frame, and now say so.** A box measurement is stored as min/max corners, so it is axis-aligned by construction and its height can only be an extent along X, Y or Z. Given a genuinely tilted up vector the geometry used to fall back to the *dominant* component — reporting the extent along the nearest axis as the height, and carrying that into the footprint ring, the exported GeoJSON and KML polygons, and the compound-CRS vertical conversion. It now throws instead. No scan can currently trigger this: every world-up the viewer sets is exactly (0, ±1, 0) or (0, 0, ±1), chosen by source format, so the refusal guards the contract rather than gating a feature. Genuinely oriented boxes need a stored basis instead of an axis index, which is a stable-v0.6 item alongside the project frame — the two are the same "arbitrary frames" problem.
