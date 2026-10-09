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
 * non-active mode is `display:none` until its tab is selected. A no-op before a
 * scan (the tab strip is absent), so callers can invoke it unconditionally after
 * a scan loads. At a phone width the rail is hidden and the mode is opened
 * through the bottom sheet's tab instead.
 */
export async function showWorkspaceMode(
  page: Page,
  mode: 'data' | 'work' | 'analyse' | 'output',
): Promise<void> {
  const tab = page.locator(`.olv-ws-tab[data-mode="${mode}"]`);
  if ((await tab.count()) === 0) return;
  if (await tab.isVisible()) {
    await tab.click();
    return;
  }
  // Phone layout: the desktop rail is hidden and its modes are the bottom
  // sheet's tabs, so the mode is reached through the sheet.
  const sheetTab = page.locator(`.olv-mobile-sheet .olv-msheet-tab[data-tab="${mode}"]`);
  if (await sheetTab.isVisible()) await activate(sheetTab);
}

/**
 * Open the Data mode's Classes page, where the class legend lives. The Data
 * home lists the classes open; the full legend is one click away.
 */
export async function openClassesPage(page: Page): Promise<void> {
  await showWorkspaceMode(page, 'data');
  // Data remembers its page: when Classes is already open there is no row to click.
  if (await page.locator('#olv-ws-mode-data .olv-ws-task-title', { hasText: 'Classes' }).isVisible()) return;
  await page.locator(':is(.olv-data-class-open, .olv-data-row):visible', { hasText: 'Classes' }).click({ timeout: 20_000 });
  // The pointer would rest over whatever the page puts under the row; park it
  // so a hover tip does not cover the page's controls.
  await page.mouse.move(1, 1);
}

/**
 * Drop the dense-grid fixture, switch to `mode`, and return `selector`'s
 * panel expanded — clicking its header if it opened collapsed. The setup
 * several a11y specs need before asserting on a panel's controls (ARIA
 * toggle state, keyboard focus order, …), so one change to how a panel
 * shows/collapses doesn't need to ripple through each of them.
 */
/**
 * Open a scene tool's page in the Tools mode through its launcher row. The
 * Tools home shows only the launcher; each tool's panel is a page of its own.
 */
export async function openToolPage(page: Page, title: 'Measure' | 'Annotate' | 'Clip box'): Promise<void> {
  await showWorkspaceMode(page, 'work');
  const heading = page.locator('#olv-ws-mode-work .olv-ws-task-title');
  if ((await heading.isVisible()) && (await heading.textContent()) === title) return;
  const back = page.locator('#olv-ws-mode-work .olv-ws-back');
  if (await back.isVisible()) await back.click();
  await page.locator('.olv-tool-launcher .olv-tl-row', { hasText: title }).click();
}

const TOOL_PAGES: Record<string, 'Measure' | 'Annotate' | 'Clip box'> = {
  '.olv-clip-panel': 'Clip box',
  '.olv-measure-panel': 'Measure',
  '.olv-anno-panel': 'Annotate',
};

export async function openExpandedPanel(
  page: Page,
  mode: 'data' | 'work' | 'analyse' | 'output',
  selector: string,
): Promise<Locator> {
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  if (mode === 'work' && TOOL_PAGES[selector]) await openToolPage(page, TOOL_PAGES[selector]);
  else await showWorkspaceMode(page, mode);

  const panel = page.locator(selector);
  await expect(panel).toBeVisible({ timeout: 20_000 });
  if (await panel.evaluate((el) => el.classList.contains('olv-collapsed'))) {
    await panel.locator('.olv-panel-head').click();
  }
  return panel;
}

/**
 * Open an Analyse page through the Analyse home. The home lists one row per
 * analysis; Terrain, Objects & Space, Feature candidates and Range frames are
 * pages of their own, and Contours is a page under Terrain.
 */
export async function openAnalysePage(
  page: Page,
  target: 'terrain' | 'contours' | 'objects' | 'features' | 'range',
): Promise<void> {
  await showWorkspaceMode(page, 'analyse');
  const heading = page.locator('#olv-ws-mode-analyse .olv-ws-task-title');
  const want = { terrain: 'Terrain', contours: 'Contours', objects: 'Objects & Space', features: 'Feature candidates', range: 'Range frames' }[target];
  if ((await heading.isVisible()) && (await heading.textContent()) === want) return;
  const back = page.locator('#olv-ws-mode-analyse .olv-ws-back');
  while (await back.isVisible()) await back.click();
  const row = target === 'contours' ? 'terrain' : target;
  await page.locator(`.olv-ah-row[data-analysis="${row}"] .olv-ah-open`).click({ timeout: 20_000 });
  if (target === 'contours') await page.locator('.olv-at-link').click();
  await expect(heading).toHaveText(want);
}

/**
 * Open the Analyse panel on its Terrain page. Shared by `flowPulseLab.spec.ts`
 * and `terrainAccessLab.spec.ts` (Sonar-flagged as a verbatim duplicate).
 */
export async function openAnalysePanel(page: Page): Promise<void> {
  await openAnalysePage(page, 'terrain');
  await expect(page.locator('.olv-analyse-panel')).toBeVisible({ timeout: 20_000 });
}

/**
 * Open the command palette, type `query`, wait for a row containing
 * `rowText`, then click that row to run it. Shared by `flowPulseLab.spec.ts`
 * and `terrainAccessLab.spec.ts` (Sonar-flagged as a verbatim duplicate).
 */
export async function firePaletteAction(page: Page, query: string, rowText: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.locator('.olv-palette')).toBeVisible();
  await page.locator('.olv-palette-input').fill(query);
  const row = page.locator('.olv-palette-row', { hasText: rowText }).first();
  await expect(row).toBeVisible();
  // The row itself: a Go to entry for the same page can rank first.
  await row.click();
  await expect(page.locator('.olv-palette')).toBeHidden();
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
 * Open the Navigation panel (Camera and Views rows) from the first scan, as a
 * user who has opened it before would see it. It starts closed otherwise.
 */
export async function pinNavigationPanel(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('olv.nav.helpPinned', '1');
    } catch {
      // Storage blocked: the panel starts closed and the spec sees that.
    }
  });
}

/**
 * Wait until the camera stops moving: the pose from the test API reads the
 * same across two polls three animation frames apart. Needs a page opened
 * with `?test=1`. Use it after a scan opens instead of a fixed sleep, so a
 * click never lands mid-way through the opening glide on a slow renderer.
 */
export async function waitForCameraSettled(page: Page, timeout = 30_000): Promise<void> {
  const pose = () => page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => { position: number[]; target: number[] } };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    return p ? JSON.stringify({ position: p.position, target: p.target }) : '';
  });
  const threeFrames = () => page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = (): void => {
      n += 1;
      if (n >= 3) resolve();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const deadline = Date.now() + timeout;
  let last = await pose();
  if (last === '') throw new Error('no camera pose: open the page with ?test=1');
  for (;;) {
    await threeFrames();
    const next = await pose();
    if (next === last) return;
    if (Date.now() > deadline) throw new Error(`the camera was still moving after ${timeout} ms`);
    last = next;
  }
}

/**
 * Where a freshly framed scan's centre lands, in page coordinates. The opening
 * fit keeps the scan above the navigation bar's mode triangle with a lens
 * shift, so on desktop the centre sits in the middle of the band above the
 * triangle (less the fit's 12 px gap), not the canvas centre. Where the bar
 * does not lay out (phones) it is the canvas centre.
 */
export async function framedScanCentre(page: Page): Promise<{ x: number; y: number }> {
  const canvas = await page.locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('canvas has no bounding box');
  const rowTop = await page.evaluate(() => {
    const row = document.querySelector('.olv-navbar .olv-nav-row');
    const r = row?.getBoundingClientRect();
    return r && r.width > 0 && r.height > 0 ? r.y : null;
  });
  const bottom = rowTop === null ? canvas.y + canvas.height : rowTop - 12;
  return { x: canvas.x + canvas.width / 2, y: (canvas.y + bottom) / 2 };
}

/**
 * Pre-seed the stale-chunk recovery cooldown (staleChunkReload.ts), so the
 * first aborted chunk in a test takes the no-reload branch and reaches the
 * failure toast instead of reloading the page.
 */
export async function seedStaleReloadCooldown(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      sessionStorage.setItem('olv:stale-reload-at', String(Date.now()));
    } catch {
      // Storage may be blocked; the failure path still runs, through one reload.
    }
  });
}

/**
 * Drop a 70 x 70 synthesised height field as a positions-only PLY. With no
 * colour channel it opens coloured by height, so the colour bar is up.
 */
export async function dropHillsPly(page: Page): Promise<void> {
  const N = 70;
  const rows: string[] = [];
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const u = i / (N - 1);
      const v = j / (N - 1);
      const h = 380 + 40 * Math.sin(u * 3.1) * Math.cos(v * 2.2) + 15 * u;
      // PLY is Y-up: the height goes in the second column.
      rows.push(`${(u * 60 - 30).toFixed(3)} ${h.toFixed(3)} ${(v * 60 - 30).toFixed(3)}`);
    }
  }
  const text =
    `ply\nformat ascii 1.0\nelement vertex ${N * N}\nproperty float x\nproperty float y\nproperty float z\nend_header\n` +
    rows.join('\n') + '\n';
  const dataTransfer = await page.evaluateHandle((t) => {
    const dt = new DataTransfer();
    dt.items.add(new File([t], 'hills.ply'));
    return dt;
  }, text);
  await page.dispatchEvent('body', 'drop', { dataTransfer });
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
 * Drop the bundled `terrain-access-utm.las` fixture — a 30×30 grid (900
 * points) georeferenced to WGS 84 / UTM zone 13N via a GeoKeys VLR (see
 * `scripts/gen-terrain-access-fixture.ts`, which regenerates it). Terrain
 * Access refuses outright on an unresolved horizontal scale
 * (UNITS_UNRESOLVED), so the drag-and-drop fixture used elsewhere in this
 * suite (`dropDenseGridPly`, a local/unreferenced PLY) can never reach the
 * routing/export happy path — this fixture exists so that path actually
 * runs in CI instead of only being unit-tested against a hand-built grid.
 */
export async function dropTerrainAccessUtmLas(page: Page): Promise<void> {
  const bytes = readFileSync(
    fileURLToPath(new URL('../fixtures/terrain-access-utm.las', import.meta.url)),
  );
  const dataTransfer = await page.evaluateHandle((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(b)], 'terrain-access-utm.las'));
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

/** The exact bytes `dropDenseGridPly` drops. */
export function denseGridPlyBytes(): Uint8Array {
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
  return new TextEncoder().encode(text);
}

/**
 * Drop a denser synthesised PLY — a 60×60 grid of 3 600 points across a small
 * 3D surface (sinusoidal Z) so the framing puts the cloud in an orbit-friendly
 * pose and the picker has a dense canopy to hit. Built inline so the bundled
 * fixtures stay small; the 10-point `tiny.ply` is too sparse for a centre-of-
 * canvas click to land on a point.
 */
export async function dropDenseGridPly(page: Page): Promise<void> {
  const bytes = denseGridPlyBytes();
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

/** The `?test=1` seam (`window.__OLV_TEST_API__`) profile placement drives,
 * shared by profileWorkbench.spec.ts and keyboardInspection.spec.ts. */
export interface MeasureTestApi {
  setMeasureKind: (k: string) => void;
  placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
  finishMeasurement?: () => void;
}

/** Wide enough that the docked workbench (not the narrow focus view) opens. */
export const WORKBENCH_WIDE = { width: 1440, height: 900 };

/**
 * Load the dense fixture, arm Measure, and place one profile across it via
 * `__OLV_TEST_API__` — placement this way does not depend on a raycast
 * landing on a particular pixel. The dense grid fixture spans about
 * [-5, +5] on each axis, so a run along X sits inside it with points either
 * side of the corridor.
 */
export async function placeProfile(page: Page): Promise<void> {
  await page.setViewportSize(WORKBENCH_WIDE);
  await page.goto('/?test=1');
  await dropDenseGridPly(page);
  await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
  await page.waitForTimeout(500); // the test API mounts on viewerLoaded
  await page.locator('.olv-tool', { hasText: 'Measure' }).click();
  await expect(page.locator('.olv-measure-bar')).toBeVisible();

  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: MeasureTestApi }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted — was ?test=1 set?');
    api.setMeasureKind('profile');
    api.placeMeasurementPoint({ x: -4, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 4, y: 0, z: 0 });
    api.finishMeasurement?.();
  });

  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

/**
 * Wait until the current page has no requests in flight. After `load` the app
 * still fetches its lazy chunks; navigating away while one is pending makes
 * Firefox cancel it, and the cancelled import plus the new navigation end in
 * NS_BINDING_ABORTED (or NS_ERROR_FAILURE) on the goto or reload.
 */
export async function settleNavigation(page: Page): Promise<void> {
  if (page.url() === 'about:blank') return;
  await page.waitForLoadState('networkidle');
}

/** page.goto that first lets the current page finish its own loading. */
export async function gotoSettled(page: Page, url: string): Promise<void> {
  await settleNavigation(page);
  await page.goto(url);
}

/** page.reload that first lets the current page finish its own loading. */
export async function reloadSettled(page: Page): Promise<void> {
  await settleNavigation(page);
  await page.reload();
}

/** Place a two-point distance through the test API (needs `?test=1`). */
export async function placeTestDistance(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as unknown as { __OLV_TEST_API__?: {
      setMeasureKind: (k: string) => void;
      placeMeasurementPoint: (p: { x: number; y: number; z: number }) => void;
    } }).__OLV_TEST_API__;
    if (!api) throw new Error('__OLV_TEST_API__ not mounted');
    api.setMeasureKind('distance');
    api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
    api.placeMeasurementPoint({ x: 1, y: 0, z: 0 });
  });
  await expect(page.locator('.olv-mp-row')).toHaveCount(1, { timeout: 5_000 });
}

/**
 * A digest of what the terrain run and the contour step put on screen: the
 * evidence text, the fitness verdict, the Contour Studio launcher and the
 * raster pixels. Each node is tagged, so a re-render (which replaces the
 * nodes) shows as a missing tag even when the text matches.
 */
export async function terrainResultDigest(page: Page, tag: string): Promise<{ digest: string; tagged: number; count: number }> {
  return page.evaluate(async (t) => {
    const nodes = [
      ...document.querySelectorAll('.olv-analyse-readiness .olv-analyse-ready, .olv-fit-row, .olv-analyse-score, .olv-analyse-validation, .olv-analyse-contour-launcher > *'),
    ] as (HTMLElement & { __probe?: string })[];
    let tagged = 0;
    for (const n of nodes) {
      if (n.__probe === t) tagged++;
      n.__probe ??= t;
    }
    const rasters = [...document.querySelectorAll('canvas.olv-analyse-raster')] as HTMLCanvasElement[];
    const text = nodes.map((n) => n.textContent ?? '').join('\n') + rasters.map((c) => c.toDataURL()).join('\n');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return { digest: [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join(''), tagged, count: nodes.length };
  }, tag);
}

/**
 * The dense-grid surface as a LAS 1.4 in EPSG:32633 with a NAVD88 metre
 * vertical axis, so the vertical unit resolves and the tier can reach T3.
 */
export async function dropDenseGridUtmLas(page: Page): Promise<void> {
  (globalThis as Record<string, unknown>).__BUILD_IDENTITY__ ??= {
    version: '0.0.0-test', commit: 'unknown', dirty: false, builtAt: '1970-01-01T00:00:00.000Z',
  };
  const { writeLas14 } = await import('../../src/convert/writeLas');
  const { wktForEpsg } = await import('../../src/io/epsgWkt');
  const N = 60;
  const x = new Float64Array(N * N);
  const y = new Float64Array(N * N);
  const z = new Float64Array(N * N);
  for (let k = 0; k < N * N; k++) {
    const u = Math.floor(k / N) / (N - 1);
    const v = (k % N) / (N - 1);
    x[k] = 500_000 + u * 10;
    y[k] = 5_000_000 + v * 10;
    z[k] = 200 + Math.sin(u * Math.PI) * Math.cos(v * Math.PI) * 1.5;
  }
  const bytes = writeLas14({ count: N * N, x, y, z }, {
    wkt: wktForEpsg(32633), epsg: 32633, linearUnitCode: 9001, verticalEpsg: 5703, verticalUnitCode: 9001,
  });
  const dt = await page.evaluateHandle((b) => {
    const d = new DataTransfer();
    d.items.add(new File([new Uint8Array(b)], 'dense-grid-utm.las'));
    return d;
  }, [...bytes]);
  await page.dispatchEvent('body', 'drop', { dataTransfer: dt });
}

/**
 * On the phone layout the scan-ready toast takes its turn in the transient
 * lane (src/ui/transientLane.ts) after the Project card and the touch hint.
 * Wait for the card, close it, then close the hint until the toast is the card
 * on screen. Conditions only: the card is raised after the load settles and
 * goes in front of whatever is showing, so nothing here depends on timing.
 */
export async function bringPhoneToastForward(page: Page): Promise<void> {
  const card = page.locator('.olv-project-card.olv-visible');
  await expect(card).toBeVisible({ timeout: 15_000 });
  await card.locator('.olv-pc-dismiss').evaluate((e) => (e as HTMLElement).click());
  await expect(card).toHaveCount(0);
  const toast = page.locator('.olv-lasso-toast.olv-visible:not(.olv-lane-wait)');
  const hint = page.locator('.olv-touch-hint.olv-visible:not(.olv-lane-wait) .olv-touch-hint-x');
  await expect.poll(async () => {
    if (await hint.isVisible()) await hint.evaluate((e) => (e as HTMLElement).click());
    return toast.isVisible();
  }, { timeout: 10_000 }).toBe(true);
}

/**
 * Close the scan from the tool dock. On a phone the control is filed under
 * More, so the tray opens first. When the scan holds work that closing would
 * discard, the confirmation appears and is accepted.
 */
export async function closeScanFromDock(page: Page): Promise<void> {
  const close = page.locator('.olv-tool-close');
  if (!(await close.isVisible())) {
    const more = page.locator('.olv-tool-more');
    if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  }
  await close.click();
  const confirm = page.locator('.olv-modal .olv-confirm-ok');
  await Promise.race([
    confirm.waitFor({ state: 'visible', timeout: 5_000 }).then(() => confirm.click()).catch(() => {}),
    page.locator('.olv-empty').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {}),
  ]);
}
