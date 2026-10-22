import { test, expect, type Page } from '@playwright/test';
import { isBenignPageError } from './pageErrors';
import { openAnalysePanel, waitForLoadIdle } from './helpers';
import { dropBytes } from './geomFixtures';

/**
 * Terrain analysis over two Web Mercator tiles 2 km apart near 60 degrees.
 *
 * Two layers are analysed together only once they prove they share a frame, so
 * the placed case is one visible tile beside a hidden anchor. The second tile is
 * placed in the project and is the active scan. Its latitude
 * is the project's northing plus the gathered coordinate; counting the tile's
 * placement twice moved the latitude by its offset and scaled every slope,
 * area and density at the wrong latitude. The status line must state the
 * latitude of the tiles' true centre.
 */

const yOf = (lat: number) => 6378137 * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
const Y0 = Math.floor(yOf(60));
const X0 = 1_000_000;
const OFFSET = 2000; // placed: the Float32 step there is well under the 1 mm placement limit
const N = 40;

async function tile(y0: number): Promise<Uint8Array> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const x = new Float64Array(N * N), y = new Float64Array(N * N), z = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const u = Math.floor(k / N), v = k % N;
    x[k] = X0 + u;
    y[k] = y0 + v;
    z[k] = 100 + 0.05 * u + 0.02 * v;
  }
  const wkt = wktForEpsg(3857);
  return writeLas14({ count: N * N, x, y, z }, { ...(wkt ? { wkt } : {}), epsg: 3857, linearUnitCode: 9001 });
}

async function expected(): Promise<{ latitude: string; factor: string }> {
  const { webMercatorScaleBound } = await import('../../src/terrain/ground/horizontalScale');
  // Only the visible north tile is gathered.
  const b = webMercatorScaleBound(Y0 + OFFSET, Y0 + OFFSET + (N - 1));
  return { latitude: b.latitudeDeg.toFixed(2), factor: b.groundPerGrid.toFixed(4) };
}

async function drop(page: Page, bytes: Uint8Array, name: string, count: number): Promise<void> {
  await dropBytes(page, bytes, name);
  await expect(page.locator('.olv-layer')).toHaveCount(count, { timeout: 20_000 });
  await waitForLoadIdle(page);
}

test('a placed Web Mercator tile beside a hidden anchor is analysed at its true latitude', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });
  await page.goto('/?test=1');
  await drop(page, await tile(Y0), 'merc-south.las', 1);
  await drop(page, await tile(Y0 + OFFSET), 'merc-north.las', 2);
  // The north tile is placed in the project, OFFSET north of the anchor.
  const offset = await page.locator('.olv-layerhealth-layer', { hasText: 'merc-north' })
    .locator('.olv-layerhealth-row', { hasText: 'Offset to project' })
    .locator('.olv-layerhealth-row-value').textContent({ timeout: 20_000 });
  expect(Number((offset ?? '').match(/-?\d+(?:\.\d+)?/g)?.[1])).toBeCloseTo(OFFSET, 0);
  // Hide the anchor: one visible placed layer remains.
  await page.locator('.olv-layer', { hasText: 'merc-south' }).locator('input[type="checkbox"][title="Show or hide this scan"]').uncheck();
  await openAnalysePanel(page);
  await page.locator('.olv-analyse-run').click();
  const status = page.locator('.olv-analyse-status');
  await expect(status).toContainText('Web Mercator grid', { timeout: 60_000 });
  const e = await expected();
  await expect(status).toContainText(`latitude ${e.latitude}°`);
  await expect(status).toContainText(`(${e.factor} m per grid metre)`);
  await expect(status).toContainText('on horizontal cell areas');
  expect(errors).toEqual([]);
});
