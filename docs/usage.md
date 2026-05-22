# Usage

How to open, inspect, navigate, measure, and export a scan. To try it without
installing anything, open the live version at <https://lidar.aurtech.mx/>.

## Opening a scan

Open the app in a modern WebGL/WebGPU-capable browser (Chrome or Edge work well). Drag a point-cloud file anywhere onto the page, or click a built-in sample on the empty state. The format is detected automatically and parsing runs in the background.

A "Project ready" card then appears with a quick summary: format, point count, bounding box, detected attributes, a suggested navigation mode, and a performance estimate. It dismisses on its own.

Supported imports are `LAS`, `LAZ`, `PLY`, `OBJ`, `GLB`, `GLTF`, `XYZ`, and `CSV`. Nothing is uploaded. The file is read and rendered entirely in your browser.

## Styling the cloud

The Scan Intelligence panel has three controls for how the cloud looks:

- **Color by** switches between Height, Intensity, Classification, and RGB. Only the modes the file actually contains are offered, and the best one is selected automatically.
- **Point size** sets the on-screen size of each point.
- **Detail** shows the honest `shown / total` count. Large clouds are voxel-downsampled to a point budget so the viewer stays responsive.

## Navigating

Switch modes with the bottom-centre control or the `1` / `2` / `3` keys. Orbit lets you drag to rotate, scroll to zoom, and double-click to focus. Walk is first-person, with WASD on the level and Space/C for height. Fly is free flight, where WASD follows where you look.

In Walk and Fly, click the scan to capture the cursor for mouse-look, and press `Esc` to release it. See [navigation.md](navigation.md).

## Inspecting with Scan Intelligence

The Scan report shows the headline metrics: point count, width, depth, height, density, spacing, and which attributes (RGB, intensity, classification) are present. When a LAS or LAZ file records them, it also shows the capture sensor, the source software, and the capture date. Open the Advanced report for the scan's georeferenced bounding box (the min and max corners in real-world coordinates) and integrity diagnostics, including invalid coordinates, duplicate points, stray outliers, and a declared-vs-decoded point-count check.

## Measuring

Click Measure in the tool dock, then click two points on the scan. The straight-line distance is drawn and labelled in cm, m, or km. Click two more points to add another measurement, Clear to remove them, or Esc to exit. Measurement is for visual inspection. See the note in [limitations.md](limitations.md).

## Inspecting a point

Click Inspect in the tool dock, then click any point on the scan. A glowing marker drops on the nearest point and a compact card shows its real-world coordinates, distance from the camera, intensity, classification, RGB colour, source layer, and index — with attributes the file does not carry shown as "Not available". For a georeferenced LAS or LAZ survey the coordinates are the absolute survey position, which is what engineers and topographers need. The Copy button puts the point's data on the clipboard as clean text. Clicking another point replaces the selection; Esc, Done, or clicking Inspect again exits. Measure and Inspect are mutually exclusive — turning one on turns the other off.

## Saved views

In the Saved views section of the panel, click Save current view to store the camera position. Click a saved view to glide back to it. This is useful for inspection, reports, and presentations.

## Exporting

Snapshot, in the tool dock, saves the current view as a PNG. Export, in the panel, re-exports the loaded cloud as PLY, OBJ, XYZ, or CSV in real-world coordinates.

## Embedding

Append `?embed=1` to the URL to strip the chrome down to a bare canvas for use in an `<iframe>`.
