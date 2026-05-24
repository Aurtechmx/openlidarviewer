# Usage

How to open, inspect, navigate, measure, and export a scan. To try it without
installing anything, open the live version at <https://lidar.aurtech.mx/>.

## Opening a scan

Open the app in a modern WebGL/WebGPU-capable browser (Chrome or Edge work well). Drag a point-cloud file anywhere onto the page, or click a built-in sample on the empty state. The format is detected automatically and parsing runs in the background.

For LAS and LAZ files a short preload summary appears first — the format, the source point count, and how the file will be loaded. A status toast then tracks the load through its stages — reading, decoding, optimizing — and a very large file shows a live point counter and a progress bar. A Cancel control on the toast stops a load in progress; nothing is added to the scene if you cancel.

A "Project ready" card then appears with a quick summary: format, point count, bounding box, detected attributes, a suggested navigation mode, and a performance estimate. It dismisses on its own.

Supported imports are `LAS`, `LAZ`, `E57`, `PLY`, `OBJ`, `GLB`, `GLTF`, `XYZ`, and `CSV`. Nothing is uploaded. The file is read and rendered entirely in your browser.

Dropping a second file opens it as an additional layer alongside the first; the Layers section of the Scan Intelligence panel lists every open scan, each with a visibility toggle and a remove control.

## Closing a scan

Click Close in the tool dock to clear the current scan — and any additional layers — and return to the empty state. From there you can drop, open, or sample another scan. Closing also clears the session's measurements and saved views, so the next scan starts clean; export a measurement session first if you want to keep it.

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

While placing, undo removes the last point. Once placed, drag any point to move it, and a measurement can be renamed or deleted from the Measurements panel. Clear all empties the list. The units toggle switches every readout between metric and imperial. Export saves all measurements to a JSON session file, and Import loads one back. Measurements persist for the browser session.

Measurement is for visual inspection. See the note in [limitations.md](limitations.md).

## Inspecting a point

Click Inspect in the tool dock, then click any point on the scan. A glowing marker drops on the nearest point and a compact card shows its real-world coordinates, distance from the camera, intensity, classification, RGB colour, source layer, and index — with attributes the file does not carry shown as "Not available". For a georeferenced LAS or LAZ survey the coordinates are the absolute survey position, which is what engineers and topographers need. The Copy button puts the point's data on the clipboard as clean text. Clicking another point replaces the selection; Esc, Done, or clicking Inspect again exits. Measure and Inspect are mutually exclusive — turning one on turns the other off.

## Saved views

In the Saved views section of the panel, click Save current view to store the camera position. Click a saved view to glide back to it. This is useful for inspection, reports, and presentations.

## Exporting

Snapshot, in the tool dock, saves the current view as a PNG. Export, in the panel, re-exports the loaded cloud as PLY, OBJ, XYZ, or CSV in real-world coordinates.

## Mobile Usage

1. Open OpenLiDARViewer on your phone.
2. Tap "Open scan from device."
3. Choose a compatible file from device storage or a cloud file provider.
4. Use touch gestures to navigate — drag to rotate, pinch to zoom, two fingers to pan.
5. Tap Measure to measure between points.
6. Open Scan Info to view scan metadata.
7. Export a snapshot or a supported file format.

## Embedding

Append `?embed=1` to the URL to strip the chrome down to a bare canvas for use in an `<iframe>`.
