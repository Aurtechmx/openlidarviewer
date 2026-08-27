# Supported / Target Formats

Format support is still evolving. This page separates what works today from what is planned.

## Current import formats

| Format | Typical source | Notes |
|---|---|---|
| `LAS` | Drone / aerial LiDAR | Georeferenced; coordinate bridge applied |
| `LAZ` | Drone / aerial LiDAR | Compressed LAS, decoded in-browser (laz-perf WASM) |
| `E57` | Terrestrial laser scanners | ASTM E2807; coordinates, RGB, intensity, classification, normals; multi-scan files merged; acquisition grid preserved for structured scans |
| `PLY` | iPhone / mobile scans | Point clouds and meshes; RGB supported |
| `OBJ` | Mesh scans, 3D tools | Mesh vertices used as points |
| `GLB` / `GLTF` | AR tools, mobile scans | Mesh vertices used as points |
| `XYZ` | Survey / generic export | Whitespace-delimited text; optional RGB; chunked decoding over the in-memory file |
| `CSV` | Survey / generic export | Comma-delimited text; optional RGB; chunked decoding over the in-memory file |
| `PCD` | Point Cloud Library | ASCII, binary, and binary-compressed; position, RGB, intensity, normals, labels; acquisition grid preserved when the header declares one |
| `PTX` | Terrestrial laser scanners | Multi-scan text; per-scan pose applied; scanner origin recorded; acquisition grid preserved per block |
| `PTS` | Terrestrial laser scanners | Whitespace-delimited text; optional header count; 3/4/6/7-column layouts; chunked reading |
| `PNTS` | 3D Tiles point tile | A single tile; magic-byte detected; `RTC_CENTER` applied; Draco refused |
| `tileset.json` | 3D Tiles 1.0 / 1.1 | Opened by URL; streamed against the camera like COPC and EPT; PNTS content only; explicit hierarchy only; other `asset.version` values refused |
| `COPC` | Cloud-optimised LiDAR | `.copc.laz`; opened by progressive octree streaming — see [streaming.md](streaming.md) |
| `EPT` | Entwine Point Tile | `ept.json` manifest + hierarchy + tiles; binary and laszip tile decode; local and remote — see [streaming.md](streaming.md) |

## Current export targets

`PLY`, `OBJ`, `XYZ`, and `CSV`, re-exported in real-world (global) coordinates, plus `PNG` snapshots of the current view (orthographic RGB, height map, intensity, classification, depth, normal, contour with legend customisation). Multi-page **PDF technical reports** (cover page + dataset summary + embedded image exports + annotations + measurements + technical notes; two built-in templates) ship as of v0.3.3. Working state — camera, render settings, colour mode, annotations, measurements, scan metadata — round-trips through the `.olvsession` JSON package.

## iPhone and mobile scan exports

OpenLiDARViewer opens exports from iPhone LiDAR and mobile scanning apps when they are saved as a supported format. `PLY`, `OBJ`, `GLB` (and self-contained `.gltf` with embedded buffers), `XYZ`, and `CSV` all work today. A `.gltf` that references an external `buffer.bin` needs to be exported as GLB or an embedded glTF instead. `USDZ` exports need conversion to a supported format first. What works depends on the app's export format, the file structure, browser memory, and the current implementation.

## Terrestrial laser scanners (E57)

`E57` (ASTM E2807) is the standard exchange format for terrestrial laser scanners and is read directly in the browser by a from-scratch TypeScript parser — nothing is uploaded and no conversion step is needed.

The parser decodes Cartesian coordinates, RGB colour, intensity, classification, and per-point surface normals. It applies each scan's recorded pose (rotation and translation), drops points the file flags as invalid, and bridges global coordinates into the viewer's local space with the same coordinate bridge the LAS loader uses. Multi-scan E57 files are merged into a single cloud, and the file's generating software is read from the header and shown in the Scan Report.

E57 exports from Trimble survey scanners have been tested directly. Other standard E57 files — from Leica, FARO, Matterport, and similar systems — follow the same ASTM format and are expected to work; E57 files that use uncommon or non-standard schema features may not.

## Drone LiDAR and other professional point clouds

Georeferenced drone LiDAR surveys in `LAS` and `LAZ` work today, including large UTM-scale coordinates handled by the coordinate bridge.

`PCD` — the Point Cloud Library format — is read directly in the browser in its ASCII, binary, and binary-compressed variants, with position, RGB colour, intensity, surface normals, and labels decoded where the file carries them.

`PTX` and `PTS`, the terrestrial laser-scanner text formats, are also read in the browser. PTX multi-scan files apply each scan's recorded pose matrix, merge every scan into one cloud, and record the scanner origin (shown in the Scan Report). PTS files read the optional leading point-count line and the standard 3-, 4-, 6-, and 7-column layouts; like XYZ and CSV they are decoded in bounded chunks over the already-loaded file, which avoids a second whole-file copy as strings (the source file itself is read in once; COPC/EPT are the true streaming paths).

## Large-scale and web formats

`COPC` (Cloud Optimized Point Cloud) `.copc.laz` files stream today — opened progressively through their octree hierarchy with partial range reads, worker-based decoding, and bounded memory. Remote COPC over HTTP range requests ships in v0.3.1 with fail-fast URL validation and classified error messages.

`EPT` (Entwine Point Tile) joins COPC as a first-class streaming source in v0.3.3 — a `ept.json` URL opens an EPT dataset progressively. Both `binary` and `laszip` tile dataTypes are supported; the laz-perf WASM module is shared with the COPC path so a session that touches both formats pays the WASM cost only once. Remote EPT carries the same URL-validation + error-classification polish as remote COPC. See [streaming.md](streaming.md).

`3D Tiles` / `PNTS`: a single `.pnts` tile opens today. It is detected by its `pnts` magic bytes (so a tile saved under another name still opens, and a file that only borrows the extension is refused rather than read as a tile), decoded through the viewer's PNTS reader — uncompressed `POSITION` and `POSITION_QUANTIZED`, RGBA/RGB/RGB565/CONSTANT_RGBA colour — and placed by adding the feature table's `RTC_CENTER` back to every position. Draco-compressed tiles are refused.

A whole `tileset.json` opens by URL, and it is worth being exact about what that is and what it is not.

What opens: a streamed 3D Tiles 1.0 or 1.1 tileset whose content is PNTS. The entry document is fetched and walked into a flat store of tiles, and from there the scan behaves as a COPC or EPT stream does: the scheduler culls against the camera, selects what fits the point budget, and fetches and decodes tile bodies as they are needed. Each tile is placed by its own cumulative transform, after its `RTC_CENTER` and before the render origin, in float64. A document declaring any other `asset.version` is refused by name, because that value fixes the schema the rest of the document is written in.

A streamed tileset reports no source point total. A `tileset.json` never states one, and the per-tile figures the scheduler admits on are decode-admission estimates rather than counts, so a sum of them would read as a measurement it is not. The colour modes offered are the ones a point tile can fill: intensity, classification and returns are absent from the format and are not offered.

A tile that refines by REPLACE into tiles with their own content is refused. REPLACE means the parent's content is replaced by its children, and the streaming scheduler draws every resident node, which is right for ADD and would draw the coarse parent alongside the fine children for REPLACE. Refusing is preferred to a scene that is quietly doubled. A REPLACE tile that refines into nothing cannot duplicate anything and is served.

Implicit tiling opens. A tileset that describes its hierarchy with a subdivision scheme and subtree files rather than a written-out tree is expanded into the equivalent explicit document before it is parsed, so every refusal the explicit path makes applies to it unchanged. Quadtree and octree schemes are read, availability arrives as a constant or as a bitstream in an internal or external buffer, and subtree and buffer URLs pass the same origin and credential checks as tile content, including the directory-escape rule. The expansion is bounded: subtree levels, tiles per subtree, external buffers, available levels, subtree count, total expanded tiles and subtree bytes each have a ceiling that refuses by name rather than truncating. A sphere bounding volume on an implicit tile is refused, as is a tile declaring both `implicitTiling` and `children`. The older extension spellings are refused by name.

What does not open: the wider 3D Tiles ecosystem. B3DM, I3DM, CMPT and glTF content are refused by name, because mesh tiles need a renderer this viewer does not have. A selection cannot reach a nested external `tileset.json`. Draco-compressed tiles are refused rather than partially read.

Two further limits of the supported subset are known:

- Content is selected by the URI extension. 3D Tiles 1.1 does not require a content URI to have a file extension, and permits content to be identified by its magic header or to be JSON, so a tileset that names its tiles without an extension is not opened even when every tile in it is PNTS.
- A tile is read as carrying a single `content`. 3D Tiles 1.1 allows `contents[]`, several contents on one tile, and only the single-content form is read here.

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

Format support varies with browser memory, GPU capacity, dataset size, preprocessing, and implementation status. Very large files may need downsampling, tiling, or conversion before they load smoothly.
