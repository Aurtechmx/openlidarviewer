import { test, expect, type Browser, type Page, type TestInfo } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { geomFixtures, dropBytes } from './geomFixtures';
import { openToolPage, showWorkspaceMode, waitForLoadIdle } from './helpers';

/**
 * Saved work must reattach to the scans it was taken on after the page is gone.
 *
 * Every restore below runs in a NEW browser context, so nothing from the page
 * that saved the session survives except the file itself: the layer ids that
 * page minted are unknown to the page that imports it. The restored work has to
 * be matched to the reopened scans on their source facts, read in their units,
 * and written back by the next save, through as many cycles as the user runs.
 */

type Api = {
  setMeasureKind(k: string): void;
  placeMeasurementPoint(p: { x: number; y: number; z: number; layer?: string }): void;
  getMeasurementCount(): number;
};

type Session = {
  measurements: Array<{ id: string; points: number[][]; owner?: { layerId?: string; frame: string } }>;
  scanSummary?: { fileName: string };
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
  await page.goto('/?test=1');
  return page;
}

async function open(page: Page, scans: readonly Scan[]): Promise<void> {
  for (let i = 0; i < scans.length; i++) {
    await dropBytes(page, scans[i]!.bytes, scans[i]!.name);
    await expect(page.locator('.olv-layer')).toHaveCount(i + 1, { timeout: 90_000 });
  }
}

async function measure(page: Page, points: number[][], layer?: string): Promise<void> {
  await openToolPage(page, 'Measure');
  await page.evaluate(({ points, layer }) => {
    const api = (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__;
    api.setMeasureKind('distance');
    for (const p of points) api.placeMeasurementPoint({ x: p[0]!, y: p[1]!, z: p[2]!, ...(layer ? { layer } : {}) });
  }, { points, layer });
}

/** Every toast shown since the import began, joined. */
const toasts = (page: Page): Promise<string> =>
  page.evaluate(() => ((window as unknown as { __toasts?: string[] }).__toasts ?? []).join('\n'));

const count = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __OLV_TEST_API__: Api }).__OLV_TEST_API__.getMeasurementCount());

async function save(page: Page): Promise<Session> {
  await openToolPage(page, 'Measure');
  const download = page.waitForEvent('download');
  await page.locator('.olv-mp-action', { hasText: 'Export' }).click();
  return JSON.parse(readFileSync((await (await download).path())!, 'utf8')) as Session;
}

async function importSession(page: Page, session: Session): Promise<void> {
  // Every toast line is recorded as it appears, so a later toast replacing it
  // cannot hide what the import reported.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts?: string[] };
    if (w.__toasts) return;
    w.__toasts = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('.olv-lasso-toast-msg')) {
        const t = el.textContent ?? '';
        if (t && w.__toasts!.at(-1) !== t) w.__toasts!.push(t);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  const dt = await page.evaluateHandle((text) => {
    const d = new DataTransfer();
    d.items.add(new File([text], 'saved.olvsession'));
    return d;
  }, JSON.stringify(session));
  await waitForLoadIdle(page);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

/** The readouts the Measure panel shows, in order. */
async function readouts(page: Page): Promise<string[]> {
  await openToolPage(page, 'Measure');
  return page.locator('.olv-mp-value').allTextContents();
}

/** Every saved measurement's points in absolute source coordinates, keyed by id. */
function worldPoints(s: Session): Record<string, number[][]> {
  const out: Record<string, number[][]> = {};
  for (const m of s.measurements) {
    let base = s.origin;
    const frame = s.projectFrame;
    if (frame && m.owner) {
      const rec = frame.layers.find((l) => l.layerId === m.owner!.layerId);
      if (m.owner.frame === 'project' && rec) base = rec.sourceOrigin.map((o, k) => o - rec.sourceToProject[k]!);
      else if (m.owner.frame === 'project') base = frame.projectOrigin;
      else if (rec) base = rec.sourceOrigin;
    }
    out[m.id] = m.points.map((p) => p.map((c, k) => Math.round((c + base[k]!) * 1e6) / 1e6));
  }
  return out;
}

/**
 * The scan each saved measurement belongs to, by file name, keyed by id: its
 * owner's frame record, or the one scan a frameless file describes.
 */
function ownerNames(s: Session): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const m of s.measurements) {
    const rec = s.projectFrame?.layers.find((l) => l.layerId === m.owner?.layerId);
    out[m.id] = rec?.sourceName ?? (s.projectFrame ? null : s.scanSummary?.fileName ?? null);
  }
  return out;
}

/**
 * Restore `saved` in a fresh page over `scans`, check what comes back, save
 * again, and return the new file. The world coordinates and owners must equal
 * the saved file's.
 */
async function cycle(browser: Browser, info: TestInfo, scans: readonly Scan[], saved: Session, expected: { count: number; readouts: string[] }): Promise<Session> {
  const page = await freshPage(browser, info);
  await open(page, scans);
  await importSession(page, saved);
  await expect.poll(() => toasts(page), { timeout: 60_000 }).toMatch(/restored/);
  await expect.poll(() => count(page), { timeout: 30_000 }).toBe(expected.count);
  expect(await toasts(page)).not.toMatch(/not restored|waiting for|more than one open scan/);
  const shown = await readouts(page);
  expect(shown).toEqual(expected.readouts);
  for (const r of shown) expect(r).not.toContain('unverified');
  const next = await save(page);
  expect(next.measurements).toHaveLength(saved.measurements.length);
  expect(worldPoints(next)).toEqual(worldPoints(saved));
  expect(ownerNames(next)).toEqual(ownerNames(saved));
  await page.context().close();
  return next;
}

test.describe('session layer identity across a fresh page', () => {
  test.describe.configure({ timeout: 480_000 });

  test('anchor removed, survivor alone reopened: the measurement reattaches and survives two re-saves', async ({ browser }, info) => {
    const f = await geomFixtures();
    const a = { bytes: f.geomA, name: 'geom-a.las' };
    const b = { bytes: f.geomB, name: 'geom-b.las' };
    const page = await freshPage(browser, info);
    await open(page, [a, b]);
    await measure(page, [[101, 1, 0], [104, 5, 0]], 'geom-b.las');
    const before = await readouts(page);
    await showWorkspaceMode(page, 'data');
    await page.getByRole('button', { name: 'Remove geom-a.las', exact: true }).click();
    await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 90_000 });
    const saved = await save(page);
    expect(saved.measurements).toHaveLength(1);
    expect(saved.projectFrame).toBeDefined();
    await page.context().close();

    const second = await cycle(browser, info, [b], saved, { count: 1, readouts: before });
    const third = await cycle(browser, info, [b], second, { count: 1, readouts: before });
    await cycle(browser, info, [b], third, { count: 1, readouts: before });
  });

  test('both scans reopened in either order: the measurement is restored and survives re-saves', async ({ browser }, info) => {
    const f = await geomFixtures();
    const a = { bytes: f.geomA, name: 'geom-a.las' };
    const b = { bytes: f.geomB, name: 'geom-b.las' };
    const page = await freshPage(browser, info);
    await open(page, [a, b]);
    await measure(page, [[4, 2, 1], [7, 6, 1]], 'geom-a.las');
    const before = await readouts(page);
    const saved = await save(page);
    expect(saved.measurements).toHaveLength(1);
    expect(saved.projectFrame).toBeDefined();
    await page.context().close();

    const second = await cycle(browser, info, [a, b], saved, { count: 1, readouts: before });
    const third = await cycle(browser, info, [b, a], second, { count: 1, readouts: before });
    await cycle(browser, info, [a, b], third, { count: 1, readouts: before });
  });

  test('two scans under one file name: work goes back to the scan with the same content, never the other', async ({ browser }, info) => {
    const f = await geomFixtures();
    const a = { bytes: f.geomA, name: 'scan.las' };
    const b = { bytes: f.geomB, name: 'scan.las' };
    const page = await freshPage(browser, info);
    await open(page, [a, b]);
    // Placed with B active (the last opened), on B's plane.
    await measure(page, [[101, 1, 0], [104, 5, 0]]);
    const before = await readouts(page);
    const saved = await save(page);
    expect(saved.measurements).toHaveLength(1);
    await page.context().close();

    // Reopened in the other order: the name matches both, the content one.
    await cycle(browser, info, [b, a], saved, { count: 1, readouts: before });

    // Only the OTHER content under the same name: nothing may bind to it.
    const wrong = await freshPage(browser, info);
    await open(wrong, [a]);
    await importSession(wrong, saved);
    await expect.poll(() => toasts(wrong), { timeout: 60_000 }).toMatch(/1 item is waiting for its scan/);
    expect(await count(wrong)).toBe(0);
    const kept = await save(wrong);
    expect(kept.measurements).toHaveLength(1);
    expect(worldPoints(kept)).toEqual(worldPoints(saved));
    await wrong.context().close();
  });

  test('a scan that is not reopened keeps its work through a re-save, and it comes back when the scan does', async ({ browser }, info) => {
    const f = await geomFixtures();
    const a = { bytes: f.geomA, name: 'geom-a.las' };
    const b = { bytes: f.geomB, name: 'geom-b.las' };
    const page = await freshPage(browser, info);
    await open(page, [a, b]);
    await measure(page, [[4, 2, 1], [7, 6, 1]], 'geom-a.las');
    await measure(page, [[101, 1, 0], [104, 5, 0]], 'geom-b.las');
    const before = await readouts(page);
    const saved = await save(page);
    expect(saved.measurements).toHaveLength(2);
    await page.context().close();

    // Only B reopened: B's measurement is restored, A's waits for A.
    const partial = await freshPage(browser, info);
    await open(partial, [b]);
    await importSession(partial, saved);
    await expect.poll(() => toasts(partial), { timeout: 60_000 }).toMatch(/1 item is waiting for its scan/);
    await expect.poll(() => count(partial), { timeout: 30_000 }).toBe(1);
    const resaved = await save(partial);
    expect(resaved.measurements).toHaveLength(2);
    expect(worldPoints(resaved)).toEqual(worldPoints(saved));
    expect(ownerNames(resaved)).toEqual(ownerNames(saved));
    await partial.context().close();

    // Both reopened: both measurements are back, with their original readouts.
    await cycle(browser, info, [a, b], resaved, { count: 2, readouts: before });
  });
  test('a scan opened after the import, in the same page, gets its held work back', async ({ browser }, info) => {
    const f = await geomFixtures();
    const a = { bytes: f.geomA, name: 'geom-a.las' };
    const b = { bytes: f.geomB, name: 'geom-b.las' };
    const page = await freshPage(browser, info);
    await open(page, [a, b]);
    await measure(page, [[4, 2, 1], [7, 6, 1]], 'geom-a.las');
    await measure(page, [[101, 1, 0], [104, 5, 0]], 'geom-b.las');
    const before = await readouts(page);
    const saved = await save(page);
    await page.context().close();

    const later = await freshPage(browser, info);
    await open(later, [b]);
    await importSession(later, saved);
    await expect.poll(() => toasts(later), { timeout: 60_000 }).toMatch(/1 item is waiting for its scan/);
    await expect.poll(() => count(later), { timeout: 30_000 }).toBe(1);
    // Opening A restores its measurement without a second import.
    await dropBytes(later, a.bytes, a.name);
    await expect(later.locator('.olv-layer')).toHaveCount(2, { timeout: 90_000 });
    await expect.poll(() => toasts(later), { timeout: 60_000 }).toMatch(/Restored 1 measurement and 0 annotations from the session onto “geom-a\.las”\./);
    await expect.poll(() => count(later), { timeout: 30_000 }).toBe(2);
    expect([...await readouts(later)].sort()).toEqual([...before].sort());
    const resaved = await save(later);
    expect(worldPoints(resaved)).toEqual(worldPoints(saved));
    expect(ownerNames(resaved)).toEqual(ownerNames(saved));
    await later.context().close();
  });
});
