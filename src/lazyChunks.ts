/**
 * lazyChunks.ts
 *
 * The dynamic-import seam for the COPC + streaming subsystem.
 *
 * Every `import()` here is a code-splitting boundary: the COPC parsers, the
 * streaming engine, and the range sources load only when a COPC scan is
 * opened, never as part of the initial app payload.
 *
 * WHY THIS MODULE EXISTS — and why it MUST stay in the live source-
 * transform's exclude list (see `vite.config.ts`):
 *
 * The live build runs a source-transform plugin in Vite's `transform`
 * hook with `stringArray` enabled. That transform rewrites string
 * literals — including the specifier of a dynamic `import('./literal')` —
 * into string-array lookups. Once the specifier is no longer a literal,
 * Vite/Rolldown can no longer statically analyse the import, the split
 * chunk is never emitted, and the call fails at runtime ("Failed to
 * fetch dynamically imported module").
 *
 * It is the same hazard that keeps `loadFile.ts` and `copcWorkerClient.ts`
 * (each carrying a `new Worker(new URL(...))`) out of the live transform.
 * Holding all of the COPC dynamic imports in this one excluded module
 * lets the transformed callers (`main.ts`, `Viewer.ts`) reach the chunks
 * through plain static imports of these helpers — which the live
 * transform does not touch.
 *
 * Do not inline these `import()` calls back into their callers.
 */

/**
 * Load the Viewer (three.js + every render controller) on demand.
 *
 * Keeping `Viewer` behind this lazy boundary keeps three.js (~500 KB)
 * out of the initial shell. The empty-state UI renders without three.js;
 * the first scan-open kicks off this dynamic import, instantiates the
 * Viewer against `stage.canvas`, then continues into the normal load
 * pipeline. Subsequent opens re-use the already-loaded module.
 */
export const loadViewer = () => import('./render/Viewer');

/**
 * Load the Contour Studio launcher (state adapter + launcher DOM builder) on
 * demand — the first time a terrain analysis completes, never in the initial
 * shell (v0.5.9 §26.1). Keeps the launcher, adapter, and launch-state strings
 * out of the eager index chunk.
 */
export const loadContourStudioMount = () => import('./ui/contourStudioMount');

/**
 * Load the Contour Studio export ORCHESTRATION (the permit gate + dispatch) on
 * the first export click. The permit resolver pulls the evidence registry, so
 * keeping it here — not eager in AnalysePanel — holds that whole chain out of the
 * startup shell. The export only fires from inside the (already lazy) Studio, so
 * this chunk is guaranteed loadable by the time it is needed.
 */
export const loadContourExportAdapter = () => import('./ui/contourExportAdapter');

/**
 * Load the v0.5.7 capability-driven panel wiring on scan open. Held out of the
 * eager shell (it imports `displayProfile` + `scanCapability`) so those modules
 * don't count against the tight `index` bundle budget — the profile is only
 * needed once a scan has loaded.
 */
export const loadApplyDisplayProfile = () => import('./render/applyDisplayProfile');

/** Load the streaming point-cloud module (COPC octree + IO). */
export const loadStreamingPointCloud = () =>
  import('./render/streaming/StreamingPointCloud');

/** Load the COPC decode worker client. */
export const loadCopcWorkerClient = () =>
  import('./io/copc/worker/copcWorkerClient');

/** Load the EPT laszip decode worker client. */
export const loadEptLaszipWorkerClient = () =>
  import('./io/ept/worker/eptLaszipWorkerClient');

/** Load the streaming colour helpers. */
export const loadStreamingColors = () => import('./render/streaming/streamingColors');

/** Load the view-dependent streaming scheduler. */
export const loadStreamingScheduler = () =>
  import('./render/streaming/StreamingScheduler');

/** Load the streaming node renderer. */
export const loadStreamingRenderer = () =>
  import('./render/streaming/StreamingRenderer');

/** Load the local-file range source (a dropped COPC file). */
export const loadLocalFileRangeSource = () =>
  import('./io/range/LocalFileRangeSource');

/** Load the HTTP range source (a remote COPC URL). */
export const loadHttpRangeSource = () => import('./io/range/HttpRangeSource');

/**
 * Load the point-cloud exporter (PLY / OBJ / XYZ / CSV). Only the user
 * clicking an export button reaches this, so the encoder ships in a chunk
 * fetched on demand — not in the initial app payload.
 */
export const loadExporters = () => import('./io/exporters');

/**
 * Load the Visual Export Studio (lazy chunk). Four modes ship inside this chunk —
 * orthographic-rgb, height-map, intensity, classification — all behind this
 * lazy boundary so they only download when the user opens the Studio panel
 * or clicks an Export button. Adds `depth` to the same chunk.
 */
export const loadExportStudio = () => import('./export');

/**
 * Load the confidence-aware terrain analysis pipeline (ground
 * classification → DTM → validation → contours). Heavy and only reached
 * when the user runs the Analyse panel, so it rides its own lazy chunk.
 * MUST live here (not inlined in main.ts) so the live source-transform
 * doesn't scramble the import() literal. v0.4.0.
 */
export const loadAnalyseContours = () => import('./terrain/contour/analyseContours');

/**
 * Load the fingerprint-keyed terrain-core cache, which reuses the heavy,
 * interval-independent computation across contour-interval changes and
 * repeated Analyse runs on the same scan. It re-exports {@link
 * computeTerrainCore} / {@link contoursFromCore} through its own import of
 * the analysis module, so it rides the SAME lazy chunk as
 * {@link loadAnalyseContours} (no extra round-trip). Routed through here for
 * the same reason as every dynamic import — the live source-transform must
 * not see the literal.
 */
export const loadTerrainCoreCache = () => import('./terrain/contour/terrainCoreCache');

/**
 * Load the worker-backed terrain-core compute bridge. {@link
 * computeTerrainCoreAsync} runs the heavy core in a dedicated worker (emitted
 * as its own chunk by Vite's worker pass) with a SAFE main-thread fallback, so
 * the first Analyse of a large cloud no longer freezes the UI. Importing this
 * module never constructs a Worker — the worker client is itself
 * dynamic-imported on first successful use — so it stays loadable everywhere.
 * Routed through here for the same reason as every dynamic import.
 */
export const loadComputeTerrainCoreAsync = () =>
  import('./terrain/worker/computeTerrainCoreAsync');

/**
 * Load the profile PDF builder (pulls in pdf-lib). Only reached when the
 * user clicks "Export PDF" on a profile. Routed through here for the same
 * reason as every other dynamic import — the live transform must not see
 * the literal. v0.4.0.
 */
export const loadProfilePdf = () => import('./render/measure/profilePdf');

/**
 * Load the contour map-sheet PDF builder (also pulls in pdf-lib). Only reached
 * when the user clicks "Export map (PDF)" on the Analyse panel — routed here so
 * the live transform never sees the literal and pdf-lib stays in its lazy chunk.
 */
export const loadMapSheetPdf = () => import('./render/measure/mapSheetPdf');

/**
 * Load the DEM package builder (ASCII Grid + GeoTIFF writers + ZIP store).
 * Only reached when the user clicks "Export DEM" on the Analyse panel — routed
 * here so the raster writers ride a lazy chunk and the live transform never
 * sees the import literal.
 */
export const loadDemPackage = () => import('./terrain/export/demPackage');
export const loadContourDeliverableBuild = () => import('./terrain/export/contourDeliverableBuild');

/**
 * Load the Space / Object Report PDF builder (also pulls in pdf-lib). Only
 * reached when the user clicks "Report PDF" on the non-terrain ObjectPanel —
 * routed here so the live transform never sees the literal and pdf-lib stays in
 * its lazy chunk. The floor-plan SVG renderer is pure (no pdf-lib) and is
 * imported directly where needed.
 */
export const loadSpaceReportPdf = () => import('./render/measure/spaceReportPdf');

/**
 * Load the Terrain Intelligence Report PDF builder (also pulls in pdf-lib). Only
 * reached when the user clicks "Intelligence report (PDF)" on the Analyse panel —
 * routed here so the live source-transform never sees the literal and pdf-lib
 * stays in its lazy chunk. The pure content builder
 * ({@link buildTerrainReportContent}) has NO pdf-lib and is imported directly
 * where needed. v0.4.3.
 */
export const loadTerrainReportPdf = () => import('./render/measure/terrainReportPdf');

/**
 * Load the Studio PNG world-file packager (`.pgw` + `.prj` + store-only ZIP).
 * Pure and small, but only reached when a GEOREFERENCED ortho export completes
 * — routed here so the ZIP writer stays out of the shell bundle and the live
 * source-transform never sees the import literal. v0.4.5 (workplan C4).
 */
export const loadPngWorldFile = () => import('./render/export/pngWorldFile');

/**
 * Load the interior floor-plan pipeline + SVG renderer. Both are PURE (no
 * pdf-lib, no DOM), so they could ship in the shell, but they are routed here
 * behind the lazy boundary alongside the report PDF so a non-export session
 * downloads neither — and, critically, so `main.ts` reaches them through a
 * plain static import of this helper (the live source-transform must never see
 * the import literal). v0.4.5: the old density-silhouette sketch is replaced
 * by the real wall-extraction pipeline (`terrain/space/floorplan/`).
 */
export const loadFloorPlan = () =>
  Promise.all([
    import('./terrain/space/floorplan/extractFloorPlan'),
    import('./terrain/space/floorplan/floorPlanSvg'),
  ]).then(([compute, svg]) => ({
    extractFloorPlan: compute.extractFloorPlan,
    floorPlanSvg: svg.floorPlanSvg,
  }));

/**
 * Load the manual classification-edit panel (class picker + lasso-arm +
 * undo/redo). Only mounted once a classification exists, so the controls + their
 * lasso tool ride this lazy chunk and never enter the startup shell. Routed here
 * so the live source-transform never sees the import literal.
 */
export const loadReclassifyUi = () => import('./ui/reclassifyUi');

/** Load the `?debug=1` performance overlay. Diagnostics-only chunk. */
export const loadDebugOverlay = () => import('./ui/DebugOverlay');

/**
 * Load the live colorbar legend overlay. Fetched the first time the active
 * colour mode is a continuous scalar (elevation / intensity / gpsTime /
 * returnNumber) — an RGB-only session never downloads it, and the eager
 * shell carries only the sub-KB refresh trigger (the bundle budget has no
 * headroom for more). Routed through here for the usual reason: the live
 * source-transform must never see the import literal.
 */
export const loadColorbarOverlay = () => import('./ui/ColorbarOverlay');

/**
 * Load the batch format converter (its modal UI plus the conversion engine and
 * proj4). Only reached when the user opens the converter, so proj4 and the LAS
 * writer never enter the initial app payload.
 */
export const loadBatchConverter = () => import('./ui/BatchConverter');

/**
 * Load just the conversion engine (`convertCloud` + proj4). Used by the
 * in-project Export panel, which mounts on every scan load but must not drag
 * proj4 into the initial bundle — so it imports the engine lazily on Export.
 */
export const loadConvertEngine = () => import('./convert/convertCloud');

/**
 * Load the streaming benchmark collector — used by both the overlay's live
 * readout and the `?benchmark=1` post-session report.
 */
export const loadStreamingBenchmark = () =>
  import('./render/streaming/streamingBenchmark');

/** Load the instrumented RangeSource wrapper (network-bytes accounting). */
export const loadInstrumentedRangeSource = () =>
  import('./io/range/InstrumentedRangeSource');

/**
 * Load the EPT (Entwine Point Tile) module: detector + types +
 * `EptStreamingPointCloud` + binary tile decoder + `EptChunkDecoder`. Only
 * loaded when the user opens an `ept.json` URL; never enters the initial
 * bundle. Mirrors `loadStreamingPointCloud` (COPC) — same chunk-emission
 * guard in `vite.config.ts` tracks it.
 */
export const loadEpt = () =>
  Promise.all([
    import('./io/ept/eptDetect'),
    import('./render/streaming/EptStreamingPointCloud'),
    import('./io/ept/EptChunkDecoder'),
    import('./io/ept/eptUrlValidation'),
    import('./io/ept/eptTransport'),
  ]).then(([detect, cloud, decoder, urlValidation, transport]) => ({
    parseEptMetadata: detect.parseEptMetadata,
    detectEptUrl: detect.detectEptUrl,
    EptStreamingPointCloud: cloud.EptStreamingPointCloud,
    EptChunkDecoder: decoder.EptChunkDecoder,
    // remote-UX polish helpers; same chunk as the
    // rest of the EPT runtime so the lazy boundary is preserved.
    validateRemoteEptUrl: urlValidation.validateRemoteEptUrl,
    describeRemoteEptError: urlValidation.describeRemoteEptError,
    // hardened remote transport (retry + per-attempt timeout +
    // typed error messages the describer already classifies).
    createEptTransport: transport.createEptTransport,
  }));

/**
 * Load the PDF Report Engine. The whole `src/report/`
 * module + the pdf-lib dependency (~150 KB) ride this single lazy
 * boundary; non-report sessions never download either. Mirrors the
 * Studio's `loadExportStudio()` shape — `generateReport(inputs)` is the
 * sole public entry, with `composeReportInputs` exported for callers
 * that want to assemble inputs separately (Studio panel → preview
 * before render, e.g.).
 */
export const loadReportEngine = () => import('./report');

/**
 * Load the Microsoft Planetary Computer catalog adapter. Reached from the
 * Catalog panel's "browse" flow (CatalogPanel.ts) and the deep-link open
 * path (main.ts) — both transformed modules, so the import literal must
 * live here, not inline at the call sites.
 */
export const loadPlanetaryComputerCatalog = () =>
  import('./io/catalog/planetaryComputer');

/**
 * Load the RGB auto-balance analyser. Only the Visuals Studio
 * "Auto-balance" action reaches it; the analyser stays out of the
 * startup chunk.
 */
export const loadRgbAutoNormalize = () => import('./render/rgbAutoNormalize');

/**
 * Load the embed-mode postMessage bridge (`?embed=1` sessions only).
 */
export const loadEmbedBridge = () => import('./ui/embedBridge');

/**
 * Pre-warm the static LAS/LAZ loader chunk. The real load path reaches
 * `loadLas` through `parseBuffer.ts` (an excluded module); this helper
 * exists for main.ts's idle-time pre-warm, whose inline `import()` literal
 * the live transform used to scramble into a raw `/assets/io/loadLas`
 * fetch — a 404 console.error on every boot of the deployed site.
 */
export const loadLasLoader = () => import('./io/loadLas');

/**
 * v0.5.1 — runtime dynamic-import seams that previously lived inline in main.ts
 * (a transformed module). The live stringArray pass scrambles a fraction of
 * inline `import()` specifiers each build, so an inline seam works in dev and on
 * most builds, then silently 404s on the one where it gets scrambled (this is
 * how the workflow-config panel crashed on the deployed build). Routing every
 * runtime seam through this excluded module makes them deterministically safe.
 */
export const loadContextMenu = () => import('./ui/contextMenu');
export const loadCommandPalette = () => import('./ui/CommandPalette');
export const loadShortcutSheet = () => import('./ui/ShortcutSheet');
export const loadMeasurementExport = () => import('./export/measurementExport');
export const loadMeasurementReport = () => import('./export/measurementReport');
export const loadKmlExport = () => import('./export/kmlExport');
export const loadConfirmFullExport = () => import('./convert/confirmFullExport');
export const loadFloorPlanConfidence = () =>
  import('./terrain/space/floorplan/floorPlanConfidence');
export const loadFullCloudGradeAction = () =>
  import('./render/streaming/runFullCloudGradeAction');
export const loadSession = () => import('./io/session');
export const loadCompareEpochs = () => import('./terrain/change/compareEpochs');
export const loadAlignEpochs = () => import('./terrain/change/alignEpochs');
export const loadCompareDtms = () => import('./terrain/change/compareDtms');
export const loadChangeRaster = () => import('./terrain/change/changeRaster');
export const loadViewCube = () => import('./ui/viewCube');
export const loadWorkflowConfigPanel = () => import('./ui/WorkflowConfigPanel');
export const loadReportVerifier = () => import('./ui/reportVerifier');

/**
 * v0.5.4 — the contour serialisers (GeoJSON / DXF / SVG writers) and the
 * unified export-provenance builder. Only reached from export/report actions
 * (all already async), so they no longer ride the eager index bundle —
 * freeing the room the derived-complexity wiring needed while keeping the
 * startup shell flat. Routed through here for the usual reason: the live
 * source-transform must never see the import literals.
 */
export const loadContourDownload = () => import('./terrain/contour/contourDownload');
export const loadExportProvenance = () => import('./terrain/export/exportProvenance');
