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
  await expect(page.locator('.olv-analyse-panel .olv-busy-scan')).toHaveCount(0);
});

test('under reduced motion the Analyse emblem is static', async ({ page }) => {
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
      const ring = scan.querySelector('.olv-bse-ring circle:not(.is-front)')!;
      const front = scan.querySelector('.olv-bse-ring circle.is-front')!;
      const core = scan.querySelector('.olv-bse-core')!;
      const axis = scan.querySelector('.olv-bse-axis circle')!;
      w.__busyStatic = [
        getComputedStyle(ring).animationName, getComputedStyle(ring).opacity,
        getComputedStyle(front).animationName, getComputedStyle(front).opacity,
        getComputedStyle(core).animationName, getComputedStyle(core).opacity,
        getComputedStyle(axis).animationName, getComputedStyle(axis).opacity,
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
  expect(got).toEqual(['none', '0.6', 'none', '0.95', 'none', '1', 'none', '0.9']);
  await expect(page.locator('.olv-analyse-panel .olv-busy-scan')).toHaveCount(0);
});

interface EmblemProbe {
  statusEmblem: boolean;
  skeletonEmblem: boolean;
  ariaHidden: string | null;
  running: string[];
  statusText: string;
}

test('while the analysis runs, the emblem waits in the status line and the readiness skeleton, and stops after', async ({ page }) => {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await openAnalysePanel(page);

  await page.evaluate(() => {
    const w = window as unknown as { __emblemProbe: EmblemProbe | null };
    w.__emblemProbe = null;
    const obs = new MutationObserver(() => {
      const scan = document.querySelector<SVGElement>('.olv-analyse-status .olv-busy-scan');
      if (!scan || w.__emblemProbe) return;
      w.__emblemProbe = {
        statusEmblem: scan.classList.contains('olv-busy-scan--emblem'),
        skeletonEmblem: !!document.querySelector('.olv-analyse-ready.is-skeleton .olv-busy-scan--emblem'),
        ariaHidden: scan.getAttribute('aria-hidden'),
        running: [...new Set(scan.getAnimations({ subtree: true }).map((a) => (a as CSSAnimation).animationName))].sort(),
        statusText: scan.parentElement!.textContent ?? '',
      };
      obs.disconnect();
    });
    obs.observe(document.body, { subtree: true, childList: true });
  });
  await page.locator('.olv-analyse-run').click();
  await expect(page.locator('.olv-analyse-readiness .olv-analyse-ready:not(.is-skeleton)')).toHaveCount(3, {
    timeout: 20_000,
  });
  const probe = await page.evaluate(() => (window as unknown as { __emblemProbe: EmblemProbe | null }).__emblemProbe);
  expect(probe, 'the emblem mounted while the run computed').not.toBeNull();
  expect(probe!.statusEmblem).toBe(true);
  expect(probe!.skeletonEmblem).toBe(true);
  expect(probe!.ariaHidden).toBe('true');
  expect(probe!.statusText).toBe('Analysing…');
  expect(probe!.running).toEqual(['olv-bse-axis', 'olv-bse-core', 'olv-bse-orbit', 'olv-bse-orbit-front']);
  // Idle: no emblem left, so nothing of it animates.
  await expect(page.locator('.olv-analyse-panel .olv-busy-scan')).toHaveCount(0);
  const left = await page.evaluate(() =>
    document.getAnimations().filter((a) => String((a as CSSAnimation).animationName).startsWith('olv-bse-')).length,
  );
  expect(left).toBe(0);
});

/** Drop a generated 90,000-point ASCII PLY, big enough to stay in the load toast for a while. */
async function dropLargePly(page: import('@playwright/test').Page): Promise<void> {
  const dataTransfer = await page.evaluateHandle(() => {
    const n = 300;
    const rows: string[] = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const z = Math.sin(i / 20) * Math.cos(j / 25) * 2;
        rows.push(`${(i / 10).toFixed(3)} ${(j / 10).toFixed(3)} ${z.toFixed(3)} 180 190 200`);
      }
    }
    const header = [
      'ply', 'format ascii 1.0', `element vertex ${n * n}`,
      'property float x', 'property float y', 'property float z',
      'property uchar red', 'property uchar green', 'property uchar blue', 'end_header',
    ].join('\n');
    const dt = new DataTransfer();
    dt.items.add(new File([`${header}\n${rows.join('\n')}\n`], 'large-grid.ply'));
    return dt;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

interface ToastProbe {
  seen: boolean;
  ariaHidden: string | null;
  scanShown: boolean;
  dotShown: boolean;
  textLeftBusy: number;
  textLeftIdle: number;
  rowBusy: number;
  rowIdle: number;
  statusRole: string | null;
}

/**
 * Budgets for the two load-toast tests. On a software renderer every frame of
 * these clouds costs the page's main thread over a second, so the load, the
 * settle's timers and each page.evaluate after it queue behind frames. Each
 * test's budget covers the waits it makes, with room for the reads after them.
 */
const LARGE_LOAD_WAIT_MS = 30_000;
const XYZ_LOAD_WAIT_MS = 90_000;

test('the busy scan shows in the load toast while a large file opens and is gone after', async ({ page }) => {
  test.setTimeout(2 * LARGE_LOAD_WAIT_MS + 30_000);
  await page.goto('/?test=1');
  await page.evaluate(() => {
    const w = window as unknown as { __toastProbe: ToastProbe };
    const probe: ToastProbe = {
      seen: false, ariaHidden: null, scanShown: false, dotShown: true,
      textLeftBusy: 0, textLeftIdle: 0, rowBusy: 0, rowIdle: 0, statusRole: null,
    };
    w.__toastProbe = probe;
    const toast = document.querySelector<HTMLElement>('.olv-toast')!;
    const obs = new MutationObserver(() => {
      if (probe.seen || !toast.classList.contains('is-busy') || toast.classList.contains('olv-hidden')) return;
      probe.seen = true;
      const scan = toast.querySelector<SVGElement>('.olv-toast-mark .olv-busy-scan')!;
      const dot = toast.querySelector<HTMLElement>('.olv-toast-dot')!;
      const text = toast.querySelector<HTMLElement>('.olv-toast-text')!;
      const row = toast.querySelector<HTMLElement>('.olv-toast-row')!;
      probe.ariaHidden = scan.getAttribute('aria-hidden');
      probe.scanShown = getComputedStyle(scan).display !== 'none';
      probe.dotShown = getComputedStyle(dot).display !== 'none';
      probe.textLeftBusy = text.getBoundingClientRect().left;
      probe.rowBusy = row.getBoundingClientRect().height;
      toast.classList.remove('is-busy');
      probe.textLeftIdle = text.getBoundingClientRect().left;
      probe.rowIdle = row.getBoundingClientRect().height;
      toast.classList.add('is-busy');
      probe.statusRole = document.querySelector('.olv-visually-hidden[role="status"]') ? 'status' : null;
      obs.disconnect();
    });
    obs.observe(toast, { attributes: true, attributeFilter: ['class'] });
  });

  await dropLargePly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: LARGE_LOAD_WAIT_MS });
  await expect(page.locator('.olv-toast')).toBeHidden({ timeout: LARGE_LOAD_WAIT_MS });

  const probe = await page.evaluate(() => (window as unknown as { __toastProbe: ToastProbe }).__toastProbe);
  expect(probe.seen, 'the toast showed the busy scan during the load').toBe(true);
  expect(probe.ariaHidden).toBe('true');
  expect(probe.scanShown).toBe(true);
  expect(probe.dotShown).toBe(false);
  expect(probe.statusRole).toBe('status');
  expect(Math.abs(probe.textLeftBusy - probe.textLeftIdle)).toBeLessThan(0.5);
  expect(Math.abs(probe.rowBusy - probe.rowIdle)).toBeLessThan(0.5);
  await expect(page.locator('.olv-toast')).not.toHaveClass(/is-busy/);
});

test('the load toast trail grows with the load and the indicator settles away at the end', async ({ page }) => {
  test.setTimeout(2 * XYZ_LOAD_WAIT_MS + 60_000);
  await page.goto('/?test=1');
  await page.evaluate(() => {
    const w = window as unknown as { __lens: number[]; __settled: boolean };
    w.__lens = [];
    w.__settled = false;
    const scan = document.querySelector<SVGElement>('.olv-toast .olv-busy-scan')!;
    new MutationObserver(() => {
      const v = Number(scan.style.getPropertyValue('--olv-bs-len'));
      if (Number.isFinite(v) && v !== w.__lens[w.__lens.length - 1]) w.__lens.push(v);
      if (scan.classList.contains('is-settled')) w.__settled = true;
    }).observe(scan, { attributes: true, attributeFilter: ['style', 'class'] });
  });

  // A text point cloud reports a decode fraction as it reads, chunk by chunk.
  const dataTransfer = await page.evaluateHandle(() => {
    const rows: string[] = [];
    for (let i = 0; i < 700; i++) {
      for (let j = 0; j < 700; j++) rows.push(`${(i / 10).toFixed(2)} ${(j / 10).toFixed(2)} ${(Math.sin(i / 25) * 2).toFixed(3)}`);
    }
    const dt = new DataTransfer();
    dt.items.add(new File([rows.join('\n') + '\n'], 'large-grid.xyz'));
    return dt;
  });
  await page.dispatchEvent('body', 'drop', { dataTransfer });
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: XYZ_LOAD_WAIT_MS });
  await expect(page.locator('.olv-toast')).toBeHidden({ timeout: XYZ_LOAD_WAIT_MS });

  const { lens, settled } = await page.evaluate(() => {
    const w = window as unknown as { __lens: number[]; __settled: boolean };
    return { lens: w.__lens, settled: w.__settled };
  });
  // The trail lengthened across the load's stages, and reached the full loop
  // for the settle. Within a load it only grows; a fall is the reset for the
  // next load, which happens after the settle.
  const growth = lens.slice(0, lens.indexOf(95) + 1);
  expect(growth.length, `lengths seen: ${lens.join(', ')}`).toBeGreaterThanOrEqual(3);
  for (let i = 1; i < growth.length; i++) expect(growth[i]).toBeGreaterThan(growth[i - 1]);
  expect(settled).toBe(true);
  await expect(page.locator('.olv-toast')).not.toHaveClass(/is-busy/);
});
