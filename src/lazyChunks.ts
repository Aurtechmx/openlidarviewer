/**
 * lazyChunks.ts
 *
 * The dynamic-import seam for the COPC + streaming subsystem.
 *
 * Every `import()` here is a code-splitting boundary: the COPC parsers, the
 * streaming engine, and the range sources load only when a COPC scan is
 * opened, never as part of the initial app payload.
 *
 * WHY THIS MODULE EXISTS — and why it MUST stay in the obfuscator's exclude
 * list (see `vite.config.ts`):
 *
 * The live build runs `vite-plugin-javascript-obfuscator` in Vite's
 * `transform` hook with `stringArray` enabled. That transform rewrites string
 * literals — including the specifier of a dynamic `import('./literal')` — into
 * string-array lookups. Once the specifier is no longer a literal, Vite/Rolldown
 * can no longer statically analyse the import, the split chunk is never
 * emitted, and the call fails at runtime ("Failed to fetch dynamically
 * imported module").
 *
 * It is the same hazard that keeps `loadFile.ts` and `copcWorkerClient.ts`
 * (each carrying a `new Worker(new URL(...))`) out of the obfuscator. Holding
 * all of the COPC dynamic imports in this one excluded module lets the
 * obfuscated callers (`main.ts`, `Viewer.ts`) reach the chunks through plain
 * static imports of these helpers — which obfuscation does not touch.
 *
 * Do not inline these `import()` calls back into their callers.
 */

/** Load the streaming point-cloud module (COPC octree + IO). */
export const loadStreamingPointCloud = () =>
  import('./render/streaming/StreamingPointCloud');

/** Load the COPC decode worker client. */
export const loadCopcWorkerClient = () =>
  import('./io/copc/worker/copcWorkerClient');

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
 * Load the Visual Export Studio (v0.3.2). Four modes ship inside this chunk —
 * orthographic-rgb, height-map, intensity, classification — all behind this
 * lazy boundary so they only download when the user opens the Studio panel
 * or clicks an Export button. v0.3.3 adds `depth` to the same chunk.
 */
export const loadExportStudio = () => import('./export');

/**
 * @deprecated Alias retained for one release while consumers migrate from the
 * v0.3.2-Phase-4 name `loadImageExports` to {@link loadExportStudio}.
 */
export const loadImageExports = loadExportStudio;

/** Load the `?debug=1` performance overlay. Diagnostics-only chunk. */
export const loadDebugOverlay = () => import('./ui/DebugOverlay');

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
 * v0.3.3 — Load the EPT (Entwine Point Tile) module: detector + types +
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
  ]).then(([detect, cloud, decoder, urlValidation]) => ({
    parseEptMetadata: detect.parseEptMetadata,
    detectEptUrl: detect.detectEptUrl,
    EptStreamingPointCloud: cloud.EptStreamingPointCloud,
    EptChunkDecoder: decoder.EptChunkDecoder,
    // v0.3.3 — remote-UX polish helpers; same chunk as the
    // rest of the EPT runtime so the lazy boundary is preserved.
    validateRemoteEptUrl: urlValidation.validateRemoteEptUrl,
    describeRemoteEptError: urlValidation.describeRemoteEptError,
  }));

/**
 * v0.3.3 — Load the PDF Report Engine. The whole `src/report/`
 * module + the pdf-lib dependency (~150 KB) ride this single lazy
 * boundary; non-report sessions never download either. Mirrors the
 * Studio's `loadExportStudio()` shape — `generateReport(inputs)` is the
 * sole public entry, with `composeReportInputs` exported for callers
 * that want to assemble inputs separately (Studio panel → preview
 * before render, e.g.).
 */
export const loadReportEngine = () => import('./report');
