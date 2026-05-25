# Changelog

All notable changes to OpenLiDARViewer are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Planned

- 0.3.0 — the complete rendering overhaul: background themes, premium loading
  states, and full mobile-adaptive rendering, building on the 0.2.5 pipeline
- Cloud-optimised and streaming formats — COPC LAZ, 3D Tiles / PNTS
- Cross-section and profile measurement
- Slicing and clipping tools
- Large-scale dataset streaming and level-of-detail

See [`docs/roadmap.md`](docs/roadmap.md) for the full roadmap.

## [0.2.9] - 2026-05-25

A professional-interoperability release. OpenLiDARViewer reads three more
point-cloud formats, loads very large text datasets without freezing, degrades
gracefully on weak devices, and gains developer diagnostics, a documented embed
API, and shareable view links — all browser-native, with nothing uploaded.

### Added

- PCD point clouds. The Point Cloud Library format opens directly — ASCII,
  binary, and binary-compressed variants — with position, RGB colour,
  intensity, surface normals, and labels read where the file carries them.
- PTX and PTS terrestrial-scanner formats. PTX multi-scan files apply each
  scan's pose matrix and record the scanner origin; PTS files read the
  optional header count and the standard 3/4/6/7-column layouts. Both decode
  entirely in the browser.
- A universal file-open summary. Every dropped file — not just LAS/LAZ — now
  shows what the viewer detected before the decode begins: the format, the
  source size, the point count where the header reveals one, and the chosen
  load mode.
- Categorised load errors. A failed load shows a clear, plain-language message
  — an unsupported format, a malformed file, a memory limit, a decode failure
  — instead of a raw error string. The raw detail still reaches the console
  under `?debug=1`.
- A performance overlay. `?debug=1` shows a live panel — frame rate, GPU
  backend, draw calls, displayed and total point counts, and an estimated GPU
  memory figure — alongside the most recent load's stage-by-stage telemetry.
- Benchmark mode. `?benchmark=1` emits a structured, comparable benchmark
  result for each load — time to first render and the full per-stage breakdown
  — to the overlay and the console.
- Shareable view links. The Share tool copies a link that reproduces the
  current view — camera, colour mode, point sizing, and the selected
  annotation. The link carries no scan data; the recipient opens the same scan
  and the saved view is restored on top.
- A hardened embed API. The `?embed=1` embed mode gains a validated
  `postMessage` bridge: a host page can load a file, jump the camera, toggle a
  layer, or focus an annotation through a small, closed set of verified
  commands, and `?ui=minimal`, `?autoload`, and force-tool flags round out the
  documented embedding surface.

### Changed

- Large text point clouds — XYZ, CSV, and PTS — are now read in bounded chunks,
  so a very large text dataset loads without exhausting browser memory.
- Graceful degradation on weak devices. The viewer profiles the device on
  startup and picks a safe render budget and quality defaults; a hard GPU
  point ceiling guards every load path, so a large survey degrades in density
  rather than risking a GPU crash.
- Internal architecture. The decoders moved behind a loader registry, and a
  `PointCloudSource` abstraction now sits between the app and the file — a
  clean seam for the planned v0.3 streaming sources. No workflow changed, and
  every v0.2.7 / v0.2.8 workflow still passes unchanged.

## [0.2.8] - 2026-05-24

An inspection-workflows release. The viewer becomes a local, private review
environment: open a scan, mark points of interest with categorised notes,
revisit them later, save the whole inspection to a file, and export visual
evidence — all in the browser, with nothing uploaded.

### Added

- Annotations. With the Annotate tool active, click a point on the scan to
  drop a numbered marker and fill in a compact card — a title, an optional
  note, and one of four categories: note, info, warning, or issue. Markers are
  drawn as a screen-space overlay that stays crisp at any zoom and carries no
  per-frame cost, so a review with hundreds of findings stays fluid.
- Annotations panel. Every placed annotation is listed with its category
  badge, title, and last-edited time. The list sorts by created time, recent
  edit, category, or title; a search box filters by title, note, or type;
  each row jumps the camera to its annotation, opens the editor, or deletes
  it. Hovering a row highlights the matching marker in the scene.
- Camera-state capture. An annotation can store the exact viewpoint it was
  created from — position, target, navigation mode, and field of view.
  Jumping to such an annotation restores the whole framing, not just the
  point; annotations without a stored view simply focus on the marked point.
- Inspection sessions. The session file now carries annotations and named
  saved views alongside measurements, so a complete review exports to a
  single JSON file and reopens with no loss. Older measurement-only session
  files still import unchanged.
- Screenshot export with overlays. A saved snapshot now burns in the placed
  measurements and annotations, so the PNG is usable as inspection evidence.
  A clean scan with neither still exports the bare render.
- A richer point inspector. Inspecting a LAS/LAZ point now also reports its
  return number and count, point source ID, and GPS time, plus the surface
  normal for clouds that carry one. Each row appears only when the data is
  present, and the Copy button includes the new fields.
- Keyboard shortcuts. `A`, `M`, and `I` toggle the Annotate, Measure, and
  Inspect tools; `V` saves the current view; `Delete` removes the selected
  annotation; `Ctrl/Cmd+Z` undoes an annotation change and `Shift` redoes it;
  `Esc` cancels the active tool; `?` opens the help overlay. Every shortcut is
  suppressed while a text field has focus.
- A help overlay. A compact reference card — opened from the dock's Help
  button or the `?` key — covering the tools, the annotation workflow,
  navigation, the keyboard shortcuts, and how work is saved.
- Undo and redo for annotations. A bounded history covers creating, editing,
  deleting, and clearing annotations; measurements are deliberately untouched.
- Live probe (desktop). A hover tool that shows a live readout of the point
  under the cursor with no click, while navigation stays fully interactive.
- Saved-view rename. Saved viewpoints can be renamed in place and keep their
  names through a session export and import.
- Mobile annotation support. Annotation placement, the editor, and the panel
  use touch-sized controls, and the panels span the width on phones.

### Changed

- The session file format advances to version 2 (additive — version 1 files
  still load). Saved views now carry a name.
- The LAS/LAZ load-memory estimate accounts for the new per-point inspection
  attributes, so the v0.2.7 memory guard keeps planning loads accurately.

## [0.2.7] - 2026-05-23

A performance and loading-optimization release. Dropped files reach the screen
faster, with a far lower memory peak on large surveys, a transparent staged
progress display, and the ability to cancel a load in flight.

### Added

- Header-only format detection. A small head slice is read first; the format
  is detected — and, for LAS/LAZ, the public header parsed — before the whole
  file is read into memory. An unsupported file now fails immediately instead
  of after a multi-gigabyte read.
- Budget-aware fast load. From the LAS/LAZ point count, a load plan is chosen:
  decode every point when within budget, decode-then-voxel-reduce at a moderate
  overshoot, or — when a cloud is far over budget — stride-decode it down to a
  memory-safe intermediate (a stratified, jittered one-in-N sample) and then
  voxel-downsample that to the budget. A huge survey is never fully
  materialised in memory, and because every over-budget path ends in the same
  voxel pass, the fast-loaded cloud keeps uniform density — no scan-line
  aliasing and no flight-strip density blocks.
- A preload summary. Between the drop and the decode, the toast shows what the
  file is — "LAS file detected", "18.2M source points", "Fast load mode
  enabled", "Target render budget: 4M points".
- Staged load progress. The status toast advances through named stages —
  detecting format, reading file, parsing metadata, decoding (with a live point
  counter and a progress bar), optimizing, preparing GPU buffers, rendering —
  in place of a single static line.
- Cancel loading. A Cancel control on the progress toast stops a load in
  flight, terminating the parse worker cleanly with no orphaned worker and no
  leaked memory.
- A memory-safety guard. Before a large allocation the load estimates the
  memory it will need; when that is risky for the device it automatically
  falls back to a sparser, stride-decoded load and says so, rather than
  risking an out-of-memory crash.
- Performance telemetry. With `?debug=1`, each load logs a per-stage timing
  table — read, decode, downsample, GPU upload, total — to the console.

### Changed

- LAS/LAZ decoding writes directly into local coordinate space. The render
  origin is computed from the header before decoding, so each record is
  converted straight into the final Float32 buffer — the intermediate Float64
  global array and the separate recentre pass are gone. Coordinate precision
  is bit-for-bit unchanged.
- One parse worker is now reused across loads, and the LAZ decoder's WASM
  module is instantiated once and reused — a second LAZ file skips decoder
  setup.
- Phones reach the stride-decode path sooner and at a tighter point budget.
- Point size now defaults to the smallest size in Fixed mode — the most
  honest first view of a cloud, with no distance-driven size gradient to read
  as banding on an oblique surface. Adaptive sizing and a larger size remain
  one tap away in the Rendering panel and are still remembered between
  sessions once chosen.

### Fixed

- Legacy LAS classification (point formats 0-5) is now masked to the low five
  bits. The synthetic / key-point / withheld flag bits in the classification
  byte are no longer mistaken for part of the class — which had produced wrong
  colours in classification mode and phantom classes in the Scan Report.
- A LAS header that declares more points than the file contains is clamped to
  what the file holds, instead of throwing partway through the decode.
- A file too small to contain a LAS header now reports a clear error instead
  of an opaque internal one.
- LAS and LAZ are distinguished by the compression bit in the file header, not
  the file extension alone, so a renamed file is decoded correctly.

## [0.2.6] - 2026-05-23

### Added

- Hover tooltips across the interface. Every tool-dock button, colour-mode and
  rendering control, navigation mode, measurement tool, panel action, and
  layer control now shows a short, plain-language hint on hover — explaining
  what it does and how to use it, written for a first-time user.
- Remember settings across sessions. Point size, the render-quality settings
  (Eye Dome Lighting on/off and strength, point-size mode, antialiasing), and
  the measurement unit system are saved to the browser and restored on the
  next visit. A saved Eye Dome Lighting choice overrides the backend default.
  Storage failures (private mode, blocked storage) fall back to defaults
  silently.

### Changed

- A loaded cloud's bounding box is computed once and cached, instead of being
  re-scanned several times per load (framing, the Scan Report, the project
  card) — less work when opening a large survey.

### Fixed

- Eye Dome Lighting no longer shimmers while orbiting. The camera's far clip
  plane was wide enough to leave the depth buffer imprecise, and EDL — which
  reads depth — picked that noise up as flicker. The far plane is now tighter,
  and EDL ignores depth differences below a small threshold, so only genuine
  edges are shaded.

## [0.2.5] - 2026-05-22

A rendering-quality release: depth cueing, distance-aware point sizing, and
softer points, with controls to tune them.

### Added

- Eye Dome Lighting — screen-space depth shading that traces every depth
  discontinuity, making point-cloud structure far more readable. It runs as a
  post-processing pass built from one node graph that targets both the WebGPU
  and WebGL 2 backends. On by default on desktop WebGPU; off by default on the
  WebGL 2 fallback and on mobile, where it can still be enabled by hand.
- Adaptive point sizing — points scale with camera distance, clamped so far
  points stay visible and near points do not bloat. A Fixed mode keeps the
  constant-size behaviour of earlier releases.
- Round, soft-edged points with point-edge antialiasing, replacing the hard
  square points — overlapping points now blend cleanly instead of stacking
  into visual noise.
- A Rendering section in the Scan Intelligence panel: an Eye Dome Lighting
  toggle and strength slider, an Adaptive / Fixed point-size switch, and an
  antialiasing toggle.

### Changed

- Rendering runs through a post-processing pipeline when Eye Dome Lighting is
  enabled; the direct render path is unchanged when it is off.
- The device-pixel-ratio is now capped at 2, bounding the render cost on
  high-density displays with no perceptible loss of sharpness.
- The live deployment build (`npm run build:live`) obfuscates the project's
  own application code, so the deployed site ships unreadable JavaScript; the
  default `npm run build` stays a plain, readable build. The readable source
  stays on GitHub, and a startup console message points there. Third-party
  libraries and the parse worker are left plain-minified.

## [0.2.0] - 2026-05-22

### Added

- E57 import — terrestrial laser-scanner data in the ASTM E2807 E57 format,
  read entirely in the browser by a from-scratch TypeScript parser. Decodes
  Cartesian coordinates, RGB colour, intensity, classification, and surface
  normals; applies each scan's pose; and merges multi-scan files into one
  cloud. Verified against Trimble scanner exports.
- Measurement toolkit — six tools replacing the single distance tool:
  distance, polyline, area, height, angle, and slope. The area tool reports
  both the true (own-plane) area and the horizontal map-projected area.
- Measurement editing — drag points to reposition them, undo the last point
  while placing, rename a measurement, and clear all.
- Measurements panel — a compact list of every placed measurement, with
  in-session persistence.
- Units toggle — one switch flips all measurement readouts between metric
  and imperial.
- Measurement sessions — export every measurement to a JSON session file
  and re-import it later.
- Surface-normal color mode — shades each point by its normal direction,
  available when a file (such as an E57) carries per-point normals.
- Close scan — a Close action in the tool dock clears the current scan and
  returns to the empty state, ready for another file to be opened.

### Changed

- The distance measurement from 0.1.0 is preserved as the toolkit's Distance
  tool, with no change to its behaviour.
- Capture provenance — source software — is now also read from E57 file
  headers and shown in the Scan Report.

## [0.1.0] - 2026-05-21

### Added

- Browser-based, local-first point-cloud viewer with drag-and-drop loading
- Import: LAS, LAZ, PLY, OBJ, GLB, GLTF, XYZ, CSV
- Export: PLY, OBJ, XYZ, CSV, and PNG snapshots
- WebGPU rendering with an automatic, fully tested WebGL 2 fallback
- Height, intensity, classification, and RGB color modes
- Orbit / Walk / Fly navigation with WASD movement and pointer-lock mouse-look
- Distance measurement inside the point cloud
- Point inspection — click a point to read its real-world coordinates,
  intensity, classification, colour, layer, and index, with one-click copy
  to the clipboard
- Scan Intelligence panel — point count, dimensions, density, spacing,
  detected attributes, and an Advanced report with the georeferenced
  bounding box and integrity diagnostics
- "Project ready" summary card shown on load
- Saved camera views
- Coordinate bridge for precise handling of large georeferenced coordinates
- Capture provenance — sensor, source software, and creation date read from
  the LAS/LAZ header and shown in the Scan Report when the file carries them
- Embed mode (`?embed=1`)
- Mobile browser support — a touch-friendly file picker, a Scan Info
  bottom sheet, touch-gesture navigation, safe-area layout, and a
  mobile-tuned point budget
- Documentation suite (`README`, `docs/`) and reference screenshots

### Changed

- Faster loading of large LAS/LAZ scans — a lighter voxel-downsample inner
  loop and a single-pass budget search cut parsing time substantially
