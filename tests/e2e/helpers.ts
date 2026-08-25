/**
 * tests/e2e/helpers.ts
 *
 * Shared helpers for the Playwright e2e suite. Centralised here so a change
 * to the empty-state DOM doesn't ripple through twelve spec files.
 *
 * Background:
 *   The empty state historically shipped two bundled samples named
 *   "Drone survey" and "Phone scan". They were removed in favour of a
 *   single streaming demo card; the spec files written against those
 *   names broke silently in CI because Playwright's `getByText` times
 *   out without surfacing a useful message. Using a stable fixture drop
 *   instead of fragile text matching makes the suite resilient to
 *   empty-state copy changes.
 */

import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The onboarding tour (v0.3.9) auto-launches on the first session per
 * browser and renders a full-canvas SVG overlay that intercepts pointer
 * events. Every Playwright run is a "first session" because the context
 * starts with an empty localStorage, so the overlay reliably blocks the
 * test's first click. Seeding the storage key BEFORE the page loads is
 * the cleanest fix — no spec changes, no flaky "wait for skip button"
 * dance. The key string mirrors `STORAGE_KEY` in src/ui/onboarding/
 * tourSteps.ts; if that changes, this string follows.
 */
/**
 * Activate a desktop-workspace left mode (Data / Work / Analyse / Output). The
 * workspace shows ONE mode at a time (v0.6.5), so a panel that lives in a
 * non-active mode is `display:none` until its tab is selected. A no-op on mobile
 * or before a scan (the tab strip is absent), so callers can invoke it
 * unconditionally after a scan loads.
 */
export async function showWorkspaceMode(
  page: Page,
  mode: 'data' | 'work' | 'analyse' | 'output',
): Promise<void> {
  const tab = page.locator(`.olv-ws-tab[data-mode="${mode}"]`);
  if (await tab.count()) await tab.click();
}

export async function suppressOnboardingTour(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('olv:tour:v1:completed', '1');
    } catch {
      // Storage may be blocked (private mode, content settings); the
      // tour just runs as it would for a user. Tests in that mode will
      // see the overlay and need to dismiss it explicitly.
    }
  });
}

/**
 * Drop the bundled `tiny.ply` fixture onto the page body via a synthesised
 * DataTransfer. Exercises the same load → render → validate path a real
 * dragged file takes, and works whether or not the empty-state sample
 * card exists. Use this anywhere a test previously clicked a sample.
 */
export async function dropTinyPly(page: Page): Promise<void> {
  const bytes = readFileSync(
    fileURLToPath(new URL('../fixtures/tiny.ply', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'tiny.ply'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Drop the bundled `tiny.las` fixture — same as `dropTinyPly` but
 * exercises the LAS decoder path instead of PLY.
 */
export async function dropTinyLas(page: Page): Promise<void> {
  const bytes = readFileSync(
    fileURLToPath(new URL('../../public/samples/tiny.las', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'tiny.las'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Drop a synthesised PTX — a scanner file that carries its ACQUISITION GRID.
 *
 * PTX is one of the two formats whose loader builds an `OrganizedRangeFrame`,
 * so this is the drop that must reveal the Range Frame Workbench launcher.
 * The grid is 6 columns by 4 rows and NON-SQUARE on purpose, and PTX orders its
 * samples down each column, so the body is written column by column.
 *
 * One sample is the format's `0 0 0` no-return marker, so the validity view has
 * something other than one flat colour to draw and the launcher is exercised on
 * a grid that is not uniformly valid.
 */
export async function dropTinyPtx(page: Page): Promise<void> {
  const cols = 6;
  const rows = 4;
  const lines: string[] = [
    String(cols),
    String(rows),
    '0 0 0',
    '1 0 0',
    '0 1 0',
    '0 0 1',
    '1 0 0 0',
    '0 1 0 0',
    '0 0 1 0',
    '0 0 0 1',
  ];
  for (let c = 0; c < cols; c++) {
    for (let r = 0; r < rows; r++) {
      if (c === 2 && r === 1) {
        lines.push('0 0 0 0'); // the scanner looked and nothing came back
        continue;
      }
      const x = (c - cols / 2) * 0.9;
      const y = (r - rows / 2) * 0.9;
      const z = Math.sin(c * 0.7) * Math.cos(r * 0.7) * 1.2;
      lines.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 0.5`);
    }
  }
  const text = lines.join('\n');
  const dataTransfer = await page.evaluateHandle((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'setup.ptx'));
    return dt;
  }, text);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Drop a denser synthesised PLY — a 60×60 grid of 3 600 points across a small
 * 3D surface (sinusoidal Z) so the framing puts the cloud in an orbit-friendly
 * pose and the picker has a dense canopy to hit. Built inline so the bundled
 * fixtures stay small; the 10-point `tiny.ply` is too sparse for a centre-of-
 * canvas click to land on a point.
 */
export async function dropDenseGridPly(page: Page): Promise<void> {
  const N = 60;
  const points: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = i / (N - 1);
      const v = j / (N - 1);
      const x = u * 10 - 5;
      const y = v * 10 - 5;
      // Gentle 3D surface — gives the cloud volume so framing produces a
      // reasonable orbit pose instead of a degenerate flat plane.
      const z = Math.sin(u * 3.14159) * Math.cos(v * 3.14159) * 1.5;
      points.push(`${x.toFixed(4)} ${y.toFixed(4)} ${z.toFixed(4)} 200 200 200 255`);
    }
  }
  const header =
    `ply\n` +
    `format ascii 1.0\n` +
    `element vertex ${N * N}\n` +
    `property float x\n` +
    `property float y\n` +
    `property float z\n` +
    `property uchar red\n` +
    `property uchar green\n` +
    `property uchar blue\n` +
    `property uchar alpha\n` +
    `end_header\n`;
  const text = header + points.join('\n') + '\n';
  const bytes = new TextEncoder().encode(text);
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'dense-grid.ply'));
    return dt;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
}

/**
 * Wait until the desktop rail chrome has finished its mount animation.
 *
 * Two rules in 72-panel-rails.css keep the rail moving after a scan mounts:
 * `.olv-left-panels:not(.olv-rail-collapsed) > *` runs the 380ms
 * `olv-rail-panel-in` entrance, and each grabber tab transitions its `left` /
 * `right` offset over 420ms on `--ease-spring`. `.olv-ws-body` is a direct
 * child of the rail, so the whole scroller and every control inside it is
 * still translating while that entrance plays.
 *
 * Only those two are awaited. The rail also hosts decorative animations that
 * never end (status-dot pulse, the Analyse shimmer, the reclassify spinner),
 * so a blanket "nothing is running" wait would never return.
 */
export async function railChromeSettled(page: Page, timeout = 15_000): Promise<void> {
  // A style change queued in this frame has no running animation yet, so a
  // check made straight away would pass before the entrance even starts. Let
  // two frames go by first: that is a frame boundary, not a duration.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  await page.waitForFunction(
    () => {
      const SETTLING = new Set(['left', 'right', 'width', 'transform', 'opacity']);
      return document.getAnimations().every((a) => {
        if (a.playState !== 'running') return true;
        const anim = a as Animation & { animationName?: string; transitionProperty?: string };
        if (anim.animationName === 'olv-rail-panel-in') return false;
        if (anim.transitionProperty === undefined) return true;
        const target = (a.effect as KeyframeEffect | null)?.target ?? null;
        if (target === null) return true;
        const inRail =
          target.closest('.olv-left-panels, .olv-right-rail, .olv-rail-tab, .olv-right-rail-tab') !==
          null;
        return !(inRail && SETTLING.has(anim.transitionProperty));
      });
    },
    undefined,
    { timeout },
  );
}

/**
 * Wait until `locator` is the element the browser actually hits at its own
 * centre, then assert it. The layer row's rightmost control clears the
 * `.olv-ws-body` client edge by 4px, so a few pixels of un-settled transform
 * put that centre inside the scroller's reserved scrollbar gutter and
 * `.olv-ws-body` wins the hit test. This waits for the condition the click
 * needs rather than for a duration, and it keeps the interception check that
 * `{ force: true }` would switch off.
 */
export async function expectHittable(locator: Locator, timeout = 15_000): Promise<void> {
  await locator.waitFor({ state: 'visible', timeout });
  await expect
    .poll(
      async () => {
        // A click scrolls its target into view before it hits anything, and the
        // rail scrolls, so do the same here. Without it the centre of a control
        // below the fold is outside the viewport and nothing is hit at all.
        await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
        return locator.evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (hit === null) return 'nothing';
          if (hit === el || el.contains(hit)) return 'target';
          return hit.className || hit.tagName;
        });
      },
      { timeout, message: 'the element at the target centre is still something else' },
    )
    .toBe('target');
}

/**
 * Activate a control the way the running device actually would.
 *
 * The mobile specs run under two projects: `deterministic` (Desktop Chrome,
 * no touch) and `webkit-mobile` (iPhone 15, touch). Those need different
 * gestures, and picking the wrong one is quietly misleading in both
 * directions. `tap()` throws where `hasTouch` is unset, so it cannot simply
 * be used everywhere. `click()` synthesizes a mouse event, which a handler
 * bound only to touch events can ignore, so a click-based mobile test can
 * pass against a control that does nothing under a real thumb.
 *
 * Reading `hasTouch` off the project rather than sniffing the user agent
 * keeps this honest: it reports what Playwright actually configured.
 */
export async function activate(locator: Locator): Promise<void> {
  const hasTouch = test.info().project.use.hasTouch === true;
  if (hasTouch) {
    await locator.tap();
    return;
  }
  await locator.click();
}
