# OpenLiDARViewer — User Guide

Open any 3D scan — drone LiDAR, terrestrial laser scan, or phone scan — in a browser tab. Nothing to install, and **nothing is uploaded**: your files are read and rendered on your own machine, so there is no server to send them to.

This guide walks through opening a scan, finding your way around, measuring, analysing terrain, comparing two scans, and sharing your work. It assumes no GIS background.

---

## Open a scan

Drag a file onto the window, or click **Open** and pick one. The format is detected for you.

You can open:

- **Survey LiDAR** — LAS, LAZ, and streaming COPC / EPT (these stream, so a billion-point cloud opens without loading the whole file)
- **Terrestrial scans** — E57, PTX, PTS, PCD
- **Phone and mesh scans** — PLY, OBJ, GLB, GLTF
- **Plain points** — XYZ, CSV

The moment a scan lands, you get a one-line summary and the most useful next step as one button: analyse the terrain, measure a volume, or compare two scans once a second one is open. Nothing runs until you ask, and nothing leaves your device.

---

## Find your way around

Click the view to take control of the camera, then:

| Key / input | Does |
|---|---|
| Mouse | Look around |
| **W A S D** | Move through the scan |
| **Space** / **C** | Move up / down |
| **Shift** | Move faster |
| **F** | Focus on the point under the cursor |
| **R** | Re-frame the whole scan |
| **Esc** | Release the cursor |
| **1 / 2 / 3** | Switch between Orbit, Walk, and Fly |
| Double-click | Fly to that point |

Three movement styles cover most jobs. **Orbit** circles a target and is best for inspecting an object from the outside. **Walk** keeps you upright and is good for moving across a site. **Fly** lets you move freely in any direction.

There are also six standard views (top, front, side, and so on) and a toggle between perspective and a flat orthographic view, which is the one you want for reading measurements off a face straight-on.

**Keyboard and mouse.** Press `?` any time for the full shortcut sheet. The ones worth knowing up front: `1` / `2` / `3` switch Orbit / Walk / Fly, `Cmd-K` (or `Ctrl-K`) opens a command palette that searches every tool and action, `Ctrl/Cmd-Z` undoes your last edit, right-clicking the scan opens a quick menu (focus here, frame, standard views), and holding `Space` while a tool is active lets you move the camera without putting the tool down. The full list is in [docs/navigation.md](navigation.md).

---

## See the data

Use **Colour by** to change what the points represent:

- **RGB** — the scan's own colour, if it has any
- **Height** — low to high, the default for bare terrain
- **Intensity** — how strongly each point reflected the laser
- **Class** — ground, vegetation, building, and so on, by ASPRS code
- **Density** — bright where points are dense, dark where they are sparse
- **Coverage** and **Confidence** — how much to trust the ground surface (see *Analyse the terrain* below)

Point size, eye-dome lighting (which adds depth cues), and a few other rendering controls live in the right-hand panel.

---

## Measure

Pick a tool from the **Measurements** panel and click points on the scan:

- **Distance** — straight line between two points
- **Polyline** — total length of a multi-segment path
- **Area** — a polygon, reported both as true area and as flat map area
- **Height** — vertical difference between two points
- **Angle** — the angle at a corner
- **Slope** — rise, run, angle, and grade percent
- **Profile** — a cross-section between two points, with a height chart
- **Volume** — cut and fill against a base level, from a polygon or a lasso

Snapping pulls each click onto the nearest real point, so you measure the scan rather than empty space.

### The trust badge

Every measurement carries a small **red / yellow / green dot** next to its value. This is the part most viewers leave out: a number is only as good as the points under its ends, so each measurement is graded on whether its endpoints landed on real returns and how dense the surrounding data is.

- **Green** — well supported by measured points
- **Yellow** — loosely supported, or the scan has no coordinate system so the scale can't be confirmed as metres
- **Red** — an endpoint sits in empty space; the number is shown faded because the data can't back it up

Hover the dot to see exactly why it earned its grade. The badge travels with the measurement when you share it (see *Save and share* below), so whoever opens your file sees the same honest verdict.

---

## Analyse the terrain

Open the **Analyse** panel and run the analysis. The viewer classifies the ground, builds a bare-earth surface (a DTM), and grades how trustworthy that surface is across the site. You get:

- A **terrain grade** and a plain-language read on what the scan is and is not good for
- **Contours** at a spacing you choose
- The **Coverage** and **Confidence** colour modes, which paint the cloud green where the ground is measured directly and red where it had to be filled in

The grade is honest about gaps. A scan that only measured part of the ground will say so rather than pretend the filled-in areas are survey-quality.

---

## Compare two scans

Open a second scan of the same place — a "before" and an "after" — and the viewer offers a comparison. It lines the two up, differences their surfaces, and reports the cut and fill volumes, with a noise floor so small changes below the survey's own precision aren't reported as real movement. You can export the difference grid for use elsewhere.

---

## Clip and slice

The **Clip box** draws a box around part of the scan and hides everything outside it (or inside it, for a cut-away). Drag the extents or fit the box to what's visible. Exports respect the clip, so you can crop a cloud down to just the area you care about.

---

## Classify

If a scan has no classification, or you want to fill the gaps, the **Classify** action derives ground, vegetation, and other classes and shows them in the **Class legend**. You can solo a single class, hide several, and switch to a colourblind-safe palette. Derived classes are labelled as derived, so they're never confused with the data the scanner shipped.

---

## Export

The **Export** panel has two lanes:

- **Cloud** — re-save the points as LAS, or compressed LAS.gz, respecting any clip
- **Products** — the things you make *from* the scan: a multi-page PDF report, contour and elevation map images, an orthographic top-down image, and your measurements as GeoJSON, CSV, or KML for Google Earth and QGIS

A live summary tells you what each export will contain before you commit.

---

## Save and share

Your work — measurements, annotations, saved viewpoints, the camera, render settings, and the class filter — saves to a single **`.olvsession`** file from the Measurements panel. It's plain text you can read in any editor, and it never contains the scan itself, so it stays small and private.

To open one, just **drag it onto the window**, use **Open**, or **Open session** in the Measurements panel — all three do the same thing. The viewer restores everything, including the trust grade on each measurement. Because the scan doesn't travel inside the session, open it alongside the same scan file; if the scan isn't loaded, the viewer tells you which file to drop.

This makes a session a shareable **record of what you measured and how much to trust it** — your evidence — that a colleague can reopen, fully offline, with nothing uploaded by either of you.

---

## Privacy

Files are read and rendered in your browser, with no upload. There is no account, no server, and no telemetry of your data. This holds for everything above — opening, analysing, measuring, comparing, and exporting all happen on your machine.

---

## If something looks off

- **A measurement reads as red or its number is faded** — an endpoint isn't on real data. Move it onto the scan, or turn on snapping.
- **Lengths don't look like metres** — the scan has no coordinate system, so the viewer can't confirm the scale. Measurements still work, but they're flagged yellow.
- **Coverage / Confidence colours are greyed out** — run the terrain analysis first; those modes describe its result.
- **A session opened but the scene is empty** — open the matching scan file too; the session carries the analysis, not the points.
- **A huge file is slow to appear** — COPC and EPT scans stream in detail-first, so the view sharpens as you look around.
