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

Terrain Access screens a terrain surface for traversability and finds a least-cost route in the Field Simulation Lab. It names the one or two cost terms that add most to the route and shows the p95 longitudinal grade, the total cost and the measured, interpolated and low-confidence share of route cells. The minimum terrain confidence blocks cells under the `block` unknown policy and is reported as evaluated; under `penalize` it is reported as disclosed, since it then only sets that low-confidence share. The above-ground obstruction limit is evaluated from the terrain run's own DSM, bound to that run's DTM, and a surface built with a different terrain is refused. An evidence-gap policy in the profile decides cells whose slope used a substituted neighbour at the grid edge or beside a void and, under the obstruction limit, cells with no above-ground return: exploratory, the default, allows them and reports their share of the route, and conservative blocks them. Under exploratory, a slope or ruggedness limit that used a substituted neighbour on the route is reported as estimated rather than evaluated. The obstruction surface leaves out noise returns (classes 7 and 18), and the obstruction limit is reported as estimated when that surface came from a sample of the scan or when route cells have no above-ground return.

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
- Opening a large local LAS or LAZ over an open stream asks the same question before any work starts. Close and every scan replacement ask before discarding class edits on any open layer, naming the layers and pointing to the LAS export at display resolution that keeps them.
- With only a streamed scan open, measurements left from a replaced scan are withheld from CSV and GeoJSON exports instead of being written under the stream's name and origin, and the signed integrity report refuses rather than leave records out.
- Layers keep their placement while other layers open or close, a lone remaining layer exports and saves through its placement, removing the active layer activates the next one, and each measurement reads out in its own scan's units.
- Binary PLY headers with CRLF or non-ASCII text read correctly; malformed PLY and glTF graphs are refused; KML descriptions are escaped as HTML.
- PDF volume rows state coverage and preview caveats, and Web Mercator or geocentric frames no longer report extents or density in ground metres.
- Close scan keeps recovery work saved for other files and the work a Replace kept, and new work on a file that has saved recovery work is journaled beside it.
- LAS and LAZ files whose header bounds do not enclose their points keep full coordinate precision. Reprojection to or from a geocentric CRS is refused.
- The "Two scans loaded" before/after prompt is offered only when both scans declare the same CRS and linear unit and neither is a truncated load.
- A local glTF or GLB that names an external buffer or image (a relative file or a web address) is refused before parsing, so opening a file never makes the browser request an address named inside it.
- Studio height, depth and contour cards report source heights. They had printed coordinates relative to the scan's internal origin, so a tile spanning -7.86 m to 39.72 m read 14.0 cm to 47.7 m.
- A Studio card drawn from a display sample says so and gives the loaded and declared point counts.
- The scan report's duplicate check reads "Not checked" on a voxel-reduced display sample instead of "None".

### E57

- The E57 reader refuses an XML section larger than 64 MiB, nested deeper than 256 levels, or holding more than 200,000 elements or 400,000 attributes, with a clear error that names the limit.
- Colour and intensity that the file flags invalid are masked per point. The point keeps its position; the flagged value is drawn grey, left out of ranges, colour balance and voxel means, and exported as an empty field or `nan`. PLY, OBJ and LAS omit the attribute for the whole file when any exported point is flagged, and the file says so.
- Intensity with declared limits is normalised over the declared range, so a signed range keeps its negative values. Colour is normalised per channel by its declared limits, so 16-bit colour is no longer clipped to 255.
- A scan whose pose rotation is malformed or degenerate is skipped instead of placed with the identity rotation. Channels dropped because some merged scans lack them are named.

### Exports

- A measurement exports through the scan it was taken on, with that scan's CRS, units, up axis and source digest. Measurements on scans whose frames differ are refused together. A measurement whose scan cannot be resolved is withheld with a stated reason in the PDF, KML, findings and integrity report.
- The Site KML writes absolute altitude only for an EGM96 geoid height. NAVD88, EGM2008 and other sea-level heights are clamped to ground, with the source elevation, unit and datum kept in each description.
- Converted LAS and LAZ files keep scan angle, user data, scanner channel, scan direction and edge-of-flight-line.
- The point-cloud converter writes the source coordinates in their stored axis order. A georeferenced PLY, such as a surveyed facade, keeps its eastings, northings and heights under Keep and Assign in XYZ, ASC, LAS 1.2 and LAS 1.4. A local Y-up model is rotated to Z-up only when "Rotate a local Y-up model to Z-up" is ticked, and the report and the file record the rotation.
- XYZ, CSV, ASC, PLY and OBJ exports are written in 4 MiB chunks, so a full-resolution export of tens of millions of points no longer fails with "Invalid string length". The bytes are unchanged.
- The "Analysed basis" line on the contour map, terrain report and DEM package says when the analysis used a subsample of the loaded display sample, and gives the loaded count.
- "Avg grade" on a profile is now "Endpoint gradient", and says how many stations between the ends are missing. The formula is unchanged.

## Scientific corrections

These change figures that earlier builds reported. Each one has a regression test built from the case that exposed it, and the volume changes also have a known-answer benchmark.

- **Volume is weighted by area, not by point.** Polygon, lasso and stockpile volume used to give every point an equal share of the footprint, so a densely sampled part of a surface counted for more than a sparse part of the same size. On a test footprint with a raised, densely sampled half and a flat, sparse half, the old figure was 90 m³ against a true 50 m³; it is now 56.3 m³, the remaining difference coming from the cells that straddle the step. Volume now integrates the clipped cell area times the median cell height over a horizontal grid.
- **Lasso volume uses the drawn lasso.** It used the convex hull of the selected points, so a concave lasso inflated both area and volume. An L-shaped 36 m² slab read 68 m² and 64.4 m³; it now reads 36 m² and 35.9 m³.
- **Gaps in a volume footprint are stated.** A cell with no points is interpolated from covered neighbours only inside the extent of covered cells, never extrapolated or set to zero. The interpolated share is shown with every volume; above 25 % the volume is marked low confidence and above 50 % it is withheld with the reason. The ± band divides by n − 1.
- **Units implied by an EPSG code are read, not assumed.** A projected CRS given only as a code, with no unit key, was treated as metres. A State Plane CRS in US survey feet therefore gave distances, areas and volumes about 3.28 times too large. The unit now comes from the CRS definition, and a code that is not known reads as unit unknown rather than metres. A vertical CRS code now sets the height unit when the file declares none, and a declared vertical unit is kept with the datum, so NAVD88 with a US survey foot unit key reads as NAVD88 height (ftUS).
- **Vertical units are read by their factor, and an unreadable one gives no height.** A WKT vertical unit of centimetres or millimetres matched the metre name and read as 1 m per unit, so a 100-unit rise read 100 m instead of 1 m or 0.1 m, and a yard or any other unit name resolved to unknown. The declared factor is now kept, and a 100-unit yard rise reads 91.44 m, as PDAL reads it. A vertical unit that is not a length, or whose factor is missing, zero, negative or not finite, read as 100 m through the horizontal unit; every height and every figure built on one is now withheld with "height unit could not be interpreted", and plan figures are kept.
- **On-screen measurements match the exports on mixed-unit scans.** With metre eastings over foot heights, the Measure panel computed angle, distance, area and profile length on unscaled coordinates while the exports converted them, so an angle could read 45° on screen and 16.95° in the CSV. Both now use the same conversion.
- **Change detection uses a propagated threshold.** The level of detection was a fixed 0.1 m. It is now 1.96 · √(σ²before + σ²after + σ²registration) from each epoch's hold-out RMSE (Wheaton et al. 2010). The registration term is accepted only from an independent assessment on stable reference areas, which the app does not have yet, so it is unavailable; the alignment residual is reported at the pose actually applied and is not used as the registration term. With some terms missing, the threshold is the larger of the known terms' figure and 0.1 m, labelled as an incomplete lower bound. Only when no term is known does it fall back to 0.1 m, labelled assumed, not measured. A vertical offset between epochs is still not estimated or removed, and the result says so.
- **Change detection compares measured cells only.** A cell was compared wherever both DTMs carried a height, and the DTM build fills cells up to about 22 cells past an epoch's footprint from the nearest measured cell. Those fills were differenced against measured cells of the other epoch. Two identical surfaces whose footprints differed by 30 % compared 4,334 such cells and read 1,462 m³ of net change. A cell is now compared only where both epochs hold ground returns, on a shared grid whose cell is at least twice the sparser epoch's mean point spacing, and the result states how many cells were left out because either surface is interpolated there. In the same case every cell of the shared footprint is compared and the net change is 0.
- **Epochs in one CRS are compared in their supplied coordinates.** Compare elevation registered every pair before differencing, and a rigid fit cannot separate a horizontal shift along a slope from a real height change: on two identical lattices on a 0.5 slope, a +1 m uplift applied a 0.40 m x shift and read a mean change of 0.800 m. Two epochs that declare the same horizontal CRS are no longer registered. The panel and the registration record state that no registration was estimated and that registration uncertainty is not quantified, so the level of detection is an incomplete lower bound. The same case now reads 1.000 m. A real horizontal misregistration between such epochs is not corrected and appears as change.
- **Local-frame alignment is refused when the surface does not determine it.** Epochs without a common declared CRS are aligned only when, before any damping, the point-to-plane information matrix of yaw, x, y and z has an eigenvalue ratio and a conditional horizontal information of at least 0.01. A plane or a single slope is refused as unobservable and compared as supplied. An accepted fit pairs points only within three mean point spacings, measures the overlap at that distance, is withheld with low overlap or a residual over 0.75 spacings, and applies yaw and x/y, not the fitted Z. The fitting residual, the residual at the applied pose and the registration uncertainty are separate fields of the record.
- **The change raster keeps its precision.** The difference raster rounded every value to three decimals, so a geographic grid lost its cell size and a 0.4 mm change was written as 0. It now writes full precision, a `.prj` and a metadata file, and refuses the export when the CRS cannot be written correctly.
- **Measurement GeoJSON follows RFC 7946.** Coordinates were written in the scan's projected CRS with a `crs` member that most GIS tools ignore, so features could be placed in the wrong location. Positions are now WGS 84 longitude and latitude, with a height only when the vertical datum is proven, and the export is refused for local or unknown frames. Scripts that read projected coordinates from these files need updating; the measured values in the properties are unchanged.
- **A volume with no coverage is withheld.** A footprint with no measured points read as zero. It is now withheld with a "No usable coverage" reason, and volume confidence is capped by the observed share of the footprint (below 50 % low, below 80 % at most medium).
- **The support grade follows point spacing.** On a flat or linear scan the snap cell was sized by the largest span of the scan, so an endpoint far from any return could read as on a measured return. The cell now follows point spacing.
- **Depth and non-projected frames are refused.** Elevation workflows refuse a depth-positive-down vertical reference. A geocentric CRS is no longer read as projected, and Web Mercator no longer receives a metric verdict; both withhold horizontal distances, areas and volumes.
- **Ground density reads the covered area.** The Analyse ground density averaged over occupied cells only and read high, more so the more the load was thinned. It is now the scaled ground-return count over the covered area of the ground surface.
- **Flow Pulse no longer counts a level plateau as a depression,** and Terrain Access takes a move's grade from both end cells and the edge itself, so a move and its reverse get the same figures.
- **Terrain analysis no longer rotates a georeferenced PLY or OBJ by its shape.** The terrain gather detected a Y-up axis from the point layout and rotated a mesh-format scan to Z-up even under a CRS, so a surveyed facade PLY under EPSG:32613 was analysed with the wall as the ground, and the DTM, contours, map sheet and terrain exports were built in that frame. A PLY or OBJ under a CRS is now analysed as stored, with easting, northing and height in X, Y and Z. A glTF or GLB under a CRS is declined with the reason. Detection is used only for a model with no CRS, and the Analyse panel states the detected axis.
- **A georeferenced PLY or OBJ is measured along Z.** Measurements read a PLY's height along Y even under a projected CRS, so on a PLY under EPSG:32613 a 100 m rise read 0.0 cm and a 100 m step north read 100.00 m, in the panel and the CSV, while terrain analysis of the same layer used Z. Measurement, navigation, the Layer Health card and the CSV, GeoJSON, KML, integrity report and PDF now read each layer's up axis by the rule terrain and conversion use: survey formats are Z-up, a PLY or OBJ under a CRS is Z-up, a PLY or OBJ with no CRS is read Y-up, and a glTF or GLB under a CRS has no up axis, so its heights, grades, profiles, boxes and volumes are withheld with the reason. Height colouring and the elevation legend follow the same axis. Assigning, replacing or clearing a CRS re-reads measurements already taken, and a reopened session re-cuts a profile or volume that was cut along another axis; stored coordinates do not move.
- **Report wording.** A terrain report no longer prints the extent of a geographic grid as 0 × 0 degrees, map sheet scale bars print quarter ticks exactly (0.25, not 0.3), and an internal hold-out RMSE is no longer written as a ± bound.

## Added in this release

- **Draw precision bound.** The scan report gives an upper bound on the eye-space position error of each point draw, from A. Urias, "Per-Draw Precision Bounds for Large-Coordinate Rendering in WebGL2 and WebGPU", with the checker pinned by its SHA-256. It is reported for the static point-cloud path on WebGPU and WebGL 2, where the shader expression was verified, and as not tested elsewhere. It covers the position before projection and nothing about survey accuracy. Rendering is unchanged.

## What changed for users

- A file declaring a vertical CRS such as EPSG:6360 now reads its vertical unit in the status strip, the Inspector and Measure from one table. A file with no declared vertical unit says so wherever a height is printed, instead of presenting metres.
- On a geographic CRS (degrees), lengths, areas, grades, angles and volumes are marked as not available in the PDF, CSV, GeoJSON, KML, findings, integrity report and snapshots, as Measure already did.
- A vertical unit that cannot be read withholds heights, 3D lengths, tilted areas, angles, grades, profiles, boxes and volumes in Measure, the trust grade, chains, the lasso volume, CSV, GeoJSON, KML, PDF, findings and the integrity report, on the active layer and on every other open layer. LAS conversion of such a source, or of one whose vertical unit is not metre, foot or US survey foot, is refused with the reason.
- Measurement chains, PDF profile grades and the stockpile caveat use the horizontal and vertical units separately, so a scan with metre eastings over foot heights no longer sums to the wrong total.
- An Area polygon that crosses itself, collapses or has a non-finite vertex is not committed, and a saved one reports no area.
- Epoch change and the volume tools leave ASPRS noise classes 7 and 18 out and count them. A volume on a cloud the loader reduced says whether noise and Withheld exclusion was available.
- glTF and GLB vertex colours are read as linear and encoded for display, so midtones look brighter than before. A GLB that failed to open with "Decoding failed" now opens. Normals a file declares are kept, and the Normal colour mode works for glTF, PLY and 3D Tiles point sets that carry them.
- The DTM and DSM GeoTIFFs declare GeoTIFF 1.1 when they carry a vertical CRS, and the vertical CRS code matches the unit of the heights. A DEM raster keeps its NoData value away from every height it holds. A package with no world origin states that its frame is local.
- LAS 1.2 and 1.4 export keeps the source file's scale and offset when the source is LAS or LAZ and its header is valid.
- A georeferenced LAS 1.4 export always carries the coordinate system as OGC WKT with global encoding bit 4 set, as LAS 1.4 R15 requires for point formats 6 to 10. A scan georeferenced by GeoTIFF keys alone gets a WKT built from EPSG definitions checked against PROJ, with its vertical CRS as a compound when the vertical code is one OLV stores. A CRS with no stored definition is refused for LAS 1.4, and the message names the code and offers LAS 1.2, which records the code as GeoTIFF keys.
- The vertical CRS of a LAS 1.4 export is in its WKT, so PDAL and GDAL read the height datum and unit: NAVD88 heights in US survey feet are no longer read as metres by tools that take the CRS from the WKT. A vertical code OLV cannot write into the WKT, or a height unit without a vertical datum that differs from the horizontal unit, is refused for LAS 1.4 and can be written as LAS 1.2.
- Assign EPSG looks up whether the code is geographic or projected, and its unit, in the EPSG v12.029 tables. A geographic code is written with geographic GeoKeys at 1e-7 degree steps; a code of unknown kind, or a compound, geocentric or vertical code, is refused and named instead of being written as projected.
- Going offline after a scan was open no longer reloads the page into an error. A part of the app that fails to load says so and points to Make available offline.
- Save session says when class edits are not stored in the session file.
- Exports that write longitude and latitude refuse NAD27 and other datums that need a grid shift, and Reproject refuses a transformation into or out of NAD27.
- The map sheet and compass read grid north, and a bearing is labelled as grid, as local axes, or is not shown.
- The hold-out RMSE says when its confidence interval is unavailable and why, instead of showing an interval with equal ends.
- PNG exports are fully opaque in every browser engine, except the georeferenced orthographic PNG (PNG + .pgw + .prj), whose no-data pixels are transparent and which carries an `olv:nodata` text chunk saying so. PDF reports continue long text on the next page, and report and Scan Report figures state UTC.
- Terrain Access converts US survey foot elevations to metres for slope, step height and cost, where it read them as metres before.
- The class palette has higher contrast against the dark canvas and wider separation between classes. Ground and Ignored Ground, which were nearly the same colour, are now clearly different. The colourblind palette is updated to match.
- The intensity colour ramp defaults to the 2nd to 98th percentile of the loaded sample, so a few saturated returns no longer wash it out. The colorbar says which window and sample it uses.
- The georeferenced orthographic PNG has transparent no-data, so it overlays other layers in a GIS. Pixels with no drawn point have alpha 0 and every other pixel is opaque.
- The quick PLY, OBJ, XYZ and CSV export buttons honour an active clip box, keep the same points as Export, and add `-clip` to the file name.
- A remembered CRS override also records a content fingerprint of its source, so two files that agree on name, point count, extent and position but differ in the sampled bytes are not treated as the same source. The fingerprint hashes at most the first 64 KiB of each sampled part, so a difference further in is not detected.
- Session work kept because its scan was not open is restored when that scan is opened later in the same page.

## Evidence

The register holds 38 claims, 17 of them at E4 and none at E5. No existing claim changed evidence level. Terrain Flow Pulse (TERRAIN-FLOW-PULSE, E3), its depression inventory (TERRAIN-FLOW-DEPRESSION-INVENTORY, E2), Terrain Access (TERRAIN-ACCESS, E3, internal oracle) and the VVA-style 95th percentile (VVA-P95, E3), split from NVA-VVA, are new claims. The dependency set moved: three.js advanced to 0.186, and the loaders.gl packages `core`, `gltf`, `obj`, `ply` and `las` moved together to 4.5.2, because every 4.5.2 package requires `@loaders.gl/core` ~4.5.0. `VALIDATION_REPORT_v0.7.0.md` states what was and was not tested. The release workflow marks a release ready only when the CI workflow has passed at the tagged commit.

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
- A glTF or GLB that uses Draco mesh compression is refused: the decoder is not bundled and none is downloaded. EPT hierarchies are read up to 2,000,000 nodes, COPC data nodes above 128 MiB are dropped, and remote URLs naming a bare host name, a private-network suffix or a non-public IP literal are refused.
