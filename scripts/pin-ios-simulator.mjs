#!/usr/bin/env node
/**
 * pin-ios-simulator.mjs — resolve one exact runtime/device pair, or refuse.
 *
 * `ios-simulator.yml` used to run on whatever iPhone generation
 * `macos-latest` happened to ship, resolving the newest one present. L13 traces its crash to the host's paravirtual GPU
 * (SimMetalHost) dying when Safari draws WebGL, and run 35823332517 verified
 * that macos-26-intel's iOS 26.5 / iPhone 17e pairing survives to a rendered
 * frame. Falling back to the newest iPhone present, or to whatever runtime
 * an image defaults to, would silently put the leg back on a pairing nobody
 * has verified — quite possibly one of the crashing ones L13 already found.
 * So there is no fallback here: a runtime or device this image does not have
 * fails the job, naming what was wanted and listing what the image offers
 * instead, rather than surfacing as a confusing failure steps later.
 *
 * Reads `xcrun simctl list -j` (unrestricted, so `runtimes` and `devices`
 * come back in the same document) on stdin with `--stdin`, or runs it.
 * Prints `udid|name` on success.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { isCliEntry } from './lib/isCliEntry.mjs';

const WANT_RUNTIME = process.env.OLV_WANT_RUNTIME ?? 'iOS 26.5';
const WANT_DEVICE = process.env.OLV_WANT_DEVICE ?? 'iPhone 17e';

/**
 * The exact device a pinned run must use, or `{ error }` describing what
 * this image has instead of `wantRuntime`/`wantDevice`. Both must match by
 * exact name; nothing here is fuzzy or falls back to a runner's default.
 */
export function pinSimulator(listing, wantRuntime = WANT_RUNTIME, wantDevice = WANT_DEVICE) {
  const runtimes = (listing.runtimes ?? []).filter((r) => r && r.isAvailable !== false);
  const runtime = runtimes.find((r) => r.name === wantRuntime);
  if (!runtime) {
    const have = runtimes.map((r) => r.name).join(', ') || '(none)';
    return { error: `runtime "${wantRuntime}" is not on this image — it has: ${have}` };
  }

  const devices = (listing.devices?.[runtime.identifier] ?? [])
    .filter((d) => d && d.isAvailable !== false && typeof d.udid === 'string');
  const device = devices.find((d) => d.name === wantDevice);
  if (!device) {
    const have = devices.map((d) => d.name).join(', ') || '(none)';
    return { error: `device "${wantDevice}" is not available under runtime "${wantRuntime}" on this image — it has: ${have}` };
  }

  return { udid: device.udid, name: device.name, runtime: runtime.name };
}

function main() {
  const raw = process.argv.includes('--stdin')
    ? readFileSync(0, 'utf8')
    : execFileSync('xcrun', ['simctl', 'list', '-j'], { encoding: 'utf8' });
  const hit = pinSimulator(JSON.parse(raw));
  if (hit.error) {
    process.stderr.write(`${hit.error}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${hit.udid}|${hit.name}\n`);
}

if (isCliEntry(import.meta.url)) main();
