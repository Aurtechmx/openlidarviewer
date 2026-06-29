import { test, expect, type Page } from '@playwright/test';
import { suppressOnboardingTour, dropTinyPly } from './helpers';

/**
 * lazyChunkLoad.spec.ts — proves the runtime dynamic-import seams actually
 * resolve, especially on the production (obfuscated) build.
 *
 * Why this exists:
 *   main.ts is a transformed module, so the live `stringArray` obfuscator
 *   pass can scramble a fraction of inline `import('./…')` specifiers each
 *   build. A scrambled specifier 404s only on the build where it happened to
 *   get mangled — "works in dev, breaks on the one build it scrambles". That
 *   is precisely how a lazily-imported panel once crashed the deployed site.
 *
 *   The fix routes every runtime lazy import through `src/lazyChunks.ts`
 *   (the obfuscator `exclude` module). This spec is the regression net: it
 *   triggers the user-facing entry points whose chunks are loaded on demand
 *   and fails if any of them raises a dynamic-import error. Run it against
 *   the minified artifact (SMOKE_LIVE=1) and a scramble-404 surfaces in CI
 *   instead of in production.
 *
 * The boot smoke (smoke.spec.ts) only proves the shell loads; it never
 * triggers these on-demand chunks, so a 404 behind a feature gate would slip
 * past it. This spec closes that gap.
 */

/** A dynamic-import failure manifests as one of these pageerror messages. */
function isDynamicImportFailure(message: string): boolean {
  return (
    /failed to fetch dynamically imported module/i.test(message) ||
    /error loading dynamically imported module/i.test(message) ||
    /unable to preload/i.test(message)
  );
}

/** Attach collectors and return the captured dynamic-import failures. */
function watchForImportFailures(page: Page): string[] {
  const failures: string[] = [];
  page.on('pageerror', (err) => {
    if (isDynamicImportFailure(err.message)) failures.push(err.message);
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error' && isDynamicImportFailure(msg.text())) {
      failures.push(msg.text());
    }
  });
  return failures;
}

test.describe('runtime lazy chunks resolve on the served build', () => {
  test('command palette chunk loads on Cmd-K', async ({ page }) => {
    const failures = watchForImportFailures(page);
    await suppressOnboardingTour(page);
    await page.goto('/');
    await expect(page.locator('.olv-empty')).toBeVisible();

    // Cmd-K is the only trigger for the CommandPalette chunk. If its
    // specifier 404s, the palette never mounts and a pageerror fires.
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(page.locator('.olv-palette')).toBeVisible({ timeout: 10_000 });

    expect(
      failures,
      `dynamic-import failure while loading the command palette:\n${failures.join('\n')}`,
    ).toEqual([]);
  });

  test('context-menu chunk loads on canvas right-click', async ({ page }) => {
    const failures = watchForImportFailures(page);
    await suppressOnboardingTour(page);
    await page.goto('/');

    // The context menu is only armed once a scan is loaded, so drop one and
    // wait for the empty state to clear before right-clicking the canvas.
    await dropTinyPly(page);
    await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
    await page.waitForTimeout(800);

    await page.locator('.olv-stage canvas').click({
      button: 'right',
      position: { x: 60, y: 60 },
    });
    await expect(page.locator('.olv-ctxmenu')).toBeVisible({ timeout: 10_000 });

    expect(
      failures,
      `dynamic-import failure while loading the context menu:\n${failures.join('\n')}`,
    ).toEqual([]);
  });
});
