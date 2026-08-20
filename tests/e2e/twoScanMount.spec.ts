import { test, expect, type Page } from '@playwright/test';
import { isBenignPageError } from './pageErrors';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GlobalPoints } from '../../src/convert/globalPoints';

/**
 * `src/convert/writeLas` transitively imports `buildIdentity`, which reads the
 * Vite-`define` global `__BUILD_IDENTITY__` at module load. The Playwright TS
 * transform does not define it, so the writer is dynamic-imported inside the
 * test AFTER the global is stubbed (below), rather than statically here.
 */
type WriteLas14 = typeof import('../../src/convert/writeLas').writeLas14;
type WktForEpsg = typeof import('../../src/io/epsgWkt').wktForEpsg;

async function loadLasWriter(): Promise<{ writeLas14: WriteLas14; wktForEpsg: WktForEpsg }> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test',
    commit: 'unknown',
    dirty: false,
    builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  return { writeLas14, wktForEpsg };
}

/**
 * P1 #1 — two-scan project-frame mount, browser evidence.
 *
 * Two tiles that declare the SAME projected CRS (EPSG:32633, WGS 84 / UTM 33N,
 * metres) but sit at different file origins must mount into one shared project
 * frame at their real separation, non-destructively. The fixtures are built
 * here by the real LAS 1.4 writer so their `LASF_Projection`/2112 WKT VLR is
 * exactly what `src/io/crs.ts` reads back — the two tiles therefore align and
 * mount, unlike the CRS-less `gate2-origin` pair.
 *
 * The separation is 2 km, not hundreds of km: the mount-precision gate refuses
 * a placement whose Float32 residual exceeds 1 mm, and ~100 km already costs
 * ~3.9 mm (see rebasePrecisionBaseline). 2 km costs well under the budget, so
 * the tiles mount while the offset is still unmistakably a real separation.
 *
 * Observability is the Layer Health card, with no test-only hooks: its
 * "Offset to project" row is the placement's `sourceToProject`, and its
 * "Source origin" row is the file origin the placement never rewrites.
 */

const EPSG_UTM33N = 32633;
const SEP_M = 2000; // 2 km east and north — inside the 1 mm precision budget

/** A 4×4 grid of points climbing 195→204 m, at the given global origin. */
function tileAt(ox: number, oy: number): GlobalPoints {
  const n = 16;
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  const z = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = ox + (i % 4);
    y[i] = oy + Math.floor(i / 4);
    z[i] = 195 + (i % 10);
  }
  return { count: n, x, y, z };
}

function georefLas(
  w: { writeLas14: WriteLas14; wktForEpsg: WktForEpsg },
  ox: number,
  oy: number,
): number[] {
  const wkt = w.wktForEpsg(EPSG_UTM33N);
  if (!wkt) throw new Error('no WKT for EPSG:32633');
  const bytes = w.writeLas14(tileAt(ox, oy), {
    wkt,
    epsg: EPSG_UTM33N,
    linearUnitCode: 9001, // horizontal metre; no vertical datum/unit — the
    // common real case, mounting horizontal-only (X/Y, Z kept per source).
  });
  return [...bytes];
}

async function dropBytes(page: Page, bytes: number[], name: string): Promise<void> {
  const dt = await page.evaluateHandle(
    ({ b, n }) => {
      const d = new DataTransfer();
      d.items.add(new File([new Uint8Array(b)], n));
      return d;
    },
    { b: bytes, n: name },
  );
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

interface LayerHealth {
  name: string;
  sourceOrigin: string;
  offsetToProject: string;
}

async function readLayerHealth(page: Page): Promise<LayerHealth[]> {
  return page.locator('.olv-layerhealth-layer').evaluateAll((els) =>
    els.map((el) => {
      const rows = [...el.querySelectorAll('.olv-layerhealth-row')].map((r) => ({
        k: r.querySelector('.olv-layerhealth-row-name')?.textContent ?? '',
        v: r.querySelector('.olv-layerhealth-row-value')?.textContent ?? '',
      }));
      const get = (label: string) => rows.find((r) => r.k === label)?.v ?? '(no row)';
      return {
        name: el.querySelector('.olv-layerhealth-layer-name')?.textContent ?? '?',
        sourceOrigin: get('Source origin'),
        offsetToProject: get('Offset to project'),
      };
    }),
  );
}

/** "500000, 4100000, 195" → [500000, 4100000, 195]; null for the "none" text. */
function parseCoords(text: string): [number, number, number] | null {
  const nums = text.match(/-?\d+(?:\.\d+)?/g);
  if (!nums || nums.length < 3) return null;
  return [Number(nums[0]), Number(nums[1]), Number(nums[2])];
}

// Multi-layer mount is disabled pending the per-layer frame fixes (v0.6.4).
// This spec is browser evidence that the mount produces a shared frame, so it
// only applies while the mount is on. The flag is read from source rather than
// imported from LayerService (which pulls lazyChunks + Vite-define globals the
// Playwright transform does not provide); the gate re-arms itself when the flag
// returns to true.
const MULTI_LAYER_MOUNT_ENABLED = /MULTI_LAYER_MOUNT_ENABLED\s*=\s*true\b/.test(
  readFileSync(resolve(process.cwd(), 'src/app/LayerService.ts'), 'utf8'),
);
test.beforeEach(() => {
  test.skip(
    !MULTI_LAYER_MOUNT_ENABLED,
    'multi-layer mount disabled pending per-layer frame fixes (v0.6.4)',
  );
});

test('two georeferenced tiles mount into one frame at their real separation', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

  const w = await loadLasWriter();
  const bytesA = georefLas(w, 500000, 4100000);
  const bytesB = georefLas(w, 500000 + SEP_M, 4100000 + SEP_M);

  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  await dropBytes(page, bytesA, 'utm33-a.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });

  await dropBytes(page, bytesB, 'utm33-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(500); // frame reconcile + health render

  const layers = await readLayerHealth(page);

  // Acceptance: loading two scans is clean end to end.
  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  expect(layers, 'Layer Health enumerates both tiles').toHaveLength(2);

  // Acceptance #1 — both mount (offset row is a coordinate, not "none").
  const offsets = layers.map((l) => parseCoords(l.offsetToProject));
  expect(offsets[0], `tile A offset was "${layers[0].offsetToProject}"`).not.toBeNull();
  expect(offsets[1], `tile B offset was "${layers[1].offsetToProject}"`).not.toBeNull();

  // Acceptance #1 — the two offsets differ by the real 2 km separation in X and
  // Y, regardless of which tile anchored the frame origin.
  const [ax, ay] = offsets[0]!;
  const [bx, by] = offsets[1]!;
  expect(Math.abs(bx - ax), 'X separation is the real 2 km').toBeCloseTo(SEP_M, 1);
  expect(Math.abs(by - ay), 'Y separation is the real 2 km').toBeCloseTo(SEP_M, 1);

  // Acceptance #3 (proxy) — the placement did not rewrite either file origin.
  expect(parseCoords(layers[0].sourceOrigin)?.[0]).toBe(500000);
  expect(parseCoords(layers[1].sourceOrigin)?.[0]).toBe(500000 + SEP_M);
});

/** A layer's offset is effectively zero — a coordinate at the origin, or "none"
 * (its own frame). Either means the layer sits where its file put it. */
function isZeroDisplacement(offsetText: string): boolean {
  const c = parseCoords(offsetText);
  if (c === null) return offsetText.includes('none');
  return Math.abs(c[0]) < 1e-6 && Math.abs(c[1]) < 1e-6 && Math.abs(c[2]) < 1e-6;
}

test('the surviving layer does not move when a sibling is added or removed (#2)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

  const w = await loadLasWriter();
  // A's origin is the lower easting, so A anchors the frame at offset zero.
  const bytesA = georefLas(w, 500000, 4100000);
  const bytesB = georefLas(w, 500000 + SEP_M, 4100000 + SEP_M);

  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  await dropBytes(page, bytesA, 'utm33-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await dropBytes(page, bytesB, 'utm33-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(500);

  const withBoth = await readLayerHealth(page);
  const aWithBoth = withBoth.find((l) => l.name.includes('utm33-a'));
  expect(aWithBoth, 'A is enumerated with both loaded').toBeTruthy();
  // Adding B did not displace A: it anchors the shared frame at zero.
  expect(
    isZeroDisplacement(aWithBoth!.offsetToProject),
    `A offset after B added was "${aWithBoth!.offsetToProject}"`,
  ).toBe(true);

  // Remove B from the scene.
  await page.getByRole('button', { name: 'Remove utm33-b.las' }).click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await page.waitForTimeout(300);

  const afterRemove = await readLayerHealth(page);
  const aAfter = afterRemove.find((l) => l.name.includes('utm33-a'));
  expect(aAfter, 'A survives B removal').toBeTruthy();
  // Removing B did not displace A, and never rewrote its file origin.
  expect(
    isZeroDisplacement(aAfter!.offsetToProject),
    `A offset after B removed was "${aAfter!.offsetToProject}"`,
  ).toBe(true);
  expect(parseCoords(aAfter!.sourceOrigin)?.[0]).toBe(500000);

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
});

/**
 * P1 #3 — a coordinate read back from the NON-ANCHOR layer.
 *
 * The two tests above prove the placement VALUES are right: Layer Health shows
 * each tile's offset and the pair differ by the real 2 km. What they cannot see
 * is whether that placement reaches the geometry a pick would hit. Those are
 * separate steps, and a layer drawn in the right place while its coordinates
 * resolve in the wrong frame looks perfect and measures wrong.
 *
 * `layerProjectPoints` resolves a point through the cloud's own `projectXYZ`,
 * which applies the placement exactly once, so a placement that is computed but
 * not applied, or applied to the wrong layer, shows up here as a coordinate
 * rather than as a picture.
 *
 * The raycast itself is NOT covered: canvas-click picking is flaky on headless
 * WebGL 2, which is why `__OLV_TEST_API__` exists at all. This asserts the
 * transform a pick resolves through, not the screen-to-ray mapping.
 */
test('a coordinate read from the mounted non-anchor layer is in the project frame', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isBenignPageError(m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => { if (!isBenignPageError(String(e))) errors.push(String(e)); });

  const w = await loadLasWriter();
  const bytesA = georefLas(w, 500000, 4100000);
  const bytesB = georefLas(w, 500000 + SEP_M, 4100000 + SEP_M);

  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await dropBytes(page, bytesA, 'utm33-a.las');
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await dropBytes(page, bytesB, 'utm33-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await page.waitForTimeout(500); // frame reconcile

  // Point 0 of each tile is its own origin corner: tileAt puts i=0 at (ox, oy).
  const pts = await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { layerProjectPoints: (i: number) => { id: string; project: [number, number, number] }[] };
    }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted — was ?test=1 set?');
    return api.layerProjectPoints(0);
  });

  expect(errors, `console/page errors: ${errors.join(' | ')}`).toEqual([]);
  expect(pts, 'both layers report a world point').toHaveLength(2);

  // Whichever anchored the frame, the two corner points must sit exactly the
  // real 2 km apart on both axes. A non-anchor layer left in its own frame, or
  // given the anchor's offset, lands on top of the anchor and fails here.
  const xs = pts.map((p) => p.project[0]).sort((a, b) => a - b);
  const ys = pts.map((p) => p.project[1]).sort((a, b) => a - b);
  expect(xs[1] - xs[0], 'X separation between the two layers').toBeCloseTo(SEP_M, 1);
  expect(ys[1] - ys[0], 'Y separation between the two layers').toBeCloseTo(SEP_M, 1);

  // The project frame is anchored on one tile, so its own corner sits at the
  // origin and the other 2 km out. A non-anchor layer left in its own frame
  // would collapse onto the anchor and read 0 here.
  expect(Math.abs(xs[0]), 'the anchor corner sits at the project origin').toBeLessThan(1);
  expect(xs[1], 'the mounted tile sits 2 km out').toBeCloseTo(SEP_M, 1);

  // A measurement placed on those two points reports the same separation, so
  // the measurement datum agrees with the mount rather than with one layer.
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
  await page.evaluate((p) => {
    const api = (window as unknown as { __OLV_TEST_API__?: {
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (q: { x: number; y: number; z: number }) => void;
    } }).__OLV_TEST_API__;
    api!.setMeasureKind('distance');
    api!.placeMeasurementPoint({ x: p[0].project[0], y: p[0].project[1], z: p[0].project[2] });
    api!.placeMeasurementPoint({ x: p[1].project[0], y: p[1].project[1], z: p[1].project[2] });
  }, pts);
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });

  // 2 km east and 2 km north is a 2.828 km diagonal; the row states it.
  const row = await page.locator('.olv-mp-row').first().textContent();
  const metres = Number((row ?? '').match(/([\d.]+)\s*(k?m)/)?.[1] ?? '0')
    * ((row ?? '').includes('km') ? 1000 : 1);
  expect(metres, `measurement row read "${row}"`).toBeGreaterThan(2820);
  expect(metres, `measurement row read "${row}"`).toBeLessThan(2835);
});
