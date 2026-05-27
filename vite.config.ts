import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import obfuscator from 'vite-plugin-javascript-obfuscator';

// Single source of truth for the app version — read from package.json at
// build time and exposed to the app as the `__APP_VERSION__` global.
const pkg = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * The live-deployment code obfuscator.
 *
 * Applied ONLY to the live deployment build — `npm run build:live` (Vite mode
 * `live`). A normal `npm run build`, which is what a GitHub checkout produces,
 * is a plain, readable build with no obfuscation; obfuscation is a property of
 * the deployed site, not of the repository.
 *
 * It obfuscates the project's own source so the live site ships unreadable
 * code while the readable source lives on GitHub. Third-party libraries under
 * `node_modules` (three.js, loaders.gl) are excluded by the plugin's defaults
 * — they stay plain-minified.
 *
 * Scope: this runs on the main bundle only. The Web Worker (the file parsers)
 * and `loadFile.ts` are left plain — see the `exclude` note and the `worker`
 * field below. Obfuscating the worker-loading path breaks worker startup, so
 * it is deliberately not attempted.
 *
 * Conservative settings only: the aggressive transforms — control-flow
 * flattening, dead-code injection, self-defending, and debug-protection — are
 * intentionally OFF. They bloat the bundle, slow the app, risk subtle
 * breakage, and (debug-protection) are anti-DevTools theatre that does not
 * actually protect anything.
 */
function obfuscatorPlugin() {
  return obfuscator({
    apply: 'build',
    // Three modules are left un-obfuscated because each carries an import
    // specifier Vite must read *statically* to split a chunk or bundle a
    // worker:
    //   - `loadFile.ts`        — `new Worker(new URL('./parseWorker.ts', …))`
    //   - `copcWorkerClient.ts`— `new Worker(new URL('./copcWorker.ts', …))`
    //   - `lazyChunks.ts`      — the COPC/streaming `import()` split points
    // The obfuscator's stringArray transform rewrites those literals, which
    // breaks Vite's static analysis and the chunk/worker never gets emitted.
    // Everything else in the project's own source is obfuscated.
    exclude: [
      /node_modules/,
      /loadFile\.ts/,
      /copcWorkerClient\.ts/,
      /lazyChunks\.ts/,
    ],
    options: {
      // A fixed RNG seed makes obfuscation deterministic — every `build:live`
      // produces an identical bundle, rather than varying run to run. This
      // particular value also happens to yield the leaner of the obfuscator's
      // output sizes.
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
 * obfuscator's stringArray transform scrambled dynamic `import()` literals
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
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  // The worker build is left un-obfuscated: it is a separate Vite pass, and
  // obfuscating the worker-loading path breaks worker startup. The worker
  // carries the file-format parsers (open standards — E57/ASTM, LAS/ASPRS).
  worker: { format: 'es' },
  build: { target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // The chunk-emission guard runs on every build; obfuscation only on `live`.
  plugins:
    mode === 'live'
      ? [obfuscatorPlugin(), chunkEmissionGuard()]
      : [chunkEmissionGuard()],
}));
