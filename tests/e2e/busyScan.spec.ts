import { test, expect } from '@playwright/test';
import { dropDenseGridPly, openAnalysePanel } from './helpers';

/**
 * Busy scan: the waiting indicator shown while Run terrain analysis computes.
 *
 * The run can finish in a few frames, so a MutationObserver installed before
 * the click records the moment the indicator mounts, and measures the layout
 * right then: the status line and the Run button must be the same height with
 * the indicator as without it. After the run it must be gone.
 */

interface BusyProbe {
  seen: boolean;
  ariaHidden: string | null;
  statusWith: number;
  statusWithout: number;
  runBefore: number;
  runDuring: number;
}

test('the busy scan shows during Run terrain analysis and is gone after, with no layout jump', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalysePanel(page);

  await page.evaluate(() => {
    const w = window as unknown as { __busyProbe: BusyProbe };
    const run = document.querySelector<HTMLElement>('.olv-analyse-run')!;
    const probe: BusyProbe = {
      seen: false, ariaHidden: null, statusWith: 0, statusWithout: 0,
      runBefore: run.getBoundingClientRect().height, runDuring: 0,
    };
    w.__busyProbe = probe;
    const obs = new MutationObserver(() => {
      const scan = document.querySelector<SVGElement>('.olv-analyse-status .olv-busy-scan');
      if (!scan || probe.seen) return;
      probe.seen = true;
      probe.ariaHidden = scan.getAttribute('aria-hidden');
      const status = scan.parentElement!;
      probe.statusWith = status.getBoundingClientRect().height;
      probe.runDuring = run.getBoundingClientRect().height;
      scan.style.display = 'none';
      probe.statusWithout = status.getBoundingClientRect().height;
      scan.style.display = '';
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });

  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });

  const probe = await page.evaluate(() => (window as unknown as { __busyProbe: BusyProbe }).__busyProbe);
  expect(probe.seen, 'the indicator mounted while the run computed').toBe(true);
  expect(probe.ariaHidden).toBe('true');
  expect(probe.statusWith).toBeGreaterThan(0);
  expect(Math.abs(probe.statusWith - probe.statusWithout)).toBeLessThan(0.5);
  expect(Math.abs(probe.runDuring - probe.runBefore)).toBeLessThan(0.5);
  await expect(page.locator('.olv-busy-scan')).toHaveCount(0);
});

test('under reduced motion the busy scan is static', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalysePanel(page);

  await page.evaluate(() => {
    const w = window as unknown as { __busyStatic: string[] | null };
    w.__busyStatic = null;
    const obs = new MutationObserver(() => {
      const scan = document.querySelector('.olv-analyse-status .olv-busy-scan');
      if (!scan || w.__busyStatic) return;
      const pt = scan.querySelector('.olv-busy-scan-pt')!;
      const beam = scan.querySelector('.olv-busy-scan-beam')!;
      w.__busyStatic = [
        getComputedStyle(pt).animationName, getComputedStyle(pt).opacity,
        getComputedStyle(beam).animationName, getComputedStyle(beam).opacity,
      ];
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });
  const got = await page.evaluate(() => (window as unknown as { __busyStatic: string[] | null }).__busyStatic);
  expect(got).toEqual(['none', '1', 'none', '0']);
  await expect(page.locator('.olv-busy-scan')).toHaveCount(0);
});
