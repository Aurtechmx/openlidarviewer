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
    // These modules are excluded because each carries an import specifier
    // Vite must read *statically* to split a chunk or bundle a worker:
    //   - `loadFile.ts`        — `new Worker(new URL('./parseWorker.ts', …))`
    //   - `copcWorkerClient.ts`— `new Worker(new URL('./copcWorker.ts', …))`
    //   - `eptLaszipWorkerClient.ts`
    //                          — `new Worker(new URL('./eptLaszipWorker.ts', …))`
    //   - `terrainCoreWorkerClient.ts`
    //                          — `new Worker(new URL('./terrainCoreWorker.ts', …))`
    //   - `computeTerrainCoreAsync.ts`
    //                          — `import('./terrainCoreWorkerClient')`, the
    //     lazy split point that pulls in the worker client (mirrors how
    //     `lazyChunks.ts` holds the COPC `import()` literal). Without this the
    //     stringArray pass scrambles the specifier and neither the client nor
    //     the `terrainCoreWorker` chunk it constructs ever gets emitted.
    //   - `lazyChunks.ts`      — the COPC/streaming `import()` split points
    //   - `parseBuffer.ts` / `loaderRegistry.ts` / `loadLas.ts` — the loader
    //     chain now reached from the main thread (the format converter's
    //     full-resolution decode), so their `import('./loadLas' | './loadXyz'
    //     | './lazDecode')` split points must stay literal here too, not just
    //     in the un-transformed worker pass.
    // The plugin's stringArray transform rewrites those literals, which
    // breaks Vite's static analysis and the chunk/worker never gets emitted.
    // Everything else in the project's own source is transformed.
    exclude: [
      /node_modules/,
      /loadFile\.ts/,
      /copcWorkerClient\.ts/,
      /eptLaszipWorkerClient\.ts/,
      /terrainCoreWorkerClient\.ts/,
      /computeTerrainCoreAsync\.ts/,
      /lazyChunks\.ts/,
      /parseBuffer\.ts/,
      /loaderRegistry\.ts/,
      /loadLas\.ts/,
      // ── Performance exclusions (v0.5.3) ────────────────────────────────
      // The stringArray pass rewrites property access (`obj.prop` →
      // `obj[decode(n)]`) and built-in calls (`Math.hypot` →
      // `Math[decode(n)]`) into decode-wrapper calls. Inside per-POINT loops
      // that is one wrapper call per point per access — on a multi-million-
      // point cloud the deployed site burned whole seconds a plain build
      // does not (profiled on a 2.5 M-pt PLY: load-path long task 6.6 s →
      // 10.2 s, single pick 56 ms → 178 ms). Each module below carries an
      // O(N)-per-point hot loop and is excluded from the transform; the
      // remaining app surface stays transformed.
      //   - healthCheck.ts   — duplicate/outlier/finite whole-cloud scans
      //     at scan attach (~2 s of pure decoder overhead when transformed).
      //   - PointCloud.ts    — bounds() min/max walk; the loop condition
      //     alone made two wrapper calls per iteration (~0.5 s per load).
      //   - colorEncode.ts   — per-point colour buffer building on attach
      //     and on every colour-mode switch (60 ms → 519 ms when transformed).
      //   - navMath.ts       — nearestPointAlongRay, the O(N) pick walked on
      //     every measure/probe hover frame and dblclick-focus; the
      //     transformed build wrapped `Math.hypot` per point (3.2× per pick).
      //   - Viewer.ts        — scan-attach buffer plumbing + the per-frame
      //     render loop; its chunk's decoder burned ~1 s per load transformed.
      //   - measure/snap.ts  — the snap grid built over every point at scan
      //     attach (min/max walk + per-point cell insert; ~1.1 s of decoder
      //     overhead per load when transformed).
      //   - panMath.ts       — the hand-tool drag geometry (v0.5.5 P1):
      //     ray-plane math run on every captured pointermove of a grab
      //     (120+ Hz pointers); sibling of navMath.ts, excluded for the
      //     same per-event Math-wrapper reason.
      /analysis\/modules\/healthCheck\.ts/,
      /model\/PointCloud\.ts/,
      /render\/colorEncode\.ts/,
      /render\/navMath\.ts/,
      /render\/panMath\.ts/,
      /render\/Viewer\.ts/,
      /render\/measure\/snap\.ts/,
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
/**
 * Auto-derive the chunk names lazyChunks.ts is contracted to emit.
 *
 * Every dynamic-import seam lives in `src/lazyChunks.ts` (that is the whole
 * point of the module — see its header). The guard used to pin a hand-copied
 * subset of those chunk names, which drifted as loaders were added: by v0.5.3
 * the module carried ~20 loaders (kmlExport, compareEpochs, alignEpochs,
 * session, viewCube, WorkflowConfigPanel, reportVerifier, …) the guard never
 * checked. Parsing the import() specifiers at config time makes the pinned
 * list structurally impossible to under-cover — a new loader is guarded the
 * moment it is written, and a scrambled specifier still fails the build.
 *
 * Rollup names each split chunk after the imported module's basename, so the
 * basename is the guard key (same `.includes` match as the static pins).
 */
function lazyChunkNames(): string[] {
  const src = readFileSync(new URL('./src/lazyChunks.ts', import.meta.url), 'utf8');
  // Strip comments so documentation examples (e.g. `import('./literal')`)
  // never leak into the contract.
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const specifiers = [...code.matchAll(/import\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
  const names = [...new Set(specifiers.map((s) => s.split('/').pop() as string))];
  if (names.length < 20) {
    // Refactor tripwire — lazyChunks.ts holds far more seams than this; a
    // tiny parse result means the regex or the module moved out from under us.
    throw new Error(
      `chunkEmissionGuard: parsed only ${names.length} dynamic-import seams from src/lazyChunks.ts — expected 20+. ` +
        'The lazyChunks parse in vite.config.ts no longer matches the module; fix the parser, do not ship unguarded.',
    );
  }
  return names;
}

function chunkEmissionGuard() {
  const required = [
    // Every lazyChunks.ts seam, derived from the module itself at config
    // time — see lazyChunkNames(). The static pins below cover only what
    // lazyChunks.ts cannot know about: worker files reached through
    // `new Worker(new URL(...))`, dynamic imports living in other excluded
    // modules, and the manualChunks vendor splits.
    ...lazyChunkNames(),
    // Worker files reached through `new Worker(new URL(...))` — their URL
    // literals live in the excluded worker-client modules, not lazyChunks.ts,
    // so they must stay pinned by hand. Losing one means the worker 404s at
    // runtime (COPC/EPT tile decodes reject; terrain-core offload silently
    // falls back to main-thread compute) — a regression that drops them must
    // fail the build loudly.
    'copcWorker',
    'eptLaszipWorker',
    'terrainCoreWorker',
    // Dynamic imports living inside OTHER excluded modules (not lazyChunks.ts):
    // `computeTerrainCoreAsync.ts` lazy-imports the terrain worker client;
    // `loadLas.ts` lazy-imports `lazDecode` (laz-perf JS + embedded WASM) so
    // uncompressed `.las` files never download the decompressor.
    'terrainCoreWorkerClient',
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
    'src/ui/DebugOverlay.ts',
    'src/render/streaming/streamingBenchmark.ts',
    // v0.3.7 chunk-isolation hardening — heavy report subsystem
    // (PDF renderer + asset composer + engine + per-section
    // composers) must arrive through the report chunk. Paths reflect
    // the current src/report layout — legacy `ReportComposer.ts`
    // and the `src/report/templates/` directory are gone (rolled
    // into `ReportAssetComposer.ts` and the flat `ReportTemplates.ts`
    // respectively). `ReportTemplates.ts` itself is intentionally
    // shell-eligible because the Inspector reads the lightweight
    // template-id metadata for the dropdown.
    'src/report/ReportPdfRenderer.ts',
    'src/report/ReportAssetComposer.ts',
    'src/report/ReportEngine.ts',
    'src/report/ReportMetadataSection.ts',
    'src/report/ReportMeasurementSection.ts',
    'src/report/ReportAnnotationSection.ts',
    'src/report/ReportBranding.ts',
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
