# Changelog

All notable changes to OpenLiDARViewer are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Planned (v0.3.3)

- Advanced image exports — heatmap, intensity, classification, depth.
  v0.3.2 ships the framework seam and the orthographic mode; the four
  remaining modes plug in here.
- EPT (Entwine Point Tile) streaming alongside COPC. v0.3.2 ships the
  `StreamingSource` interface; the EPT implementation plugs in here.
- SDK / embed-API hardening.

### Planned (later)

- 3D Tiles / PNTS streaming.
- Cross-section and profile measurement.
- Slicing and clipping tools.

See [`docs/roadmap.md`](docs/roadmap.md) for the full roadmap.

## [0.3.2] - 2026-05-26

The Visual Export Studio + research-grade georeference release. v0.3.2 ships
the platform-consolidation work originally scoped (incremental rescoring, the
StreamingSource interface, zero Three.js deprecation warnings), a four-mode
user-facing export studio (orthographic RGB, height map, intensity,
classification), CRS detection from LAS VLRs with bit-exact unit conversion,
and a documented coordinate-precision audit with extreme-magnitude tests.
Tests: 634 → 690 (+56).

### Added

- **Visual Export Studio (4 modes).** The Inspector now carries an "Image
  export" section with four buttons:
  - **Ortho RGB** — parallel-projected snapshot of the current view in the
    active colour mode.
  - **Height Map** — top-down ortho coloured by elevation (terrain /
    grayscale / heatmap / topo ramps; default terrain).
  - **Intensity** — top-down ortho coloured by LiDAR intensity. Gated on
    `adapter.hasIntensity()`; disabled with an explicit reason on clouds
    that lack the channel (no silent blank PNG).
  - **Class Map** — top-down ortho coloured by ASPRS classification.
    Gated on `adapter.hasClassification()`; same disabled-with-reason
    behaviour. Uses the runtime palette so the export and live view never
    drift.
  Each mode is a single PNG via `canvas.toBlob`. Resolutions are framed off
  the cloud's local AABB; transparent / background / annotation / measurement
  overlay options are plumbed through the new `CommonExportOptions` type
  surface (full UI controls land in v0.3.3 alongside depth + contour
  modes).
- **ExportRegistry + ExportPresets + ASPRS legend renderer.** A pure-data
  registry in `src/export/` with five curated presets (Terrain Review,
  QA Inspection, Classification Review, Technical Report, Intensity Scan)
  and a stand-alone `ExportLegendRenderer` for swatch + label rendering.
  The legend module ships the canonical ASPRS class labels so the runtime
  palette in `colorModes.ts` stays single-sourced for visual tuning while
  the spec-bound labels live with the Studio.
- **Incremental rescoring (stable-camera fast path).** The deferred
  Task 10 from v0.3.1. The scheduler caches its scheduling signature
  (frustum, camera position, depth cap, point budget, pressure-
  reduction); a tick whose signature is bit-equal to the previous tick
  reuses the prior `wanted` set and skips the rescore loop entirely.
  A periodic forced rescore every 60 ticks flushes any cached-state
  drift. `SchedulerStats` gains `fullRescoreCount` so the debug
  overlay and benchmark can see how often the full path runs.
- **StreamingSource interface.** A format-agnostic contract that
  `StreamingPointCloud` (COPC) now implements explicitly. The
  scheduler, renderer, picking path, and Viewer depend only on the
  interface; v0.3.3's EPT implementation will plug in without touching
  any of them. Adds `kind`, `readNodeChunk(record, signal)`, and
  `decodeMeta(record)` to the COPC class — the latter two replace the
  scheduler's previous direct reach into `cloud.source.readNodeChunk`
  and its hand-rolled decode-metadata construction.
- **Research-grade CRS detection** — new `src/io/crs.ts` parses both LAS
  CRS encodings: OGC WKT VLRs (LAS 1.4 default, record IDs 2111 / 2112)
  and GeoTIFF tag VLRs (LAS 1.0–1.3 fallback, record IDs 34735 / 36 / 37).
  Extracts CRS name, EPSG code, linear-unit code (metres / international
  foot / US survey foot), and the geographic-vs-projected flag.
  US-survey-foot scale is bit-exact (1200/3937 ≈ 0.30480060960121922).
  Threaded through `LasHeader`, `CopcHeaderInfo`, `CloudMetadata`, and the
  export adapter; surfaced in the scan-report card on every exported PNG
  as **CRS** + **Units** rows so an analyst reading the file later knows
  the datum the dimensions live in.
- **`toMetres(value, crs)`** — pure helper that converts a measurement
  from the source CRS's linear unit to true metres, so a "15.25 m"
  display reads as true 15.25 m regardless of whether the underlying
  scan was in metres, international feet, or US survey feet.
- **WYSIWYG export pipeline** — all four Studio modes now route through
  the existing `viewer.snapshot()` path so the export captures the exact
  on-screen view (perspective camera, EDL, framing). Measurement
  geometry, annotation markers, the active Inspect tool's selected-point
  marker + info card, and the LiveProbe's last-known readout all bake
  into the export by default. The probe uses last-known retention so the
  bake survives the "cursor leaves canvas to click Export" gap.
- **Scan-report card** drawn into the bottom-right of every exported PNG
  via the new `src/export/ScanReportRenderer.ts`. Rows: scan name, mode,
  total points, width × depth × height (km / m / cm formatted), density
  pts/m², capability summary (RGB / Intensity / Classification yes/no),
  CRS + units when known, footer with version + timestamp. Card sized to
  fit content, capped at 48% of canvas width; bumped 20% larger after
  live UX feedback to read clearly at full export resolution.
- **`docs/coordinate-precision.md`** — research-grade precision audit
  documenting the three coordinate spaces (file CRS / local render space
  / camera space), the load-bearing Float64-subtract-narrow-to-Float32
  contract, the inspection round-trip math, annotation persistence, and
  the limits where research-grade does NOT extend (no reprojection, no
  spherical geographic distance, no vertical-datum handling). Lists every
  invariant + the test that pins it.
- **`tests/copcDecodePrecision.test.ts`** + extended
  `tests/coordinatePrecision.test.ts` — 10 new tests pinning sub-mm
  precision at extreme magnitudes: real UTM 12N (4.1 M m), UTM 12S
  southern-hemisphere (9.5 M m), ECEF Earth-radius (6.37 M m), state-plane
  US survey feet, plus a regression test that fails if a refactor moves
  the Float32 narrow before the subtraction.
- **Inspect tool + LiveProbe baked into exports** — new
  `InspectTool.overlaySVG()` + `selectionForExport()` and
  `LiveProbe.activeProbeForExport()` (with last-known retention) feed the
  snapshot pipeline. Inspector's HTML "Point Info" card is redrawn onto
  the export canvas via `drawInspectorInfoCard` with the same X/Y/Z,
  distance, intensity, classification, RGB, and LAS-extras rows the live
  UI shows. LiveProbe gets the same treatment via `drawProbeReadoutCard`.
- **Pre-warm of heavy load chunks on app idle** — once the GPU backend
  is ready, `requestIdleCallback` (with `setTimeout(1500)` fallback) fires
  background fetches for `loadStreamingPointCloud`, `loadCopcWorkerClient`,
  and the static LAS/LAZ loader, so the first file-drop runs the parser
  without waiting for the ~200–500 ms of lazy-chunk download + parse.
- **Inspector "Image export" button group** — Studio modes available
  through the Scan Intelligence panel. Buttons start disabled with a
  "(load a scan first)" tooltip; enable when a static cloud is added OR a
  streaming COPC cloud attaches; disable again on full close.

### Changed

- **`Viewer.exportImage(mode, options)`** is now the entry point for all
  four Studio modes. The runtime forces the relevant colour mode for the
  duration of the render and restores it in `finally`, so a thrown export
  never leaves the UI mid-recoloured. Backed by a narrow
  `ExportSceneAdapter` interface so each exporter is unit-testable with a
  stub — no circular dependency on `Viewer.ts`.
- **Lazy chunk renamed** `loadImageExports` → `loadExportStudio`. A
  deprecated alias preserves the old name for one release.
- **Chunk-emission guard tracks `export`** (was `imageExports`). The
  required-chunks list still grows to 13 entries; the obfuscator-driven
  build still fails loudly if the Studio chunk disappears.
- **Three.js Clock → Timer.** Migrated `Viewer._clock` to
  `THREE.Timer` per Three's r170 deprecation. The render loop now
  calls `_timer.update()` before `_timer.getDelta()`; behaviour is
  identical, the deprecation warning is gone.
- **Three.js PostProcessing → RenderPipeline.** Same migration on the
  EDL post-processing surface — same API, renamed class. The second
  deprecation warning the v0.3.1 live console showed is also gone.
- **Head slice 4 KB → 16 KB** in both `loadFile.ts` and
  `copc/CopcSource.ts` so the first read captures more of the LAS VLR
  list (CRS detection needs the LASF_Projection VLR that sits after the
  public header). Local cost: microseconds. Remote cost: ~12 KB extra on
  first request — spares a likely second range request for VLR
  re-fetching, net saves ~100–200 ms on remote loads.
- **Measure line stroke widths bumped ~10%** in both the live CSS and
  the snapshot CSS so measurements read clearly against detailed scans
  without crowding the handle hit-zones (line 1.6 → 1.75; dot 1.5 →
  1.65; pending ring 2 → 2.2; area-fill 1.3 → 1.45; leader 1 → 1.1).
- **Dock reordered.** Frame · Snapshot · Measure · Inspect · Probe ·
  Annotate · Slice · Share · Help · Close — the work tools cluster
  first, meta tools (Share + Help) sit to their right, and Close anchors
  the far right with its own rose-tinted resting colour to set the
  destructive action apart from neutral tools.

### Fixed

- **Classification export silent-crash hardening.** A loaded cloud whose
  static-cloud entries lacked classification could crash the Studio's
  `setExportColorMode('classification')` mid-loop because the runtime's
  `colorForMode` throws when the channel is missing. The export adapter
  now wraps each per-cloud `setColorMode` in `try/catch`, and
  `withColorMode` puts the initial swap inside the `try` block so the
  `finally` always runs. Export errors are surfaced via a `window.alert`
  (toast replacement lands in v0.3.3) instead of failing silently to
  `console.error` only.

### Deferred

- The four Studio modes that v0.3.3 still owns: **depth**, **contour
  overlays**, **normal map**, **report snapshots**. The `ExportMode` type
  already has a `'depth'` slot reserved; the other three land via new
  factory registrations against the same registry.
- Compositing the classification legend **into** the exported PNG (rather
  than as a sidecar artifact). v0.3.2 renders the legend alongside the
  Studio panel; v0.3.3 composes it directly into the raster.
- Incremental rescoring's frame-budgeted N-per-tick partial rescore
  (the v0.3.1 plan's literal goal beyond the stable-camera win) is
  evaluated when the v0.3.2 benchmark on a 100 M+ fixture surfaces a
  case the stable-camera path misses. Today's bound shows the stable
  path captures the practical win on real-world camera usage.
- The 50-scan open/close leak audit and the WebGL2-forced streaming
  e2e (still from the v0.3.1 deferred list).

## [0.3.1] - 2026-05-26

A streaming-hardening release. v0.3.0 shipped COPC streaming; v0.3.1
re-grounds every part of that pipeline on measured invariants. Eviction is
now hierarchy-aware, the scheduler reads camera motion and budget
pressure, the remote path retries and times out gracefully, picking can
no longer reach a stale buffer, and the whole subsystem is exercised by
a stress harness. No new file formats, no breaking changes to sessions
or share links; everything that worked in v0.3.0 still works.

### Added

- **Streaming benchmark mode.** `?benchmark=1` on a COPC scan now emits
  per-session metrics — first-paint, time-to-coarse-stable, time-to-
  refined-stable, network and decoded byte totals, scheduler/decode/
  frame timing aggregates, peak resident points and bytes, cache hits/
  misses/evictions, thrash events, and session duration. The
  `?debug=1` overlay shows the live values plus a sliding scheduler-
  tick window.
- **Synthetic-COPC stress fixtures.** Deterministic generator for 1 M,
  10 M, 100 M, 250 M, and 500 M-point hierarchies used by the stress
  harness and the regression suite.
- **Eviction hysteresis with parent protection.** A resident node that
  leaves the wanted-set is held for a short window before its mesh is
  dropped, so a quick camera flick no longer thrashes through
  load → evict → reload. Parents of resident nodes are never evicted
  before their children.
- **Camera-motion awareness.** An EWMA-smoothed velocity signal halves
  the concurrent-decode budget under sustained motion and lowers the
  depth cap; settling back to full refinement takes 250 ms of stable
  camera, so a brief pause inside a longer pan doesn't pop in detail
  prematurely.
- **Hierarchy-aware eviction.** When multiple deferred nodes lapse
  together, the deepest-and-furthest evict first. A deferred node
  whose sibling is still wanted gets one extra window of grace, on
  the bet that the camera will pull the siblings together.
- **Compressed-cache hysteresis.** Evicted chunks get bumped to most-
  recently-used in the LRU at eviction time, so a quick return finds
  them warm and the re-decode skips the file read.
- **Three-tier memory metrics.** The overlay now distinguishes the
  compressed cache (LRU bytes + hits / misses / evict), the decoded
  layer (CPU-side bytes + cumulative uploads / evictions), and the
  GPU estimate.
- **Pressure adaptation.** When resident points exceed 90 % of the
  budget for ≥ 1 s, the scheduler lowers refinement by one depth
  level. When residency falls below 70 % for ≥ 2 s, refinement is
  restored. A 70 – 90 % hysteresis band prevents oscillation.
- **Resilient remote streaming.** Range reads now retry transient
  transport failures (network drops, 5xx, 408, 429) with exponential
  backoff and jitter, max three retries. Every request has a 20 s
  default timeout. 206 responses are validated against the requested
  `Content-Range`. When HEAD returns 4xx or omits `Content-Length`,
  the source falls back to a `Range: bytes=0-0` GET to discover the
  total size.
- **Remote-URL hygiene.** The `?copc=` entry rejects non-http(s)
  schemes, URLs over 2048 characters, and URLs with embedded
  `user:pass@` credentials. Every error message and log line runs
  through a sanitiser that strips userinfo.
- **Specific remote error UX.** Distinct messages for CORS-blocked
  hosts, hosts without range support, request timeouts, content
  mismatches, server-side errors, and malformed COPC files.
- **Resident-only picking.** The streaming pick path validates its
  mesh / decoded-chunk pairing on every call; any stale entry is
  pruned fail-closed before it can return a stale buffer.
- **"Still refining" inspector hint.** When the user picks a point on
  a node coarser than the deepest currently-resident one, the
  inspector card shows a small "Detail · still refining" row.
- **Node fade-in.** Each newly resident node fades from 50 % to 100 %
  opacity over 120 ms; off on mobile and on the low-tier device
  profile. EDL stays valid through the animation.
- **Device-profile tiers and runtime FPS adaptation.** A device-
  capability classifier resolves a low / medium / high tier from
  `deviceMemory` + `hardwareConcurrency`; the resolved profile
  carries the budget, the EDL default, and the fade-in flag. At
  runtime, sustained FPS under 24 for ≥ 3 s steps the tier down;
  sustained FPS over 50 for ≥ 10 s steps it up. A wide hysteresis
  band prevents oscillation.
- **Streaming stress harness.** A Node-runnable test drives the
  scheduler through a six-position camera orbit on a 1 M synthetic
  fixture, asserts the hardening invariants (bounded residency, zero
  thrash on a stable path, scheduler tick bounds), and emits the
  benchmark JSON. Larger tiers are opt-in via the
  `OPENLIDARVIEWER_STRESS_TIERS` env list.
- **Obfuscator chunk-emission guard.** The build fails loudly if any
  of the 12 required code-split chunks is missing from the obfuscated
  output, so a regression of the v0.3.0 lazy-import bug cannot recur.
- **Lazy diagnostics and exporter chunks.** The `?debug=1` /
  `?benchmark=1` overlay code and the PLY / OBJ / XYZ / CSV
  exporters are loaded only when actually needed, shaving weight off
  the initial bundle.
- **Coordinate-precision regression pin.** A unit test pins sub-2 mm
  f32 round-trip precision within ±10 km of the render origin;
  degradation past 100 km / 1000 km is documented.

### Changed

- **Documented priority weights** in `nodeScore`. `DEPTH_WEIGHT`,
  `SIZE_TERM_MAX`, `SIZE_TERM_SCALE` are now named, exported
  constants; the `SIZE_TERM_MAX = DEPTH_WEIGHT - 1` relationship
  enforces the coarse-first dominance invariant by definition.
- **Annotation type docs.** `Annotation.localPosition` is explicitly
  documented as a world-space anchor in the cloud's render frame;
  streaming refinement does not move existing annotations.

### Fixed

- **AbortSignal listener leak in `HttpRangeSource`.** Successful range
  reads now explicitly remove their `onAbort` listener from the
  caller's signal so a long-lived signal across many reads cannot
  accumulate listeners. In typical streaming use the caller's signal
  is per-decode and short-lived, so this had no production impact;
  the fix makes the API contract defensive against any future caller
  pattern.

### Deferred

- Incremental rescoring with a dirty queue and a frame-budgeted
  N-per-tick cap is moved to v0.3.2 — it needs a dedicated invariant-
  analysis session.
- The 50-scan open/close leak audit and the WebGL2-forced streaming
  e2e require live-browser verification; the static-audit pieces
  (lifecycle correctness in `removeStreamingMesh`, the abort-signal
  discipline test, the post-stop "no late `onNodeReady`" invariant)
  are in. The browser passes happen during release QA.

## [0.3.0] - 2026-05-25

A streaming-architecture release. OpenLiDARViewer gains real Cloud Optimized
Point Cloud (COPC) support: a `.copc.laz` file opens through progressive,
octree-based streaming — partial reads, a view-dependent scheduler, bounded
memory, and worker-based decoding — never a full-file load. Every existing
format and workflow is untouched.

### Added

- COPC streaming. A local `.copc.laz` file opens through a dedicated streaming
  pipeline: the COPC hierarchy is read with partial range reads, a coarse view
  renders almost immediately, and visible regions refine progressively as the
  camera moves. The point data is never read or decoded whole.
- A view-dependent scheduler. Each tick it frustum-culls the octree, scores
  nodes coarse-first by on-screen size and depth, loads what fits the point
  budget, evicts the rest, and cancels stale work — so streaming follows the
  camera and memory stays bounded.
- Worker-based LAZ chunk decoding. COPC node chunks are decompressed off the
  main thread by a dedicated worker (laz-perf's per-chunk decoder), so the UI
  never stalls on decode.
- A bounded streaming cache. A least-recently-used cache of compressed chunks,
  capped by a byte budget, lets a revisited region re-decode without re-reading
  the file — and never grows without limit.
- A streaming panel. While a COPC scan is open, a calm panel shows the load
  phase, a metadata scan summary (format, source point count, extent, spacing,
  octree depth), the live node and point counts, and the cache size — plus
  controls for colour mode, quality (Low / Balanced / High), pause/resume,
  clear cache, and saved camera views.
- Streaming diagnostics. The `?debug=1` overlay gains a streaming section —
  visible / queued / loading / resident nodes, displayed and source points,
  cache and GPU estimates, and scheduler time.
- Remote COPC streaming. A COPC scan hosted at a URL opens straight from the
  start screen's "open from URL" field, or via a shareable `?copc=<url>` deep
  link, and streams over HTTP range requests through the same pipeline as a
  local file. A HEAD probe up front checks the host can serve byte ranges, so
  a misconfigured server fails fast with a precise reason — CORS-blocked or
  unreachable, no range support, or a host that ignored the range — rather
  than a stalled load.

### Changed

- Streaming nodes render through the existing instanced-quad pipeline, so Eye
  Dome Lighting, the colour modes (RGB, height, intensity, classification),
  adaptive point sizing, and the WebGPU / WebGL2 backends all apply to a COPC
  scan exactly as to a static one.
- Lighter initial load. Each format decoder (LAS/LAZ, E57, PLY, OBJ/glTF, PCD,
  PTS/PTX) is now a separate, on-demand chunk — opening one format never
  fetches another's decoder or the laz-perf WASM it does not need. The whole
  COPC and streaming subsystem is likewise a lazy chunk, fetched only when a
  COPC scan is opened, so it no longer weighs on the initial app payload.
- Measurement, annotation, point inspection, and the live probe all work on a
  streaming COPC scan. Each resident node keeps its full decoded per-point
  attributes, so clicking a streaming point reports the same real-world
  coordinates, intensity, classification, return, GPS time, and point-source id
  as on a static scan.
- The decoded point colours of a static cloud are now produced through shared,
  range-explicit colour helpers — no behaviour change.

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
