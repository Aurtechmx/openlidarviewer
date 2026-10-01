import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { COPC_FIXTURE } from './streamingFixtures';
import { showWorkspaceMode, suppressOnboardingTour } from './helpers';

/**
 * swisstopoCatalogueCrs.spec.ts
 *
 * swissSURFACE3D COPC tiles carry no CRS record: the header sets the WKT bit
 * but no WKT VLR or EVLR follows, and the one EVLR is the COPC hierarchy. The
 * curated swisstopo URL is answered here with the in-repo COPC fixture given
 * that structure (moved onto LV95 coordinates, its projection VLR renamed so
 * no CRS record remains). Streamed from that URL, the scan must resolve to
 * EPSG:2056 in metres over LN02, labelled as a catalogue assertion, with the
 * georeferenced exports enabled. Nothing leaves the browser.
 */

const SWISS_URL =
  'https://open-lidar-data.s3.eu-central-1.amazonaws.com/data/CH/Swiss_federal_authorities/swisssurface3d_2022/copc/2485_1109.copc.laz';

/** The fixture with the real tile's header structure and no CRS record. */
function swissLikeFixture(): Buffer {
  const b = Buffer.from(readFileSync(COPC_FIXTURE));
  const dx = 2485000 - 500000;
  const dy = 1109000 - 4100000;
  b.writeUInt16LE(17, 6); // GPS standard time + WKT bit, as in the real tile
  b.writeDoubleLE(b.readDoubleLE(155) + dx, 155);
  b.writeDoubleLE(b.readDoubleLE(163) + dy, 163);
  for (const at of [179, 187]) b.writeDoubleLE(b.readDoubleLE(at) + dx, at);
  for (const at of [195, 203]) b.writeDoubleLE(b.readDoubleLE(at) + dy, at);
  const info = 375 + 54; // COPC info VLR payload: center x, y first
  b.writeDoubleLE(b.readDoubleLE(info) + dx, info);
  b.writeDoubleLE(b.readDoubleLE(info + 8) + dy, info + 8);
  // Walk the VLRs and rename any projection record, so the file carries none.
  const vlrCount = b.readUInt32LE(100);
  let p = b.readUInt16LE(94);
  for (let i = 0; i < vlrCount; i++) {
    if (b.toString('latin1', p + 2, p + 17) === 'LASF_Projection') b.write('OLV_TEST_PAD\0\0\0\0', p + 2, 'latin1');
    p += 54 + b.readUInt16LE(p + 20);
  }
  return b;
}

async function routeSwissTile(page: Page): Promise<void> {
  const body = swissLikeFixture();
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers': 'content-length, content-range, accept-ranges',
    'accept-ranges': 'bytes',
    'content-type': 'application/octet-stream',
  };
  await page.route(SWISS_URL, async (route) => {
    const req = route.request();
    if (req.method() === 'HEAD') {
      await route.fulfill({ status: 200, headers: { ...cors, 'content-length': String(body.length) } });
      return;
    }
    const m = /bytes=(\d+)-(\d*)/.exec((await req.allHeaders()).range ?? '');
    if (!m) {
      await route.fulfill({ status: 200, body, headers: cors });
      return;
    }
    const start = Number(m[1]);
    const end = Math.min(m[2] ? Number(m[2]) : body.length - 1, body.length - 1);
    await route.fulfill({
      status: 206,
      body: body.subarray(start, end + 1),
      headers: { ...cors, 'content-range': `bytes ${start}-${end}/${body.length}` },
    });
  });
}

test('a swisstopo tile with no CRS record streams as EPSG:2056 from the catalogue', async ({ page }) => {
  test.setTimeout(120_000);
  await suppressOnboardingTour(page);
  await routeSwissTile(page);
  await page.goto('/');
  await page.locator('.olv-url-input').fill(SWISS_URL);
  await page.locator('.olv-url-btn').click();
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });

  // State strip: horizontal CRS with its catalogue source, and the vertical datum.
  await expect(page.locator('.olv-ss-crs')).toContainText('CH1903+ / LV95 · metres · catalogue (swisstopo LV95)', { timeout: 20_000 });
  await expect(page.locator('.olv-ss-vertical')).toContainText('LN02');

  // Streaming card: spacing in metres, and the card does not scroll inside the rail.
  const card = page.locator('.olv-right-rail > .olv-streaming-panel');
  await expect(card).toContainText('© swisstopo');
  await expect(card).not.toContainText('(source units)');
  const inner = await card.evaluate((e) => e.scrollHeight - e.clientHeight);
  expect(inner).toBeLessThanOrEqual(1);

  // Inspector: the source row names the assertion.
  await page.locator('summary', { hasText: 'Coordinate system' }).first().click();
  await expect(page.locator('.olv-crs-epsg').first()).toHaveText('EPSG:2056', { timeout: 15_000 });
  await expect(page.locator('.olv-crs-meta').first()).toContainText('catalogue (swisstopo LV95)');

  // Export: the scan area is offered and its reason no longer cites the CRS.
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  await expect(panel.getByTestId('export-scan-footprint')).toBeEnabled({ timeout: 15_000 });
  await expect(panel).not.toContainText('no known coordinate system');
  // Disabled measurement products say why in visible text.
  await expect(panel.locator('.olv-export-product-group[data-product="measurements"]')).toContainText('Unavailable: no measurements yet');
});
