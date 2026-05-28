# Usage

How to open, navigate, measure, annotate, inspect, and export a scan. To try
it without installing anything, open the live version at
<https://lidar.aurtech.mx/>.

## Opening a scan

Open the app in a modern WebGL/WebGPU-capable browser (Chrome or Edge work well). Drag a point-cloud file anywhere onto the page, or click a built-in sample on the empty state. The format is detected automatically and parsing runs in the background.

For LAS and LAZ files a short preload summary appears first — the format, the source point count, and how the file will be loaded. A status toast then tracks the load through its stages — reading, decoding, optimizing — and a very large file shows a live point counter and a progress bar. A Cancel control on the toast stops a load in progress; nothing is added to the scene if you cancel.

A "Project ready" card then appears with a quick summary: format, point count, bounding box, detected attributes, a suggested navigation mode, and a performance estimate. It dismisses on its own.

Supported imports are `LAS`, `LAZ`, `E57`, `PLY`, `OBJ`, `GLB`, `GLTF`, `XYZ`, `CSV`, `PCD`, `PTS`, and `PTX`. Large hierarchical-streaming formats — `COPC` (`.copc.laz`) and `EPT` (Entwine Point Tile, via an `ept.json` URL) — open progressively through their octree hierarchies; see [`streaming.md`](streaming.md). Nothing is uploaded. The file is read and rendered entirely in your browser.

Dropping a second file opens it as an additional layer alongside the first; the Layers section of the Scan Intelligence panel lists every open scan, each with a visibility toggle and a remove control.

## Closing a scan

Click Close in the tool dock to clear the current scan — and any additional layers — and return to the empty state. From there you can drop, open, or sample another scan. Closing also clears the session's measurements, annotations, and saved views, so the next scan starts clean; export the session first if you want to keep it.

## Styling the cloud

The Scan Intelligence panel controls how the cloud looks:

- **Color by** switches between Height, Intensity, Classification, RGB, and Normal. Only the modes the file actually contains are offered, and the best one is selected automatically. Normal shading maps each point's surface-normal direction to colour and appears for files that carry per-point normals, such as many E57 scans.
- **Point size** sets the base on-screen size of each point.
- **Detail** shows the honest `shown / total` count. A cloud larger than the point budget is loaded at reduced density so the viewer stays responsive — see [performance.md](performance.md).

## Rendering

The Rendering section of the panel tunes how the cloud is drawn:

- **Eye Dome Lighting** toggles screen-space depth shading. It darkens depth discontinuities so edges and 3D structure stand out, and the strength slider sets how pronounced the effect is. It is on by default on desktop WebGPU, and off on the WebGL 2 fallback and on phones — where it can still be switched on.
- **Point size mode** switches between Adaptive — points scale with camera distance, clamped so far points stay visible and near ones do not bloat — and Fixed, a constant on-screen size. A cloud opens at the smallest size in Fixed mode — the most honest first view, with no distance-driven size gradient — and the point-size slider sets the base size for both modes. A size or mode you choose is remembered for the next session.
- **Antialiasing** toggles the smoothing of each point's round edge.

## Navigating

Switch modes with the bottom-centre control or the `1` / `2` / `3` keys. Orbit lets you drag to rotate, scroll to zoom, and double-click to focus. Walk is first-person, with WASD on the level and Space/C for height. Fly is free flight, where WASD follows where you look.

In Walk and Fly, click the scan to capture the cursor for mouse-look, and press `Esc` to release it. See [navigation.md](navigation.md).

## Inspecting with Scan Intelligence

The Scan report shows the headline metrics: point count, width, depth, height, density, spacing, and which attributes (RGB, intensity, classification) are present. When a LAS or LAZ file records them, it also shows the capture sensor, the source software, and the capture date. Open the Advanced report for the scan's georeferenced bounding box (the min and max corners in real-world coordinates) and integrity diagnostics, including invalid coordinates, duplicate points, stray outliers, and a declared-vs-decoded point-count check.

## Measuring

Click Measure in the tool dock to open the measurement toolbar. Pick a tool from it, then click points on the scan:

- **Distance** — two points; the straight-line distance between them.
- **Polyline** — any number of points; the total path length. Double-click or press Done to finish.
- **Area** — three or more points forming a polygon; reports both the true area in the polygon's own plane and the horizontal map-projected area.
- **Height** — two points; the vertical difference between them.
- **Angle** — three points; the angle at the middle vertex.
- **Slope** — two points; the rise, run, slope angle, and grade percentage.
- **Profile** — two points; the full cross-section geometry of the line: 3D length, horizontal distance, vertical drop, and grade percentage. Reads in a single compact card ("12.5 m · Δh +2.3 m · 18.4%"); the overlay draws the 3D segment plus an L-bent ghost so the run and drop are visible separately.

While placing, undo removes the last point. Once placed, drag any point to move it, and a measurement can be renamed or deleted from the Measurements panel. Clear all empties the list. The units toggle switches every readout between metric and imperial. Export saves all measurements to a JSON session file, and Import loads one back. Measurements persist for the browser session.

Measurement is for visual inspection. See the note in [limitations.md](limitations.md).

## Annotating

Annotations mark points of interest for review. Click Annotate in the tool dock, then click a point on the scan: a numbered marker drops on it and a compact card opens. Give the annotation a title, choose a category — note, info, warning, or issue — and add an optional note. Keep the "Save current camera view" checkbox ticked to store the exact viewpoint you placed it from. Save commits the annotation; Cancel discards the draft, so an abandoned card never leaves a stray marker.

You can also link an annotation to a measurement: when the scan has measurements, the editor offers a "Linked measurement" selector, and a linked annotation shows the measurement's name in the panel.

The Annotations panel lists every placed marker with its category badge, title, and when it was last edited. Sort the list by created time, recent edit, category, or title, and use the search box to filter by title, note, or type. Each row jumps the camera to its annotation — restoring the saved viewpoint when one was captured — and offers Edit and delete; Clear all empties the list with a confirm step. Hovering a row highlights the matching marker in the scene.

Every scan stays on your device. Export the session (see Exporting) to save the whole inspection — measurements, annotations, and named views — to a JSON file and reload it later.

## Inspecting a point

Click Inspect in the tool dock, then click any point on the scan. A glowing marker drops on the nearest point and a compact card shows its real-world coordinates, distance from the camera, intensity, classification, RGB colour, source layer, and index — with attributes the file does not carry shown as "Not available". For a LAS or LAZ point the card also shows the return number and count, the point source ID, and the GPS time when the file records them, and the surface normal for clouds that carry one; those rows are simply omitted when the data is absent. For a georeferenced LAS or LAZ survey the coordinates are the absolute survey position, which is what engineers and topographers need. The Copy button puts the point's data on the clipboard as clean text. Clicking another point replaces the selection; Esc, Done, or clicking Inspect again exits.

The **live probe** (desktop) is Inspect without the click: turn on Probe in the tool dock and a small readout follows the cursor, showing the point under it as you hover. Navigation stays fully live, so you can orbit and probe at once. Probe is a hover affordance, so it is not offered on touch devices.

The picking tools — Measure, Inspect, Annotate, and Probe — are mutually exclusive; turning one on turns the others off.

## Saved views

In the Saved views section of the panel, click Save current view — or press `V` — to store the camera position. Each saved view can be renamed in place; click Go to glide the camera back to it, or the `×` to delete it. Saved views are kept in the session file, so they survive an export and import. This is useful for inspection, reports, and presentations.

## Keyboard shortcuts

`A`, `M`, and `I` toggle the Annotate, Measure, and Inspect tools; `V` saves the current camera view; `Delete` removes the selected annotation; `Ctrl`/`Cmd`+`Z` undoes an annotation change and adding `Shift` redoes it; `Esc` cancels the active tool; and `?` opens the help overlay. Shortcuts are suppressed while you are typing in a field. Navigation keeps its own keys — `1`/`2`/`3` for the modes, `R` to frame the scan, `F` to focus the centre. The Help button in the tool dock opens a reference card covering all of this.

## Exporting

Snapshot, in the tool dock, saves the current view as a PNG; any placed measurements and annotations are burned into the image, so the snapshot works as inspection evidence. The Visual Export Studio opens richer image modes — orthographic RGB, height map, intensity, classification, and normal — with legend customisation. Export, in the panel, re-exports the loaded cloud as PLY, OBJ, XYZ, or CSV in real-world coordinates.

**Report PDF.** Export → Report PDF builds a multi-page technical report from the live working state — a cover page, dataset summary (point count, bounds, density, CRS), embedded image exports, annotations and measurements tables, technical notes, and a footer. Five built-in templates (Engineering Inspection, QA Validation, Terrain Review, Survey Summary, Technical Documentation) set the default voice; three themes (`light-technical`, `dark-inspection`, `minimal-engineering`) and white-label project metadata (Client / Project / Phase / Reference / Date) plus an optional confidentiality footer note propagate through every page. Branding (accent colour, logo, organisation, author) and the metric/imperial unit system propagate through every table. The PDF engine and its pdf-lib dependency load only when you click the button, so the initial app payload stays unchanged for users who never need a report.

**Session round-trip (`.olvsession`).** The session Export saves the full working state — camera, render settings, active colour mode, annotations, measurements, named views, and scan metadata — to a `.olvsession` JSON file. Import loads one back, restoring the camera and view exactly. Older measurement-only and v2 session files still open via the v1/v2/v3 schema back-compat in the parser.

## Mobile Usage

1. Open OpenLiDARViewer on your phone.
2. Tap "Open scan from device."
3. Choose a compatible file from device storage or a cloud file provider.
4. Use touch gestures to navigate — drag to rotate, pinch to zoom, two fingers to pan.
5. Tap Measure to measure between points, or Annotate to mark and note a point of interest.
6. Open Scan Info to view scan metadata.
7. Export a snapshot or a supported file format.

The annotation editor and panel use touch-sized controls on phones. The live probe is a hover tool, so it is desktop-only.

## Sharing a view

The **Share** tool in the bottom dock copies a link that reproduces the current view — the camera position and target, the colour mode, the point sizing, and the selected annotation. The link carries **no scan data**: the recipient opens the same scan themselves, and the saved view is applied on top. This keeps "share this view" working with no upload and no backend.

## Embedding

Append `?embed=1` to the URL to strip the chrome down to a bare canvas for use in an `<iframe>`. The embed surface is a small, documented set of URL flags and a validated `postMessage` bridge.

### URL flags

| Flag | Effect |
|---|---|
| `?embed=1` | Embed mode — hides the dock and panels, enables the bridge |
| `?ui=minimal` | Hides the dock and panels without enabling the bridge |
| `?measurements=1` | Surfaces the measurement tool layer in a bare view |
| `?annotations=1` | Surfaces the annotation tool layer in a bare view |
| `?autoload=sample:<id>` | Opens a built-in sample on startup (`survey` or `scan`) |

### postMessage bridge

In embed mode the viewer posts one `ready` message to the host page once the renderer has initialised: `{ source: 'openlidarviewer', type: 'ready', version }`. The host page may then send commands with `iframe.contentWindow.postMessage(...)`. Each command is validated against a small, closed set of verbs; anything unrecognised or malformed is ignored:

| Command | Shape |
|---|---|
| Load a file | `{ type: 'load-file', buffer: ArrayBuffer, name: string }` |
| Jump the camera | `{ type: 'jump-camera', camera: { position, target, mode?, fov? } }` |
| Toggle a layer | `{ type: 'toggle-layer', id: string, visible: boolean }` |
| Focus an annotation | `{ type: 'focus-annotation', id: string }` |

## Developer diagnostics

Two URL flags surface developer diagnostics; neither appears in a normal session.

`?debug=1` shows a live performance overlay — frame rate and frame time, the GPU backend (WebGPU or WebGL 2), draw calls, the displayed and total point counts, and an estimated GPU memory figure — refreshed about four times a second, alongside the most recent load's stage-by-stage telemetry. The raw error detail for any failed load is also logged to the console under this flag.

`?benchmark=1` emits a structured benchmark result for each load — the time to first render and the full per-stage timing breakdown — to both the overlay and the console, so loading performance can be compared across versions.
