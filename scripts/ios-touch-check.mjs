#!/usr/bin/env node
/**
 * ios-touch-check.mjs — the touch model, exercised by iOS rather than by a page.
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
 * library: one fetch per command is easier to read in a CI log than a
 * framework's abstraction, and adds no dependency to install.
 */
import { writeFileSync } from 'node:fs';

const APPIUM = process.env.OLV_APPIUM ?? 'http://127.0.0.1:4723';
const BASE = process.env.OLV_BASE_URL ?? 'http://127.0.0.1:4173';
const DEVICE = process.env.OLV_SIM_DEVICE ?? 'iPhone 16';
const UDID = process.env.OLV_SIM_UDID ?? '';

const steps = [];
const record = (name, ok, detail) => {
  steps.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

/** One WebDriver command. Throws with the server's own message on failure. */
async function wd(method, path, body) {
  const res = await fetch(`${APPIUM}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const msg = json?.value?.message ?? json?.raw ?? res.statusText;
    throw new Error(`${method} ${path} -> ${res.status}: ${msg}`);
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

    // The seam must be armed, or the pose oracle reads nothing and every
    // assertion below would be vacuous.
    const seam = await evaluate(sid, 'return !!window.__OLV_TEST_API__;');
    record('test seam armed', seam === true, String(seam));
    if (seam !== true) throw new Error('__OLV_TEST_API__ absent — was OLV_TEST_SEAM set at build time?');

    // A scan, loaded the only way a phone can: fetched and dropped, which is
    // the same path the desktop specs drive.
    await evaluateAsync(sid, `
      const done = arguments[arguments.length - 1];
      (async () => {
        const r = await fetch('/samples/tiny.las');
        const buf = await r.arrayBuffer();
        const dt = new DataTransfer();
        dt.items.add(new File([buf], 'tiny.las', { type: 'application/octet-stream' }));
        for (const t of ['dragenter', 'dragover', 'drop']) {
          document.body.dispatchEvent(new DragEvent(t, { bubbles: true, cancelable: true, dataTransfer: dt }));
        }
        done(true);
      })().catch((e) => done('ERR: ' + e.message));
    `);
    await new Promise((r) => setTimeout(r, 6000));

    const loaded = await evaluate(sid, 'return !!document.querySelector("canvas");');
    record('scan loaded', loaded === true, `canvas=${loaded}`);

    const before = await evaluate(sid, 'return JSON.stringify(window.__OLV_TEST_API__.getCameraPose());');
    record('pose read before gesture', typeof before === 'string' && before.length > 2, before);

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
    record('two-finger pinch dispatched by iOS', true, `centre=${cx},${cy}`);

    await new Promise((r) => setTimeout(r, 1200));
    const after = await evaluate(sid, 'return JSON.stringify(window.__OLV_TEST_API__.getCameraPose());');
    const moved = before !== after;
    record('camera moved', moved, moved ? 'pose changed' : `unchanged: ${after}`);

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
