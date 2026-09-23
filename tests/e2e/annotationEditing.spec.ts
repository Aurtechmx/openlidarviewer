import { test, expect, type Page, type Locator } from '@playwright/test';
import { dropDenseGridPly, showWorkspaceMode } from './helpers';

/**
 * Annotation editing acceptance flows — the AnnotationPanel / AnnotationEditor
 * / AnnotationController accessibility and data-safety fixes from the fe-
 * annotations lane of the v0.7.0 audit. This file grows with each fix; today
 * it covers:
 *
 *   - a panel action (delete, resolve/reopen, activate) restores keyboard
 *     focus to the equivalent control instead of stranding it on <body>;
 *   - the panel's mobile collapse toggle announces its expanded state and
 *     swaps its label.
 *
 * Placement goes through a real canvas click (no `?test=1` seam exists for
 * annotate — that flag only wires measurement placement). The dense-grid
 * fixture exists precisely so a centre-of-canvas click lands a raycast hit
 * (see `dropDenseGridPly`'s own doc comment); `placeAnnotation` below retries
 * at a couple of nearby points to absorb the rare miss without depending on
 * an exact pixel.
 */

const WIDE = { width: 1440, height: 900 };

/** Load the dense fixture and arm the Annotate tool. */
async function loadSampleAndAnnotate(page: Page): Promise<void> {
  await page.setViewportSize(WIDE);
  await page.goto('/');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  // Let the framing tween settle so canvas clicks land on the cloud.
  await page.waitForTimeout(1500);
  await page.locator('.olv-tool', { hasText: 'Annotate' }).click();
  await showWorkspaceMode(page, 'work');
}

/** A handful of screen-fraction points around the canvas centre, each a
 * plausible raycast hit against the dense grid once the camera has framed
 * it — tried in order until one opens the editor. */
const CANDIDATE_POINTS: { x: number; y: number }[] = [
  { x: 0.5, y: 0.5 },
  { x: 0.46, y: 0.46 },
  { x: 0.54, y: 0.54 },
  { x: 0.5, y: 0.42 },
  { x: 0.5, y: 0.58 },
];

/** Click the canvas until the editor opens (a miss just reports "no point
 * there" and leaves nothing open), trying a few nearby fractional points. */
async function openEditorNear(page: Page, offset = 0): Promise<void> {
  const canvas = page.locator('canvas').first();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('scene canvas has no bounding box');
  const editor = page.locator('.olv-anno-editor');
  for (let i = 0; i < CANDIDATE_POINTS.length; i++) {
    const p = CANDIDATE_POINTS[(i + offset) % CANDIDATE_POINTS.length];
    await page.mouse.click(box.x + box.width * p.x, box.y + box.height * p.y);
    try {
      await expect(editor).toBeVisible({ timeout: 2_000 });
      return;
    } catch {
      // Missed the cloud (or landed back on an existing marker) — try the
      // next candidate point.
    }
  }
  throw new Error('no candidate canvas point opened the annotation editor');
}

/** Open the editor near a fresh point, fill it in and save. `offset` picks a
 * different candidate point so successive calls land distinct annotations
 * rather than re-selecting the same marker. */
async function placeAnnotation(
  page: Page,
  opts: { title: string; severity?: 'low' | 'medium' | 'high' | 'critical'; offset?: number },
): Promise<void> {
  await openEditorNear(page, opts.offset ?? 0);
  await page.locator('.olv-anno-editor-title').fill(opts.title);
  if (opts.severity) {
    await page.locator(`.olv-anno-sev-${opts.severity}`).click();
  }
  await page.locator('.olv-anno-editor-save').click();
  await expect(page.locator('.olv-anno-editor')).toBeHidden();
}

/** The row for a given title, scoped under the Annotations panel. */
function rowFor(page: Page, title: string): Locator {
  return page
    .locator('.olv-anno-panel .olv-ap-row')
    .filter({ has: page.locator('.olv-ap-name', { hasText: title }) });
}

test.describe('AnnotationPanel — focus survives a row action', () => {
  test('deleting the focused row lands focus back inside the panel, not on <body>', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'First', offset: 0 });
    await placeAnnotation(page, { title: 'Second', offset: 1 });

    const row = rowFor(page, 'First');
    await expect(row).toBeVisible();
    const del = row.locator('.olv-ap-del');
    await del.focus();
    await expect(del).toBeFocused();
    await page.keyboard.press('Enter');

    // The row (and its Delete button) is gone — the old bug left focus on
    // <body> here, which a screen-reader/keyboard user cannot recover from
    // without re-Tabbing from the top of the page.
    await expect(rowFor(page, 'First')).toHaveCount(0);
    const stillOnBody = await page.evaluate(() => document.activeElement === document.body);
    expect(stillOnBody).toBe(false);
    // Lands inside the panel specifically (its landmark head, since the
    // acted-on row no longer exists to refocus).
    const focusedInPanel = await page.evaluate(() =>
      document.activeElement?.closest('.olv-anno-panel') !== null,
    );
    expect(focusedInPanel).toBe(true);
  });

  test('resolving an issue keeps focus off <body>', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Leak at joint', severity: 'high', offset: 0 });

    const row = rowFor(page, 'Leak at joint');
    const resolveBtn = row.locator('.olv-ap-issue-status');
    await expect(resolveBtn).toHaveText('Resolve');
    await resolveBtn.focus();
    await page.keyboard.press('Enter');

    const stillOnBody = await page.evaluate(() => document.activeElement === document.body);
    expect(stillOnBody).toBe(false);
  });

  test('activating (jumping to) a row keeps focus on its own title button', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Anchor point', offset: 0 });

    const row = rowFor(page, 'Anchor point');
    const title = row.locator('.olv-ap-name');
    await title.focus();
    await page.keyboard.press('Enter');

    // The row survives selection (it is not removed), so focus returns to
    // the SAME control rather than merely somewhere safe.
    await expect(rowFor(page, 'Anchor point').locator('.olv-ap-name')).toBeFocused();
  });
});

test.describe('AnnotationPanel — mobile collapse toggle', () => {
  test('aria-expanded and the label flip with the collapsed state', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Mobile check', offset: 0 });

    await page.setViewportSize({ width: 390, height: 844 });
    // Below the mobile breakpoint the panel is re-parented (live, listeners
    // and all) into the bottom sheet's "Layers" tab (MobileSheet.ts) instead
    // of the desktop left column; the sheet opens on "Analyse" and collapsed
    // to "peek" by default, so it has to be selected before its content is
    // actually visible rather than merely present in the DOM.
    await page.locator('#olv-msheet-tab-layers').click();
    const toggle = page.locator('.olv-anno-panel .olv-collapse-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-label', 'Collapse panel');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-label', 'Expand panel');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-label', 'Collapse panel');
  });
});
