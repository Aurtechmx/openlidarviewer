# OpenLiDARViewer

![Status](https://img.shields.io/badge/status-R%26D%20Prototype-teal)
![Rendering](https://img.shields.io/badge/rendering-WebGL%20%2F%20WebGPU-blue)
![Privacy](https://img.shields.io/badge/privacy-local--first-green)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

![OpenLiDARViewer — point-cloud exploration without the desktop overhead](docs/screenshots/openlidarviewer-promo.jpg)

**A browser-based LiDAR and point-cloud viewer for fast local inspection, 3D navigation, measurement, volume and cross-section analysis, theming, and a command palette — built on a research-derived approach to scan quality, capture provenance, and honesty about uncertainty.**

Local-first. Cited. Honest about what it can't tell you.

**Live version: [https://lidar.aurtech.mx/](https://lidar.aurtech.mx/)**

---

## Overview

OpenLiDARViewer opens LiDAR and point-cloud datasets straight in the browser. You can inspect a scan, navigate it in 3D, switch how it is colored, measure distances, and export results, without setting up a desktop GIS workflow.

The idea is simple: opening a point cloud should feel about as easy as opening an image, but you still get the spatial depth, navigation, and inspection tools that real LiDAR work needs.

It is built as an R&D project for browser-native geospatial visualization and human-centered point-cloud interaction. It is not a GIS, photogrammetry, or survey-grade processing suite. It is a browser-native LiDAR inspection and terrain-analysis platform focused on transparency, validation, and local-first processing.

## Live Demo

A live version is available at **[https://lidar.aurtech.mx/](https://lidar.aurtech.mx/)**.

Performance there depends on your browser, GPU, memory, the dataset size, and the rendering detail you pick.

## Why OpenLiDARViewer?

Most LiDAR tools are powerful, but a lot of them are heavy, desktop-first, and GIS-shaped. That is a poor fit when you just need to open a scan, look at it, move around, measure something, and show it to someone.

OpenLiDARViewer takes a lighter path. It runs in the browser with nothing to install. Files are read and rendered locally, so there is no server to upload to. It keeps the interface small and the navigation game-like instead of GIS-like. And it is built to be a testbed for browser-native spatial computing rather than a full GIS replacement.

It opens georeferenced drone LiDAR surveys in LAS and LAZ, terrestrial laser-scanner data in E57, PTX, and PTS — including exports from Trimble and other survey scanners — compatible iPhone and mobile scan exports (PLY, OBJ, GLB/GLTF), and Point Cloud Library (PCD) files. Large `COPC` (Cloud Optimized Point Cloud) and `EPT` (Entwine Point Tile) datasets stream progressively, octree node by octree node, with bounded memory and no full-file load.

## Key Advantages

- Inspect point-cloud datasets directly in a modern web interface, with nothing to install.
- Local-first by design: files are read and rendered in your browser, with no upload, which suits sensitive survey data.
- Opens compatible iPhone and mobile scan exports when saved as PLY, OBJ, GLB/GLTF, XYZ, or CSV.
- Opens georeferenced drone LiDAR surveys in LAS and LAZ, and terrestrial laser-scanner data in E57, PTX, and PTS, with a coordinate bridge that keeps large survey coordinates precise.
- Reads Point Cloud Library (PCD) files — ASCII, binary, and binary-compressed.
- Streams large COPC, EPT, and 3D Tiles datasets progressively, with bounded memory and no full-file load.
- Game-like navigation: Orbit, Walk, and Fly modes with WASD and mouse-look, plus Top / Iso / Oblique / Planar smart camera presets.
- A measurement toolkit — distance, polyline, area, height, angle, slope, cross-section profile (with a resizable height-vs-distance chart), and volume cut/fill against a polygon or 3D lasso — with editable points, in-session persistence, and JSON export/import.
- Annotations: mark points of interest with categorised, titled notes, revisit them, and save the whole inspection to a file.
- Inspect any point: click it to read its exact coordinates (UTM + lat/lon when CRS is known), intensity, classification, GPS time, and colour, then copy them in one click.
- A Scan Intelligence panel that reports point count, dimensions, density, spacing, and detected attributes, plus a Dataset Intelligence card with honest `—` when no signal is available.
- Visuals Studio with three chip rails for colour mode, RGB preset, and sky/EDL, plus white-balance assist on streaming COPC.
- Theme system (Dark / Light / High-contrast), a command palette (`Cmd-K`), a workflow recorder (`.olvworkflow`), and a searchable shortcut sheet.
- Save camera viewpoints, export PNG snapshots, re-export the cloud (PLY/OBJ/XYZ/CSV), or compose multi-page PDF technical reports.
- A clean dark interface aimed at researchers, developers, and geospatial work.

OpenLiDARViewer does not claim survey-grade measurement or support for every LiDAR format. Capabilities are described honestly. See [Current Limitations](#current-limitations) and [What's in this release](#whats-in-this-release).

## Features

### Core viewer
- Browser-based point-cloud visualization, no install
- Local-first scan inspection — nothing is uploaded
- WebGPU rendering with an automatic, fully tested WebGL 2 fallback
- Import: LAS, LAZ, E57, PLY, OBJ, GLB, GLTF, XYZ, CSV, PCD, PTX, PTS
- Export: PLY, OBJ, XYZ, CSV, and PNG snapshots
- Budget-aware fast loading of large LAS/LAZ surveys — header preflight, stride decoding, a memory-safety guard, staged progress, and a load that can be cancelled mid-flight
- Chunked, bounded-memory reading of large text point clouds (XYZ, CSV, PTS); graceful degradation on weak devices so a large survey reduces in density instead of crashing
- A universal file-open summary and clear, categorised load-error messages

### Streaming
- COPC streaming — a `.copc.laz` file, on disk or hosted at a URL, opens through progressive, octree-based, view-dependent streaming with worker-based decoding and bounded memory; never a full-file load. A remote scan opens from the start screen's open-from-URL field or a shareable `?copc=<url>` deep link
- EPT (Entwine Point Tile) streaming — local and remote, `binary` and `laszip` tiles
- 3D Tiles / `.pnts` streaming — Cesium-style tilesets read directly from a `tileset.json`
- A verified public-LiDAR catalog of 18+ hand-vetted COPC / EPT URLs, every one probed at release time

### Navigation & camera
- Orbit, Walk, and Fly navigation with WASD movement and mouse-look
- Smart camera presets — Top, Iso, Oblique, Planar — one-click jumps that frame the cloud from a known angle
- A triangular nav widget that surfaces the current mode and a centre Reset
- Saved, renamable camera views for repeatable inspection
- Shareable view links — the **Copy view link** tool copies a link that reproduces the current view (camera, colour mode, point sizing); no scan data is shared, the recipient still needs the same file

### Rendering
- Eye Dome Lighting (EDL) depth shading that makes point-cloud structure far more readable, with strength, radius, and three named presets (Subtle / Balanced / Inspection)
- Optional SSAO ambient occlusion that combines with EDL for surface separation
- Hillshade overlay colour mode for terrain readability
- Soft splat rendering — Classic round points, Soft splats, or Inspection mode with density-aware radius
- Adaptive or fixed point sizing, round antialiased points, and a Detail control that shows an honest `shown / total` count
- Height, intensity, classification, RGB, and surface-normal colour modes, picked automatically per file
- Percentile-clipped height mode with a 5/95 default and a Turbo perceptual palette
- HDR sky presets — Studio Dark, Blueprint, Survey Light, Terrain, Black

### Visuals Studio
- A unified Inspector section with three chip rails — Colour Mode, RGB Preset, Sky / EDL — that re-style the scan without leaving the panel
- RGB appearance presets — Photoreal, Drone RGB, Mobile LiDAR, Infrastructure — each tuning gamma, contrast, saturation, and exposure
- White balance (temperature + tint) with an Auto-balance assist, gated to streaming COPC where it can sample residency
- Patch view at the inspector cursor — a KNN-based tangent-plane projection of the point's neighbourhood with a photometric witness panel

### Measurement & analysis
- A measurement toolkit with seven tools — distance, polyline, area, height, angle, slope, and **cross-section profile** — with draggable points, undo, rename, a units toggle, and JSON session export/import
- **Cross-section profile** renders a height-vs-distance chart strip directly under the row, resizable from a default 140 px out to 360 px so the curve reads at deliverable size
- **Volume (cut / fill)** measurement against a polygon or a 3D lasso selection, with NaN / degenerate / self-intersection guards and a streaming-resident caveat when nodes are still loading
- **Classification editor** — paint a class id over a lassoed selection and write the result back to LAS
- **Density heatmap** overlay for coverage QA
- **Box clipping / slicing** for interactive cross-cuts
- **Measurement chains** — combine placed measurements as sum / difference / ratio
- A Scan Intelligence panel with point count, dimensions, density, spacing, attributes, and an Advanced report of integrity diagnostics
- A Dataset Intelligence card backed by the terrain foundation — Point Density, Terrain Complexity, Ground Visibility, Streaming Coverage, Terrain Confidence; renders `—` rather than fabricating a bucket when no signal is available
- A coordinate bridge that keeps large georeferenced (UTM-scale) coordinates precise
- Point inspection — click a point to read its coordinates and attributes (including LAS return number, point source ID, GPS time, and UTM + lat/lon when a CRS is known), with one-click copy; or hover with the live probe for a click-free readout
- Capture provenance from LAS/LAZ and E57 headers — sensor, source software, and date — shown in the Scan Report when the file carries them
- A "Project ready" summary card on load, with a suggested navigation mode

### Annotation, sessions & reporting
- Annotations — drop categorised, titled markers with notes, browse and search them in a panel, capture the camera viewpoint with each, and undo/redo changes
- Inspection sessions — export measurements, annotations, and named views to one JSON file and reload them later
- Workflow recorder — save and replay a `.olvworkflow` of camera moves, mode switches, and tool actions for repeatable demos and inspections
- Multi-page PDF technical reports — six built-in templates with branding and unit-system awareness
- Visual Export Studio — orthographic RGB, height map, intensity, classification, depth, normal, and contour map exports
- Screenshot export that burns in placed measurements and annotations as inspection evidence

### Interface & accessibility
- Theme system — Dark, Light, High-contrast — with a persisted preference
- Command palette (`Cmd-K` / `Ctrl-K`) for keyboard-first access to every tool, mode, theme, and export
- Searchable shortcut sheet (`?`) listing every keybinding
- An onboarding tour that walks new users through the empty state, tool dock, and Inspector
- Keyboard shortcuts for the tools plus a built-in help overlay
- A mobile touch model with twist + pinch + pan decomposition, sub-threshold dead zones to keep accidental wobble from moving the camera, and an opt-in 3-finger zoom for advanced users
- A mobile Scan Intelligence bottom-sheet with peek + tap-to-toggle, and an overflow "More" disclosure on the tool dock so the primary row stays one-handed

### Multi-scan & embed
- Open multiple scans as layers, or close the current scan from the tool dock to start fresh with another
- An embed mode for `<iframe>` use (`?embed=1`), with a validated `postMessage` bridge for host-page control
- Developer diagnostics — a live performance overlay (`?debug=1`) and a structured benchmark mode (`?benchmark=1`)

## Terrain Intelligence Foundation

OpenLiDARViewer ships an internal terrain analysis foundation under
`src/terrain/` (introduced in v0.3.9). The foundation is a small set of
pure-data contracts and deterministic primitives (per-neighborhood metrics,
ground-confidence scoring, grid and tile partitioning, LRU cache,
worker job lifecycle, feature flags) that establish one common
envelope for every terrain analysis. Every result carries an honesty
contract: a coverage mode (`full` / `resident-only` / `sampled`),
the source and analyzed point counts, a 0–100 confidence value, and
ordered warnings, so an analyser never implies full-cloud certainty
when only resident streaming nodes were walked.

The first user-facing surface is the **Dataset Intelligence card** in
the Inspector. It reads the foundation outputs and renders five
informational rows: Point Density, Terrain Complexity, Ground
Visibility, Streaming Coverage, and Terrain Confidence. Rows for which
no signal is available render as `—` rather than fabricating a
confident bucket. The card does not perform ground classification.

Building on that foundation, v0.4.x adds a confidence-aware DTM and
contour pipeline (`src/terrain/contour/`, `ground/`, `surface/`) surfaced
through the **Analyse panel**: ground classification, a gridded DTM with
per-cell confidence and hold-out RMSE validation, a 0–100 terrain quality
score, surface models (DSM, canopy height, slope, multi-directional
hillshade), a single top-level Terrain Assessment verdict, evidence-graded
contour export (GeoJSON / SVG / DXF), a printable map sheet, and a
georeferenced DEM package (ASCII Grid + GeoTIFF). A DTM quality gate
governs whether a professional contour export is offered, and the panel is
explicit that its products are for analysis — not survey certification. The
per-cell confidence is calibrated against measured hold-out error, not
asserted: treat terrain products and DEM exports as deliverable-ready only
when the Terrain Assessment reads Good, and as preview otherwise.

See [`docs/terrain-intelligence.md`](docs/terrain-intelligence.md)
for the contract definitions and the honesty fields every result must carry,
and [`docs/validation/terrain-validation-matrix.md`](docs/validation/terrain-validation-matrix.md)
for how each terrain product is validated.

## Screenshots

| | |
|---|---|
| ![Main viewer](docs/screenshots/openlidarviewer-main.jpg) | ![Measuring inside the cloud](docs/screenshots/measurement-tool.jpg) |
| A 9.6M-point drone survey, height-colored, with the Scan Intelligence panel and the Orbit / Walk / Fly navigation. | The measurement toolkit — here a distance between two picked points; it also measures polyline, area, height, angle, slope, and cross-section profile. |
| ![Inspecting a point](docs/screenshots/inspect-tool.jpg) | ![Scan Intelligence panel](docs/screenshots/scan-intelligence-panel.jpg) |
| Inspecting a point: a glowing marker and a card with its real-world coordinates and attributes. | The Scan Intelligence panel — point count, dimensions, density, spacing, attributes, and the Advanced report. |
| ![Dataset Intelligence card](docs/screenshots/dataset-intelligence-card.jpg) | |
| The Dataset Intelligence card — informational summary of the loaded scan: Point Density, Terrain Complexity, Ground Visibility, Streaming Coverage, and Terrain Confidence. Rows for which no signal is available render as `—`. | |

More in [`docs/screenshots.md`](docs/screenshots.md).

## Navigation

OpenLiDARViewer has a game-like navigation system, so a scan can be explored like a 3D environment.

| Control | Action |
|---|---|
| W / A / S / D | Move through the scan |
| Mouse | Look around (click the scan to capture the cursor) |
| Shift | Move faster |
| Space | Move up |
| C / Ctrl | Move down |
| Esc | Release the cursor |
| R | Reset / re-frame the view |
| F | Focus on the point under the cursor |
| 1 / 2 / 3 | Orbit / Walk / Fly mode |
| Double-click | Fly to the clicked point |

Orbit mode is best for inspecting an object or area from the outside. Walk mode suits interiors, buildings, corridors, and street-level scans. Fly mode is for drone LiDAR, terrain, forests, and wide-area scans.

Movement speed scales with the size of the loaded scan, so the controls feel right whether the dataset is a small room or a kilometre-wide survey. Full detail is in [`docs/navigation.md`](docs/navigation.md).

## Rendering

OpenLiDARViewer is tuned so a point cloud reads as a 3D surface, not a flat wash of dots.

**Eye Dome Lighting** adds screen-space depth shading: it darkens every depth discontinuity, so edges, ridges, and the separation between near and far structure all become legible. It runs as a post-processing pass that targets both the WebGPU and WebGL 2 backends from one node graph. It is on by default on desktop WebGPU, and off by default on the WebGL 2 fallback and on mobile, where it can still be switched on.

**Adaptive point sizing** scales points with camera distance — clamped so far points stay visible and near points do not bloat — so density reads correctly across a scan. A Fixed mode keeps a constant on-screen size.

Points render as round, soft-edged dots with point-edge antialiasing, so overlapping points blend cleanly instead of stacking into visual noise.

All of this is tunable from the Rendering section of the Scan Intelligence panel: the Eye Dome Lighting toggle and strength, the Adaptive / Fixed point-size switch, and the antialiasing toggle.

## Measurement

OpenLiDARViewer includes a measurement toolkit for visual inspection and documentation. Open the Measure tool, pick a kind from the toolbar, and place points directly on the scan. Seven tools are available:

| Tool | What it measures |
|---|---|
| Distance | Straight-line distance between two points |
| Polyline | Total length of a multi-segment path |
| Area | Polygon area — both the true area in the polygon's own plane and the horizontal (map-projected) area |
| Height | Vertical difference between two points |
| Angle | The angle at a vertex between two arms |
| Slope | Rise, run, slope angle, and grade percentage between two points |
| Profile | Cross-section line between two points: 3D length, horizontal distance, vertical drop, and grade |

Every measurement is editable: drag a point to move it, undo the last point while placing, rename a measurement, or clear them all. Placed measurements are listed in a compact Measurements panel and persist for the session. A single toggle switches all readouts between metric and imperial units. The whole set can be exported to a JSON session file and re-imported later.

The **Profile** tool draws a section line on the cloud and renders an inline height-vs-distance chart strip beneath the row. The chart defaults to 140 px tall and can be dragged taller (up to 360 px) for closer inspection of grades and slope changes; a **Clear profile** button removes it when you're done. **Volume** runs against a polygon or a 3D lasso selection — the cut/fill numbers honour a streaming-resident caveat when nodes are still loading. **Measurement chains** combine placed measurements arithmetically (sum, difference, ratio) so the panel can carry both raw values and a derived figure.

Measurement is meant for visual inspection and research, not survey-grade use. Treat it as survey-grade only if you have validated it against survey-grade data and procedures.

## Supported / Target Formats

**Current import formats:** `LAS`, `LAZ`, `E57`, `PLY`, `OBJ`, `GLB`, `GLTF`, `XYZ`, `CSV`, `PCD`, `PTX`, `PTS`.

**Current export targets:** `PLY`, `OBJ`, `XYZ`, `CSV`, and `PNG` snapshots.

**iPhone and mobile scans.** OpenLiDARViewer opens exports from iPhone LiDAR and mobile scanning apps when they are saved as a supported format, usually PLY, OBJ, or GLB/GLTF (and XYZ/CSV). `USDZ` exports need conversion to a supported format first.

**Terrestrial laser scanners.** `E57` (ASTM E2807), the standard exchange format for terrestrial laser scanners, is read directly in the browser. The parser handles Cartesian coordinates, RGB colour, intensity, classification, surface normals, scan poses, and multi-scan files (every scan is merged into one cloud). E57 exports from Trimble survey scanners have been tested, and other standard E57 files — Leica, FARO, Matterport, and similar — follow the same ASTM format.

**Drone LiDAR and professional point clouds.** Georeferenced drone LiDAR surveys in LAS and LAZ work today. `PCD` (the Point Cloud Library format, in ASCII, binary, and binary-compressed variants) and the terrestrial-scanner text formats `PTX` and `PTS` are read directly in the browser.

**COPC streaming.** Large `COPC` (Cloud Optimized Point Cloud) `.copc.laz` files open through a dedicated streaming pipeline: the octree hierarchy is read with partial range requests, a coarse view renders almost immediately, and visible regions refine progressively as the camera moves. Decoding runs in a worker, memory stays bounded by a view-dependent budget, and the point data is never read whole. A COPC scan opens the same way whether it is on disk or hosted at a URL — a remote scan streams over HTTP range requests from the start screen's open-from-URL field or a shareable `?copc=<url>` deep link, provided the host allows range and cross-origin requests. Full detail is in [`docs/streaming.md`](docs/streaming.md).

Format support varies with browser memory, GPU capacity, dataset size, preprocessing, and implementation status. Full detail is in [`docs/supported-formats.md`](docs/supported-formats.md).

**Recommended formats for large datasets:**

- COPC (`.copc.laz`)
- EPT (`ept.json`)

**Recommended formats for lightweight sharing:**

- PLY
- GLB

## System Requirements

OpenLiDARViewer runs in the browser and depends on modern GPU-accelerated web rendering. Performance varies with the dataset and the device.

Use a modern Chromium-based browser (Chrome or Edge) with WebGL 2.0 support and hardware acceleration enabled. WebGPU is used automatically where it is available.

| Component | Minimum | Recommended |
|---|---|---|
| CPU | Modern dual-core | Quad-core or better |
| RAM | 8 GB | 16 GB or more |
| GPU | Integrated GPU with WebGL 2.0 | Dedicated GPU, or modern Apple Silicon / integrated GPU |
| Browser | WebGL 2.0 compatible | WebGL 2.0 and WebGPU-capable |

**Recommended browsers:**

- Chrome
- Edge

**Supported browsers:**

- Firefox
- Safari (WebGL fallback may apply)

Very large LiDAR datasets are best handled as COPC or EPT, which stream progressively with bounded memory; other very large formats may need downsampling or preprocessing. Full detail is in [`docs/performance.md`](docs/performance.md).

## Mobile Browser Support

OpenLiDARViewer includes a mobile-friendly interface for opening compatible point-cloud and 3D scan files from phones and tablets.

On mobile:

- Files can be opened from the device file picker.
- Users can open compatible exports saved to device storage or cloud file providers.
- Scan Intelligence is shown as a compact panel after loading a scan.
- Navigation uses touch gestures instead of keyboard shortcuts.
- Measurement uses tap-based point selection.
- Rendering defaults to a mobile-safe performance mode.

Recommended mobile workflow:

1. Export a compatible scan from a mobile scanning app.
2. Save it to device storage or a cloud file provider such as iCloud Drive.
3. Open OpenLiDARViewer in a mobile browser.
4. Tap "Open scan from device."
5. Inspect, measure, and export.

Mobile scanning app note: OpenLiDARViewer can open compatible files exported from mobile scanning apps when the exported format is supported by the viewer. A practical testing workflow is to capture a scan with an iPhone LiDAR scanning app — such as Polycam, Scaniverse, or 3D Scanner App — export it in a supported format (GLTF/GLB, OBJ, or PLY), save the file to the device, and open it in OpenLiDARViewer. Available export formats, free-tier options, and pricing differ between apps and can change over time, so check each app's current help documentation. Some formats may require a paid plan.

Mobile performance note: Mobile performance depends on browser, GPU, memory, file size, and point count. Very large datasets may require desktop hardware, downsampling, tiling, or optimized formats.

Trademark note: All third-party product names are used only for descriptive compatibility and workflow documentation. OpenLiDARViewer is not affiliated with, endorsed by, or sponsored by Apple, Polycam, or other third-party scanning apps.

Full detail is in [`docs/mobile-browser-support.md`](docs/mobile-browser-support.md).

## Research & Development Focus

OpenLiDARViewer started as an experiment: how far can modern browser technology go in making LiDAR and point-cloud data easy to reach? It looks at browser-native point-cloud rendering, lightweight WebGL/WebGPU pipelines, human-centered interaction with 3D data, game-inspired navigation for technical inspection, local-first workflows for sensitive data, and simpler interfaces for complex datasets.

The aim is not to replace full GIS or survey-grade processing. It is to give people a fast, approachable way to open, inspect, navigate, measure, and present point clouds. See [`docs/research-notes.md`](docs/research-notes.md).

## How It Works

1. You load a point-cloud dataset by dropping a file, or by clicking a built-in sample.
2. The format is detected from the file's magic bytes first, then its extension.
3. The file is parsed off the main thread, inside a Web Worker.
4. Point positions and attributes are decoded. Large georeferenced coordinates are recentered in double precision before the float32 downcast.
5. Clouds above the point budget are voxel-downsampled, and the Detail control shows the honest `shown / total` count.
6. The cloud renders through a WebGPU or WebGL 2 pipeline built on three.js; Eye Dome Lighting adds screen-space depth shading as a post-processing pass.
7. Color modes map height, intensity, classification, RGB, or surface-normal direction onto the points, which are sized adaptively with distance.
8. You explore with Orbit, Walk, or Fly navigation.
9. Scan Intelligence summarizes the dataset, and the measurement toolkit takes distance, area, height, angle, slope, and cross-section profile measurements.
10. You save viewpoints and export snapshots, re-exported point data, or a JSON measurement session.

## Technology Stack

- TypeScript, in strict mode, across the IO, model, and render layers
- three.js (`three/webgpu`), a WebGPU renderer with a WebGL 2 fallback
- A `three/tsl` node-graph post-processing pipeline (Eye Dome Lighting) that targets both backends from one shader description
- loaders.gl and laz-perf (WASM) for mesh and LAZ parsing, plus a from-scratch TypeScript E57 parser
- Vite for the build and dev server, with Web Worker and WASM handling
- Vitest and Playwright for unit and end-to-end tests
- A client-side, local-first pipeline with no backend

## Getting Started

```bash
git clone https://github.com/aurtechmx/openlidarviewer.git
cd openlidarviewer
npm install
npm run dev
```

Open the local URL it prints, then drop a scan onto the page or click a built-in sample.

To build for static hosting (GitHub Pages, Netlify, or any CDN, since it is just files):

```bash
npm run build
npm run preview
```

## Usage

1. Open the app in a modern WebGL/WebGPU-capable browser.
2. Drop a compatible point-cloud file onto the page.
3. Choose a visual mode: Height, Intensity, Classification, RGB, or Normal.
4. Adjust point size and rendering detail.
5. Navigate with Orbit, Walk, or Fly mode.
6. Read the Scan Intelligence panel for dataset metadata and quality.
7. Measure distance, polyline, area, height, angle, slope, or cross-section profile inside the point cloud.
8. Annotate points of interest with categorised notes, and inspect or probe individual points.
9. Save viewpoints for repeated inspection.
10. Export a PNG snapshot, re-export the cloud as PLY, OBJ, XYZ, or CSV, or save the full working state as a `.olvsession` package.
11. Close the scan from the tool dock to return to the start and open another.

A fuller walkthrough is in [`docs/usage.md`](docs/usage.md).

## Recommended Workflows

A short list of practical workflows the current toolkit is well-suited for. Each one assumes a single drag-and-drop or URL open, with everything happening locally in the browser.

- **Large streaming dataset review.** Open COPC (`.copc.laz`) or EPT (`ept.json`) datasets directly — local file or remote URL. Navigate at interactive frame rates against datasets far larger than browser memory; the scheduler streams only what the current view needs.
- **Inspection reporting.** Annotate findings → measure distances, areas, slopes, angles, or cross-section profiles → export a multi-page PDF technical report (cover, dataset summary, embedded image exports, annotations, measurements, technical notes). Five built-in templates and brand-aware accent + logo support.
- **Terrain analysis.** Export height maps from drone LiDAR datasets with legend customisation and unit-system control. Useful for slope review, elevation comparison, and quick topographic figures. Cross-section profile measurements report 3D length, horizontal distance, vertical drop, and grade across any two picked points.
- **Classification QA.** Export classification maps for validation workflows; toggle the colour mode to highlight specific classes, place annotations on misclassified regions, and round-trip the working state through `.olvsession` for follow-up review.
- **Mobile scan review.** Open lightweight datasets — `.glb`, `.ply`, `.obj` from Polycam, Scaniverse, or similar iPhone/Android scanners — on tablets or phones. The viewer adapts rendering detail and Eye Dome Lighting defaults for weaker GPUs so a phone scan is readable from the first frame.

## Architecture Overview

OpenLiDARViewer is deliberately modular, with one file per format and one file per concern. File loading, point parsing, the coordinate bridge, render-buffer generation, color modes, the navigation manager, the measurement system, the Scan Intelligence modules, and the export system are all separable. See [`docs/architecture.md`](docs/architecture.md) and the [Developer Manual](docs/developer-manual.md).

## Performance Notes

Performance depends on point count, browser memory, GPU capability, point size, rendering detail, the color mode in use, the file format, and how the data was prepared. A LAS/LAZ file is planned from its header before it is fully read: a cloud above the roughly 4M-point budget is loaded at reduced density — voxel-downsampled, or stride-decoded when far over budget so it is never fully held in memory — with a memory-safety guard, staged progress, and a cancellable load. The Detail readout always shows the honest `shown / total` count.

For real-world figures — a 9.6M-point drone LAZ survey and a 55K-point iPhone scan, both opened from one drag-and-drop — see [`docs/benchmarks.md`](docs/benchmarks.md).

COPC streaming — local and remote — ships in v0.3.0 and is hardened across v0.3.1 / v0.3.3 with a view-dependent scheduler, hierarchy-aware eviction, a dispatch-pressure gate that bounds residency under 1B-synthetic-point stress, and trustworthy picking against actively-refining clouds. EPT (Entwine Point Tile) joins COPC as a first-class peer in v0.3.3. See [`docs/performance.md`](docs/performance.md) and [`docs/streaming.md`](docs/streaming.md).

## What's in this release

### v0.3.9 — Premium interaction surface + terrain foundation
- Smart camera presets — Top, Iso, Oblique, Planar
- Theme system — Dark, Light, High-contrast — with a persisted preference
- Command palette (`Cmd-K` / `Ctrl-K`) for keyboard-first access to every tool, mode, theme, and export
- Workflow recorder — save and replay `.olvworkflow` files of camera moves and tool actions
- Onboarding tour + searchable shortcut sheet (`?`)
- Terrain Intelligence Foundation (`src/terrain/`) — deterministic, honesty-contracted primitives for ground confidence, partitioning, caching, and worker job lifecycle
- Dataset Intelligence card — Point Density, Terrain Complexity, Ground Visibility, Streaming Coverage, Terrain Confidence; honest `—` when no signal is available
- Inspector mini-dashboards — sparklines and gauges for live scan telemetry
- Mobile touch model — twist + pinch + pan decomposition with dead zones; opt-in 3-finger zoom for advanced users
- Mobile Scan Intelligence bottom-sheet — peek + tap-to-toggle; tool-dock overflow "More" disclosure
- A coordinate bridge with `CrsService`, UTM + lat/lon inspector readouts, and a streaming-aware Visuals Studio with white balance + auto-balance gated to streaming COPC

### v0.3.8 — Visuals Studio + lasso volume + FLAI integration
- Visuals Studio — three chip rails (Colour Mode, RGB Preset, Sky / EDL) that re-style the scan without leaving the panel
- Soft splat rendering — Classic round points, Soft splats, or Inspection mode with density-aware radius
- Lasso volume — 3D volumetric (not screen polygon) selection with NaN / degenerate / self-intersection guards, save-to-session, and a streaming-resident caveat
- FLAI integration — additional curated COPC URLs verified through a CORS + LAS-header probe
- Polygon completion workflow — click first vertex to close, with visual feedback

### v0.3.7 — Premium graphics + new LiDAR capabilities
- EDL + SSAO combined ambient occlusion
- Hillshade overlay colour mode
- Local-density adaptive point sizing
- Palette editor + named perceptual presets, with a 5/95 percentile-clipped height mode and Turbo default
- HDR sky / atmospheric backgrounds — Studio Dark, Blueprint, Survey Light, Terrain, Black
- Inspection presets (Survey / Terrain / Foliage / Class / QA)
- **Cross-section + height profile** — pickable section line with a chart strip in the Measurements panel
- **Volume (cut / fill)** measurement against a polygon
- **Classification editor** with LAS write-back
- **Density heatmap** overlay
- **3D Tiles / `.pnts` streaming** — Cesium-style tilesets read from a `tileset.json`
- **Interactive box clipping / slicing**
- Patch view + colour provenance
- White balance (temperature + tint), auto-balance, EDL presets (Subtle / Balanced / Inspection)
- Photoreal RGB + Drone RGB + Mobile LiDAR + Infrastructure presets
- Measurement chains — combine placed measurements as sum / difference / ratio

### v0.3.6 — Research foundation
- Verified public LiDAR dataset picker — 18 hand-vetted COPC / EPT URLs, every one probed at release time, no API key
- Provenance fingerprint — classifies capture type (iPhone / drone / terrestrial / aerial / spaceborne) with literature-cited accuracy bounds
- Scan Acceptance report template — pass/fail checklist over user-supplied thresholds, with a literature-cited Methods appendix
- Local-first usage counters — categorical session stats in `localStorage` only, `?notelemetry=1` opt-out

### v0.3.0 – v0.3.5 — Streaming + reporting platform
- COPC LAZ streaming — local and remote (0.3.0); hardened across 0.3.1–0.3.3
- EPT (Entwine Point Tile) streaming — local and remote, `binary` and `laszip` tiles (0.3.3)
- PCD, PTS, PTX static imports
- Visual Export Studio — orthographic RGB, height map, intensity, classification, depth, normal, contour (0.3.2–0.3.3)
- Multi-page PDF technical reports — six built-in templates with branding and unit-system awareness (0.3.3–0.3.6)
- `.olvsession` session round-trip — camera, render settings, colour mode, annotations, measurements, scan metadata (0.3.3)
- Measurement toolkit — distance, polyline, area, height, angle, slope, cross-section profile
- Annotation system with categorised markers and notes
- Point inspector and live probe
- WebGPU primary path with a WebGL 2 fallback

## Current Limitations

OpenLiDARViewer is an active R&D-stage project focused on lightweight visualization and interaction. It is not meant to replace full GIS, photogrammetry, or survey-grade processing tools.

- Large files are limited by browser memory and GPU performance.
- Some LiDAR formats need preprocessing or conversion before they load.
- Format support is still evolving.
- Measurement is for visual inspection, not survey-grade use.
- Coordinate reference system handling is basic and may need future work.
- Classification visualization depends on attributes present in the file.
- Very large datasets stream as COPC (local or remote); other huge formats may still need tiling or downsampling.
- WebGPU feature support varies by browser, and the WebGL 2 fallback is used otherwise.
- Eye Dome Lighting is a screen-space depth cue, not physically-based lighting; it is off by default on the WebGL 2 fallback and on mobile.

Full detail is in [`docs/limitations.md`](docs/limitations.md).

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), the [security policy](SECURITY.md), and the [code of conduct](CODE_OF_CONDUCT.md). The codebase is small, test-first (Vitest and Playwright), written in strict TypeScript, and deliberately modular.

## License

MIT. See [LICENSE](LICENSE). If you use OpenLiDARViewer in research, a [CITATION.cff](CITATION.cff) is included.

## Author

Developed by Aurtech. [aurtech.mx](https://aurtech.mx)
