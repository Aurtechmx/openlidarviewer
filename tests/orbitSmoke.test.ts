/**
 * orbitSmoke.test.ts
 *
 * Smoke test for orbit-axis navigation that runs against the **built
 * dist bundle**, not the source. The orbit feel comes from a handful of
 * numbers that flow through Viewer.ts → OrbitControls; if a tree-shake,
 * minifier setting, or rolldown chunk-split silently drops or mangles a
 * binding, the visual regression wouldn't surface until a user reports
 * "feels weird on the axis" again. This test catches that pre-ship.
 *
 * What it checks (no DOM, no three.js — Node-only string scan over the
 * Viewer chunk emitted by the build pipeline):
 *
 *   1. The Viewer chunk references `OrbitControls` — the actual
 *      navigation class wasn't tree-shaken out.
 *   2. The chunk emits the v0.3.6 damping factor 0.07 — proves the
 *      value was inlined by the minifier, not silently replaced.
 *   3. The chunk emits the v0.3.6 rotate speed 0.95.
 *   4. The chunk references the OrbitControls 'start' and 'end' event
 *      strings — proves the settle-window listeners are wired.
 *   5. The chunk references the orbit-pivot public APIs `orbitTarget`,
 *      `cloudCenter`, `getOrbit`, and `zoom` — these are the
 *      diagnostic + model-viewer-parity surfaces a downstream consumer
 *      may script against, and accidentally dropping them would break
 *      embed integrations.
 *
 * If `dist/` doesn't exist yet (running tests against a clean checkout),
 * the test self-skips with a single info-level note rather than blocking
 * the suite. CI builds before testing, so this only skips in dev.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const distAssetsDir = join(
  fileURLToPath(new URL('../dist/assets', import.meta.url)),
);
const shouldRun = existsSync(distAssetsDir);

const describeOrSkip = shouldRun ? describe : describe.skip;

function viewerChunk(): string {
  const files = readdirSync(distAssetsDir);
  const viewerFile = files.find((f) => /^Viewer-[A-Za-z0-9_-]+\.js$/.test(f));
  if (!viewerFile) {
    throw new Error(
      `Viewer chunk not found in ${distAssetsDir}. ` +
      `Expected a file matching /^Viewer-[A-Za-z0-9_-]+\\.js$/.`,
    );
  }
  return readFileSync(join(distAssetsDir, viewerFile), 'utf-8');
}

describeOrSkip('orbit navigation — production build smoke', () => {
  it('Viewer chunk references three.js OrbitControls', () => {
    const text = viewerChunk();
    // OrbitControls is the actual navigation class. Either the name
    // survives in some form, or its hallmark method names do.
    const hasOrbitControls =
      text.includes('OrbitControls') ||
      // The class' two most distinctive members — `enableDamping` and
      // `dampingFactor` — survive minification because they're property
      // sets on a non-mangled object.
      (text.includes('enableDamping') && text.includes('dampingFactor'));
    expect(hasOrbitControls).toBe(true);
  });

  it('damping factor 0.07 is inlined in the shipped chunk', () => {
    const text = viewerChunk();
    // Numeric literals minify to either `0.07` or `.07`.
    expect(/(?:[^.\d]|^)0?\.07(?:[^\d]|$)/.test(text)).toBe(true);
  });

  it('rotate speed 0.95 is inlined in the shipped chunk', () => {
    const text = viewerChunk();
    expect(/(?:[^.\d]|^)0?\.95(?:[^\d]|$)/.test(text)).toBe(true);
  });

  it('OrbitControls start + end event listeners are wired (settle window)', () => {
    const text = viewerChunk();
    // Vite/rolldown's minifier rewrites single/double-quoted string
    // literals to backtick template strings to save bytes. Accept any
    // of the three quoting styles.
    const hasStart =
      text.includes('"start"') ||
      text.includes("'start'") ||
      text.includes('`start`');
    const hasEnd =
      text.includes('"end"') ||
      text.includes("'end'") ||
      text.includes('`end`');
    expect(hasStart).toBe(true);
    expect(hasEnd).toBe(true);
    // Also verify the settle-window flag exists — proves the gate is
    // wired all the way through to the maintenance loop.
    expect(text).toContain('_userInteracting');
  });

  it('public orbit-pivot APIs survive tree-shaking', () => {
    const text = viewerChunk();
    // These method names are part of the Viewer's public surface — a
    // downstream embed integration may script against them, so an
    // accidental rename / drop must fail loudly.
    for (const name of ['orbitTarget', 'cloudCenter', 'getOrbit', 'zoom']) {
      expect(text, `expected '${name}' on Viewer surface`).toContain(name);
    }
  });

  it('soft-clamp + streaming-refinement lerp factors ship in the chunk', () => {
    const text = viewerChunk();
    // 0.12 → soft-clamp pull-back per frame
    expect(/(?:[^.\d]|^)0?\.12(?:[^\d]|$)/.test(text)).toBe(true);
    // 0.05 → streaming-refinement lerp per frame
    expect(/(?:[^.\d]|^)0?\.05(?:[^\d]|$)/.test(text)).toBe(true);
  });

  it('settle window 280 ms ships in the chunk', () => {
    const text = viewerChunk();
    expect(text.includes('280')).toBe(true);
  });
});

if (!shouldRun) {
  describe('orbit navigation — production build smoke', () => {
    it.skip('dist/ not present — run `npm run build` first', () => {
      // Marker for the test reporter; intentional skip in dev.
    });
  });
}
