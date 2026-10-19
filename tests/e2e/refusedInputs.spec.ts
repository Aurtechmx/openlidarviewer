import { test, expect } from '@playwright/test';
import { dropBytes } from './geomFixtures';

/**
 * A file the viewer refuses is refused with the reason on screen, not with a
 * generic failure. These cases drop a file and read the toast.
 */

/** A GLB whose JSON chunk is `doc` and whose binary chunk is empty. */
function glb(doc: object): Uint8Array {
  const pad = (n: number): number => (4 - (n % 4)) % 4;
  const json = new TextEncoder().encode(JSON.stringify(doc));
  const jsonBytes = new Uint8Array(json.length + pad(json.length)).fill(0x20);
  jsonBytes.set(json);
  const total = 12 + 8 + jsonBytes.length;
  const out = new Uint8Array(total);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jsonBytes.length, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.set(jsonBytes, 20);
  return out;
}

test('a GLB that lists Draco mesh compression is refused with the reason', async ({ page }) => {
  await page.goto('/?test=1');
  const draco = 'KHR_draco_mesh_compression';
  await dropBytes(page, glb({ asset: { version: '2.0' }, extensionsUsed: [draco], extensionsRequired: [draco] }), 'draco.glb');
  const toast = page.locator('.olv-toast');
  await expect(toast).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
  await expect(toast).toContainText('uses Draco mesh compression (KHR_draco_mesh_compression)');
  await expect(toast).toContainText('The Draco decoder is not bundled with this viewer and no decoder is downloaded');
  await expect(toast).toContainText('Re-export the model without Draco compression, or as a PLY or OBJ file.');
  // Nothing opened: the empty state stays.
  await expect(page.locator('.olv-layer')).toHaveCount(0);
});

test('a GLB that only lists Draco as used is refused too', async ({ page }) => {
  await page.goto('/?test=1');
  await dropBytes(page, glb({ asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] }), 'draco-used.glb');
  await expect(page.locator('.olv-toast')).toHaveClass(/olv-toast-error/, { timeout: 20_000 });
  await expect(page.locator('.olv-toast')).toContainText('Draco mesh compression');
});
