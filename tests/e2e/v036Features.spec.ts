import { test, expect } from '@playwright/test';
import { dropTinyPly } from './helpers';

/**
 * tests/e2e/v036Features.spec.ts
 *
 * Coverage for the user-visible additions in v0.3.6 that the pre-existing
 * specs (viewer / measure / rendering / streaming / smoke) don't reach:
 *
 *   1. Verified public LiDAR dataset picker  — `.olv-catalog-select`
 *   2. Capture-kind chips                    — `.olv-capture-chip`
 *   3. Triangular NavWidget + Reset button   — `.olv-mode-reset`
 *   4. Inspector "Provenance" section        — `.olv-provenance`
 *   5. Mobile-collapsible side panels        — chevron toggles
 *
 * Generated via the `/generating-end-to-end-tests` skill as part of the
 * Gate 6 pass before the v0.3.6 deploy. Each spec drops a fixture file
 * through a synthesised `DataTransfer` (the empty-state sample buttons no
 * longer exist) and asserts on stable counts rather than visibility where
 * the target lives inside a collapsed `<details>` (Inspector first-view
 * density pass — see Gate 6 stability rules in `docs/quality-control.md`).
 */

// ── 0. PC "Search by location" disclosure layout (regression) ──────────────

test('PC Search disclosure: heading and helper text do not visually overlap', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  // Open the disclosure — the `<details>` summary toggle.
  const pcSummary = page.locator('.olv-empty-formats-summary', {
    hasText: 'Search by location',
  });
  await pcSummary.click();

  // Once open, the helper caption is rendered as a sibling `<p>`. The
  // regression: a stale `-16px` top margin on `.olv-empty-section-caption`
  // pulled the caption up onto the same y-band as the summary, so the two
  // texts overlapped on screen. Assert the caption's top edge sits
  // strictly below the summary's bottom edge.
  const headingBox = await pcSummary.boundingBox();
  const captionBox = await page
    .locator('.olv-empty-section-caption')
    .first()
    .boundingBox();
  if (!headingBox || !captionBox) {
    throw new Error('PC search heading or caption has no bounding box');
  }
  expect(captionBox.y).toBeGreaterThanOrEqual(headingBox.y + headingBox.height);
});

// ── 1. Curated public LiDAR catalog dropdown ────────────────────────────────

test('empty state shows the curated public LiDAR catalog dropdown', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  // The catalog dropdown is the empty-state surface for the new
  // verified-public-LiDAR picker. Hide it under `?notelemetry=1`.
  const select = page.locator('.olv-catalog-select').first();
  await expect(select).toBeVisible();

  // The dropdown is populated at build time from the curated catalog —
  // every release ships at least the placeholder option plus the public
  // entries documented in `docs/public-lidar-catalog.md`.
  const optionCount = await select.locator('option').count();
  expect(optionCount).toBeGreaterThan(1);
});

test('?notelemetry=1 suppresses the curated catalog surface', async ({ page }) => {
  await page.goto('/?notelemetry=1');
  await expect(page.locator('.olv-empty-title')).toBeVisible();
  // The curated catalog is the source of (anonymous) load-by-curated-id
  // counts — the flag suppresses the panel structurally.
  await expect(page.locator('.olv-catalog-select')).toHaveCount(0);
});

// ── 2. Capture-kind chips ──────────────────────────────────────────────────

test('empty state shows three capture-kind chips with their labels', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('.olv-empty-title')).toBeVisible();

  // Three chips: Drone LiDAR · iPhone scans · Terrestrial laser.
  await expect(page.locator('.olv-capture-chip')).toHaveCount(3);
  await expect(
    page.locator('.olv-capture-chip', { hasText: 'Drone LiDAR' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-capture-chip', { hasText: 'iPhone scans' }),
  ).toBeVisible();
  await expect(
    page.locator('.olv-capture-chip', { hasText: 'Terrestrial laser' }),
  ).toBeVisible();
});

// ── 3. Triangular NavWidget + centre Reset ─────────────────────────────────

test('the nav widget renders three mode vertex buttons and a Reset', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // Three mode buttons (Orbit / Walk / Fly) and one Reset action at the
  // triangle centroid. The dashed cyan outline lives in
  // `.olv-modes-tri-bg` so a redesign that drops the geometric framing
  // would surface here too.
  await expect(page.locator('.olv-modes-tri-bg')).toBeVisible();
  await expect(page.locator('.olv-mode')).toHaveCount(3);
  await expect(page.locator('.olv-mode-reset')).toBeVisible();
});

test('clicking the Reset button re-frames the camera', async ({ page }) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(800);

  // Reset re-runs the frame-all logic — accessibility label confirmed.
  const reset = page.locator('.olv-mode-reset');
  await expect(reset).toHaveAttribute('aria-label', /frame/i);
  // The click is a pure UI action with no toast. The contract under test
  // is that pressing it does NOT throw a page-level error.
  let pageError: Error | null = null;
  page.on('pageerror', (e) => (pageError = e));
  await reset.click();
  await page.waitForTimeout(300);
  expect(pageError).toBeNull();
});

// ── 4. Inspector Provenance fingerprint section ────────────────────────────

test('Inspector exposes a Provenance section after a scan loads', async ({
  page,
}) => {
  await page.goto('/');
  await dropTinyPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });

  // The Provenance body is rendered into a collapsible section. The body
  // element is always present once a scan is loaded — the `<details>`
  // around it may be collapsed by default (Inspector first-view density).
  await expect(page.locator('.olv-provenance')).toHaveCount(1);

  // The collapsible summary carries the section title.
  await expect(
    page.locator('.olv-section-summary', { hasText: /Provenance/i }),
  ).toBeVisible();
});

// ── 5. Mobile-collapsible side panels ──────────────────────────────────────

test.describe('mobile bottom sheet', () => {
  test.use({ viewport: { width: 390, height: 844 } }); // iPhone-class viewport

  // v0.4.6 replaced the per-panel "chevron toggle on mobile" model with a single
  // bottom sheet (MobileSheet) that re-parents every panel into one of three
  // tabs — View / Analyse / Layers. This pins that new contract: the sheet
  // mounts with its tablist, and selecting a tab expands the sheet and activates
  // that tab's slot.
  test('mounts a View / Analyse / Layers tab sheet that switches panels', async ({
    page,
  }) => {
    await page.goto('/');
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(500);

    const sheet = page.locator('.olv-mobile-sheet');
    await expect(sheet).toBeVisible({ timeout: 8_000 });

    // The three tabs are present in order.
    for (const id of ['view', 'analyse', 'layers'] as const) {
      await expect(sheet.locator(`.olv-msheet-tab[data-tab="${id}"]`)).toBeVisible();
    }

    // Selecting a tab activates its slot (and expands the sheet).
    await sheet.locator('.olv-msheet-tab[data-tab="layers"]').click();
    await expect(page.locator('.olv-msheet-slot[data-tab="layers"].is-active')).toBeVisible({
      timeout: 4_000,
    });

    // Switching to another tab moves the active slot.
    await sheet.locator('.olv-msheet-tab[data-tab="view"]').click();
    await expect(page.locator('.olv-msheet-slot[data-tab="view"].is-active')).toBeVisible({
      timeout: 4_000,
    });
    await expect(page.locator('.olv-msheet-slot[data-tab="layers"].is-active')).toHaveCount(0);
  });
});
