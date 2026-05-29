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
