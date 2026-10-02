import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { showWorkspaceMode } from './helpers';
import { dropBytes, geomFixtures } from './geomFixtures';

/**
 * Measurement exports with two scans open place every measurement through the
 * scan it was taken on, whichever scan is active at export time.
 *
 * Scan A sits at E 500000, Z 100 and scan B 100 m east at Z 50. A distance on
 * A placed before B is added, an area started on A and finished after, and a
 * distance taken on B must each export at their own world coordinates and name
 * their own source, in either load order.
 */

type Vec3 = [number, number, number];
interface Api {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void;
  finishMeasurement(): void;
}

/**
 * Each layer's offset into the project frame as the scene places it: the
 * project position of its first record, less that record's local position
 * (A's first record sits 1 m above its floor(min) origin, B's on it).
 */
async function offsets(page: Page, order: readonly ('a' | 'b')[]): Promise<Record<'a' | 'b', Vec3>> {
  const pts = await page.evaluate(() =>
    (window as unknown as { __OLV_TEST_API__: { layerProjectPoints(i: number): { project: Vec3 }[] } }).__OLV_TEST_API__.layerProjectPoints(0));
  expect(pts).toHaveLength(2);
  const local: Record<'a' | 'b', Vec3> = { a: [0, 0, 1], b: [0, 0, 0] };
  const out = {} as Record<'a' | 'b', Vec3>;
  order.forEach((k, i) => { out[k] = [pts[i].project[0] - local[k][0], pts[i].project[1] - local[k][1], pts[i].project[2] - local[k][2]]; });
  return out;
}

async function place(page: Page, kind: string, pts: Vec3[], finish = false, layer?: string): Promise<void> {
  await page.evaluate(({ k, p, f, layer }) => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind(k);
    for (const q of p) api.placeMeasurementPoint({ x: q[0], y: q[1], z: q[2], layer });
    if (f) api.finishMeasurement();
  }, { k: kind, p: pts, f: finish, layer });
}

async function exportFile(page: Page, label: 'GeoJSON' | 'CSV'): Promise<{ name: string; text: string }> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  const head = panel.locator('.olv-export-products-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  const btn = panel.locator('.olv-export-product-actions button', { hasText: new RegExp(`^${label}$`) });
  const wait = page.waitForEvent('download');
  await btn.click();
  const d = await wait;
  return { name: d.suggestedFilename(), text: readFileSync((await d.path())!, 'utf8') };
}

async function armMeasure(page: Page): Promise<void> {
  if (!(await page.locator('.olv-measure-bar').isVisible())) await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();
}

const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];

// Points in each scan's own local frame (metres from its floor(min) origin).
const A_DIST: Vec3[] = [[4, 2, 1], [7, 2, 1]];
const A_AREA: Vec3[] = [[2, 10, 1], [12, 10, 1], [12, 16, 1]];
const B_DIST: Vec3[] = [[1, 1, 0], [4, 5, 0]];

/** World coordinates every export must carry, from the fixture geometry alone. */
const WORLD = {
  aDist: [[500004, 4000002, 100], [500007, 4000002, 100]],
  aArea: [[500002, 4000010, 100], [500012, 4000010, 100], [500012, 4000016, 100], [500002, 4000010, 100]],
  bDist: [[500101, 4000001, 50], [500104, 4000005, 50]],
};

interface Feature { geometry: { type: string; coordinates: number[][] | number[][][] }; properties: Record<string, unknown> }

function byName(text: string): Record<string, Feature> {
  const fc = JSON.parse(text) as { features: Feature[] };
  return Object.fromEntries(fc.features.map((f) => [String(f.properties.name), f]));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
});

for (const order of ['A then B', 'B then A'] as const) {
  test(`two-scan measurement export uses each measurement's own scan (${order})`, async ({ page }) => {
    const fx = await geomFixtures();
    const first = order === 'A then B' ? { bytes: fx.geomA, name: 'geom-a.las', key: 'a' } : { bytes: fx.geomB, name: 'geom-b.las', key: 'b' };
    const second = order === 'A then B' ? { bytes: fx.geomB, name: 'geom-b.las', key: 'b' } : { bytes: fx.geomA, name: 'geom-a.las', key: 'a' };

    await dropBytes(page, first.bytes, first.name);
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
    await armMeasure(page);
    // One scan open: its local frame is the project frame.
    if (first.key === 'a') {
      await place(page, 'distance', A_DIST);
      await place(page, 'area', A_AREA);
    } else {
      await place(page, 'distance', B_DIST);
    }

    await dropBytes(page, second.bytes, second.name);
    await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
    const off = await offsets(page, [first.key, second.key] as ('a' | 'b')[]);
    await armMeasure(page);
    if (first.key === 'a') {
      // The area started on A is finished with B open and active.
      await place(page, 'area', [], true);
      await place(page, 'distance', B_DIST.map((p) => add(p, off.b)), false, 'geom-b.las');
    } else {
      await place(page, 'distance', A_DIST.map((p) => add(p, off.a)), false, 'geom-a.las');
      await place(page, 'area', A_AREA.map((p) => add(p, off.a)), true, 'geom-a.las');
    }
    await expect(page.locator('.olv-mp-row')).toHaveCount(3, { timeout: 5_000 });

    const geo = await exportFile(page, 'GeoJSON');
    const feats = byName(geo.text);
    // Names follow placement order: the first scan's distance is "Distance 1".
    const aDist = first.key === 'a' ? 'Distance 1' : 'Distance 2';
    const bDist = first.key === 'a' ? 'Distance 2' : 'Distance 1';
    expect(feats[aDist].geometry.coordinates, 'distance on A').toEqual(WORLD.aDist);
    expect(feats[bDist].geometry.coordinates, 'distance on B').toEqual(WORLD.bDist);
    expect((feats['Area 1'].geometry.coordinates as number[][][])[0], 'area on A').toEqual(WORLD.aArea);
    expect(feats[aDist].properties.source).toBe('geom-a');
    expect(feats[bDist].properties.source).toBe('geom-b');
    expect(feats['Area 1'].properties.source).toBe('geom-a');
    expect(geo.name).toBe('geom-a+geom-b-measurements.geojson');

    const csv = await exportFile(page, 'CSV');
    expect(csv.name).toBe('geom-a+geom-b-measurements.csv');
    const [header, ...rows] = csv.text.split('\n');
    const col = header.split(',').indexOf('source');
    expect(col).toBeGreaterThan(-1);
    const sources = rows.map((r) => r.split(',')[col]).sort();
    expect(sources).toEqual(['geom-a', 'geom-a', 'geom-b']);
  });
}

test('a one-scan export names that scan and keeps its coordinates', async ({ page }) => {
  const fx = await geomFixtures();
  await dropBytes(page, fx.geomA, 'geom-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await armMeasure(page);
  await place(page, 'distance', A_DIST);
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  const geo = await exportFile(page, 'GeoJSON');
  expect(geo.name).toBe('geom-a-measurements.geojson');
  const f = Object.values(byName(geo.text))[0];
  expect(f.geometry.coordinates).toEqual(WORLD.aDist);
  expect(f.properties.source).toBe('geom-a');
  const csv = await exportFile(page, 'CSV');
  expect(csv.name).toBe('geom-a-measurements.csv');
  const [header, row] = csv.text.split('\n');
  expect(row.split(',')[header.split(',').indexOf('source')]).toBe('geom-a');
});

// A point picked on the scan that is NOT active: the export follows the scan
// under the pick. Horizontal-only scans keep their own heights (dz = 0), so a
// point exported through the active scan's frame lands at the wrong height.
for (const vertical of [false, true]) {
  for (const order of ['A then B', 'B then A'] as const) {
    test(`a point picked on the inactive scan exports on that scan (${vertical ? 'verified' : 'horizontal-only'}, ${order})`, async ({ page }) => {
      const fx = await geomFixtures();
      const a = vertical ? fx.geomAVert : fx.geomA;
      const b = vertical ? fx.geomBVert : fx.geomB;
      const aFirst = order === 'A then B';
      await dropBytes(page, aFirst ? a : b, aFirst ? 'geom-a.las' : 'geom-b.las');
      await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
      await armMeasure(page);
      await dropBytes(page, aFirst ? b : a, aFirst ? 'geom-b.las' : 'geom-a.las');
      await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
      const off = await offsets(page, aFirst ? ['a', 'b'] : ['b', 'a']);
      await expect(page.locator('.olv-measure-bar')).toBeVisible();
      // The last-loaded scan is active; the pick lands on the first-loaded one.
      if (aFirst) await place(page, 'distance', A_DIST.map((p) => add(p, off.a)), false, 'geom-a.las');
      else await place(page, 'distance', B_DIST.map((p) => add(p, off.b)), false, 'geom-b.las');
      await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
      const geo = await exportFile(page, 'GeoJSON');
      const f = Object.values(byName(geo.text))[0];
      expect(f.geometry.coordinates).toEqual(aFirst ? WORLD.aDist : WORLD.bDist);
      expect(f.properties.source).toBe(aFirst ? 'geom-a' : 'geom-b');
    });
  }
}

// Save, close both scans, reopen them and the session: the record of where each
// point was picked survives, so the export still places it on its own scan.
test('a session saved and reopened with two scans keeps each point on the scan it was picked on', async ({ page }) => {
  test.setTimeout(90_000);
  const fx = await geomFixtures();
  await dropBytes(page, fx.geomA, 'geom-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await armMeasure(page);
  await dropBytes(page, fx.geomB, 'geom-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  const off = await offsets(page, ['a', 'b']);
  // B is active; the distance is picked on A.
  await place(page, 'distance', A_DIST.map((p) => add(p, off.a)), false, 'geom-a.las');
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
  await showWorkspaceMode(page, 'work');
  const [saved] = await Promise.all([page.waitForEvent('download'), page.locator('.olv-mp-action', { hasText: 'Export' }).click()]);
  const sessionText = readFileSync((await saved.path())!, 'utf8');
  expect(sessionText).toContain('pickLayers');

  await showWorkspaceMode(page, 'data');
  await page.getByRole('button', { name: 'Remove geom-b.las' }).click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  // Removing the last scan closes it, after a confirmation.
  await page.getByRole('button', { name: 'Remove geom-a.las' }).click();
  await page.getByRole('button', { name: 'Remove and close' }).click();
  await expect(page.locator('.olv-layer')).toHaveCount(0, { timeout: 20_000 });
  await dropBytes(page, fx.geomA, 'geom-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await dropBytes(page, fx.geomB, 'geom-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 20_000 });
  await expect(page.locator('.olv-project-card')).toContainText('geom-b.las');
  await dropBytes(page, new TextEncoder().encode(sessionText), 'geom-b.olvsession');
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 10_000 });

  const geo = await exportFile(page, 'GeoJSON');
  const f = Object.values(byName(geo.text))[0];
  expect(f.geometry.coordinates).toEqual(WORLD.aDist);
  expect(f.properties.source).toBe('geom-a');
});
