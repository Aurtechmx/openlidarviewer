# Current Limitations

OpenLiDARViewer is an active R&D-stage project focused on lightweight visualization and interaction. It is not meant to replace full GIS, photogrammetry, or survey-grade processing tools. Being clear about the limits is part of the design.

## Known limitations

Large files are limited by browser memory and GPU performance. A cloud above the point budget is loaded at reduced density — voxel-downsampled, or, when it is far over budget, stride-decoded so it is never fully held in memory. If a load would still risk exhausting memory, it automatically falls back to a sparser one and says so in the status toast.

Fast loading of compressed LAZ is bounded by the decoder. A very large LAZ file loads with a lower memory peak under fast load, but not proportionally faster: the `laz-perf` decoder decompresses records strictly in sequence, so stride loading still decompresses every record — it only skips the coordinate transform and storage for the records it drops. Uncompressed LAS, whose records are randomly addressable, does get the proportional speed-up.

Format coverage is still evolving. Some LiDAR formats need preprocessing or conversion before they load. See [supported-formats.md](supported-formats.md).

Measurement is for visual inspection. The measurement toolkit — distance, polyline, area, height, angle, and slope — is meant for inspection and documentation. It is not survey-grade and should not be treated as such unless it has been validated against survey-grade data and procedures. Measurements are kept for the browser session; the JSON session export is the way to retain them beyond that.

E57 coverage is broad but not exhaustive. The E57 reader handles the common real-world files terrestrial scanners produce — Cartesian XYZ with colour, intensity, classification, and normals — and has been tested with Trimble exports. E57 files that use uncommon schema features, spherical coordinates, or non-standard extensions may not load.

Coordinate reference systems are handled only loosely. The viewer recenters large coordinates for precision, but it does not do full CRS handling or reprojection.

Classification visualization depends on classification attributes actually being present in the file, and many scans carry none.

Very large datasets are handled through streaming. A COPC (Cloud Optimized Point Cloud) `.copc.laz` file or an EPT (Entwine Point Tile) dataset, local or hosted at a CORS-enabled URL, opens through progressive, octree-based streaming: partial range reads, a view-dependent scheduler with a memory-pressure dispatch gate, bounded residency, and worker decoding, so a file far larger than memory renders without ever being read whole. Any other very large format still relies on the downsampling and stride-decode fallbacks above.

EPT behaviour in practice depends on the dataset. EPT support reads both the `binary` and `laszip` tile dataTypes; in real-world use, time-to-first-render and refinement smoothness depend on the dataset's hierarchy organisation and tile density, the hosting configuration (CORS-enabled, range-capable, low-latency), the client's available browser memory, and network conditions. A well-built EPT served from a fast CDN streams comparably to COPC; a deeply unbalanced hierarchy, a slow host, or a tight-memory device can change that picture.

WebGPU feature support varies by browser. Where it is unavailable, the viewer uses its WebGL 2 fallback.

Eye Dome Lighting is a screen-space depth cue, not physically-based lighting — it shades depth discontinuities to make structure readable, and does not model real light, shadows, or materials. It runs as a post-processing pass and is off by default on the WebGL 2 fallback and on mobile, where it can still be enabled by hand.

OBJ and glTF meshes are shown as their vertices. Faces and materials are not rendered.

## Not in scope, for now

Full GIS layers and analysis, photogrammetry, survey-grade measurement, CRS reprojection, and editing of point data are deliberately left to dedicated tools.

## Reporting issues

If something does not work as described, please open an issue. See [CONTRIBUTING.md](../CONTRIBUTING.md). Do not attach sensitive scan data to public issues. See [SECURITY.md](../SECURITY.md).
