/**
 * tests/e2e/helpers.ts
 *
 * Shared helpers for the Playwright e2e suite. Centralised here so a change
 * to the empty-state DOM doesn't ripple through twelve spec files.
 *
 * Background:
 *   The empty state historically shipped two bundled samples named
 *   "Drone survey" and "Phone scan". They were removed in favour of a
 *   single streaming demo card; the spec files written against those
 *   names broke silently in CI because Playwright's `getByText` times
 *   out without surfacing a useful message. Using a stable fixture drop
 *   instead of fragile text matching makes the suite resilient to
 *   empty-state copy changes.
 */

import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The onboarding tour (v0.3.9) auto-launches on the first session per
 * browser and renders a full-canvas SVG overlay that intercepts pointer
 * events. Every Playwright run is a "first session" because the context
 * starts with an empty localStorage, so the overlay reliably blocks the
 * test's first click. Seeding the storage key BEFORE the page loads is
 * the cleanest fix — no spec changes, no flaky "wait for skip button"
 * dance. The key string mirrors `STORAGE_KEY` in src/ui/onboarding/
 * tourSteps.ts; if that changes, this string follows.
 */
export async function suppressOnboardingTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('olv:tour:v1:completed', '1');
    } catch {
      // Storage may be blocked (private mode, content settings); the
      // tour just runs as it would for a user. Tests in that mode will
      // see the overlay and need to dismiss it explicitly.
    }
  });
}

/**
 * Drop the bundled `tiny.ply` fixture onto the page body via a synthesised
 * DataTransfer. Exercises the same load → render → validate path a real
 * dragged file takes, and works whether or not the empty-state sample
 * card exists. Use this anywhere a test previously clicked a sample.
 */
export async function dropTinyPly(page: Page): Promise<void> {
  const bytes = readFileSync(
    fileURLToPath(new URL('../fixtures/tiny.ply', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'tiny.ply'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Drop the bundled `tiny.las` fixture — same as `dropTinyPly` but
 * exercises the LAS decoder path instead of PLY.
 */
export async function dropTinyLas(page: Page): Promise<void> {
  const bytes = readFileSync(
    fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'tiny.las'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Drop a denser synthesised PLY — a 60×60 grid of 3 600 points across a small
 * 3D surface (sinusoidal Z) so the framing puts the cloud in an orbit-friendly
 * pose and the picker has a dense canopy to hit. Built inline so the bundled
 * fixtures stay small; the 10-point `tiny.ply` is too sparse for a centre-of-
 * canvas click to land on a point.
 */
export async function dropDenseGridPly(page: Page): Promise<void> {
  const N = 60;
  const points: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = i / (N - 1);
      const v = j / (N - 1);
      const x = u * 10 - 5;
      const y = v * 10 - 5;
      // Gentle 3D surface — gives the cloud volume so framing produces a
      // reasonable orbit pose instead of a degenerate flat plane.
      const z = Math.sin(u * 3.14159) * Math.cos(v * 3.14159) * 1.5;
      points.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 200 200 200 255`);
    }
  }
  const header =
    `ply\n` +
    `format ascii 1.0\n` +
    `element vertex ${N * N}\n` +
    `property float x\n` +
    `property float y\n` +
    `property float z\n` +
    `property uchar red\n` +
    `property uchar green\n` +
    `property uchar blue\n` +
    `property uchar alpha\n` +
    `end_header\n`;
  const text = header + points.join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'dense-grid.ply'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}
