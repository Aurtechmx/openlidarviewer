#!/usr/bin/env node
/**
 * discover-cells.mjs — which simulator to build, on whatever image this runs.
 *
 * `ios-simulator.yml` names a fixed device and gets whatever runtime the
 * default Xcode on `macos-latest` happens to carry. This leg is asking a
 * different question — does ANY image/runtime combination render WebGL
 * without the host's paravirtual GPU crashing? — so it cannot pin a runtime
 * either: each hosted image ships its own set, and that set changes as
 * GitHub rolls images forward. The set is read from the image itself, with
 * `xcrun simctl list runtimes -j`, and three points across it are kept —
 * oldest, middle, newest — rather than every runtime, so a five-runtime
 * image costs the same three cells as a three-runtime one.
 *
 * A runtime alone is not bootable; `simctl create` also wants a device type,
 * and only the ones in that runtime's own `supportedDeviceTypes` are legal.
 * The newest iPhone in that list is taken, by the same numeric-generation
 * comparison `pick-ios-simulator.mjs` uses for already-booted devices — a
 * plain string sort would rank "iPhone 9" above "iPhone 17".
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { generationOf } from '../pick-ios-simulator.mjs';
import { isCliEntry } from '../lib/isCliEntry.mjs';

/** `"18.5"` -> `[18, 5]`, for a numeric (not lexical) version compare. */
function versionParts(v) {
  return String(v ?? '0').split('.').map((n) => Number.parseInt(n, 10) || 0);
}

function compareVersions(a, b) {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** The best iPhone device type a runtime offers, or its first device type. */
export function pickDeviceType(runtime) {
  const types = (runtime.supportedDeviceTypes ?? [])
    .filter((d) => d && typeof d.identifier === 'string' && typeof d.name === 'string');
  const phones = types.filter((d) => d.name.startsWith('iPhone'));
  const pool = phones.length > 0 ? phones : types;
  if (pool.length === 0) return null;
  return [...pool].sort((a, b) =>
    generationOf(b.name) - generationOf(a.name) || b.name.localeCompare(a.name))[0];
}

/**
 * Up to `max` runtimes from `listing` (the parsed `simctl list runtimes -j`
 * object), spread across the image's own range rather than clustered at one
 * end, each paired with the device type it should boot.
 *
 * Only `isAvailable` iOS runtimes are considered — a runtime Xcode lists but
 * has not finished installing cannot boot a device, and a cell that tried
 * would be reporting a download failure, not a rendering one.
 */
export function pickCells(listing, max = 3) {
  const runtimes = (listing.runtimes ?? [])
    .filter((r) => r && r.isAvailable !== false)
    .filter((r) => /ios/i.test(r.platform ?? r.name ?? r.identifier ?? ''))
    .sort((a, b) => compareVersions(a.version, b.version));

  if (runtimes.length === 0) return [];

  const indices = new Set();
  indices.add(0);
  indices.add(runtimes.length - 1);
  indices.add(Math.floor((runtimes.length - 1) / 2));
  const chosen = [...indices].sort((a, b) => a - b).slice(0, max).map((i) => runtimes[i]);

  return chosen
    .map((runtime) => {
      const deviceType = pickDeviceType(runtime);
      if (!deviceType) return null;
      return {
        runtimeId: runtime.identifier,
        runtimeName: runtime.name,
        runtimeVersion: runtime.version,
        deviceTypeId: deviceType.identifier,
        deviceTypeName: deviceType.name,
      };
    })
    .filter((cell) => cell !== null);
}

function main() {
  const raw = process.argv.includes('--stdin')
    ? readFileSync(0, 'utf8')
    : execFileSync('xcrun', ['simctl', 'list', 'runtimes', '-j'], { encoding: 'utf8' });
  const cells = pickCells(JSON.parse(raw));
  process.stdout.write(`${JSON.stringify(cells, null, 2)}\n`);
  if (cells.length === 0) {
    process.stderr.write('no available iOS runtime on this image has a usable device type\n');
    process.exitCode = 1;
  }
}

if (isCliEntry(import.meta.url)) main();
