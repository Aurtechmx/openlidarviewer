# Supported / Target Formats

Format support is still evolving. This page separates what works today from what is planned.

## Current import formats

| Format | Typical source | Notes |
|---|---|---|
| `LAS` | Drone / aerial LiDAR | Georeferenced; coordinate bridge applied |
| `LAZ` | Drone / aerial LiDAR | Compressed LAS, decoded in-browser (laz-perf WASM) |
| `E57` | Terrestrial laser scanners | ASTM E2807; coordinates, RGB, intensity, classification, normals; multi-scan files merged |
| `PLY` | iPhone / mobile scans | Point clouds and meshes; RGB supported |
| `OBJ` | Mesh scans, 3D tools | Mesh vertices used as points |
| `GLB` / `GLTF` | AR tools, mobile scans | Mesh vertices used as points |
| `XYZ` | Survey / generic export | Whitespace-delimited text; optional RGB; chunked, bounded-memory reading |
| `CSV` | Survey / generic export | Comma-delimited text; optional RGB; chunked, bounded-memory reading |
| `PCD` | Point Cloud Library | ASCII, binary, and binary-compressed; position, RGB, intensity, normals, labels |
| `PTX` | Terrestrial laser scanners | Multi-scan text; per-scan pose applied; scanner origin recorded |
| `PTS` | Terrestrial laser scanners | Whitespace-delimited text; optional header count; 3/4/6/7-column layouts; chunked reading |

## Current export targets

`PLY`, `OBJ`, `XYZ`, and `CSV`, re-exported in real-world (global) coordinates, plus `PNG` snapshots of the current view.

## iPhone and mobile scan exports

OpenLiDARViewer opens exports from iPhone LiDAR and mobile scanning apps when they are saved as a supported format. `PLY`, `OBJ`, `GLB`/`GLTF`, `XYZ`, and `CSV` all work today. `USDZ` exports need conversion to a supported format first. What works depends on the app's export format, the file structure, browser memory, and the current implementation.

## Terrestrial laser scanners (E57)

`E57` (ASTM E2807) is the standard exchange format for terrestrial laser scanners and is read directly in the browser by a from-scratch TypeScript parser — nothing is uploaded and no conversion step is needed.

The parser decodes Cartesian coordinates, RGB colour, intensity, classification, and per-point surface normals. It applies each scan's recorded pose (rotation and translation), drops points the file flags as invalid, and bridges global coordinates into the viewer's local space with the same coordinate bridge the LAS loader uses. Multi-scan E57 files are merged into a single cloud, and the file's generating software is read from the header and shown in the Scan Report.

E57 exports from Trimble survey scanners have been tested directly. Other standard E57 files — from Leica, FARO, Matterport, and similar systems — follow the same ASTM format and are expected to work; E57 files that use uncommon or non-standard schema features may not.

## Drone LiDAR and other professional point clouds

Georeferenced drone LiDAR surveys in `LAS` and `LAZ` work today, including large UTM-scale coordinates handled by the coordinate bridge.

`PCD` — the Point Cloud Library format — is read directly in the browser in its ASCII, binary, and binary-compressed variants, with position, RGB colour, intensity, surface normals, and labels decoded where the file carries them.

`PTX` and `PTS`, the terrestrial laser-scanner text formats, are also read in the browser. PTX multi-scan files apply each scan's recorded pose matrix, merge every scan into one cloud, and record the scanner origin (shown in the Scan Report). PTS files read the optional leading point-count line and the standard 3-, 4-, 6-, and 7-column layouts; like XYZ and CSV they are read in bounded chunks so a very large text scan loads without exhausting memory.

## Large-scale and web formats

For very large datasets, the planned direction is `COPC LAZ` (cloud-optimised point cloud), `3D Tiles` / `PNTS` (tiled, streamable point clouds), and tiled or streamed datasets with level-of-detail.

## Mobile Scan Exports

OpenLiDARViewer can open compatible files exported from mobile scanning apps when the exported format is supported by the viewer.

Recommended mobile formats:

- GLTF / GLB — practical for mobile mesh workflows and some free mobile scanning workflows
- PLY — useful for point-cloud workflows when available
- OBJ — common mesh format when available
- XYZ / CSV — useful for raw point-coordinate workflows
- LAS / LAZ — professional LiDAR formats if exported or converted

Mobile scanning apps: Several iPhone LiDAR scanning apps — such as Polycam, Scaniverse, or 3D Scanner App — can export scans in these formats. Available formats and free-tier options differ between apps and can change, so check each app's current help documentation. Some formats may require a paid plan.

Trademark note: OpenLiDARViewer is not affiliated with, endorsed by, or sponsored by Apple or any third-party scanning app.

## Notes

Format support varies with browser memory, GPU capacity, dataset size, preprocessing, and implementation status. Very large files may need downsampling, tiling, or conversion before they load smoothly. Anything listed as planned is not implemented yet. See [roadmap.md](roadmap.md).
