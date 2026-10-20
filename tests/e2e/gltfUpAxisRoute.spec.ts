import { test, expect, type Page } from '@playwright/test';
import { dropBytes } from './geomFixtures';
import { openAnalysePanel } from './helpers';

/**
 * A glTF or GLB with no CRS is Y-up by the glTF specification. The terrain
 * gather used to read its up axis from the point layout, so a 60 m tall wall
 * stored Y-up read as Z-up and was routed as terrain with its 0.1 m thickness
 * as the elevation range. In the app: a GLB wall is not routed as terrain, a
 * GLB floor is, the layer details name the specification as the basis, and a
 * terrain run on the floor states that it was rotated.
 */

/** Deterministic points: a wall (60 m wide in X, 60 m tall in Y) or a floor (60 m by 60 m in X-Z). */
function points(shape: 'wall' | 'floor'): Float32Array {
  let s = 37;
  const r = (): number => (s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const out = new Float32Array(6000 * 3);
  for (let i = 0; i < out.length; i += 3) {
    const a = r() * 60;
    const b = r() * 60;
    const thin = r() * 0.1;
    out.set(shape === 'wall' ? [a, b, thin] : [a, thin, b], i);
  }
  return out;
}

/** A GLB holding `p` as one point primitive, its buffer embedded as a data URI. */
function glb(p: Float32Array): Uint8Array {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i++) {
    min[i % 3] = Math.min(min[i % 3], p[i]);
    max[i % 3] = Math.max(max[i % 3], p[i]);
  }
  const json = new TextEncoder().encode(
    JSON.stringify({
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: p.length / 3, type: 'VEC3', min, max }],
      bufferViews: [{ buffer: 0, byteLength: p.byteLength }],
      buffers: [{ byteLength: p.byteLength, uri: `data:application/octet-stream;base64,${Buffer.from(p.buffer).toString('base64')}` }],
    }),
  );
  const jsonLength = Math.ceil(json.byteLength / 4) * 4;
  const out = new Uint8Array(20 + jsonLength);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, out.byteLength, true);
  v.setUint32(12, jsonLength, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  out.fill(0x20, 20);
  out.set(json, 20);
  return out;
}

async function open(page: Page, shape: 'wall' | 'floor'): Promise<void> {
  await page.goto('/?test=1');
  await dropBytes(page, glb(points(shape)), `${shape}.glb`);
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 30_000 });
  await expect(page.getByRole('progressbar', { name: 'Loading progress' })).toHaveCount(0, { timeout: 30_000 });
}

/** The route the app detected, from the "Treat scan as" control. */
async function detectedRoute(page: Page): Promise<string | null> {
  return page.evaluate(() => (document.querySelector('.olv-scan-type-opt.is-detected') as HTMLElement | null)?.dataset.value ?? null);
}

/** The Up axis row of the first layer's details. */
async function upAxisRow(page: Page): Promise<string> {
  return page.locator('.olv-layerhealth-layer').first().evaluate((el) => {
    const row = [...el.querySelectorAll('.olv-layerhealth-row')].find((r) => r.querySelector('.olv-layerhealth-row-name')?.textContent === 'Up axis');
    return row?.querySelector('.olv-layerhealth-row-value')?.textContent ?? '';
  });
}

test.describe('a GLB with no CRS is Y-up by specification', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a wall is not routed as terrain', async ({ page }) => {
    await open(page, 'wall');
    await expect.poll(() => detectedRoute(page), { timeout: 30_000 }).not.toBeNull();
    expect(await detectedRoute(page)).not.toBe('terrain');
    await expect.poll(() => upAxisRow(page)).toBe('Y up (GLB specification)');
  });

  test('a floor is routed as terrain, and a terrain run states the rotation', async ({ page }) => {
    await open(page, 'floor');
    await expect.poll(() => detectedRoute(page), { timeout: 30_000 }).toBe('terrain');
    await expect.poll(() => upAxisRow(page)).toBe('Y up (GLB specification)');
    await openAnalysePanel(page);
    await page.locator('.olv-analyse-run').click();
    await expect(page.locator('.olv-analyse-status')).toContainText('glTF is Y-up by specification, so this mesh was rotated to Z-up', { timeout: 60_000 });
  });
});
