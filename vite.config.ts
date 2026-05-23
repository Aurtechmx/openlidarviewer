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
    // `loadFile.ts` is left un-obfuscated: it carries the
    // `new Worker(new URL('./parseWorker.ts', import.meta.url))` construct,
    // which Vite must read statically to bundle the parse worker. Obfuscating
    // it scrambles that pattern and the worker fails to load. Everything else
    // in the project's own source is obfuscated.
    exclude: [/node_modules/, /loadFile\.ts/],
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

export default defineConfig(({ mode }) => ({
  base: './',
  // The worker build is left un-obfuscated: it is a separate Vite pass, and
  // obfuscating the worker-loading path breaks worker startup. The worker
  // carries the file-format parsers (open standards — E57/ASTM, LAS/ASPRS).
  worker: { format: 'es' },
  build: { target: 'es2022' },
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // Obfuscation is applied only to the live deployment build — Vite mode
  // `live`, run via `npm run build:live`. The default `npm run build`, used
  // for development and by anyone building the GitHub source, is a normal,
  // readable build.
  plugins: mode === 'live' ? [obfuscatorPlugin()] : [],
}));
