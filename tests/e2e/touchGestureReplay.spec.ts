import { test, expect, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dropTinyPly } from './helpers';

/**
 * tests/e2e/touchGestureReplay.spec.ts
 *
 * Replays a recorded iOS touch trace — real WebDriverAgent input, captured
 * by scripts/ios-touch-trace.mjs against src/probe/iosTouchProbe.ts on the
 * iOS simulator — into the real, full application, on the three engines
 * this repository already runs deterministic touch coverage on (webkit,
 * webkit-mobile, and Chromium via the `deterministic` project — see the
 * file-name match rules in playwright.config.ts).
 *
 * tests/e2e/touchGesture.spec.ts already proves the recogniser's ARITHMETIC
 * against Playwright's own synthesized events. This proves something else:
 * that the SEQUENCE iOS actually produced — its own event count, its own
 * inter-event timing, its own coalescing — drives the same outcome once it
 * reaches the app, on every engine, not just the one it was recorded on.
 *
 * Fixtures live in tests/fixtures/ios-traces/ (see its README for which
 * device, iOS runtime, runner image and date they were recorded from). A
 * checkout with none yet — this spec ships before the first CI recording is
 * committed — reports one explanatory skip rather than a red or a silent
 * pass, so an empty fixture set cannot look like a coverage claim.
 */

interface PointerLogEntry {
  readonly kind: 'pointer';
  readonly t: number;
  readonly type: string;
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly clientX: number;
  readonly clientY: number;
}

interface IosTrace {
  readonly meta: { readonly gesture: string; readonly description: string };
  readonly canvasRect: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
  readonly events: ReadonlyArray<PointerLogEntry | { readonly kind: string }>;
}

/**
 * Whether the FULL application should move its camera for this gesture.
 *
 * Deliberately separate from the probe's own `expectRecognizer` (recorded in
 * the fixture's `meta`): that field is scoped to `TouchTracker`, the
 * two-pointer recogniser. `oneFingerDrag` and `doubleTap` never reach
 * `TouchTracker` — they move the camera through `OrbitControls`' single-
 * finger orbit and `TouchTapGate`'s double-tap focus instead — so a replay
 * against the real Viewer expects motion from them despite `TouchTracker`
 * firing nothing. `wobble` is the one gesture no path should move.
 */
const EXPECT_MOTION: Record<string, boolean> = {
  pinchIn: true,
  pinchOut: true,
  twist: true,
  pan: true,
  oneFingerDrag: true,
  doubleTap: true,
  wobble: false,
};

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/ios-traces/', import.meta.url));

function loadTraces(): Array<{ file: string; trace: IosTrace }> {
  let names: string[];
  try {
    names = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.json') && f !== 'RESULT.json');
  } catch {
    return [];
  }
  return names.map((file) => ({
    file,
    trace: JSON.parse(readFileSync(`${FIXTURES_DIR}${file}`, 'utf8')) as IosTrace,
  }));
}

/**
 * Dispatch a recorded iOS pointer sequence at the live canvas, preserving
 * event order, id, type and the RELATIVE timing between events (`t`, ms,
 * from the trace). Coordinates are recorded relative to the probe's own
 * canvas rect and rescaled onto whatever rect the replay engine's canvas
 * actually has — the iPhone 17e simulator and a desktop WebKit window are
 * different sizes, so an absolute replay would drift off the canvas.
 */
async function replayTrace(
  page: Page,
  trace: IosTrace,
  liveRect: { x: number; y: number; width: number; height: number },
): Promise<void> {
  const pointerEvents = trace.events.filter(
    (e): e is PointerLogEntry => e.kind === 'pointer',
  );
  await page.evaluate(
    async ([events, rect]) => {
      const canvas = document.querySelector('.olv-canvas') as HTMLElement | null;
      if (!canvas) throw new Error('no canvas');
      // A page script's dispatchEvent(new PointerEvent(...)) never registers
      // a browser-tracked "active pointer" the way a real touch does, so
      // Element.setPointerCapture throws NotFoundError for every id this
      // replay invents. OrbitControls calls it, uncaught, on its own
      // pointerdown handler (three's OrbitControls.js) before it attaches
      // the drag's pointermove/pointerup listeners, so without this, the
      // single-finger orbit path this replay exists to exercise never even
      // starts. Shimmed for the duration of this replay only: real touch
      // input gets capture for free, and this stands in for that guarantee
      // rather than loosening anything the app or the recognisers assert.
      const proto = Element.prototype;
      const realSet = proto.setPointerCapture;
      const realRelease = proto.releasePointerCapture;
      const realHas = proto.hasPointerCapture;
      const captured = new Set<number>();
      proto.setPointerCapture = function (id: number) { captured.add(id); };
      proto.releasePointerCapture = function (id: number) { captured.delete(id); };
      proto.hasPointerCapture = function (id: number) { return captured.has(id); };
      const fire = (type: string, id: number, isPrimary: boolean, x: number, y: number) => {
        const ev = new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: id,
          pointerType: 'touch',
          clientX: rect.x + x,
          clientY: rect.y + y,
          isPrimary,
        });
        Object.defineProperty(ev, 'offsetX', { get: () => x });
        Object.defineProperty(ev, 'offsetY', { get: () => y });
        canvas.dispatchEvent(ev);
      };
      try {
        let lastT = events.length > 0 ? events[0].t : 0;
        for (const e of events) {
          // Clamped to 200ms so a trace with a genuine long pause (a stalled
          // simulator, a slow CI host) cannot stall this test for that long.
          // Measured against every fixture committed under
          // tests/fixtures/ios-traces/: the largest real inter-event gap is
          // 68ms (wobble.json, see its README), so nothing recorded there is
          // compressed by this clamp today. Re-check this comment's number
          // against tests/fixtures/ios-traces/README.md's own measurement
          // whenever a fixture there is replaced.
          const wait = Math.max(0, Math.min(200, e.t - lastT));
          if (wait > 0) await new Promise((r) => setTimeout(r, wait));
          lastT = e.t;
          // e.clientX/Y are recorded relative to the PROBE's canvas rect
          // (trace.canvasRect); rescale into a 0..1 fraction of it, then place
          // that fraction on the LIVE canvas rect this replay actually has.
          fire(e.type, e.pointerId, e.isPrimary, e.canvasFracX * rect.width, e.canvasFracY * rect.height);
        }
      } finally {
        proto.setPointerCapture = realSet;
        proto.releasePointerCapture = realRelease;
        proto.hasPointerCapture = realHas;
      }
    },
    [
      pointerEvents.map((e) => ({
        type: e.type,
        pointerId: e.pointerId,
        isPrimary: e.isPrimary,
        t: e.t,
        canvasFracX: (e.clientX - trace.canvasRect.x) / trace.canvasRect.w,
        canvasFracY: (e.clientY - trace.canvasRect.y) / trace.canvasRect.h,
      })),
      liveRect,
    ] as const,
  );
}

async function settledPose(page: Page): Promise<string> {
  await expect(page.locator('body.olv-has-scan')).toHaveCount(1, { timeout: 30_000 });
  await page.bringToFront();
  await expect
    .poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 })
    .toBe('visible');
  const threeFrames = () => page.evaluate(() => new Promise<void>((resolve) => {
    let n = 0;
    const tick = (): void => { n += 1; if (n >= 3) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  let last = await readPose(page);
  for (let i = 0; i < 120; i++) {
    await threeFrames();
    const next = await readPose(page);
    if (next === last) return next;
    last = next;
  }
  throw new Error('the camera was still moving after 120 three-frame checks');
}

async function readPose(page: Page): Promise<string> {
  const pose = await page.evaluate(() => {
    const api = (window as unknown as {
      __OLV_TEST_API__?: { getCameraPose?: () => { position: number[]; target: number[] } };
    }).__OLV_TEST_API__;
    const p = api?.getCameraPose?.();
    return p ? JSON.stringify({ position: p.position, target: p.target }) : '';
  });
  expect(
    pose,
    'test-seam pose oracle read nothing - is the page on ?test=1 and the build carrying OLV_TEST_SEAM?',
  ).not.toBe('');
  return pose;
}

const traces = loadTraces();

test.describe('iOS trace replay — real device input into the full app', () => {
  if (traces.length === 0) {
    test('skipped — no fixtures in tests/fixtures/ios-traces/ yet', () => {
      test.skip(true, 'run scripts/ios-touch-trace.mjs on the iOS simulator leg and commit its output first');
    });
    return;
  }

  for (const { file, trace } of traces) {
    const gesture = trace.meta.gesture;
    const expectMotion = EXPECT_MOTION[gesture];

    test(`${gesture} — ${trace.meta.description} (${file})`, async ({ page }) => {
      test.skip(
        expectMotion === undefined,
        `no EXPECT_MOTION entry for gesture "${gesture}" — add one before trusting this replay`,
      );
      // A real one-finger drag has genuine damped momentum (OrbitControls'
      // enableDamping), which keeps rendering frames for a while after the
      // last input event. On a runner with no GPU adapter for the browser
      // (forcing the fully-software WebGL fallback) that tail was measured
      // locally at 48s to 90s for oneFingerDrag across repeated runs, well
      // past this file's default per-test budget and with enough variance
      // to want headroom past the worse of the two. Widened here, not
      // globally, so a fast GPU-backed runner just finishes early instead.
      test.setTimeout(180_000);

      await page.goto('/?test=1');
      await dropTinyPly(page);
      await expect(page.locator('.olv-empty')).toBeHidden({ timeout: 20_000 });
      await settledPose(page);

      const before = await readPose(page);

      const box = await page.locator('.olv-canvas').boundingBox();
      if (!box) throw new Error('no canvas bounding box');
      await replayTrace(page, trace, box);
      await page.waitForTimeout(700);

      const after = await readPose(page);
      if (expectMotion) {
        expect(after, `${gesture} was recorded on iOS as motion but the replay left the camera unchanged`).not.toBe(before);
      } else {
        expect(after, `${gesture} was recorded on iOS as a dead-zone no-op but the replay moved the camera`).toBe(before);
      }
    });
  }
});
