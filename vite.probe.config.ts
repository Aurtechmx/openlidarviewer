import { defineConfig } from 'vite';

/**
 * vite.probe.config.ts — builds probe.html on its own, separate from the
 * real application build.
 *
 * `vite.config.ts` is the production build: a single entry (`index.html`),
 * a chunk-emission guard, a shell-isolation guard, the live source
 * transform. None of that is meant to know about a WebDriver test fixture,
 * so the probe gets its own tiny config instead of a second entry threaded
 * into the real one. `npm run build` / `build:live` never run this file —
 * only `npm run build:probe` does, which scripts/ios-touch-check.mjs's
 * workflow step runs explicitly, after the real build. `emptyOutDir: false`
 * so this ADDS probe.html + its one small chunk to the existing `dist/`
 * (which `vite preview` already serves) instead of erasing it.
 *
 * The probe's own module (src/probe/iosTouchProbe.ts) imports only
 * DOM-free, dependency-free recogniser code (touchTracker.ts /
 * touchGesture.ts / touchTapGate.ts), so this config needs none of the
 * `define`s or chunking rules the real build carries for three.js, the
 * workers, or the live obfuscator.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: { input: 'probe.html' },
  },
});
