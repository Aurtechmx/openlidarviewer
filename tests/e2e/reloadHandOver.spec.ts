import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { geomFixtures, dropBytes } from './geomFixtures';
import { openToolPage, showWorkspaceMode, waitForLoadIdle } from './helpers';

/**
 * "Reload at higher density" opens the same file again and hands the original
 * layer's identity to the copy before the original is closed. Work placed
 * before the reload stays owned, the layer keeps its place in its group, and a
 * session saved afterwards restores both in a fresh page.
 *
 * The scans are small and not reduced, so the reload runs through the test
 * seam's call into the Output panel's reload (past its confirm dialog) rather
 * than the link a reduced layer shows.
 */

type Api = {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void;
  getMeasurementCount(): number;
  reloadLayerByName(name: string, budget: number): Promise<void>;
};

type Session = {
  measurements: Array<{ id: string; points: number[][]; owner?: { layerId?: string; frame: string } }>;
  layerGroups?: Array<{ name: string; memberIds: string[] }>;
  projectFrame?: { projectOrigin: number[]; layers: Array<{ layerId: string; sourceName: string; sourceOrigin: number[]; sourceToProject: number[] }> };
  origin: number[];
};

type Scan = { bytes: Uint8Array; name: string };

async function freshPage(browser: Browser, info: TestInfo): Promise<Page> {
  const use = info.project.use;
  const ctx = await browser.newContext({
    baseURL: use.baseURL,
    storageState: use.storageState,
    viewport: use.viewport ?? { width: 1280, height: 720 },
  });
  const page = await ctx.newPage();
  // Every toast line is recorded as it appears, so a later toast cannot hide one.
  await page.addInitScript(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    document.addEventListener('DOMContentLoaded', () => {
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('.olv-lasso-toast-msg')) {
          const t = el.textContent ?? '';
          if (t && w.__toasts.at(-1) !== t) w.__toasts.push(t);
        }
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
  });
  await page.goto('/?test=1');
  return page;
}

async function open(page: Page, scans: readonly Scan[]): Promise<void> {
  for (let i = 0; i < scans.length; i++) {
    await dropBytes(page, scans[i]!.bytes, scans[i]!.name);
    await expect(page.locator('.olv-layer')).toHaveCount(i + 1, { timeout: 90_000 });
  }
}

const api = (page: Page) => ({
  count: () => page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.getMeasurementCount()),
});

const toasts = (page: Page): Promise<string> =>
  page.evaluate(() => ((window as unknown as { __toasts?: string[] }).__toasts ?? []).join('\n'));

async function readouts(page: Page): Promise<string[]> {
  await openToolPage(page, 'Measure');
  return page.locator('.olv-mp-value').allTextContents();
}

async function save(page: Page): Promise<Session> {
  await openToolPage(page, 'Measure');
  const download = page.waitForEvent('download');
  await page.locator('.olv-mp-action', { hasText: 'Save session' }).click();
  return JSON.parse(readFileSync((await (await download).path())!, 'utf8')) as Session;
}

async function importSession(page: Page, session: Session): Promise<void> {
  const dt = await page.evaluateHandle((text) => {
    const d = new DataTransfer();
    d.items.add(new File([text], 'saved.olvsession'));
    return d;
  }, JSON.stringify(session));
  await waitForLoadIdle(page);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

/** Every saved measurement's points in absolute source coordinates, keyed by id. */
function worldPoints(s: Session): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const m of s.measurements) {
    let base = s.origin;
    const rec = s.projectFrame?.layers.find((l) => l.layerId === m.owner?.layerId);
    if (m.owner?.frame === 'project' && rec) base = rec.sourceOrigin.map((o, k) => o - rec.sourceToProject[k]!);
    else if (rec) base = rec.sourceOrigin;
    out[m.id] = m.points.map((p) => p.map((c, k) => Math.round((c + base[k]!) * 1e6) / 1e6));
  }
  return out;
}

/** The scan names each saved group holds, through the file's own frame records. */
function groupScans(s: Session): Array<{ name: string; scans: string[] }> {
  return (s.layerGroups ?? []).map((g) => ({
    name: g.name,
    scans: g.memberIds.map((id) => s.projectFrame?.layers.find((l) => l.layerId === id)?.sourceName ?? `unknown:${id}`),
  }));
}

/** The layer rows each group header holds in the Layers panel. */
async function groupRows(page: Page): Promise<string[][]> {
  await showWorkspaceMode(page, 'data');
  return page.locator('.olv-group').evaluateAll((groups) =>
    groups.map((g) => Array.from(g.querySelectorAll('.olv-layer')).map((r) => (r.textContent ?? '').includes('geom-a.las') ? 'geom-a.las' : (r.textContent ?? '').includes('geom-b.las') ? 'geom-b.las' : '?')));
}

test('a density reload keeps work and group membership through a save and a fresh-page import', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const f = await geomFixtures();
  const a = { bytes: f.geomA, name: 'geom-a.las' };
  const b = { bytes: f.geomB, name: 'geom-b.las' };

  const page = await freshPage(browser, info);
  // A is opened last, so it is the active layer and owns the measurement.
  await open(page, [b, a]);
  await openToolPage(page, 'Measure');
  await page.evaluate(() => {
    const t = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    t.setMeasureKind('distance');
    for (const p of [[4, 2, 1], [7, 6, 1]]) t.placeMeasurementPoint({ x: p[0]!, y: p[1]!, z: p[2]!, layer: 'geom-a.las' });
  });
  await expect.poll(() => api(page).count()).toBe(1);
  const before = await readouts(page);

  // Group A on its own.
  await showWorkspaceMode(page, 'data');
  await page.locator('.olv-group-new:not(.olv-add-dataset-row)').click();
  await page.locator('.olv-group-pick', { hasText: 'geom-a.las' }).locator('input').check();
  await expect.poll(() => groupRows(page)).toEqual([['geom-a.las']]);

  // Reload A. Its copy replaces it in the scene, in the group and as owner of the work.
  await page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.reloadLayerByName('geom-a.las', 1_000_000));
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 60_000 });
  expect(await toasts(page)).not.toMatch(/refused|did not complete/);
  expect(await api(page).count()).toBe(1);
  expect(await readouts(page)).toEqual(before);
  await expect.poll(() => groupRows(page)).toEqual([['geom-a.las']]);

  const saved = await save(page);
  expect(saved.measurements).toHaveLength(1);
  const recA = saved.projectFrame!.layers.find((l) => l.sourceName === 'geom-a.las')!;
  expect(saved.measurements[0]!.owner!.layerId).toBe(recA.layerId);
  expect((saved.measurements[0] as { pickLayers?: string[] }).pickLayers).toEqual([recA.layerId]);
  expect(groupScans(saved)).toEqual([{ name: 'Group 1', scans: ['geom-a.las'] }]);
  await page.context().close();

  // A fresh page with both scans open restores the work onto A and A into its group.
  const fresh = await freshPage(browser, info);
  await open(fresh, [a, b]);
  await importSession(fresh, saved);
  await expect.poll(() => toasts(fresh), { timeout: 60_000 }).toMatch(/restored/);
  await expect.poll(() => api(fresh).count(), { timeout: 30_000 }).toBe(1);
  expect(await toasts(fresh)).not.toMatch(/not restored|waiting for|more than one open scan/);
  expect(await readouts(fresh)).toEqual(before);
  await expect.poll(() => groupRows(fresh)).toEqual([['geom-a.las']]);
  const again = await save(fresh);
  expect(worldPoints(again)).toEqual(worldPoints(saved));
  expect(groupScans(again)).toEqual(groupScans(saved));
  await fresh.context().close();
});
