# OpenLiDARViewer: User Guide

Open any 3D scan (drone LiDAR, terrestrial laser scan, or phone scan) in a browser tab. Nothing to install, and nothing is uploaded: your files are read and rendered on your own machine, so there is no server to send them to.

This guide walks through opening a scan and finding your way around it. Then measuring, terrain analysis, comparing two scans, and sharing what you found. It assumes no GIS background.

---

## Open a scan

Drag a file onto the window, or press Open scan from device and pick one. LAS, LAZ, E57, PLY, GLB and `.pnts` are identified from their own contents, so one of those opens even under an odd name. The rest go by their extension, so keep it right on OBJ, GLTF, PTX, PTS and the plain-text formats.

You can open:

- Survey LiDAR: LAS and LAZ as local files, plus streaming COPC and EPT
- Terrestrial scans: E57, PTX, PTS, PCD
- Phone and mesh scans: PLY, OBJ, GLB, GLTF
- 3D Tiles: a single `.pnts` tile, or a whole tileset
- Plain points: XYZ, CSV, ASC, TXT

COPC, EPT and 3D Tiles tilesets usually live on a web server rather than on your disk. Paste the address into the URL field beside the open button and press Open.

An eligible local LAZ opens progressively: the viewer reads the header and the chunk table first, shows a bounded preview within moments, and fills in the full cloud behind it. Ordinary LAS and the static formats are read in one pass, and a source too heavy for memory is indexed and streamed from disk instead.

The moment a scan lands, you get a one-line summary and the most useful next step as one button: analyse the terrain, measure a volume, or compare two scans once a second one is open. Nothing runs until you ask, and nothing leaves your device.

A scan bigger than your device can draw is thinned for display. The viewer either keeps every Nth point or reduces the cloud to one point per small cube, and it says which, so the point count you see is a display sample rather than the file's own total. Measurements and analysis say the same thing wherever the distinction matters. A file beyond what the browser can hold at all is refused before it is read, with a message naming the reason.

---

## Find your way around

### The screen

The scan fills the window, with four places around it.

The left rail holds four tabs, one open at a time:

- Data: what the scan is: the layers you have open, how healthy each one is, and the classes it carries.
- Tools: what you do to it: Measure, Inspect point, Annotate and the Clip box, each listed with its key.
- Analyse: one row per analysis with its status (ready, review or blocked) and the reason, and a page for each task.
- Export: writing the scan, the images and the reports out.

The right rail is how the scan is drawn: Colour by, point size and rendering, with the scan's coordinate system, its scan report and your saved views below. Inspecting a point puts its readout on a card beside the point itself.

The bottom dock carries Frame, Snapshot, Measure, Inspect, Probe, Annotate, Analyse, Copy view link, Commands and Help. Above it sit the camera pads and the navigation legend.

Measure, Annotate and Analyse from the dock switch the left rail to the tab that holds them. The other tools leave it where it is. Each rail has a grabber on its inside edge that hides it and gives the space back to the scan. On a phone the panels move into a bottom sheet with View, Analyse and Layers tabs.

### Moving the camera

You start in Orbit, where dragging swings around the scan and scrolling zooms. Switch to Walk or Fly and the movement keys take over, and clicking the view hands the cursor to the camera until you press Esc.

| Key / input | Does |
|---|---|
| Drag | Orbit around the scan (Orbit mode) |
| Mouse | Look around (Walk and Fly, after clicking the view) |
| W A S D | Move through the scan (Walk and Fly) |
| Space / C | Move up / down (Walk and Fly) |
| Shift | Move faster |
| F | Focus on whatever is at the centre of the view |
| R | Re-frame the whole scan |
| Esc | Release the cursor |
| 1 / 2 / 3 / 4 | Orbit, Walk, Fly, Pan |
| G | Toggle Pan from any mode |
| Double-click | Focus on the point under the cursor, flying to it in Walk and Fly |

Four movement styles cover most jobs. Orbit circles a target and is best for inspecting an object from the outside. Walk keeps you upright and is good for moving across a site. Fly lets you move freely in any direction. Pan slides the view sideways without turning it, which is what you want when reading a face or a plan straight-on.

There are also six standard views (top, front, side, and so on) and a toggle between perspective and a flat orthographic view, which is the one for reading measurements off a face straight-on.

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

Point size, eye-dome lighting (which adds depth cues), and a few other rendering controls live in the right-hand rail.

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

---

## Analyse the terrain

Open the Analyse tab. Its home lists Terrain, Flow Pulse, Terrain Access, Observatory and Objects & Space, each with its status and a one-line reason. A blocked row names what would lift it: Flow Pulse and Terrain Access need a terrain run first, so their rows offer Prepare terrain, which opens the Terrain page. Before a run the Terrain row also offers Run terrain analysis, which opens Terrain and starts the run. Once a run has made contours, a Contours row sits under Terrain and opens them in one click. After a run the Terrain status is the stricter of Process Studio's readiness and the run's own verdict, so a run that says it is not usable never shows as Ready. Flow Pulse and Terrain Access read that surface, so they are never shown as better than Terrain: their reason starts with "Terrain run:" and their fix opens the Terrain page. Range frames shows Scanner grid present, since no readiness check applies to it.

Choose Terrain and run the analysis. After a run, Create contours opens the Contours page. The page leads with its status, then a Why? disclosure that holds the full Process Studio view: the processing stages, each product's verdict and the quality checks. Evidence holds the detailed figures and the surface models, and Method holds the scan-type override and the planned capabilities. The viewer classifies the ground, builds a bare-earth surface (a DTM), and grades how trustworthy that surface is across the site. You get:

- A terrain grade and a plain-language read on what the scan is and is not good for
- Contours, drawn into the scene as their own layer, at the interval the analysis judges this surface can support. Contours has its own page under Terrain, with Contour Studio and the layer controls; Back returns to Terrain, then to the Analyse home.
- The Coverage and Confidence colour modes, which grade the surface in three bands: measured, where a ground return landed in that cell; interpolated, where the height was filled in from nearby data; and extrapolated or gap, where it is a guess or there is no reliable surface at all. Coverage uses green, yellow and red. Confidence says the same thing on a colourblind-safe ramp.

The grade is honest about gaps. A scan that only measured part of the ground will say so rather than pretend the filled-in areas are survey-quality.

### What a run gives you to take away

- DEM (ZIP): the bare-earth surface, the top surface and the canopy-height model, as ASCII Grid and GeoTIFF with a README recording the settings that produced them
- Contour vectors: GeoJSON in the scan's own coordinates, GeoJSON in WGS 84, DXF, or SVG
- Export Contours: a printable map sheet, where you also pick the contour interval from the ones this surface supports
- Intelligence report (PDF): the assessment, coverage, accuracy figures and warnings in one sheet

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

Load two scans of the same place, a "before" and an "after", and a Compare elevation button appears in the Layers section of the Inspector. A one-click prompt also appears when the second scan lands. Both are there only while exactly two scans are loaded.

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

You can solo a single class, hide several, and switch to a colourblind-safe palette. Hiding is a display filter: a point-cloud export still writes every class, whatever is hidden on screen.

You can also correct classes by hand. Pick a target class in Edit classes, press Reclassify (lasso), and draw around the points to change. Undo and Redo take the change back, and your source file is never modified.

---

## Export

The Export tab has two lanes.

Point cloud. Re-save the points as LAS 1.4, LAS 1.2, XYZ or ASC. Either LAS can be gzipped to a smaller `.las.gz`. You choose whether to keep the scan's coordinate system, assign an EPSG code, or reproject, and whether to write the display sample or every point at full resolution. A live summary tells you the point count, the size and the coordinate system before you commit.

Products. The things you make *from* the scan: your measurements as GeoJSON or CSV, an integrity report that pairs them with a checksum, and a Site KML and scan-area polygon for Google Earth. Image exports sit here too: height, intensity, class and normal maps, and a view capture that comes out as a georeferenced top-down image when the scan is georeferenced. The terrain products are downloaded from Analyse, on the Contours page under Terrain, where the run that made them lives.

A product that cannot be made yet says why on hover rather than failing when you press it.

---

## Save and share

Your work saves to a single **`.olvsession`** file from the Measurements panel. It holds your measurements and annotations, your saved viewpoints and the camera, the render and colour settings, and the class filter. It is plain text you can read in any editor, and it never contains the scan itself, so it stays small and private.

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
- Classify says it will not run: the scan already carries classes from the surveyor, or it is streaming rather than fully loaded.
- A huge file is slow to appear: COPC and EPT scans stream in detail-first, so the view sharpens as you look around. A large local LAZ shows a preview first and fills in behind it.
