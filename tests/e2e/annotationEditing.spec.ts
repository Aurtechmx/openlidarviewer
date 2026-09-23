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
 *   - opening the editor over an unsaved, dirty draft asks before discarding
 *     it, rather than silently overwriting it — and so do leaving the tool
 *     and undoing/redoing while a dirty draft is still open;
 *   - the editor carries real dialog semantics (role, aria-labelledby) and
 *     traps Tab, so a stray Tab-then-Escape can no longer exit the whole
 *     annotate tool; it does NOT claim aria-modal, since unlike every other
 *     dialog in the app it has no backdrop and does not block the rest of
 *     the page;
 *   - the type chips expose aria-pressed, matching the severity/status chips
 *     beside them;
 *   - the panel's mobile collapse toggle announces its expanded state and
 *     swaps its label;
 *   - the editor re-clamps itself inside a short viewport instead of
 *     rendering off-screen with no scroll to recover it;
 *   - keyboard focus on a row highlights its marker, matching mouse hover.
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

  test('activating (jumping to) a row that is not already selected keeps focus on its own title button', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'First', offset: 0 });
    await placeAnnotation(page, { title: 'Second', offset: 1 });

    // "Second" (placed last) is the current selection. Activating "First"
    // here has to actually move the selection and rebuild the list — that
    // rebuild is what exercises the focus capture/restore this test guards.
    // Activating the row that is ALREADY selected is a same-id no-op inside
    // AnnotationController.select (it early-returns before any rebuild), so
    // it would pass here whether or not focus restoration actually works.
    const row = rowFor(page, 'First');
    const title = row.locator('.olv-ap-name');
    await title.focus();
    await page.keyboard.press('Enter');

    // The row survives selection (it is not removed), so focus returns to
    // the SAME control rather than merely somewhere safe.
    await expect(rowFor(page, 'First').locator('.olv-ap-name')).toBeFocused();
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

test.describe('AnnotationController — reopening over an unsaved draft', () => {
  test('editing another annotation over a dirty draft asks before discarding it', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Saved one', offset: 0 });

    // Start a second, NEW draft and type into it without saving.
    await openEditorNear(page, 1);
    await page.locator('.olv-anno-editor-title').fill('UNSAVED DRAFT');

    // Ask the panel to edit the already-saved annotation instead.
    await rowFor(page, 'Saved one').locator('.olv-ap-edit').click();

    // A confirm dialog interrupts instead of silently swapping the draft.
    const dialog = page.locator('.olv-modal[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('unsaved changes');

    // "Keep editing" leaves the dirty draft exactly as it was.
    await page.locator('.olv-confirm-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.olv-anno-editor-title')).toHaveValue('UNSAVED DRAFT');

    // Asking again and discarding this time really does switch to the edit.
    await rowFor(page, 'Saved one').locator('.olv-ap-edit').click();
    await expect(dialog).toBeVisible();
    await page.locator('.olv-confirm-ok').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.olv-anno-editor-title')).toHaveValue('Saved one');
  });

  test('reopening a pristine (untouched) draft needs no confirmation', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Saved two', offset: 0 });

    // Open a second draft but leave it exactly as it opened — nothing to lose.
    await openEditorNear(page, 1);
    await expect(page.locator('.olv-anno-editor')).toBeVisible();

    await rowFor(page, 'Saved two').locator('.olv-ap-edit').click();
    await expect(page.locator('.olv-modal[role="dialog"]')).toHaveCount(0);
    await expect(page.locator('.olv-anno-editor-title')).toHaveValue('Saved two');
  });
});

test.describe('AnnotationController — leaving the tool over an unsaved draft', () => {
  test('turning the tool off with a dirty draft open asks, and "Keep editing" leaves it open', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await openEditorNear(page, 0);
    await page.locator('.olv-anno-editor-title').fill('UNSAVED ON TOOL OFF');

    // Toggling the Annotate tool button off is what calls
    // AnnotationController.setActive(false).
    await page.locator('.olv-tool', { hasText: 'Annotate' }).click();

    // Not silently dropped — the card is still open, behind a confirm.
    const dialog = page.locator('.olv-modal[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('unsaved changes');
    await expect(page.locator('.olv-anno-editor')).toBeVisible();

    await page.locator('.olv-confirm-cancel').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.olv-anno-editor-title')).toHaveValue('UNSAVED ON TOOL OFF');
  });

  test('turning the tool off with a dirty draft open, and discarding, closes the card', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await openEditorNear(page, 0);
    await page.locator('.olv-anno-editor-title').fill('DISCARD ON TOOL OFF');

    await page.locator('.olv-tool', { hasText: 'Annotate' }).click();

    const dialog = page.locator('.olv-modal[role="dialog"]');
    await expect(dialog).toBeVisible();
    await page.locator('.olv-confirm-ok').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.olv-anno-editor')).toBeHidden();
  });
});

test.describe('AnnotationController — undo over an unsaved draft', () => {
  test('undo with a dirty draft open asks before discarding it', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Undo target', offset: 0 });

    await openEditorNear(page, 1);
    await page.locator('.olv-anno-editor-title').fill('UNSAVED BEFORE UNDO');
    // Move focus off the text field first — the global undo shortcut is
    // suppressed while a text input holds focus (so a keystroke meant for
    // the title is never read as a shortcut); clicking a type chip both
    // moves focus to a button and further dirties the draft.
    const chips = page.locator('.olv-anno-editor-types .olv-anno-chip');
    await chips.filter({ hasText: 'Warning' }).click();

    await page.keyboard.press('ControlOrMeta+KeyZ');

    const dialog = page.locator('.olv-modal[role="dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('unsaved changes');
    // Not silently dropped — the draft is still open, and the earlier
    // annotation has not actually been undone yet.
    await expect(page.locator('.olv-anno-editor')).toBeVisible();
    await expect(rowFor(page, 'Undo target')).toHaveCount(1);

    await page.locator('.olv-confirm-ok').click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.olv-anno-editor')).toBeHidden();
    await expect(rowFor(page, 'Undo target')).toHaveCount(0);
  });
});

test.describe('AnnotationEditor — dialog semantics and focus trap', () => {
  test('carries dialog role/aria-labelledby naming its heading, and no false aria-modal', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await openEditorNear(page, 0);

    const editor = page.locator('.olv-anno-editor');
    await expect(editor).toHaveAttribute('role', 'dialog');
    // No backdrop blocks the rest of the page, so this card must not claim
    // aria-modal — that would tell assistive tech the background is inert
    // when it is not.
    expect(await editor.getAttribute('aria-modal')).toBeNull();
    const labelledBy = await editor.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = page.locator(`#${labelledBy}`);
    await expect(heading).toHaveText('New annotation');
  });

  test('Tab cannot leave the card, and Escape only closes the card, not the whole tool', async ({
    page,
  }) => {
    await loadSampleAndAnnotate(page);
    await openEditorNear(page, 0);

    // Tab well past the last control (Save) — a real trap cycles back inside
    // instead of handing focus to the rest of the page.
    for (let i = 0; i < 14; i++) await page.keyboard.press('Tab');
    const stillInside = await page.evaluate(() =>
      document.querySelector('.olv-anno-editor')?.contains(document.activeElement) === true,
    );
    expect(stillInside).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.locator('.olv-anno-editor')).toBeHidden();
    // The whole tool is still active — its `aria-pressed` (the dock's own
    // canonical toggle-state signal) survives, unlike the old bug where a
    // stray Tab handed Escape to the window listener and exited annotate
    // mode entirely.
    await expect(page.locator('.olv-tool', { hasText: 'Annotate' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

test.describe('AnnotationEditor — type chips expose aria-pressed', () => {
  test('exactly one type chip is aria-pressed, and it follows the click', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await openEditorNear(page, 0);

    const chips = page.locator('.olv-anno-editor-types .olv-anno-chip');
    const noteChip = chips.filter({ hasText: 'Note' });
    const warningChip = chips.filter({ hasText: 'Warning' });
    await expect(noteChip).toHaveAttribute('aria-pressed', 'true');
    await expect(warningChip).toHaveAttribute('aria-pressed', 'false');

    await warningChip.click();
    await expect(warningChip).toHaveAttribute('aria-pressed', 'true');
    await expect(noteChip).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('AnnotationEditor — repositions inside a short viewport', () => {
  test('opening in a short window stays fully on-screen and re-fits as it grows', async ({
    page,
  }) => {
    // Place the annotation at a normal, reliable viewport first (raycast
    // placement, like every other test here) — the short-viewport clamp is
    // exercised by REOPENING it afterward via the panel's own Edit button,
    // which needs no raycast and so isn't sensitive to exactly where the
    // dense grid lands on an oddly narrow-tall canvas.
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Short viewport check', offset: 0 });

    // 390px tall is short enough that the OLD fixed CARD_H=420 guess always
    // clamped `top` to a negative value here regardless of click position
    // (390 - 420 - 8 = -38 < the 8px floor) — the real reproduction case.
    await page.setViewportSize({ width: 844, height: 390 });
    await rowFor(page, 'Short viewport check').locator('.olv-ap-edit').click();

    const editor = page.locator('.olv-anno-editor');
    await expect(editor).toBeVisible();
    const box = await editor.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(390);

    // Marking it a critical issue reveals the status row — a real height
    // change the card has to stay clamped through, not just on first open.
    // Forced: at this deliberately short viewport the (unrelated) elevation
    // colorbar legend can overlap the card's screen position, which is a
    // pre-existing layout fact of this narrow window, not something this
    // click needs to actually be reachable by a pointer to exercise the
    // severity toggle and its resulting reflow.
    await page.locator('.olv-anno-sev-critical').click({ force: true });
    const grown = await editor.boundingBox();
    expect(grown).not.toBeNull();
    expect(grown!.y).toBeGreaterThanOrEqual(0);
    expect(grown!.y + grown!.height).toBeLessThanOrEqual(390);
  });
});

test.describe('AnnotationPanel — keyboard focus previews the marker like hover', () => {
  test('Tabbing onto a row highlights its marker; tabbing off clears it', async ({ page }) => {
    await loadSampleAndAnnotate(page);
    await placeAnnotation(page, { title: 'Marker check', offset: 0 });

    const row = rowFor(page, 'Marker check');
    const id = await row.getAttribute('data-id');
    expect(id).toBeTruthy();
    const marker = page.locator(`.olv-anno-marker[data-aid="${id}"]`);
    await expect(marker).not.toHaveClass(/olv-anno-hover/);

    await row.locator('.olv-ap-name').focus();
    await expect(marker).toHaveClass(/olv-anno-hover/);

    // Moving focus within the SAME row (to Edit) must not flicker the
    // highlight off and back on — it stays highlighted throughout.
    await row.locator('.olv-ap-edit').focus();
    await expect(marker).toHaveClass(/olv-anno-hover/);

    // Tabbing out of the row clears it, just as mouseleave would.
    await page.locator('.olv-ap-search').focus();
    await expect(marker).not.toHaveClass(/olv-anno-hover/);
  });
});
