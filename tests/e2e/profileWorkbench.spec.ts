import { test, expect, type Page } from '@playwright/test';
import { dropDenseGridPly } from './helpers';

/**
 * Profile workbench acceptance flows.
 *
 * The unit suite already covers the section maths, the LOD selection, the CSV
 * and the PDF. What only a browser can show is that opening the workbench does
 * not cost the 3D scene, that the canvas draws something, that the accessible
 * structure a screen reader needs is really in the DOM, and that closing it
 * leaves the measurement behind. Those are the parts a unit test cannot reach
 * and a screenshot cannot prove.
 *
 * Placement goes through `__OLV_TEST_API__`, the `?test=1` seam the other
 * measurement specs use, so the flows do not depend on a raycast landing on a
 * particular pixel. Two profile endpoints are pushed in world space; the dense
 * grid fixture spans about [-5, +5] on each axis, so a run along X sits inside
 * it with points either side of the corridor.
 *
 * NOT covered here, deliberately, because a browser flow would assert less than
 * the unit test that already covers it, or would assert something the fixture
 * cannot produce:
 *
 *   - exact accepted-point counts and LOD row counts, which
 *     profileSectionLod.test.ts and profileReturnsCsv.test.ts pin numerically
 *     against known clouds rather than against whatever the fixture yields;
 *   - the true vertical-exaggeration ratio, which needs a scan with known CRS
 *     units, and the fixture is a unitless PLY;
 *   - the non-anchor mounted-layer link, which needs two placed layers and is
 *     covered by twoScanMount.spec.ts plus workbenchPointLink.test.ts;
 *   - the streaming resident caveat, covered by streamingCaveat.spec.ts against
 *     a streaming source this fixture is not.
 *
 * Listing them is the point: a spec file named after an acceptance list should
 * not let a reader assume the whole list ran.
 */

/** Wide enough that the docked workbench is chosen over the focus view. */
const WIDE = { width: 1440, height: 900 };

interface TestApi {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  finishMeasurement?: () => void;
}

/** Load the dense fixture, arm Measure, and place one profile across it. */
async function placeProfile(page: Page): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500); // the test API mounts on viewerLoaded
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();

  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: TestApi }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted — was ?test=1 set?');
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y: 0, z: 0 });
    api.finishMeasurement?.();
  });

  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

/** Open the workbench from the profile row's expand affordance. */
async function openWorkbench(page: Page): Promise<void> {
  await page.locator('.olv-mp-chart-wrap').first().click();
  await expect(page.locator('.olv-workbench')).toBeVisible({ timeout: 10_000 });
}

test.describe('profile workbench', () => {
  test('a profile lists a row and keeps its compact chart', async ({ page }) => {
    // Scenarios 1-3: the measurement exists and the small chart stays in the
    // panel, so opening the workbench is an addition rather than a replacement.
    await placeProfile(page);
    await expect(page.locator('.olv-mp-chart-wrap')).toHaveCount(1);
  });

  test('opening the workbench leaves the 3D scene mounted and visible', async ({ page }) => {
    // Scenarios 4-5, and the one that would hurt most if it regressed. The dock
    // shares a box with the stage; a workbench that replaced the canvas rather
    // than sharing with it would still look right in a screenshot of itself.
    await placeProfile(page);
    const sceneCanvas = page.locator('canvas').first();
    await expect(sceneCanvas).toBeVisible();

    await openWorkbench(page);

    await expect(sceneCanvas).toBeVisible();
    const box = await sceneCanvas.boundingBox();
    expect(box, 'the scene canvas still occupies a box').not.toBeNull();
    expect(box!.height).toBeGreaterThan(0);
  });

  test('the workbench draws its section onto a canvas of its own', async ({ page }) => {
    // Scenario 6. Asserting the canvas has area is weaker than asserting pixels,
    // and honest: what pixels land there is the renderer's business and is
    // covered by profileSectionRenderer.test.ts.
    await placeProfile(page);
    await openWorkbench(page);

    const wb = page.locator('.olv-workbench-canvas');
    await expect(wb).toBeVisible();
    const box = await wb.boundingBox();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(50);
  });

  test('the workbench is a labelled region with a described canvas', async ({ page }) => {
    // Scenario from section 39: a canvas cannot be the only source of exact
    // information. The region label and the canvas description are what a
    // screen reader reads before any of the numbers.
    await placeProfile(page);
    await openWorkbench(page);

    const region = page.locator('.olv-workbench');
    await expect(region).toHaveAttribute('role', 'region');
    const label = await region.getAttribute('aria-label');
    expect(label && label.length > 0, 'the region carries a name').toBe(true);

    const canvas = page.locator('.olv-workbench-canvas');
    await expect(canvas).toHaveAttribute('role', 'img');
    const described = await canvas.getAttribute('aria-label');
    expect(described && described.length > 20, 'the canvas describes itself').toBe(true);
  });

  test('the section figures live in the DOM, not only in the canvas', async ({ page }) => {
    // Scenario 10 and the accessibility requirement behind it: a canvas states
    // nothing an assistive technology can read, so every exact value the plot
    // shows also exists as text.
    //
    // The panel is populated from the moment the section builds, rather than
    // waiting for a pick and showing a "nothing selected" placeholder until
    // then. That is the stronger behaviour, and it is what makes the labelled
    // region worth landing on: a reader who tabs here before touching the plot
    // still gets the scope and extent in words.
    await placeProfile(page);
    await openWorkbench(page);

    const detail = page.locator('.olv-workbench-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toHaveAttribute('aria-label', 'Selected return');

    // The panel is in the document before its rows are, because the section is
    // measured after the dock opens. `count()` and `textContent()` read once
    // and do not wait, so on a slow machine they saw the empty panel and read
    // it as a panel that carries nothing. These wait for the rows to arrive.
    const rows = page.locator('.olv-workbench-detail-row');
    await expect(rows.first(), 'the detail panel carries rows on open').toBeVisible();

    // Each row is a key and a value, so the text is readable as a pair rather
    // than as a number with no name attached to it.
    const firstKey = page.locator('.olv-workbench-detail-key').first();
    const firstValue = page.locator('.olv-workbench-detail-value').first();
    await expect(firstKey).not.toBeEmpty();
    await expect(firstValue).not.toBeEmpty();
  });

  test('status is announced politely rather than only drawn', async ({ page }) => {
    await placeProfile(page);
    await openWorkbench(page);
    await expect(page.locator('.olv-workbench-status')).toHaveAttribute('role', 'status');
  });

  test('the splitter is a keyboard-reachable separator', async ({ page }) => {
    // The dock is resizable, and a drag handle that only responds to a mouse
    // makes the whole workbench unusable from a keyboard.
    await placeProfile(page);
    await openWorkbench(page);

    const splitter = page.locator('.olv-workbench-splitter');
    await expect(splitter).toHaveAttribute('role', 'separator');
    await expect(splitter).toHaveAttribute('aria-label', 'Resize the profile workbench');
  });

  test('collapsing keeps the workbench mounted, and closing leaves the measurement', async ({ page }) => {
    // Scenarios 21-22. Collapse and close are different promises: one keeps the
    // section around, the other gives the room back. Neither may take the
    // measurement with it, because the measurement is the user's work and the
    // workbench is only a view onto it.
    await placeProfile(page);
    await openWorkbench(page);

    await page.locator('.olv-workbench-btn', { hasText: 'Collapse' }).click();
    await expect(page.locator('.olv-workbench-collapsed')).toHaveCount(1);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);

    await page.locator('.olv-workbench-btn', { hasText: 'Close' }).click();
    await expect(page.locator('.olv-workbench')).toHaveCount(0);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
  });

  test('reopening after a close builds the section again', async ({ page }) => {
    // Scenario 22. The snapshot is regenerated rather than restored, so a
    // second open exercises the whole build path a first open did.
    await placeProfile(page);
    await openWorkbench(page);
    await page.locator('.olv-workbench-btn', { hasText: 'Close' }).click();
    await expect(page.locator('.olv-workbench')).toHaveCount(0);

    await openWorkbench(page);
    await expect(page.locator('.olv-workbench-canvas')).toBeVisible();
  });

  test('no console error is raised across an open, collapse, close and reopen', async ({ page }) => {
    // A workbench that throws on teardown still passes every assertion above,
    // because the DOM it leaves behind is the DOM those assertions want.
    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push(String(e)));

    await placeProfile(page);
    await openWorkbench(page);
    await page.locator('.olv-workbench-btn', { hasText: 'Collapse' }).click();
    await page.locator('.olv-workbench-btn', { hasText: 'Close' }).click();
    await openWorkbench(page);

    expect(errors, `console errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
