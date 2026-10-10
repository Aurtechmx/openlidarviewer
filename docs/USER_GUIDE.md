# OpenLiDARViewer: User Guide

Open any 3D scan (drone LiDAR, terrestrial laser scan, or phone scan) in a browser tab. Nothing to install, and nothing is uploaded: your files are read and rendered on your own machine, so there is no server to send them to.

This guide walks through opening a scan and finding your way around it. Then measuring, terrain analysis, comparing two scans, and sharing what you found. It assumes no GIS background.

---

## Open a scan

Drag a file onto the window, or press Open scan and pick one. LAS, LAZ, E57, PLY, GLB and `.pnts` are identified from their own contents, so one of those opens even under an odd name. The rest go by their extension, so keep it right on OBJ, GLTF, PTX, PTS and the plain-text formats.

You can open:

- Survey LiDAR: LAS and LAZ as local files, plus streaming COPC and EPT
- Terrestrial scans: E57, PTX, PTS, PCD
- Phone and mesh scans: PLY, OBJ, GLB, GLTF
- 3D Tiles: a single `.pnts` tile, or a whole tileset
- Plain points: XYZ, CSV, ASC, TXT

COPC, EPT and 3D Tiles tilesets usually live on a web server rather than on your disk. Paste the address into the URL field beside the open button and press Open.

Static scans stack. Each file you open joins the scene as its own layer, and many can be open at once. A streamed COPC, EPT or 3D Tiles tileset source is open one at a time. Opening one closes the stream already open and every static layer, and opening a static file while a stream is open closes the stream. A local file too heavy for memory streams from disk: it replaces an open stream and keeps the static layers.

An eligible local LAZ opens progressively: the viewer reads the header and the chunk table first, shows a bounded preview within moments, and fills in the full cloud behind it. Ordinary LAS and the static formats are read in one pass, and a source too heavy for memory is indexed and streamed from disk instead.

The moment a scan lands, you get a one-line summary and the most useful next step as one button: analyse the terrain, measure a volume, or compare two scans once a second one is open. Nothing runs until you ask, and nothing leaves your device.

A scan bigger than your device can draw is thinned for display. The viewer either keeps every Nth point or reduces the cloud to one point per small cube, and it says which, so the point count you see is a display sample rather than the file's own total. Measurements and analysis say the same thing wherever the distinction matters. A file beyond what the browser can hold at all is refused before it is read, with a message naming the reason.

---

## Find your way around

### The screen

The scan fills the window, with four places around it.

The left rail holds four tabs, one open at a time:

- Data: what the scan is: the layers you have open, how healthy each one is, and the classes it carries. For a classified scan the class list is open here, one row per class with its code, name, share of points and legend colour. A scan that was reduced to a display sample says "Shares of the loaded display sample." under the list. A collapse control hides the list and remembers your choice, and Open Classes goes to the full Classes page. The rows only display and never change a class. A scan with no classification shows a single Classes row reading "None detected".
- Tools: what you do to it: Measure, Inspect, Annotate and the Clip box, each listed with its key.
- Analyse: one row per analysis with its status (ready, review, blocked, or what the step needs) and the reason, and a page for each task.
- Export: writing the scan, the images and the reports out.

The right rail is how the scan is drawn: Colour by, point size and rendering, with the scan's coordinate system, its scan report and your saved views below. Inspecting a point puts its readout on a card beside the point itself.

The bottom dock carries Frame all, Save a snapshot, Measure, Inspect, Probe, Annotate, Analyse, Copy view link, Commands and Help, with Close scan at the far right. On narrower windows a ••• button folds some of them away: laptop widths fold Save a snapshot, Copy view link and Probe (and Commands between 768 and 830 px wide), and phones also fold Analyse, Help and Close scan. Close scan asks first when closing would lose measurements, annotations, saved views, class edits or results, and offers Save session first when the session would keep something. The session file does not keep class edits. Above the dock sit the camera pads and the navigation legend.

Measure, Annotate and Analyse from the dock switch the left rail to the tab that holds them. The other tools leave it where it is. Each rail has a grabber on its inside edge that hides it and gives the space back to the scan. On a phone the panels move into a bottom sheet with Data, Tools, Analyse, Export and View tabs.

### The state strip

Once a scan is open, a strip of short readouts shows its state. From left to right it shows the dataset name, the horizontal coordinate system, the vertical reference, the basis, the clip box when one is on, what is processing, and how many items are waiting for review. Each item is a button that opens the place that explains it, such as Data, the coordinate system section, the Clip box or Analyse.

The basis reads Full dataset, Currently loaded points, Sampled, or Partial for a truncated file. When a local file was reduced to a display sample, two links appear beside the basis. Export all N points opens the Export tab with full resolution ticked, so the file is written from the original rather than from the sample. Reload all N points opens the file again at a higher point count; when the device cannot hold every point the link reads Reload at N points, and the result is still a sample. A link that cannot run stays in place and says why when you press it. The reasons include a device that is too small, a phone or tablet, and class edits that a reload would discard. A reload clears the layer's saved findings and any compare result computed on it. Analyses keep reading the display sample either way.

### Moving the camera

You start in Orbit, where dragging swings around the scan and scrolling zooms. Switch to Walk or Fly and the movement keys take over, and clicking the view hands the cursor to the camera until you press Esc.

| Key / input | Does |
|---|---|
| Drag | Orbit around the scan (Orbit mode) |
| Mouse | Look around (Walk and Fly, after clicking the view) |
| W A S D | Move through the scan (Walk and Fly) |
| Space / C | Move up / down (Walk and Fly) |
| Shift | Move faster |
| F | Focus on whatever is at the screen centre |
| R | Re-frame the whole scan |
| Esc | Release the cursor |
| 1 / 2 / 3 / 4 | Orbit, Walk, Fly, Pan |
| G | Toggle Pan from any mode |
| Double-click | Focus on the point under the cursor, flying to it in Walk and Fly |

Four movement styles cover most jobs. Orbit circles a target and is best for inspecting an object from the outside. Walk keeps you upright and is good for moving across a site. Fly lets you move freely in any direction. Pan slides the view sideways without turning it, which is what you want when reading a face or a plan straight-on.

The camera pads add four camera presets (Top, Iso, Oblique and Planar; the keys T, O and P select Top, Oblique and Planar), six axis-aligned standard views (Top, Bottom, Front, Back, Left and Right), an Ortho toggle for a flat orthographic view, and a Plan chip. Plan looks straight down in parallel projection with the hand tool on the drag, and turning it off puts back the view you had. It switches on once the camera has landed top-down. If the camera cannot get there, Plan turns off and says "Plan view did not finish. Try Plan again." Orthographic is the view for reading measurements off a face straight-on. Measurements use the 3D points either way. On a scan with a coordinate system the top face of the compass rose reads Grid N, the direction of the map's Y axis, which is not true north. A scan with no coordinate system labels the faces B, R, F and L instead.

Keyboard and mouse. Press `?` any time for the full shortcut sheet. The ones worth knowing up front: `Cmd-K` (or `Ctrl-K`) opens a command palette that searches every tool and action, `Ctrl/Cmd-Z` undoes your last edit, right-clicking the scan opens a quick menu (focus here, frame, standard views), and holding `Space` while a tool is active lets you move the camera without putting the tool down. The full list is in [docs/navigation.md](navigation.md).

To use the viewer with no connection, run Make available offline from the command palette or Help. It downloads the app files once (about 9 MB, the exact size is shown before it starts), and Remove offline copy deletes them.

---

## See the data

Use Colour by to change what the points represent:

- RGB: the scan's own colour, if it has any
- Height: low to high, the default for bare terrain
- Intensity: how strongly each point reflected the laser
- Class: ground, vegetation, building, and so on, by ASPRS code
- Density: bright where points are dense, dark where they are sparse
- Normal: the direction each small surface faces
- Return: first, intermediate or last return, which separates canopy from the ground beneath it
- GPS time: when each point was captured, which shows the flight or setup pattern
- Coverage and Confidence: how much to trust the ground surface (see *Analyse the terrain* below)

Point size, eye-dome lighting (which adds depth cues), and a few other rendering controls live in the right-hand rail. The same rail's Reference plane section (or the `B` key) draws a grid at an elevation you set, as a visual reference. It is not measured terrain; see [usage.md](usage.md#reference-plane).

---

## Measure

Open the Tools tab and start Measure, or press M. A toolbar appears over the view; pick a kind there and click points on the scan:

- Distance: straight line between a pair of points
- Polyline: total length of a multi-segment path
- Area: a polygon, reported both as true area and as flat map area
- Height: vertical difference between a pair of points
- Angle: the angle at a corner
- Slope: rise, run, angle, and grade percent
- Profile: a cross-section between a pair of points, with a height chart
- Box: two opposite corners, reported as width, depth, height and volume
- Volume: cut and fill against a base level, from a polygon or a lasso

Each measurement lands in the Measurements panel, which lists what you have placed and holds the session buttons.

Snapping is off until you turn it on. The snap button in the toolbar cycles three states: off, point (each click lands on the nearest real return near the cursor), and geometry (also lands on the corners and midpoints of measurements you have already placed). Snapping needs points in memory and a perspective view: it has nothing to work with on a streaming scan, and it stands down while the view is orthographic.

### The trust badge

A measurement on a fully loaded scan carries a small red / yellow / green dot next to its value. This is the part most viewers leave out: a number is only as good as the points under its ends, so each measurement is graded on whether its endpoints landed on real returns and how dense the surrounding data is. A streaming COPC or EPT scan holds no resident points to grade against, so measurements taken on one carry no dot.

- Green: well supported by measured points
- Yellow: loosely supported, or the scan has no coordinate system so the scale cannot be confirmed as metres
- Red: the number cannot be backed up. An endpoint sits in empty space, or the coordinate system makes the figure wrong rather than merely uncertain: degrees of latitude and longitude are not distances, and a system whose height unit differs from its horizontal unit cannot be fixed by scaling. The number is shown faded.

Hover the dot to see exactly why it earned its grade. The badge travels with the measurement when you share it (see *Save and share* below), so whoever opens your file sees the same verdict.

### When a measurement reports no number

- Area. A polygon that crosses itself, overlaps its own edges, collapses to a line or has a vertex that is not a finite number is not committed. The check runs in the polygon's own best-fit plane, so a vertical wall or a tilted plane is accepted. A ring whose vertices sit far from any single plane is refused too, because a plane area would not describe it. A saved or imported polygon like this reports no area. The Measurements panel, the totals and every export leave the area out and give the reason, instead of writing 0.
- Volume on a reduced cloud. Polygon and lasso volumes leave out noise classes 7 and 18 and Withheld points, and count them. A cloud the loader thinned by keeping every Nth point keeps the file's own records, so both exclusions work. A cloud reduced to one point per small cube holds centroids that carry the first member's class and no flags. A volume on it records that noise and Withheld exclusion was unavailable, together with the reduction mode and the resident and declared point counts. The Measurements panel, saved sessions, the measurement CSV, GeoJSON and KML, the integrity report and the PDF report all say so. Volumes on a whole cloud are unchanged.
- Geographic coordinate systems. When the scan is in degrees, every measurement except a height is marked as not a distance. The exports follow. The PDF report, the chain total and the labels drawn on snapshots print "not available: geographic CRS (degrees are not distances)". The profile sheet PDF is disabled. CSV cells are left empty, GeoJSON properties are null with a `not_available` property, and the findings and integrity reports record a null value with an empty unit and still verify. Heights, rises and box heights are still written.
- Unconfirmed scale. A length on a scan whose scale is not confirmed as metres is labelled in source units in the PDF and the findings report, never in metres.

A few more details on what a measurement says. A nonzero value smaller than 0.0005 keeps three significant digits in the CSV, GeoJSON, KML, integrity report and findings report, so a 0.0004 m segment reads 0.0004 and not 0. Exact zero stays 0. A bearing reads "042° grid" on a projected coordinate system with an EPSG code, and "042° (local axes)" when there is no coordinate system, a local engineering one, or a Y-up scan. No bearing is shown on a geographic one. Grid north is the direction of the map's Y axis, and it differs from true north by up to about 3 degrees inside a UTM zone. When a file declares no vertical unit, a rise, slant, grade, height or volume uses the horizontal unit, and the Measurements panel says "Heights are assumed to be in the horizontal unit (vertical unit not declared)". On a compound coordinate system the chain total, the PDF grades and the angles use the horizontal and the vertical unit separately.

---

## Analyse the terrain

Open the Analyse tab. Its home lists Terrain, Flow Pulse, Terrain Access, Observatory and Objects & Space, each with its status and a one-line reason. A row missing a routine prerequisite names it in place of a status, such as Needs a loaded scan or Needs terrain, and offers the fix: Flow Pulse and Terrain Access need a terrain run first, so their rows read Needs terrain and offer Prepare terrain, which opens the Terrain page. Blocked is kept for a run that is not usable or a check that fails. Before a run the Terrain row also offers Run terrain analysis, which opens Terrain and starts the run. Once a run has made contours, a Contours row sits under Terrain and opens them in one click. After a run the Terrain status is the stricter of Process Studio's readiness and the run's own verdict, so a run that says it is not usable never shows as Ready. Flow Pulse and Terrain Access read that surface, so they are never shown as better than Terrain: their reason starts with "Terrain run:" and their fix opens the Terrain page. Range frames shows Scanner grid present, since no readiness check applies to it.

Choose Terrain and run the analysis. After a run, Create contours opens the Contours page. The page leads with its status, then a Why? disclosure that holds the full Process Studio view: the processing stages, each product's verdict and the quality checks. Evidence holds the detailed figures and the surface models, and Method holds the scan-type override and the planned capabilities. The viewer classifies the ground, builds a bare-earth surface (a DTM), and grades how trustworthy that surface is across the site. You get:

- A terrain grade and a plain-language read on what the scan is and is not good for
- Contours, drawn into the scene as their own layer, at the interval the analysis judges this surface can support. Contours has its own page under Terrain, with Contour Studio and the layer controls; Back returns to Terrain, then to the Analyse home.
- The Coverage and Confidence colour modes, which grade the surface in three bands: measured, where a ground return landed in that cell; interpolated, where the height was filled in from nearby data; and extrapolated or gap, where it is a guess or there is no reliable surface at all. Coverage uses green, yellow and red. Confidence says the same thing on a colourblind-safe ramp.

The grade is honest about gaps. A scan that only measured part of the ground will say so rather than pretend the filled-in areas are survey-quality.

### What the analysis was built from

A terrain run reads the points the viewer holds. On a scan reduced to a display sample that is a sample, and on a streaming scan it is the resident set. The surface, the contours and every export say which. The map sheet prints an "Analysed basis" line such as "2,899,049 of 47,170,656 points (display sample); whole-dataset support not claimed". Points flagged Withheld are left out and counted, and they do not make a full read count as a sample. If Withheld points forced the surface to be rebuilt, the status says the source was read again at the point budget, taking every Nth point, so the surface is still a sample.

The USGS density reference is not printed on the map sheet, in the Analyse panel, in the terrain report or in an export's provenance when the coverage is not a full read, or when points are missing for a reason other than Withheld exclusion. The map sheet shows "not stated on a sample" in its place and titles the accuracy block "Hold-out accuracy (preview)" with a line saying the figures come from a sample of the points. The hold-out figures are internal checks on withheld ground returns, not a survey accuracy statement.

The blocked hold-out RMSE comes with a 95% confidence interval when two or more blocks were scored. When no interval could be computed, the Analyse panel and the report show "Confidence interval unavailable" with the reason (only one block was scored, the bootstrap was disabled, or no held-out points were scored) and keep the point RMSE.

### What a run gives you to take away

- DEM (ZIP): the bare-earth surface, the top surface and the canopy-height model, as ASCII Grid and GeoTIFF with a README recording the settings that produced them
- Contour vectors: GeoJSON in the scan's own coordinates, GeoJSON in WGS 84, DXF, or SVG
- Export Contours: a printable map sheet, where you also pick the contour interval from the ones this surface supports
- Intelligence report (PDF): the assessment, coverage, accuracy figures and warnings in one sheet

Once a run exists, the Export tab's Products list also offers DEM package (ZIP) and Contour map sheet (PDF). They run the same exports as the Analyse buttons. The map sheet button opens the map sheet dialog. If the sheet is refused, the dialog stays open and says why. A button that cannot run is disabled and shows the reason on hover, for example "No contours at this interval to export." or that the analysis belongs to a different scan.

The DTM and DSM GeoTIFFs carry a vertical coordinate system only when the height unit is known and EPSG has a code for that reference in that unit. NAVD88 heights in US survey feet are written as EPSG:6360, in international feet as EPSG:8228 and in metres as EPSG:5703. Otherwise the rasters carry no vertical coordinate system, keep the height unit as the band unit, and the README says why. A raster without a placed origin is written with no coordinate system at all, and the README says the frame is local. Every raster declares one NoData value, -9999 unless a written height equals it, in which case the package uses a value below every height and states it in the README. The LAS writer matches its vertical code to the unit of the Z values in the same way, and leaves the code off when the two contradict.

### When the scan is not ground

Terrain analysis is for ground scans. When a scan reads as an interior space or a compact object, the viewer shows a Space scan or Object scan panel instead, with the dimensions, planes and capture quality that suit it, and a report of its own.

If the detection is wrong, correct it. Treat scan as switches the route between Terrain, Object, Interior and Auto, and Run terrain contours anyway at the top of that panel sends the scan down the terrain path in one click.

---

## Inspect the scanner grid

A terrestrial scan does not arrive as a bare cloud. It arrives as a grid: for
each row and column the instrument fired along a direction and recorded a
return, or recorded that nothing came back. When a scan carries that grid,
Range frames appears on the Analyse home, and its page holds Open Range Frame Workbench.

The workbench shows one setup at a time, coloured by range or by validity, with
the counts beside it. Click a cell and the viewer highlights the point it
produced. Inspect a point and the workbench highlights the cell it came from.

A cell with no return is not a gap in the data. It means the scanner looked that
way and nothing came back, which is worth knowing when a surface has holes in
it. The viewer will not tell you why, because the file does not say: dark
asphalt, glass and open sky all look the same from here.

If the scan was reduced to fit in memory, the grid survives and the link to
individual points does not. The workbench says so rather than pointing at the
nearest point, and an export made from that scan records where the link was
lost.

---

## Compare two scans

Load two scans of the same place, a "before" and an "after", and a Compare elevation button appears in the Layers list on the Data tab. A one-click prompt also appears when the second scan lands. Both are there only while exactly two scans are loaded.

The comparison lines the two up horizontally, turning and shifting sideways but never vertically, so real settlement or fill is measured rather than absorbed into the fit. It builds both bare-earth surfaces on one shared grid and differences them. The panel reports what the alignment did, the net change, the gain and the loss separately, and how many grid cells were comparable. Cell by cell, a change below a small noise floor counts as unchanged, and the gain and loss figures cover only what clears it. You can export the difference grid for use elsewhere.

The comparison refuses rather than guessing. If the two scans are in provably different coordinate systems or vertical datums, if the horizontal unit is unknown, or if their footprints do not overlap, you get a line saying so and what to fix, with no volume attached.

---

## Clip and slice

The Clip box draws a box around part of the scan and hides everything outside it, or inside it for a cut-away. Type the six extents (minimum and maximum on X, Y and Z), or press Fit to scan to reset the box to the whole scan and work inwards. The panel counts how many points the box keeps.

The clip changes what you see, not what you have. A point-cloud export made with the converter's Export button carries the clipped points; the quick format buttons write the whole loaded cloud.

---

## Classify

If a scan carries no classification at all, Classify (derive) works out ground, vegetation and building classes and shows them in the Classes panel on the Data tab. If the scan already carries classes from the surveyor, Classify leaves them alone and says so. Use Fill unclassified points instead, which derives only the gaps and keeps every class the file shipped with.

Both actions need points in memory, so neither runs on a streaming scan.

A derived class is a heuristic guess rather than a survey product, and it is labelled that way wherever it appears, so it is never confused with the data the scanner shipped.

You can solo a single class, hide several, and switch to a colourblind-safe palette. On a scan reduced to a display sample, the counts, solo and hide act on the loaded sample rather than the full cloud, and the Classes page says so. Hiding is a display filter: a point-cloud export still writes every class, whatever is hidden on screen.

Two kinds of point are treated apart from the rest. A point carrying the LAS Withheld flag is shown on screen and written back to an export with its flag intact, but terrain analysis, profiles and the volume tools leave it out and say how many they left out. The Scan Report leaves Withheld points out of its extent, density and spacing. Points in the ASPRS noise classes 7 and 18 are left out of the volume tools and of the elevation comparison, each of which states how many. When noise points sit inside the extent, the Height in the Scan Report and the PDF report reads "(includes noise classes 7 and 18)". Overlap-flagged points are never left out.

You can also correct classes by hand. Pick a target class in Edit classes, press Reclassify (lasso), and draw around the points to change. Undo and Redo take the change back, and your source file is never modified.

To replace the surveyor's classes, press Clear classes in Edit classes. Every point becomes class 1 (Unclassified) for this session, and the file on disk keeps its classes. A note under the buttons offers Undo and Restore earlier classes. Auto-classify scan then runs on the cleared scan, and Undo steps back over it to the cleared classes.

Restore earlier classes puts back the classes the scan held before its first clear or auto-classify since you opened it. Hand edits you made before that point come back with them.

Auto-classify finds ground, vegetation and buildings. Buildings come from a height and roughness heuristic. It does not find wires, poles, water, bridges or noise.

Clearing leaves the classification flags alone, so a Withheld point stays Withheld. The Export panel warns before you write cleared or derived classes. Two outputs record the state inside the file: the header comment of the quick XYZ button and the PDF report. Both also name the classifier and its version beside derived classes. LAS, the converter's XYZ and ASC, CSV and PNG image exports carry no such note.

The first clear or auto-classify keeps a copy of the codes it replaced, one byte per point, until the scan closes. Each clear, auto-classify or restore stores its undo step at one byte per point, and a hand edit stores six bytes per changed point. On a 20 million point scan that is 20 MB for the copy and 20 MB for each clear. Undo keeps up to 50 steps and 128 MB per scan, and drops the oldest step first. Restore earlier classes reads the kept copy, so a dropped step does not affect it.

Clear and Auto-classify need a fully loaded scan, so Edit classes stays hidden on a streaming scan.

---

## Export

The Export tab has two lanes.

Point cloud. Re-save the points as LAS 1.4, LAS 1.2, XYZ or ASC. Either LAS can be gzipped to a smaller `.las.gz`. You choose whether to keep the scan's coordinate system, assign an EPSG code, or reproject, and whether to write the display sample or every point at full resolution. A live summary tells you the point count, the size and the coordinate system before you commit. LAS 1.2 holds less than LAS 1.4. When a LAS 1.2 write would lose information (a class above 31, a return above 7, a scan angle beyond 90 degrees, a scanner channel, a class number whose meaning differs, or the overlap flag), the export is refused and names the checkbox that allows each loss. The checkboxes read "Allow classes above 31 to wrap", "Allow returns above 7 to be clamped", "Allow scan angles to clip and scanner channels to be dropped", "Allow class numbers to change meaning" and "Allow the overlap flag to be dropped". A class number can change meaning because some codes differ between the two versions: class 10 (Rail) is read as reserved in LAS 1.2, and high noise (18) has no legacy class. LAS 1.4 keeps all of it.

Products. The things you make *from* the scan: your measurements as GeoJSON or CSV, an integrity report that pairs them with a checksum (and, if you turn on Sign this report, a signature from a key kept in this browser), and a Site KML and scan-area polygon for Google Earth. After a terrain run it also lists the DEM package (ZIP) and the Contour map sheet (PDF).

The Export tab also has quick buttons that write the loaded cloud as PLY, OBJ, XYZ or CSV, an Image export section, and a Report PDF section. The images are Height map, Intensity, Class map, Normal map and View capture. A view capture comes out as a georeferenced top-down image with world file and projection sidecars when the scan is georeferenced. The Report PDF section has a template list (Survey Summary, Technical Report and Scan QA) and a Report PDF button. Survey Summary is a compact handover, Technical Report adds the full provenance, annotations and visuals, and Scan QA is a data-quality summary. The report follows the Measurements panel's metric or imperial setting. In the dataset summary, Height follows the vertical unit: it reads in source units with "(vertical unit not declared)" when the file declares none, and "(declared vertical unit is invalid)" when the declared factor is zero, negative or not a number. Width and Depth follow the horizontal unit. The Exported stamp prints UTC with the zone named. The terrain products can also be downloaded from Analyse, on the Contours page under Terrain.

A product that cannot be made yet says why on hover rather than failing when you press it.

#### Longitude and latitude exports

The Site KML, the scan-area polygon, the WGS 84 contour GeoJSON and the accepted building-footprint GeoJSON write longitude and latitude. OLV applies no datum shift when it writes them, so each export checks the datum first.

- A scan on NAD27, a geographic scan on a datum the viewer does not list, a scan with no EPSG code, or a projected scan whose definition names no datum, unless its EPSG code is on WGS 84, is refused. The export button shows the reason, such as "This scan is on NAD27", and points to PROJ, GDAL or PDAL with the NADCON or NTv2 grids for the transformation.
- NAD83, ETRS89, RGF93, GDA94, GDA2020 and NZGD2000 scans export, geographic or projected. The KML description and the GeoJSON metadata name the datum and the size of the difference from WGS 84 (about 1 to 2 m for NAD83, about 1 m for ETRS89, RGF93 and NZGD2000, about 2 m for GDA94 and about 0.4 m for GDA2020) instead of calling the coordinates WGS 84.
- A point with latitude outside -90 to 90, longitude outside -180 to 180, or a value that is not finite is refused. Longitudes are not wrapped.
- Reproject in Export and the batch converter refuse a move into or out of NAD27, because OLV has no NAD27 shift. They transform X and Y and leave Z unchanged.

### How to reproduce a result

Every export that carries provenance records the fields below. To get the same numbers again, open the same input file in the same app version and repeat the run with the recorded settings.

- **App version and build.** `OLV version` in a package README, `version` and `commit` in the GeoJSON `provenance` member, the `olv:build` chunk of a PNG, or the `build` field of `processing-manifest.json`. A different commit, or `+dirty`, may give different numbers.
- **Input file.** `Source` or `source` names the file by its base name only. `Source SHA-256` (`sourceSha256` in JSON, `olv:source-sha256` in a PNG) is the SHA-256 of the original file bytes: check your copy with `shasum -a 256`. A streamed scan records `not available for streamed sources`, because only part of the file is ever read. A terrain analysis over several layers records no single digest and says how many sources it combined.
- **Analysis input.** `Input SHA-256` or `Analysis input SHA-256` (`analysisInputSha256`) is the SHA-256 of the sample the analysis read: up to 300,000 points taken at a stride, in the viewer's scene frame, after Withheld exclusion and clipping and before class exclusion, each coordinate a little-endian float32. Compare it between two runs of this app; it cannot be recomputed from the file alone.
- **Interpretation level.** How the file's bytes were read. `VERIFIED`, `COMPATIBLE` or `PROBABLE` come from the format probe; `not-probed` means the file opened on its signature; `not-recorded` means the producing path did not look. Open the file the same way before you compare.
- **Data basis.** `full` means every point was read; `sampled` means a display sample; `resident-only` means the streaming set in memory at the time. A result computed on a display sample or on a resident streaming set can move once more of the file is read, so load the file the same way, with the same point budget and the same streaming state, before you compare the two runs.
- **Coordinate system.** `Horizontal CRS`, `Vertical datum` or `crs`. Resolve to it first. Where it is recorded, `crsOrigin` or the `CRS source` line says where the CRS came from: `las-vlr` (a LAS header record), `las-evlr` (an extended record after the points), `user-override` (chosen in the app), or `unknown`. Open the file so the CRS resolves from the same place, or set the same override.
- **Methods and settings.** The ordered `ops` in `processing-manifest.json` name each method as `id@version` with its parameters. Flow Pulse and Terrain Access packages also ship `*.olv-field-sim.json`: re-running it on the same surface gives the same `fieldDigest`. For a terrain product, use the cell size and contour interval printed in the README.
- **Time.** `Generated` or `generatedAt` dates the export. It is not an input.

A point re-save (LAS, XYZ, ASC) carries the source digest and CRS origin only: LAS in its Text Area Description record, XYZ and ASC as `#` lines. A measurement CSV, a point CSV and a world file do not carry this record. Export the GeoJSON alongside a CSV when you need the record to travel with the numbers.

---

## Save and share

Your work saves to a single **`.olvsession`** file from the Measurements panel. It holds your measurements and annotations, your saved viewpoints and the camera, the render and colour settings, and the class filter. It does not store class edits: to keep a reclassification, export the scan as LAS at display resolution. It is plain text you can read in any editor, and it never contains the scan itself, so it stays small and private.

Use Export in that panel to write one and Open to read one back, or just drag the session onto the window. The viewer restores everything, including the trust grade on each measurement. Because the scan does not travel inside the session, open it alongside the same scan file; if the scan is not loaded, the viewer tells you which file to drop.

A session is a shareable record of what you measured and how much to trust it, your evidence, that a colleague can reopen offline with nothing uploaded by either of you.

---

## Privacy

Files are read and rendered in your browser, with no upload. There is no account, no server for your data, and no telemetry. Opening, analysing, measuring, comparing and exporting all happen on your machine.

The network is reached only when you ask for it. Opening a COPC, EPT or 3D Tiles address fetches from that server, and searching the public dataset catalogue by location asks Microsoft's Planetary Computer for matching datasets. Neither sends your scan or your measurements anywhere.

A scan too large to hold in memory is indexed into private browser storage on your own device so it can be streamed from disk. That store stays on the machine, is capped in size, and is cleared with your browser's site data.

---

## If something looks off

- A measurement reads as red or its number is faded: an endpoint is not on real data, or the coordinate system makes the figure unreliable. Hover the dot to see which, then move the endpoint or set the coordinate system.
- Lengths don't look like metres: the scan has no coordinate system, so the viewer cannot confirm the scale. Measurements still work, but they are flagged yellow.
- Coverage / Confidence colours are greyed out: run the terrain analysis first; those modes describe its result.
- A session opened but the scene is empty: open the matching scan file too. A session carries your measurements and views, not the points and not the terrain analysis, so re-run the analysis after the scan is back.
- Classify says it will not run: the scan already carries classes from the surveyor (press Clear classes first), or it is streaming rather than fully loaded.
- A huge file is slow to appear: COPC and EPT scans stream in detail-first, so the view sharpens as you look around. A large local LAZ shows a preview first and fills in behind it.
