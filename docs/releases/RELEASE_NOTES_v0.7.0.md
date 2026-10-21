# OpenLiDARViewer v0.7.0

Two new terrain tools, measurements that state their basis, a clip box that works on WebGPU and streaming scans, and stricter file handling.

v0.7.0 continues from v0.6.9 (`c164e907f50ff49da7233385d92285c53dfb3b8d`). The v0.6.9 documents and evidence are unchanged. OpenLiDARViewer stays browser-native and local-first: files stay on your device and no account is needed. The license is AGPL-3.0-only; releases through v0.6.6 remain available under MIT.

## Highlights

- Terrain Flow Pulse routes flow over a surface and inventories its depressions.
- Terrain Access screens a surface for traversability and finds a least-cost route.
- Terrain analysis runs on streamed Web Mercator data such as USGS EPT.
- The clip box changes what is drawn, on WebGPU and on streaming scans.
- The view cube is on by default, and Focus mode, the Field theme and a reference plane are new.
- Sampled layers can be exported in full or reloaded at higher density.
- Volumes are weighted by area, and their gaps are stated.
- Stricter limits on files, sessions and embedding.

## Terrain

- Flow Pulse. Single-direction routing, flow accumulation and a depression inventory, on the raw or the conditioned surface, with traced paths and catchments and a ZIP export. A banner marks results from a blocked or preview terrain run as illustration only.
- Terrain Access. Slope, step, ruggedness and obstruction limits, editable profiles, a preview before the run, the cost terms that shape the route, the p95 grade and the measured, interpolated and low-confidence share of route cells. It is a screening, never a safety guarantee. ZIP export included.
- Web Mercator. Terrain analysis converts distances with the ground scale at the scan's latitude, states the scale and its largest error, and refuses a scan too large for one scale. Geographic scans beyond ±89° latitude are refused.
- Contours are anchored to world elevation. The DEM package adds per-cell evidence, sensitivity and attention rasters.
- Ground density reads the covered area, which removes a high bias on thinned loads.

## Classification

- One module supplies ASPRS class names for every format, by point data record format. Classes 19 to 22 are named and only 64 and above are user definable.
- Flags survive a load. Synthetic, Key-Point, Withheld and Overlap are read, carried and written by both LAS writers. Terrain, volumes, profiles, density, epoch comparison and feature extraction leave Withheld points out and report the count.
- A LAS export that would change a class meaning or drop a flag asks for an opt-in and records the loss in the file.
- The Data tab lists classes with code, name, share and colour. Auto-classify and Clear classifications are undoable, and the palette has stronger contrast, with Ground and Ignored Ground clearly apart.

## Measure, clip and inspect

- Clip box. Applied per point in the shader, so it works under WebGPU and on streaming nodes. Draw it, flip Inside or Outside, fit it to the scan (placed scans included), or turn a Box measurement into the clip region. Reversed or blank bounds are not applied and the panel says so. Quick exports honour it and add `-clip` to the name.
- Measurements snap and grade across every visible scan, read each scan's units, and mark unverified units on the label. A result card shows the latest figure with Copy and Details.
- An Area that crosses itself is refused. A profile's "Avg grade" is now "Endpoint gradient".
- Reference plane. Horizontal, vertical or through three picked points.
- Reports and findings. A profile sheet names its project and sample basis, long PDF text continues on the next page, and figures state UTC. Findings are kept per scan with Undo on Clear all.

## Navigation and interface

- View cube on by default except on phones, with all 26 views reachable by keyboard. Orbit | Walk | Fly | Pan is one control and the axis views sit under More.
- Focus mode gives the scan the whole window. Plan view waits for the camera and orthographic zoom stays under the cursor.
- Themes: Blue, Field and High contrast. The Light theme is retired and a saved choice moves to Field.
- View Inspector opens in Basic detail, with an Advanced switch.
- A location bar, Go-to entries in the palette, mode homes with Continue, and a pill that names the active tool.
- Phones and tablets: panels take turns, targets are at least 44 px, and hints, toasts and notices no longer overlap.
- Closing a scan with measurements, annotations, saved views, class edits or computed results asks first.

## Opening files

- Sampled layers. Export all N points, Reload at higher density, and a `-sample` suffix and provenance note on anything written from a sample.
- A file over 1 GiB in a format other than LAS or LAZ is refused before it is read, as are full-resolution exports, reloads and conversions over 1 GiB. A larger LAS or LAZ streams from disk.
- While a file opens the status shows its name, format, stage and bytes read. Several dropped files read "Opening 2 of 3" with Cancel and Cancel remaining files.
- A file that cannot be read names the formats that open and suggests an E57 or LAS version.
- E57. Colour and intensity flagged invalid are masked per point, intensity and colour are normalised by their declared limits, malformed poses are skipped and dropped channels are named. Limits on XML size, nesting and counts apply.
- Binary PLY headers with CRLF read correctly, malformed PLY and glTF are refused, and GLB colours, normals and "Decoding failed" files are fixed.
- Two scans offer a before/after comparison only when they can be compared in one frame.
- Unknown files are probed and described, and Copy diagnostics adds a browser capability report.
- After a crash the viewer offers to restore your work, which expires after seven days and can be cleared.
- Six curated public datasets, with a statement that sample data carries no warranty.

## Exports and georeferencing

- Each measurement exports through its own scan: CRS, units, up axis and source digest. Measurement GeoJSON follows RFC 7946 in WGS 84.
- LAS 1.4 carries the CRS as OGC WKT with its vertical datum and unit. A CRS the exporter cannot write is refused for 1.4 and offered as LAS 1.2. LAS exports keep the source scale and offset and round half away from zero.
- Converted LAS and LAZ keep scan angle, user data, scan direction and edge-of-flight-line. The scanner channel is kept in LAS 1.4 and reported as dropped in 1.2.
- DEM GeoTIFFs declare GeoTIFF 1.1 with a vertical CRS, keep NoData off real heights, and say when their frame is local.
- Longitude and latitude exports apply no datum shift and refuse NAD27. Maps and the compass read grid north.
- Site KML writes absolute altitude only for EGM96 heights. Text exports are written in chunks of about 4 million characters, so tens of millions of points export.
- The orthographic PNG is georeferenced with transparent no-data. The change raster keeps full precision, with a `.prj` and metadata.
- Converted files record software, version, source hash, CRS and point basis. A measurement CSV ships with a provenance sidecar, and integrity reports can be signed with a browser-held key.

## Corrected figures

These change numbers earlier builds reported. Each has a regression test, and the volume changes a known-answer benchmark.

| Area | Before | Now |
|---|---|---|
| Volume | Every point weighted equally | Weighted by area; gaps interpolated only inside the covered extent and shown with the figure |
| Lasso volume | Convex hull of the selected points | The drawn lasso (an L-shaped 36 m² slab read 68 m², now 36 m²) |
| Units from an EPSG code | Assumed metres | Read from the code (State Plane in US survey feet was about 3.28 times off) |
| Vertical units | Centimetre and millimetre names read as metres | Read by factor; an unreadable unit withholds heights |
| Mixed-unit scans | Panel and exports disagreed | Each axis uses its own unit everywhere |
| Change detection | Fixed 0.1 m threshold | Propagated from each epoch's error; measured cells only |
| Epochs in one CRS | Rigid fit hid horizontal shifts as change | Compared in supplied coordinates |
| Measurement GeoJSON | Projected coordinates with a legacy `crs` member | WGS 84 longitude and latitude, refused for local frames |
| Zero-coverage volume | Read as zero | Withheld, with confidence capped by the covered share |
| Georeferenced PLY and OBJ | Rotated or measured along Y | Read along Z under a CRS, one up axis per layer |
| Depth, geocentric and Web Mercator frames | Treated as metric | Refused or withheld |
| Hold-out RMSE | Printed as a ± bound | Stated as hold-out RMSE, with its interval when available |

## Security and untrusted input

- Embedding works for the same origin or for origins the deployer lists in `OLV_EMBED_ORIGINS` at build time. Other parents see a notice.
- Session files over 64 MiB, with more than 512 frame layers, or with more than 20,000 measurements are refused, not truncated. The size limit was 256 MiB and the layer limit 10,000.
- glTF. Draco-compressed files, files other than glTF 2.0, and files naming external buffers or images are refused. The parser reads only `data:` URIs held in the file, so opening a file never contacts another address.
- Remote URLs pointing at private networks are refused. E57, PCD, EPT, COPC and 3D Tiles have fixed input limits.
- The measurement overlay draws at most 400 labels. DXF comments stay on one line. The live build never includes the test hook, and the release workflow checks the shipped files.

## Also in this release

Observatory (a preview) with stations and a slice plane, a results shelf, a session log with Open in Profile Workbench, intensity ramps trimmed to the 2nd to 98th percentile, Make available offline, a storage-grid diagnostics library, a draw precision bound in the scan report, the Olv font and a new emblem, a privacy statement and full licence notices.

## Evidence and limits

The register holds 38 claims, 17 of them at E4 and none at E5. Flow Pulse (E3), its depression inventory (E2), Terrain Access (E3) and VVA-P95 (E3) are new, and no existing claim changed level. three.js advanced to 0.186.

Nothing here is a survey-grade result; held-out validation against independent reference data has not been done. Figures from a display sample describe the points held, not the whole file. Observatory is a preview that uses resident points and declared stations, Flow Pulse and Terrain Access run on the main thread, registration is not exposed beyond Compare elevation's planar fit, one streamed source is open at a time, and an E57 of about 900 MB or more is refused before its points are read.

Details: [CHANGELOG.md](../../CHANGELOG.md), [KNOWN_LIMITATIONS_v0.7.0.md](KNOWN_LIMITATIONS_v0.7.0.md) and [VALIDATION_REPORT_v0.7.0.md](VALIDATION_REPORT_v0.7.0.md).
