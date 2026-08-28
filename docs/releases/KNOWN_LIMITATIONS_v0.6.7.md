# Known limitations: OpenLiDARViewer v0.6.7

v0.6.7 is a licensing and engineering-hardening release. It changes the license to AGPL-3.0-only, hardens the read paths against malformed and oversized input, and adds out-of-core streaming for heavy local files and 3D Tiles implicit tiling. It adds no new scientific evidence claim: the register stays at twelve products at E4, exactly as validated in v0.6.6, and every limit below is inherited from `KNOWN_LIMITATIONS_v0.6.6.md` except where this cycle's engineering changed the wording. The full inherited list is that file; the sections here restate the load-bearing limits and the boundary of the new engineering.

## No new evidence claim in this release

The memory-safety hardening and the two new ingest paths are covered by the test suite, not by a scientific claim. No product is promoted, no new cross-implementation study is added, and no field campaign is run. The twelve E4 products and their boundaries are unchanged from v0.6.6, and this release does not claim survey-grade accuracy, standards compliance or independent field validation.

## The two monoliths are still monoliths

`src/main.ts` is 5,675 lines and `src/render/Viewer.ts` is 6,419, against stated targets of 2,500 and 2,000. Both counts are unchanged this cycle: the engineering here landed in the read and streaming paths rather than in the composition root or the renderer, so neither monolith grew or shrank. The remaining blocks to lift are in `docs/architecture/architecture-map.md`.

## Out-of-core streaming holds the index, not the whole cloud

A very large uncompressed LAS and a chunked LAZ are indexed into temporary browser storage in the Origin Private File System and streamed from that index. The device must still hold the index and the resident working set; a file whose index alone exceeds the budget is refused with guidance rather than opened. The stratified preview sample is a sample, marked incomplete until the full index swaps in, so a measurement taken against the preview is a measurement against a subset. The store lifecycle is leak-free and a startup janitor sweeps abandoned stores, but the Origin Private File System is per-origin browser storage that a user or the browser can clear, so an index is a working cache and not a durable artifact.

## 3D Tiles implicit tiling reads the subtree form, and the wider format is bounded

Quadtree and octree implicit subtrees now open and stream. This is the implicit hierarchy of the 3D Tiles specification; a set is read where it encodes its hierarchy as subtrees rather than as an explicit tile tree. It is an ingest path, not an evidence claim, and it does not change any computed number. The parsers remain strict at the format boundary and refuse a malformed tileset rather than failing open.

## The memory-safety budget is a ceiling, not a validation of every input

One shared decoded-byte budget caps the LAZ chunk table, the LAZ chunks and windows, the LAS record batches, the COPC nodes and the out-of-core tiles together, so a malformed multi-gigabyte input is refused before it allocates past that budget. What this bounds is allocation from a hostile or truncated file. It is not a claim that every well-formed file within the budget decodes correctly, which is what the format conformance tests cover, and it does not change the numbers a good file produces.

## Multi-layer mounting: enabled, with one precision refinement outstanding

Physical multi-layer mounting is enabled. Two georeferenced layers that declare the same projected CRS mount into one shared project frame at their real separation, non-destructively, and each boundary recovers the world coordinate in the frame it names. One item is a precision refinement rather than a correctness defect: for far-apart mounts the renderer should fold `renderOrigin` out on the CPU per mesh so the Float32 GPU residual stays small. It is bounded and refused past 1 mm by the mount-precision gate, so a placement that cannot hold a millimetre never mounts. Incompatible layers carry no placement and stay in their own frame.

## No cross-CRS reprojection

Unchanged from prior releases: the viewer does not reproject between coordinate systems. Equal-CRS scans display alongside each other; mixed-CRS scans display in their on-disk local frames. Aligning different CRSs needs a downstream tool (PDAL, GDAL or proj4).

## Evidence ceiling: twelve cross-implemented products, no product at E5

Twelve products have been compared against an independent implementation, exactly as recorded for v0.6.6: `SLOPE-RASTER`, `ASPECT-RASTER`, `HILLSHADE`, `CONTOURS` and `MEAS-AREA` against GDAL; `DSM`, `DTM` and `CHM` against PDAL 2.10.2 `writers.gdal`; `TPI` against gdaldem 3.13.1 and `VRM` against SAGA 7.8.2, each also against the closed form on a controlled analytic fixture; `MEAS-PROFILE` against a reference assembled from OGR/SpatiaLite and R; and `E57-INGEST` against PDAL `readers.e57`. Those grades and their boundaries are stated in full in `KNOWN_LIMITATIONS_v0.6.6.md` and are inherited without change. The PDAL surface checks cover the cell gridding on clouds where the reference radius is below half a cell, not ground classification and not real-terrain void interpolation, so `GROUND-FILTER` stays partial and the DTM's own required bar remains E5. Every other terrain product tops out at E3. No registered product reaches E5, and no result in this release promotes a claim.

## Inherited limits

The remaining limits from v0.6.6 apply unchanged and are not restated here in full: building classification's synthetic-only ground-support gate, return-number-aware automatic classification, cross-layer results requiring proven frame compatibility, review-grade derived-ground terrain, contour GeoJSON shipping in two frames, the residual streaming flicker at the point-budget boundary in the default configuration, the startup bundle above the early-warning line, advisory mutation and coverage evidence, two-platform reproducibility, the Float32 render-local position contract and its effect on classification and volume, LAS 1.4 support with 1.5 read through the 1.4 path, and the density-gradient volume figure. Each is stated in `KNOWN_LIMITATIONS_v0.6.6.md`.
