import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { openAnalysePanel } from './helpers';
import { MAX_GAP_MS, settled, stopWatching, watch } from './mainThreadWatch';

const SIDE = 2010;

/** A plain LAS 1.2 (format 0) ground grid over a gentle surface, with scattered canopy. */
function writeBigLas(path: string): number {
  const veg = Math.floor(SIDE * SIDE * 0.05);
  const n = SIDE * SIDE + veg;
  const rec = 20;
  const off = 227;
  const buf = Buffer.alloc(off + n * rec);
  buf.write('LASF', 0);
  buf[24] = 1;
  buf[25] = 2;
  buf.writeUInt16LE(227, 94);
  buf.writeUInt32LE(off, 96);
  buf[104] = 0;
  buf.writeUInt16LE(rec, 105);
  buf.writeUInt32LE(n, 107);
  buf.writeUInt32LE(n, 111);
  for (const at of [131, 139, 147]) buf.writeDoubleLE(0.01, at);
  let seed = 7;
  const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const ground = (x: number, y: number): number => 200 + 8 * Math.sin(x / 90) * Math.cos(y / 70);
  let o = off;
  const put = (x: number, y: number, z: number): void => {
    buf.writeInt32LE(Math.round(x * 100), o);
    buf.writeInt32LE(Math.round(y * 100), o + 4);
    buf.writeInt32LE(Math.round(z * 100), o + 8);
    buf[o + 14] = 0x09;
    buf[o + 15] = 1;
    o += rec;
  };
  for (let i = 0; i < SIDE; i++) for (let j = 0; j < SIDE; j++) put(i + rnd() * 0.3, j + rnd() * 0.3, ground(i, j));
  for (let k = 0; k < veg; k++) {
    const x = rnd() * SIDE;
    const y = rnd() * SIDE;
    put(x, y, ground(x, y) + 2 + rnd() * 12);
  }
  buf.writeDoubleLE(SIDE, 179);
  buf.writeDoubleLE(0, 187);
  buf.writeDoubleLE(SIDE, 195);
  buf.writeDoubleLE(0, 203);
  buf.writeDoubleLE(230, 211);
  buf.writeDoubleLE(190, 219);
  writeFileSync(path, buf);
  return n;
}

/**
 * A scan over the 4,000,000-point display budget is voxel-reduced for display,
 * which drops its Withheld flags, so the run re-decodes the source file and
 * builds the ground surface from that. That core used to be computed on the
 * main thread. The scan is written here (4.2M points, 85 MB) rather than kept
 * in the repo.
 *
 * Tagged @gpu: drawing four million points on a software renderer (CI has no
 * GPU) holds the main thread for seconds per frame in the canvas readback, so
 * a heartbeat there measures the renderer, not the analysis. The test skips
 * itself on SwiftShader.
 */
test.use({ launchOptions: { args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])] } });

test('@gpu a terrain run on an over-budget scan keeps the page responsive', async ({ page }, info) => {
  test.slow();
  await page.goto('/?test=1');
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : 'none';
  });
  test.skip(/SwiftShader|llvmpipe|none/i.test(renderer), `software renderer: ${renderer}`);

  const file = info.outputPath('over-budget.las');
  writeBigLas(file);
  await page.locator('.olv-file-input').first().setInputFiles(file);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 120_000 });
  await expect(page.locator('.olv-dock .olv-tool', { hasText: /^Analyse$/ })).toBeEnabled({ timeout: 120_000 });
  await openAnalysePanel(page);
  await watch(page);

  await page.locator('.olv-analyse-run').click();
  await expect(settled(page)).toHaveCount(3, { timeout: 240_000 });
  // The surface came from the full-resolution re-decode, the path under test.
  await expect(page.locator('.olv-analyse-status')).toContainText('full-resolution re-decode');

  const { gap } = await stopWatching(page);
  expect(gap, `longest main-thread gap during the run: ${Math.round(gap)} ms`).toBeLessThan(MAX_GAP_MS);
});
