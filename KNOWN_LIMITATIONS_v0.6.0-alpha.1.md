# Known limitations — OpenLiDARViewer v0.6.0-alpha.1

This is an alpha for evaluation. The items below are known and deliberate — recorded here rather than hidden, in keeping with the project's honesty contract.

## Shared project frame is a foundation, not an active system

`ProjectSpatialFrame` / `LayerSpatialTransform` (value types + pure transform math) are tested and documented (`docs/architecture/project-spatial-frame.md`), but the running viewer does **not** yet mount layers through them. For this alpha:

- Cross-layer operations require the layers to already share a compatible coordinate frame (same CRS, comparable origins). Two georeferenced scans with different origins still mount in their own local frames.
- **Multi-dataset comparison is experimental.** Compare Studio, cross-layer measurement, shared clipping, and cross-layer picking are not backed by an authoritative project frame yet.
- Results that depend on a common frame should be treated as indicative when common-frame compatibility can't be established.
- Integrated Spatial Workflows are **not** claimed complete.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is **opt-in and not wired** into the live scheduler — enabling it must first reconcile with the scheduler's ancestor-protection and be verified visually in a browser. Some budget-boundary "regions pulsing" may remain in this build.

## Startup bundle above the early-warning line

The live entry chunk measures 693 KiB — within the hard 720 KiB ceiling but above the 680 KiB early-warning threshold, which the bundle-budget guard flags. Trimming it (e.g. deferring the session-import fact-building off the eager path) is a follow-up.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).
