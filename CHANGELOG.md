# Changelog

The format is based on Keep a Changelog and the project follows Semantic Versioning.

## [0.4.7] - 2026-06-14

A correctness and honesty pass across the load, export, and analysis paths,
with no user-facing feature changes.

### Fixed

- **Empty files are rejected with a clear message.** A file that decodes to
  zero points is no longer opened into a blank, unframable scene; it is
  rejected at the parse stage with a message explaining there are no points to
  display. A point cloud with no points now reports a finite bounding box
  rather than an infinite one, so nothing downstream can target a degenerate
  camera.
- **Reprojection never ships non-finite coordinates.** A transform whose output
  falls outside the target projection's valid area (proj4 returns Infinity or
  NaN without raising an error) is now treated as a failed transform: the
  coordinates are left in their source system and the converter reports how many
  points were affected, instead of writing a file with NaN coordinates.
- **Contour map sheet reports an unmeasured interpolation honestly.** When there
  are no contours to measure, the legend reads "Interpolated fraction — not
  measured" instead of a fabricated "0% interpolated".
- **Measured areas read the same in the PDF report as on screen.** The report's
  area formatting is single-sourced from the live measurement overlay, so a
  polygon documents itself in the same units (m² / ft² / acre) the user saw
  while measuring.
- **Point density reads "—" when it is unknown.** With neither a measured
  density nor the point count and bounds to derive one, the dataset card no
  longer shows a confident "Sparse"; it shows "—", matching how terrain
  complexity and ground visibility already report a missing signal.
- **Disposal.** The colour-recompute throttle's trailing timer is cleared when a
  viewer is torn down, and a streaming (COPC) cloud now closes its underlying
  file/range reader when detached, so neither lingers after teardown.
- **Load errors are described precisely.** A typed load failure now keeps its
  category as it crosses from the decode worker to the main thread, so the
  message shown is the exact one for the failure rather than a best-effort guess.
- **Foot-based coordinate overrides.** When a coordinate system is assigned by
  hand, its linear unit is resolved from the CRS registry rather than assumed to
  be metres, so a foot-based system scales measurements correctly.

### Changed

- **Large text scans load on tighter memory.** The XYZ/CSV loader releases its
  intermediate buffers as it builds the final arrays, lowering peak memory by a
  full copy of the cloud on the largest files.

- **One byte-size formatter** is shared across the stage, batch converter, debug
  overlay, and streaming panels, so a file size reads identically everywhere.
- **The unit test suite is split into four buckets** (`test:unit`,
  `test:terrain`, `test:ui`, `test:slow`) that together cover the whole suite,
  so it can run in parallel.

## [0.4.6] - 2026-06-14

Phase 1 of the design audit (visual-only; verdict-as-hero, two-tier surfaces,
quieter typography, mobile reflow, surface-quality chip density reduction) lands
alongside the GPU compute seam — the TerrainRasterEngine with equivalence-gated
WebGPU derivative/scatter kernels where the CPU stays the reference and the GPU
must prove per-session equivalence before it is trusted, falling back silently
otherwise. The interior floor plan remains an experimental PREVIEW, now backed by
an explicit wall-graph reconstruction and flood-fill room segmentation with
claim-accurate labels throughout. Plus nine label-vs-value drift fixes (incl.
foot-CRS / geographic-unit correctness and the edge-risk wording) and mobile
touch-target / safe-area improvements. Three more visible improvements
round it out: the plumbed-but-headless floor-plan export knobs get a small
UI (still an experimental PREVIEW), the last flagged capture-quality
label-vs-value drift ("Coverage … % of footprint" → "Bounding area filled") is
closed, and the streaming loader's indeterminate text becomes an honest
determinate resident-node progress bar.

### Navigation, tooling & hardening

- **Standard views + parallel projection.** Six axis-aligned camera views
  (Top / Bottom / Front / Back / Left / Right) snap the camera to look straight
  at a face for distortion-free measuring, alongside an Orthographic toggle that
  switches to a near-parallel projection (a long-lens approximation that leaves
  the render pipeline, culling and picking untouched). The view geometry is pure
  and unit-tested.
- **Icon + label toolbars.** The bottom dock, the measurement toolbar, the
  Layers "Solo" control and the Export header gain a consistent custom line-icon
  set, each keeping its visible text label (icon-only toolbars measurably hurt
  first-time users). Inspect and Probe are deliberately differentiated (target
  vs eyedropper). On phones the measurement toolbar reflows into a vertical
  rail; on desktop it is a top-centre bar that no longer overlaps the
  left-docked panels.
- **Full-screen toggle** in the header, with a glyph that tracks the real
  Fullscreen state (so F11 / Esc are reflected too).
- **Contour map sheet (PDF) fixes.** The title no longer overlaps the legend on
  long filenames; the contour-interval unit now matches the scale bar (m / ft);
  and an ungeoreferenced sheet drops the E/N graticule suffixes and the north
  arrow rather than implying a compass frame it doesn't have.
- **Security.** Parameter-derived button labels are escaped via `textContent`;
  only trusted static icon SVG passes through the raw-markup path, each site
  registered on the `unsafeHtml` review allowlist.
- **Smaller polish.** "Solo" is disabled when only one class is present; the
  `?debug` overlay clarifies the wall-clock load total, reports the CPU/GPU
  terrain compute path, and stops printing a false "0 draw calls"; and the
  Preview "not recommended for" wording reads "outputs requiring independent
  validation".

### Design

Phase 1 of the v0.4.6 design audit — a visual-only pass (no logic, data, or
component-behaviour changes; every selector preserved, all unit tests
stay green) that evolves the existing `src/style.css` token system to make the
honesty-first verdict the unmistakable hero and calm everything around it.
Dark, Light, and High-contrast themes all verified WCAG AA on the new
combinations (verdict-on-card ≥5.8:1 in every theme; primary action ≥4.9:1).

- **Two-tier surfaces (audit 1.2).** New `--panel-raised` / `--panel-recessive`
  / `--shadow-raised` / `--hairline-strong` tokens (defined in `:root` and
  overridden per theme). The Analyse verdict card and the Inspector "Color by"
  control rail now read RAISED (lift shadow, firmer edge); the secondary
  stacked left panels (Measure / Annotation / ClassLegend / Export / Object)
  drop to a RECESSIVE translucent fill and lift back to the full panel on
  hover/focus-within — focal hierarchy at last, costing one token pair.
- **Verdict as hero (audit 1.1).** `.olv-analyse-assess-verdict` jumps from a
  hard-coded 19px to `--text-2xl`; the full-card rating tint (previously only
  on `is-blocked`) now applies to ALL states (good / preview / limited /
  blocked) at low alpha, so the card's background subtly carries the verdict
  colour. The card rises + fades in last (reusing `olv-ready-in`) so the eye
  lands on the truth first.
- **Quieter typography (audit 2.1).** `text-transform: uppercase` + `var(--mono)`
  are now reserved for top-level section labels and honest-status WORDS
  (Ready/Preview/Blocked). Sub-group eyebrows and metric sublabels —
  `.olv-visuals-group-label`, `.olv-render-sublabel`,
  `.olv-analyse-assess-metric-label`, `.olv-analyse-workflow-head`,
  `.olv-analyse-products-head`, `.olv-analyse-why-subhead`,
  `.olv-object-subhead`, `.olv-getstarted-eyebrow`,
  `.olv-analyse-product-reason-label` — move to calm sentence-case Manrope.
  Tabular numeric/coordinate readouts stay monospace (untouched).
- **Honesty as a visible system (audit 2.4).** A single reusable `.olv-caveat`
  primitive (left-rule + tinted bg, modelled on `.olv-di-warning`) with
  `--caveat-rule` / `--caveat-tint` tokens, applied uniformly to every honest
  limit: Suitability caveats (`.olv-object-note`), Blocked/Preview reasons
  (`.olv-analyse-reason`, `.olv-analyse-product-reason`), and export notes
  (`.olv-analyse-dem-note`, `.olv-analyse-export-note`). The
  "Private · on your device" trust pill (`.olv-badge`) is elevated to a
  confident pill with a CSS-drawn lock glyph and a firmer accent edge.
- **One primary action per state (audit 1.4).** A reusable `.olv-primary-action`
  recipe (solid `--accent` fill, `--on-accent` ink, weight 600 — modelled on
  the lasso toast) promoted in place onto the single primary of each state
  (fresh Run analysis, the DEM/Report download, Convert) so it's unmistakable;
  secondaries stay quiet outline/ghost.
- **Mobile reflow (audit 1.3, CSS-achievable part).** Below 767px the
  `.olv-left-panels` stack is capped to the top ~52vh with internal scroll and
  a soft bottom fade, so panels no longer blanket the canvas or the bottom dock
  and the verdict stays reachable. (A true single bottom-sheet with a
  View · Analyse · Layers segmented control needs JS — flagged as a follow-up.)
- **Surface-quality chip saturation (density reduction).** The Analyse verdict
  showed nine supporting-metric chips as one flat pile under the verdict +
  reason + export readiness + product rows — a lot to parse at once. The chips
  are now TIERED without hiding anything a trust decision needs: an
  always-visible PRIMARY row carries the three decisive chips (DTM quality, the
  headline number; Coverage, the frame; and the single WORST-rated remaining
  signal, so whatever is actually dragging the surface down is never buried),
  and the full nine move into an "All metrics" `<details>` disclosure grouped
  into meaningful clusters — **Coverage** (Coverage / Empty cells /
  Interpolation), **Surface** (Ground density / DTM quality / Edge risk),
  **Accuracy** (Vertical RMSE), **Georef** (CRS / Vertical datum) — instead of
  a flat list. The disclosure defaults OPEN on desktop and COLLAPSED on mobile
  (`_syncMetricsDisclosure`, a `matchMedia('(max-width: 640px)')` check; no chip
  is ever removed from the DOM, only the default open-state differs). A Georef
  cluster whose chips are all "unknown" is dimmed (`.is-uninformative`) since it
  adds nothing beyond the export-readiness line already shown. Honesty-first:
  the verdict, score, export readiness, reason, terrain-product rows and "Why?"
  causes all stay always-visible above the disclosure — only the full numeric
  breakdown is progressively disclosed. CSS + small-DOM grouping only
  (`_renderAssessMetrics` in `AnalysePanel.ts`); no selector consumed by a test
  changed. (A true single mobile bottom-sheet for the whole panel remains the
  flagged JS follow-up from audit 1.3.)

### Added

- **Floor-plan export options control (ObjectPanel).** The `snapMode`
  (`'auto' | 'strong' | 'off'`) and `adaptiveBand` settings — already plumbed
  through `extractFloorPlan` as `FloorPlanParams` and into `main.ts`
  `FLOORPLAN_OPTIONS`, but with no way to set them — now have a compact
  "Floor plan options" control directly under the "Floor plan preview" button:
  a 3-segment **Walls** picker (Auto · Square · As-is → snap `auto` / `strong` /
  `off`) plus an **Adaptive height** toggle, defaulting to the existing headless
  defaults. The selection flows through a single `ObjectPanel.floorPlanOptions()`
  getter that BOTH export paths (standalone SVG sheet + report-embedded PDF plan)
  spread into the same `extractFloorPlan` call, so the two artifacts can never
  diverge on the chosen policy. The floor plan stays an experimental PREVIEW; the
  control only chooses an extraction policy and does not imply survey-grade
  output. a11y: the segments are a real radio group (`role="radiogroup"`, named
  `<input type="radio">` + `<label>` chips, focus ring); the toggle is a labelled
  `<input type="checkbox">`. The honesty footer on the sheet still states which
  wall policy was used. Tests: `tests/floorPlanExportOptions.test.ts` (control
  defaults match `FLOOR_PLAN_EXPORT_DEFAULTS` / `FLOORPLAN_OPTIONS`; selecting a
  Walls segment or toggling Adaptive height flows into `floorPlanOptions()` — the
  object spread into `FloorPlanParams`; the getter returns a copy).
- **Determinate streaming-progress treatment (StreamingPanel).** The
  "Refining visible detail…" phase now carries a thin brand-gradient progress
  bar showing the RESIDENT-node fraction (loaded ÷ known nodes) over the faint
  track, with a tabular `X / Y nodes resident` + `X.XM / Y.YM pts` readout. The
  "Streaming ready" terminal state latches the bar full. When the total node
  count is not yet known the bar falls back to the indeterminate brand shimmer
  rather than fabricating a percentage. HONESTY: the bar reflects what is LOADED
  into the scene (resident octree nodes), explicitly labelled "resident" — it is
  not a download percentage (a streaming source has no fixed total bytes). New
  pure `streamingProgress()` helper carries the fraction/label logic. Tests:
  `tests/streamingProgress.test.ts` (hand-computed fraction incl. clamp to [0,1]
  and the unknown-total → indeterminate fallback, and the same-unit millions
  points readout).
- **GPU compute phase 2 — DTM min/count scatter on the GPU**
  (`src/terrain/engine/dtmScatter.ts`, `gpuBackend.ts`, `TerrainRasterEngine.ts`).
  The TerrainRasterEngine gains a `scatterMinCount` entry: point→cell binning
  for the INTEGER-STABLE DTM reductions — per-cell `min` elevation and per-cell
  `count` (the density layer) — as WGSL compute. Float min has no
  `atomic<f32>` in WebGPU, so the kernel mins in u32 space through an
  ORDER-PRESERVING bit key (the radix-sort trick: flip the sign bit for
  non-negative floats, all bits for negatives — u32 comparison then matches
  f32 numeric comparison), with `atomicMin` on the keys and `atomicAdd` on the
  counts; a finalize pass decodes the winning key back to f32 (or the canonical
  NaN `Float32Array.fill(NaN)` stores, for empty cells). Because min and count
  are order-INDEPENDENT, the equivalence is EXACT, not tolerance-bounded: the
  once-per-session probe now also scatters a synthetic 24×24 grid (dense
  contention cells, genuinely-empty cells, ±elevations, out-of-grid edge-clamp)
  and asserts the GPU grid is BIT-equal to the CPU reference
  (`scatterMinCountReference`, the exact transcription of `rasterizeDtm('min')`
  — and byte-identical to it on the f32 point buffers the pipeline feeds). The
  engine routes scatter to the GPU only when `probe.scatterExact === true`,
  with the same auto-fallback + telemetry as the derivative kernels (a dispatch
  throw demotes the session to CPU and the call is recomputed on the reference).
  `mean` (a float sum that reassociates), `median`, `percentile`, and `robust`
  are NOT atomics-tractable and stay on the CPU `rasterizeDtm` — only the
  min/count/density paths move, per the tech evaluation; the synchronous
  contour pipeline keeps calling the CPU `gridFromPoints` (the async
  GPU-eligible scatter is wired and proven, adopted when that stage goes async
  next phase, mirroring the phase-1 derivatives discipline). Tests:
  `tests/terrainRasterEngine.test.ts` (ordered-key round-trip + monotonicity,
  a hand-computed tiny-grid scatter, reference-vs-`rasterizeDtm` byte-equality,
  exact scatter probe gating + diverging-scatter fallback) and
  `tests/gpuBackendDispatch.test.ts` (mock-device scatter+finalize dispatch:
  buffer sizes/usages, sentinel-seeded key buffer, uniform packing, two-pass
  geometry, cleanup); `tests/e2e/gpuDerivatives.spec.ts` now also asserts the
  real-device scatter is exact (a `false` is the same forbidden divergence as a
  derivative mismatch).
- **Floor plan: adaptive wall-slice height band**
  (`src/terrain/space/floorplan/wallSlice.ts`). The hardcoded 0.7–1.8 m wall
  band now ADAPTS: `detectWallBand` builds a z-histogram of returns above the
  floor and finds the densest SUSTAINED vertical window (scored by its weakest
  bin, so a broad wall slab beats a one-bin floor/ceiling/furniture spike), and
  re-centres the band on it. Countertop / industrial scans whose walls sit
  outside 0.7–1.8 m (high clerestory, racking, mezzanines) now slice their
  actual walls instead of low clutter. It only MOVES the slice on genuinely
  off-centre evidence — a normal full-height room (uniform wall density) keeps
  the well-tested fixed band by a centre-preference tie-break — and falls back
  to the fixed band, then the widened retry, then full height. `floorBasis`
  gains a `bandBasis` companion ('fixed' | 'adaptive') and the sheet's honesty
  footer says when the band was re-centred. Default on; `adaptiveBand: false`
  pins the fixed band. Tests in `tests/floorPlan.test.ts` (the detector on
  hand-built histograms: uniform→fixed, high-zone→re-centre, narrow
  spike→reject, floor-clearance clamp) and an end-to-end high-clerestory room
  that climbs onto the 2.0–3.2 m walls and excludes the 0.5–0.9 m clutter.
- **Floor plan: furniture height-profile classifier feature**
  (`regularize.ts`, `occupancyGrid.ts`, `wallSlice.ts`). The wall slice now
  keeps per-band-point elevation (`zs`), and `extractFloorPlan` bins it into a
  per-cell height profile (`buildCellHeightProfile`) passed to
  `classifyIslands`. A component's vertical EXTENT now joins area / elongation /
  distance-to-wall: a THIN, TALL component (small column footprint that spans
  most of the band) is rescued to STRUCTURE instead of being demoted to
  furniture, while a WIDE full-height blob (a wardrobe) stays furniture by its
  footprint — height span alone is not enough, it is the thin-and-tall
  combination that reads as a column. The feature only ever RESCUES a compact
  component into walls on strong vertical evidence (never demotes a
  footprint-wall, so door-jamb safety is untouched), and is a no-op when no
  profile is supplied (pre-v0.4.6 behaviour). Tests in
  `tests/floorPlanRealism.test.ts` (a tall thin column kept vs a low cabinet
  lifted, a wide full-height wardrobe staying furniture, footprint-only when no
  profile).
- **Floor plan: plumbed extraction options (snap mode + adaptive band)**
  (`extractFloorPlan.ts`, `main.ts`). `FloorPlanParams` gains `adaptiveBand`
  and `snapMode`, threaded into the wall slice and the vectoriser's
  `resolveSnapAxes` (the `SNAP_MODE` auto/off/strong policy). `main.ts` plumbs
  a single documented `FLOORPLAN_OPTIONS` object (sane defaults — adaptive band
  on, snap auto) into BOTH export paths (the PDF report's embedded plan and the
  standalone SVG sheet), so the two can never extract with different settings.
  A dedicated ObjectPanel control is deferred — the plumbed options object is
  the seam a future control would set; the honesty footer already reports the
  band basis and snap policy used. Test: the pipeline suite asserts
  `bandBasis`, the adaptive re-centre note, and `snapMode: 'off'` are honoured.
- **TerrainRasterEngine seam + WebGPU derivative kernels**
  (`src/terrain/engine/`). One interface now owns terrain raster
  construction — `groundFilterPass` (SMRF), `gridFromPoints` (DTM
  rasterisation), and the grid-in → grid-out derivatives (Horn
  slope/aspect, ESRI hillshade) — behind two backends. The `cpuBackend` is
  PURE DELEGATION to the existing tested functions (`classifyGroundSmrf`,
  `rasterizeDtm`, `hornSlopeAspect`, `shadeFromSlopeAspect`): no logic
  moved, byte-identical outputs, and it remains the REFERENCE
  implementation and the always-available fallback (WebGL2-only devices
  run it unchanged). The `gpuBackend` ships the embarrassingly-parallel
  DERIVATIVES kernels only this phase — Horn slope/aspect and hillshade as
  WGSL compute, mirroring the CPU operation-for-operation (northing-up
  aspect negation, edge clamp, non-finite→centre fallback via a CPU-built
  validity mask since WGSL NaN tests are driver-unreliable, half-UP shade
  rounding); point→grid scatter and the ground filter stay on the CPU
  functions even when GPU is active (atomics-bound, deferred per the tech
  evaluation). Honesty-first by construction: a once-per-session
  EQUIVALENCE PROBE runs both backends on a synthetic 64×64 grid (hills +
  ramp + NaN holes + an exactly-flat patch) and the GPU is only activated
  if it agrees per-cell within 1e-4 (slope rise/run; aspect compared as an
  angular distance, only above a 1e-6 slope floor where direction is
  numerically meaningful) and ±1 grey level of shade — f64-vs-f32
  float-order and driver FMA/atan2-precision caveats are documented at the
  seam, and a GPU that diverges is a FAILURE, not a fast answer. Missing
  `navigator.gpu`, a failed device request, a failed probe, or a later
  dispatch throw each pin the session to CPU — silent to the user, but
  recorded in compute-path telemetry (`getLastTerrainRasterComputePath`,
  mirroring the worker-path telemetry), and a failed dispatch is recomputed
  on CPU so callers always get the reference answer. The contour
  pipeline's derivative stage now routes through the engine's synchronous
  CPU-reference entries (byte-identical to before — the async entries are
  the GPU-eligible ones the stage adopts when it goes async next phase).
  Tests: `tests/terrainRasterEngine.test.ts` (delegation byte-equality,
  the f32 kernel-transcription equivalence harness across synthetic grids,
  every fallback reason, probe idempotence) and
  `tests/gpuBackendDispatch.test.ts` (mock-device dispatch plumbing:
  buffer sizes/usages, uniform packing, workgroup geometry, cleanup);
  real-GPU verification is the self-skipping browser gate
  `tests/e2e/gpuDerivatives.spec.ts`, which fails loudly on a probe
  mismatch.
- **Wall graph** (`src/terrain/space/floorplan/wallGraph.ts`). The centerline
  skeleton (centerline.ts) is lifted into an explicit topological model:
  junction cells (≥ 3 skeleton neighbours, clustered 8-connectedly) and free
  endpoints become NODES; the skeleton paths between them become EDGES, each
  carrying a straightened centerline polyline (Douglas-Peucker via the
  vectorize machinery + an open-chain dominant-axis snap), ONE measured mean
  thickness (chamfer transform of the wall mask the graph describes — an
  echo-collapsed wall reports its collapsed thickness, not the echo's), and a
  per-edge observed fraction against the raw pre-close mask. Junction-free
  cycles get a synthetic loop node so every skeleton cell belongs to exactly
  one edge. The wall mask is then RE-EXTRUDED FROM THE GRAPH — constant
  thickness per wall run, join discs at junctions so corners close cleanly —
  with sub-cell mass recentring of the path (the integer skeleton of an
  even-width strip sits half a cell off the true medial axis) and a paint
  radius of (meanDist − 0.5) cells, which together reproduce the measured
  width exactly for both parities: the reconstruction never fattens a wall
  beyond the evidence and never recedes its faces (sheet W × D keeps agreeing
  with the Space panel). Falls back to the normalised mask (and drops the
  graph claim) when the graph is degenerate. Truth-grid tests
  (`tests/floorPlanWallGraph.test.ts`): T / + / L junction topologies, loop
  self-edges, hand-computed edge thickness (3-cell strip → ≈ 0.2 m half),
  half-observed runs reading ≈ 0.5, odd AND even strip widths round-tripping
  exactly, L-corner closure with bounded mass growth, watertight loop
  extrusion, and the open-chain snap's fixed/free end contracts.
- **Room segmentation** (`src/terrain/space/floorplan/roomDetect.ts`). Flood
  fill of the free space bounded by the graph-extruded walls PLUS the
  classified doorways' jamb-to-jamb spans (painted as temporary barriers — a
  door separates the rooms it connects). Chosen over planar graph faces
  deliberately: faces need a closed embedding and collapse on gappy real
  scans, while flood fill degrades gracefully. Honesty rules by construction:
  door-separated rooms stay DISTINCT (merging through classified doorways
  stays off); 'unknown' gaps are NEVER closed, so an unscanned divider merges
  its regions instead of fabricating a wall; a region leaking to the grid
  border is exterior, never claimed as a room. Per room: outer boundary
  polygon (existing trace + simplify machinery), area measured on the REGION
  MASK (not the simplified polygon), and a label anchor at the pole of
  inaccessibility (chamfer maximum) so labels sit inside L-shaped rooms.
  Regions under the architectural minimum room area (`ROOM_MIN_AREA_M2`, 4 m²
  — see the same-day calibration fix below) are slivers and dropped; the room
  list is also suppressed in favour of an honest "Open space" / "could not
  segment" outcome when it would not faithfully describe the floor; at most 16
  rooms are reported, largest first. Tests (`tests/floorPlanRooms.test.ts`):
  hand-counted two-room grid
  (320 / 324 cells exactly, including the provable 4-cell door-barrier bite),
  open-plan merge, unknown-gap non-closure, exterior leak → no rooms,
  sub-1 m² sliver rejection, exact L-enclosure area; end-to-end two-room scan
  with a 0.9 m door → exactly 2 rooms within ±2% of the hand-computed
  interiors (39.105 / 38.71 m²), a 2 m unknown gap → ONE merged room, and an
  L-shaped scan → one room at the hand-counted 58.66 m².
- **Rooms on the artifacts.** The SVG sheet labels each room
  "Room N · 12.3 m²" (sq ft under the imperial unit system) at its pole of
  inaccessibility when the text fits, prints a "Room schedule (flood-fill of
  the wall graph, approx.)" footer line with every room either way, and the
  Space Report PDF embed draws the same labels. The sheet subtitle and the
  PDF caption now say "wall-graph reconstruction" — but ONLY when the walls
  really were re-extruded from the graph (`fromWallGraph`); the fallback
  keeps the old "approximate wall-trace sketch" wording, and all standing
  "preview / experimental / not for construction" caveats remain. The old
  "≈ area" scanned-floor region labels still render when no rooms were
  segmented (and only then — no double labelling).
- **Styled confirm dialog** (`openConfirm` in `src/ui/Modal.ts`). A
  Promise-based replacement for `window.confirm()` built on the existing
  accessible Modal chrome. WHY: `window.confirm()` is unreliable in embedded
  WebViews — some suppress it entirely, returning `false` without ever showing
  a prompt, which silently blocked a user inside an iframe/app shell from
  approving a large-file or cellular download. The styled dialog renders
  identically everywhere the app does, focuses Cancel as the safe default, and
  treats any dismissal (Escape / backdrop / close-X) as "no". Wired into all
  three former native prompts: the mobile large-file open gate and the sample
  download gate (`Stage.ts`, now async), and the reset-session-stats gate
  (`Inspector.ts`). Tests: `tests/modalConfirm.test.ts` (resolve semantics,
  settle-once idempotence, Cancel-focus default, multi-line message split).
- **Gated-control reasons are now visible, not hover-only.** Two disabled
  controls whose "why" lived only in a `title` tooltip — invisible on touch,
  which has no hover — now restate the reason as a visible line in the flow:
  the Inspector's analysis-gated Coverage / Confidence colour chips ("Run
  terrain analysis first to enable Coverage and Confidence"), and the batch
  converter's disabled LAZ format pill (the in-browser-LAZ-not-yet note). The
  `title` attributes stay for pointer users.

### Changed

- **Honest capture-quality coverage label (last drift fix).** The Capture
  quality "Coverage … % of footprint" row (hint "Share of the footprint with
  returns") implied a share of a traced room outline, but the value is computed
  as occupied cells ÷ (cols × rows) over the scan's axis-aligned BOUNDING-BOX
  grid — a fill ratio of the EXTENT. Relabelled to **"Bounding area filled"**
  with a bare `%` value and a hint that says exactly that ("Share of the scan's
  bounding-box footprint grid whose cells contain returns — a fill ratio of the
  extent, not of a measured room outline"), in both the ObjectPanel row and the
  report-PDF layout, so label == computation. The math is unchanged. Tests:
  `tests/coverageLabelHonesty.test.ts` (pins the new "Bounding area filled" label
  — bare `%`, fill-ratio hint — in both surfaces and guards the old
  "% of footprint" / "Share of the footprint" phrasing from regressing).
- **Mobile touch targets bumped to ≥ 44 px** (the long-deferred mobile audit
  box from 0.4.4). On phones (`max-width: 767px`), the tool-dock chips
  (`.olv-dock .olv-tool`, previously 32 px), the batch-converter format / CRS
  pills (`.olv-bc-pill`), the measure-toolbar chain-operation chips
  (`.olv-mp-chain-chip`), the camera-preset chips (`.olv-cam-chip`), and the
  styled-confirm buttons now meet Apple's 44 px minimum tap height. Dock width
  stays content-driven (with a 44 px floor) so the six-button row still fits
  the narrowest iPhone — height carries the tap area in a dense horizontal
  toolbar. All rules live inside the phone media query, so desktop density is
  untouched.
- **Notch-safe toasts.** The lasso-result toast and the load-progress toast now
  subtract `env(safe-area-inset-left/right)` from their max-width so a
  landscape side-notch (sensor housing / rounded corner) can never clip them.
  `env()` is 0 on inset-free displays, so desktop width is unchanged. (The
  vertical safe-area handling for the dock / nav / toasts was already in place.)

### Fixed

- **Streaming scheduler per-tick allocation storm — "computer got really slow
  when I opened the project"** (`StreamingNodeStore.ts`, `StreamingScheduler.ts`).
  On a large streamed COPC (the 125.5 M-pt interior: 28 319 known nodes, ~495
  resident) the view-dependent scheduler runs ~10×/s for the whole session. Each
  tick walked `octree.nodes()` — `[...map.values()]`, a throwaway **28 319-element
  array** — THREE times: the "reconsider queued" reset pass, the full rescore,
  and (via `store.resident()` = `all().filter(...)`) the eviction pass, which
  allocated TWO such arrays. So every idle tick allocated ~3–4 full-hierarchy
  arrays and re-scanned all 28 k nodes just to touch a few hundred — GC churn +
  walk cost that scaled with the WHOLE octree, not the working set, and bogged
  the main thread the entire time the cloud was open (the stable-camera fast
  path skipped the *scoring* but NOT these walks). The store now maintains
  `resident` / `queued` SETS at every `setState` transition and exposes
  zero-allocation iterators (`iterate()`, `residentNodes()`, `queuedNodes()`);
  the scheduler's per-tick passes are now O(resident)/O(queued) with no
  per-tick array allocation. The dominant per-frame cost on scan-open is gone.
  (Investigated and ruled OUT as the open-path regression: the WebGPU
  equivalence probe — gated behind Analyse via `analyseContours.ts`, idempotent
  one-shot, never on the open path — and the O(N) brute-force hover pick, which
  only fires on pointer-move with the measure/probe tool armed, not at
  scan-open.) Guard test in `tests/streamingOctree.test.ts` proves the
  maintained sets stay bit-identical to a ground-truth `all().filter` walk
  across every lifecycle transition.
- **Big open interior misdetected as terrain — "Treat as" never auto-committed
  to Interior** (`scanShape.ts`). On the real 125.5 M-pt 360 industrial-interior
  scan the "Treat as" control would not commit to Interior automatically; the
  user had to set it by hand. Root cause was DETECTION, not the commit mechanism:
  `classifyScanShape` read this large open interior (≈11.8 × 15.0 m footprint,
  ~4 m ceiling) as TERRAIN. A 360 scanner sees a HIGH ceiling only at grazing
  angle, so full-height `wallCoverage` AND `ceilingCoverage` both landed ~12–22%
  — under the strict `WALL_INTERIOR` (0.25) and `ENCLOSURE_COVER` (0.45) bars —
  while the densely-sampled floor (≈100%) looked like a flat field. With the
  verdict at terrain, the planner correctly REFUSED the mid-session terrain flip,
  so no commit ever fired and the pill stayed on Auto past `SETTLE_RETRY_CAP`.
  The fix adds an **open-interior path**: accept a much lower wall-OR-ceiling
  presence (`WALL_OR_CEILING_OPEN_INTERIOR`, 0.10), safe because
  `floorCoverage ≥ 0.5` AND `overhangFraction ≥ 0.15` each independently exclude
  every terrain case (flat AND steep hilly terrain measure ~10–15% floor and ~0%
  overhang in testing). The verdict now reads `interior` (own honest 0.7
  confidence, "open interior space — high or sparsely-scanned ceiling"); the
  settle one-shot then commits the pill on its own. New test in
  `tests/scanShape.test.ts` reproduces the scan's exact shape signature
  (sparse ceiling, partial walls, full floor) and pins interior, with the
  terrain/forest controls verifying no regression.
- **Floor-plan region areas exceeded the stated floor area — incoherent sheet**
  (`floorPlanSvg.ts`). The sheet reported "Floor area 94.4 m²" yet "Approx.
  region areas … 106.6 m²" — the per-region breakdown summed to MORE than the
  headline floor area. The two figures measured different things: `floorAreaM2`
  is the NET scanned presence mask (measured before closing), while the region
  rings are vectorised from the CLOSED, hole-healed, outward-simplified mask, so
  their polygon sum is a GROSS extent that overshot. A region sum larger than the
  stated floor is incoherent on an honesty-first sheet, so a new
  `regionAreaReconcileScale` proportionally scales the regions down (factor ≤ 1,
  never up) so the breakdown sums to the floor area exactly — relative extents
  stay honest, no figure ever exceeds the headline. Applied to BOTH the footer
  sum and the in-plan per-region labels so the sheet never shows two areas for
  one region. New test in `tests/floorPlanQuickWins.test.ts`.
- **Floor-plan furniture-hint clutter — 37 grey specks stippled the sheet**
  (`extractFloorPlan.ts`). The contents classifier on a cluttered 360 interior
  lifted 37 compact islands and drew every one as a grey hint blob — noise, not
  a layout aid. The drawn set is now capped at the `MAX_CONTENTS_HINTS` (12)
  LARGEST by footprint after a sub-`MIN_CONTENTS_HINT_M2` (0.12 m²) speck filter
  — same found-vs-drawn honesty pattern as `MAX_UNKNOWN_GAPS`. The footer states
  the full found count, how many were drawn, and that the smallest were omitted
  to keep the sheet legible. New test in `tests/floorPlanRealism.test.ts` (many
  islands classified, ≤ 12 drawn, honest footer wording).
- **Floor-plan room segmentation calibration — no fake room schedule on an
  open plan** (`roomDetect.ts`, `extractFloorPlan.ts`, `floorPlanSvg.ts`).
  On a real open industrial interior (96 m² floor) the open floor LEAKS to the
  exterior boundary through unscanned boundary runs, so the flood fill
  classified the whole interior as exterior and the only enclosed regions were
  tiny sealed pockets between wall fragments — the sheet then printed "Room 1…5"
  totalling 8.3 m² (pockets of 1.0–2.8 m²), which read as broken. Three changes
  recalibrate it honestly: (a) the architectural **minimum room area** is raised
  from 1.0 m² to **4.0 m²** (`ROOM_MIN_AREA_M2`, parameterised — a 1–3 m² flood
  pocket is not a room; sub-threshold pockets are DROPPED, never numbered);
  (b) a **"could not segment" / open-plan guard** — when the kept rooms cover
  less than `ROOM_COVERAGE_MIN_FRAC` (35%) of the scanned floor area, the room
  list is suppressed and the model reports an honest outcome instead: a single
  **Open space · ~N m²** when one connected region dominates the floor
  (`OPEN_SPACE_MIN_FRAC`, 55%), else **"Rooms could not be reliably segmented
  from the wall returns"** — no fabricated schedule, while the wall poché,
  overall dimensions, and floor area still render; (c) a single unpartitioned
  region (no doorway split, not ≥2 rooms) that covers most of the floor is now
  presented as one **Open space** rather than "Room 1" of a schedule. The
  echo-collapse pass (`centerline.ts`) was re-verified — its output is a strict
  subset of the input wall mask (it only removes excess double-scanned wall
  mass, never erodes past raw returns), so the "25 m²-removed" figure is
  legitimate double-wall collapse, NOT the cause of the leak; left as-is and
  confirmed by the existing subset test. The room detector now takes the
  scanned floor area so it can apply the guard. New tests in
  `tests/floorPlanRooms.test.ts`: the raised min-area floor (9 m² enclosure is a
  room, 3.24 m² is not), the leaking-open-plan pathology in miniature → NOT a
  room schedule (`unsegmented`), one dominant region → `open-space`, threshold
  ordering, and the end-to-end open-plan / L-shape scans now read as a single
  open space; the genuine two-room partition still yields two distinct rooms.
- **Caveat collapse in the Space/Object panel** (`ObjectPanel.ts`, `style.css`).
  The interior scan panel stacked ~5 orange `.olv-object-note` caveats ("Based
  on points currently loaded…", "N stray returns excluded…", "Density scaled
  from sample…", "Ceilings sparsely captured…", "Wall and plane figures are
  pragmatic estimates…") that ate the panel vertically. The single most
  decision-critical line — **"pragmatic estimates, not a certified survey"** —
  now stays visible as a lead note; the remaining secondary caveats fold into
  ONE collapsed `<details>` disclosure ("About these figures (N) ▸") with native
  `<summary>` keyboard + `aria-expanded` semantics, a rotating caret, and a
  focus ring. Nothing is removed: the collapsed content stays in the DOM (the
  `currently loaded / streamed` and other strings remain reachable by tests and
  assistive tech, just hidden until expanded), and the floor-plan
  "experimental — requires visual validation" note stays visible when the
  preview button is present. The AnalysePanel was reviewed and left unchanged —
  its quality `reasons` already live inside the collapsed "Details" disclosure,
  so it had no surface-level pile-up. Pinned in `tests/objectPanelSpace.test.ts`
  (one disclosure, lead kept visible, every secondary caveat still in the DOM).
- **Edge-risk wording bug (Analyse "Why?" panel).** The surface-quality
  "Why? / How to improve" engine (`whyNotReasons.ts`) still described the
  high-edge-risk cause as "`N%` of cells are a long interpolation from real
  returns" — the wording that belongs to the gate's *tally* metric
  (`dtmCellStatus 'edgeRisk'`: interpolated cells far from any measurement).
  But the value it prints, `quality.edgeRiskRatio`, is wired from
  `cellMetrics.edgeRiskRatio` (`analyseContours.ts`) — the fraction of
  *measured* cells that sit near the data boundary (real returns, just least
  neighbour support). The same mislabel was fixed in `terrainAssessment.ts`
  before, but this second copy — which renders in the SAME surface-quality
  section, directly below the verdict — was missed, so a user could see the
  EDGE RISK chip (e.g. 53%) and a contradictory "long interpolation" reason at
  once. The cause now reads "`N%` of measured cells sit at the edge of the
  data, where the surface is least supported", matching the chip and the
  assessment reason verbatim. Pinned in `tests/whyNotReasons.test.ts` (the
  metric is no longer called "long interpolation"; the gate's own tally metric
  in `tests/dtmQuality.test.ts` legitimately keeps that phrasing).
- Sparse-regime doorway-close cap (`closeRadiusCells`): the closing radius
  was floored at 1 cell to heal hairline gaps, but in the sparse regime the
  adaptive cell can GROW to 0.3 m, where radius 1 bridges up to
  2·√2·0.3 ≈ 0.85 m diagonally — enough to seal a standard 0.6 m doorway.
  The floor now applies only while radius 1 cannot bridge `keepOpenM` even
  diagonally (2·√2·cell < keepOpen); past that, closing is disabled outright
  (the grown rasterisation has already fused returns within each fat cell, so
  the hairline-heal duty is moot). A door survives at EVERY cell size by
  construction. Pinned in `tests/floorPlan.test.ts` (0.21 m → 1; 0.25 m and
  0.30 m → 0; radius-0 closing is the identity).
- The Space Report PDF's embedded floor-plan dimension line now honours the
  caller's unit system (imperial prints feet first, metric metres first),
  matching the standalone SVG sheet and the measurement panel —
  `buildSpaceReportPdf` gains `unitSystem`, threaded from the live
  measurement unit system in `main.ts`.
- **Stride-scaled USGS QL presented as exact (terrain honesty asymmetry).**
  When the gather strides a huge cloud (≤300k points), ground density is scaled
  back to the full scan by a uniform-stride assumption (`samplePointScale`),
  and that scaled density grades the USGS 3DEP Quality Level. The space-scan
  path already disclosed "uniform-stride assumption" on its density/spacing, but
  the terrain QL chip, its tooltip, and the Terrain Report presented the grade
  as a directly-counted, exact figure. `analyseContours.ts` now emits a
  uniform-stride caveat into `result.warnings` whenever the density was scaled
  (`samplePointScale > 1`) — surfaced verbatim in the exported PDF report's
  Warnings section — and the Analyse panel's QL hint carries the same note, so
  the QL grade reads as the estimate it is. No caveat is emitted on an
  un-strided (scale 1) run. Pinned in `tests/densitySampleScale.test.ts`.

## [0.4.5] - 2026-06-10

The honesty-and-deliverables release: one readiness engine behind every export
verdict, a colourblind-safe confidence overlay, profile intelligence (summary,
station table, CSV, sampler controls), the Terrain Intelligence Report,
workflow presets, true measurement units on foot-CRS scans, and an accessible
onboarding tour.

### Fixed

- (2026-06-12 amendment) The streaming settle one-shot could STILL leave an
  interior scan uncommitted — the field report after the depth-gate +
  spend-on-verdict fix below. The remaining hole was the spend rule itself:
  "spend once detection reached a verdict" also spent on a verdict the
  planner REFUSED. Past the depth gate the resident set can still be
  ceiling-heavy (the gather walks the coarse nodes first), so the settled
  evaluation can read TERRAIN against a standing interior route; the
  mid-session no-flip guard rightly refuses that flip — no apply, no commit —
  but the one-shot counted it as "reached a verdict", spent itself, and the
  "Treat as" pill stayed on Auto forever while the panel showed Interior.
  `settleOneShotSpent` now spends only when the verdict actually LANDED
  (the planner applied it, or the settled soft-commit fired) or when no
  commit can ever come (pinned / manual override); a refused verdict and an
  undecidable frame both RE-ARM the one-shot. Re-attempts are gated on the
  resident set actually changing (re-reading an identical idle frame cannot
  change the verdict; a failed gather may retry at once) and bounded by
  `SETTLE_RETRY_CAP` (40) so a permanently refused scan can never
  re-classify on every poll forever. The exact failure sequence is pinned in
  `tests/streamingSettleCommit.test.ts`: settle at depth 2 reads terrain
  (refused, one-shot stays armed, no churn on the unchanged frame) → a later
  ready poll on grown geometry reads interior → the Interior pill commits;
  plus the retry-cap bound.
- (2026-06-12 amendment) Opening the interior floor-plan SVG (or the Space
  Report PDF embedding the same model) could make the machine crawl on a
  dense scan: the emitted geometry was unbounded. The DECORATIVE scanned-
  floor fill traced every furniture-occlusion shadow and unhealed pinhole
  into its own hole subpath — a synthetic dense patchy room reproduced 200+
  hole rings (~86% of all emitted vertices) on a single room, scaling
  linearly with scan area — the wall mask can reach 1024² cells, and every
  classified unknown gap became its own dashed segment. The model now ships
  with budgets: the floor fill drops holes, keeps only the largest outer
  regions (≤ 24), and simplifies at twice the wall tolerance; every layer
  has a vertex budget (walls 3 500 / floor 1 000 / contents 500 ≤
  `PLAN_VERTEX_BUDGET` 5 000) enforced by proportional Douglas-Peucker
  tightening then smallest-ring dropping (`capRingVertices` — DP only ever
  removes raster vertices, nothing is fabricated); and dashed unknown gaps
  are deduped and capped at the 32 widest (`MAX_UNKNOWN_GAPS`) while the
  footer keeps reporting the full classified tally. The dense-room sheet is
  byte-size pinned in `tests/floorPlanBudget.test.ts`; the same budgeted
  model feeds the PDF embed. Floor AREA is still measured on the raw
  presence mask before any of this — the printed figure is unaffected.
- (2026-06-12 amendment) The floor-plan sheet reads like an actual floor
  plan: overall W × D dimension lines are drawn architecturally (extension
  lines off the plan corners, 45° ticks, the measurement written on the
  line, depth label rotated along its line); the dims line prints the floor
  area from the scanned-floor fill region — never the bbox product, so an
  L-shaped room prints its true ~68 m², not 80 (`tests/
  floorPlanSheetCalibration.test.ts` pins it against the model figure); and
  the wall poché renders at a 0.10 m architectural minimum (a stud wall is
  ≥ ~0.09 m — the 5 cm mask-cell strip read toy-like), with the stroke
  symmetrically widening the traced strip and a footer note keeping the
  honest MEASURED thickness on the sheet. Geometry is untouched and walls
  measured at/above the minimum keep a hairline outline only.
- With "Treat scan as" on Auto, the terrain Surface-Quality/Analyse panel
  could surface on its own for a scan whose settled verdict is interior: a
  sparse mid-stream frame can momentarily read as terrain, and the streaming
  re-evaluation flipped the session's panels to terrain before the
  fully-resident geometry corrected the verdict. The routing decision now
  lives in a pure, matrix-tested planner (`planScanRoute`): a streaming
  re-evaluation can only re-route TOWARD the Object/Space panel (its purpose
  is rescuing interiors/objects misread on a sparse early frame) and never
  flips the session to terrain, and the terrain pipeline NEVER auto-runs from
  detection — only the explicit "Run terrain contours anyway" hatch or a
  manual Terrain override expands the Analyse panel and starts an analysis,
  exactly as before. The "Treat as" control also stops hiding what Auto
  resolved to: while Auto stays the selected mode, its label reads
  "Auto (Interior)" (or Object / Terrain) and the detected pill carries a
  small accent dot plus an aria-description, so "detected as interior" is
  visible at a glance instead of living only in hover titles. Once the
  verdict SETTLES — the open-time detection of a fully loaded static file,
  or the one-shot re-evaluation when a streaming cloud reaches "Streaming
  ready" — the control soft-commits: the detected pill becomes the selected
  segment (aria-pressed), still wearing its "detected" accent dot so the
  auto-detected origin stays visible, and Auto reverts to a plain pill whose
  click re-runs detection. The commit is detection-sourced, never a manual
  override: no "(manual)" note, no routing pin (the streaming guards behave
  exactly as before — `planScanRoute` still routes on the effective type),
  it resets to Auto on every new scan and on any user click, and it only
  fires when the settled verdict matches the route actually standing (a
  settled terrain read against a standing interior route never claims the
  pill — the routing guard refused it). Sparse mid-stream frames only ever
  route, never commit. Route-matrix
  tests pin every cell: interior/object-detected + Auto ⇒ Object panel, no
  terrain panel, no run; terrain-detected ⇒ panel shown collapsed, still no
  auto-run; hatch and manual overrides still run; re-evaluation never flips
  to terrain and still rescues an early terrain misread into interior.
- The settled soft-commit above could silently never land on a streamed scan:
  the "Streaming ready" poll fired the settle one-shot on the FIRST
  scheduler-idle frame and spent it unconditionally — but the scheduler often
  reads idle at the root level (depth 0, the same reality the streaming
  benchmark's coarse-stable guard documents) long before the cloud fills in,
  so the one-shot ran on a sparse frame whose verdict was terrain (refused by
  the mid-session no-flip guard — no apply, no commit) or undecidable (gather
  empty — no commit possible), and the GENUINE settle later could never move
  the "Treat as" pill off Auto ("Streaming ready" + Terrain disabled with the
  interior reason + Auto still selected). Two guards now keep the one-shot
  THE settled verdict: a depth gate (`settleTargetDepth` — the settled
  evaluation isn't even attempted until the resident set spans the
  hierarchy's own depth, capped at 2, mirroring the coarse-stable guard) and
  spend-on-verdict (`settleOneShotSpent` — `applyScanRoute` reports whether
  detection actually reached a verdict, or routing is pinned/manual; an
  undecidable frame leaves the one-shot armed so the next ready poll retries
  on fuller geometry). Routing semantics are unchanged — a reached verdict is
  final whatever the planner did with it. The screenshot sequence is pinned
  end-to-end against the real planner + "Treat as" control (stream → early
  interior verdict → Object panel → settle confirms the same verdict ⇒ the
  Interior pill commits), alongside the premature-root-idle and
  undecidable-frame regressions (`tests/streamingSettleCommit.test.ts`).
- The interior floor-plan export was replaced with a wall-trace extraction
  pipeline (preview — the export is labelled "Floor plan preview" and marked
  experimental, pending visual validation against real scans). The old
  generator traced one blob around a coarse (≤48-cell) occupancy grid of the
  WHOLE cloud — floor, furniture, and ceiling smeared together — and drew
  fabricated straight "wall" lines along the bounding-box edges; on a real
  360 scan the result was an unrecognisable sketch. The new pipeline
  (`terrain/space/floorplan/`) runs: a wall-height
  point slice 0.7–1.8 m above the detected floor (full-height fallback when
  no floor exists), an adaptive 2–5 cm density-thresholded wall mask,
  morphological closing that bridges scan dropouts but is capped so doorways
  (≥ 0.6 m) always stay open, boundary vectorisation with Douglas-Peucker
  simplification, and dominant-axis snapping that only engages when the wall
  direction histogram is clearly bimodal at 90° (no fabricated right
  angles on round or irregular rooms). The SVG sheet now draws solid wall
  poché with door openings as real gaps, a light scanned-floor interior
  fill, a scale bar and overall dimensions in the measurement panel's unit
  system (metric or imperial first), the local-frame orientation note, and
  the standing suitability caveat; the Space Report PDF embeds the same
  model. Hardened against the real-360-scan failure modes the first cut
  still tripped over: the export now re-gathers at the terrain budget
  (300 k points) instead of reusing the 60 k routing snapshot, the wall-mask
  cell GROWS (to ≤ 0.3 m, still under any doorway) when the slice is too
  sparse to support 5 cm cells instead of starving into speckle, the slice
  is clipped to the occupancy-weighted dense footprint first so 360 noise
  arms can no longer inflate the sheet's extents (connected-component mass,
  not a per-cell threshold — random arm clusters don't survive), and a
  missing floor peak falls back to a robust low-percentile band anchor
  (plus one widened-band retry) instead of smearing floor + furniture +
  ceiling into the "walls" at full height — the floor FILL still requires a
  real detected floor plane, and the sheet states which basis was used.
  A realism pass (`floorplan/regularize.ts`) then makes the honest trace
  READ like a floor plan: compact off-wall islands in the wall mask —
  furniture, shelving, plants caught by the wall-height band (43 of the 70
  poché subpaths on the user's real 360 sheet) — are lifted out of the wall
  poché and drawn as light grey room-contents hints (the architectural
  convention; toggleable, and the sheet says so), with near-wall fragments
  kept as walls so a jamb return severed by a door gap is never erased;
  stair-step jogs of up to one mask cell merge into single straight wall
  lines at the runs' length-weighted mean; sub-0.25 m out-and-back spurs
  (flat-tip and V-apex) are cut back while door jambs survive by
  construction (a jamb's flanks are the wall run itself); and zero-width
  tracing slivers die a mean-thickness filter. A second realism round
  (`floorplan/centerline.ts`), driven by the surviving artifact classes on
  the user's next real 360 sheet (blobby double-wall mass with voids punched
  through it, splatter-shaped contents hints, and gaps the sheet could not
  tell apart from doorways), promotes the wall-thickness normalisation that
  was deferred: a chamfer distance transform plus Zhang-Suen thinning fit a
  centerline through every wall strip (loops and door gaps preserved by
  construction), medial-axis spurs shorter than the local half-thickness are
  pruned, and the walls re-extrude at min(local, measured-median) thickness
  clamped to the traced mask — echo-fattened runs (a wall scanned from both
  sides, clutter fused against a wall) collapse onto their centerline at the
  thickness the building actually measures, while clean walls round-trip
  bit-identically (the pass only ever removes excess; its output is a strict
  subset of its input, so it can never invent wall). Free-standing masses
  far thicker than the building's walls (kitchen islands, sofa groups)
  demote from the poché to the contents layer instead of being traced as
  fake architecture. Contents hints simplify to the convex hull per blob —
  the honest "something stands here, about this big" footprint instead of
  raster splatter. And wall gaps are now CLASSIFIED by jamb evidence
  (`classifyWallGaps`): two wall ends whose runs point at each other
  squarely (within ~23°) across a clear 0.55–1.4 m opening are a doorway
  and stay genuinely open; facing ends without that evidence — ragged/skewed
  ends, non-door widths up to 2.5 m — are honest UNKNOWN gaps drawn as a
  dashed line on the SVG sheet and the Space Report PDF ("the wall may
  continue here; the scan can't say"), and anything wider stays an
  undecorated hole. The sheet's footer reports the collapsed echo mass, the
  demotions, and the door/unknown gap tally. The plan sheet and
  the Space panel also stop disagreeing about size (the real sheet read
  12.9 × 15.0 m while the panel claimed 24.72 × 13.76 m): the panel's
  dimensions now clip 360 noise arms with the SAME dense-footprint rule the
  plan uses (the model exposes the clip bbox), and both report the strays
  they excluded. Synthetic-room tests pin walls to within 5 cm + one cell,
  door preservation, floor area to ±2%, an L-shaped room's reflex corner,
  50% wall-dropout healing, a sealed two-room scan keeping BOTH room
  interiors (every loop above the speckle floor survives, never just the
  largest), a 4%-density strided sample staying traceable via the grown
  cell, a 20 m noise arm being clipped (extents stay the room's), the
  percentile and widened-band anchors, and the honest empty result below
  500 points; the realism round adds a 1 × 0.5 m mid-room island leaving
  the poché for a contents hint, a jittered wall straightening to one line,
  a 0.15 m stub spur dying while both door jambs survive, hand-truth jog /
  spike / sliver cases, and a plan-vs-panel extents cross-check on the
  noise-arm scene; the centerline round adds hand-computed chamfer
  distances, a fat strip thinning to a 1-cell line and a wall loop keeping
  its loop, spur-prune survivor/victim pairs, a clean room round-tripping
  through the normaliser vs a 0.5 m echo-fattened wall collapsing to the
  median, a free-standing fat mass demoting to contents, square-jamb /
  skewed / over-wide / L-corner gap classification truth, convex-hull
  containment, and an end-to-end double-walled room whose door classifies
  by its jambs while the echo mass collapses.
- The surface-quality panel's reason sentence no longer mislabels the
  edge-risk chip's figure. The chip (cellMetrics' edge-risk ratio) counts
  MEASURED cells sitting near the data boundary — cells with real returns
  that are merely least supported — but the Limited/Preview reason called
  that same number "cells that are a long interpolation from real returns",
  which describes the OTHER edge metric (the gate's tally of interpolated
  cells far from any measurement). The reason now reads "N% of measured
  cells sit at the edge of the data, where the surface is least supported";
  the gate's own wording (where the phrase is true) is unchanged. A field
  fixture pins the interior-360 case (Limited 52/100, interpolation 72%,
  edge risk 53%) so the chips and the reason sentence provably quote the
  same numbers.
- Activating Measure no longer opens the Measurements panel on top of the
  measure toolbar. The centred toolbar and the left panel column both
  anchored to the same `top: 56px` band, and entering measure mode
  auto-opens the Measurements panel into that column — so the panel painted
  over the toolbar's left half and hid the first kind pills (Distance /
  Polyline / Area…). The toolbar's height is dynamic (pills wrap at narrow
  widths, Finish polygon comes and goes), so instead of a static offset a
  ResizeObserver now mirrors the toolbar's real height into a CSS custom
  property (`--olv-measure-bar-clear`) that pushes the panel column — and
  its scroll budget — below the toolbar while it is visible, at every
  viewport width including phones, and snaps it back up when measure mode
  exits. The embed's `?measurements=1` path gets the same guard.
- Hardened the measurement stack against crash-class degenerate inputs after
  a report of the app dying mid-session with many chained distance
  measurements placed. The measurement-label collision layout — which runs
  inside the per-frame render loop and scales with the number of placed
  measurements — is now bounded by construction: a non-finite label anchor (a
  vertex projected at the camera plane) is placed as-is instead of joining
  collision tests, a push-down move must make strict progress so a float
  boundary can never re-trigger forever, and a hard pass cap converts any
  residual pathology into a cosmetic overlap instead of a frozen tab. The
  profile chart's elevation-tick and station-grid walks, and the profile
  PDF's grid loops, are guarded the same way: a denormal elevation span used
  to underflow the tick step to zero and push gridlines until the tab ran out
  of memory, and a corrupt (non-finite) chainage sample made the station walk
  infinite — both now degrade to an honest minimal axis or the "nothing to
  plot" branch. Chain aggregates and the station table tolerate unknown
  measurement kinds / dimensions from forward-compat session files instead
  of throwing in the panel's render path, and every degenerate unit factor,
  zero-length segment and NaN value is pinned to its honest "—" fallback by
  a new regression suite (`tests/measureCrashGuards.test.ts`).
- Replaced the "Fitness-for-use" wording stamped on PDF reports and export
  provenance (profile sheets, terrain/space reports, DXF/SVG/GeoJSON/README
  stamps) with plain language. The standing note now reads "Suitability: not
  survey-grade unless validated against ground-truth control." — same honesty
  contract, no QA jargon.
- Clicking "Terrain" in the TREAT SCAN AS control on an interior / object
  scan no longer shuts the Space/Object panel down into a dead end. The
  click tore the panel down and handed off to the Analyse panel still in its
  collapsed-chip state — the busy status, the (usually blocked) terrain
  result, and the Treat-as control that is the only way back were all hidden
  under the chip. The Terrain segment is now disabled with the visible
  reason while detection reads the scan as an interior or compact object
  (the explicit "Run terrain contours anyway" escape hatch remains the
  deliberate override); when terrain IS forced, the Analyse panel expands so
  the result and the way back are on screen; and switching back to
  Object / Interior / Auto always restores the Space/Object panel — even if
  geometry gathering fails at that moment it renders its honest empty state
  instead of tearing down.
- The live-deployment build no longer loses lazy feature chunks. Four
  dynamic `import()` calls lived inline in modules the deploy transform
  rewrites, which scrambled their specifiers: the Planetary Computer
  catalog search and the Visuals Studio Auto-balance chunks were silently
  never emitted (both features dead on the deployed site, working in a
  source checkout), and the idle-time LAS-loader pre-warm fetched a raw
  `/assets/io/loadLas` URL — a 404 logged on every boot. All four imports
  now route through the `lazyChunks.ts` seam that exists for exactly this,
  and the chunk-emission guard pins them so a re-inline fails the build
  loudly instead of shipping silently broken features.
- The Space panel no longer reports sideways metrics on 360-style interiors
  whose walls are densely scanned and whose floor is sparse or cluttered. The
  up-axis detector used to crown a dense flat wall as the "floor" — every
  figure on the panel (height, floor area, the floor-plan sketch) was then
  computed in a sideways frame, which is how a 5 m-tall room reported
  H = 23 m and exported a side elevation labelled as a floor plan. Detection
  now treats Z as the incumbent (point-cloud formats are Z-up by spec): a
  horizontal axis must beat it by a clear margin, full-height wall-like
  columns no longer count as floor evidence, and ties resolve to Z instead of
  X. On top of that, LAS/LAZ and streamed COPC/EPT scans now tell the
  detector their frame outright — the up-axis guess only runs at all for
  formats whose frame is genuinely ambiguous (PLY, OBJ, glTF), where it still
  detects Y-up phone scans exactly as before.
- Elevation profiles are now sampled along the scan's actual up axis. The
  sampler was hardcoded to Z-up, so a profile cut through a Y-up phone scan
  measured "height" along a horizontal axis.
- Measurements on foot-based coordinate systems now read in true units. The
  measure stack assumed render coordinates were metres, so a 10 ft span on a
  US-survey-foot scan displayed as "10 m" — wrong by a factor of 3.28 — in
  every readout: the distance/area/volume headlines, the on-canvas labels,
  the live placement hints, chain aggregates, the profile chart axes, the
  profile summary, the station data and the CSV/PDF exports. The scan CRS's
  linear-unit factor (the same seam the terrain and space panels already
  read) is now threaded into the measurement controller and applied exactly
  once at its display boundary — lengths ×f, areas ×f², volumes ×f³, and the
  profile sample series before it fans out — so formatted labels and raw
  chart numerals can never disagree. The measurement table in generated
  report PDFs (all six Report Engine templates) applies the same factor at
  its own formatting boundary, so a report handed to a client agrees with
  the on-screen panel to the digit. Metric and local scans are unaffected.
- The profile PDF no longer discards what the app already knows. Every sheet
  printed "auto (5 % of length)", "p25" and "Horizontal CRS — (not
  georeferenced)" even when the CRS service had resolved the frame and the
  sampler had used concrete parameters. The corridor width and ground
  percentile that actually shaped the estimate are now stamped onto the
  measurement when it commits, the resolved CRS and vertical datum are read
  at export time, and all of it lands on the sheet — in the summary block
  and in a compact provenance line in the header.
- The profile chart's vertical-scale control is now honest. The chips said
  "1:1 / 2:1 / 5:1 / 10:1", but the chart never drew true ratios — it
  stretches with the resizable panel, so "1:1" depended on how the panel was
  dragged, and at higher settings the curve silently spilled past the plot
  frame. The chips now read "Fit / 2× / 5× / 10×" (multiples of the fitted
  elevation scale), the curve is clipped to the plot box so relief leaving
  the visible band reads as a deliberate crop rather than a glitch, and the
  in-chart badge says the same thing. True stated 1:N scales remain on the
  PDF export, which computes real paper ratios.
- Imperial elevation tick labels on the profile chart no longer collapse
  into duplicates on sub-metre relief — they carry the decimals the tick
  step needs instead of rounding to whole feet. The chart tooltip's Δh also
  honours the unit toggle now, instead of always printing metres.
- The profile PDF sheet honours the unit toggle. The builder grew imperial
  support in this cycle's unit sweep — feet on the elevation axis and grid,
  US 100-ft stationing on the chainage axis, converted summary and station
  table — but the export button never told it which system was active, so
  every sheet still printed metric regardless. The panel now passes the
  same unit system the chart and CSV already read, and a sheet exported in
  imperial mode is imperial end-to-end: axes, gridline labels, summary
  block (length, relief, gain/loss, extremes, corridor) and the station
  table.
- XYZ and CSV exports of geographic (lat/lon) scans no longer truncate
  position to street-block precision. Coordinates were always written at a
  fixed 3 decimals — millimetres on a projected CRS, but ~110 m on a degree
  axis. When the cloud's CRS is geographic, x and y now carry 7 decimals
  (1e-7° ≈ 1 cm at the equator); z stays at 3 decimals, since heights are
  linear units even in a geographic CRS. Projected and local exports are
  byte-identical to before.
- The converter no longer reports "reprojected" as a clean success when the
  datum leg of the transform is known to be missing or degenerate. GDA94 →
  GDA2020 resolves to an identity shift here (the true plate-motion
  difference is ≈ 1.8 m), and NAD27 transforms run without NADCON grids
  (errors of 10 m or more) — both used to log the same success line as a
  genuine transform. They now log an explicit warning naming the problem, and
  the conversion report's CRS status says "APPROXIMATE datum shift" instead
  of a bare "reprojected". Same-datum reprojects and a skipped/unresolvable
  reproject behave as before (the latter already warned loudly).
- A skipped reproject no longer stamps the metre GeoKey on the output LAS.
  The linear-unit tag keyed off the requested MODE, so when the transform
  could not be resolved and the file stayed in its source (possibly
  US-survey-foot) CRS, it was still tagged 9001 "metre" — a unit lie baked
  into the deliverable. The tag now follows what actually happened: applied
  reproject → metre, skipped reproject / keep → the source CRS's own unit.
- Density, spacing and the USGS Quality Level now describe the scan, not the
  analysis subsample. Every analysis path strides big clouds down to a budget
  (≤ 60 k for the space panel, ≤ 300 k for terrain), but the density figures
  divided only the sampled count by the area — a stride-100 scan read 100×
  too sparse, the object panel's median spacing was inflated ~√(N/2000), and
  the QL grade judged the subsample instead of the survey. The space panel
  now scales by its known source count (and says so in its caveats), the
  object metrics correct the nearest-neighbour probe by √(P/N), and the
  terrain pipeline accepts the gather's stride (`samplePointScale`) and
  multiplies per-cell densities back to the scan before the QL grade is
  assigned. Coverage, confidence and RMSE are untouched — they genuinely
  measure the analysed points.
- The hold-out validation now builds its surface exactly like the live
  pipeline. It used to skip the blunder despike and the extrapolation guard
  and dropped the horizontal-unit scale, so the RMSE — and the confidence
  calibration fitted from it — measured a *different* surface than the one
  delivered. Both paths now construct their grid through one shared
  raster→grid constructor, making the divergence structurally impossible.
  The per-slope/zone residual tables also bin points with the same floor
  convention the raster was built with; the old `Math.round` attributed
  half of every cell's points to the neighbouring cell. The confidence
  calibration fitted from the unified validation additionally requires a
  minimum per-bin sample count before a bin may shape the curve — a
  2-sample bin's 50 % "reliability" is a coin flip, and because the remap
  extrapolates flat past its end knots, one near-empty noisy bin could
  drag every low-confidence cell on the live grid down with it.
- LAS export headers now tell the truth twice over: returns above the
  histogram range (> 5 for LAS 1.2's legacy tally, > 15 for 1.4's extended
  tally) clamp into the top slot to match how the point records clamp the
  field, instead of being counted as first returns; and the header min/max
  bounds are written from the quantised values the records reconstruct,
  not the raw input doubles — strict validators no longer flag points
  "outside the header bounds" by half a scale step.

- The onboarding tour is no longer keyboard- and screen-reader-hostile.
  Key terms in step copy ("colour mode", "Visuals Studio", "Chain") used
  to read as raw selection-blue text; they now render as properly themed
  highlights, and the card itself can no longer be accidentally
  text-selected by rapid Next-clicking. The card announces itself as a
  modal dialog (role, aria-modal, labelled by its title and described by
  its body), focus lands on the Next button at every step and Tab cycles
  within the card's buttons instead of escaping into the page behind the
  backdrop. Arrow keys step forward and back, Enter advances, and Esc now
  does what the welcome copy always promised — skips the tour and
  remembers that, instead of silently re-showing it next session. The
  step text is a polite live region, so each step's copy is actually
  announced even though focus stays parked on Next. The "Open a scan"
  step now spotlights the empty state's real open button — its old
  selector pointed at a dock button that has never existed, so the
  spotlight silently failed on every first run — the Measure step gained
  a stable hook on the dock button (its old selector matched only the
  enabled-state tooltip text), and a step whose target is present but
  hidden (the dock collapses on the empty state) now centres its card
  instead of pinning a 16-pixel spotlight to the screen corner.

### Added

- (2026-06-12 amendment) Floor Plan Preview sheet refinements — presentation
  and threading over data the pipeline already computes (the wall-graph /
  room-segmentation engine itself stays scheduled for 0.4.6; the export
  remains a labelled, experimental preview):
  - ARCHITECTURAL SHEET STYLING: the wall poché prints in near-black #111
    architectural ink on the white sheet (theme-agnostic), dimension and
    extension lines draw thinner (0.55 px), every CLASSIFIED doorway gets a
    door-leaf swing symbol (quarter-circle arc from one jamb, radius = the
    clear gap width, opening toward the plan centre — a drawing symbol, not
    a hinge-side claim), and a tidy bottom-right title block carries title,
    overall dims, floor area, scale text (nominal ratio + the graphic bar,
    which stays the trustworthy reference) and date, like a real sheet.
  - APPROXIMATE REGION AREAS: each kept floor-fill region prints its own
    polygon area ("≈ 12.3 m²") centred in regions ≥ 3 m² whose extent fits
    the label (centroid-inside check, no label squeezed into a sliver), and
    the footer lists every region's area. Labelled honestly as approximate
    scanned-floor extents — these are the floor-fill regions, NOT
    wall-measured rooms (that needs the 0.4.6 wall graph).
  - WALL CONFIDENCE: every wall ring now carries an OBSERVED fraction —
    its outline sampled against the PRE-CLOSE density mask, so cells filled
    by morphological closing read as interpolation, not observation
    (`wallRingObservedFrac`, threaded through the model). Rings under 60%
    observed (`OBSERVED_FRAC_MIN`) render as a yellow-tinted poché with the
    footer note "Tinted walls: interpolated from sparse evidence…" — coarse
    and honest, a boundary-sample statistic, not a survey confidence figure.
    Hole rings follow their containing outer so the poché stays punched.
  - SNAP CONTROL: the dominant-axis snap is now governed by a documented
    `SNAP_MODE` constant in `vectorize.ts` — 'auto' (default: snap only when
    the direction histogram is clearly bimodal at ~90°, exactly the previous
    behaviour), 'off' (never snap), 'strong' (force the strongest axis when
    the auto gates fail; the sheet footer then says right angles may be
    assumed where the scan shows none). A UI control is deferred; the
    resolver (`resolveSnapAxes`) reports mode + forced-ness for the footer.
  All four are pinned in `tests/floorPlanQuickWins.test.ts` (door-arc count
  and radius per classified doorway, area labels within ±2% of the region
  polygon area, observed-fraction threshold + tint partition, snap modes),
  and the sheet was render-verified in headless Chromium.
- A colourblind-safe "Confidence" colour mode — the Cividis twin of the
  Coverage trust overlay. The coverage mode's traffic-light ramp says the
  right thing but says it in colours ~8 % of users cannot tell apart, so
  the per-cell DTM confidence now also renders on three exact Cividis
  stops (the one palette the catalogue tags fully colour-blind safe):
  bright = strong (measured), mid = moderate (interpolated), dark = weak
  (extrapolated / gap) — deliberately the t 0.2 stop rather than the ramp
  floor, which would vanish into the dark canvas and read as "no data"
  instead of "untrustworthy data". The buckets are the SAME
  `gradeForConfidence` thresholds the coverage minimap legend, the
  dashed-contour evidence and the click-to-sample readout use, and the
  3D mode shares the coverage mode's grid-lookup core, so the two
  overlays can disagree only about hue, never about which cell a point
  samples or how trusted it is. Empty cells stay neutral grey (3D) or
  transparent (2D raster) — a hole is never painted as a confidence. The
  chip sits next to Coverage on the Inspector's COLOR BY rail (both
  analysis-gated, with the same "Run terrain analysis first" tooltip
  until a grid exists), and the Analyse panel's coverage tile gained a
  "Colour 3D by confidence" link that paints the tile's own buckets onto
  the cloud.
- Real raster icons for the web manifest. The manifest declared only the
  SVG favicon, so the installable-app baseline (a 192 px and a 512 px
  PNG) was unmet and install surfaces fell back to whatever they could
  scrape. `public/icon-192.png` and `public/icon-512.png` are rasterised
  from the official logo asset (see the brand bullet under Changed) by a
  new `scripts/make-brand-rasters.py` (Pillow, supersampled master so
  edges stay crisp at 192 px) and declared in `manifest.webmanifest`
  with `purpose: "any maskable"`. The same script also renders the
  180 px apple-touch-icon, the 16/32/48 `favicon.ico`, the vector
  `favicon.svg` and the `og-card.jpg` share image from the identical
  source, so every identity surface regenerates from the one logo file.
- Terrain Intelligence Report. One click on the Analyse panel
  ("Intelligence report (PDF)", next to the DEM and map-sheet exports)
  assembles everything the app already computed about a surface into a
  client-facing PDF. It opens with an Executive Summary — the assessment's
  own verdict sentence (status plus reason), the export readiness with its
  reason, and what the surface is honestly best for; never new prose —
  then Dataset Statistics: scan metadata plus, when the Inspector's
  Dataset Intelligence card has them, the card's exact density /
  complexity / ground-visibility / metric-stability bucket labels (the
  rows are simply omitted when the card is empty, never re-derived). The
  body carries the terrain assessment with its 0–100 score and reason,
  coverage analysis (measured / interpolated / empty / edge-risk ratios
  and mean confidence), the ASPRS/USGS quality metrics when they were
  measured, deduped warnings with their figures, the recommended-workflow
  checklist, the SAME six-product Terrain Products status list the panel
  leads with — one projection feeds both, so the PDF and the panel can
  never grade a product apart — and how-to-improve fixes when the surface
  is not fully good. Every string is sourced from an existing module — the
  report can never disagree with the on-screen panel — and the footer
  carries the same unified provenance block (software version, metric
  version, CRS, datum, coverage mode) every other export stamps, pinned by
  the cross-export provenance-consistency test. Unknown values print as
  em-dashes, never fabricated zeros, and the standing not-survey-grade
  note is always present.
- Workflow presets in the Visuals Studio. A new chip row — Terrain ·
  Construction · Mining · Forestry · Hydrology · Archaeology — sets up the
  whole look for a job in one click: colour mode, EDL depth shading, point
  size and sizing mode, background, and how much of the elevation band the
  height ramp spans (Mining and Hydrology use the untrimmed band so pit
  floors and subtle channels keep colour resolution; Archaeology pairs the
  strongest depth-edge shading with fine fixed points for micro-relief).
  Every preset is a pure bundle over knobs that already existed — no new
  rendering machinery. Hand-adjust any of those knobs afterwards and the
  rail switches to a "Custom" state chip instead of pretending you are
  still on the preset; clicking a preset returns to it exactly. The pills
  expose their pressed state through `aria-pressed`, so a screen reader
  hears which preset (or "Custom") is active instead of a colour-only
  highlight.
- Profile summary. Every profile now shows the civil headline numbers under
  its chart — length, elevation gain/loss, average grade, max grade, the
  steepest section as a station range, and the highest/lowest points with
  their stations — in the active unit system. The same summary is printed on
  the profile PDF sheet, computed by the same code, so the panel and the
  print can never disagree. Figures are only derived between adjacent covered
  stations: a coverage gap contributes nothing, and an unmeasurable figure
  reads "—", never 0.
- Profile CSV export. A "CSV" button next to the profile's "Export PDF"
  downloads the station data — station, chainage, ground elevation, the
  corridor point count behind each elevation, and grade to the next station —
  in the active unit system, with the unit named in the column headers. The
  station table was previously locked inside the PDF.
- In-panel station table. Each profile row now carries a collapsed "Station
  table" disclosure under its summary with the exact station / chainage /
  elevation / points / grade values — built from the same rows the CSV
  exports, so the screen and the file can never disagree. It is also the
  chart's accessible counterpart: the decorative SVG used to point screen
  readers at a station table that did not exist in the panel.
- Profile sampling controls. The parameters that shape every profile —
  corridor half-width, ground percentile, and sample count — are now
  user-settable, per profile, from a small disclosure under the chart whose
  always-visible caption states the values that actually produced the line
  ("Corridor ±2.5 m · ground p25 · 64 samples" — the same numbers the PDF
  header prints). Changing a value re-samples immediately; out-of-range
  inputs clamp to sane bounds (corridor 0.05–500 m, percentile 0–100; the
  sample picker offers 32–512 bins) rather than erroring; Reset returns to the defaults
  (auto corridor at 5 % of length, p25, 64 bins). On foot-CRS scans the
  corridor you type in display units is the corridor the sampler walks —
  the same unit seam the readouts use, applied in reverse. A 1 km section
  no longer silently aggregates a 100 m swath at ~16 m bin spacing with no
  way to see or change either. The values you settle on persist: they are
  remembered across reloads and applied to the next profile you draw, and
  Reset clears the remembered preference along with the row. Rapid edits —
  a held spinner arrow — coalesce into one re-sample instead of one per
  step.
- Intensity and classification ride along in XYZ/CSV exports. The columns
  appear only when the cloud actually carries the channel — raw 16-bit
  intensity and the raw ASPRS class code, after the r/g/b columns — and
  they are never a guessing game for the next tool: the CSV header row
  names every column, and an XYZ with the extra columns starts with a
  `# columns: …` comment line (a plain x-y-z export stays byte-identical
  to earlier releases). Both channels previously vanished on the way out.
- Terrain Products. The Analyse panel now leads with a compact status list —
  Profiles, Measurements, Terrain review, DTM/DEM export, Contours, Map
  sheet — each marked Ready ✓ / Preview ⚠ / Blocked ✕, and every product
  sitting below Ready carrying its own full "Reason:" line on a second row
  that wraps (the first cut ellipsized the reason into one line — "Preview
  Insufficient qua…"). The reason is the most specific string the readiness
  engine already minted for that product (`productReasonFor`): the export
  reason naming the exact georeferencing gap ("vertical datum unknown") when
  that is what holds a deliverable back, otherwise the assessment's surface
  line quoting the measured figure ("50% of the surface is interpolated"),
  with the short workflow note only as a last resort — and Ready rows carry
  no reason at all. The Terrain Intelligence Report's products section
  prints the same engine-selected text, word for word. It re-presents the
  assessment the panel already computed (nothing is re-judged), the status
  travels as a word next to the icon rather than by colour alone, and the
  original "Recommended workflow" checklist remains available beneath it,
  collapsed.
- Contour DXF files now open in CAD with their units declared and their
  labels attached. A minimal HEADER section carries `$INSUNITS` (metres by
  default, feet / US survey feet when the CRS resolves to them, honest
  "unitless" when unknown), so imports stop prompting for — or silently
  assuming — drawing units. The elevation labels that previously existed
  only in the SVG and PDF now ride along as TEXT entities on their own
  CONTOUR_TEXT layer, so they can be frozen or restyled independently of
  the linework.
- Contour SVG labels carry the decimals their interval needs — a 0.25 m
  interval prints 10.25 / 10.50 instead of collapsing every level onto
  "10" — and every sheet now states its interval and scale in the visible
  drawing ("Contour interval 0.5 m · 1 SVG unit = 1 m"), since the file
  previously carried no unit or scale cue a reader could see.
- Georeferenced ortho export. On a scan with a known CRS and world origin,
  the Studio's "View capture" (Orthographic RGB) button now renders a true
  top-down orthographic frame of the full footprint and downloads it as a
  small ZIP — the PNG plus a `.pgw` world file and a `.prj` — that QGIS and
  ArcGIS place exactly. The framed render is the only raster an affine
  world file can honestly describe, so the perspective view capture is
  never given one: scans without a CRS or origin, multi-cloud sessions
  with conflicting frames, and class-filtered exports (whose caveat banner
  would corrupt a placed raster's pixels) all keep the existing bare-PNG
  download and filename. The `.prj` is deliberately impossible to attach
  to local-frame coordinates (the v0.4.3 contour-georeferencing lesson,
  applied by construction).

### Changed

- (2026-06-12 amendment) Claim-accuracy wording pass on the two places the
  product talked itself up beyond its validation evidence. The interior
  floor-plan export is now labelled **"Floor plan preview"** everywhere the
  user sees it — the Space-panel button (with an "experimental — requires
  visual validation" note beside it), the standalone SVG sheet (subtitle
  "Floor Plan Preview — approximate wall-trace sketch" plus the same
  experimental caveat in the footer's warning style), and the Space Report
  PDF's embedded-plan section — code and module names are unchanged. And the
  standing deliverable-note wording minted by the readiness engine changed
  from "preview only — not for final deliverables" to **"preview only —
  additional validation recommended"** at its single source
  (`readinessEngine.deliverableNote`), so every consumer — the workflow
  checklist, Terrain Products rows, the Terrain Intelligence Report, and
  every DXF/SVG/GeoJSON/README provenance stamp — inherits the new wording
  verbatim; docs and the pinned test literals were updated to match. No
  behaviour change, wording only.
- The workflow recorder is disabled for this release (product decision).
  Its original `Cmd/Ctrl+Shift+R` chord collided with the browser's
  hard-refresh — toggling a recording reloaded the page and lost the live
  session — and rather than ship a mid-cycle rebind that risks fresh
  shortcut-collision confusion, the feature is switched off entirely while
  the "Replay a workflow file…" experience (the recipient must already have
  the same scan open) gets a proper design pass. The shortcut, the three
  Workflow command-palette actions, the shortcut-sheet entries and the
  recording badge are all absent in this build; `.olvworkflow` recording and
  replay will return in a later release. When it does, the shortcut will be
  `Cmd/Ctrl+Shift+U`: `U` is unbound in Chrome, Firefox and Safari, Edge's
  Read Aloud on `Ctrl+Shift+U` is page-interceptable (unlike reserved combos
  such as `Cmd+Shift+W` / `Cmd+Shift+T`), and no in-app binding uses `U`,
  bare or modified. The recorder engine and its unit tests remain in the
  tree behind the `WORKFLOW_RECORDER_ENABLED` flag in
  `src/ui/WorkflowController.ts`.
- The export-readiness verdict now has exactly one author. The same
  judgement — Ready / Preview / Blocked, the reason naming what holds it
  back, and the per-product good / caution / blocked grades — was derived
  or re-quoted with private mapping tables in four places (the terrain
  assessment minted the tier and reason inline, the recommended-workflow
  checklist re-graded it with its own note table, the Terrain Products
  list renamed the grades with a third table, and the provenance stamp
  and report rows each formatted the "Tier — reason" line themselves), so
  a future edit to any one table could have let an exported file grade a
  product differently from the panel. All of it now lives in
  `terrain/quality/readinessEngine.ts` — one `deriveReadiness` function
  returning `{tier, reason, productGrades}`, plus the shared word / glyph
  vocabulary and the one "Tier — reason" formatter — and every former
  author is a view over its output. No string changed: the engine was
  conformed to the existing wording, and the provenance-consistency and
  report-content suites pass unchanged; a new suite pins the
  single-source contract by swapping the engine's verdict for a sentinel
  and watching it surface verbatim in the assessment, the workflow
  checklist, the products list, every provenance stamp and the report.
- The brand now derives from the official OpenLiDARViewer logo file — no
  redrawn geometry anywhere. The invented orbit-rings mark that
  previously carried the identity (and the interim plain placeholder
  tile that briefly replaced it) are both gone; every identity surface
  is produced from the delivered asset itself. `public/brand-logo.svg`
  is the logo verbatim (the point-cloud-orb mark plus its raster
  wordmark band), and `public/brand-mark.svg` is the same file with only
  its root viewBox cropped to the mark region — nothing repainted. The
  in-app top bar and empty-state hero render that mark via `<img src>`
  (the asset never passes through the `unsafeHtml` escape hatch, so the
  XSS-guard allowlist keeps no brand entries), with the wordmark kept as
  real text beside/beneath it for light-theme and screen-reader
  legibility. All raster assets are RASTERISED from the logo file by the
  new `scripts/make-brand-rasters.py` (which retires the Pillow redraw
  script `make-manifest-icons.py`): `favicon.svg` is the mark's own
  pixels downscaled onto the #0a0e1a plate for contrast,
  `icon-192.png` / `icon-512.png` put the mark on the rounded brand-dark
  plate, `apple-touch-icon.png` is full-bleed with no alpha for iOS,
  `favicon.ico` (16/32/48) is the real asset downscaled — soft at 16 px
  by honest choice rather than redrawn — and `og-card.jpg` (1200×630)
  now carries the full official lockup on the deep-navy field with the
  "Visualize. Explore. Understand." tagline in cyan beneath it.
  `public/BRANDING-TODO.txt` is deleted: the logo arrived.

## [0.4.4] - 2026-06-09

Final release. Sections below fold in the post-audit hardening batch.

### Added

- Dropping several files at once now says what happened: the first file opens
  as before, and a toast names it and reports how many companions were
  ignored, pointing at the batch converter — instead of silently discarding
  everything past the first file.

- The batch converter can write LAS 1.4 (point data record formats 6/7), and
  it is now the default output format. The extended records carry the full
  8-bit classification, so classes above 31 — class 64, vendor codes up to
  255 — survive conversion intact where LAS 1.2's 5-bit field destroyed them
  (the audit defect). Format 7 is picked automatically when the cloud has
  colour (RGB upscaled 8→16 bit losslessly), format 6 otherwise; up to 15
  returns are tallied into the extended uint64 by-return counts. When the
  source carries a WKT CRS and coordinates are kept, the WKT travels into the
  1.4 file with the global-encoding WKT bit set (as the spec requires for
  formats 6+); when only an EPSG is known, the GeoKey tag is written instead
  and the log says so. These extended records are also what COPC requires, so
  this writer is the foundation for future COPC output.

### Changed

- The previous LAS output is now labelled "LAS 1.2" (next to "LAS 1.4") so the
  version choice is explicit, and it warns per file — instead of staying
  silent — when its 5-bit classification field clamps classes above 31,
  pointing at LAS 1.4 as the lossless choice.
- The Export panel now defaults to LAS 1.4, matching the batch converter's
  recommended format instead of pre-selecting the lossy LAS 1.2 legacy choice.
- Faint UI text (`--text-faint`) is lighter in the dark theme and darker in
  the light theme so hints, captions and placeholders clear WCAG AA contrast;
  the high-contrast theme already passed and is unchanged.
- The tool dock's toggle buttons (Measure, Inspect, Probe, Annotate, Analyse)
  keep a stable label and expose their on/off state through `aria-pressed`
  instead of swapping to "Measuring…"-style text — screen readers now hear
  the toggle state, and the dock no longer shifts layout on every toggle.
- The synchronous main-thread terrain fallback (used only when the analysis
  worker fails) now has a 1 M-point ceiling. Every production caller strides
  the analysis sample to ≤ 300 000 points, so the ceiling never fires today —
  it protects future full-resolution callers from a silent main-thread freeze
  by failing with a clear message instead.

### Fixed

- The Dataset Intelligence card — and every provenance stamp fed from the same
  constant: terrain reports, DEM-package READMEs, contour exports, space
  reports — no longer claims "Metric Version v0.4.1". The shared
  `TERRAIN_METRIC_VERSION` was not bumped when 0.4.4 changed the metric
  definitions (the aspect north–south mirror fix, cell-centre contour
  registration, and the compound-WKT horizontal-unit fix all change what the
  metrics report for the same cloud); it now reads v0.4.4 and its doc comment
  records why.
- The Dataset Intelligence card's "Analyzed Points" row no longer reads "0"
  forever on streamed COPC / EPT scans. The attach-time summary honestly
  starts at 0 (nothing analysed yet), but nothing ever updated it; a finished
  terrain run now folds its real analysed-point count — the same
  `dtm.analyzedPointCount` the terrain report's "Analysed points" row prints —
  back into the card, so the card and the PDF agree.
- The Help overlay's shortcut list no longer drifts from the actual bindings:
  it now lists the T / O / P camera presets, L (lasso volume), H (controls
  HUD) and Cmd/Ctrl-K (command palette), and the `?` entry says what `?`
  really does — open the keyboard shortcut sheet, which owns that key.
- Load-status announcements for screen readers now come from two permanently
  rendered, visually hidden live regions (polite status + assertive alert)
  instead of the toast itself — a toast hidden with `display:none` leaves the
  accessibility tree, so its announcements fired unreliably or not at all.
- The `?debug=1` overlay's frame stats now include streamed COPC / EPT
  clouds: resident points fold into the displayed count and GPU byte
  estimate, and the source's total point count folds into the total —
  previously a streamed scan reported zero points while clearly on screen.
- Contour exports from a streamed COPC / EPT scan keep their world origin
  and EPSG stamp: the map context now falls back to the streaming source's
  render origin and CRS when no static cloud is active, instead of silently
  degrading to a local frame.
- The scalar sRGB → linear EOTF copies in the photometric patch view and the
  colour-provenance card now delegate to the shared seam in `colorEncode.ts`,
  so the curve can no longer drift from what the GPU pipeline applies.
- Eye Dome Lighting obscurance is no longer computed in the wrong depth space.
  The renderer draws with a logarithmic depth buffer, but the EDL pass was
  inverting its depth samples with the standard perspective formula
  (`perspectiveDepthToViewZ`) — decoding log-encoded values as if they were
  perspective depth, so the depth cue read far too weak up close and erratic
  at range, silently defeating the unit-tested EDL maths. The pass now applies
  the matching logarithmic inversion,
  `eyeDist = near′ · 2^(depth · log2(far / near′))` with `near′ = max(near,
  1e-6)` — the exact inverse of three.js's near-anchored log-depth encoding on
  both the WebGPU backend and the WebGL 2 fallback — and keeps the perspective
  path for a renderer built without log depth. The depth mode is read back off
  the renderer at construction rather than assumed, and the inversion is
  pinned CPU-side by new unit tests (`logDepthToEyeDistance` in `edl.ts`),
  following the same mirrored-math pattern as the splat shader.
- Clicking Cancel on an in-flight "Open from URL" load no longer instantly
  restarts the very load it just aborted. The cancel handler flipped the
  button back to `type="submit"` while the click event was still
  dispatching, so the browser evaluated the click's default action against
  the new type and re-submitted the form — Cancel aborted the stream and
  then immediately kicked off the same request again. The handler now
  suppresses the click's default action before cancelling, so Cancel means
  cancel.

### Notes

- New regression tests pin provenance consistency across every exporter — the
  DEM README, contour GeoJSON / DXF / SVG, map-sheet PDF and terrain report
  are driven from one analysis run and must agree word-for-word on the
  surface-quality and export-readiness verdicts, CRS, datum, accuracy and
  software stamps — and pin the terrain-core fallback's stale-result
  (abort-during-worker-failure) and oversize (`MAX_FALLBACK_POINTS`) guards.
- A static-analysis guard now pins every `unsafeHtml` call site to a
  hand-reviewed allowlist — all seven current sites carry only literal SVG
  icons or chart markup composed from numeric inputs — and fails on any new
  site, any stale entry, or any argument naming user-shaped data (scan / file
  / dataset names, URL params, message payloads), so the `innerHTML` escape
  hatch in `dom.ts` cannot silently regress into an XSS sink.

### Earlier in this release

A correctness and hardening release driven by a full-codebase audit. Every fix
below was verified against the v0.4.3 source before being applied.

### Fixed — survey-output correctness

- The point Inspector no longer applies the world origin twice. World
  coordinates, and the Geographic / UTM rows derived from them, were shifted by
  a full extra origin (e.g. ~+500 000 E / +4 500 000 N on a UTM scan). The
  card now shows the true World position, and a separate Local group (renderer
  frame) only when an origin exists.
- Contour vector exports (GeoJSON, DXF, SVG) are now georeferenced. They
  previously wrote origin-recentred local coordinates while stamping a real
  EPSG CRS, landing hundreds of kilometres from truth in GIS software; contour
  elevation values were offset by the vertical origin as well. Exports now
  shift geometry and levels to world coordinates — and when no origin is
  available, the EPSG stamp is omitted and a "local frame" warning is attached
  instead of claiming a CRS.
- Horizontal linear units are read from the horizontal CRS only. A compound
  WKT (projected + vertical) in US survey feet was previously measured as
  metres because the vertical axis's UNIT won the scan (~3.28× error in every
  derived measure).
- Aspect (and therefore hillshade lighting) is no longer mirrored north–south
  on the northing-up analysis grids; a north-facing slope now reports north,
  and the default 315° sun lights from the northwest as labelled.
- Contours are registered to cell centres, removing a systematic half-cell
  southwest shift relative to the exported DEM GeoTIFF of the same surface.

### Fixed — stability and behaviour

- Malformed or hostile files can no longer trigger runaway allocations: LAZ,
  COPC, EPT and E57 decoders now validate file-declared point/record counts
  against the actual bytes available before allocating (a shared
  `validateDeclaredPointCount` guard), failing with a typed malformed-file error.
- Recoloring after the initial upload (color-mode switches, coverage grids,
  height trims, classification edits, streaming recolors) now applies the same
  sRGB→linear conversion as the first upload, through one shared seam —
  switching Elevation → RGB no longer washes out the cloud.
- Removing a cloud releases its classification and selection snapshots
  (previously retained for the session — up to ~5 MB per edited scan).
- The URL field's Cancel button actually cancels the in-flight download (the
  abort signal is now threaded through to the loader), and submitting an empty
  URL explains what is expected instead of silently doing nothing.
- Concurrent open requests are rejected race-free (the loading flag is set
  synchronously), with a toast — "Already loading — cancel the current load
  first." — instead of silence.
- Pressing `I` no longer fires the Inspect tool and the Iso camera preset on
  the same keystroke: bare `I` belongs to Inspect (as the help advertises);
  the Iso preset remains on the view chips and command palette. All bare-key
  handlers now honour and set `defaultPrevented` so collisions cannot recur.
- Panel-width persistence no longer throws (and blocks boot) when browser
  storage is unavailable; all storage access goes through one guarded helper.

### Added

- Load progress, errors, and toasts are announced to screen readers
  (`role="status"` / `role="alert"` with polite live regions).
- Share metadata (Open Graph / Twitter card), an SVG favicon, an
  apple-touch-icon link, and a web app manifest.
- A commented production `.htaccess` (long-lived immutable caching for hashed
  assets, HSTS, nosniff, referrer and permissions policies, WASM MIME type,
  and a Content-Security-Policy draft in report-only form for testing).

### Notes

- Aspect/hillshade truth-test fixtures that encoded the mirrored convention
  were corrected alongside the fix; new regression tests cover the Inspector
  origin, contour world-origin shift, compound-WKT units, cell-centre
  registration, and the decoder allocation guards.

## [0.4.3] - 2026-06-09

### Added

- Manual scan-type override: a "Treat as" control (Auto / Terrain / Object /
  Interior) in both the terrain Analyse panel and the Space / Object panel lets
  you correct a misjudged scan in one click. A non-auto choice takes precedence
  over auto-detection, stays pinned while the cloud streams in, and resets to
  Auto on each new scan. Metrics are still computed honestly for the chosen
  type; the panel notes when the type was set manually.

### Changed

- Export provenance is unified: GeoJSON, DXF, SVG, the printable map sheet, and
  the DEM package now all stamp the same provenance, derived once from the run —
  software and metric version, date, source, CRS, vertical datum, coverage,
  contour interval and style, Surface Quality and Export Readiness (with the
  reason), and the measured accuracy (RMSEz / NVA / VVA / USGS Quality Level) —
  so no two exported artifacts can disagree, and every one carries the
  not-survey-grade note.
- Scan-type detection re-evaluates once the streaming cloud has fully settled
  ("Streaming ready"), so a type decided on a sparse early frame (which could
  misread a 360 / interior scan) is corrected on the representative geometry.

### Fixed

- Terrain density and slope now respect the scan's real horizontal units. On a
  foot-based projected coordinate system, ground density is reported as genuine
  points per square metre (previously it was measured in square feet but
  labelled per square metre, understating density by ~10.8×) and the slope used
  for surface-quality checks is computed over a metre run. Metric (metre) data
  is unchanged. This matches the existing handling of the vertical axis.
- A surface rated "Limited" now states a Limited reason instead of borrowing the
  preview-tier wording, and the "% of the surface is interpolated" figure is
  consistent everywhere it appears — it always means the share of the captured
  surface that is interpolated rather than measured, no longer diluted by empty
  cells in some views.
- Export honesty wording is tighter: a georeferencing gap (unknown CRS / datum)
  is only listed as an export reason when it actually holds the export back
  below the surface quality, and when a surface is both below grade AND not
  georeferenced the export reason now names both, rather than only the
  coordinate-system gap.
- The Space / Object report now respects the scan's real horizontal units, so
  dimensions, area, and volume read correctly (and convert correctly between
  metres and feet) for foot-based and other non-metre coordinate systems
  instead of assuming metres.
- Interior floor / ceiling / storey detection is more robust: floor and ceiling
  planes are found from density-weighted height peaks (so a cluttered floor or a
  sparsely captured ceiling is still detected), and a second storey is only
  counted when there is a real floor-to-floor gap with mass between the levels —
  it stays clearly labelled as approximate.

## [0.4.2] - 2026-06-05

### Added

- Classification legend: a "Classes" panel lists one row per ASPRS class
  actually present in the loaded scan, each with the renderer's class colour
  swatch, the class name, and a live count of the points currently shown — so
  the legend reads as the true colour key for the view, not a static table.
- Per-class show/hide, isolate, and show-all: untick a class to drop it from
  the view, use "Solo" to isolate a single class, and "Show all" to bring
  everything back. A persistent "Filtered — showing N of M classes" banner
  stays up the whole time a filter is active, so a partial view can never be
  mistaken for the full cloud. Picking and inspection honour the filter too —
  you can only pick points in the classes you can see.
- Metrics follow the visible classes: when classes are hidden, the scan
  report recomputes over just the visible subset (ground, density, coverage,
  and the rest), and every filtered readout is stamped with the class scope it
  was measured under, so no filtered number is ever shown unqualified. Clearing
  the filter restores the full-cloud figures and removes the stamps.
- Streaming header metrics that can't be re-derived from the resident view are
  shown for the full cloud and clearly labelled "not class-scoped", rather than
  silently mixing a full-cloud figure into an otherwise filtered report.
- Filtered exports carry their scope: copied points, the PDF report, and the
  image and snapshot exports are all stamped with the active class filter, so a
  filtered artifact is self-describing — anyone opening it later can see exactly
  which classes it represents.
- Contour map PDF, pre-export dialog: the MAP PDF action now opens a dialog to
  set the title, "prepared by", a free Project / Notes block, the sheet size and
  orientation, the final contour interval, and the output filename — each
  pre-filled with a sensible default from the scan. A re-picked interval
  regenerates the contours from the already-computed surface (no re-analysis).
  The measured fields (CRS, vertical datum, scale, NVA / VVA / RMSEz, USGS
  Quality Level, date) are shown read-only and stay computed from the scan, so a
  deliverable can be titled and described freely without ever hand-editing the
  accuracy figures.
- Interface polish: a consistent button system across the app with clearer
  primary actions, accessible focus rings, and an obvious, rotating expand /
  collapse chevron on the collapsible panel headers (Analyse, Export / Convert).
- Contour shape style, selectable on export: a "Contour style" picker (in the
  Analyse export section and the map-PDF dialog) chooses how the contour lines
  are shaped — As measured (crisp), Smooth, Rounded, Generalized, or
  Semi-geometric — and applies to every contour export (PDF, SVG, DXF, GeoJSON).
  Smoothing stays honesty-gated: it never moves a low-confidence vertex or
  bridges a data gap, so a dashed / uncertain run can't be reshaped into a
  confident line, and each exported file is stamped with the style it was made
  with. The on-screen contours are unchanged (the default matches the previous
  smoothing).
- Non-terrain scan detection: indoor / 360 / phone-LiDAR room and object scans
  are now recognised as non-terrain (a floor-plus-ceiling enclosure, or a
  compact object) instead of being pushed through the terrain contour pipeline,
  which is a category error for them. Such scans get a Space / Object report —
  overall dimensions (L x W x H, in metres and feet), floor area, ceiling
  height, enclosed volume, floor / wall / ceiling plane detection, storey count,
  and a capture-quality block (point count, density, coverage, RGB) — with the
  same honesty caveats as terrain (figures are based on the loaded / streamed
  data, ceilings are often sparsely captured, nothing is survey-certified).
  Terrain contour analysis stays one click away for any scan. Object scans get a
  matching report at the same depth — oriented and axis-aligned dimensions
  (metres and feet), largest dimension, bounding-envelope volume (m³ and ft³),
  an approximate bounding-box surface area, and the same capture-quality block —
  with the figures honestly labelled as bounding envelopes, not solid or mesh
  measurements. Scan-type detection is more robust: an interior is recognised
  from its floor plus wall / floor-to-ceiling columns (so a real multi-room or
  360 house with a partial, occluded ceiling is no longer mistaken for terrain),
  and when a scan carries classification a vegetation-dominated canopy keeps a
  forested drone scan as terrain rather than reading the canopy as a ceiling.
  Streaming scans re-evaluate their type as more of the cloud arrives.
- Contour export, simplified: the redundant contour-interval picker and the
  contour-style selector were removed from the Analyse panel — both are now
  chosen in the export dialog — and the "MAP PDF" button is renamed
  "Export Contours" to read as the primary contour-deliverable action.

### Changed

- Terrain DTM now aggregates each grid cell by the MEDIAN of its ground returns
  instead of the arithmetic mean. The median (50% breakdown point) is resistant
  to outliers: a single high return (vegetation, a parked vehicle) or low return
  (multipath) in a cell no longer pulls the cell's elevation, so the bare-earth
  surface tracks the true ground more faithfully. This changes elevation values
  in cells that previously had a skewed mix of returns. The hold-out RMSE
  validation rebuilds its DTM with the same median aggregation, so the reported
  accuracy continues to measure the surface that ships, and the DEM export
  README's "Generation parameters" now records the cell aggregation used.
- Terrain quality is now reported on TWO independent axes instead of one
  conflated verdict: **Surface Quality** (is the terrain surface internally
  valid?) and **Export Readiness** (is it georeferenced enough to hand off?).
  Surface Quality is derived purely from surface metrics (coverage,
  interpolation, edge risk, density, ground visibility, hold-out RMSE) and is
  INDEPENDENT of the coordinate system and vertical datum — a dense, clean,
  well-covered scan with an unknown datum now reads as a good surface. Export
  Readiness equals Surface Quality further gated by georeferencing: an unknown
  CRS or vertical datum caps it to "preview" (with an explicit reason such as
  "vertical datum unknown"), even when the surface itself is good. The Analyse
  panel shows both axes; DEM and contour/map exports key off Export Readiness;
  and the DEM/map deliverables still carry their preliminary caveat whenever the
  georeferenced hand-off is not export-ready. The honesty contract is unchanged
  — an unknown datum still blocks an export-ready verdict and nothing claims
  survey-grade.

## [0.4.1] - 2026-06-04

### Added

- Terrain Assessment: a single top-level verdict — Good / Preview / Limited —
  at the top of the Analyse panel, with the 0–100 terrain quality score folded
  into the headline (e.g. "Preview · 64/100"), a one-line reason, what the
  surface is best for, and a caution where relevant. The detailed metrics
  (quality breakdown, coverage, confidence, RMSE, NVA/VVA, readiness,
  recommended grid) now sit behind a collapsed "Details" expander, so a
  non-specialist reads the bottom line first and drills in only on demand. The
  verdict speaks to data quality and fitness-for-use — it does not claim
  survey-grade or survey-certified output.
- DEM export: a one-click "DEM (ZIP)" button in the Analyse panel downloads the
  elevation rasters — bare-earth DTM, top-surface DSM, and canopy height (CHM) —
  each as both an Esri ASCII Grid (.asc) and a georeferenced Float32 GeoTIFF
  (.tif), with a .prj CRS sidecar when known and a metadata README (CRS,
  vertical datum, cell size, units, RMSEz / NVA / VVA, USGS Quality Level, and
  coverage). GeoTIFF carries its CRS by EPSG GeoKeys and a north-up
  ModelTiepoint, so it drops straight into QGIS / ArcGIS / GDAL. The raster
  writers ride a lazy chunk, and the export stays available even when the
  contour quality gate would block the vector exports.
- An "Analyse" button in the tool dock toggles the terrain analysis panel, so
  it can always be re-opened after it's closed — including when selecting the
  Profile tool tucks it away, or when an object scan demotes it behind the
  Object panel. On phones it lives in the dock's "More" (•••) menu, and the
  bottom-centre navigation control always stays clickable where the two meet.
- Multi-directional relief: the Analyse panel's hillshade is now a soft
  multi-directional shaded relief by default, with a toggle to a single sun and
  an adjustable sun azimuth and altitude. Re-lighting is instant — it reuses the
  cached slope/aspect grids — and the current relief exports as a PNG.
- Click-to-sample: clicking any analysed preview raster (relief or canopy)
  reports the bare-earth elevation, slope, and above-ground height at that cell,
  turning the static surface into a point-query tool. The sampled point is
  marked with a crosshair, the readout is announced to screen readers, and the
  relief tile carries a shaded-relief legend and clearer sun-off state.
- Canopy Height Model (CHM): the Analyse panel now renders above-ground height
  (DSM − DTM) as its own north-up preview on a green canopy ramp with a height
  legend, exportable as a print-resolution PNG — alongside the hillshade, which
  shares the same preview/export controls.
- Bare-earth elevation histogram: a compact distribution of the DTM's ground
  elevations in the Analyse panel, with the value range and cell count, for a
  quick read of the terrain's hypsometry.
- Distance measurements now report a compass bearing (zero-padded azimuth,
  e.g. "15.2 m · 042°") alongside the length; purely vertical pairs show length
  only. Bearing is measured in the map plane and handles non-Z-up scans.
- Typography refresh: the interface now uses Manrope for text and JetBrains
  Mono for figures and labels (both self-hosted, no external font requests),
  and the data panels render tabular figures so columns of numbers line up.
- Cross-section profile chart, professional numbers pass: the elevation axis
  now labels rounded "nice" values (e.g. 120 · 125 · 130) with matching
  gridlines instead of the raw min/max, and every numeral renders in JetBrains
  Mono with tabular figures from a positioned overlay — so the axis text no
  longer inherits the chart's horizontal stretch and reads crisply at any
  chart height. Units are spaced (e.g. "120 m") and decimals are consistent.
- Selecting the Profile measurement now clears the Analyse panel and brings
  the Measurements panel forward automatically, so the cross-section chart has
  room and the workflow focus is unambiguous.
- Readiness cards redesigned: ground confidence, DTM quality and contour
  readiness now read as a row each — the label and supporting line on the
  left, a large figure with its unit and a colour-coded rating pill on the
  right — so the headline number and its rating are scannable at a glance.

- Point cloud format converter: batch-convert files from the start screen, plus
  an in-project Export panel. Reads LAS, LAZ, XYZ and ASC; writes LAS, XYZ and
  ASC with a CRS assign or reproject step and an optional full-resolution pass.
- Vertical datum detection from LAS GeoTIFF / WKT, and LAS RGB reading so colour
  point clouds now display in colour. Wider reprojection CRS coverage.
- Terrain quality: a 0–100 quality score (surfaced in the Analyse panel) built
  from per-cell density, completeness and edge metrics, outlier-rejection DTM
  hardening, and hold-out RMSE stratified by slope and surface zone.
- DTM extrapolation guard: a filled cell whose supporting ground data lies only
  on one side is an extrapolation, not a bracketed interpolation, so its
  confidence is now demoted toward dashed/gap rather than reading as trusted.
  The guard scans eight rays and measures the angular spread of nearby data; a
  cell whose support is confined to an arc under 180° is treated as one-sided.
- Surface models in the Analyse panel: a top-surface DSM with above-ground
  height (canopy and structures), slope, and an exportable hillshade preview.
- Unit-correct terrain analysis: slope, roughness and hillshade convert
  geographic (degree) grids to metres, and the hold-out RMSE and quality score
  are reported in metres for foot-based CRSs.
- The Measurements panel is now width-resizable (drag the south-east handle)
  so the cross-section profile chart can be widened to read; the chosen width
  is remembered. The hillshade preview also exports at full resolution (~2048
  px) instead of the raw grid size.
- Cross-section profiles honour classification: when the cloud carries ASPRS
  classes, vegetation / building / noise returns are dropped before the
  bare-earth percentile, so trees no longer pull the profile floor up.
- Object-scan detection now finds the up axis from geometry (handles Y-up
  phone / glTF scans), instead of assuming Z-up.
- Object scans get object analysis: a scan that reads as a compact 3-D object
  (a phone scan of a sculpture, a chair, a room) is detected from its geometry,
  and an Object panel surfaces the right measurements — oriented dimensions
  (L×W×H), envelope volume, scan resolution, and capture completeness — instead
  of misleading contours. Terrain analysis stays one click away ("run anyway").
- Splash reorganized for clarity: the primary Open button now sits beside a
  peer Convert chip, and the location picker, location search and streaming demo
  are consolidated into one "Explore public LiDAR" card.
- Performance: the 2D tool overlays (measure / inspect / annotate) are
  re-projected only on rendered frames rather than every animation frame, so a
  static scene no longer does continuous overlay DOM work — lower idle CPU.
- Printable map-sheet PDF — a field deliverable: contours rendered as a framed
  map with a UTM coordinate graticule, scale bar, north arrow, a legend keying
  the line types, and a title block carrying the CRS, vertical datum, scale, and
  the NVA / VVA / USGS Quality Level accuracy with a survey-grade / preview note.
- Geodesic (surface-aware) void interpolation: empty DTM cells are filled by
  inverse-distance weighting along the terrain surface rather than in a
  straight line, so a gap in a valley is no longer filled from across a ridge —
  more accurate bare-earth heights near breaklines.
- DEM accuracy in survey standards: the Analyse panel reports NVA (95%
  confidence = RMSEz × 1.96), VVA (95th-percentile vegetated accuracy), and the
  USGS 3DEP Quality Level (QL0–QL3) the surface meets on point density and
  RMSEz together.
- Classification-aware contours: when the cloud carries ASPRS classification
  (from the file or the lasso editor), vegetation, building and noise returns
  are dropped before ground filtering so the bare-earth surface and contours
  can't anchor to canopy or rooftops. Above-ground height still uses the full
  cloud. The ground filter's slope-scaled tolerance is also capped so steep
  terrain can't admit low buildings or vehicles as ground.

## [0.4.0] - 2026-06-03

### Added

- Terrain analysis (preview): a confidence-aware DTM and contour pipeline with
  a mounted Analyse panel. Classifies ground, validates the surface, gates a
  professional export behind quality (CRS, vertical datum, coverage), and
  exports evidence-graded contours as GeoJSON, SVG, and DXF.
- Cross-section profiles export a full-page, scaled PDF with a
  station / elevation / grade table and civil summary.

### Fixed

- Long measurement readings and dataset/layer names no longer overflow their
  panels.

## [0.3.10] - 2026-06-02

Browser-based LiDAR and point-cloud viewer. Loads LAS, LAZ, E57, PLY, PCD,
PTS, PTX and streams COPC, EPT, and 3D Tiles, entirely client-side on WebGPU
with a WebGL2 fallback. Includes measurement, annotation, classification,
cross-section profiles, volume, PDF reporting, and image export.
