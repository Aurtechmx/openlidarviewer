# Release notes: OpenLiDARViewer v0.7.0

v0.7.0 continues from v0.6.9 (`c164e907f50ff49da7233385d92285c53dfb3b8d`). The published v0.6.9 documents and evidence are unchanged.

OpenLiDARViewer remains browser-native and local-first: local files stay on the user's device, and no account is required. The license is AGPL-3.0-only. Releases through v0.6.6 were published under MIT and stay available under those terms. The license of a bundled dependency or of any test or validation dataset is unaffected.

## What is new

### Classification and flags

ASPRS class semantics come from one module instead of a table in each of eight places. Names depend on the point data record format the file declares. Class 12 is Overlap Points under formats 0 to 5 and reserved from format 6, where overlap is carried by a flag. Codes 19 to 22 are named, 23 to 63 are reserved and only 64 and above are user definable.

Classification flags survive a load. Synthetic, Key-Point, Withheld and Overlap are read from both record layouts, carried on the point model and written back by both LAS writers. The LAS 1.2 write no longer erases the three legacy flags, and a clip carries the flags with the points it keeps. Terrain analysis, both volume tools, profiles, point density, epoch comparison and feature extraction leave Withheld points out and record how many they read, excluded and analysed.

A LAS export that would change a class number's meaning, drop the overlap flag, clip scan angles or drop the scanner channel is refused until the matching opt-in is ticked in Export or the batch converter. Every accepted loss is written to the file as a conversion event and listed in the export summary.

### Terrain Flow Pulse and Terrain Access

Terrain Flow Pulse routes flow over a terrain surface with single-direction routing and flow accumulation, and reports an inventory of depressions. When the terrain run behind it is blocked or a preview, a banner says to read the result as illustration only.

Terrain Access screens a terrain surface for traversability and finds a least-cost route in the Field Simulation Lab. It names the one or two cost terms that add most to the route and shows the p95 longitudinal grade, the total cost and the measured, interpolated and low-confidence share of route cells.

Both maps are drawn north-up, with colour ramps, hatching for blocked cells and markers for cells without enough evidence.

### Sampled layers

For a layer the loader reduced to a display sample, "Export all N points" opens Export with full-resolution conversion ticked, and "Reload at higher density" reopens the layer at the largest point count the device can hold, after a confirm dialog states it. Exports from a sample are named with a `-sample` suffix and say in their provenance that they hold part of the scan.

### Provenance and integrity

Converted XYZ, ASC and LAS files record the software and version, the source file and its SHA-256, the CRS and where it came from, the point basis and whether classes were edited. A measurement CSV downloads with a provenance sidecar. Integrity reports can be signed with an ECDSA P-256 key created in the browser and kept non-extractable. The report verifier shows which key it checked.

### Interface

- A reference plane in the View panel, off by default: a horizontal grid, a vertical grid or a plane through three picked points.
- Closing a scan that holds measurements, annotations, saved views, class edits or saved recovery work asks first and offers to save the session.
- The Data tab lists the classes of a classified scan with code, name, share and legend colour.
- On a phone, the Project card, legend, prompts and recovery notice take turns instead of covering the screen, and every control is at least a 44 px target. Tablets get 44 px targets outside the rails and dock.
- Plan view waits until the camera has landed top-down before it reports itself on, and says so if the move does not finish. The standard views fit the visible bounds at the current window shape.
- In the orthographic projection and Plan view, wheel and pinch zoom keep the point under the cursor or between the fingers fixed on screen.

## What changed for users

- A file declaring a vertical CRS such as EPSG:6360 now reads its vertical unit in the status strip, the Inspector and Measure from one table. A file with no declared vertical unit says so wherever a height is printed, instead of presenting metres.
- On a geographic CRS (degrees), lengths, areas, grades, angles and volumes are marked as not available in the PDF, CSV, GeoJSON, KML, findings, integrity report and snapshots, as Measure already did.
- Measurement chains, PDF profile grades and the stockpile caveat use the horizontal and vertical units separately, so a scan with metre eastings over foot heights no longer sums to the wrong total.
- An Area polygon that crosses itself, collapses or has a non-finite vertex is not committed, and a saved one reports no area.
- Epoch change and the volume tools leave ASPRS noise classes 7 and 18 out and count them. A volume on a cloud the loader reduced says whether noise and Withheld exclusion was available.
- glTF and GLB vertex colours are read as linear and encoded for display, so midtones look brighter than before. A GLB that failed to open with "Decoding failed" now opens. Normals a file declares are kept, and the Normal colour mode works for glTF, PLY and 3D Tiles point sets that carry them.
- The DTM and DSM GeoTIFFs declare GeoTIFF 1.1 when they carry a vertical CRS, and the vertical CRS code matches the unit of the heights. A DEM raster keeps its NoData value away from every height it holds. A package with no world origin states that its frame is local.
- LAS 1.2 and 1.4 export keeps the source file's scale and offset when the source is LAS or LAZ and its header is valid.
- Going offline after a scan was open no longer reloads the page into an error. A part of the app that fails to load says so and points to Make available offline.
- Save session says when class edits are not stored in the session file.
- Exports that write longitude and latitude refuse NAD27 and other datums that need a grid shift, and Reproject refuses a transformation into or out of NAD27.
- The map sheet and compass read grid north, and a bearing is labelled as grid, as local axes, or is not shown.
- The hold-out RMSE says when its confidence interval is unavailable and why, instead of showing an interval with equal ends.
- PNG exports are fully opaque in every browser engine. PDF reports continue long text on the next page, and report and Scan Report figures state UTC.
- Terrain Access converts US survey foot elevations to metres for slope, step height and cost, where it read them as metres before.

## Evidence

The register holds 37 claims, 17 of them at E4 and none at E5. No existing claim changed evidence level. Terrain Flow Pulse (TERRAIN-FLOW-PULSE, E3), its depression inventory (TERRAIN-FLOW-DEPRESSION-INVENTORY, E2) and Terrain Access (TERRAIN-ACCESS, E3, internal oracle) are new claims. The dependency set moved: three.js and two loaders.gl loaders advanced, with `@loaders.gl/core` held at 4.4.x because every 4.5.1 loader declares a peer dependency on it. `VALIDATION_REPORT_v0.7.0.md` states what was and was not tested.

## Scientific limits and caveats

These limits are stated in full in `KNOWN_LIMITATIONS_v0.7.0.md`. They apply to every number the application produces.

- Nothing here is a survey-grade or certified result. Held-out validation against independent reference data has not been done, so no product is at E5 and no figure should be quoted as an established field accuracy.
- Analyses run on a sample are previews. A cloud the loader reduced to a display sample, and a streamed source that is not fully resident, give figures that describe the points held, not the whole file. Each such figure states its basis, and a volume on a voxel-reduced cloud cannot exclude noise or Withheld points.
- Measurements on a geographic CRS (degrees) are refused rather than computed, because degrees are not distances.
- Datum handling is limited. There is no cross-CRS reprojection beyond the listed transforms, no datum shift is applied to longitude and latitude exports, and NAD27 is refused. Bearings are grid bearings, not true north. A vertical datum that is unknown stays unknown, and a file with no declared vertical unit is shown in source units.
- Terrain Access is a geometry screening and never a safety guarantee. Flow Pulse is topographic routing only, with no rainfall, runoff, infiltration or drainage structures.
- The ground filter loses ground on curved terrain, and the boundary share measures the survey edge of the cloud.
- The reference plane is a drawing, not a surface. Set from the scan minimum, it sits at the lowest point in the scan, which is not ground.
- Withheld points are excluded from scientific products but not from registration, classification or measurement.
- Class names are exact only when the point data record format is known, and class edits are not stored in a session file.
- Only one streamed source is open at a time.
- Registration is not exposed in the interface.
- Touch gestures run in CI as synthesized pointer events. Multi-touch on a real device is unverified.
