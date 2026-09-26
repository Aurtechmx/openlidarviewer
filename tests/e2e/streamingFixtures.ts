import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Small in-repo streaming fixtures for the blocking e2e specs. Nothing here
 * touches the network and nothing binds a port.
 *
 * COPC: `tests/fixtures/copc/terrain-access-utm.copc.laz`, 900 project-made
 * points with real LAZ chunks (scripts/make-copc-fixture.mjs). It opens through
 * the file input, the same path a user's local `.copc.laz` takes.
 *
 * EPT: `tests/fixtures/ept-stream/`, 2 500 project-made ground returns over a root
 * and four child tiles (scripts/make-ept-fixture.py --children). The URL form only
 * accepts public https hosts, so the spec opens it at a reserved `.example`
 * host and Playwright answers every request from disk before it leaves the
 * browser.
 */
export const COPC_FIXTURE = fileURLToPath(
  new URL('../fixtures/copc/terrain-access-utm.copc.laz', import.meta.url),
);

const EPT_DIR = fileURLToPath(new URL('../fixtures/ept-stream/', import.meta.url));
const EPT_ORIGIN = 'https://fixtures.olv.example';
export const EPT_FIXTURE_URL = `${EPT_ORIGIN}/ept-stream/ept.json`;

/** Total octree nodes in the EPT fixture: the root plus four children. */
export const EPT_FIXTURE_NODES = 5;

/**
 * Serve the EPT fixture to `page`. With `holdChildren`, the four depth-1 tiles
 * wait until the returned `release()` is called, so the scan stays partly
 * resident for as long as the spec needs.
 */
export async function routeEptFixture(
  page: Page,
  opts: { holdChildren?: boolean } = {},
): Promise<{ release: () => void }> {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  if (!opts.holdChildren) release();

  await page.route(`${EPT_ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const rel = path.startsWith('/ept-stream/') ? path.slice('/ept-stream/'.length) : '';
    if (!/^[A-Za-z0-9._/-]+$/.test(rel) || rel.includes('..')) {
      await route.fulfill({ status: 404 });
      return;
    }
    if (rel.startsWith('ept-data/1-')) await released;
    let body: Buffer;
    try {
      body = readFileSync(EPT_DIR + rel);
    } catch {
      await route.fulfill({ status: 404 });
      return;
    }
    await route.fulfill({
      status: 200,
      body,
      headers: {
        'access-control-allow-origin': '*',
        'content-type': rel.endsWith('.json') ? 'application/json' : 'application/octet-stream',
      },
    });
  });
  return { release };
}

/** Open the EPT fixture through the empty state's URL form. */
export async function openEptFixture(page: Page): Promise<void> {
  await page.locator('.olv-url-input').fill(EPT_FIXTURE_URL);
  await page.locator('.olv-url-btn').click();
}
