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

### Clipping and measurement in the scene

- The clip box now changes what is drawn. The clip is a per-point keep test in the point shader path, so Inside, Outside, an Advanced bounds edit and Fit to scan take effect on the next frame, and streaming nodes carry it too. Picking, double-click focus and measurement vertices skip clipped-away points.
- A Box measurement can be used as the clipping region ("Use as clipping region", or "Isolate this box" on the result card). A box thinner than 5 % of the scan's vertical range takes the scan's full height, and the toast says so.
- The Clip page leads with Draw clipping box, Inside or Outside, Fit to scan and Clear, with the numeric extents under Advanced. A "Clipping on" chip shows while a clip is active.
- A compact result card for the latest measurement shows the Measurements list's value and the same scene caveats, with Copy result and Open details.
- Measurement snapping and the support grade work in the project frame across every visible, unlocked scan. The green grade reads "Supported — close to measured points"; the on-a-return tolerance is half the local point spacing, and the grade makes no accuracy claim.
- Measurement labels drawn in the scene use the scan's unit status: a scan with no CRS reads source units marked "(unit unverified)".

### Navigation and layout

- An interactive view cube, on by default except at phone width. Its click targets are at least 24 by 24 CSS px, and faces, edges and corners no longer overlap at any orientation. All 26 views can be reached from the keyboard at any orientation: Tab enters the cube, the arrow keys move between views and Enter turns the camera.
- Navigation modes are one segmented control, Orbit | Walk | Fly | Pan; the six axis views moved to a "More" menu. Focus mode gives the scan the whole window.
- Plan View turns off when the command palette, Frame all, the keys or a saved-view restore change the view or projection, and returns to the navigation mode used before it.
- Keyboard navigation keeps working after a streaming COPC or EPT file replaces a static scan.
- Floating hints, toasts, the result card, the clip chip, the active-tool pill and the recovery notice no longer overlap one another or the dock.
- While a file opens, the status keeps its name, format and loading scope on one line and reports bytes read against its size.
- When several files are dropped at once, the status reads "Opening 2 of 3" and offers "Cancel this file" and "Cancel remaining files".
- Interface themes are Blue, Field and an upgraded High contrast. The Light theme is retired, and a saved Light choice moves to Field.
- The View Inspector opens in Basic detail, with an Advanced switch for the full set of sections.

### Loading and files

- Whole-file loading is capped at 1 GiB. A larger LAS or LAZ opens out-of-core; any other format, full-resolution export, reload or batch conversion over the cap is refused before the file is read.
- A file that cannot be read as a point cloud names the formats that open and suggests opening an E57 or LAS version.
- Opening a streamed scan over an open one, and importing a session over existing work, asks Save session / Replace / Cancel. Replace keeps a recovery snapshot.
- Opening a large local LAS or LAZ over an open stream asks the same question before any work starts. Close and every scan replacement ask before discarding class edits on any open layer, naming the layers and pointing to the LAS export that keeps them.
- With only a streamed scan open, measurements left from a replaced scan are withheld from CSV and GeoJSON exports instead of being written under the stream's name and origin, and the signed integrity report refuses rather than leave records out.
- Layers keep their placement while other layers open or close, a lone remaining layer exports and saves through its placement, removing the active layer activates the next one, and each measurement reads out in its own scan's units.
- Binary PLY headers with CRLF or non-ASCII text read correctly; malformed PLY and glTF graphs are refused; KML descriptions are escaped as HTML.
- PDF volume rows state coverage and preview caveats, and Web Mercator or geocentric frames no longer report extents or density in ground metres.
- The "Two scans loaded" before/after prompt is offered only when both scans declare the same CRS and linear unit and neither is a truncated load.
- A local glTF or GLB that names an external buffer or image (a relative file or a web address) is refused before parsing, so opening a file never makes the browser request an address named inside it.

### E57

- The E57 reader refuses an XML section larger than 64 MB or nested deeper than 256 levels with a clear error.
- Colour and intensity that the file flags invalid are masked per point. The point keeps its position; the flagged value is drawn grey, left out of ranges, colour balance and voxel means, and exported as an empty field or `nan`. PLY, OBJ and LAS omit the attribute for the whole file when any exported point is flagged, and the file says so.
- Intensity with declared limits is normalised over the declared range, so a signed range keeps its negative values. Colour is normalised per channel by its declared limits, so 16-bit colour is no longer clipped to 255.
- A scan whose pose rotation is malformed or degenerate is skipped instead of placed with the identity rotation. Channels dropped because some merged scans lack them are named.

### Exports

- A measurement exports through the scan it was taken on, with that scan's CRS, units, up axis and source digest. Measurements on scans whose frames differ are refused together. A measurement whose scan cannot be resolved is withheld with a stated reason in the PDF, KML, findings and integrity report.
- The Site KML writes absolute altitude only for an EGM96 geoid height. NAVD88, EGM2008 and other sea-level heights are clamped to ground, with the source elevation, unit and datum kept in each description.
- Converted LAS and LAZ files keep scan angle, user data, scanner channel, scan direction and edge-of-flight-line.
- XYZ, CSV, ASC, PLY and OBJ exports are written in 4 MiB chunks, so a full-resolution export of tens of millions of points no longer fails with "Invalid string length". The bytes are unchanged.
- The "Analysed basis" line on the contour map, terrain report and DEM package says when the analysis used a subsample of the loaded display sample, and gives the loaded count.
- "Avg grade" on a profile is now "Endpoint gradient", and says how many stations between the ends are missing. The formula is unchanged.

## Scientific corrections

These change figures that earlier builds reported. Each one has a regression test built from the case that exposed it, and the volume changes also have a known-answer benchmark.

- **Volume is weighted by area, not by point.** Polygon, lasso and stockpile volume used to give every point an equal share of the footprint, so a densely sampled part of a surface counted for more than a sparse part of the same size. On a test footprint with a raised, densely sampled half and a flat, sparse half, the old figure was 90 m³ against a true 50 m³; it is now 56.3 m³, the remaining difference coming from the cells that straddle the step. Volume now integrates the clipped cell area times the median cell height over a horizontal grid.
- **Lasso volume uses the drawn lasso.** It used the convex hull of the selected points, so a concave lasso inflated both area and volume. An L-shaped 36 m² slab read 68 m² and 64.4 m³; it now reads 36 m² and 35.9 m³.
- **Gaps in a volume footprint are stated.** A cell with no points is interpolated from covered neighbours only inside the extent of covered cells, never extrapolated or set to zero. The interpolated share is shown with every volume; above 25 % the volume is marked low confidence and above 50 % it is withheld with the reason. The ± band divides by n − 1.
- **Units implied by an EPSG code are read, not assumed.** A projected CRS given only as a code, with no unit key, was treated as metres. A State Plane CRS in US survey feet therefore gave distances, areas and volumes about 3.28 times too large. The unit now comes from the CRS definition, and a code that is not known reads as unit unknown rather than metres. A vertical CRS code now sets the height unit when the file declares none, and a declared vertical unit is kept with the datum, so NAVD88 with a US survey foot unit key reads as NAVD88 height (ftUS).
- **On-screen measurements match the exports on mixed-unit scans.** With metre eastings over foot heights, the Measure panel computed angle, distance, area and profile length on unscaled coordinates while the exports converted them, so an angle could read 45° on screen and 16.95° in the CSV. Both now use the same conversion.
- **Change detection uses a propagated threshold.** The level of detection was a fixed 0.1 m. It is now 1.96 · √(σ²before + σ²after + σ²registration) from each epoch's hold-out RMSE and the alignment residual (Wheaton et al. 2010). When a term is unavailable or its unit is unknown, the threshold falls back to 0.1 m and says it is assumed, not measured. A vertical offset between epochs is still not estimated or removed, and the result says so.
- **The change raster keeps its precision.** The difference raster rounded every value to three decimals, so a geographic grid lost its cell size and a 0.4 mm change was written as 0. It now writes full precision, a `.prj` and a metadata file, and refuses the export when the CRS cannot be written correctly.
- **Measurement GeoJSON follows RFC 7946.** Coordinates were written in the scan's projected CRS with a `crs` member that most GIS tools ignore, so features could be placed in the wrong location. Positions are now WGS 84 longitude and latitude, with a height only when the vertical datum is proven, and the export is refused for local or unknown frames. Scripts that read projected coordinates from these files need updating; the measured values in the properties are unchanged.
- **A volume with no coverage is withheld.** A footprint with no measured points read as zero. It is now withheld with a "No usable coverage" reason, and volume confidence is capped by the observed share of the footprint (below 50 % low, below 80 % at most medium).
- **The support grade follows point spacing.** On a flat or linear scan the snap cell was sized by the largest span of the scan, so an endpoint far from any return could read as on a measured return. The cell now follows point spacing.
- **Missing level-of-detection terms no longer lower the threshold.** With some terms missing, the threshold is the larger of the known terms' figure and 0.1 m, labelled as an incomplete lower bound. The alignment residual is reported at the pose actually applied and is not used as the registration term, so σreg is unavailable until an independent assessment exists.
- **Depth and non-projected frames are refused.** Elevation workflows refuse a depth-positive-down vertical reference. A geocentric CRS is no longer read as projected, and Web Mercator no longer receives a metric verdict; both withhold horizontal distances, areas and volumes.
- **Ground density reads the covered area.** The Analyse ground density averaged over occupied cells only and read high, more so the more the load was thinned. It is now the scaled ground-return count over the covered area of the ground surface.
- **Flow Pulse no longer counts a level plateau as a depression,** and Terrain Access takes a move's grade from both end cells and the edge itself, so a move and its reverse get the same figures.
- **Report wording.** A terrain report no longer prints the extent of a geographic grid as 0 × 0 degrees, map sheet scale bars print quarter ticks exactly (0.25, not 0.3), and an internal hold-out RMSE is no longer written as a ± bound.

## Added in this release

- **Draw precision bound.** The scan report gives an upper bound on the eye-space position error of each point draw, from A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU", with the checker pinned by its SHA-256. It is reported for the static point-cloud path on WebGPU and WebGL 2, where the shader expression was verified, and as not tested elsewhere. It covers the position before projection and nothing about survey accuracy. Rendering is unchanged.

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

The register holds 38 claims, 17 of them at E4 and none at E5. No existing claim changed evidence level. Terrain Flow Pulse (TERRAIN-FLOW-PULSE, E3), its depression inventory (TERRAIN-FLOW-DEPRESSION-INVENTORY, E2), Terrain Access (TERRAIN-ACCESS, E3, internal oracle) and the VVA-style 95th percentile (VVA-P95, E3), split from NVA-VVA, are new claims. The dependency set moved: three.js and two loaders.gl loaders advanced, with `@loaders.gl/core` held at 4.4.x because every 4.5.1 loader declares a peer dependency on it. `VALIDATION_REPORT_v0.7.0.md` states what was and was not tested.

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
- An E57 is decoded whole in memory, so one of about 900 MB or more is refused before its points are read; convert larger E57 files to LAS, LAZ or COPC. A scan that stores only spherical coordinates is skipped with a warning.
