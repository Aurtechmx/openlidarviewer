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

**Point parsing.** There is one loader per format (`loadLas`, `loadPly`, `loadObj`, `loadGltf`, `loadXyz`). LAS and LAZ point records are decoded by hand for full float64 precision, and LAZ is decompressed with the `laz-perf` WASM module.

**Coordinate bridge.** Large georeferenced (UTM-scale) coordinates overflow 32-bit floats. Every cloud is recentered about an integer origin, and the subtraction happens in float64 before the float32 downcast.

**Render-buffer generation.** Each point becomes a camera-facing instanced quad, so it has a real, controllable size on both the WebGPU and WebGL 2 backends.

**Voxel downsampling.** Clouds above the point budget are reduced on a voxel grid. The Detail control always reports the honest `shown / total` count.

**Visualization modes.** `colorModes` derives per-point RGB for height, intensity, classification, or stored RGB.

**Navigation.** `NavController` owns the orbit, walk, and fly modes, keyboard input, pointer-lock mouse-look, and eased camera tweens. The movement maths is a separate, pure, unit-tested module.

**Measurement.** The measure tool picks points by ray and draws markers, lines, and distance labels as an SVG overlay.

**Scan Intelligence.** The analysis modules (`healthCheck`, `scanReport`) are pure functions over a `PointCloud`. They return rows and never touch the renderer. New modules register through an open API.

**Export.** Pure serializers turn a `PointCloud` back into PLY, OBJ, XYZ, or CSV text.

## Layering rule

`src/io/` owns one format or concern per file. `Viewer.ts` owns all three.js state. Analysis modules consume `PointCloud` only and never import the renderer. The algorithmic core is test-first with Vitest, and the renderer and worker are covered by Playwright.
