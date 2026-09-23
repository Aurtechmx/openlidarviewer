#!/usr/bin/env node
/**
 * ios-touch-trace.mjs — records what iOS actually delivers to a touch
 * canvas, on a page that never asks WebGL for a context.
 *
 * scripts/ios-touch-check.mjs already proves the platform CAN deliver a
 * gesture to OLV: it loads the real app and dispatches one pinch. What it
 * cannot finish proving on a GitHub-hosted runner is documented in
 * docs/releases/V070_IMPLEMENTATION_LEDGER.md's L13 entry — the runner's
 * paravirtual GPU driver crashes SimMetalHost when the app renders the frame
 * the pinch resumes, and Safari goes down with it. That crash is triggered by
 * WebGL, not by touch.
 *
 * This script drives probe.html instead: OLV's real canvas, real CSS
 * (`touch-action: none`), and real gesture recognisers
 * (src/probe/iosTouchProbe.ts imports touchTracker.ts / touchGesture.ts /
 * touchTapGate.ts directly), with no `<canvas>` ever asked for a rendering
 * context. Seven named gestures are dispatched through XCUITest, each
 * checked against the probe's own log for: no page zoom
 * (`visualViewport.scale` unchanged), no scroll, no `touchcancel` mid-
 * gesture, and a recogniser verdict matching what the gesture should
 * produce. If Safari still went down here, that would say the GPU-driver
 * theory in L13 was wrong — nothing below touches a renderer.
 *
 * DOUBLE-TAP IS NOT VERIFIED ON iOS BY THIS INSTRUMENT. WebDriverAgent
 * delivers a fast down/up/pause/down/up on one pointer id as two overlapping
 * touch identifiers plus a drift off the original point, not two clean taps
 * — see scripts/lib/doubleTapClassifier.mjs's header and
 * tests/fixtures/ios-traces/README.md. `runGesture`'s doubleTap call routes
 * through that classifier rather than a plain pass/fail: the characterised
 * artifact reads as `unverified: instrument limitation`, never a pass and
 * never a step failure; a genuine `doubletap` event now firing fails the
 * step loudly, because it would mean the artifact this module documents is
 * gone and the classification needs revisiting.
 *
 * A sibling of ios-touch-check.mjs rather than an extension of it: the two
 * scripts drive different pages for different reasons, and duplicating the
 * ~40-line WebDriver transport here keeps this file safe to change without
 * re-risking the touch check that already passes today.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { classifyDoubleTap } from './lib/doubleTapClassifier.mjs';

const APPIUM = process.env.OLV_APPIUM ?? 'http://127.0.0.1:4723';
const BASE = process.env.OLV_BASE_URL ?? 'http://127.0.0.1:4173';
const DEVICE = process.env.OLV_SIM_DEVICE ?? 'iPhone 16';
const UDID = process.env.OLV_SIM_UDID ?? '';
const RUN_ID = process.env.OLV_RUN_ID ?? 'local';
const OUT_DIR = 'ios-touch-traces';

mkdirSync(OUT_DIR, { recursive: true });

const steps = [];
let doubleTapClassification = null;

/**
 * `status` defaults from `ok` (`'pass'` / `'fail'`) but can be overridden to
 * `'unverified'` — the doubleTap instrument-limitation case: never `ok:true`,
 * never counted as a pass, but also not counted as a step failure. Only
 * `status === 'fail'` can flip the run's exit code; see the bottom of `main`.
 */
const record = (name, ok, detail, status = ok ? 'pass' : 'fail') => {
  steps.push({ name, ok, status, detail });
  const label = status === 'unverified' ? 'SKIP' : ok ? 'ok  ' : 'FAIL';
  console.log(`${label}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** One WebDriver command. Throws with the server's own message on failure. */
async function wd(method, path, body) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { status, text } = await new Promise((resolve, reject) => {
    const req = request(`${APPIUM}${path}`, {
      method,
      headers: payload === undefined
        ? {}
        : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (status < 200 || status >= 300) {
    const msg = json?.value?.message ?? json?.raw ?? `HTTP ${status}`;
    throw new Error(`${method} ${path} -> ${status}: ${msg}`);
  }
  return json.value;
}

const evaluate = (sid, script, args = []) =>
  wd('POST', `/session/${sid}/execute/sync`, { script, args });

/**
 * The iOS runtime and Xcode version behind `DEVICE`/`UDID`, read the same way
 * scripts/pick-ios-simulator.mjs reads the device list. Best-effort: a trace
 * fixture with an unlabelled runtime is still useful, so failures here fall
 * back to 'unknown' rather than aborting the run.
 */
function hostEnvironment() {
  let iosRuntime = 'unknown';
  try {
    const listing = JSON.parse(
      execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' }),
    );
    for (const [runtime, list] of Object.entries(listing.devices ?? {})) {
      if (list.some((d) => d.udid === UDID)) { iosRuntime = runtime; break; }
    }
  } catch { /* best-effort */ }
  let xcodeVersion = 'unknown';
  try {
    xcodeVersion = execFileSync('xcodebuild', ['-version'], { encoding: 'utf8' }).trim().split('\n')[0];
  } catch { /* best-effort */ }
  return {
    iosRuntime,
    xcodeVersion,
    runnerImage: process.env.ImageOS ?? 'macos-latest',
  };
}

/**
 * One two-pointer W3C actions gesture: `fromA`/`fromB` to `toA`/`toB` over
 * `steps` ticks. Mirrors the coordinate shape tests/e2e/touchGesture.spec.ts
 * dispatches in Playwright, so a fixture recorded here and one recorded
 * there describe the same intended motion.
 */
function twoFingerActions(fromA, fromB, toA, toB, moveMs = 400) {
  const leg = (from, to) => [
    { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
    { type: 'pointerDown', button: 0 },
    { type: 'pause', duration: 80 },
    { type: 'pointerMove', duration: moveMs, x: to.x, y: to.y },
    { type: 'pointerUp', button: 0 },
  ];
  return [
    { type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' }, actions: leg(fromA, toA) },
    { type: 'pointer', id: 'finger2', parameters: { pointerType: 'touch' }, actions: leg(fromB, toB) },
  ];
}

function oneFingerActions(from, to, moveMs = 350) {
  return [{
    type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x: from.x, y: from.y },
      { type: 'pointerDown', button: 0 },
      { type: 'pause', duration: 60 },
      { type: 'pointerMove', duration: moveMs, x: to.x, y: to.y },
      { type: 'pointerUp', button: 0 },
    ],
  }];
}

function doubleTapActions(at, gapMs = 120) {
  return [{
    type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
    actions: [
      { type: 'pointerMove', duration: 0, x: at.x, y: at.y },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
      { type: 'pause', duration: gapMs },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ],
  }];
}

async function main() {
  let sid = null;
  const traces = [];
  try {
    const alwaysMatch = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': DEVICE,
      'appium:browserName': 'Safari',
      'appium:newCommandTimeout': 180,
      'appium:safariInitialUrl': `${BASE}/probe.html`,
      'appium:webviewConnectTimeout': 60000,
      // Same generous timeouts as ios-touch-check.mjs — WebDriverAgent is
      // already built and running by the time this session opens, so these
      // mostly guard against a loaded runner rather than a cold compile.
      'appium:wdaLaunchTimeout': 360000,
      'appium:wdaConnectionTimeout': 360000,
      'appium:wdaStartupRetries': 2,
      'appium:wdaStartupRetryInterval': 20000,
      'appium:simulatorStartupTimeout': 600000,
    };
    if (UDID) alwaysMatch['appium:udid'] = UDID;

    const created = await wd('POST', '/session', { capabilities: { alwaysMatch } });
    sid = created.sessionId;
    if (!sid) throw new Error('Appium returned no sessionId');
    record('session created', true, `device=${DEVICE}`);

    await wd('POST', `/session/${sid}/url`, { url: `${BASE}/probe.html` });
    record('navigated', true, `${BASE}/probe.html`);

    // Same uncaught-error collection as ios-touch-check.mjs: installed
    // before anything is driven, read once at the end.
    await evaluate(sid, `
      window.__olvErrors = [];
      window.addEventListener('error', (e) => window.__olvErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__olvErrors.push('unhandled: ' + String(e.reason)));
      return true;
    `);

    // Polled for the same reason ios-touch-check.mjs polls for
    // __OLV_TEST_API__: navigation returns once the document loads, and the
    // probe module attaches its listeners after its own imports resolve.
    let ready = false;
    for (let i = 0; i < 60 && ready !== true; i++) {
      ready = await evaluate(sid, 'return !!(window.__OLV_PROBE__ && window.__OLV_PROBE__.ready);');
      if (ready !== true) await new Promise((r) => setTimeout(r, 500));
    }
    record('probe armed', ready === true, String(ready));
    if (ready !== true) throw new Error('__OLV_PROBE__ absent — did npm run build:probe run before this?');

    // See scripts/ios-touch-check.mjs's "cap the WebDriverAgent snapshot"
    // step: a snapshot walks the whole accessibility tree before the first
    // touch action, which stalled once on the full app. The probe page has
    // almost no tree, so the stall is unlikely here — applied anyway, since
    // it costs nothing and this script should not be the one that finds out.
    await wd('POST', `/session/${sid}/appium/settings`, {
      settings: { snapshotMaxDepth: 1, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 },
    });

    const rect = JSON.parse(await evaluate(sid, `
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    `));
    const cx = rect.x + Math.round(rect.w / 2);
    const cy = rect.y + Math.round(rect.h / 2);
    const R = Math.max(60, Math.min(140, Math.round(Math.min(rect.w, rect.h) / 3)));

    const env = hostEnvironment();

    /**
     * Reset the probe, dispatch `actions`, settle, then pull the log and
     * check it against what this gesture should have produced.
     *
     * `expectRecognizer` is the component (`'pinch' | 'twist' | 'pan'`) the
     * gesture should fire, with `expectSign` its expected direction; `null`
     * means the gesture should fire NOTHING (a single finger never reaches
     * the two-pointer recogniser at all, and a sub-dead-zone wobble should
     * cross no threshold). `classifyAsDoubleTap` routes the step through
     * scripts/lib/doubleTapClassifier.mjs instead of a plain pass/fail, since
     * whether this instrument can even DELIVER a double-tap is a separate
     * question from whether TouchTracker's two-pointer recogniser behaved.
     */
    async function runGesture(name, description, actions, { expectRecognizer = null, expectSign = 0, classifyAsDoubleTap = false } = {}) {
      await evaluate(sid, 'window.__OLV_PROBE__.reset(); return true;');
      const dispatchedAt = Date.now();
      await wd('POST', `/session/${sid}/actions`, { actions });
      await wd('DELETE', `/session/${sid}/actions`).catch(() => {});
      await new Promise((r) => setTimeout(r, 700));

      const summary = JSON.parse(await evaluate(sid, 'return window.__OLV_PROBE__.getSummary();'));
      const events = JSON.parse(await evaluate(sid, 'return window.__OLV_PROBE__.getLog();'));

      const noZoom = summary.before.visualViewportScale === summary.after.visualViewportScale
        && summary.after.visualViewportScale === 1;
      const noScroll = summary.before.scrollX === summary.after.scrollX
        && summary.before.scrollY === summary.after.scrollY;
      const noTouchCancel = summary.touchcancel === 0;

      const recognizerEvents = events.filter((e) => e.kind === 'recognizer');
      let recognizerAsIntended;
      if (expectRecognizer === null) {
        recognizerAsIntended = recognizerEvents.length === 0;
      } else {
        const field = expectRecognizer === 'pinch' ? 'dPinch' : expectRecognizer === 'twist' ? 'dTwist' : 'dPanX';
        recognizerAsIntended = recognizerEvents.some((e) => {
          const v = e[field];
          return expectSign === 0 ? v !== 0 : Math.sign(v) === expectSign;
        });
      }

      const baseDetail = `zoom=${summary.after.visualViewportScale} scroll=(${summary.after.scrollX},${summary.after.scrollY}) ` +
        `touchcancel=${summary.touchcancel} recognizerEvents=${recognizerEvents.length} pointerEvents=${summary.counts.pointer}`;

      let ok;
      let doubleTap = null;
      if (classifyAsDoubleTap) {
        doubleTap = classifyDoubleTap(events, { noZoom, noScroll, noTouchCancel, recognizerAsIntended });
        doubleTapClassification = doubleTap;
        ok = doubleTap.ok; // always false — see doubleTapClassifier.mjs
        record(name, ok, `${baseDetail} classification=${doubleTap.classification} — ${doubleTap.detail}`, doubleTap.failStep ? 'fail' : 'unverified');
      } else {
        ok = noZoom && noScroll && noTouchCancel && recognizerAsIntended;
        record(name, ok, baseDetail);
      }

      const trace = {
        meta: {
          gesture: name,
          description,
          device: DEVICE,
          udid: UDID,
          iosRuntime: env.iosRuntime,
          xcodeVersion: env.xcodeVersion,
          runnerImage: env.runnerImage,
          runId: RUN_ID,
          recordedAt: new Date(dispatchedAt).toISOString(),
          expectRecognizer,
          expectSign,
        },
        canvasRect: rect,
        before: summary.before,
        after: summary.after,
        counts: summary.counts,
        touchcancel: summary.touchcancel,
        assertions: { noZoom, noScroll, noTouchCancel, recognizerAsIntended },
        ...(doubleTap ? { doubleTap: { classification: doubleTap.classification, detail: doubleTap.detail } } : {}),
        events,
      };
      writeFileSync(`${OUT_DIR}/${name}.json`, `${JSON.stringify(trace, null, 2)}\n`);
      traces.push(trace);
    }

    await runGesture(
      'pinchIn', 'two-finger pinch, fingers converging (zoom in)',
      twoFingerActions({ x: cx - R, y: cy }, { x: cx + R, y: cy }, { x: cx - 30, y: cy }, { x: cx + 30, y: cy }),
      { expectRecognizer: 'pinch', expectSign: -1 },
    );
    await runGesture(
      'pinchOut', 'two-finger pinch, fingers diverging (zoom out)',
      twoFingerActions({ x: cx - 30, y: cy }, { x: cx + 30, y: cy }, { x: cx - R, y: cy }, { x: cx + R, y: cy }),
      { expectRecognizer: 'pinch', expectSign: 1 },
    );
    await runGesture(
      'twist', 'two-finger 90° twist, distance unchanged',
      twoFingerActions({ x: cx - R, y: cy }, { x: cx + R, y: cy }, { x: cx, y: cy - R }, { x: cx, y: cy + R }),
      // Left finger moves to the top, right finger to the bottom:
      // decompose2Pointer's angleOf inverts Y (canvas Y grows downward), so
      // this specific rotation reads as a NEGATIVE angle delta — verified
      // against the real recogniser (touchTracker.ts) with this exact
      // coordinate pair before trusting the sign here.
      { expectRecognizer: 'twist', expectSign: -1 },
    );
    await runGesture(
      'pan', 'two fingers moving together, distance and angle unchanged',
      twoFingerActions({ x: cx - 40, y: cy - 10 }, { x: cx + 40, y: cy - 10 }, { x: cx - 40 + 80, y: cy - 10 + 40 }, { x: cx + 40 + 80, y: cy - 10 + 40 }),
      { expectRecognizer: 'pan' },
    );
    await runGesture(
      'oneFingerDrag', 'single-finger drag — never reaches the two-pointer recogniser',
      oneFingerActions({ x: cx - 60, y: cy }, { x: cx + 60, y: cy + 40 }),
      { expectRecognizer: null },
    );
    await runGesture(
      'doubleTap', 'two single-finger taps at the same point, within the double-tap window',
      doubleTapActions({ x: cx, y: cy }),
      { expectRecognizer: null, classifyAsDoubleTap: true },
    );
    const wobbleAngle = (1 * Math.PI) / 180;
    await runGesture(
      'wobble', 'sub-dead-zone 1° twist — below touchGesture.ts DEFAULT_GESTURE_THRESHOLDS.twistDeadZone',
      twoFingerActions(
        { x: cx - R, y: cy }, { x: cx + R, y: cy },
        { x: cx - R * Math.cos(wobbleAngle), y: cy + R * Math.sin(wobbleAngle) },
        { x: cx + R * Math.cos(wobbleAngle), y: cy - R * Math.sin(wobbleAngle) },
      ),
      { expectRecognizer: null },
    );

    const errors = await evaluate(sid, 'return JSON.stringify(window.__olvErrors || []);');
    const errorList = JSON.parse(errors);
    record('no uncaught page errors', errorList.length === 0, errors);

    writeFileSync(
      `${OUT_DIR}/RESULT.json`,
      `${JSON.stringify({ device: DEVICE, env, runId: RUN_ID, steps, doubleTapClassification }, null, 2)}\n`,
    );
    // A step's own `ok` is never true for the doubleTap instrument-limitation
    // case (see doubleTapClassifier.mjs) — `status` is what decides the run's
    // exit code, so that case cannot fail the run and cannot look like a pass.
    if (steps.some((s) => s.status === 'fail')) process.exitCode = 1;
  } catch (err) {
    record('run', false, err instanceof Error ? err.message : String(err));
    writeFileSync(
      `${OUT_DIR}/RESULT.json`,
      `${JSON.stringify({ device: DEVICE, steps, doubleTapClassification }, null, 2)}\n`,
    );
    process.exitCode = 1;
  } finally {
    if (sid) await wd('DELETE', `/session/${sid}`).catch(() => {});
  }
}

await main();
