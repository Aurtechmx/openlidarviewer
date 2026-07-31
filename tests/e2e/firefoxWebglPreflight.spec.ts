/**
 * Does this runner give Firefox a WebGL 2 context at all?
 *
 * The whole leg used to fail: 111 tests, 43 minutes, every one of them a
 * timeout waiting for a viewer that could not start. The cause was one line in
 * `Viewer.ts` — "Neither WebGPU nor WebGL 2 produced a usable context" — and
 * nothing in those 111 failures said so. Reading them, you would go looking for
 * a UI regression.
 *
 * This asks the browser the one question that determines whether the rest of
 * the suite can mean anything, and asks it without loading the app. When the
 * graphics environment breaks again, the leg fails here in seconds with a
 * renderer string, instead of spending 40 minutes producing failures about
 * panels and toolbars that are all downstream of the same missing context.
 *
 * It deliberately stops at the context. Asserting which backend OLV then picks
 * would couple a graphics-environment check to application markup, so a debug
 * overlay rename would fail the preflight and point at the runner. The suite
 * that follows is what tests the app; this only certifies the ground it stands
 * on.
 */
import { test, expect } from '@playwright/test';

test.describe('Firefox graphics preflight', () => {
  test('the runner exposes a WebGL 2 context', async ({ page, browserName }) => {
    test.skip(browserName !== 'firefox', 'Firefox is the leg with the GL problem.');

    const gl = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('webgl2', {
        antialias: false,
        // llvmpipe is a software rasteriser, so it reports a performance
        // caveat. Refusing the context on that basis is what we are testing
        // AROUND: the fixtures are a 10-point PLY and a 3,600-point grid, and
        // software rendering is entirely adequate at that size.
        failIfMajorPerformanceCaveat: false,
      });
      if (!ctx) return null;
      const info = {
        version: String(ctx.getParameter(ctx.VERSION)),
        vendor: String(ctx.getParameter(ctx.VENDOR)),
        renderer: String(ctx.getParameter(ctx.RENDERER)),
        extensions: ctx.getSupportedExtensions()?.length ?? 0,
      };
      ctx.getExtension('WEBGL_lose_context')?.loseContext();
      return info;
    });

    expect(
      gl,
      'Firefox produced no WebGL 2 context. On Linux this means the browser is '
      + 'running headless: no preference substitutes for a display, and the leg '
      + 'must launch headful under xvfb-run. Every other failure in this run is '
      + 'downstream of this one.',
    ).not.toBeNull();

    // Printed so a green run still records WHICH renderer answered. A silent
    // pass cannot tell you that the runner quietly moved from llvmpipe to
    // something else, and the renderer string is the cheapest way to notice.
    console.log(
      `Firefox WebGL 2: ${gl!.renderer} / ${gl!.vendor} / ${gl!.version} `
      + `(${gl!.extensions} extensions)`,
    );

    // getSupportedExtensions() returning nothing means a context that exists
    // and can do nothing, which would fail the suite in a far more confusing
    // place than here.
    expect(gl!.extensions, 'The context advertises no extensions.').toBeGreaterThan(0);
  });
});
