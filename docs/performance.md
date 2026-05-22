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

Small point clouds work on most modern laptops. Medium datasets benefit from 16 GB of RAM and a modern GPU. Very large LiDAR datasets may need downsampling, preprocessing, tiling, or future streaming formats such as COPC LAZ or 3D Tiles, and browser memory limits can affect extremely large scans.

Clouds above a point budget of roughly 4M points are voxel-downsampled on load to stay responsive. The Detail control always shows the honest `shown / total` count, so you know exactly what you are looking at.

## Rendering backend

OpenLiDARViewer uses the WebGPU renderer when the browser supports it, and falls back automatically to WebGL 2 otherwise. The active backend is shown in the bottom-right indicator. Points are drawn as instanced, camera-facing quads, so they render at a real, controllable size on both backends.

## Browser settings

For best performance, enable hardware acceleration, use a modern Chromium-based browser, and close unnecessary tabs when loading large point clouds. Use the detail and point-size controls for heavy datasets, and prefer optimised, tiled, or downsampled files for very large scans.

## Benchmarks

Real benchmark numbers should be measured on representative hardware before being published. Use this table as a template.

| Dataset | Points | Browser | GPU | Mode | FPS / Notes |
|---|---:|---|---|---|---|
| _replace_ | _replace_ | Chrome / Edge | _replace_ | Balanced | _replace_ |

Replace this table with real measurements before making any performance claims.

## Planned work

Tiled datasets, COPC LAZ, 3D Tiles / PNTS streaming, level-of-detail controls, and performance presets for large datasets. See [roadmap.md](roadmap.md).

## Privacy

OpenLiDARViewer is built around local-first inspection. Files are read, parsed, and rendered in the browser, and there is no server to upload them to. That makes it suitable for sensitive survey data. See [SECURITY.md](../SECURITY.md).

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
