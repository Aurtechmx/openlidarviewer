import { test, expect, type Page } from '@playwright/test';
import { openAnalysePanel, type MeasureTestApi } from './helpers';
import { EPT_FIXTURE_NODES, openEptFixture, routeEptFixture } from './streamingFixtures';

/**
 * The streaming caveats. While only part of a streaming octree is resident,
 * the terrain analysis reports `resident-only` coverage (its DEM export is a
 * preliminary preview) and a Profile carries the `Resident-node analysis only`
 * caption. Once every node is resident, the Profile caption clears on its own
 * and a re-run analysis no longer reports resident-only coverage.
 *
 * The in-repo EPT fixture has a root and four child tiles. Each spec holds the
 * children back, so the scan stays partial for as long as it needs, then lets
 * them in.
 */

const PARTIAL = 'coverage: resident-only';

/** Open the EPT fixture with its children held; resolves once the root is resident. */
async function openPartialStream(page: Page): Promise<() => void> {
  const { release } = await routeEptFixture(page, { holdChildren: true });
  await page.goto('/?test=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  await openEptFixture(page);
  const panel = page.locator('.olv-streaming-panel');
  await expect(panel).toBeVisible({ timeout: 30_000 });
  await expect(panel).toContainText(`1 / ${EPT_FIXTURE_NODES} requested nodes resident`, {
    timeout: 30_000,
  });
  return release;
}

async function expectFullyResident(page: Page): Promise<void> {
  await expect(page.locator('.olv-streaming-panel')).toContainText(
    `${EPT_FIXTURE_NODES} / ${EPT_FIXTURE_NODES} requested nodes resident`,
    { timeout: 30_000 },
  );
}

test.describe('streaming caveats', () => {
  test('the terrain analysis is resident-only until every node is resident', async ({ page }) => {
    // A terrain run over the whole fixture takes several seconds on a
    // software renderer, and this test runs two.
    test.setTimeout(300_000);
    const release = await openPartialStream(page);
    // Open the Terrain page, where the Analyse panel lives. Scan routing can
    // settle after the first attempt, so retry until the panel is on screen.
    await expect(async () => {
      await openAnalysePanel(page);
    }).toPass({ timeout: 30_000 });

    const verdict = page.locator('.olv-fit-verdict-text');
    await page.locator('.olv-analyse-run').click();
    await expect(verdict).toBeVisible({ timeout: 120_000 });
    // The DEM caveat sits on the Contours page, under Terrain; the Analyse mode
    // host holds both pages, as the one panel used to.
    const analyseMode = page.locator('#olv-ws-mode-analyse');
    await expect(analyseMode).toContainText(PARTIAL, { timeout: 120_000 });

    release();
    await expectFullyResident(page);
    const run = page.locator('.olv-analyse-run');
    await expect(run).toHaveText('Re-run analysis', { timeout: 120_000 });
    await run.click();
    await expect(page.locator('.olv-analyse-panel')).not.toContainText('resident-only', { timeout: 120_000 });
    await expect(page.locator('.olv-analyse-dem-note', { hasText: 'resident-only' })).toHaveCount(0);
    await expect(run).toHaveText('Re-run analysis');
    await expect(verdict).toBeVisible();
  });

  test('a Profile carries the resident-only caption until every node is resident', async ({ page }) => {
    const release = await openPartialStream(page);

    await page.locator('.olv-tool', { hasText: 'Measure' }).click();
    await expect(page.locator('.olv-measure-bar')).toBeVisible();
    await page.evaluate(() => {
      const api = (window as unknown as { __OLV_TEST_API__?: MeasureTestApi }).__OLV_TEST_API__;
      if (!api) throw new Error('__OLV_TEST_API__ not mounted, was ?test=1 set?');
      api.setMeasureKind('profile');
      // The fixture is 100 m square, centred on the render origin.
      api.placeMeasurementPoint({ x: -40, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 40, y: 0, z: 0 });
      api.finishMeasurement?.();
    });

    const caveat = page.locator('.olv-mp-chart-caveat').first();
    await expect(caveat).toBeVisible({ timeout: 15_000 });
    await expect(caveat).toContainText('Resident-node analysis only');

    // Once every node is resident the profile is re-sampled over the whole
    // stream and the caption goes away.
    release();
    await expectFullyResident(page);
    await expect(page.locator('.olv-mp-row')).toHaveCount(1);
    await expect(page.locator('.olv-mp-chart-caveat')).toHaveCount(0, { timeout: 15_000 });
  });
});
