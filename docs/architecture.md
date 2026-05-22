# Architecture

OpenLiDARViewer keeps one file per format and one file per concern. This page is a high-level map. The full reference is the [Developer Manual](developer-manual.md).

## Data flow

```
drop a file
   |
sniff format (magic bytes, then extension)
   |
Web Worker:  pick loader -> parse -> coordinate bridge -> voxel downsample
   |
PointCloud (normalized in-memory model)
   |
Viewer (WebGPU / WebGL 2)  ->  analysis modules  ->  Scan Intelligence panel
```

## Modules

**File loading and format detection.** `sniffFormat` identifies the format from magic bytes first, then the extension. `loadFile` reads the file and dispatches to a per-format loader.

**Point parsing.** There is one loader per format (`loadLas`, `loadE57`, `loadPly`, `loadObj`, `loadGltf`, `loadXyz`). LAS and LAZ point records are decoded by hand for full float64 precision, and LAZ is decompressed with the `laz-perf` WASM module. E57 is parsed by a from-scratch TypeScript module set under `io/e57/` — header de-paging, a minimal XML reader, and a `CompressedVector` binary decoder — which `loadE57` adapts into a `PointCloud`, merging multi-scan files and applying each scan's pose.

**Coordinate bridge.** Large georeferenced (UTM-scale) coordinates overflow 32-bit floats. Every cloud is recentered about an integer origin, and the subtraction happens in float64 before the float32 downcast.

**Render-buffer generation.** Each point becomes a camera-facing instanced quad, so it has a real, controllable size on both the WebGPU and WebGL 2 backends.

**Voxel downsampling.** Clouds above the point budget are reduced on a voxel grid. The Detail control always reports the honest `shown / total` count.

**Visualization modes.** `colorModes` derives per-point RGB for height, intensity, classification, stored RGB, or surface-normal direction.

**Navigation.** `NavController` owns the orbit, walk, and fly modes, keyboard input, pointer-lock mouse-look, and eased camera tweens. The movement maths is a separate, pure, unit-tested module.

**Measurement.** The measurement toolkit (`render/measure/`) supports six kinds — distance, polyline, area, height, angle, and slope. The geometry, value formatting, session serialization, and label layout are pure, unit-tested modules with no three.js or DOM dependency. A controller picks points by ray, supports draggable editing, and draws markers, lines, polygons, and anti-overlapping labels as an SVG overlay — backend-agnostic across WebGPU and WebGL 2.

**Inspection.** The inspect tool picks the nearest point to a ray and shows its real-world coordinates and attributes in a floating card. The picked-point data shape and its clipboard and JSON forms live in a pure, unit-tested module.

**Scan Intelligence.** The analysis modules (`healthCheck`, `scanReport`) are pure functions over a `PointCloud`. They return rows and never touch the renderer. New modules register through an open API.

**Export.** Pure serializers turn a `PointCloud` back into PLY, OBJ, XYZ, or CSV text.

## Layering rule

`src/io/` owns one format or concern per file. `Viewer.ts` owns all three.js state. Analysis modules consume `PointCloud` only and never import the renderer. The algorithmic core is test-first with Vitest, and the renderer and worker are covered by Playwright.
