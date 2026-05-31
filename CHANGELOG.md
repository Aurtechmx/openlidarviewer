# Changelog

All notable changes to OpenLiDARViewer are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.3.7] - 2026-05-30

Four work streams land in this release: new measurement and capture
features (cross-section, volume, classification editor, density
heatmap, box clipping), a mobile multi-touch recognizer, CRS detection
and persistence, and a graphics pass focused on depth readability over
photorealism. No breaking changes. v0.3.6 sessions, share links and
APIs keep working; the session schema bumps additively to v4.

### Added

- **Cross-section + height profile chart.** A new sampler walks the
  resident cloud along a profile line and stamps a height-vs-distance
  series onto the Profile measurement record. The Measurements panel
  renders the chart strip beneath the headline; NaN bins (no-coverage
  regions of the cloud) read as discontinuities rather than smooth
  interpolations.
- **Volume (cut / fill) measurement.** A new polygon-footprint
  measurement reports cubic metres above and below a reference plane,
  with a `density` field and a `confidence: 'high' | 'medium' | 'low'`
  badge driven by point-count thresholds.
- **Classification editor data layer.** Pure mutators for global class
  swaps and polygon-bounded reclassifications, with snapshot-based
  undo. New `viewer.swapClassification()`,
  `viewer.reclassifyInPolygon()`, and `viewer.undoClassification()`
  public APIs.
- **Density heatmap colour mode.** Voxel-grid points-per-m² hashed
  through a perceptual hot-cold ramp. Surfaces coverage gaps a global
  density figure on the Scan Report would otherwise hide.
- **3D Tiles / PNTS streaming foundation.** Pure-data tileset.json
  parser (region / box / sphere bounding volumes, refine, transform,
  content) and PNTS binary decoder (POSITION, POSITION_QUANTIZED,
  RGB, RGBA, NORMAL, RTC_CENTER) — the data layer the third streaming
  format will plug into alongside COPC and EPT.
- **Box measurement + clipping.** A 2-point axis-aligned box
  measurement with wireframe overlay and headline `W × D × H · volume`.
  Answers "what's the bounding extent of this feature?" directly.
- **Inspection presets.** Five one-tap modes — Survey · Terrain ·
  Foliage · Classification · QA — each bundling EDL strength, AO
  strength, elevation palette, point size, sky background, hillshade
  flag and the default colour mode. New `viewer.applyPreset(id)`
  public API.
- **Hillshade colour mode (data layer).** Cartographer's sun-direction
  Lambertian shading from a voxel-grid gradient. Composable with any
  elevation palette via the `bakeHillshadeIntoRgb` in-place modulator.
- **Local-density adaptive point sizing (data layer).** Per-point
  scale derived from a `√(refDensity / cellDensity)` curve, capped at
  configurable `[minScale, maxScale]`. Removes the "thin in periphery,
  blocky in centre" failure mode of fixed-size renders.
- **Palette editor catalogue.** Five built-in perceptual presets
  (Cividis, Viridis, Inferno, Turbo, Classic) with colourblind-safety
  flags and an in-memory registry for user-defined custom palettes
  (2..8 stops, monotonic-t validation, RGB clamps).
- **HDR sky / atmospheric backgrounds.** Five tone-mapped radial-
  gradient presets keyed by inspection mode. No GPU work, no extra
  draw call.
- **SSAO approximation (data layer).** A pure-data screen-space
  ambient-occlusion approximation from 8-neighbourhood depth
  differences. Stacks under the existing EDL pass — EDL shades edges,
  AO shades cavities.
- **CRS Phase C — high-level detection.** A new `detectCrs()`
  aggregator combines LAS / COPC / EPT VLR signals, STAC catalog
  EPSG hints, user overrides and default-format hints into a single
  resolved CRS with documented provenance, confidence ladder, and a
  `conflict` flag the Inspector surfaces when signals disagree.
- **CRS Phase E — session persistence.** Session schema bumps to v4
  (additive — v3 still imports). A `crs?: ResolvedCrs` field
  round-trips the resolved CRS through `serializeSession` /
  `parseSession`. Malformed records are dropped tolerantly so a
  partly-broken file still imports the rest.
- **Mobile touch model — twist + pinch + pan decomposition.** A new
  2-pointer gesture recogniser decomposes every frame into three
  orthogonal channels — `Δdistance / midDistance` (pinch), `Δangle`
  (twist), `Δcentroid` (pan) — each above its own dead-zone (3 % /
  4° / 6 px). Twist maps to yaw around world-up, matching the Maps /
  Procreate convention every mobile user already knows. The
  Inspector ships a `Touch twist` chip that opts out, persisted via
  the v0.3.7 prefs schema. End-to-end Playwright coverage included.

### Release e2e — final pass

- **`tests/e2e/heightTrim.spec.ts`** (3 tests) — the v0.3.7 height
  percentile-trim slider is wired into the Inspector. Verifies the
  slider hides on every mode except Height, defaults to 5 %, and the
  percentage label tracks the slider value across the input event
  range. Catches the regression where the chip click listener stops
  toggling `.olv-hidden` after a refactor.
- **`tests/e2e/photometricWitness.spec.ts`** (2 tests) — picking a
  cloud point with the Inspect tool surfaces the collapsible
  "Photometric witness" section. First test verifies the summary
  with the documented label is present; second test opens the
  `<details>`, confirms the patch canvas + the documented row labels
  (Scanner / Linear / Display / Coverage). The reconstruction maths
  is unit-tested in `tests/patchView.test.ts`; this spec is the
  live-DOM contract.

### Height colour mode — dramatic gradient pass

- **Default percentile tightened to 5 / 95.** The first percentile fix
  used the 2 / 98 band; field-only scans need more aggressive clipping
  to actually fill the colour ramp. New default trims 10 % of the
  range — outliers still clamp, but the 90 % of points an analyst
  cares about now spread across the full palette.
- **Default elevation palette switched from Cividis to Turbo.**
  Cividis is fully CVD-safe but its muted blue → grey → gold tones
  read as one "tan" colour on small elevation variations. Turbo
  (Google's perceptually-corrected spectral rainbow) gives an analyst
  the red → orange → yellow → green → blue gradient they actually
  expect from a topographic ramp. Cividis stays in the catalogue for
  colour-blind users.
- **Inspector slider for percentile trim.** A new "Trim outliers"
  row appears beneath the Color By chips when Height is the active
  mode. Slider 0 % → 25 %, default 5 %. 0 % uses true min / max (the
  old buggy behaviour); 25 % gives a very dramatic field gradient with
  trees / outliers clamping hard at the top colour. Recolours every
  static cloud in elevation mode in place — no re-decode, no re-upload.
- **`ColorForModeOptions` API.** `colorForMode(mode, cloud, opts?)`
  now takes an optional `heightPercentileTrim` so the renderer,
  exporter and report engine all read the same setting through one
  seam.

### Height colour mode — percentile clipping

- **Fixed the "everything looks pale blue" Height mode bug.** The
  previous min/max scan let a single tall outlier — a tree, a power
  line, a flag-mast — stretch the colour ramp so wide that 99 % of
  the field points squeezed into one colour stop. New
  `src/render/elevationRange.ts` computes a 2nd / 98th percentile-
  clipped Z range from a strided sample (cap 50 000), exposes both
  the clipped range and the true min / max for downstream UI. Matches
  what CloudCompare, Potree and Entwine viewers do.
- **Wired into both the static and streaming colour paths.**
  `colorModes.ts` calls the helper directly for static clouds.
  `StreamingRenderer.ts` reseeds its `minZ` / `maxZ` from the coarsest
  decoded node's percentile band — same pattern intensity already
  uses — and the range stays stable as subsequent nodes stream in,
  preventing colour-stop drift at node boundaries.

### Final visual polish

- **Photoreal RGB preset + one-click look.** New
  `src/render/photorealLook.ts` bundles the documented v0.3.7 default
  look — Photoreal RGB appearance (exposure 1.15, gamma 1.10,
  contrast 1.12, saturation 1.08) + Subtle EDL + Studio Dark sky.
  The bundle is a single readonly object the Inspector can apply with
  one call. New 8th preset added to `rgbAppearance.ts`.
- **Softer point edges.** Widened the existing TSL smoothstep from
  (0.42 → 0.50) to (0.30 → 0.50), and lowered `alphaTest` from 0.5 to
  0.18. The point centre brightness is unchanged so a pixel-accurate
  measurement still hits the same point, but the rim is visibly
  softer and sparkle on sparse regions is reduced. This is NOT
  splatting — it's a wider antialiased rim on the existing sprite.
  Works on both WebGPU and WebGL 2 because the TSL node compiles
  for both backends through the existing renderer.
- **Terrain auto-suggestion.** New
  `src/render/terrainSuggestion.ts` walks a strided sample of a
  cloud's classification histogram. When ASPRS class 2 (Ground)
  covers ≥ 35 %, or vegetation (classes 3-5) covers ≥ 25 %, the
  module returns `shouldSuggest: true` plus a reason. Buildings
  (class 6) ≥ 40 % vetoes the suggestion in favour of Infrastructure.
- **Snapshot supersampling 2× / 4×.** `Viewer.snapshot()` now accepts
  `supersample: 1 | 2 | 4`. At 2× and 4× the output canvas is sized
  `gl.width × factor` so the SVG overlays + scale bar + inspector
  cards all composite at higher resolution. The GL framebuffer
  itself isn't multisampled — this is a sharp print-ready upscale
  for hero PNGs.
- **Scale-bar overlay.** New `src/render/scaleBar.ts` —
  `computeScaleBar(pixelsPerMetre, maxPixels)` returns a 1-2-5
  "nice" step that fits the budget, with the matching label
  (`5 m`, `20 m`, `1 km`, `10 cm`). `pixelsPerMetreAt(fovY,
  canvasHeight, distanceToTarget)` derives the ratio from the camera
  state. `Viewer.snapshot({ scaleBar: true })` composites a
  black-bar + white-tip + outlined label in the bottom-left.

### Visual fidelity additions

- **White balance — temperature + tint.** `rgbAppearance.ts` extends
  with two optional fields: `temperature` (±25 % per-channel gain on
  the blue ↔ orange axis) and `tint` (±15 % per-channel gain on the
  green ↔ magenta axis). Both clamped to [-1, +1], pivot-axis sliders
  in the colour-grading idiom, defaults to 0 / 0 for back-compat.
- **RGB auto-normalise.** New `src/render/rgbAutoNormalize.ts` walks a
  histogram of the cloud's sRGB Uint8 colours, classifies it as
  healthy / underexposed / overexposed / low-contrast / washed-out,
  and returns a recommended `RgbAppearance` bundle the analyst can
  apply with one click. Non-destructive, transparent (returns the
  diagnostic that drove the suggestion), gentle (clamps the
  corrections so a healthy scan barely moves).
- **Three new scan-context RGB presets:**
  - **Drone RGB** — aerial mapping defaults. Gentle warmth corrects
    high-altitude blue cast, mild contrast lift, clarified shadows.
  - **Mobile LiDAR** — iPhone / SLAM indoor scans. Stronger exposure
    compensates for low-light capture; gentler gamma rescues
    underexposed midtones.
  - **Infrastructure** — buildings, towers, utilities. Strong contrast
    surfaces edges; neutral white balance keeps brick / concrete tones
    accurate.
- **EDL preset bundles.** New `src/render/edlPresets.ts` — Subtle /
  Balanced / Inspection. Bundles strength + radius + an opt-in for
  adaptive scaling. Inspection opts out so the analyst gets full depth
  response regardless of zoom.

### Photometric witness

- **Per-point patch view in the inspector.** Picking a point inside
  Inspect mode now surfaces a 64 × 64 px photometric witness — a
  tangent-plane reconstruction of the cloud's captured colour at and
  around the picked point. The reconstruction:
  - Finds the K nearest neighbours via a max-heap KNN (no spatial
    index dependency; pure leaf module).
  - Computes the tangent plane via PCA power-iteration on the
    neighbour offsets, deflating the largest eigenvector to find the
    second.
  - Splats every neighbour through a soft quadratic-falloff disc into
    a Float32 accumulator, then resolves through the sRGB EOTF for
    the final RGBA8 pixels.
  - Auto-sizes the (u, v) extent from the 90th-percentile neighbour
    distance so the patch fills itself without wasting pixels on
    distant outliers.
- **Colour provenance values block.** Below the patch, the inspector
  shows three rows — Scanner (the bytes the publisher committed to
  disk), Linear (the renderer's working values via the piecewise sRGB
  EOTF), and Display (the round-trip back to sRGB). Lets the analyst
  defend a map export by reading exactly what colour the scanner
  captured at any clicked point.
- **Pure-data architecture.** `src/render/patchView.ts` and
  `src/render/colorProvenance.ts` ship as leaf modules with no DOM
  and no three.js dependency. The inspector wires them through a
  patch-provider callback (same pattern as the profile + volume
  samplers) so both static clouds and streaming resident sets feed
  the same reconstruction path.
- **Map-export integration deferred to v0.3.8.** The data layer is
  ready and the inspector card already renders the patch + values to
  a `<canvas>` element. Threading the patch into the PDF report
  templates + PNG export pipeline is queued as the v0.3.8 work item.

### Colour fidelity

- **Removed ACES Filmic tone-mapping from the renderer.** ACES was
  designed for HDR cinema content — it deliberately rolls off
  highlights and desaturates near-white values. Applied to LDR
  point-cloud RGB, which the scanner captured in display-referred
  space, that roll-off read as pale, washed-out colour. Switched to
  `THREE.NoToneMapping` with exposure 1.0 so the renderer passes
  scanner-captured RGB straight through. A brown roof reads brown,
  grass reads green — what the analyst expects from RGB mode.
- **Linearised vertex-colour upload in `toFloatColors`.** Our TSL
  pipeline plumbs the colour attribute straight to the colour node,
  which bypasses three.js's automatic sRGB → linear conversion that
  `vertexColors: true` would normally apply. With
  `outputColorSpace = SRGBColorSpace` the renderer encodes
  linear → sRGB at output, so passing already-sRGB values through
  the linear path means three.js re-encoded a second time — washed
  saturation, brightened midtones. The loader now applies the
  piecewise sRGB EOTF (IEC 61966-2-1, matches `Color.SRGBToLinear`)
  so the renderer receives true linear light and sRGB-encodes once.
  Net round-trip: scanner sRGB in → display sRGB out, faithful.

### Release polish

- **Four additional sky presets** — Studio Dark (flat #0B0F14 for
  hero-shot backdrops), Blueprint (deep navy with a drafting-table
  highlight), Survey Light (warm off-white for daylight inspection),
  and Terrain (subtle atmospheric gradient for elevation work). All
  four extend `src/render/skyPresets.ts` alongside the original five
  inspection-mode skies and follow the same `getSkyDefinition()` seam.
- **RGB appearance controls (data layer).** A new pure-data RGB
  modulator — `applyRgbAppearance(rgb, settings)` — applies exposure,
  contrast, saturation, and gamma to a normalised RGB Float32Array in
  the pipeline order each transform mathematically expects (exposure →
  contrast → saturation → gamma → final clamp). NaN-safe, identity
  fast-path, every channel clamped to [0, 1] at every step. Ships
  with four named presets — Natural (identity), Survey (gentle
  daylight lift), RGB Inspection (punchy contrast + saturation for
  material differentiation), High Contrast (wide tonal spread for
  low-light scans). Composable with hillshade and SSAO under the same
  per-chunk decode seam.
- **Streaming coverage transparency on profile + volume measurements.**
  When the cloud is still streaming, the Measurements panel surfaces
  a "Resident-node analysis only — may refine as streaming loads"
  caption beneath profile charts and volume readouts, so the analyst
  understands the displayed value is computed against the points
  currently resident in memory and can refine as additional nodes
  stream in. The caption fades in over 200 ms ease-out (opacity-only,
  no layout shift) and honours `prefers-reduced-motion`.
- **Chunk-isolation hardening.** Sharpened `vite.config.ts`
  documentation on why `vendor-three-webgpu` (~800 KB post-min) is
  the one chunk that legitimately breaches the Vite warning threshold
  — Three.js's WebGPU/TSL runtime is unavoidably heavy — and added
  the report subsystem to the in-build shell-leak guard
  (`ReportPdfRenderer`, `ReportComposer`, `report/templates/`).
  Added a post-build `tests/chunkIsolation.test.ts` that asserts the
  contract from the outside: every required code-split chunk is
  emitted, `vendor-three-webgpu` is the only chunk over the 500 KB
  threshold, and the startup shell carries no inlined pdf-lib /
  laz-perf / WebGPU renderer / TSL runtime. Two guards, one contract.
- **e2e coverage for the v0.3.7 measurement picker + streaming
  caveat.** `tests/e2e/measurePicker.spec.ts` iterates every kind
  (Distance, Polyline, Area, Height, Angle, Slope, Profile, Volume,
  Box) and asserts each becomes active when clicked — catches the
  regression where a kind is rendered but its click handler is wired
  to a stale enum. `tests/e2e/streamingCaveat.spec.ts` opens the
  autzen COPC fixture, places a Profile measurement, and verifies
  `.olv-mp-chart-caveat` appears with the documented
  "Resident-node analysis only" copy. The caveat spec auto-skips
  when the autzen fixture is absent (same pattern as the existing
  streaming e2e); locks the behaviour the previous polish pass added.

### Tests + verification

- 1482 unit tests passing across 119 files (18 skipped, up from 1216 /
  95 in v0.3.6), including new analytical-fixture coverage for the
  volume estimator (10 × 10 × 1 m cube → 100 m³, 20 × 20 × 2 m plateau
  → 800 m³, symmetric half-fill / half-cut → net 0, pure cut basin →
  50 m³), the cross-section sampler (flat plane, linear ramp at
  slope 1.0, sharp step, diagonal axis orientation, gap detection),
  the release-polish sky catalogue (Studio Dark, Blueprint, Survey
  Light, Terrain), the new RGB appearance modulator (identity
  fast-path, exposure, contrast, saturation, gamma, NaN guard, [0, 1]
  clamp, preset registry), and a post-build chunk-isolation contract
  (vendor-three-webgpu is the only chunk over the 500 KB warning;
  the startup shell carries no inlined pdf-lib / laz-perf / WebGPU
  renderer / TSL runtime; every required code-split chunk is emitted).
  Full Playwright e2e suite runs locally before each release.
  Typecheck clean. Lint clean. Smoke + build gates green.

### Documentation

- **`docs/quality-control.md`** Gate 6 — the full Playwright e2e suite
  is mandatory before exporting a deployable version. New stability
  rules for e2e specs (drop fixtures, assert on count not visibility,
  match overlay text by stable substrings).
- **`docs/supported-formats.md`** 3D Tiles / PNTS clarified as an
  experimental data-layer foundation — groundwork for future support,
  not yet user-facing.

### Known limitations (v0.3.7)

- **3D Tiles / PNTS.** The data-layer foundation ships — tileset.json
  parser, PNTS binary decoder — but the user-facing streaming path is
  not enabled. Drop a `.pnts` file or a `tileset.json` URL today and
  the viewer will not open it. Treat the format as planned, not shipped.
- **Streaming analysis (cross-section, volume).** When the cloud is
  still streaming, measurements operate over the resident-node subset.
  The Measurements panel surfaces a "Resident-node analysis only —
  may refine as streaming loads" caption beneath the profile chart so
  the analyst understands the value can refine as more nodes arrive.
- **WebGPU.** Best-effort: WebGPU runs when the browser + hardware
  combination supports it. Otherwise the viewer falls back to the
  WebGL 2 renderer with no feature loss — every Stream A graphics
  capability works under both backends.

## [0.3.6] - 2026-05-28

The "public data + quality intelligence" release. Five user-visible
additions land alongside the most important architectural change of
the v0.3.x cycle: a contract'd analysis seam that the next release's
in-browser sampling features build on. Every addition keeps the
local-first guarantee — nothing is uploaded, nothing leaves the
device, no API key required. No breaking changes — v0.3.5 sessions,
share links, and APIs continue to work.

### Added

- **Verified public LiDAR dataset picker.** A new empty-state panel
  surfaces a curated dropdown of public LiDAR datasets — every URL was
  probed at release time and routes through the existing EPT / COPC
  streaming pipeline on click. v0.3.6 ships 18 entries: visually
  distinctive COPC files (Autzen Stadium, Sofia, Cahokia Mounds,
  Francis Scott Key Bridge, Puerto Rico FEMA recovery) and large EPT
  datasets from the USGS public LiDAR bucket (San Francisco, Los
  Angeles, Denver Metro DRCOG, Grand Canyon National Park). Each
  option shows file size or point count inline so users can pick by
  network budget. No API key, no proxy, no geocoder request, no
  upload. The `?notelemetry=1` flag suppresses the panel. For
  arbitrary datasets, users paste their own COPC / EPT URL into the
  dedicated URL field above the picker.
  See [`docs/public-lidar-catalog.md`](docs/public-lidar-catalog.md).
- **Scan Acceptance report template.** A sixth report template, sitting
  alongside the existing five, renders a pass/fail checklist over
  caller-supplied thresholds (point count, CRS declared, classification
  present, NPS, density, etc.) plus a Methods appendix that cites the
  literature behind each metric. The thresholds are user-supplied —
  v0.3.6 deliberately does NOT bake QL1/QL2 limits into the template,
  since those are airborne-survey acceptance values that don't
  generalise to mobile or terrestrial scans.
- **Provenance fingerprint.** The Inspector gains a "Provenance" section
  that classifies an open scan into one of seven capture types
  (iPhone LiDAR, drone LiDAR, terrestrial, mobile SLAM, aerial ALS,
  spaceborne, unknown) using a layered decision order — software
  string > sensor string > format-derived > numeric heuristics — and
  pairs each verdict with an expected-accuracy envelope drawn from
  the published literature (Luetzenburg 2021, Krausková 2025, Tondo
  2023, Jiang 2025, Bolcek 2025, Lohani & Ghosh 2017, Ruzgienė 2025,
  Fareed 2026). The accuracy figures are documented as "expected
  ranges from the cited literature, not guarantees", and a manual
  override is available for the user to correct the classifier.
- **Local-first usage counters.** A new in-browser session-stats
  panel surfaces categorical event counts (scans opened, measurements
  taken, exports, reports, errors) collected entirely in
  `localStorage`. No telemetry leaves the device. The `?notelemetry=1`
  URL flag suppresses every increment structurally; the counter
  storage has an LRU cap of 200 entries with a sanitised subcategory
  key.
- **Analysis architecture seam.** A pure-data `PointSampler` interface
  (`src/analysis/PointSampler.ts`) becomes the contract every future
  analysis module reads through. `docs/analysis-architecture.md`
  defines the five contracts (Determinism, Abortable, Non-mutating,
  Coverage semantics, Budget honesty) and 18 skipped contract tests
  in `tests/analysisSeamContract.test.ts` pin the shape so future
  sampler implementations have something concrete to satisfy.

### Improved

- **PDF report sanitisation.** Every user-supplied string passed to
  pdf-lib is now sanitised against the WinAnsi-only repertoire of
  Helvetica before drawing — including a per-section em-dash, ellipsis,
  smart-quote, degree-sign, and `²`/`³` mapping plus a fallback `?`
  substitution for anything outside Basic Latin / Latin-1 Supplement
  printable. The fix closes a silent failure where a single em-dash
  in a measurement value (which `ReportMeasurementSection` itself
  emits for degenerate measurements) caused the host section to
  disappear from the rendered PDF. `ReportResult.failedSections`
  now surfaces the affected section ids so the caller can show a
  toast when the PDF shipped without one of its sections.
- **EPT zstandard rejected at detect time.** A zstandard-encoded EPT
  dataset previously passed `parseEptMetadata`, paid the full
  manifest + hierarchy round-trip (often hundreds of HTTP
  requests), then failed once per tile at decode time. The detect
  step now rejects with an actionable message pointing the user to
  re-encode with Entwine's laszip output.
- **Streaming benchmark long-session discipline.** The per-sample
  buffers switch from `Array.shift()` (O(n)) to a constant-time
  ring buffer (`RingSamples`), and the eviction-history map now
  sweeps stale entries (older than the thrash window) once it
  passes 512 entries — closing a long-session memory leak where a
  pan across a large dataset accumulated map entries that could
  never produce a thrash event.
- **EPT depth cap.** A hard cap of depth 24 protects the octree from
  pathological or malicious manifests where the `x >> 1` parent-key
  arithmetic would wrap into negative space at depth 31. Practical
  Entwine output rarely exceeds depth ~20.
- **EPT truncated tile is retryable.** A short binary tile now throws
  a typed `EptTruncatedTileError` (rather than a plain `Error`) so
  the scheduler can distinguish "transport problem — retry" from
  "schema problem — permanent fail" and re-queue the node.
- **Benchmark output discloses budget-capped loads.** The
  `?benchmark=1` console block now prints `"4,000,000 of 100,000,000
  (4.0%)"` when the device-aware budget downsampled the source. A
  budget-capped load no longer reads identically to a full one.
- **Coarse-stable benchmark gate.** The streaming benchmark's
  "coarse stable" marker now requires at least one resident node at
  depth ≥ 2 in addition to the scheduler-idle condition, so a slow
  link reaching idle at depth 0 (root only) doesn't fire the marker
  as if the coarse view were ready.
- **GPU init failure surfaces.** `Viewer.ready` now has an explicit
  `.catch` that logs the GPU init failure to the console — previously
  a rejection on both WebGPU and WebGL 2 left the canvas blank with
  no signal as to why.
- **WebGPU → WebGL 2 fallback is named.** When the browser advertises
  WebGPU but the renderer settled on the WebGL 2 fallback, a one-shot
  `console.info` message states what happened so a user who expected
  WebGPU performance can see why their FPS is lower. The activated
  fallback is also recorded as `error:webgpu-fallback` in the local
  usage counters.

### Fixed

- **Mobile-collapsible side panels.** StreamingPanel, MeasurePanel,
  and AnnotationPanel now each carry a chevron toggle in their head
  row that's hidden on desktop and shown on phones. Tap the chevron
  (or the title strip) to roll the panel up to its head — the rest of
  the body disappears so the user can reclaim canvas with one tap.
  The Inspector keeps its existing bottom-sheet dismiss; the new
  pattern complements it for the three lighter side panels. CSS-only
  collapse mechanism (~50 lines of media query), zero JS in the
  collapse path beyond the toggle handler. `prefers-reduced-motion`
  honoured implicitly — the rotate is a 220 ms transform.
- **Axis-feel root-cause fix.** Earlier passes dialed damping +
  rotate-speed but the real cause of "weird axis" was that the orbit-
  centre maintenance loop moved `controls.target` without translating
  the camera position by the same vector. OrbitControls reinterprets
  its spherical state around the new target every frame, so a sliding
  target manifests as the camera "rotating around a weird axis." Fix:
  every programmatic `controls.target` update now applies the same Δ
  to `camera.position` (new `_translateOrbit` helper). What the user
  sees is the scene sliding back into view smoothly — no axis spin.
- **Planetary Computer STAC search (borrowed from
  `opengeos/maplibre-gl-usgs-lidar`).** New lazy-loaded
  `src/io/catalog/planetaryComputer.ts` queries Microsoft Planetary
  Computer's public `3dep-lidar-copc` STAC endpoint by lat/lon. Surfaces
  as a "Search by location" disclosure below the curated dropdown so
  the curated-only path stays free of network cost. Each result renders
  with source format, EPSG, capture date, and bbox. No basemap
  dependency, no MapLibre — borrows only the search pattern. Public,
  unauthenticated endpoint; `?notelemetry=1` suppresses the surface.
- **EPSG short-circuit on PC items.** When a result carries a
  `proj:epsg` STAC property, the EPSG is written into the CRS override
  store *before* dispatch — the streaming pipeline reads the override
  first and skips the LAS VLR probe, cutting ~500-700 ms off CRS
  resolution for PC-sourced streams.
- **Source format already surfaced.** The Streaming Intelligence panel
  already shipped a "COPC LAZ · PDRF N" vs. "EPT · binary · N attrs"
  format line per the audit; this release verifies the contract is
  intact across the PC dispatch path (PC items are always COPC; the
  `source: 'copc' | 'ept'` field on the STAC client output is the
  forward-looking shape).
- **Mobile empty-state design audit + error-UX overhaul.** Tool dock
  now hides entirely while no scan is loaded (was showing eight dimmed
  tools on mobile, which competed with the primary CTA and pushed the
  catalog dropdown off-screen). The empty state collapses to two
  sections — *Quick demos* (samples + curated catalog) and *Open from
  URL* — with a quiet caption clarifying that catalog entries were
  probed at release time. Format list is now a one-line tap-to-expand
  ("Supports 10 formats including .las, .laz, .ply") instead of a wall
  of 10 extensions. Hero clamps to 40 px on viewports < 480 px so the
  CTA fits in-fold without scroll. Mobile copy variant drops the
  "drag onto the page" instruction (iOS Safari has no DnD) and leads
  with "Pick a point-cloud file from your device." The GitHub link
  demotes from a filled pill to a ghost link so the "Private · on
  your device" trust pill stays the dominant header element. URL
  field gains constraint bullets above the input ("File must be in
  COPC format" / "Server must allow CORS range requests") and an
  idle pulse on the primary CTA fires twice at 4 s of inactivity,
  then never again. Honours `prefers-reduced-motion`. Error-UX hierarchy:
  the URL field inline-validates on blur (warning when the URL
  doesn't look like COPC, soft so the user can still try), preserves
  input on error, swaps the Open button into a Cancel + spinner
  during in-flight loads, surfaces a Retry banner with the failed
  URL after failure, hides the URL row when offline (driven by
  `window.online`/`offline` events), and maps raw CORS / fetch / 404
  / 403 errors to plain-English guidance ("This file's host blocks
  browser access — try downloading and using Open scan from device").
  A cellular-data confirmation gates large samples ≥ 250 MB when
  `navigator.connection.type === 'cellular'`, and a mobile-memory
  warning gates files ≥ 1.2 GB on phones so a 2 GB LAZ doesn't
  silently OOM the tab.
- **Camera smoothness — model-viewer feel.** OrbitControls damping
  factor lowered 0.08 → 0.05 and rotate speed bumped 0.85 → 1.0 so
  the active drag stays responsive while the release glide coasts a
  few extra frames — the cadence Google's `<model-viewer>` ships by
  default. Per-frame orbit-pivot maintenance now suspends itself
  while the user is actively driving OrbitControls (subscribed via
  the controls' 'start'/'end' events) so no lerp or soft-clamp
  competes with live mouse input. The soft-clamp gentles a drifted
  target back into the envelope via a 12-%-per-frame lerp instead of
  snapping — produces a smooth pull-back rather than a one-frame
  correction artefact. Programmatic tween defaults bumped 0.6 →
  0.8 s (`tweenTo`) and 0.7 → 0.9 s (`frameAll`) so the cubic ease
  has room to feel as acceleration rather than a jump.
- **New camera APIs — `viewer.zoom(delta)` and `viewer.getOrbit()`.**
  Mirrors `<model-viewer>`'s identically named methods. `zoom(delta)`
  advances the dolly by wheel-tick units (positive = closer, negative
  = farther), respecting `minDistance` / `maxDistance` bounds.
  `getOrbit()` returns the camera's spherical pose around the orbit
  target as `{ theta, phi, radius, target }` with theta/phi in
  radians — the same compact 4-number encoding `<model-viewer>` uses
  in its `camera-orbit` attribute.
- **Orbit pose round-trips through share links at UTM scale.** Existing
  share-link encoding already carries `camera.target` (the new orbit
  pivot) alongside position, mode, and FOV; v0.3.6 adds a regression
  test that pins the precision contract — a target at
  `(637 600 m, 852 000 m, 160 m)` (Autzen public COPC, UTM 10N)
  round-trips byte-for-byte through encode → decode, so a research
  screenshot's share link drops into a paper without quiet
  coordinate drift.
- **Camera orbit centered on the cloud's volumetric centre.**
  Previously the orbit pivot was the dataset's coordinate origin, so
  large translated LAS / LAZ surveys (UTM eastings in the millions)
  felt visibly off-axis until the user pressed `R`. The Viewer now
  snaps `controls.target` to the visible cloud's AABB centre the
  instant a cloud attaches — both static and streaming — so the very
  first drag orbits around the scan rather than the origin. A soft
  clamp keeps the target inside the cloud's AABB inflated by 25 % of
  its diagonal, so a user-driven pan can drift slightly past the
  edge for inspection without ever orbiting around empty space.
  Streaming refinement glides the pivot toward the latest bounds
  centre at 5 % per frame, never snapping when a new octree node
  finishes decoding. Original world coordinates are preserved end-
  to-end for measurements, exports, and CRS workflows. New API:
  `viewer.orbitTarget()` and `viewer.cloudCenter()` for diagnostics.
- **USGS catalog robustness.** Two latent failure modes in the new
  catalog provider, fixed before release: (1) TNM Products API
  sometimes returns `boundingBox.minX` as a quoted string rather
  than a JSON number; the parser now coerces both forms instead of
  silently dropping the tile and surfacing "no coverage" for real
  coverage. (2) The `bboxIntersects` check is now edge-inclusive so
  a tile whose `maxX` equals the query's `minX` is no longer
  silently rejected at a tile seam.

### Tests + verification

- 971 tests across 84 files (up from 869 / 77 in v0.3.5), plus 18
  skipped contract tests in `tests/analysisSeamContract.test.ts` that
  pin the future sampler shape. Typecheck clean, lint clean, smoke
  gate green.

### Documentation

- **`docs/public-lidar-catalog.md`** — new doc covering the v0.3.6
  catalog seam, the USGS 3DEP provider, the privacy contract, and how
  to add a new provider.
- **`docs/analysis-architecture.md`** — new doc defining the five
  analysis-seam contracts and the planned sampler sequence.

## [0.3.5] - 2026-05-28

A reliability + visibility patch on top of v0.3.4. New blocking CI gates close the gap that allowed the v0.3.4 startup regression through, the measurement toolkit gains a Profile / cross-section kind, and the Studio's broken Depth / Contour buttons are pulled back until they can be implemented correctly. No breaking changes — v0.3.4 sessions, share links, and APIs continue to work.

### Added

- **Profile / cross-section measurement.** A new `'profile'` `MeasurementKind` joins the toolkit's seven-kind picker. Drop two points and read off the full geometry of the line in one card: 3D length, horizontal distance, vertical drop, and grade percent. The overlay renders the 3D segment as the solid headline with an L-bent run/drop ghost (the same idiom the slope tool uses), so users move fluently between the two. A future release will sample point-cloud heights along the line and persist a height-vs-distance chart inside the measurement record; the kind, picker entry, and session schema are stable in v0.3.5 so the chart layer drops in without churn.
- **Startup smoke gate (CI).** `tests/e2e/smoke.spec.ts` loads `/` and `/?debug=1` against the production build and asserts zero `pageerror` and zero `console.error` events during the first three seconds. The job is wired as a blocking gate in `.github/workflows/ci.yml` alongside `build-and-test`; the broader e2e suite remains advisory.
- **Main-deferral lint rule (CI).** `scripts/lint-main-deferral.mjs` fails the build if `src/main.ts` ever re-introduces a top-level `viewer.*` dereference outside a `viewerLoaded.then(...)` block — the precise regression class that broke v0.3.4 at startup. Permitted patterns (declarations, type annotations, imports) are explicitly listed; the rule has a regression test and a clear remediation message.
- **Real Entwine reference fixture.** A committed `tests/fixtures/ept/tiny/ept.json` + matching hierarchy file in the byte-for-byte format Entwine produces. `tests/eptRealFixture.test.ts` (10 assertions) exercises `detectEptUrl` + `parseEptMetadata` against the literal file, so future drift from the EPT 1.0 spec surfaces here rather than in production.
- **PDF report end-to-end smoke render.** `tests/reportPdfSmoke.test.ts` (10 assertions) drives `renderReportPdf` against every shipped template and every theme, then re-parses the resulting bytes through `pdf-lib`'s loader to validate page count, title, author, and creator-string round-trip. The contract tests stop at the section builders; this spec covers the rendered PDF.

### Removed

- **Depth Map and Contour Map exporters.** Their v0.3.3 implementations produced an elevation raster — the same output as Height Map — without true camera-relative depth-buffer extraction or marching-squares contour-line drawing. The mismatch between the button labels and the actual output was a credibility hit, so both modes are unregistered from the default `ExportRegistry` and removed from the Inspector's image-export grid. The source files (`DepthMapExporter.ts`, `ContourMapExporter.ts`) and the type / preset slots remain so the proper implementations can land incrementally in a future release.

### Improved

- **PDF report export hardened.** Several defensive layers added around the report engine so a pathological input or a corrupt asset can no longer lock the tab or kill the whole render. (1) `generateReport` now enforces upper bounds on annotation count (2 000), measurement count (2 000), visual count (32), dataset row count (200), and technical-notes character length (200 000); each violation throws a precise, user-readable message that names the cap. (2) The render is wrapped in a 30 s timeout race — runaway pdf-lib work can no longer hang the page. (3) An optional `AbortSignal` parameter lets the caller cancel mid-render (the rejection settles immediately even if pdf-lib itself can't be interrupted). (4) The renderer now isolates each section in its own `try`/`catch` — a corrupt visual blob or a malformed annotation row is skipped with a console warning rather than aborting the whole report, so the user still gets a partial PDF instead of nothing. (5) The image-export and report-export failure paths in `main.ts` now surface errors through the shared toast UI (`dropZone.setError`) instead of the modal `window.alert` that blocked the page. Seven new contract tests in `tests/reportPdfSmoke.test.ts` cover the bounds, the abort signal, and the corrupt-visual isolation path.

### Fixed

- **Critical — image exports all captured the same frame.** The Visual Export Studio's per-mode color-mode swap (Height Map → elevation, Intensity → intensity, Class Map → classification, Normal Map → normal) is applied by marking the cloud's color attribute `needsUpdate = true` so the renderer re-uploads the new buffer on the next render. The snapshot pipeline called `renderer.render(...)` then `canvas.toBlob(...)` in immediate succession — but on the WebGPU backend the render call only queues GPU work; the new color buffer wasn't on the canvas yet when `toBlob` read from it. The result was every export mode producing whatever frame was on screen *before* the swap, with only the scan-report metadata card differing between outputs. Fixed by changing `Viewer.snapshot()` to a double `renderAndPresent` pattern: render → `requestAnimationFrame` (present cycle) → render → present, *then* read the canvas. Adds ~33 ms to a snapshot — negligible against an export action that already runs in the hundreds of milliseconds.
- **Hotfix — v0.3.4 startup regression.** v0.3.4 shipped with a Phase 1 Viewer-deferral regression: eight `viewer.*` statements at module top level in `src/main.ts` threw `TypeError: Cannot read properties of null` because `viewer` was the lazy-load sentinel until the chunk resolved. The page never moved past its first frame. Fixed by wrapping listener wiring + overlay-element appending inside `void viewerLoaded.then(...)`; guarding `streamingDebugSample()` with a `viewerReady` check so the debug overlay's 4 Hz poll doesn't crash before the Viewer is up; inlining the EPT URL-pattern check in `handleRemoteUrl` so a `loadEpt()` failure doesn't swallow the error toast on a malformed URL; and validating remote-COPC / remote-EPT URLs before awaiting `viewerLoaded` so a bad URL surfaces a toast even when the Viewer chunk can't load. The new smoke gate + lint rule prevent re-introduction.
- **Image-export bar overflow.** Seven image-export buttons in a single flex row inside the 232 px Inspector panel shrank below their label widths and triggered horizontal scroll — buttons were effectively hidden unless the user scrolled the panel right. Switched to a 2-column CSS grid (`.olv-export-grid`); the four-button file-format row and the single Report PDF button keep their flex layout.

### Tests + verification

- 869 tests across 77 files (up from 843 / 75 in v0.3.4). Typecheck clean. Default and live transformed builds clean. The CI workflow now runs typecheck → main-deferral lint → unit tests → production build → smoke gate, with the broader e2e suite advisory after.

### Documentation

- Roadmap (internal) records the Tier 3.1 (real laz-perf decode in the bench harness) and Tier 3.2 (250M-tier scheduler optimisation) work as v0.4.0 candidates. Both need infrastructure investment — laz-perf-in-bench needs a Web Worker harness refactor and per-tier real-data fixtures; the 250M optimisation needs incremental rescore + spatial-index acceleration with full stress-bench validation before/after. Neither was responsible to ship half-built.

## [0.3.4] - 2026-05-27

A hardening release on top of v0.3.3. The initial JavaScript shell drops from ~1.3 MB to ~100 KB through Viewer deferral, the streaming subsystem gains an ease-out fade and standardised phase strings, the EPT transport gains parity with COPC's retry / timeout / abort discipline, the PDF report engine grows three themes and white-label project metadata, and a torture-test suite locks in long-session invariants. No behaviour changes break v0.3.3 sessions, share links, or APIs.

### Improved

- **Initial shell trimmed by ~87%.** The Viewer module (Three.js scene, render pipeline, post-processing, navigation, picking, measurement geometry) now loads on demand behind `loadViewer()`. The first-paint shell drops from ~1.3 MB to ~100 KB pre-gzip / ~32 KB gzipped; Three.js WebGPU is fetched lazily on backend init; the PDF report chunk (~430 KB) is fetched only when the user clicks Export → Report PDF. See `docs/benchmarks.md` for the per-chunk table.
- **Streaming refinement polish.** Node fade-in eases from 50% to 100% over 180 ms on a cubic ease-out curve (was 120 ms linear), so refinements arrive smoothly rather than popping. Load phase strings are standardised across COPC + EPT: "Loading metadata…", "Building hierarchy…", "Streaming coarse geometry…". Export and PDF report flows surface their own progress through the same status pipeline.
- **EPT transport hardened to COPC parity.** A new `createEptTransport()` factory wraps every manifest / hierarchy / tile fetch in retry-with-backoff (transient 408 / 429 / 5xx + network errors, max three attempts, exponential backoff with jitter), a per-attempt 20 s timeout, and proper `AbortSignal` composition. Permanent 4xx (404 manifest, malformed tile) fails fast without burning retries. The transport sits behind the same lazy-EPT chunk so it adds no shell weight.
- **PDF report — three themes + white-label.** `branding.theme` selects between `light-technical` (default, white-paper inspection report), `dark-inspection` (high-contrast dark page for on-screen review), and `minimal-engineering` (austere monochrome, no accent stripe). All page background, body text, muted text, footer text, table rules, and accent-stripe behaviour are palette-driven. New `branding.projectMetadata` adds optional Client / Project / Phase / Reference / Date rows on the cover. `branding.footerNote` adds an optional confidentiality / compliance line above the standard footer on every page. White-label fields carry through `composeReportInputs`.
- **`__APP_VERSION__` runtime stamp.** The Studio's scan-report card and export metadata now read the version from `package.json` at build time via a Vite `define`, replacing the hand-edited string that could drift between release and footer.

### Tests + verification

- **Torture-test suite.** `tests/torture.test.ts` covers 50 cloud-swap cycles, 100 session round-trips, 100 report-compose cycles, and other long-session invariants — locking in the leak-class and memory-shape guarantees the lifecycle audit asserts.
- **EPT transport tests.** `tests/eptTransport.test.ts` pins the retry / timeout / abort discipline: transient failures retry, permanent 4xx fails immediately, abort propagates through composed signals, per-attempt timeout fires independently of overall budget.
- **Renderer theme contract tests.** `tests/reportEngine.test.ts` gains coverage for `resolveTheme()` palette selection and white-label-field passthrough. 843 tests across 75 files (up from 820 / 73). Typecheck clean. Default and live transformed builds clean.

### Documentation

- **`docs/benchmarks.md`** — new v0.3.4 bundle-shell benchmark table (per-chunk sizes, pre-gzip + gzipped). Existing v0.3.3 streaming stress numbers are now explicitly version-pinned and noted as still-valid for v0.3.4 (scheduler / cache logic unchanged).
- **`docs/streaming.md`** — new sections covering EPT hosting, EPT production, the v0.3.4 EPT transport guarantees (retry / timeout / abort), and browser recommendations.
- **README** — added recommended-formats and recommended-browsers guidance for large datasets and lightweight sharing.

## [0.3.3] - 2026-05-27

OpenLiDARViewer becomes a professional workflow platform. EPT (Entwine Point Tile) streaming joins COPC as a first-class peer; the Export Studio gains depth, normal, and contour image modes plus a multi-page PDF technical report engine; the streaming subsystem is hardened against bounded-memory and zero-thrash invariants at synthetic stress up to 1B points; the `.olvsession` package round-trips full working state including camera, render settings, and active colour mode; the WebGL fallback is leak-class clean across 50 open/close cycles; and the remote-URL UX gates malformed URLs before any network call and classifies failures into precise human-readable messages, for both COPC and EPT.

### Added

- **EPT (Entwine Point Tile) streaming.** `ept.json` URLs open progressively through the same scheduler / renderer / picking machinery as COPC. Both `binary` and `laszip` tile dataTypes; the laz-perf WASM module is shared with the COPC path. Local and remote, with fail-fast URL validation (`http`/`https` only, no embedded credentials, ≤ 2048 chars, must end in `/ept.json`) and classified error messages (CORS, manifest 404, manifest 5xx, malformed manifest, hierarchy/tile fetch failure, network down). Hierarchy walk is capped at 4096 files to bound hostile inputs. Float64-narrow precision contract preserved end-to-end.
- **PDF technical report engine.** Export → Report PDF builds a multi-page report from the live working state — cover page, dataset summary, embedded image exports, annotations table, measurements table, technical notes, footer. Five built-in templates: Engineering Inspection, QA Validation, Terrain Review, Survey Summary, Technical Documentation. Branding (accent + logo) and metric/imperial unit system propagate through every table. The engine and its pdf-lib dependency (~150 KB) load only when the user clicks the button; the chunk-emission guard prevents accidental inclusion in the initial bundle.
- **Visual Export Studio — depth, normal, and contour modes.** Camera-relative depth grayscale with invert toggle, RGB-encoded surface normals with smoothing options, and a contour mode with interval controls + topographic styling. Legend customisation (custom palettes, toggles, styling) and export-metadata overlays apply to every Studio mode.
- **`.olvsession` session package.** Saves camera, render settings, active colour mode, annotations, measurements, named views, and scan-summary metadata to a `.olvsession` JSON file. Import restores everything, including camera pose. v3 schema with full v1/v2 back-compat so older session files keep opening.

### Improved

- **Streaming scheduler — dispatch-pressure gate.** `_dispatch` now refuses to start a new decode when `resident + in-flight + nextNode.pointCount` would exceed the hysteresis cap (`1.5 × pointBudget`). Prevents peak-residency overshoot under high-throughput dispatch — the failure mode observed at 100M-point synthetic stress before the fix.
- **Streaming scheduler — `stop()` state cleanup.** Now resets each in-flight and queued node back to `'unloaded'` before clearing the maps, so a re-attached cloud starts from a clean baseline rather than carrying stale `'queued'` / `'loading'` state visible via `stats()`.
- **Picking selection extracted into a pure helper.** `selectStreamingPick` (in `src/render/streaming/streamingPickSelection.ts`) centralises the angular tolerance constant and locks the resident-only, angular-fair, refinement-aware contracts. The Viewer's `_pickStreamingDetailed` now does only the orphan-prune + visibility filter, then delegates selection.
- **Viewer lifecycle — listener + ResizeObserver leak fixed.** The constructor's canvas/window listeners (dblclick, click, pointermove, pointerleave, keydown) and the host-canvas `ResizeObserver` are now held as stored bound references and symmetrically removed in `dispose()`. A re-created Viewer on the same canvas no longer accumulates listeners across cycles.
- **Bundle audit + lazy splits.** `embedBridge` moved behind a lazy boundary; `loadReportEngine` and `loadEpt` (with the new URL validator) join the existing lazy chunks. Chunk-emission guard tracks every required lazy chunk so an accidental drag into the initial bundle fails the live transformed build.

### Documentation

- **`docs/benchmarks.md` — synthetic stress section.** Records measured numbers at 1M / 10M / 100M / 250M / 500M / 1B tiers: bounded residency at the hysteresis cap, zero thrash, peak GPU estimate, scheduler tick mean/p95, wall time. Documents the synthetic-fake-decoder caveat (the harness measures scheduler / cache / eviction, not laz-perf decode throughput).
- Streaming, supported-formats, architecture, usage, performance, limitations, README, and developer manual updated to reflect COPC + EPT parity, the Visual Export Studio + PDF reports, `.olvsession` round-trip, and the hardening invariants.

### Tests + verification

- 820 tests across 73 files. Typecheck clean. Default and live transformed builds clean. Live deploy bundle: main + every required lazy chunk emitted per the chunk-emission guard.

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
- **Incremental rescoring (stable-camera fast path).** The
  incremental-rescore work that was deferred from v0.3.1. The
  scheduler caches its scheduling signature
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
  required-chunks list still grows to 13 entries; the transform-driven
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
- **Live-transform chunk-emission guard.** The build fails loudly if any
  of the 12 required code-split chunks is missing from the transformed
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
- The live deployment build (`npm run build:live`) applies a source-transform
  pass to the project's own application code, so the deployed site ships
  compact unstructured JavaScript; the default `npm run build` stays a plain,
  readable build. The readable source stays on GitHub, and a startup console
  message points there. Third-party libraries and the parse worker are left
  plain-minified.

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
