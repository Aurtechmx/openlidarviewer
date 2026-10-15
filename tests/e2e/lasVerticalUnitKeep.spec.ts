import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { geomFixtures, dropBytes } from './geomFixtures';
import { showWorkspaceMode } from './helpers';

/**
 * lasVerticalUnitKeep.spec.ts
 *
 * A LAS with metre eastings/northings and NAVD88 heights in US survey feet
 * (EPSG:6360), exported through the primary Export button with Keep CRS. The
 * downloaded LAS must keep Z unchanged AND keep the vertical CRS and its US
 * survey foot unit, so a 10 ftUS rise still reads as 3.048006 m.
 */

async function exportPanel(page: Page) {
  await showWorkspaceMode(page, 'output');
  const p = page.locator('.olv-export-panel');
  if (await p.evaluate((e) => e.classList.contains('olv-collapsed'))) await p.locator('.olv-panel-head').click();
  return p;
}

for (const pill of ['LAS 1.2', 'LAS 1.4'] as const) {
  test(`${pill} Keep CRS keeps the US survey foot vertical unit of unchanged Z`, async ({ page }) => {
    await geomFixtures();
    const { writeLas } = await import('../../src/convert/writeLas');
    const { parseLasHeader } = await import('../../src/io/lasHeader');
    const { spatialContextFrom, verticalMetresPerUnit } = await import('../../src/geo/SpatialContext');
    const source = writeLas(
      {
        count: 4,
        x: Float64Array.from([500000, 500001, 500000, 500001]),
        y: Float64Array.from([4000000, 4000000, 4000001, 4000001]),
        z: Float64Array.from([100, 100, 110, 110]),
      },
      { epsg: 32613, linearUnitCode: 9001, verticalEpsg: 6360, verticalUnitCode: 9003 },
    );
    const parse = (b: Uint8Array) => parseLasHeader(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer);
    expect(parse(source).crs?.verticalUnitToMetres).toBeCloseTo(1200 / 3937, 12);

    await page.goto('/?test=1');
    await dropBytes(page, source, 'metre-xy-ftus-z.las');
    await expect(page.locator('.olv-layer')).toHaveCount(1);
    const exp = await exportPanel(page);
    await exp.locator('.olv-bc-pill', { hasText: pill }).click();
    await expect(exp.locator('.olv-bc-pill', { hasText: pill })).toHaveAttribute('aria-pressed', 'true');
    const download = page.waitForEvent('download');
    await exp.locator('.olv-bc-convert').click();
    const d = await download;
    const bytes = new Uint8Array(readFileSync((await d.path())!));

    const h = parse(bytes);
    expect(h.versionMinor).toBe(pill === 'LAS 1.4' ? 4 : 2);
    expect(h.min[2]).toBe(100);
    expect(h.max[2]).toBe(110);
    expect(h.crs?.epsg).toBe(32613);
    expect(h.crs?.verticalEpsg).toBe(6360);
    expect(h.crs?.verticalLinearUnit).toBe('us-survey-foot');
    expect(h.crs?.verticalUnitToMetres).toBeCloseTo(1200 / 3937, 12);
    const zToMetres = verticalMetresPerUnit(spatialContextFrom(h.crs), 'horizontal-when-known');
    expect((h.max[2] - h.min[2]) * (zToMetres as number)).toBeCloseTo(3.048006, 6);
  });
}
