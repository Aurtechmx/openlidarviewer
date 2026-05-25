# Architecture

OpenLiDARViewer keeps one file per format and one file per concern. This page is a high-level map. The full reference is the [Developer Manual](developer-manual.md).

## Data flow

```
drop a file
   |
preflight (main thread):  read a 4 KB head slice -> sniff format
                          -> for LAS/LAZ, parse the header -> build a load plan
   |
read the whole file
   |
Web Worker:  decode per the plan (all / voxel / stride) -> coordinate bridge
             -> voxel downsample (when the plan calls for it)
   |
PointCloud (normalized in-memory model)
   |
Viewer (WebGPU / WebGL 2)  ->  analysis modules  ->  Scan Intelligence panel
```

## Modules

**File loading and format detection.** A file reaches the viewer through a `PointCloudSource` — the abstraction that decouples *where* a cloud comes from from *how* it decodes. v0.2.9 ships one implementation, `LocalFileSource` (a dropped or picked file); the interface is the seam for v0.3 streaming sources. `loadFile` runs a preflight on the main thread: it reads only a 4 KB head slice, identifies the format from magic bytes (then the extension), parses the public header for LAS/LAZ, and reads the optional count line for PTS. An unsupported file fails here — with a typed, categorised `LoadError` — before the whole file is ever read, and a universal preload summary tells the user what was detected. The full file is then handed to a long-lived parse worker, reused across loads. A load reports staged progress and can be cancelled mid-flight through an `AbortSignal`.

**Load planning.** For LAS/LAZ, `loadPlan` turns the header's point count and the file size into a budget-aware plan: decode every point when the cloud is within the point budget, decode-then-voxel-reduce at a moderate overshoot, or — when it is far over budget — *stride-decode* the cloud down to a memory-safe intermediate (a stratified, jittered sample, `strideSample.ts`) and then voxel-downsample that to the budget. A huge survey is never fully held in memory, and because every over-budget path ends in the same voxel pass, the fast-loaded cloud keeps uniform density — no scan-line aliasing, no flight-strip density blocks. A memory estimate guards the plan — a load that would risk an out-of-memory crash on the device is automatically downgraded to a sparser one. `loadPlan` and `strideSample` are pure, unit-tested modules.

**Point parsing.** There is one loader per format (`loadLas`, `loadE57`, `loadPly`, `loadObj`, `loadGltf`, `loadXyz`, `loadPcd`, `loadPtx`, `loadPts`), reached through a loader registry: `loaderRegistry.ts` maps each format to its decoder, while a separate `formatInfo.ts` holds the lightweight format facts the preflight and UI need — keeping the heavy decoders out of the main bundle. LAS and LAZ point records are decoded by hand, straight into the local coordinate frame — the float64 arithmetic happens before the float32 store, so precision is preserved with no intermediate global-coordinate pass. LAZ is decompressed with the `laz-perf` WASM module, which is instantiated once and reused across loads. E57 is parsed by a from-scratch TypeScript module set under `io/e57/` — header de-paging, a minimal XML reader, and a `CompressedVector` binary decoder — which `loadE57` adapts into a `PointCloud`, merging multi-scan files and applying each scan's pose. PCD is decoded through three.js's `PCDLoader` (ASCII, binary, and binary-compressed). PTX applies each scan block's pose matrix and records the scanner origin; PTS, XYZ and CSV are read through a chunked text reader (`textChunkReader.ts`) so a very large text cloud never has to be held in memory at once.

**COPC streaming.** A COPC (`.copc.laz`) file takes a separate pipeline from the static loaders — the two never call into each other. A `RangeSource` (`io/range/`) answers arbitrary byte-range reads (local `File.slice` today; an `HttpRangeSource` scaffold for v0.3.1). `CopcSource` opens the file with partial reads — detection, the LAS 1.4 header and COPC `info` VLR, then the octree hierarchy of 32-byte entries (the index, never the point data). A `StreamingOctree` holds the node records; node bounds derive from the normative COPC `info` VLR cube. A view-dependent `StreamingScheduler` — three.js-free, fed a plain view-projection matrix — frustum-culls, scores nodes coarse-first, enforces a point budget, and dispatches decodes; LAZ chunk decompression runs in a dedicated worker via laz-perf's per-chunk decoder. A `StreamingCache` bounds the compressed-chunk memory with an LRU, and `StreamingRenderer` draws each resident node with the *same* instanced-quad mesh a static cloud uses — so Eye Dome Lighting, the colour modes, and both backends apply for free. The scheduler, octree, cache, and scoring are pure, unit-tested modules; the worker decode is verified against a real COPC file. See [`streaming.md`](streaming.md).

**Coordinate bridge.** Large georeferenced (UTM-scale) coordinates overflow 32-bit floats. Every cloud is recentered about an integer origin, and the subtraction happens in float64 before the float32 downcast.

**Render-buffer generation.** Each point becomes a camera-facing instanced quad, so it has a real, controllable size on both the WebGPU and WebGL 2 backends. A circular alpha mask plus alpha-to-coverage makes each point a round, antialiased dot, and the point size is either fixed or adaptively scaled with camera distance.

**Voxel downsampling.** Clouds above the point budget are reduced on a voxel grid. The Detail control always reports the honest `shown / total` count.

**Visualization modes.** `colorModes` derives per-point RGB for height, intensity, classification, stored RGB, or surface-normal direction.

**Eye Dome Lighting.** When enabled, the scene renders into a `three/tsl` post-processing `pass`; an EDL node then compares each pixel's depth with its screen-space neighbours and darkens depth discontinuities, adding readable depth cueing. The one node graph compiles to both backends. The depth maths is mirrored by the pure, unit-tested `edl.ts`; the adaptive point-size curve by `pointStyle.ts`.

**Navigation.** `NavController` owns the orbit, walk, and fly modes, keyboard input, pointer-lock mouse-look, and eased camera tweens. The movement maths is a separate, pure, unit-tested module.

**Measurement.** The measurement toolkit (`render/measure/`) supports six kinds — distance, polyline, area, height, angle, and slope. The geometry, value formatting, session serialization, and label layout are pure, unit-tested modules with no three.js or DOM dependency. A controller picks points by ray, supports draggable editing, and draws markers, lines, polygons, and anti-overlapping labels as an SVG overlay — backend-agnostic across WebGPU and WebGL 2.

**Inspection.** The inspect tool picks the nearest point to a ray and shows its real-world coordinates and attributes — including LAS return number, point source ID, and GPS time — in a floating card. The picked-point data shape and its clipboard and JSON forms live in a pure, unit-tested module. The live probe reuses the same picker and data shape for a click-free hover readout.

**Annotations.** The annotation layer (`render/annotate/`) mirrors the measurement toolkit: a pure, unit-tested data model and session schema with no three.js or DOM dependency, a controller that owns the annotation list, selection, and a bounded undo history, and a persistent-element SVG overlay that draws one marker group per annotation — so a review with hundreds of markers costs no per-frame budget. An annotation can capture the camera viewpoint it was placed from and link to a measurement; the Annotations panel sorts, searches, and revisits the list.

**Scan Intelligence.** The analysis modules (`healthCheck`, `scanReport`) are pure functions over a `PointCloud`. They return rows and never touch the renderer. New modules register through an open API.

**Export.** Pure serializers turn a `PointCloud` back into PLY, OBJ, XYZ, or CSV text.

## Layering rule

`src/io/` owns one format or concern per file. `Viewer.ts` owns all three.js state. Analysis modules consume `PointCloud` only and never import the renderer. The algorithmic core is test-first with Vitest, and the renderer and worker are covered by Playwright.
