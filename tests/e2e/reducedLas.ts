import { expect, type Page } from '@playwright/test';
import { suppressOnboardingTour } from './helpers';

/**
 * A synthetic LAS large enough that the loader reduces it for display, opened
 * on a device that reports `deviceMemoryGB`, which sets the render budget.
 */

/** A LAS 1.2 point format 0 file: a flat grid of `n` points with a little relief. */
export function syntheticLas(n: number): Uint8Array {
  const HEADER = 227;
  const REC = 20;
  const buf = new ArrayBuffer(HEADER + n * REC);
  const v = new DataView(buf);
  const u8 = new Uint8Array(buf);
  u8.set([0x4c, 0x41, 0x53, 0x46], 0); // LASF
  v.setUint8(24, 1); v.setUint8(25, 2); // version 1.2
  v.setUint16(94, HEADER, true);
  v.setUint32(96, HEADER, true); // offset to point data
  v.setUint32(100, 0, true); // VLR count
  v.setUint8(104, 0); // point format 0
  v.setUint16(105, REC, true);
  v.setUint32(107, n, true);
  v.setUint32(111, n, true); // all first returns
  const scale = 0.01;
  for (const o of [131, 139, 147]) v.setFloat64(o, scale, true);
  const side = Math.ceil(Math.sqrt(n));
  let maxX = 0, maxY = 0, maxZ = 0;
  for (let i = 0; i < n; i++) {
    const x = i % side, y = Math.floor(i / side);
    const z = Math.round(50 * Math.sin(x / 40) * Math.cos(y / 40)) + 100;
    const p = HEADER + i * REC;
    v.setInt32(p, x * 10, true); v.setInt32(p + 4, y * 10, true); v.setInt32(p + 8, z, true);
    v.setUint16(p + 12, 100, true);
    v.setUint8(p + 14, 0x09); // return 1 of 1
    v.setUint8(p + 15, 2); // ground
    maxX = Math.max(maxX, x * 10); maxY = Math.max(maxY, y * 10); maxZ = Math.max(maxZ, z);
  }
  v.setFloat64(179, maxX * scale, true); v.setFloat64(187, 0, true);
  v.setFloat64(195, maxY * scale, true); v.setFloat64(203, 0, true);
  v.setFloat64(211, maxZ * scale, true); v.setFloat64(219, 0, true);
  return u8;
}

export async function openReducedLas(page: Page, n: number, deviceMemoryGB: number, name = 'reduced-grid.las'): Promise<void> {
  await page.addInitScript((gb) => {
    Object.defineProperty(navigator, 'deviceMemory', { get: () => gb, configurable: true });
  }, deviceMemoryGB);
  await suppressOnboardingTour(page);
  await page.goto('/?test=1');
  await page.locator('.olv-file-input').first().setInputFiles({
    name, mimeType: 'application/octet-stream', buffer: Buffer.from(syntheticLas(n)),
  });
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 240_000 });
}

