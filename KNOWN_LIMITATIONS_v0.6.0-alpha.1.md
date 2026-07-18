# Known limitations — OpenLiDARViewer v0.6.0-alpha.1

This is an alpha for evaluation. The items below are known and deliberate — recorded here rather than hidden, in keeping with the project's honesty contract.

## Shared project frame is a foundation, not an active system

`ProjectSpatialFrame` / `LayerSpatialTransform` (value types + pure transform math) are tested and documented (`docs/architecture/project-spatial-frame.md`), but the running viewer does **not** yet mount layers through them. For this alpha:

- Cross-layer operations require the layers to already share a compatible coordinate frame (same CRS, comparable origins). Two georeferenced scans with different origins still mount in their own local frames.
- **Multi-dataset comparison is experimental.** Compare Studio, cross-layer measurement, shared clipping, and cross-layer picking are not backed by an authoritative project frame yet.
- Results that depend on a common frame should be treated as indicative when common-frame compatibility can't be established.
- Integrated Spatial Workflows are **not** claimed complete.

## Partial session matches restore automatically

The session source-identity guard **blocks** a clear conflict (a session captured over a different scan). A **partial** match — where the fingerprint neither clearly matches nor clearly conflicts — currently restores the session and shows a disclosure notice, rather than requiring explicit confirmation first. A confirmation gate before applying spatial measurements, views, clips, and annotations on a partial match is planned; until then, read the disclosure before trusting a partially-matched restore.

## PCD load emits a benign bounding-sphere warning on malformed input

The PCD loader routes decoded positions through the central non-finite sanitiser before building the point cloud, so no NaN reaches measurement, rendering, or export. However, the upstream `three` `PCDLoader.parse` computes a bounding sphere internally *before* that sanitation, so a PCD file containing non-finite coordinates produces a benign `THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN` console warning during parse. The rendered and measured cloud is unaffected; only the console message is emitted. Pre-filtering before the upstream parse is a planned cleanup.

## Residual streaming flicker at the budget boundary

An anti-thrash resident-stickiness option exists in the budget selector and is unit-tested, but it is **opt-in and not wired** into the live scheduler — enabling it must first reconcile with the scheduler's ancestor-protection and be verified visually in a browser. Some budget-boundary "regions pulsing" may remain in this build.

## Startup bundle above the early-warning line

The live entry chunk measures 692 KiB — within the hard 720 KiB ceiling but above the 680 KiB early-warning threshold, which the bundle-budget guard flags. Trimming it (e.g. deferring the session-import fact-building off the eager path) is a follow-up.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL / GDAL / proj4).
