import { defineConfig, type PluginOption } from 'vite';
import { readFileSync } from 'node:fs';
import liveSourceTransform from 'vite-plugin-javascript-obfuscator';
import { visualizer } from 'rollup-plugin-visualizer';

// Single source of truth for the app version — read from package.json at
// build time and exposed to the app as the `__APP_VERSION__` global.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * The live-deployment source-transform plugin.
 *
 * Applied ONLY to the live deployment build — `npm run build:live` (Vite mode
 * `live`). A normal `npm run build`, which is what a GitHub checkout produces,
 * is a plain, readable build with no extra transform; the extra transform is
 * a property of the deployed site, not of the repository.
 *
 * It rewrites the project's own source so the live site ships compact,
 * unstructured JS while the readable source lives on GitHub. Third-party
 * libraries under `node_modules` (three.js, loaders.gl) are excluded by the
 * plugin's defaults — they stay plain-minified.
 *
 * Scope: this runs on the main bundle only. The Web Worker (the file parsers)
 * and `loadFile.ts` are left plain — see the `exclude` note and the `worker`
 * field below. Transforming the worker-loading path breaks worker startup, so
 * it is deliberately not attempted.
 *
 * Conservative settings only: the aggressive transforms — control-flow
 * flattening, dead-code injection, self-defending, and debug-protection — are
 * intentionally OFF. They bloat the bundle, slow the app, risk subtle
 * breakage, and (debug-protection) are anti-DevTools theatre that does not
 * actually protect anything.
 */
function liveSourceTransformPlugin() {
  return liveSourceTransform({
    apply: 'build',
    // Three modules are excluded because each carries an import specifier
    // Vite must read *statically* to split a chunk or bundle a worker:
    //   - `loadFile.ts`        — `new Worker(new URL('./parseWorker.ts', …))`
    //   - `copcWorkerClient.ts`— `new Worker(new URL('./copcWorker.ts', …))`
    //   - `lazyChunks.ts`      — the COPC/streaming `import()` split points
    // The plugin's stringArray transform rewrites those literals, which
    // breaks Vite's static analysis and the chunk/worker never gets emitted.
    // Everything else in the project's own source is transformed.
    exclude: [
      /node_modules/,
      /loadFile\.ts/,
      /copcWorkerClient\.ts/,
      /lazyChunks\.ts/,
    ],
    options: {
      // A fixed RNG seed makes the transform deterministic — every
      // `build:live` produces an identical bundle, rather than varying run to
      // run. This particular value also happens to yield the leaner of the
      // plugin's output sizes.
      seed: 7,
      compact: true,
      controlFlowFlattening: false,
      deadCodeInjection: false,
      debugProtection: false,
      selfDefending: false,
      stringArray: true,
      stringArrayThreshold: 0.75,
      stringArrayEncoding: ['base64'],
      identifierNamesGenerator: 'hexadecimal',
      numbersToExpressions: false,
      simplify: true,
      splitStrings: false,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    },
  });
}

/**
 * Fails the build if any of the required code-split chunks went missing —
 * a structural regression guard for the v0.3.0 lazyChunks bug, where the
 * live transform's stringArray pass scrambled dynamic `import()` literals
 * and Rolldown silently failed to emit the chunks. Runs on every build,
 * not just `build:live`, so a refactor on the plain build can't introduce
 * the same hazard either.
 *
 * The required list is the union of every module that is dynamically
 * imported from a hot path — losing any of them would mean a runtime
 * "Failed to fetch dynamically imported module" the v0.3.1 error classifier
 * surfaces as a "resource-load" toast, but never silently.
 */
function chunkEmissionGuard() {
  const required = [
    // COPC streaming subsystem.
    'StreamingPointCloud',
    'StreamingScheduler',
    'StreamingRenderer',
    'streamingColors',
    'copcWorker',
    'copcWorkerClient',
    'LocalFileRangeSource',
    'HttpRangeSource',
    // v0.3.1 — lazy on-demand chunks.
    'exporters',
    'DebugOverlay',
    'streamingBenchmark',
    'InstrumentedRangeSource',
    // v0.3.2 — Visual Export Studio (orthographic-rgb / height-map /
    // intensity / classification; depth lands in v0.3.3).
    'export',
    // v0.3.3 — EPT (Entwine Point Tile) module: detection + streaming
    // source + binary tile decoder + chunk decoder. All lazy — only
    // loaded when the user opens an ept.json URL. Pinned here so a
    // refactor that accidentally drags EPT into the initial bundle
    // fails the live transformed build loudly.
    'eptDetect',
    'EptStreamingPointCloud',
    'EptChunkDecoder',
    // v0.3.4 — Viewer (three.js + render controllers) deferred so it
    // stays out of the initial shell. The empty-state UI loads without
    // three.js; the first scan-open lazy-imports the Viewer module.
    'Viewer',
    // v0.3.3 Phase 9 — EPT remote-UX polish (URL validator + error
    // classifier). Pinned so a refactor that drags it into the initial
    // bundle fails the live transformed build loudly.
    'eptUrlValidation',
    // v0.3.4 — hardened remote-EPT transport (retry + timeout + abort
    // discipline). Same lazy boundary as the rest of EPT.
    'eptTransport',
    // v0.3.3 Phase 2 — PDF Report Engine + pdf-lib (~150 KB dep).
    // Lazy — only loaded when the user clicks Export → Report PDF.
    'report',
    // v0.3.6 chunk-architecture refactor.
    // `lazDecode` carries laz-perf JS + embedded WASM; lazy-imported
    // by loadLas.ts when a `.laz` file is opened (and by EPT laszip
    // tile decode). Uncompressed `.las` files never download it.
    'lazDecode',
    // Vendor chunks pinned via manualChunks. The presence of these
    // chunks proves the manualChunks rule is still active — losing them
    // would re-inflate the loadLas / report chunks.
    'vendor-pdf',
    'vendor-laz',
    'vendor-three-webgpu',
  ];

  // Application-owned source modules that must NEVER end up in the
  // initial shell chunk (`index-*.js`). The shell is whatever first paints
  // the empty-state UI; the listed modules are heavy or feature-gated and
  // must arrive through a dynamic import().
  const forbiddenInShell = [
    // pdf-lib + standard fonts must only arrive via the report chunk.
    '/pdf-lib/',
    '/@pdf-lib/',
    '/pako/',
    // laz-perf decompressor must only arrive via lazDecode.
    '/laz-perf/',
    'src/io/lazPerfWasm.ts',
    'src/io/lazDecode.ts',
    // Visual Export Studio orchestration must only arrive via export chunk.
    'src/export/index.ts',
    'src/export/ExportRegistry.ts',
    'src/export/BaseExportMode.ts',
    // The Viewer + three.js renderer ride a separate chunk.
    'src/render/Viewer.ts',
    'node_modules/three/build/',
    // EPT subsystem.
    'src/io/ept/EptStreamingPointCloud.ts',
    'src/io/ept/EptChunkDecoder.ts',
    // Debug overlay + streaming benchmark are dev/diagnostic-only chunks.
    'src/diagnostics/DebugOverlay.ts',
    'src/render/streaming/streamingBenchmark.ts',
    // v0.3.7 chunk-isolation hardening — report subsystem (PDF renderer
    // + templates + composer) must arrive through the report chunk.
    'src/report/ReportPdfRenderer.ts',
    'src/report/ReportComposer.ts',
    'src/report/templates/',
  ];

  return {
    name: 'olv-chunk-emission-guard',
    apply: 'build' as const,
    generateBundle(
      this: { error: (m: string) => never },
      _options: unknown,
      bundle: Record<string, unknown>,
    ): void {
      const filenames = Object.keys(bundle);
      const missing = required.filter(
        (req) => !filenames.some((name) => name.includes(req)),
      );
      if (missing.length > 0) {
        const detail = missing.join(', ');
        // `this.error` is provided by Rollup's plugin context — it stops the
        // build with the message.
        this.error(
          `OpenLiDARViewer chunk-emission guard: missing required code-split chunks: ${detail}.\n` +
            `This typically means a dynamic import() literal was scrambled — see lazyChunks.ts.`,
        );
      }

      // Shell-isolation guard. The shell is the chunk that whoever opens
      // index.html downloads first; finding any of `forbiddenInShell`
      // inside it means the lazy boundary leaked.
      const shellName = filenames.find(
        (n) => n.includes('index-') && n.endsWith('.js'),
      );
      if (shellName) {
        const shellChunk = bundle[shellName] as { modules?: Record<string, unknown> };
        const shellModules = Object.keys(shellChunk.modules ?? {});
        const leaked = forbiddenInShell.filter((forbidden) =>
          shellModules.some((m) => m.includes(forbidden)),
        );
        if (leaked.length > 0) {
          this.error(
            `OpenLiDARViewer chunk-emission guard: forbidden modules leaked into the shell chunk (${shellName}): ${leaked.join(', ')}.\n` +
              `Each entry must arrive through a dynamic import() — check the static import graph from src/main.ts.`,
          );
        }
      }
    },
  };
}

/**
 * Optional bundle visualizer, gated on `ANALYZE=1`. Produces a treemap at
 * `bundle-stats.html` so we can see what's pulling which chunk. The file is
 * .gitignored — it is a build diagnostic, not a shipped artifact.
 *
 *   ANALYZE=1 npm run build && open bundle-stats.html
 */
function bundleAnalyzer(): PluginOption {
  if (process.env.ANALYZE !== '1') return null;
  return visualizer({
    filename: 'bundle-stats.html',
    template: 'treemap',
    gzipSize: true,
    brotliSize: false,
    sourcemap: false,
    open: false,
  });
}

export default defineConfig(({ mode }) => ({
  base: './',
  // The worker build is left un-transformed: it is a separate Vite pass, and
  // transforming the worker-loading path breaks worker startup. The worker
  // carries the file-format parsers (open standards — E57/ASTM, LAS/ASPRS).
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    // three.webgpu is intentionally isolated as a vendor chunk.
    // It is large because Three.js WebGPU/TSL runtime is heavy
    // (~1.1 MB pre-min, ~800 KB post-min). The Vite warning that fires
    // is acceptable as long as `vendor-three-webgpu` is the ONLY chunk
    // breaching the 500 KB threshold and no app-owned workflows
    // (report, export, EPT, LAZ, COPC, debug, benchmark) leak into the
    // startup shell.
    //
    // We deliberately do NOT raise `chunkSizeWarningLimit` — the warning
    // is the canary. If a refactor adds the warning back on a different
    // chunk, that chunk is mis-architected, not the threshold.
    rollupOptions: {
      output: {
        // Manual chunk strategy — pin heavy vendor libraries to dedicated
        // chunks so the application-owned chunks that import them stay small.
        //
        //   vendor-pdf       — pdf-lib + @pdf-lib/* + pako. Only reached
        //                       through `report/ReportPdfRenderer.ts`, so it
        //                       only downloads when the user clicks
        //                       Generate PDF. Splitting it off keeps the
        //                       `report-*` chunk small enough to stay under
        //                       the Vite warning threshold.
        //
        //   vendor-laz       — laz-perf JS bindings. Reached through
        //                       `io/lazDecode.ts` (LAZ open + EPT laszip
        //                       tile decode). The 286 KB WASM blob itself
        //                       lives in `lazPerfWasm.ts` and is grouped
        //                       into the same chunk by its module path so
        //                       both pieces ship together.
        //
        //   vendor-three-*   — `three.webgpu.js` is the unavoidable warning
        //                       (~1.1 MB). Pinning it lets the smaller
        //                       `three.core.js` ride along in the same
        //                       chunk it already shares.
        //
        // Modules outside these prefixes fall through to Rollup's default
        // splitting, which respects every dynamic import() boundary the
        // application already declares (Viewer, exporters, EPT, debug, etc.).
        manualChunks(id: string): string | undefined {
          // pdf-lib runtime + vendored fonts/PNG/zlib it pulls in.
          if (id.includes('node_modules/pdf-lib/')) return 'vendor-pdf';
          if (id.includes('node_modules/@pdf-lib/')) return 'vendor-pdf';
          if (id.includes('node_modules/pako/')) return 'vendor-pdf';
          // LAZ decompressor (JS glue) — the WASM blob lives at
          // src/io/lazPerfWasm.ts and is naturally co-resident in the
          // `lazDecode` chunk that imports it.
          if (id.includes('node_modules/laz-perf/')) return 'vendor-laz';
          // Three.js webgpu backend — vendor-only, unavoidable size.
          if (id.includes('node_modules/three/build/three.webgpu')) {
            return 'vendor-three-webgpu';
          }
          // Three core lives alongside webgpu — they're never used separately.
          if (id.includes('node_modules/three/build/three.core')) {
            return 'vendor-three-webgpu';
          }
          return undefined;
        },
      },
    },
  },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The chunk-emission guard runs on every build; the live source transform only on `live`.
  plugins: [
    chunkEmissionGuard() as PluginOption,
    ...(mode === 'live' ? [liveSourceTransformPlugin() as PluginOption] : []),
    bundleAnalyzer(),
  ].filter(Boolean) as PluginOption[],
}));
