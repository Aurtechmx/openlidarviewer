#!/usr/bin/env node
/**
 * ios-touch-check.mjs — OLV's surfaces, exercised by iOS rather than by a page.
 *
 * Every other touch check in this repository synthesizes `PointerEvent`s and
 * dispatches them at the canvas. That verifies the recogniser's arithmetic and
 * nothing about the platform: the events never leave JavaScript, so a browser
 * that delivered touches differently, or refused them, would still pass.
 *
 * Here the two fingers are moved by XCUITest through the simulator, so the
 * events are the ones iOS actually produces in Mobile Safari. What is being
 * tested is not the recogniser — that is already covered on four projects —
 * but whether the platform delivers to it at all.
 *
 * WHAT THIS DOES NOT ESTABLISH. A simulator is not a phone. The touches are
 * injected rather than sensed, so this says nothing about a digitizer, palm
 * rejection, or the timing of a real finger. It is a step closer than a
 * dispatched event, not a substitute for a device.
 *
 * Speaks the W3C WebDriver protocol over HTTP directly, with no client
 * library: one request per command is easier to read in a CI log than a
 * framework's abstraction, and adds no dependency to install.
 *
 * `node:http` rather than `fetch`. Node's `fetch` gives up on a response whose
 * headers take longer than five minutes, and creating a session answers only
 * once WebDriverAgent is running, which on a cold runner is longer than that.
 * The request then fails as a bare "fetch failed" while Appium is still
 * working normally.
 */
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';

const APPIUM = process.env.OLV_APPIUM ?? 'http://127.0.0.1:4723';
const BASE = process.env.OLV_BASE_URL ?? 'http://127.0.0.1:4173';
const DEVICE = process.env.OLV_SIM_DEVICE ?? 'iPhone 16';
const UDID = process.env.OLV_SIM_UDID ?? '';

/** The pose read, as a string so two reads compare with `!==`. */
const POSE = 'return JSON.stringify(window.__OLV_TEST_API__.getCameraPose());';

const steps = [];
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
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

/** Run `script` in the page and return its value. */
const evaluate = (sid, script, args = []) =>
  wd('POST', `/session/${sid}/execute/sync`, { script, args });

/**
 * Run an async `script`, which must call the callback WebDriver appends as its
 * last argument. `execute/sync` returns a promise object rather than awaiting
 * it, so anything that has to finish before the next command goes here.
 */
const evaluateAsync = (sid, script, args = []) =>
  wd('POST', `/session/${sid}/execute/async`, { script, args });

async function main() {
  let sid = null;
  try {
    const alwaysMatch = {
      platformName: 'iOS',
      'appium:automationName': 'XCUITest',
      'appium:deviceName': DEVICE,
      'appium:browserName': 'Safari',
      'appium:newCommandTimeout': 180,
      // The simulator reaches the host's loopback directly, so no tunnel.
      'appium:safariInitialUrl': `${BASE}/?test=1`,
      'appium:webviewConnectTimeout': 60000,
      // WebDriverAgent is compiled by xcodebuild on the first session, and a
      // cold compile on a fresh runner takes minutes. Appium's default wait is
      // 60 s, so the session failed on a refused connection to a WDA that was
      // still building. The log could not say so, because xcodebuild output is
      // suppressed unless it errors; showing it makes the next failure explain
      // itself.
      'appium:wdaLaunchTimeout': 360000,
      'appium:wdaConnectionTimeout': 360000,
      'appium:wdaStartupRetries': 2,
      'appium:wdaStartupRetryInterval': 20000,
      'appium:showXcodeLog': true,
      // The driver re-checks that the simulator finished booting and allows
      // two minutes by default. On a loaded runner, after the WebDriverAgent
      // build, that check has run out while the device was still settling.
      'appium:simulatorStartupTimeout': 600000,
    };
    // Only pin the udid when the workflow resolved one; an empty string would
    // match no device and the failure would name the capability, not the cause.
    if (UDID) alwaysMatch['appium:udid'] = UDID;

    const created = await wd('POST', '/session', { capabilities: { alwaysMatch } });
    sid = created.sessionId;
    if (!sid) throw new Error('Appium returned no sessionId');
    record('session created', true, `device=${DEVICE}`);

    await wd('POST', `/session/${sid}/url`, { url: `${BASE}/?test=1` });
    record('navigated', true, `${BASE}/?test=1`);

    // Collect uncaught errors from here on. Installed before anything is
    // driven, and read at the end: without this the error check would report
    // an empty array whatever happened, which is worse than not checking.
    await evaluate(sid, `
      window.__olvErrors = [];
      window.addEventListener('error', (e) => window.__olvErrors.push(String(e.message)));
      window.addEventListener('unhandledrejection', (e) => window.__olvErrors.push('unhandled: ' + String(e.reason)));
      return true;
    `);

    // The seam must be armed, or the pose oracle reads nothing and every
    // assertion below would be vacuous.
    // Polled, because navigation returns once the document loads, and the
    // app mounts the seam later, after its own modules run. A single read
    // races that and reports the seam missing from a build that has it.
    let seam = false;
    for (let i = 0; i < 60 && seam !== true; i++) {
      seam = await evaluate(sid, 'return !!window.__OLV_TEST_API__;');
      if (seam !== true) await new Promise((r) => setTimeout(r, 500));
    }
    record('test seam armed', seam === true, String(seam));
    if (seam !== true) throw new Error('__OLV_TEST_API__ absent — was OLV_TEST_SEAM set at build time?');

    // Safari's driver starts with an async-script timeout of a few
    // milliseconds, so a script that awaits a fetch and a parse is abandoned
    // before it can answer. Set it explicitly to cover loading the scan.
    await wd('POST', `/session/${sid}/timeouts`, { script: 60000 });

    // A scan, fetched and handed to the app's file input: the same path the
    // desktop specs drive with setInputFiles.
    const dropResult = await evaluateAsync(sid, `
      const done = arguments[arguments.length - 1];
      (async () => {
        const r = await fetch('/samples/tiny.las');
        const buf = await r.arrayBuffer();
        const dt = new DataTransfer();
        dt.items.add(new File([buf], 'tiny.las', { type: 'application/octet-stream' }));
        // Through the file input the desktop specs use. Safari's DragEvent
        // constructor does not attach a scripted dataTransfer, so a synthetic
        // drop there arrives with no files.
        const input = document.querySelector('.olv-file-input');
        if (!input) { done('ERR: no .olv-file-input'); return; }
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        done(true);
      })().catch((e) => done('ERR: ' + e.message));
    `);

    // The canvas exists from boot, before any file, so its presence proves
    // nothing about a load. What a load leaves behind is the drop resolving
    // and the empty-state panel going away; a failed fetch returns 'ERR: …'.
    // Polled: parsing runs in a worker, and a cold simulator takes longer
    // than any fixed wait that would be comfortable on a desktop.
    let loaded = false;
    for (let i = 0; i < 120 && loaded !== true && dropResult === true; i++) {
      loaded = await evaluate(sid, `
        const e = document.querySelector('.olv-empty');
        return !e || e.offsetParent === null || getComputedStyle(e).display === 'none';
      `);
      if (loaded !== true) await new Promise((r) => setTimeout(r, 500));
    }
    record('scan loaded', dropResult === true && loaded === true,
      `drop=${String(dropResult)} emptyStateHidden=${loaded}`);
    if (dropResult !== true || loaded !== true) throw new Error('the scan did not load, so nothing below would test anything');

    const before = await evaluate(sid, POSE);
    const poseOk = typeof before === 'string' && before.length > 2;
    record('pose read before gesture', poseOk, before);
    if (!poseOk) throw new Error('no pose to compare against');

    // The gesture, injected by iOS. Two pointers, moved apart: a pinch the
    // recogniser should read as zoom. Coordinates are viewport points taken
    // from the canvas rect, so the device size does not have to be assumed.
    const rect = JSON.parse(await evaluate(sid, `
      const c = document.querySelector('canvas');
      const r = c.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });
    `));
    const cx = rect.x + Math.round(rect.w / 2);
    const cy = rect.y + Math.round(rect.h / 2);

    // WebDriverAgent resolves the target app before it synthesises any touch,
    // and by default does so by snapshotting Safari's whole accessibility
    // tree, web content included. With the viewer's page loaded that snapshot
    // never finished: the log showed one "Requesting snapshot of accessibility
    // hierarchy" every five seconds for forty seconds, after which Safari was
    // gone and the remote debugger lost it. Coordinate actions only need the
    // application frame, so the snapshot is capped at the top of the tree and
    // the idle waits, which spin on the same busy app, are switched off.
    await wd('POST', `/session/${sid}/appium/settings`, {
      settings: { snapshotMaxDepth: 1, waitForIdleTimeout: 0, animationCoolOffTimeout: 0 },
    });

    const pinchStart = Date.now();
    await wd('POST', `/session/${sid}/actions`, {
      actions: [
        {
          type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: cx - 40, y: cy },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerMove', duration: 400, x: cx - 120, y: cy },
            { type: 'pointerUp', button: 0 },
          ],
        },
        {
          type: 'pointer', id: 'finger2', parameters: { pointerType: 'touch' },
          actions: [
            { type: 'pointerMove', duration: 0, x: cx + 40, y: cy },
            { type: 'pointerDown', button: 0 },
            { type: 'pause', duration: 80 },
            { type: 'pointerMove', duration: 400, x: cx + 120, y: cy },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    });
    record('two-finger pinch dispatched by iOS', true, `centre=${cx},${cy} took=${Date.now() - pinchStart}ms`);

    // If Safari does not survive the gesture, the next page call fails with a
    // remote-debugger error that names neither the app state nor the screen.
    // These two say which app is in front and what the device shows.
    try {
      const info = await wd('POST', `/session/${sid}/execute/sync`, { script: 'mobile: activeAppInfo', args: [] });
      console.log(`active app after pinch: ${JSON.stringify(info)}`);
    } catch (e) { console.log(`active app after pinch: unavailable (${e.message})`); }
    try {
      const png = await wd('GET', `/session/${sid}/screenshot`);
      writeFileSync('ios-after-pinch.png', Buffer.from(png, 'base64'));
    } catch (e) { console.log(`screenshot after pinch: unavailable (${e.message})`); }

    await new Promise((r) => setTimeout(r, 1200));
    const after = await evaluate(sid, POSE);
    const moved = before !== after;
    record('camera moved', moved, moved ? 'pose changed' : `unchanged: ${after}`);

    // ── The rest of the application, on the same device ────────────────────
    // A gesture proving the touch stack says nothing about whether the tools
    // behind it work on a phone. Each check below drives one surface through
    // the seam the desktop suites already use, so a failure here is the same
    // failure they would report rather than a mobile-only assertion.

    // Orbit: one finger, which is a different recogniser path from the pinch.
    const beforeOrbit = await evaluate(sid, POSE);
    await wd('POST', `/session/${sid}/actions`, {
      actions: [{
        type: 'pointer', id: 'finger1', parameters: { pointerType: 'touch' },
        actions: [
          { type: 'pointerMove', duration: 0, x: cx, y: cy },
          { type: 'pointerDown', button: 0 },
          { type: 'pause', duration: 60 },
          { type: 'pointerMove', duration: 350, x: cx + 90, y: cy + 40 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    });
    await new Promise((r) => setTimeout(r, 900));
    record('single-finger orbit moves the camera', (await evaluate(sid, POSE)) !== beforeOrbit);

    // Measurement: place two points and confirm the controller kept them.
    const measured = await evaluate(sid, `
      const api = window.__OLV_TEST_API__;
      api.clearMeasurements();
      api.setMeasureMode(true);
      api.setMeasureKind('distance');
      api.placeMeasurementPoint({ x: 0, y: 0, z: 0 });
      api.placeMeasurementPoint({ x: 5, y: 0, z: 0 });
      api.finishMeasurement();
      const n = api.getMeasurementCount();
      api.setMeasureMode(false);
      return n;
    `);
    record('measurement records a distance', measured >= 1, `count=${measured}`);

    // Elevation filter: a window, then cleared. The seam exists to confirm
    // points outside it hide, so the check is that neither call throws and
    // the app still renders afterwards.
    const filtered = await evaluate(sid, `
      const api = window.__OLV_TEST_API__;
      api.setElevationFilter([0, 1]);
      api.setElevationFilter(null);
      return !!document.querySelector('canvas');
    `);
    // No seam reports which points are visible, so this cannot claim the filter
    // hid anything. It checks the narrower thing it can: both calls are
    // accepted on this device and the page is still rendering afterwards.
    record('elevation filter seam accepts a window and a clear', filtered === true);

    // Classification: seed a uniform class, read one back, then undo.
    const classed = await evaluate(sid, `
      const api = window.__OLV_TEST_API__;
      const n = api.seedUniformClass(2);
      const at = api.classAt(0);
      return JSON.stringify({ n, at });
    `);
    const classInfo = JSON.parse(classed);
    record('classification seam answers', classInfo.n > 0 && classInfo.at === 2, classed);

    // The mobile shell: the panels live in a bottom sheet at this width, and
    // every tab must be reachable or the tools above cannot be driven by hand.
    const sheet = await evaluate(sid, `
      const tabs = [...document.querySelectorAll('.olv-msheet-tab')].map((t) => t.textContent.trim());
      return JSON.stringify(tabs);
    `);
    const tabs = JSON.parse(sheet);
    record('mobile sheet exposes its tabs', tabs.length >= 3, sheet);

    // Nothing threw while all of that ran.
    const errors = await evaluate(sid, 'return JSON.stringify(window.__olvErrors || []);');
    const errorList = JSON.parse(errors);
    record('no uncaught page errors', errorList.length === 0, errors);

    writeFileSync('ios-touch-result.json', `${JSON.stringify({ device: DEVICE, before, after, moved, steps }, null, 2)}\n`);
    if (!steps.every((s) => s.ok)) process.exitCode = 1;
  } catch (err) {
    record('run', false, err instanceof Error ? err.message : String(err));
    writeFileSync('ios-touch-result.json', `${JSON.stringify({ device: DEVICE, steps }, null, 2)}\n`);
    process.exitCode = 1;
  } finally {
    if (sid) await wd('DELETE', `/session/${sid}`).catch(() => {});
  }
}

await main();
