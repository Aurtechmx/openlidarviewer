# Changelog

The format is based on Keep a Changelog and the project follows Semantic Versioning.

## [0.6.0-alpha.2] - 2026-07-21

A stabilization cut. Almost nothing here is visible in the viewer: it makes the
test gates mean what they claim, starts the decomposition of the two monoliths,
and writes down the architecture so the rest of the work has a target. Alpha
caveat unchanged: this cut is for evaluation, and interfaces may still move
before v0.6.0.

### Changed

- **The end-to-end suite actually gates now.** 161 of the 166 e2e specs ran under
  `continue-on-error`, so only the smoke and mobile specs (about twelve tests)
  could ever block a build — a regression in any of the rest shipped green, which
  is the shape of gap that let a streaming blank-render bug reach a release.
  Playwright now has two projects: `deterministic` (blocking) and `gpu`
  (advisory, `@gpu`-tagged). 165 specs block; only the real-WebGPU equivalence
  probe stays advisory, because it legitimately falls back on a headless runner.
  An untagged spec blocks by default, so a new spec gates until it is shown to be
  GPU-variable.
- **No module-level mutable application state remains in `main.ts`.** The saved
  views, active-scan selection and scan-route clusters moved onto `AppContext`
  behind services (`viewBookmarks`, `ScanService`, `ScanRouteService`), joining
  `LayerService`. Eleven copies of `activeId ? getCloud(activeId) : null` became
  one `activeCloud()`, and the twice-spelled route-pinned predicate became one
  getter. This is a coupling change, not a size one — `main.ts` moved 7,587 to
  7,574 lines. Its value is that the orchestration blocks can now close over
  services instead of file-scope `let`s, which is what makes them movable at all.

### Added

- **A coverage ratchet over the pure modules** (`npm run coverage`): the numeric,
  geometric and model code a unit test can genuinely pin, deliberately excluding
  the render and UI layers and the two monoliths, where a repo-wide percentage is
  a number nobody acts on. Baseline lines 90.57 / statements 89.19 / functions
  87.75 / branches 82.73, with thresholds just underneath.
- **A mutation gate over the numeric core** (`npm run mutation`, advisory): the
  formulas where a wrong number is a silent scientific error rather than a crash.
  It earned its place immediately — `hornSlopeAspect`'s degenerate-input guard had
  17 surviving mutants, meaning a zero or NaN cell size could have produced an
  Infinity slope that propagates into confidence grades, RMSE bands and terrain
  ruggedness. Coverage rated that file ~90% because the lines *ran*. Now pinned;
  score 85.11 to 87.23.
- **An architecture map** (`docs/architecture/architecture-map.md`) with a drift
  check: every module path it names must resolve, or the test fails and the page
  moves in the same change. It caught itself on the first run.
- **A streaming origin-localisation guard.** The scheduler tests only ever used a
  cube at the origin, where subtracting the render origin is a no-op — so the
  alpha.1 EPT blank-render bug could not have been caught there. A case at
  UTM-scale coordinates now fails if that path regresses.

### Internal

- The stabilization work is tracked against measured baselines, separating
  what is provable in a sandbox from what needs a browser or a workstation.
  `docs/architecture/architecture-map.md` carries the module graph and the
  decomposition targets.

## [0.6.0-alpha.1] - 2026-07-18

First alpha of the v0.6 cycle: startup and streaming performance, a correctness-and-honesty hardening pass across the streaming, loader, and measurement paths, the foundation for a shared project coordinate frame, and the start of the internal restructuring that the v0.6 workflow features build on. Alpha caveat: this cut is for evaluation; interfaces and internals may still change before v0.6.0.

### Added

- **Stale-chunk recovery.** A tab left open across a deploy no longer breaks the first action that touches a swept-away code chunk: the failed dynamic import is classified (across Chromium/Firefox/Safari/Vite phrasings) and the page reloads once, guarded by a per-tab cooldown so a persistent failure surfaces an error instead of a reload loop. URL and query are preserved.
- **Dependency-singleton guard.** `npm run check:deps` fails the release gate if a second copy of three, laz-perf, proj4, or pdf-lib ever enters the tree (duplicate decoder/geometry state is a correctness risk, not just bloat); Vite dedupe backs it up at resolve time. A real duplicate laz-perf was collapsed by removing the unused `@loaders.gl/las` dependency.
- **Progressive streaming hierarchy.** Large public EPT datasets expose thousands of hierarchy sub-files; loading them all before the first points render made big projects look hung. The walk is split into a bounded first-paint pass plus a resumable background continuation, and the frontier drops every attempted key so a persistently-failing fetch can't spin into an allocation loop.
- **Shared project coordinate-frame foundation.** Value types (`ProjectSpatialFrame`, `LayerSpatialTransform`) and pure Float64 transform math for expressing multiple layers in one authoritative frame, so georeferenced scans with different origins can occupy their true relative positions rather than overlapping near local zero. The tested foundation ships; the scene wiring is staged and documented in `docs/architecture/project-spatial-frame.md`.

### Changed

- **Startup bundle.** The Analyse and Object panels now mount on first scan load instead of at boot, cutting the live entry chunk from 792 KiB; the bundle-budget guard's ceiling drops 800 → 720 KiB with an early-warning threshold at 680 so the win cannot silently erode. After the alpha hardening the live entry measures 693 KiB — within the 720 ceiling, above the 680 warning line.
- **Live probe pauses during camera drags.** The hover readout's detailed GPU pick is skipped while the user is actively orbiting or panning — you are navigating, not reading a value — and fires once as soon as the drag settles.
- **Measurement station tables build lazily.** Station rows render when their section is first expanded; exports are byte-identical.
- **Start-screen theming and layout.** The start-screen backdrop follows the selected theme, so Light and High-contrast re-theme the whole page rather than only the centre panel. A "Try a sample scan" action sits under the primary button for a visitor with no file on hand, the brand mark carries one slow drift that respects reduced-motion, and the format converter is a secondary link rather than a competing button.

### Fixed

- **Public COPC and EPT datasets open reliably.** Two separate causes could leave the viewer on "Streaming coarse geometry" with nothing drawn. The scheduler was advanced only by the render loop, which the browser pauses for a background or throttled tab, so a dataset opened in that state sat at zero resident nodes with no error; a steady heartbeat now drives the scheduler independently of the render loop. Separately, every EPT node's bounds were shifted by the render origin twice — once when the node was built and again in the shared scheduler — so every node fell one whole origin from the camera and was culled before it could draw; EPT node bounds are now world-space, matching the COPC contract, and the origin is applied once.
- **Consistent values across panel, report, and export.** A metric computed in more than one place no longer disagrees with itself on a foot-based, compound, or non-Z-up dataset: slope no longer reads about 3.28× too steep, a Y-up mesh (PLY/OBJ/GLB/glTF) is measured on its ground plane and height, the streaming scan panel and Dataset Intelligence convert source units to metres before printing, point density prints at the same precision everywhere, the export card reports the declared point count and tight data extent rather than a strided sample or the octree cube, and the change-detection raster, measurement GeoJSON/CSV/KML, and profile chart carry the file's own linear and vertical units. Single-unit metre datasets are byte-identical.
- **Polygon reclassification on non-Z-up scans.** For a non-Z-up up-axis, the polygon was projected onto an (east, north) basis while each point was tested in raw XY — mismatched spaces that reclassified the wrong points on rotated, Y-up, tilted, or non-origin clouds. Points now project through the same basis, height included; the Z-up fast path is unchanged.
- **COPC/EPT refinement flicker.** Streaming LOD transitions cross-faded with `transparent: true` while keeping depth writes for EDL, so overlapping coarse/fine layers z-fought and refining regions pulsed while a cloud streamed in. Transitions are now an opaque per-point dither dissolve driven through the size graph — no transparency, no z-fight, EDL stays exact — and an evicted node dissolves out from its current density instead of snapping to full.
- **Non-finite streaming nodes are refused.** The central sanitiser cleans file-loaded clouds but by contract skips streaming buffers; the COPC/EPT decoders now reject a node whose transform (a malformed header scale/offset/origin) or whose float source carries a NaN, with a structured error the scheduler backs off — instead of sending NaN to the GPU.
- **Sessions no longer rebase onto the wrong scan.** Import checks a session's stored scan fingerprint (extents primary, point count corroborating, name/CRS disclosure) against the loaded scan before rebasing its geometry: a clear mismatch is refused, a partial match disclosed, rather than silently realigning one scan's analysis onto another.
- **Stockpile confidence is honest about units.** A points/m² density can no longer earn HIGH confidence when the horizontal CRS unit is unknown (an unknown unit was silently treated as metres); the density row is labelled accordingly.
- **Profile elevations read against the right datum**, and the distance formatter no longer renders negative heights as centimetres.
- **Central non-finite sanitation across every file loader**, PCD included, and streaming elevation ranges now read from decoded data bounds rather than the octree cube, so a tall cube can't inflate the elevation legend. Streaming-only session exports store the active geographic origin instead of `[0,0,0]`.
- **Partial session matches now ask before applying.** A session whose scan fingerprint neither clearly matches nor clearly conflicts with the loaded scan no longer restores automatically — it surfaces an "Apply anyway" confirmation, so an unverified match can't quietly place measurements on the wrong scan.
- **No spurious PCD console warning.** A PCD file with a non-finite coordinate no longer prints three's `computeBoundingSphere(): Computed radius is NaN` — that one redundant message is suppressed for the parse (the point is still excluded and reported through the loader's own warning channel).

### Internal

- **Composition root.** New `AppRuntime`/`AppContext` own the shared application state (layer visibility/solo/comparison, active-scan selection, saved views) that previously lived in module-level mutables, and the first extracted service (`LayerService`) manages the layer list against it. Behaviour-preserving; groundwork for the v0.6 decomposition.
- **Anti-thrash streaming selection (opt-in).** The budget selector can give an already-shown node a small score bonus so budget-boundary noise can't bump it out and force a re-fade — the "regions pulsing" flicker — with a node being refined away exempt so LOD never freezes. Unit-tested and off by default: enabling it live needs reconciling with eviction protection and visual verification in a browser, so no behaviour changes in this cut.
- **Single-file test runner.** `npm run test:file <path>` mirrors the release buckets' terminating policy with a wall-clock watchdog and a greppable exit line, for fast red-to-green iteration without a full bucket.
- **Sub-sharded test buckets, everywhere.** The bucket runner grew a `--shards=N` mode that runs a bucket as N sequential deterministic slices (fresh vitest process each), so no single process holds hundreds of files — the shape that can fail to terminate ("Worker exited unexpectedly") at shutdown on a constrained machine. `test:release` uses it (unit ×3, terrain ×2, slow ×2); CI runs the same slices in parallel via `--shard=i/N`. The slices partition each bucket exactly.

## [0.5.9] - 2026-07-15

v0.5.9 launches Contour Studio — a post-analysis workflow that turns a correctly analysed LiDAR scan into an evidence-aware terrain deliverable, kept out of the crowded analysis panel — alongside scientific-correctness, unit, evidence-gate, provenance, and registration fixes that stand on their own. Headline additions: a verifiable hash-chained processing manifest, a labelled colorbar legend (live and burned into figures), named restorable view states (session schema v7), GPS-time and return-number colour modes, and purpose-driven contour exports whose geometry differs by purpose.

### Added

- **Verifiable processing-provenance manifest (schema 1).** Every terrain export's provenance now embeds one ordered, hash-chained record of the methods and final parameters that produced it (`processingManifest` beside the scientific record in the GeoJSON metadata, plus a one-line `Manifest` stamp — schema, shortened chain head, op count — in the DXF/SVG/README text block). Each op folds the previous hash plus its canonical serialization into a SHA-256 chain seeded from the manifest envelope (schema, build identity, source name), so editing any op, reordering, truncating, or rewording the envelope breaks verification at exactly the first altered position (`verifyProcessingManifest` reports the index). Parameters are bound only where the provenance carries them (coverage scope, VRM/TPI windows and radii, contour interval and shape style); an op whose settings never reached the provenance says `params not captured in this slice` instead of fabricating values. Honesty boundary: this is a *verify-only* record — ordering, parameters, tamper-evidence — not an execution recipe, and no executor consumes it. Saving a `.olvsession` after an analysis fills the v7-reserved `processingManifest` slot with the same manifest, so the session file carries the audit record of the numbers on screen.
- **Labelled colorbar legend — live and burned into figures.** A quantitative figure needs a labelled min/max colorbar, so the continuous scalar colour modes (elevation, intensity, GPS time, return number) now carry one on two single-sourced surfaces: a dismissible on-screen legend near the viewport (a lazy chunk — an RGB-only session never downloads it) and a burn-in on the right edge of saved views and Studio image exports, positioned clear of the scale bar, scan-report card, and class-scope banner. Both consumers read ONE spec-builder that labels the exact window the pixels normalise against (`rampRangeForMode` — the same function the colouring pass paints with; streaming legends read the renderer's seeded cloud-global ranges verbatim, and static and streaming paths drive the same overlay). Honesty rules throughout: the elevation unit comes from the resolved CRS (user overrides included) and an unknown unit shows no suffix — never a guessed "m"; a percentile-trimmed ramp is annotated "p5–p95 window" so clipped endpoints are never mistaken for true extremes; intensity renders a GRAYSCALE bar because that is how the points are actually painted, with no unit (a raw DN); GPS time is normalised to seconds from the window start and says so; and the categorical modes (RGB, classification, and friends) get no continuous bar at all — it would invent an ordering the renderer never used.
- **Named, restorable view states (session schema v7).** A saved view is no longer just a camera bookmark: pressing `V` (or Save current view in the panel, or "Save view state" in the command palette) captures the camera together with the clip box, colour mode, class filter, elevation/intensity filter windows, and render settings, and restoring the view reapplies the lot — camera strictly last, so nothing re-frames after the pose lands. States are serialized per-view in the `.olvsession` file through the same tolerant sub-parsers as the session's global fields, so a paper can cite "Figure 3 = view state 'north-scarp'" and a reviewer with the same scan regenerates it. The session schema bumps to v7 in this one coordinated step: it also reserves an opaque top-level `processingManifest` slot (passthrough, unvalidated) so the verifiable-processing-manifest workstream lands without another version bump. Migration is additive and honest — a v6 file imports with its camera-only views intact and restoring them behaves exactly as before (not even the FOV is touched), a bundle-free view still serializes byte-identically to the v6 writer's output, and unsupported future versions are still rejected. Streaming caveat: on a COPC/EPT scan a restored state reproduces the same settings over whatever detail is resident — the same picture, not a claim of identical point membership.
- **GPS-time and return-number colour modes.** Two continuous scalar colour modes join the chip row in the Inspector and the streaming panel, data-gated on their channel: "GPS time" ramps acquisition time (dark early → bright late) and "Return" ramps return ordinals (dark first → bright last), both defaulting to the colourblind-safe Cividis palette and available in the static and COPC/EPT streaming pipelines alike. Streaming nodes colour against one cloud-global window seeded from the coarsest resident node, so adjacent nodes never band at shared edges; the GPS-time range is percentile-clipped through the same core as elevation, so one garbage timestamp cannot compress the whole ramp, and non-finite values from a malformed chunk cannot poison the window. Honesty gate: classification keeps its categorical palette and `pointSourceId` deliberately gets no ramp mode — sequential colour on unordered flight-line ids would invent an ordering the data does not have.
- **Terrain Products launcher.** After analysis, the crowded panel no longer shows contour export controls inline; it shows a noticed launcher whose state (hidden / unavailable / exploratory / available) is computed from the analysis result and the CRS frame. The contour export controls move into a gated container revealed only when the launcher's action fires. The launcher, its state adapter, and its strings load lazily (a separate chunk), keeping Contour Studio out of the startup shell.
- **Contour Studio state + purpose model.** A serializable state (schema 1) with deterministic serialization, a schema-versioned parse with a migration seam, and a stable content hash. Five purpose presets (Engineering Plan, Survey Review, Terrain Research, Presentation Map, Custom) are bundles of defaults only; selecting one changes presentation settings and preserves user overrides, and cannot raise an evidence level because the state carries no evidence field.
- **Unit-safe contour level definitions.** Contour interval and base elevation are recorded in both the source vertical unit and metres, with the metre value null when the vertical unit is unknown, so a source-unit number is never presented as metres. Metric contour support is claimed only on a known vertical unit and a projected CRS; feet show a metric equivalent; unknown units render as "units unverified".
- **Contour Studio workspace + recommendations.** A workspace shell (purpose cards, an evidence ladder tied to the real launch state, and an export bar) and a review-bar model that surfaces the analysis's own grid and interval recommendations with their rationale. All of it loads lazily.
- **Analytical/cartographic geometry split.** Exact analytical isolines and a generalized cartographic product that references the analytical hash, records displacement statistics and a topology flag, and is never labelled exact. Cartographic exports apply a bounded per-purpose generalization tolerance; a terrain-aware per-feature variant (scaling tolerance by support, confidence, closure, and length within a bounded band) exists in the module library but is not the shipped export path.
- **Print-aware label engine.** Places contour labels on straight, low-curvature, supported runs with a suppression audit; an unsupported span is never labelled as if measured.
- **Evidence-gated exports.** A registry of the scientific exporters and one resolver that returns validated / exploratory / blocked and can only downgrade; a multipage PDF content model and a complete-deliverable-package model that omit unavailable files honestly, watermark exploratory output, and refuse to build a polished deliverable when blocked.
- **Publication artifacts.** `VALIDATION_REPORT_v0.5.9.md`, `docs/validation/THREATS_TO_VALIDITY.md`, `docs/validation/METHOD_VERSIONS.md`, `ARTIFACT_EVALUATION.md`, `REPRODUCIBILITY.md`, `DATA_AVAILABILITY.md`, a contour validation case manifest, and analytic contour validation (cone, paraboloid, tilted-plane) checked against closed-form truth.
- **Trimmed ICP registration.** Robust correspondence trimming with a median-based warm-start, so change-detection alignment resists gross blunders and scattered outliers instead of collapsing. Diagnostics (inlier fraction over the whole cloud, kept-set RMS) are reported honestly.

### Fixed

- **Hold-out validation runs train-only on the shipped path.** Ground classification is re-run per fold with the held-out points excluded, closing the classify-before-split optimism. The analyser (`computeTerrainCore`) passes a train-only reclassifier that re-runs the SAME SMRF classifier with the SAME resolved parameters on the training points only, so a held-out point never helps decide its own ground membership; the report's full-cloud disclosure is off because the leak is removed, not restated. Cost is bounded: the hold-out is a single deterministic split — one extra SMRF pass over the training share of the already-capped analysed cloud (ground-filter cost ≤ 2× per run). `olv.validation.holdout-rmse` is version 2. The spatially-blocked diagnostic still scores against the full-cloud mask and its threats-to-validity disclosure stands.
- **Contour Studio purposes export distinct geometry.** Selecting a purpose previously exported the on-screen default geometry byte-for-byte — the purpose changed only a provenance line, and the file was stamped with a `terrain-adaptive` generalize method whose module has no production caller. Each purpose now carries a bounded generalization tolerance (Survey Review 0 = exact analytical isolines; Terrain Research 0.25, Engineering Plan 0.5, Presentation Map 1.0, Custom 0.5 cells), so the four cartographic purposes serialize pairwise-distinct vertices; the exact tolerance and the honest `olv.contour.generalize` method id travel into the export provenance and the processing manifest, so a deliverable names the epsilon it used.
- **The Complete (ZIP) deliverable reflects the selected purpose.** It previously always bundled the exact analytical geometry and recorded no purpose; it now bundles the geometry for the chosen purpose (Survey Review's analytical isolines, or a cartographic purpose's generalized geometry at its tolerance) and stamps the geometry method, purpose, and tolerance into the deliverable provenance. The stamp is written only when the geometry is regenerated at the purpose's style, so it can never describe a bundle it does not match.
- **Complete-deliverable PDF named for what it is.** The multipage PDF inside the complete ZIP is a text technical report (contour summary, surface support, validation, method and provenance), not a rendered map sheet — only the standalone map-sheet PDF draws an actual map. It is now named `Contour_Report.pdf` ("Contour report (PDF)") instead of `Contour_Map.pdf`.
- **Honest elevation unit in the complete deliverable.** The deliverable README and PDF no longer assert that the vertical unit equals the horizontal unit; they report the real Z-axis unit when the CRS declares one separately, and "unknown" otherwise, so a foot-based scan never prints an unverified elevation unit.
- **Self-validating confidence calibration.** The reported calibration quality is now computed by deterministic K-fold cross-fitting, so no sample is scored by a calibrator trained on it. Out-of-fold reliability and Brier score are exposed.
- **Unit overclaiming on elevation.** Picked-point elevation no longer prints metres on a foot vertical datum or unknown units, and space reports no longer say "metres (assumed)" on unknown-scale data. Both route through the typed-unit helpers.
- **Signed EPT URLs keep their credential past the manifest.** A remote EPT manifest URL carrying an auth query (`?token=…`, an Azure SAS, a CDN signature) validated and loaded `ept.json`, then dropped the query when deriving the dataset directory — so the first `ept-hierarchy/…` request went out unsigned and 401/403'd. The query now rides every derived hierarchy and tile request. A per-object presigned signature bound to `ept.json` alone still cannot authorise the sibling hierarchy files; that case stays an honest hierarchy-fetch error rather than a silent stall.
- **Service worker caches only the build's own hashed bundles.** The offline worker cached anything under `/assets/` by path prefix, so a point cloud or EPT hierarchy a self-hoster placed there would have been written to Cache Storage — contradicting the worker's stated privacy contract. It now requires a Vite content-hash and a known application extension, so a `.las` / `.laz` / `.copc.laz` / `.bin` / `.zst` / `ept.json` / hierarchy file under `/assets/` is never cached. Covered by a test across those extensions and directories.
- **Restored real elevations in the contour map, DEM rasters, and complete deliverable.** A recentred scan's exports carried recentred-negative heights (a DTM of −450..−210 m where the source is ~+210..+450): the dropped vertical origin was already added back for measurements and vector contours, but not for the map-sheet labels or the DTM/DSM rasters. The map-sheet elevation labels, the DEM package's DTM/DSM `.asc`/`.tif`, and the complete deliverable's DTM GeoTIFF now add it back (a covered-cell-only copy — CHM stays a height difference, and the source grid is never mutated). Only the numbers are corrected; the vertical datum stays honestly "unknown".
- **Contour map sheet redesigned toward an official-grade deliverable.** One line-style table (shared with the legend so they cannot desync) gives a continuous hierarchy — a bold measured index skeleton, lighter measured intermediate, a lighter continuous tint for interpolated, and a broken line only for low-confidence gaps — so a heavily-interpolated preview reads as signal rather than dashed noise. The print-aware label engine now places the map's index labels (upright, on straight supported runs, collision-avoided, repeated along each line at print scale), an interior tick-cross graticule, a double map neatline and an outer sheet neatline, an explicit "local grid up — true north unknown" note in place of a compass arrow on an ungeoreferenced scan, and a three-column ruled title block whose PREVIEW / evidence verdict is wrapped within its column so it can no longer overlap the legend. Every honesty disclosure — preview readiness, interpolated fraction, the evidence-gate line, and the unknown-datum caveat — is preserved.

### Changed

- **Terrain intelligence report joins the unified evidence gate.** The report was the last Contour Studio product with a standalone gate; its Studio export now mints a permit through the same central evidence resolver as the vectors, map PDF, DEM package and complete deliverable (`contour.report`, governed by the DTM claim — the report can never claim more than the surface it summarises). A blocked permit refuses the export with the same blocked-button feedback as the other products; a granted permit's decision (validated / exploratory + watermark) is stamped into the report's provenance footer. The resolver only ever downgrades, and the report keeps honestly describing preview/blocked verdicts in its body; the direct panel convenience button keeps its own availability (no stamp), as the DEM's does.
- **Evidence gate coverage.** Measurements CSV, the integrity report, and the map-sheet PDF now route their claim status through the one central evidence gate rather than exporting ungated. The `exportGate` / `isValidatedExport` API is unchanged.
- **`test:release` runs the blocking mobile smoke.** The release command now includes the mobile responsive smoke (320 / 375 px, `visualsStudioMobile.spec.ts`) that CI already gates on, so the local release gate is a true superset of CI's blocking browser checks instead of omitting one.

## [0.5.8] - 2026-07-08

Architectural and scientific-provenance hardening. This release starts a staged
cleanup that ties every output to the exact build that produced it and stops the
viewer from asserting units it does not know.

### Added

- **Build identity.** Each build now carries one identity resolved at build
  time: version, git commit, a dirty-tree flag, build time, Node version and
  channel. It is stamped into every terrain export's provenance (text and JSON)
  and into the report PDF's creator metadata, so an artifact records which build
  made it, not just which release. When git is unavailable the commit is
  reported as `unknown` rather than fabricated, and the build time honours
  `SOURCE_DATE_EPOCH` for reproducible builds.
- **Layer-boundary lint.** A CI check fails the build if a science or core
  module (`terrain`, `validation`, `analysis`, `science`) imports the UI layer
  or three.js, keeping those modules pure and worker-safe.
- **Method registry.** A single catalogue of the scientific methods the viewer
  runs, each with a stable `id@version`, so provenance and reports can name the
  exact algorithm and revision behind a number.
- **Architecture cleanup plan.** `docs/architecture/v0.5.8-cleanup-plan.md`
  records the staged program and its current state.

### Fixed

- **Inspector units.** The picked-point card showed every projected and every
  local or unknown-CRS coordinate with a metre suffix. A foot-based survey
  therefore read as metres, and an unknown-unit scan asserted metres it never
  knew. Axes now follow the CRS's own linear unit (metre, foot), and an unknown
  unit shows no suffix instead of claiming metres.
- **Contour interval gate on foot data.** The interval honesty-gate compared the
  metre-valued hold-out RMSE against source-unit contour intervals, so a foot-CRS
  surface could offer intervals finer than its true vertical error. The RMSE is
  now expressed in the interval's own units before gating; the recommendation is
  invariant to the declared vertical scale.
- **Unit constructors reject non-finite input.** The branded-unit constructors
  now throw on NaN / ±Infinity, catching a poison value at its source instead of
  letting it propagate through every downstream computation.
- **Validation honesty.** The hold-out report now states explicitly that it
  withholds points from the surface fit only — ground classification runs over
  the full cloud — a mild optimism versus true classify-inside-fold validation.
- **Packaging.** An unanchored `build` entry in `.gitignore` had been silently
  excluding `src/build/buildIdentity.ts` from the source archive, breaking a
  clean checkout's typecheck and build. The ignore patterns are now root-anchored,
  the file is tracked, and a new `lint:no-ignored-src` gate fails the build if any
  source file is ever git-ignored.

### Changed

- **Claim register is generated, not hand-mirrored.** The runtime evidence
  registry is now generated from `docs/validation/claim-register.yaml`
  (`npm run gen:claim-registry`); `lint:claim-register` fails if the generated
  output drifts from the YAML, removing the two-place edit.
- **Plain-build chunk-isolation ceiling raised 516 → 520 KiB.** A committed
  contract decision: the boot-time input-aware mobile detection and the sub-KB
  scientific-record / export-provenance triggers added ~3.4 KB of eager shell
  surface since v0.5.6 (index measured 529,464 B, 1,080 B over the prior
  ceiling). The heavy code still rides lazy chunks — the shell-leak fingerprint
  guard confirms no decoder / pdf / WebGPU / TSL import entered the startup
  shell. `test:build` (plain build + chunk-isolation contract) is now part of
  `test:release`, so this contract is enforced on every release, not only the
  obfuscated live-build budget.

## [0.5.7] - 2026-07-05

Object and E57 capture honesty, plus an explicit evidence model. v0.5.7 makes
the viewer read a scan for what it is — a compact object, an interior, or a
local-frame terrestrial/handheld capture — and stops applying airborne-survey
and terrain framing where it does not belong. It also replaces the old single
"Production" status with a documented evidence ladder so every scientific claim
states how strongly it is supported.

### Added

- **Capture lens.** A single derivation composes the scan-shape verdict
  (object / interior / terrain) with the display profile (geo / terrestrial-scan
  / handheld / mesh) into one read used across the classifier, reports, and
  panels. It distinguishes "not terrain" (contours/coverage don't apply) from
  "local frame" (no geodetic CRS), so a terrestrial scan of a hillside keeps its
  contours but suppresses CRS, and a temple keeps its CRS suppression without
  losing shape context.
- **Declared-by-the-file provenance card.** When a scan carries a recognised
  display profile or an `olv:` provenance block (E57), the Inspector surfaces the
  declared capture app, sensor, and profile headline under an explicit "Declared
  by the file — not verified" qualifier. Values are shown verbatim; nothing here
  is inferred.
- **Evidence model.** A machine-readable claim register
  (`docs/validation/claim-register.yaml`) and an evidence ladder E0–E6
  (`src/validation/evidenceLevel.ts`) record, per product, the current evidence
  level, the level required to export as validated, and the approved and
  prohibited claims. Independent evidence begins at E4; nothing ships at E4+ yet,
  and the docs say so.
- **glTF capture stamps.** The glTF `asset.generator` string (e.g. Polycam,
  Scaniverse, RealityKit) and a texture/material presence flag are read on load
  and fed to the display profile for handheld-capture identification.

### Changed

- **The capture-type classifier is now shape-aware.** A compact object or
  interior can no longer be labelled drone/aerial/spaceborne from point density
  alone — airborne capture is ruled out by geometry and the verdict is demoted to
  an honest "ground-based, method not determined" rather than a fabricated one.
  Direct evidence (software/sensor strings, the file's own declaration) still
  wins.
- **The Coordinate-system section hides for local-frame scans** (terrestrial /
  handheld / mesh), where a bare "CRS unknown" row reads as a defect rather than
  a fact. The geo/survey path is unchanged.
- **Validation docs corrected for overstatement.** The terrain matrix's
  "Production" status is replaced by evidence levels; the ground filter is
  described as an SMRF-core progressive-morphological subset; confidence,
  NVA/VVA-style, and QL wording are scoped to what the evidence supports; and the
  CRS limitation states precisely what is detected, converted, and propagated
  versus not reprojected.

## [0.5.6] - 2026-07-04

Point filtering. v0.5.6 connects the staged point-filter work to the live
renderer, starting with an elevation filter. Browser-native and local-first;
files never leave the device.

### Added

- **Elevation filter.** Hide points outside a chosen height window. The window
  is given in world units and converted to the scan's attribute space along its
  up-axis (Z-up for LAS/LAZ/E57, Y-up for phone scans); out-of-window points
  collapse to zero size on the GPU (they still run the vertex stage but produce
  no visible sprite and add no extra draw calls), and clearing the filter
  restores the scene exactly. Picking, measuring, snapping, and classification
  edits all respect the filter — you can't select a point you can't see. Works
  for static clouds and streaming COPC/EPT nodes, with an Inspector control.
- **Intensity filter.** Hide points outside a chosen intensity window, in the
  file's raw intensity units. Same GPU approach as the elevation filter; the
  control seeds from the cloud's own intensity range and is hidden for scans
  without an intensity channel.
- **Streaming point-cloud export.** Export the streamed-in (resident) points of
  a COPC/EPT scan to LAS or XYZ (optionally gzip-compressed as `.las.gz`) at
  display resolution. The export is flagged as a reduced view while the whole
  cloud is still streaming. (In-browser LAZ writing is not yet available.)
- **Clearer scan-loading feedback.** Opening a scan — a device file or a public
  or streaming dataset — now shows a prominent blue blinking "Opening…"
  indicator, so an in-flight load reads the same way from either entry point.
- **Readable GPU errors.** If the graphics backend fails to render a scan (a
  shader or pipeline error, which surfaces after the scan has already decoded),
  the reason is now shown as a message instead of leaving a blank view with no
  explanation.

### Fixed

- **Point filters no longer affect scans that don't use them.** The elevation
  and intensity filters now touch a scan's render path only while a filter is
  actually active; opening a scan without a filter renders exactly as it did
  before the filters existed.
- **Filters apply to interaction, not just the picture.** Picking, measuring,
  snapping, focus, probing, annotating, and lasso reclassification now reject
  points hidden by the elevation or intensity filter, so a hidden point can't
  become a measurement vertex or be rewritten by a class edit.
- **Streaming filter controls now appear.** A COPC/EPT scan seeds its elevation
  and intensity controls from the streamed data (previously they stayed hidden),
  and a static→streaming swap clears any leftover filter state.
- **Range-control accuracy.** Clearing a filter field no longer briefly applies
  a bogus zero bound, and re-seeding the extent for a new scan clears the prior
  scan's active filter so the control and the rendered scene always agree.
- **Sessions keep every measurement.** Profile, box, and volume measurements and
  their data (profile chart, corridor width, ground percentile, cut/fill volume
  record, resident-only flags) now survive a session round-trip instead of being
  silently dropped on import.
- **GPU error handling.** The graphics-error listener is now released on teardown
  and de-duplicated per scan, and a lost GPU device surfaces a clear message
  instead of a permanently blank canvas.
- **Startup hardening.** Guarded an empty-state initialisation path so a fresh
  page load can't error before a scan is opened.

### Known limitations

- Elevation/intensity filtering uses a single up-axis and reference origin, so a
  session with multiple layers at differing origins or mixed Z-up/Y-up axes may
  filter some layers inconsistently. Per-layer filtering is planned.

## [0.5.5] - 2026-07-03

Navigation, interface, reporting, and validation. v0.5.5 adds a Pan hand tool,
refines viewport navigation and point rendering, makes the side panels
collapsible, reduces the PDF report set to two documents, corrects scan-health
reporting for deliberately sampled datasets, and adds reproducible performance
diagnostics. Browser-native and local-first; files never leave the device.

### Added

- **Pan hand tool.** A fourth navigation mode. `4` selects Pan, `G` toggles it,
  and a middle-mouse drag pans temporarily from any other mode. A primary mouse,
  pen, or one-finger touch drag moves the scene while the wheel keeps zooming;
  camera orientation and view scale stay fixed. Pan mode is preserved in saved
  sessions and share links.
- **Frame-rate-independent wheel and trackpad zoom.** The same gesture reaches
  the same zoom on a 60, 120, or 144 Hz display, and zoom centres on the pointer
  so the point under the cursor stays put. The previous behaviour stays available
  with `?wheelDolly=legacy`.
- **Motion-adaptive resolution.** While the view moves, the renderer lowers the
  device-pixel ratio a little and restores it once you stop, keeping interaction
  smooth on dense scenes without a visible drop in sharpness. Disable with
  `?adaptiveDpr=off`.
- **Gaussian point-appearance mode.** A point style that softens ordinary point
  samples. It is not a trained 3D Gaussian Splat scene.
- **Collapsible side panels.** A one-tap handle collapses the left column; on the
  right, the Inspector and (when a COPC dataset streams) the streaming card each
  collapse on their own handle, so either can be hidden without the other. Each
  handle's state persists per browser and stays hidden until a scan is open and on
  small screens.
- **Reproducible performance diagnostics.** The optional debug overlay records
  frame-time percentiles (p50/p95/p99), counts of frames over common frame-time
  thresholds, the longest observed main-thread task where the browser supports
  it, the effective device-pixel ratio, and rendering and streaming counters,
  and copies them out as JSON. A deterministic scheduler baseline is included for
  regression testing. No general rendering or streaming speedup is claimed
  without device-specific evidence.

### Changed

- **The PDF report set is now two documents.** Survey Summary is a compact
  handover (inspection summary, dataset information, concise provenance,
  measurements, supplied technical notes). Technical Report is the full record,
  adding detailed provenance, file-declared source metadata, annotations, and
  visuals. Older report-template identifiers map to the nearest current template,
  so existing sessions and integrations still open.
- **Scan-health reporting separates three cases:** a complete decode, a
  deliberate display-sample cap, and a declared-versus-decoded count mismatch. A
  large LAS or LAZ file loaded with an intentional sampling stride reads as
  sampled rather than as having lost points. The decoded count and applied stride
  now cross the parsing-worker boundary intact. Classification coverage shows in
  the Classification row, repeated analysis caveats are merged, and an empty
  cloud reports a verdict instead of an unrelated point count.
- **Left-column panels share one width** so the rail reads as a single aligned
  stack, and its collapse handle sits flush against it. A wheel over any overlay
  panel now scrolls only that panel and never reaches the camera or the page.

### Removed

- **The Scan Acceptance report template.** Its metadata-presence rows did not
  amount to an acceptance test. Acceptance reporting should return only when it is
  backed by explicit, data-derived checks and user-defined criteria; legacy Scan
  Acceptance identifiers fall back to the nearest current template.

## [0.5.4] - 2026-07-02

Terrain science hardening. The "Terrain Complexity" reading is no longer a
heuristic: it is now backed by two literature-defined metrics computed from
the analysed DTM, with windows, units, derived confidence, and a cited
density caveat carried everywhere the number appears.

### Added

- **Real terrain-complexity metrics.** The terrain core now computes the
  Vector Ruggedness Measure (VRM, Sappington et al. 2007, doi:10.2193/2005-723)
  and the Topographic Position Index with Weiss (2001) six-class slope
  position — implemented from the primary literature, riding the existing
  Horn slope/aspect grids, and computed alongside the heavy core in the
  worker (never on the interactive path). VRM was chosen deliberately
  because it is slope-decoupled: a smooth 45° plane scores ~0 ruggedness,
  so steepness is never mistaken for complexity. Both metrics report
  median + IQR, state their window/radius in cells AND ground metres,
  state TPI's Z units, and carry a confidence derived from data support
  (valid fraction × window support) — never asserted.
- **The Dataset Intelligence "Terrain Complexity" row is engine-fed.**
  After a terrain run the row shows the band of the real VRM median
  (Low / Moderate / High / Very High) with the numeric median + IQR,
  window, and units one hover away (and in the Details panel). Until a run
  measures something it still reads "—" — nothing is fabricated.
- **A derived-metrics line on the Analyse panel** under the Terrain
  Assessment: VRM median [IQR] with its window, the dominant TPI landform
  class with its radius, units always stated, with the standard caveat
  treatment.
- **A cited density-reliability caveat.** When the scan-scaled ground
  density is below 4 pts/m², the complexity outputs carry: "point density
  N pts/m² is below the ≥4 pts/m² reliability threshold reported for
  detailed terrain/vegetation complexity (Münzinger et al. 2022,
  doi:10.1016/j.ufug.2022.127637); treat complexity as indicative." A
  warning, never a block; tested present at 2 pts/m² and absent at 6.
- **Complexity in reports and export provenance.** The terrain report and
  every export's provenance now record the metric names, window/radius in
  cells and ground units, Z units, the Horn slope/aspect convention note,
  the derived confidence, and the caveats — reproducible parameters,
  stamped word-for-word identically across README/DXF/SVG/GeoJSON/report
  (the provenance-consistency suite pins the new fields).

### Reproducibility

- `npm run repro` gains metric M5: VRM slope-independence on an analytic
  constant-45° plane vs. an equally steep rough surface, and a
  hand-computed TPI ridge-crest value with its class — CI-guarded, not
  asserted. Unit fixtures prove VRM is identical across feet/metre CRSs
  (dimensionless) and that TPI scales exactly with the Z unit.

### Scientific-audit response

A scientific audit of this release was answered in two groups: data-
correctness defects, each landed with a hand-computed regression test, and
honesty corrections — places where a formula was right but its label
claimed more than it measured. Formulas in the second group are unchanged;
the claims now state their true strength.

Data correctness:

- **EPT size-8 attributes decode by their declared type.** The binary tile
  decoder read every 8-byte dimension as Float64; `int64`/`uint64` now decode
  via BigInt and convert to Number only when exactly representable, so
  X/Y/Z-as-int64 layouts decode correctly and values beyond ±(2⁵³−1) throw
  the same typed malformed-file error the count validator uses.
- **EPT RGB bit depth is one dataset-level decision.** 8-bit-stuffed 16-bit
  colour (the same real-world wrinkle the COPC path already handles) is now
  detected once, pinned on the first decoded RGB tile, and shared through the
  decode-metadata seam — the old unconditional `>> 8` rendered such clouds
  black, and a per-tile decision could have split one cloud into two colour
  depths.
- **E57 scans without Cartesian X/Y/Z are skipped honestly.** A spherical-
  only scan used to inflate the merged allocation and leave phantom
  zero-coordinate points parked at the local origin; it now contributes
  nothing to counts, bounds, or attribute decisions, and a load warning
  (surfaced in the Scan Report) names the skipped scan.
- **E57 normals rotate with the scan pose** (rotation only, never the
  translation) instead of keeping the scanner's frame.
- **E57 pose quaternions are validated**: finite non-unit quaternions are
  normalised with a warning recording the norm; degenerate ones fall back to
  the identity with a warning — never silently scaled or NaN geometry.
- **Over-cap contour levels are thinned evenly, not truncated from the top.**
  The old cap deleted every level above it — summits vanished. Every k-th
  level is now kept with the top level forced in, so the minimum and maximum
  survive at an honestly-stated effective interval of k× the requested one.
- **Marching-squares saddles use the exact bilinear decider.** Connectivity
  now flips at the bilinear saddle value z* = (v0·v2 − v1·v3)/(v0+v2−v1−v3)
  rather than the corner mean — identical on symmetric saddles, correct on
  asymmetric ones where a dominant corner dragged the mean above the true
  saddle and mislinked the contour topology.

Honesty (labels fixed, math unchanged):

- **NVA/VVA are labelled "NVA-style / VVA-style (hold-out)"** everywhere they
  face the user, with tooltips disclosing that the figures apply the ASPRS
  2014 formulas to internally withheld points — not the independent survey
  checkpoints the standard defines them against — and that the VVA-analog is
  the p95 of ALL residuals, not vegetated-class checkpoints.
- **The USGS 3DEP Quality Level reads "(estimated)"** on the panel chip and
  the export-provenance stamp, and its tooltip discloses that the RMSEz leg
  is hold-out-based (the stride-scaled-density note already existed).
- **`checkCalibration` is now `checkConfidenceOrdering`** (result field
  `orderingConsistent`): a monotone confidence→error band ordering is a
  necessary condition for calibration, not calibration itself. The genuine
  PAV isotonic calibration in `calibrateConfidence` keeps its name.
- **Stockpile bands say what they are**: the headline prints "± N m³ (1σ)"
  explicitly, and every result carries a spatial-correlation caveat (the √N
  sampling term assumes independent residuals, which scan noise violates).
- **Change detection's "detectable" now means the ~95% level of detection**
  (|net| > 1.96σ) — the module's own documented LoD convention — instead of
  a bare 1σ bar that called a ~68% wiggle detectable.
- **The measured polygon area is described as the vector (Newell) area** —
  equal to the own-plane area for planar rings, a lower bound for non-planar
  ones — instead of "the true surface area".
- **A geographic frame analysed with an unknown latitude now warns** that the
  east–west scale is uncorrected (cos φ = 1) and derivatives are approximate,
  instead of degrading silently.

### Declared source metadata (E57) and inspection-PDF fixes

A metadata-rich E57 probe file exposed two gaps: the viewer surfaced almost
none of what the file declared about itself, and the Engineering Inspection
PDF asserted a density-derived capture type ("Drone-mounted LiDAR") over a
file whose own metadata declares a synthetic origin. Both are provenance
problems; both now honour the same rule — the viewer reports what the file
DECLARES, labelled as declared and never as verified.

Added:

- **E57 declared source metadata is captured end to end.** The schema reader
  now extracts the root-level provenance fields (guid, e57LibraryVersion,
  creationDateTime, coordinateMetadata) and per-scan fields (name, guid,
  description, sensorVendor / sensorModel / sensorSerialNumber, acquisition
  times, temperature / humidity / pressure, intensity + colour limits) —
  plus, generically, any extension-namespace String/Integer/Float leaf
  fields (e.g. an `olv:` block) at root or scan level, in document order,
  each with its namespace URI. Everything rides `CloudMetadata.
  sourceMetadata` as declared-only data: the E57 empty-element default
  (Integer/Float 0, String "") is treated as NOT declared, so a zero
  acquisition time or blank string is omitted rather than displayed as a
  fabricated value, and malformed metadata degrades to omission with a load
  warning, never a failed load.
- **The Inspector's Scan report gains a collapsible "Source metadata"
  section** listing the declared standard fields, with an "Extended metadata
  (file-declared)" subsection for extension-namespace fields — verbatim
  values (long ones truncated with the full text in the tooltip) under the
  disclosure "Declared by the file, not verified by OpenLiDARViewer". Only
  declared rows render; a metadata-less file shows nothing new.
- **The Engineering Inspection PDF gains a "Declared source metadata"
  section** with the same fields and the same not-verified disclosure,
  omitted entirely when the file declares nothing.
- **The capture-type classifier now consumes declarations as a signal.**
  When sensorModel / description / name / datasetType / accuracyClass
  declare a synthetic / procedural / reconstruction / reference origin, the
  verdict becomes "Declared: <value> (from file metadata)" — quoted
  verbatim, with the density heuristic demoted to a secondary
  low-confidence line and no literature accuracy ribbon attached (the cited
  physical capture-type bounds do not describe a declared synthetic
  source). Files without declared metadata classify exactly as before.

Fixed (Engineering Inspection PDF):

- **The page-1 text overlap.** A provenance citation containing a glyph
  outside WinAnsi ("Ruzgienė") threw mid-section; the per-section error
  isolation reverted the layout cursor, and the Measurements / Annotations
  headings drew OVER the already-rendered Provenance + Signals block. The
  citation line is now sanitised like every other drawn string, and — as
  defence in depth — a failed section resumes on a fresh page so no later
  text can ever land on partially-drawn content. A layout regression test
  parses the rendered content streams and pins the no-overlap rule.
- **Section-heading underlines span the heading text.** The rule under each
  section heading was a fixed 40 pt stub; it now spans the measured text
  width.
- **WinAnsi glyphs print as themselves.** The sanitiser replaced ², ³, ×,
  ÷, ±, °, —, – and friends with ASCII fallbacks ("m^2", "--", "1.96 x")
  even though Helvetica's WinAnsi encoding covers them; those glyphs now
  pass through verbatim (the Methods appendix follows suit), and only
  genuinely unencodable characters are mapped (≥ ≤ → ASCII, Greek → names,
  Latin-Extended letters in author names → base letters, anything else →
  a visible "?").
- **Keep-with-next pagination.** Placeholder-only sections ("No
  measurements taken…") reserve exactly their heading + body instead of a
  flat 60 pt, so a small section stays with its predecessor when it fits
  and breaks as one unit when it doesn't — no orphaned headings, no
  near-empty trailing page holding a two-line block.

### Point-cloud export correctness and provenance (verified against real user exports)

A user's actual CSV/OBJ exports of a metadata-rich E57 exposed one
data-destroying defect and two disclosure gaps, all fixed here:

Data correctness:

- **E57 unit-range float intensity no longer binarizes to {0, 1}.** The
  loader stored intensity with a bare `Math.round` into the Uint16 store, so
  a file declaring continuous float intensity (the sample declares
  intensityLimits 0.2800009–0.7380647 over 1,564,029 points) collapsed to
  two values — the user's CSV export contained only 0 (551,801 rows) and
  1 (1,012,228 rows), and the intensity ramp and inspector saw the same
  wreckage. The E57 path now follows the PTS/PCD rule it missed: a
  unit-range channel (declared intensityMaximum ≤ 1, or an observed maximum
  ≤ 1 when the file declares no limits) rescales ×65535 into the 16-bit
  store — absolute scaling, never min–max stretching — while wider ranges
  stay raw. Exports carry the stored 0–65535 integers; against the real
  sample the channel now spans 18350–48369, continuous. Red-green pinned:
  the pre-fix fixture read `[0, 1, 1]`.
- **PLY and OBJ write geographic coordinates at 7 dp.** The v0.4.5 lat/lon
  precision fix (3 dp of a degree is ~110 m) reached only XYZ/CSV; the PLY
  and OBJ writers kept millimetre-style 3 dp on degrees. Both now use the
  same geographic-aware formatter; Z stays 3 dp, projected/local exports are
  byte-identical.

Honest disclosure:

- **Declared provenance rides the export headers.** XYZ (`#`), PLY
  (`comment`) and OBJ (`#`) exports of a cloud with declared source metadata
  now open with: exporter + version, source file name, declared source
  (sensorModel, else the declared scan name), declared license and declared
  limitations when present — verbatim values, single-line-flattened and
  length-capped so file text can never break the format — closed by the
  standing "declared by the file, not verified by OpenLiDARViewer"
  disclosure. Only declared fields print; a cloud that declares nothing gets
  no section, and metadata-less exports stay byte-identical to earlier
  releases. CSV deliberately stays pure data (no comment convention naive
  parsers survive): header row first, always.
- **Dropped channels are named, not silently vanished.** OBJ discloses
  intensity/classification as "not representable in OBJ — omitted" and
  normals as "not written by this exporter — omitted" (OBJ could carry
  `vn`; the wording claims no more than what happens); PLY discloses
  intensity/classification/normals; XYZ discloses normals (its intensity and
  classification ride as columns).

## [0.5.3] - 2026-07-01

A hardening patch on v0.5. Change detection gains real epoch alignment, the
viewer installs and runs offline (PWA), and a one-command harness reproduces
the evaluation — on top of seventeen defect fixes from two audit passes: nine
terrain/profile hardenings and eight Phase 0 Criticals.

### Changed

- **The on-canvas compass is now a discoverable, remembered control.** The
  compass / ViewCube gizmo from v0.5.2, previously reachable only through the
  `?viewcube=1` URL flag, can now be toggled from the command palette ("Toggle
  compass"), and the choice persists. It stays off by default: the app's left and
  right edges are full-height panel columns, so a persistent gizmo has no free
  corner without overlapping them. `?viewcube=1` and `?viewcube=0` still force it
  on or off. The animation loop pauses while the tab is hidden.

### Added

- **Two-cloud alignment in change detection.** The planar ICP core shipped in
  v0.5.2 is now wired into the two-epoch change-detection flow. Before two epochs
  are compared, the after cloud is coarse-registered onto the before cloud
  (yaw + horizontal shift only — a real vertical change is the signal, so z is
  preserved), and the fit is reported: the shift, the yaw, and the RMS residual
  appear in the compare result. A fit whose residual exceeds the gate is refused
  and the clouds are compared as-is, so alignment never invents a shift it can't
  stand behind. The pure core (`alignEpochClouds`) is unit-tested.
- **Installable and offline (PWA).** A service worker caches the app shell, so
  the viewer opens and runs with no network after the first visit, and it can be
  installed as a standalone app. The worker is local-first by construction: it
  caches only the same-origin app shell and never touches a cross-origin dataset
  request, so opening a remote scan still goes straight to its source and nothing
  the user loads is stored. Registered on production secure origins only.

### Reproducibility

- **A one-command evaluation harness** (`npm run repro`). It runs the pure
  analysis cores over deterministic synthetic fixtures with analytic ground truth
  and writes a metrics table plus reliability figures: the epoch-registration
  vertical-bias result (horizontal-only preserves a uniform vertical change while
  a full-3D fit absorbs it), planar-alignment recovery, stockpile ±-band coverage
  (empirical vs nominal 0.68), and report-digest determinism. The coverage and
  bias checks also run as a CI-guarded unit test, so the uncertainty claims are
  tested rather than asserted. A `REVIEWER_QUICKSTART.md` gives the
  clone → test → repro → verify path.

### Fixed

- **The deployed site no longer runs slower than a local build.** The live
  deployment's source transform rewrites property access into decode-wrapper
  calls — and inside per-POINT loops that meant one wrapper call per point per
  access. On a 2.5 M-point scan the deployed site burned seconds a plain build
  does not: the scan-attach main-thread task grew from 6.6 s to 10.2 s and a
  single measure/probe pick from 56 ms to 178 ms (3.2×, profiled headless
  A/B). The six modules that carry whole-cloud loops (health check, cloud
  bounds, colour encoding, pick math, snap grid, viewer attach/render loop)
  are now excluded from the transform, and the deployed build measures at
  parity with the plain one. Local files still never leave the machine — this
  was compute, not upload.
- **Opening a large local file no longer freezes the viewer for seconds.** The
  Scan Report's health check walks every point several times (duplicate-point
  scan, median/MAD, outliers, finite check) and ran synchronously at scan
  attach — ~5 s of frozen UI on a multi-million-point cloud, on top of the
  transform cost above. It now runs when the main thread next goes idle: the
  scan renders and navigates immediately and the report card fills in a beat
  later. Measured attach-path blocking fell from 6.6 s to 0.6 s at 2.5 M
  points.
- **Offline support now works on sub-path deployments.** The service worker
  registered as `/sw.js` — an origin-root path, so any deploy under a sub-path
  (GitHub Pages `…/repo/`) 404'd the registration and silently lost offline
  support and installability. The worker URL now resolves relative to the page
  (unit-tested), and the worker's sample-dataset cache exclusion resolves
  against its registration scope the same way.

Nine correctness hardenings from the v0.4.x terrain/profile audit, ported onto
the 0.5 pipeline (each verified at its current location before fixing, every
new expectation hand-computed):

- **Geographic (lat/lon) scans no longer collapse to a 1-cell grid.** The
  analysis runner's cell-size floor was a raw `0.25` in SOURCE units — on a
  degree CRS that forced 0.25° ≈ 28 km cells, flattening any scan under ~64° of
  extent to 1–2 cells. The floor is now 0.25 metres expressed in the source
  unit (degrees ÷ metres-per-degree, feet ÷ metres-per-foot; metres unchanged).
  Two-epoch change detection's shared grid had the same unit-blind floor and
  gets the same fix, with each cloud's CRS units threaded honestly from the
  loaded metadata (and surviving epoch alignment).
- **cos φ everywhere derivatives run, from the WORLD latitude.** v0.5.0 made
  the hold-out and cell-confidence slope fields per-axis, but both derived the
  "grid-centre latitude" from render-RECENTRED local Y — which is ≈ 0, so
  cos φ silently degraded to 1. The runner now recovers the true world latitude
  (cloud origin + local bbox centre) and threads it through the pipeline; the
  main derivative stage (slope/aspect/hillshade) is per-axis too, through the
  whole TerrainRasterEngine — CPU reference, the WGSL Horn kernel's uniform,
  and the per-session equivalence probe, which now runs an anisotropic pass so
  a GPU kernel that ignores the second axis can never pass the gate. Per-cell
  densities (and the USGS QL graded from them) fold the cos φ cell-area
  anisotropy in as √(cos φ). The CPU remains the reference by contract.
- **One percentile convention.** Three conventions coexisted: nearest-rank in
  `holdoutRmse` / `buildDsm` / `hillshade` vs the type-7 (NumPy/R/Excel
  PERCENTILE.INC) quantile in `rasterizeDtm` / `wallSlice`. Every p95 the
  pipeline reports now routes through one shared type-7 helper
  (`src/terrain/quantile.ts`), so a reported percentile is reproducible
  against standard tools regardless of which file computed it.
- **Contour correctness on fine and degree-denominated grids.** Contour
  stitching's endpoint-matching quantum was a fixed 1 mm — ≈ 111 m in degrees,
  welding a fine geographic grid's contours into one blob; it now scales with
  the grid cell (cell/1000, unit-free). The coarse-interval gate used the
  range-only rule `interval < range`, falsely rejecting e.g. a 1 m interval on
  a 0.4–1.2 m surface even though the 1.0 level crosses it; with real surface
  bounds it now uses the exact level-crossing test (`ceil(minZ/i)·i ≤ maxZ`).
  Marching-squares saddle cells (cases 5/10) are now disambiguated with the
  standard cell-average rule instead of a fixed pairing that silently assumed
  centre-below for both — mislinking basins on ridge/col terrain.
- **The ground-filter despike actually fires on small cells.** The documented
  `floorPercentile` despike was a silent no-op for cells with ≤ 20 returns
  (`ceil(0.05·n)−1 = 0` — the strict minimum, blunder included, still won).
  Once a cell has ≥ 3 returns, at least the single lowest return is now
  skipped; 1–2-return cells keep the minimum (no evidence to reject either).
- **Signed vertical grade.** A straight-DOWN pair reported `gradePercent` as
  an infinite CLIMB (`+Infinity`); the grade's sign now matches the rise's
  (±∞), agreeing with the ±90° the angle already reported — in both
  `slopeBetween` and `profileMetrics`.
- **Terrain worker point-count clamp.** An oversized caller-supplied point
  count would throw inside the terrain-core worker while rebuilding its typed
  array — silently costing the off-thread path via the fallback. The count is
  now clamped to what the buffer actually holds.
- **Geographic CRS measurements are refused, not mislabelled.** On a
  geographic (degree) CRS, X/Y are degrees while Z is linear, so lengths,
  areas, grades, profiles and volumes mix units and no scalar factor can
  repair them — a 0.35-"m" corridor is really ≈ 39 km. The measure stack now
  says so everywhere with ONE shared string: affected measurements carry the
  red refusal trust grade (not presentable — pure-vertical heights and
  unit-free angles keep their ordinary grade), the measure-bar hint carries
  the caveat, and the Measurements panel shows a persistent notice while the
  frame is geographic. Symmetric on a user override to a projected CRS.

Eight Critical-severity fixes from the Phase 0 baseline audit of the v0.5.x
line (each reproduced with a failing test before the fix wherever the surface
allows):

- **Applying epoch alignment no longer degrades a georeferenced survey.** The
  aligned after cloud was stored as ABSOLUTE world coordinates in a
  `Float32Array` with its origin collapsed to zero — at georeferenced
  magnitudes (UTM northing ~4,000,000) the float32 quantum is ~0.25–0.5 m,
  larger than the centimetre-level misalignment ICP corrects, so applying the
  alignment injected up to half a metre of horizontal jitter into the after
  cloud before rasterisation, on the most common real case (two georeferenced
  surveys). The transform is now computed in float64 world space and stored
  back LOCAL to the cloud's preserved origin; only the small residual rounds
  to float32.
- **Planar ICP is refused on geographic (degree) frames.** `alignEpochClouds`
  received the geographic flag on both clouds but never read it: the planar
  rigid model was fit in raw lon/lat, where 1° of longitude ≠ 1° of latitude
  (cos φ) — a solved yaw is a SHEAR in metres, the convergence tolerance was
  ~1.1 m expressed in degrees (declaring convergence long before a meaningful
  fit), and the residual gate compared degree numbers against a metre
  threshold. The transform could worsen registration off the equator while
  reporting success. Measurements already refuse geographic frames through
  the trust system; alignment now refuses them too — clouds untouched, with a
  distinct summary line pointing at reprojection.
- **Alignment reports metres, not source units.** The alignment result
  documents its shift and residual in metres and the UI prints "N m", but the
  values came out of the fit in the clouds' own units — a foot-CRS survey
  shifted 10 ft displayed as a "10.00 m shift", and the metre-denominated
  residual gate compared against feet. The unit seam now lives in one place:
  the gate converts to source units going into the fit, the reported shift
  and residual convert to metres coming out, and the applied transform stays
  in source units, as it must. Geographic frames never reach this seam — they
  are refused earlier.
- **Geographic epochs refuse cut/fill volumes instead of printing degrees² as
  m³.** The epoch-compare path passed geographic DTMs straight into volume
  integration, where a degree-sized cell area underreports volumes by ~10
  orders of magnitude, and the summary printed the result as "N m³" — worst
  case flagged MEASURED, because two epochs declaring the same geographic CRS
  and vertical datum pass every co-registration check. Volumes on a degree
  grid are now refused with the shared geographic-refusal reason; the Δz
  statistics remain valid and are still reported (z is a linear unit).
- **Lasso reclassify can no longer edit points you cannot see.** The lasso
  selection culled only points outside the view frustum, so a reclassify
  permanently rewrote points hidden by the active clip box or by a hidden
  ASPRS class — an edit to invisible data, contradicting the click-pick
  contract, which already refuses hidden points. The selection now runs
  through the same clip predicate the GPU clipping planes realise and the
  same class-visibility mask picking uses; in-place compaction, no allocation
  on the edit path.
- **A classification edit flags the on-screen analysis stale.** The edit hook
  promised cache invalidation AND a re-grade, but only cleared the
  terrain-core cache — the rendered verdict, contours, and coverage stayed on
  screen presented as current while reflecting the previous classification.
  The Analyse panel now shows a staleness caveat at the top of the results
  ("results reflect the previous classification — re-run Analyse"), cleared
  by the next run, and the contract now states what actually happens: a
  staleness disclosure, not a silent auto re-grade.
- **The clip box survives a session round-trip.** The v5 session schema
  documents a clip round-trip and the import side has restored it since v5,
  but export never emitted the clip — no session written by this app could
  carry one. Emitting it exposed two more gaps, fixed together: the
  reveal-time auto-frame destroyed a clip restored before the scan appeared
  (now skipped when the viewer already holds one), and the Clip panel never
  reflected a restored box (it now adopts the state — inputs, mode pills,
  enable box, readout — without re-firing the apply).
- **Visiting another page can no longer poison the offline app shell.** The
  service worker cached EVERY same-origin navigation response under the
  app-shell key, so opening the credits page (or landing on a 404/500 or a
  redirect tail) replaced the cached shell and the next offline launch served
  the wrong document as the app. The shell now refreshes only from an ok,
  non-redirected response to the registration-scope root (or its
  `/index.html`).

## [0.5.2] - 2026-06-29

A polish release: a stronger integrity digest, a richer earthwork report, an
opt-in on-canvas compass, and a build guard that closes the live-only 404 class
for good.

### Changed

- **The integrity report now uses SHA-256 by default.** The content digest that
  makes a measurement report tamper-evident is now a cryptographic-strength
  SHA-256 (manifest v3), computed synchronously so the core stays pure and
  deterministic. It is still an integrity digest, not a secret-keyed signature.
  A caller can inject the older FNV-1a checksum where speed matters more.
- **Volume findings carry the whole earthwork.** A volume measurement in the
  integrity report now reports the net as its headline with the cut and fill,
  the footprint area, the confidence tier, and any streaming-resident caveat
  riding along, instead of the fill alone.

### Added

- **On-canvas compass / ViewCube (opt-in).** A small compass gizmo shows which
  way the camera faces and snaps to a standard view on click. Behind `?viewcube=1`
  while it gets on-device verification; the heading/face math is unit-tested and
  the widget loads lazily.
- **Build guard against inline dynamic imports.** A new `lint:inline-imports`
  check fails the build if a runtime `import('./…')` reappears in `main.ts`,
  where the obfuscator could scramble the specifier into a deploy-only 404. Wired
  into the release gate and CI.
- **Release-sync guard.** A new `lint:release-sync` check fails the build unless
  the version in `package.json`, the lockfile, the README's current-release line,
  the changelog section, and the release-notes file all agree. Wired into the
  release gate and CI.
- **The integrity report records the version that produced it.** The exported
  report manifest now carries the app version, so a reader can tell whether a
  newer build would grade or label the scan differently. The field is covered by
  the report digest.
- **Re-opening an old session flags a version gap.** A saved session now stamps
  the app version that wrote it; opening one written by an earlier build shows a
  short notice that the current build may read the scan differently, so you can
  re-save. A session with no stamp reads as "an earlier version".
- **Verify an integrity report.** A new command-palette action ("Verify
  integrity report…") opens a report JSON, recomputes its digest against the
  algorithm the file names, and shows whether it is intact or has been modified,
  along with the producing version, classification epoch, and finding count. The
  handed-over report becomes a checkable artifact, not just a JSON dump.

### Foundations

These tested cores ship in source ahead of the interface that will use them, the
project's usual pattern:

- **Planar ICP alignment** (`icpRegister`) — coarse rigid alignment of one cloud
  onto another (3-D translation + yaw) with a reported RMS residual that refuses
  a fit it can't trust. The honest prerequisite for aligning two epochs before a
  change comparison.
- **Export-staleness helper** (`exportStaleness`) — compares a stamped producing
  version against the running one, so an export from an older build can be
  flagged for regeneration.

### Performance

- **Lighter startup.** The workflow-recorder settings popup now loads on first
  open instead of riding in the eager startup bundle, trimming the live index
  chunk (757 → 750 KiB) and shaving a little off first paint. The bundle ceiling
  was lowered to match, so the saved room can't silently creep back.
- The opt-in on-canvas compass animation loop pauses while the browser tab is
  hidden rather than running every frame in the background.

### Documentation

- The navigation guide and the User Guide now list the keyboard and mouse
  shortcuts (command palette, the `?` sheet, undo, right-click menu, hold-Space),
  sourced from the live key bindings.

### Maintenance

- The native-unit contract is documented on `StockpileBreakdown`, and the report
  export's `signed*` names were renamed to `integrity*` to match what the file
  actually is.

## [0.5.1] - 2026-06-28

Deepens the honest-uncertainty work. Stockpile/earthworks volume now reports an auditable
confidence band, manual classification editing lands end-to-end (class picker,
lasso reclassify, multi-step undo/redo), and measurements export as a
tamper-evident integrity report. Adds two-epoch change-detection uncertainty and
edit-aware provenance so an edited classification can never silently outlive the
numbers computed from it.

### Added

- **Stockpile / earthworks volume with a confidence band.** The lasso volume
  readout carries a ± band that states its own uncertainty — a sampling-error
  term (area·σ/√N) and a systematic base-plane term (a single horizontal base
  under sloped ground biases every thickness the same direction) combined in
  quadrature — plus a show-the-math breakdown and honest caveats.
- **Manual classification editing.** A class picker and a lasso-reclassify tool
  with real multi-step undo/redo, lazy-loaded beside the classification legend.
  Edits mutate the live class channel, so they round-trip straight into LAS
  export.
- **Tamper-evident integrity report.** Placed measurements export as a JSON
  report whose findings, dataset provenance, and classification edit-epoch are
  folded into a verifiable content digest (deterministic canonical hashing;
  default FNV-1a, named in the manifest as `digestAlgorithm`). Changing any
  figure without recomputing the digest breaks verification — a guard against
  accidental or casual edits, not a secret-keyed cryptographic signature
  (SHA-256 hashFn is injectable for that).
- **Two-epoch change-detection uncertainty.** A volume-change ± band (random
  cell noise that averages as √N plus a systematic co-registration term) that
  also reports whether the net change exceeds its own error — never presenting
  noise as a confident gain or loss.

### Changed

- **Undo now reaches every edit.** Ctrl/Cmd+Z (and Shift+Z / Ctrl+Y to redo)
  undoes whichever history you touched last — annotations or classification —
  and falls through to the other once one empties. Classification edits were
  previously reversible only from the reclassify panel's own buttons, so a
  keyboard undo did nothing after a lasso reclassify.
- **Hold Space to re-orient mid-tool.** While Measure, Inspect, or Annotate is
  active, holding Space hands the mouse back to camera navigation so you can
  rotate, pan, and zoom without leaving the tool, then release to resume.
- **Right-click menu on the scan.** Right-clicking a loaded cloud offers focus
  the pivot on the point under the cursor, frame the whole scan, or snap to the
  top / front / oblique view.
- **Accurate keyboard help.** The Help overlay now documents the up/down and
  sprint navigation keys, the measure-mode Enter/Backspace keys, and the
  broadened undo, matching what the viewer actually does.
- **More detail on capable desktops.** The high-end desktop tier (ample RAM and
  cores) now keeps more of a dense survey resident before automatic point
  reduction kicks in; mid and low tiers and mobile are unchanged, and the GPU
  safety ceiling still bounds every path.
- **Stockpile volumes flag a reduced cloud.** When a cloud was automatically
  reduced to fit the device, a lasso/stockpile volume now adds a caveat that the
  inside points are a representative sample of a denser survey — the ± band
  already widens with the thinner sample, and now the reason is stated.
- **Classification edits invalidate stale analysis.** Each edit (swap,
  reclassify, undo, redo) bumps a per-cloud edit epoch and drops the
  terrain-core cache, so the next Analyse recomputes against the edited classes
  instead of serving a grade that no longer matches the cloud.

### Fixed

- **Stockpile base-plane honesty.** Base uncertainty now models the systematic
  mis-fit of a flat base under sloped ground, not just point scatter — a sloped
  apron honestly widens the band instead of reporting a confidently-narrow
  number.
- **Sampling-error self-consistency.** The √N in the stockpile sampling error is
  taken over the same finite inside-height population its σ is computed on.
- **Reliable file downloads on Safari / iOS and for large exports.** Every export
  now funnels through one helper that releases the temporary blob URL only after
  the download has had a moment to start, instead of immediately — an immediate
  release could cancel large PDF / DEM / batch-ZIP / integrity-report downloads
  mid-transfer on some browsers.
- **Imported render state is range-checked.** A point size or field-of-view read
  back from a saved session is now clamped to a sane range, so a hand-edited or
  corrupted session file can't load the viewer into an unusable display state.

### Tooling

- The browser smoke test can now optionally run against the production
  (minified) build, catching build-only breakage that the development build
  never surfaces.

## [0.5.0] - 2026-06-26

Opens the v0.5 line (Measure · Place · Compare · Share): point snapping, KML
export, the Layers panel (isolate / lock / CRS-mismatch flagging), two-epoch
change detection, and the clip box. The line also gained a full-cloud quality
grade for streaming scans, an Evidence Capsule that carries trust grades inside
the shared session, per-measurement honesty grading, and a substantial
correctness, units, performance, and security hardening pass.

### Added

- **Full-cloud grade for streaming scans.** Streaming COPC/EPT scans can be
  graded against a deep octree sample rather than the preview tile — an
  areal-primary density tier, valid-point tracking, cancel support, and a Z
  graded in true metres via the vertical CRS unit. The grade is discarded if the
  scan is detached or replaced mid-decode.
- **Evidence Capsule.** Trust grades and provenance travel inside the shared
  `.olvsession`, so a re-opened session shows the same honesty assessment it was
  saved with.
- **Per-measurement honesty grade.** Each measurement carries a red/yellow/green
  grade with a "show why" breakdown and a refusal gate when the data can't
  support the claim.
- **Instant analysis-on-drop.** Dropping a scan surfaces the most relevant
  analysis one click away, before any upload.
- **Unified `.olvsession` open.** One router handles drop-to-open and the
  open-from-URL path consistently.
- **Drone capture-type classification** for dense low-altitude UAV flights, with
  capture-type confidence surfaced.
- **Elevation-difference export** (`.asc`) that honours the active clip box, plus
  three roadmap on-ramps (3D Tiles guidance, COPC conversion, co-registration
  checklist).

### Performance

- **EPT laszip tiles decode in a dedicated worker**, off the main thread —
  mirroring the COPC decode worker (request-id multiplexing, abort, stale-reply
  drop), with an in-process fallback and a browser round-trip e2e.
- **ClipPanel edits are debounced** and the **per-cloud health check is
  memoised**, so editing the clip extents or refreshing the Inspector no longer
  re-runs O(N) work on every keystroke.
- **Full-cloud grade streams into one buffer** instead of chunks plus a merged
  copy; the session parser, the measurement/KML exporters, and two-epoch change
  detection are lazy-loaded off the initial bundle; export downloads copy the
  payload only when it is a partial view; the default streaming point budget is
  trimmed to 2.5M and EDL is suspended while the camera moves.

### Fixed

- **Cut/fill volume on Y-up scans.** The Volume measurement integrated point
  heights along a hardcoded Z axis even on Y-up clouds (iPhone / mobile PLY,
  OBJ, GLB/GLTF exports), while the reference plane was already derived along
  the cloud's real up-axis — so the height axis and the reference disagreed and
  the reported cut/fill volume was wrong. The volume sampler now reads the
  configured world up (`_worldUp`), matching the profile sampler's earlier B1
  fix. Z-up surveys (LAS/LAZ/E57) and the streaming COPC/EPT path — Z-up by
  spec — are unaffected.
- **Clip control no longer throws on a fresh page.** The clip panel cleared its
  state during construction, which fired before the deferred 3D viewer existed
  and raised an uncaught error on every page load. The clear is now a no-op
  until a scan is open, matching every other startup-reachable viewer action.
- **Units reported in true metres.** Lasso volume, the scan report, scan-story
  footprint area, and change-detection cut/fill now convert from the source
  CRS's native units to metres (and m²/m³) instead of reporting raw projected
  units; per-axis slope on geographic grids applies the cos φ longitude factor.
- **Horizontal datum resolved once, never downgrading.** The datum is derived a
  single time and a known datum is never replaced by a coarser guess.
- **COPC RGB bit-depth decided once per file**, not per chunk, so colour can't
  shift between octree nodes; the EPT laszip path unifies the same way.
- **EPT laszip worker URL stays readable in the shipped build.** The obfuscated
  bundle's string transform could scramble the worker URL into a 404; the worker
  client is now excluded from that transform and both chunks are pinned.
- **A non-finite coordinate can no longer blow `PointCloud` bounds to infinity**;
  GPS Standard Time is declared in converted LAS global encoding; the streaming
  colour ramp seeds from the coarsest node; the shared parse-worker is serialised
  across concurrent loads; two epochs are aligned by origin before differencing.

### Changed

- **One sRGB colour seam.** The linear→sRGB OETF, previously carried as two
  byte-identical inline copies in `patchView.ts` and `colorProvenance.ts`,
  now lives once in `colorEncode.ts` as `linearToSrgbScalar` (the exact
  inverse of the existing `srgbToLinearScalar`). Both leaf modules already
  shared the decode direction; the encode direction is now converged too, so
  the provenance card and the neighbourhood splat can no longer drift from
  the curve the GPU upload uses.

### Security

- **Enforcing Content-Security-Policy** (`script-src 'self' 'wasm-unsafe-eval'`,
  `style-src 'self' 'unsafe-inline'`) shipped in both `.htaccess` and `_headers`,
  backed by an `unsafeHtml` injection-sink lint guard wired into CI.
- **Supply-chain hardening.** loaders.gl is pinned to local workers (no CDN
  fetch), and the CI workflows run with least-privilege permissions and bounded,
  capped test buckets.

## [0.4.9] - 2026-06-20

### Added

- **Data Fitness scorecard.** The Analyse panel now leads with one plain-language
  verdict and a six-row traffic-light scorecard — Location & height, Coverage,
  Ground detail, Vertical accuracy, Classification, Integrity — each with a
  metaphor icon and a shape-distinct tone glyph (check / dash / triangle, never
  colour alone). Caveats are non-hideable, and the USGS Quality Level badge is
  shown only when earned (georeferenced, density above floor,
  accuracy validated).
- **Portable security headers.** A `_headers` file ships alongside `.htaccess`
  so the same deploy bundle is hardened on Netlify / Cloudflare Pages-style
  static hosts, not only Apache-family ones.

### Changed

- **File-scale honesty across every surface.** Large clouds are strided for
  display, so the rendered count is a subset. The Scan Report, the Engineering
  Inspection PDF, the Provenance density, and the Layers chip now report the
  file's true point count and areal density (back-scaled from the sample), with
  a "Loaded" row disclosing the in-memory subset — a dense survey no longer
  reads as several times sparser than it is.
- **Capture-type detection.** Dense drone surveys (UAV LiDAR, ~100–1000 pts/m²
  over an open mapping footprint) classify as drone-mounted LiDAR rather than
  Terrestrial Laser Scan, matching the cited density literature.
- **Honest classification + terrain wording.** A classification dimension that
  carries no assigned classes reads "Present, unclassified" instead of a bare
  "Yes"; the Terrain Intelligence Report labels its ground-point counts "Ground
  points / Used in DTM" rather than the misreadable "Source points".
- **Analyse panel de-duplicated.** Each fact now has one home — the scorecard is
  the headline, the assessment block carries export readiness + terrain products
  + "Why?", and the collapsed Details holds the lone composite score and the
  unique validation detail.
- **Portable PWA manifest.** Relative `./` paths + `scope` so the app installs
  correctly under subpath hosting; `X-Frame-Options: SAMEORIGIN` added.

### Fixed

- The point cloud no longer clips to a square on browser zoom-out.
- Contour GeoJSON exports carry 3D coordinates (elevation) and per-feature
  evidence grades.
- Vertical units are honoured: `VerticalUnitsGeoKey` (4099) and the WKT vertical
  `UNIT` are parsed, and Z is scaled to metres for accuracy bucketing.
- Honest height wording for georeferenced scans. A horizontally-georeferenced
  scan with an undeclared vertical datum (common for drone LiDAR — absolute
  Z, no `VerticalCRS`) now reads "elevation datum not declared" rather than
  "heights are relative." Its heights are absolute; only the datum is unverified.
  Truly floating scans (no CRS) still read "relative."

### Under the hood

- A tested orchestration seam for the full-cloud grade (plan → coverage →
  back-scaled grade) landed ahead of its streaming surface.
- Brand assets trimmed ~1.05 MB from the deploy: the mark and favicon are
  re-rastered to display size, and the unused full-resolution logo master moved
  out of the shipped bundle (kept in the repo for regenerating share cards).

## [0.4.8] - 2026-06-17

### Added

- **Data sources & credits.** A new credits page (in-app `credits.html`, reachable
  from a Credits link in the header, mirrored in `docs/credits.md`) attributes the
  streamed sample datasets to their providers — USGS 3DEP, swisstopo, GURS, and AHN
  — and thanks the open-source projects the viewer is built on (three.js, loaders.gl,
  proj4, pdf-lib, laz-perf). The README gained an Acknowledgements section tying
  these together.

### Changed

- **Curated datasets restricted to confirmed-open sources.** The public-LiDAR
  picker now lists only datasets with a confirmed open licence — USGS 3DEP
  (public domain) and the swisstopo / GURS / AHN national programmes. Sample
  datasets whose licence could not be confirmed were removed, and the bundled
  "Public streaming demo" button (which pointed at an unlicensed demo bucket) was
  removed; the open-from-URL field still accepts any COPC/EPT URL.
- **Sessions remember the class-visibility filter.** Hiding classes (e.g. "ground
  only") and exporting an `.olvsession` now carries that filter; re-importing
  restores it. Schema v5, strictly additive — older sessions load unchanged.

### Fixed

- **Third-party notices completeness.** `THIRD_PARTY_NOTICES.md` now lists `proj4`
  (MIT) and the Manrope and JetBrains Mono fonts (OFL-1.1), which were bundled but
  previously unlisted.
- Corrected the Slovenia (GURS) dataset licence label, which had asserted a specific
  CC version the sources don't agree on.

### Under the hood

- Tested, pure cores landed ahead of their interactive surfaces: measurement
  GeoJSON/CSV export, two-epoch DTM change detection, an axis-aligned clipping-box
  region core, a breadth-first full-cloud sampling planner, and a gzip (`.las.gz`)
  export path. Each is unit-tested in isolation; the UI that drives them follows.

## [0.4.7] - 2026-06-15

A correctness and honesty pass across the load, export, and analysis paths,
alongside a few accessibility and workflow additions.

### Added

- **Colourblind-safe classification palette.** A checkbox in the Classes panel
  recolours the classes with an Okabe-Ito categorical palette (ground orange,
  vegetation as lightness steps of bluish-green, buildings vermillion, water
  blue) that stays distinguishable under the common colour-vision deficiencies.
  The class label and count stay on every row, so colour is never the only cue.
- **Annotation grouping.** The Annotations panel and the PDF report now open
  with a one-line summary of the notes — totals, the per-category breakdown, and
  how many areas they fall across — so a dense set reads at a glance.
- **Workflow recorder.** Record a sequence of camera moves and tool actions and
  replay it (on the same scan), with a settings popup for the file format,
  save destination, start/stop shortcut, replay speed, a pre-record countdown,
  which action families are captured, and loop replay. Records actions only —
  never scan data.
- **Signal-tier cue on the Dataset Intelligence card.** A quiet coloured dot
  marks each row's qualitative tier; terrain complexity stays neutral (it is
  descriptive, not a quality) and a missing signal is muted. The colourblind
  toggle also re-themes these status dots and the confidence chip.
- **Recommended-view chip.** After a scan loads, a small dismissible chip
  suggests the best camera preset (top-down for a wide classified surface,
  oblique for a colour scan, isometric otherwise); one click applies it.
- **Profile stations on the cloud and in the report.** A cross-section profile
  drops small station markers along the section line in 3D, and the PDF report
  now draws the profile as a sharp vector chart, not just the station text.
- **More accessible report PDFs.** The document title is announced instead of
  the filename, and the document language is tagged for correct pronunciation.

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
touch-target / safe-area improvements. Three more visible improvements:
the plumbed-but-headless floor-plan export knobs get a small
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
