import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import { dropDenseGridPly, showWorkspaceMode, railChromeSettled, expectHittable } from './helpers';

/**
 * v0.7 accessibility-audit fixes (fe/aria lane): keyboard/focus/visible-state
 * coverage for the ARIA wiring added across StreamingPanel, CatalogPanel,
 * ClipPanel, reclassifyUi and ExportPanel's format/CRS pills. The DOM-free
 * behaviour (attribute flips on every code path, including the ones no UI
 * click reaches, like ClipPanel.setState) is pinned by the sibling vitest
 * files (streamingPanelAria, clipPanelAria, reclassifyUiAria,
 * catalogPanelPcSearchAria, exportPanelPillsAria); this spec drives the same
 * controls as a user actually would, in a real browser.
 */

// Same fixture-resolution rule as streaming.spec.ts / streamingCaveat.spec.ts.
const COPC_FILE =
  process.env.OLV_AUTZEN_FIXTURE ??
  new URL('../../autzen-classified.copc.laz', import.meta.url).pathname;
const hasAutzenFixture = fs.existsSync(COPC_FILE);

test.describe('ClipPanel — Inside/Outside mode + readout a11y state', () => {
  test('mode buttons carry aria-pressed and the readout is a live region', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'work');

    const panel = page.locator('.olv-clip-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
      await panel.locator('.olv-panel-head').click();
    }

    const inside = panel.locator('.olv-bc-pill', { hasText: 'Inside' });
    const outside = panel.locator('.olv-bc-pill', { hasText: 'Outside' });
    await expect(inside).toHaveAttribute('aria-pressed', 'true');
    await expect(outside).toHaveAttribute('aria-pressed', 'false');

    await railChromeSettled(page);
    await expectHittable(outside);
    await outside.click();
    await expect(outside).toHaveAttribute('aria-pressed', 'true');
    await expect(inside).toHaveAttribute('aria-pressed', 'false');

    // The "kept of total" readout — a role="status" aria-live="polite" live
    // region from construction, independent of the mode click above.
    const readout = panel.locator('.olv-export-fullres-hint');
    await expect(readout).toHaveAttribute('role', 'status');
    await expect(readout).toHaveAttribute('aria-live', 'polite');
  });
});

test.describe('ExportPanel — format pills a11y state', () => {
  test('the format row exposes aria-pressed and flips it on click', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await showWorkspaceMode(page, 'output');

    const panel = page.locator('.olv-export-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
      await panel.locator('.olv-panel-head').click();
    }

    const las14 = panel.locator('.olv-bc-pill', { hasText: 'LAS 1.4' });
    const xyz = panel.locator('.olv-bc-pill', { hasText: 'XYZ' });
    await expect(las14).toHaveAttribute('aria-pressed', 'true');
    await expect(xyz).toHaveAttribute('aria-pressed', 'false');

    await xyz.click();
    await expect(xyz).toHaveAttribute('aria-pressed', 'true');
    await expect(las14).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('reclassifyUi — lasso-arm toggle a11y state', () => {
  test('aria-pressed follows the armed/disarmed state across two clicks', async ({ page }) => {
    await page.goto('/?test=1');
    await dropDenseGridPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

    await page.evaluate(async () => {
      const api = (
        window as unknown as {
          __OLV_TEST_API__: {
            seedUniformClass: (cls: number) => number;
            showReclassify: () => Promise<void>;
          };
        }
      ).__OLV_TEST_API__;
      api.seedUniformClass(1);
      await api.showReclassify();
    });

    const armBtn = page.locator('[data-testid="reclass-arm"]');
    await expect(armBtn).toBeAttached({ timeout: 10_000 });
    await expect(armBtn).toHaveAttribute('aria-pressed', 'false');

    await railChromeSettled(page);
    await expectHittable(armBtn);
    await armBtn.click();
    await expect(armBtn).toHaveAttribute('aria-pressed', 'true');
    await expect(armBtn).toHaveClass(/olv-mkind-active/);

    await armBtn.click();
    await expect(armBtn).toHaveAttribute('aria-pressed', 'false');
    await expect(armBtn).not.toHaveClass(/olv-mkind-active/);
  });
});

test.describe('CatalogPanel — PC-search status is a live region', () => {
  test('the "Search by location" status line carries role=status aria-live=polite', async ({ page }) => {
    await page.goto('/?test=1');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    const details = page.locator('.olv-pc-search-disclosure');
    await details.locator('summary').click();
    const status = details.locator('.olv-catalog-status');
    await expect(status).toHaveAttribute('role', 'status');
    await expect(status).toHaveAttribute('aria-live', 'polite');

    // A real (synchronous, no-network) path into the live node: submitting
    // with both coordinate fields empty writes the app's own guard message.
    // (An out-of-range value is also guarded in source, but the inputs carry
    // native HTML5 min/max, so a real click never dispatches `submit` for
    // one — that branch is DOM-free-unit-tested in
    // catalogPanelPcSearchAria.test.ts instead.)
    await details.getByRole('button', { name: 'Search' }).click();
    await expect(status).toHaveText('Enter a numeric latitude and longitude.');
  });
});

test.describe('StreamingPanel — collapse toggle, chip and grade-result a11y state (autzen COPC required)', () => {
  test.skip(!hasAutzenFixture, `requires the autzen COPC fixture at ${COPC_FILE}`);
  test.slow();

  test('collapse toggle, colour-mode chips and the grade-result live region', async ({ page }) => {
    await page.goto('/?test=1');
    await expect(page.locator('.olv-empty-title')).toBeVisible();

    await page.locator('.olv-file-input').first().setInputFiles(COPC_FILE);
    const panel = page.locator('.olv-streaming-panel');
    await expect(panel).toBeVisible({ timeout: 60_000 });

    // The grade-result region is a live region from construction, before any
    // grade has run.
    const gradeResult = panel.locator('.olv-streaming-grade-result');
    await expect(gradeResult).toHaveAttribute('role', 'status');
    await expect(gradeResult).toHaveAttribute('aria-live', 'polite');

    // A colour-mode chip carries aria-pressed and flips it on click — pick
    // whichever chip is NOT already active, so the assertion holds regardless
    // of which modes this scan's source declares.
    const chips = panel.locator('.olv-streaming-chips .olv-chip');
    await expect(chips.first()).toHaveAttribute('aria-pressed', /true|false/, { timeout: 20_000 });
    const inactive = chips.filter({ hasNot: page.locator('[aria-pressed="true"]') }).first();
    await inactive.click();
    await expect(inactive).toHaveAttribute('aria-pressed', 'true');

    // The mobile collapse chevron: aria-expanded=true/label "Collapse panel"
    // at rest, and it flips on click. It is a real <button> the whole time —
    // CSS only hides it above the 767px breakpoint (83-mobile-audit.css), and
    // this desktop-width session's boot-time mobile/desktop layout split
    // (owned by main.ts, outside this lane) does not reliably re-derive from
    // a mid-test viewport resize, and a `display:none` element has no click
    // point even with `force: true`. `dispatchEvent('click')` fires the same
    // native click event the button's own listener reacts to (the same
    // listener a phone tap would trigger), so it exercises the exact code
    // under test without depending on that layout branch.
    const collapseBtn = panel.locator('.olv-collapse-toggle');
    await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseBtn).toHaveAttribute('aria-label', 'Collapse panel');

    await collapseBtn.dispatchEvent('click');
    await expect(collapseBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(collapseBtn).toHaveAttribute('aria-label', 'Expand panel');
    await expect(panel).toHaveClass(/olv-collapsed/);

    await collapseBtn.dispatchEvent('click');
    await expect(collapseBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(collapseBtn).toHaveAttribute('aria-label', 'Collapse panel');
    await expect(panel).not.toHaveClass(/olv-collapsed/);
  });
});
