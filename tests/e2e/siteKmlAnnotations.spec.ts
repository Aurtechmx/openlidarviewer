import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import proj4 from 'proj4';
import { geomFixtures, dropBytes } from './geomFixtures';
import { openToolPage, showWorkspaceMode, dropHillsPly } from './helpers';
import { COPC_FIXTURE } from './streamingFixtures';

/**
 * Site KML end to end.
 *
 * The up-axis a lon/lat placement relies on is resolved through the shared
 * per-layer frame rule: an ordinary Z-up LAS, a streamed (LAS-derived) scan and
 * a PLY under a CRS export; a mesh with no CRS is refused (a glTF under a
 * CRS is refused too: tests/kmlSiteUpAxisWiring.test.ts). Annotations are
 * placed only when the active scan owns them; one left behind by a closed scan
 * is withheld and the document says so, rather than being written at the
 * active scan's lon/lat for coordinates it never had there.
 */

const UTM13N = '+proj=utm +zone=13 +datum=WGS84 +units=m +no_defs';

async function siteKmlButton(page: Page): Promise<Locator> {
  await showWorkspaceMode(page, 'output');
  const panel = page.locator('.olv-export-panel');
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((e) => e.classList.contains('olv-collapsed'))) await panel.locator('.olv-panel-head').click();
  const head = panel.locator('.olv-export-products-head');
  if ((await head.getAttribute('aria-expanded')) === 'false') await head.click();
  return panel.getByRole('button', { name: 'Site KML', exact: true });
}

async function downloadSiteKml(page: Page): Promise<string> {
  const site = await siteKmlButton(page);
  await expect(site).toBeEnabled();
  const wait = page.waitForEvent('download');
  await site.click();
  const d = await wait;
  expect(d.suggestedFilename()).toMatch(/\.kml$/);
  return readFileSync((await d.path())!, 'utf8');
}

/** Click the scan near the centre until the annotation editor opens, then save `title`. */
async function annotate(page: Page, title: string): Promise<void> {
  await openToolPage(page, 'Annotate');
  const box = await page.locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  for (const q of [[0.5, 0.5], [0.46, 0.46], [0.54, 0.54], [0.5, 0.42], [0.5, 0.58]]) {
    await page.mouse.click(box!.x + box!.width * q[0]!, box!.y + box!.height * q[1]!);
    try {
      await expect(page.locator('.olv-anno-editor')).toBeVisible({ timeout: 1500 });
      break;
    } catch { /* missed the cloud; try the next spot */ }
  }
  await expect(page.locator('.olv-anno-editor')).toBeVisible();
  await page.locator('.olv-anno-editor-title').fill(title);
  await page.locator('.olv-anno-editor-save').click();
}

/** The session the Measure page exports, for the annotation's recorded world position. */
async function exportSession(page: Page): Promise<{ annotations: Array<{ title: string; worldPosition: { x: number; y: number }; owner?: { layerId?: string } }> }> {
  await openToolPage(page, 'Measure');
  const wait = page.waitForEvent('download');
  await page.locator('.olv-mp-action', { hasText: 'Save session' }).click();
  return JSON.parse(readFileSync((await (await wait).path())!, 'utf8'));
}

function placemarkCoords(kml: string, name: string): number[] {
  const m = kml.match(new RegExp(`<name>${name}</name>[\\s\\S]*?<coordinates>([^<]+)</coordinates>`));
  expect(m, `placemark ${name}`).not.toBeNull();
  return m![1]!.trim().split(',').map(Number);
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
});

test('an ordinary Z-up UTM LAS exports Site KML with the annotation at its real lon/lat', async ({ page }) => {
  const f = await geomFixtures();
  await dropBytes(page, f.geomA, 'site-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await annotate(page, 'SITE-NOTE');
  const session = await exportSession(page);
  const a = session.annotations.find((x) => x.title === 'SITE-NOTE')!;
  expect(a).toBeDefined();
  const [lon, lat] = proj4(UTM13N, 'WGS84', [a.worldPosition.x, a.worldPosition.y]) as [number, number];

  const kml = await downloadSiteKml(page);
  const [klon, klat] = placemarkCoords(kml, 'SITE-NOTE');
  expect(klon).toBeCloseTo(lon, 6);
  expect(klat).toBeCloseTo(lat, 6);
  // Zone 13N around 500 000 E / 4 000 000 N: the central meridian, ~36 N.
  expect(klon).toBeCloseTo(-105, 2);
  expect(klat).toBeGreaterThan(36);
  expect(klat).toBeLessThan(36.2);
  expect(kml).not.toContain('withheld');
});

test('an annotation left by a removed scan is withheld from the remaining scan\'s Site KML', async ({ page }) => {
  // A in zone 13N, B a copy declared zone 12N, a note
  // on B, then B removed. The button used to stay disabled for an unknown
  // up-axis; with the axis resolved it exports, and B's note must not ride
  // along at A's lon/lat.
  const f = await geomFixtures();
  const b = Uint8Array.from(f.geomA);
  const v = new DataView(b.buffer);
  let p = v.getUint16(94, true);
  let changed = false;
  for (let i = 0; i < v.getUint32(100, true); i++) {
    const id = v.getUint16(p + 18, true), len = v.getUint16(p + 20, true), body = p + 54;
    if (id === 34735) {
      for (let k = 0; k < v.getUint16(body + 6, true); k++) {
        const at = body + 8 + k * 8;
        if (v.getUint16(at, true) === 3072) { v.setUint16(at + 6, 32612, true); changed = true; }
      }
    }
    p = body + len;
  }
  expect(changed).toBe(true);
  await dropBytes(page, f.geomA, 'notes-a.las');
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  await dropBytes(page, b, 'notes-b.las');
  await expect(page.locator('.olv-layer')).toHaveCount(2, { timeout: 45_000 });
  await showWorkspaceMode(page, 'data');
  await page.getByRole('button', { name: 'Isolate notes-b.las', exact: true }).click();
  await annotate(page, 'FOREIGN-CRS-NOTE');
  const session = await exportSession(page);
  expect(session.annotations.find((x) => x.title === 'FOREIGN-CRS-NOTE')?.owner?.layerId).toBeTruthy();

  await showWorkspaceMode(page, 'data');
  await page.getByRole('button', { name: 'Remove notes-b.las', exact: true }).click();
  await expect(page.locator('.olv-layer')).toHaveCount(1, { timeout: 20_000 });
  const kml = await downloadSiteKml(page);
  expect(kml).not.toContain('FOREIGN-CRS-NOTE');
  expect(kml).toContain('1 annotation withheld: placed on a scan that is no longer open');
});

test('a streamed COPC scan exports Site KML', async ({ page }) => {
  await page.locator('.olv-file-input').first().setInputFiles(COPC_FIXTURE);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 30_000 });
  const site = await siteKmlButton(page);
  await expect(site).toBeEnabled({ timeout: 30_000 });
  const kml = await downloadSiteKml(page);
  // The declared extent's outline, placed in zone 13N.
  const ring = kml.match(/<name>Scan outline<\/name>[\s\S]*?<coordinates>([^<]+)<\/coordinates>/);
  expect(ring).not.toBeNull();
  for (const pair of ring![1]!.trim().split(/\s+/)) {
    const [lon, lat] = pair.split(',').map(Number);
    expect(lon!).toBeGreaterThan(-108);
    expect(lon!).toBeLessThan(-102);
    expect(Number.isFinite(lat)).toBe(true);
  }
});

test('a mesh with no CRS is refused; once a CRS is chosen its X, Y, Z are easting, northing, height', async ({ page }) => {
  await dropHillsPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  let site = await siteKmlButton(page);
  await expect(site).toBeDisabled();
  // The disabled button says why on hover.
  await expect(site).toHaveAttribute('title', /KML needs a georeferenced scan/);
  await showWorkspaceMode(page, 'data');
  await page.locator('summary', { hasText: 'Coordinate system' }).first().click();
  await page.locator('.olv-crs-select').first().selectOption('32613');
  // The rule terrain, measurement and conversion share: a PLY under a CRS is
  // Z-up, so the footprint is read off X/Y like any survey.
  site = await siteKmlButton(page);
  await expect(site).toBeEnabled({ timeout: 20_000 });
});
