import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dropTinyLas } from './helpers';
import {
  COPC_FIXTURE,
  EPT_FIXTURE_NODES,
  openEptFixture,
  routeEptFixture,
} from './streamingFixtures';

/**
 * Streaming end-to-end coverage in the blocking `deterministic` project. The
 * chunks-load test drives a tiny in-memory fake-COPC buffer through
 * openStreamingCopc. The rest open the small in-repo COPC and EPT fixtures
 * (see streamingFixtures.ts), so every clone and every CI runner runs them.
 */

test('the COPC streaming chunks load when a COPC file is opened', async ({ page }) => {
  // Regression guard for the v0.3.0 source-transform bug: the COPC subsystem is
  // code-split behind dynamic import()s. If the live-build source-transform mangles
  // those import specifiers, the chunks never emit and openStreamingCopc dies
  // with "Failed to fetch dynamically imported module" — surfaced to the user
  // (with the v0.3.0 error-classifier fix) as a "could not be loaded" toast.
  //
  // A 700-byte file carrying only the bytes detectCopc checks is enough to
  // route into openStreamingCopc and exercise every COPC dynamic import,
  // without needing a full 80 MB scan. `?debug=1` makes the load-error path
  // log to the console so a mangled import is visible there too.
  const moduleErrors: string[] = [];
  const note = (s: string): void => {
    if (/dynamically imported module|importing a module script/i.test(s)) {
      moduleErrors.push(s);
    }
  };
  page.on('console', (msg) => note(msg.text()));
  page.on('pageerror', (err) => note(err.message));

  await page.goto('/?debug=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  const fake = new Uint8Array(700);
  fake.set([0x4c, 0x41, 0x53, 0x46], 0); // "LASF"
  fake.set([0x63, 0x6f, 0x70, 0x63], 377); // "copc" — first VLR user id
  fake[393] = 1; // COPC info-VLR record id (u16 LE)

  await page.locator('.olv-file-input').first().setInputFiles({
    name: 'probe.copc.laz',
    mimeType: 'application/octet-stream',
    buffer: Buffer.from(fake),
  });

  // The streaming panel's `show()` sets `data-opened="1"` as a one-way
  // marker that survives the subsequent hide() — which happens fast on
  // a fake file that fails to parse. This is what the test actually
  // wants to assert: that openStreamingCopc was reached. Checking the
  // marker instead of live visibility eliminates the race where the
  // parser fails between two Playwright polls and the panel is hidden
  // by the time the next poll fires. 30 s envelope covers cold-WebGPU
  // CI runners that take 10–18 s to compile shaders before
  // viewer.ready resolves.
  await expect(page.locator('.olv-streaming-panel')).toHaveAttribute(
    'data-opened',
    '1',
    { timeout: 30_000 },
  );
  // Let the dynamic imports resolve (or fail).
  await page.waitForTimeout(2_500);

  // Decisive: no chunk failed to fetch, and the error toast (the fake file
  // does fail to parse, as expected) is not the resource-load message.
  expect(moduleErrors, moduleErrors.join('\n')).toHaveLength(0);
  const toast = page.locator('.olv-toast');
  if (await toast.isVisible()) {
    await expect(toast).not.toContainText('could not be loaded');
  }
});

test.describe('streaming COPC and EPT fixtures', () => {
  test('opens a COPC file and streams it', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);

    // The streaming panel appears once metadata and hierarchy are read.
    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('Current view ready', { timeout: 30_000 });

    // The empty state is gone and navigation is live.
    await expect(page.locator('.olv-empty')).toBeHidden();
    await expect(page.locator('.olv-mode-active')).toHaveText('Orbit');

    // The scan summary is populated from the COPC metadata.
    await expect(panel).toContainText('COPC LAZ');
    await expect(panel).toContainText('terrain-access-utm');
    await expect(panel).toContainText('900');

    // Saving a camera view adds it to the Inspector's Saved views, which serve
    // static and streaming scans alike.
    const inspector = page.locator('.olv-inspector');
    await inspector.locator('summary', { hasText: 'Saved views' }).click();
    await inspector.locator('.olv-view-save').click();
    await expect(inspector.locator('.olv-view-name').first()).toHaveValue('View 1');
  });

  test('a streamed COPC whose CRS is only in an EVLR shows that CRS', async ({ page }) => {
    // The fixture with its LASF_Projection VLR renamed so the VLRs carry no
    // CRS, and the same WKT appended as an extended VLR after the hierarchy.
    const src = new Uint8Array(readFileSync(COPC_FIXTURE));
    const view = new DataView(src.buffer, src.byteOffset, src.byteLength);
    const headerSize = view.getUint16(94, true);
    const vlrCount = view.getUint32(100, true);
    let cursor = headerSize;
    let wkt: Uint8Array | null = null;
    for (let i = 0; i < vlrCount; i++) {
      const userId = Buffer.from(src.subarray(cursor + 2, cursor + 18)).toString('latin1').replace(/\0+$/, '');
      const length = view.getUint16(cursor + 20, true);
      if (userId === 'LASF_Projection') {
        wkt = src.slice(cursor + 54, cursor + 54 + length);
        src[cursor + 2] = 'X'.charCodeAt(0);
      }
      cursor += 54 + length;
    }
    expect(wkt).not.toBeNull();
    const evlr = new Uint8Array(60 + wkt!.length);
    evlr.set(Buffer.from('LASF_Projection', 'latin1'), 2);
    new DataView(evlr.buffer).setUint16(18, 2112, true);
    new DataView(evlr.buffer).setBigUint64(20, BigInt(wkt!.length), true);
    evlr.set(wkt!, 60);
    const out = new Uint8Array(src.length + evlr.length);
    out.set(src);
    out.set(evlr, src.length);
    const outView = new DataView(out.buffer);
    outView.setUint32(243, outView.getUint32(243, true) + 1, true);

    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles({
      name: 'evlr-crs.copc.laz',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(out),
    });
    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('Current view ready', { timeout: 30_000 });

    await page.locator('summary', { hasText: 'Coordinate system' }).first().click();
    await expect(page.locator('.olv-crs-name').first()).toContainText('UTM zone 13N', { timeout: 15_000 });
    await expect(page.locator('.olv-crs-epsg').first()).toHaveText('EPSG:32613');
  });

  test('opens an EPT dataset from a URL and makes every node resident', async ({ page }) => {
    await routeEptFixture(page);
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await openEptFixture(page);

    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('ept-stream (EPT)');
    await expect(panel).toContainText(
      `${EPT_FIXTURE_NODES} / ${EPT_FIXTURE_NODES} requested nodes resident`,
      { timeout: 30_000 },
    );
    await expect(panel).toContainText('Current view ready');
  });

  test('closes a streaming COPC scan back to the empty state', async ({ page }) => {
    await page.goto('/');
    await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
    await expect(page.locator('.olv-streaming-panel')).toBeVisible({ timeout: 30_000 });

    await page.locator('.olv-tool', { hasText: 'Close' }).click();
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await expect(page.locator('.olv-streaming-panel')).toBeHidden();
  });

  test('switches the active source between static and streaming', async ({ page }) => {
    /** Class of the active static cloud's first point, or -1 with none active. */
    const staticClassAt0 = (p: Page): Promise<number> =>
      p.evaluate(() => {
        const api = (window as unknown as { __OLV_TEST_API__?: { classAt: (i: number) => number } })
          .__OLV_TEST_API__;
        return api ? api.classAt(0) : -2;
      });
    const panel = page.locator('.olv-streaming-panel');

    await page.goto('/?test=1');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    // Static first.
    await dropTinyLas(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await expect.poll(() => staticClassAt0(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
    await expect(panel).toBeHidden();

    // Static to streaming: the stream replaces the static layer.
    await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText('Current view ready', { timeout: 30_000 });
    await expect.poll(() => staticClassAt0(page), { timeout: 20_000 }).toBe(-1);

    // Streaming back to static: the static load tears the stream down.
    await dropTinyLas(page);
    await expect(panel).toBeHidden({ timeout: 30_000 });
    await expect.poll(() => staticClassAt0(page), { timeout: 20_000 }).toBeGreaterThanOrEqual(0);
    await expect(page.locator('.olv-empty')).toBeHidden();
  });
});
