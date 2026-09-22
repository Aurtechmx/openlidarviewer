/**
 * hudCollision.spec.ts: the top-centre lane holds one surface, clear of the rails.
 *
 * Five transient surfaces share one band across the top of the canvas: the
 * progress toast, the "Project ready" card, the recommended-view chip, and the
 * measure and annotation hints. They were positioned independently, in five
 * files, at four different offsets, and two of them were raised together on
 * every scan open, so the chip covered the card for the card's whole life.
 *
 * Run at every configured width (playwright.widths.config.ts), because a lane
 * that reads clear on a 1440px desktop is the same lane that runs into the
 * panel rails at 1024 and into the notch on a 320px phone. Two claims:
 *
 *   1. at most one lane surface is on screen at a time, and
 *   2. whichever one is up sits in the free band between the panel rails.
 *
 * The second claim is conditional on there BEING a free band: the two rails are
 * about 285px each and sit 14px in from each edge, so the gap between them is
 * the viewport width less about 601px. The card narrows to that gap down to a
 * 200px floor, so it clears both rails from about 800px up. From 768px (where
 * the desktop layer starts) to there, no placement of a readable card clears
 * both. Measured rather than assumed (the gap is read from the rails' own
 * boxes), and where it is too narrow the surface must still fall inside the
 * viewport.
 *
 * "On screen" here means laid out AND painted: the project card is always in
 * the DOM at opacity 0, which Playwright counts as visible, so the check reads
 * computed opacity and visibility rather than trusting the box alone.
 */
import { test, expect, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../fixtures/multichunk.laz', import.meta.url));

/** The surfaces that share the top-centre lane. */
const LANE = ['.olv-project-card', '.olv-rvc', '.olv-measure-hint', '.olv-toast'];
/** The two panel columns the lane must stay out of. */
const RAILS = ['.olv-left-panels', '.olv-right-rail'];

interface Box { x: number; y: number; w: number; h: number }
interface Placed { sel: string; box: Box }
interface Seen { painted: Placed[]; rails: Placed[]; viewport: number }

/** What is actually painted right now, with its box, for both groups. */
async function survey(page: Page): Promise<Seen> {
  return page.evaluate(([lane, rails]) => {
    const painted = (sel: string): { sel: string; box: Box } | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.05) return null;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return null;
      return { sel, box: { x: r.x, y: r.y, w: r.width, h: r.height } };
    };
    const pick = (list: string[]) => list.map(painted).filter((v): v is { sel: string; box: Box } => v !== null);
    return { painted: pick(lane), rails: pick(rails), viewport: window.innerWidth };
  }, [LANE, RAILS] as const) as Promise<Seen>;
}

/** The horizontal band the rails leave free, read from their own boxes. */
function freeBand(seen: Seen): { left: number; right: number } {
  const mid = seen.viewport / 2;
  let left = 0;
  let right = seen.viewport;
  for (const rail of seen.rails) {
    const railMid = rail.box.x + rail.box.w / 2;
    if (railMid < mid) left = Math.max(left, rail.box.x + rail.box.w);
    else right = Math.min(right, rail.box.x);
  }
  return { left, right };
}

function assertLaneIsSane(seen: Seen, when: string): void {
  const up = seen.painted.map((p) => p.sel);
  expect(up.length, `${when}: lane surfaces up at once: ${up.join(', ')}`).toBeLessThanOrEqual(1);
  const band = freeBand(seen);
  for (const p of seen.painted) {
    const { x, w } = p.box;
    // A one-pixel touch at a shared edge is not a collision; allow it.
    if (w <= band.right - band.left) {
      expect(x, `${when}: ${p.sel} runs under the left rail`).toBeGreaterThanOrEqual(band.left - 1);
      expect(x + w, `${when}: ${p.sel} runs under the right rail`).toBeLessThanOrEqual(band.right + 1);
    } else {
      // No placement clears both rails at this width; it must at least be whole.
      expect(x, `${when}: ${p.sel} starts off-screen`).toBeGreaterThanOrEqual(-1);
      expect(x + w, `${when}: ${p.sel} runs off-screen`).toBeLessThanOrEqual(seen.viewport + 1);
    }
  }
}

test.describe('top-centre lane', () => {
  // A cold decode of the fixture can take most of a minute on a CI runner, and
  // this test then drives a handoff on the far side of it.
  test.slow();

  test('holds one surface at a time and clears the panel rails', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.olv-empty-title')).toBeVisible();
    await page.locator('.olv-file-input').first().setInputFiles(FIXTURE);
    // Wait on the card rather than on the empty state clearing: the card is
    // raised as soon as the scan opens, several seconds before the empty state
    // finishes getting out of the way, and the card only lives for seven. The
    // decode is pooled off-thread and takes longer on CI than the default wait.
    const card = page.locator('.olv-project-card');
    await expect(card).toHaveClass(/olv-visible/, { timeout: 60_000 });

    // The moment the "Project ready" card and the recommended-view chip used to
    // be raised together.
    assertLaneIsSane(await survey(page), 'on open');

    // Then hand the lane over. Pressing × is the deterministic half of the
    // card's contract; its own 7 s timer takes the identical path, so the click
    // is allowed to find the card already gone.
    await page.locator('.olv-pc-dismiss').click({ timeout: 5_000 }).catch(() => {});
    // The successor takes the lane it was waiting for.
    await expect(page.locator('.olv-rvc')).not.toHaveClass(/olv-hidden/, { timeout: 30_000 });
    // Let the card's 240ms fade-out finish before the snapshot: it is allowed
    // to cross-fade under the incoming chip, and a crossfade is not a
    // collision. The chip auto-hides nine seconds later; a snapshot taken after
    // that finds an empty lane, which satisfies the claims the same way.
    await page.waitForTimeout(500);
    assertLaneIsSane(await survey(page), 'after the card yields');
  });
});
