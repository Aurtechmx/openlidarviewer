# Performance

OpenLiDARViewer runs in the browser and depends on modern GPU-accelerated web rendering. Performance varies with the dataset and the device.

## What performance depends on

The main factors are point count, browser memory, GPU capability, point size, rendering detail, the color mode in use, the file format, and how the data was prepared.

## System requirements

Use a modern Chromium-based browser (Chrome or Edge) with WebGL 2.0 support and hardware acceleration enabled. WebGPU is used automatically where it is available.

| Component | Minimum | Recommended |
|---|---|---|
| CPU | Modern dual-core processor | Quad-core or better |
| RAM | 8 GB | 16 GB or more |
| GPU | Integrated GPU with WebGL 2.0 | Dedicated GPU, or modern Apple Silicon / integrated GPU |
| Browser | WebGL 2.0 compatible | WebGL 2.0 and WebGPU-capable |
| Storage | Space for local scan files | SSD recommended for large datasets |

## Dataset size

Small point clouds work on most modern laptops. Medium datasets benefit from 16 GB of RAM and a modern GPU. Very large LiDAR datasets are best handled through streaming formats such as COPC or EPT — opened progressively through their octree hierarchies so only what the current view needs is fetched, decoded, and uploaded to the GPU. Non-streaming formats above the point budget are downsampled on load to stay responsive; browser memory limits can still affect extremely large scans regardless of format.

Clouds above a point budget of roughly 4M points are downsampled on load to stay responsive — see *Loading large files* below. The Detail control always shows the honest `shown / total` count, so you know exactly what you are looking at.

## Loading large files

A dropped LAS or LAZ file is planned before it is fully read. A small header slice reveals the point count and byte size, and from those a load strategy is chosen: a cloud within the point budget is decoded in full; a cloud moderately over budget is decoded and voxel-downsampled; a cloud far over budget is *stride-decoded* down to a memory-safe intermediate — a stratified, jittered one-in-N sample of the records — which is then voxel-downsampled to the budget. The cloud is never fully *decoded* into memory — though its source bytes are read in once — and because the final step is the same voxel pass medium clouds get, the result keeps uniform density: no scan-line aliasing, and no flight-strip density blocks. For uncompressed LAS the stride step also makes the decode proportionally faster; for LAZ, whose records must be decompressed in sequence, it lowers the memory peak but not the decode time.

Before any large allocation, the load estimates the memory it will need. If that is risky for the device, it automatically falls back to a sparser load and says so in the status toast, rather than risking an out-of-memory crash.

The load reports staged progress — detecting format, reading, decoding with a live point counter, optimizing, rendering — and can be cancelled at any point from the Cancel control on the progress toast. Adding `?debug=1` to the URL logs a per-stage timing breakdown to the browser console.

## Rendering backend

OpenLiDARViewer uses the WebGPU renderer when the browser supports it, and falls back automatically to WebGL 2 otherwise. The active backend is shown in the bottom-right indicator. Points are drawn as instanced, camera-facing quads, so they render at a real, controllable size on both backends.

The device-pixel-ratio is capped at 2, which bounds the render cost on high-density displays with no perceptible loss of sharpness.

## Eye Dome Lighting

Eye Dome Lighting adds a single full-screen post-processing pass that samples scene depth — a small, fixed cost independent of point count, and cheap next to drawing the cloud itself. It is on by default on desktop WebGPU and off by default on the WebGL 2 fallback and on phones, so a weaker device is never dropped below interactive on load. It can be toggled, and its strength tuned, from the Rendering section of the panel. Turning it off restores the direct render path with no post-processing overhead.

## Browser settings

For best performance, enable hardware acceleration, use a modern Chromium-based browser, and close unnecessary tabs when loading large point clouds. Use the detail and point-size controls for heavy datasets, and prefer optimised, tiled, or downsampled files for very large scans.

## Benchmarks

Real-world figures — a 9.6 M-point drone LAZ survey and a 55 K-point iPhone scan, both opened from one drag-and-drop on an Apple MacBook Pro M3 Max — are recorded in [`benchmarks.md`](benchmarks.md), alongside the v0.3.3 synthetic stress runs that validate bounded residency and zero thrash up to 1 B-point streaming hierarchies. Hardware, browser, dataset, and the rendering detail you pick all change the numbers; the published figures are field observations, not a formal benchmark suite.

## Privacy

OpenLiDARViewer is built around local-first inspection. Files are read, parsed, and rendered in the browser, and there is no server to upload them to. See [SECURITY.md](../SECURITY.md).

## Mobile Performance

Mobile devices have stricter memory and GPU limits than desktop systems.

Recommendations:

- Start with smaller GLTF / GLB / PLY files.
- Use Mobile Safe or Balanced detail.
- Avoid very large LAS/LAZ datasets on phones unless they are optimized.
- Use a desktop for heavy drone LiDAR datasets.
- Close unused browser tabs.
- Keep hardware acceleration enabled when available.
- WebGPU support may vary; the WebGL 2 fallback should remain reliable.
