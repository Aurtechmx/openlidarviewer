# Supported / Target Formats

Format support is still evolving. This page separates what works today from what is planned.

## Current import formats

| Format | Typical source | Notes |
|---|---|---|
| `LAS` | Drone / aerial LiDAR | Georeferenced; coordinate bridge applied |
| `LAZ` | Drone / aerial LiDAR | Compressed LAS, decoded in-browser (laz-perf WASM) |
| `PLY` | iPhone / mobile scans | Point clouds and meshes; RGB supported |
| `OBJ` | Mesh scans, 3D tools | Mesh vertices used as points |
| `GLB` / `GLTF` | AR tools, mobile scans | Mesh vertices used as points |
| `XYZ` | Survey / generic export | Whitespace-delimited text; optional RGB |
| `CSV` | Survey / generic export | Comma-delimited text; optional RGB |

## Current export targets

`PLY`, `OBJ`, `XYZ`, and `CSV`, re-exported in real-world (global) coordinates, plus `PNG` snapshots of the current view.

## iPhone and mobile scan exports

OpenLiDARViewer opens exports from iPhone LiDAR and mobile scanning apps when they are saved as a supported format. `PLY`, `OBJ`, `GLB`/`GLTF`, `XYZ`, and `CSV` all work today. `USDZ` and `E57` exports need conversion to a supported format first. What works depends on the app's export format, the file structure, browser memory, and the current implementation.

## Drone LiDAR and professional point clouds

Georeferenced drone LiDAR surveys in `LAS` and `LAZ` work today, including large UTM-scale coordinates handled by the coordinate bridge.

Planned support: `E57`, the common terrestrial and mixed-scan exchange format; `PCD`, the Point Cloud Library format; and `PTS` / `PTX`, the terrestrial scanner formats.

## Large-scale and web formats

For very large datasets, the planned direction is `COPC LAZ` (cloud-optimised point cloud), `3D Tiles` / `PNTS` (tiled, streamable point clouds), and tiled or streamed datasets with level-of-detail.

## Notes

Format support varies with browser memory, GPU capacity, dataset size, preprocessing, and implementation status. Very large files may need downsampling, tiling, or conversion before they load smoothly. Anything listed as planned is not implemented yet. See [roadmap.md](roadmap.md).
