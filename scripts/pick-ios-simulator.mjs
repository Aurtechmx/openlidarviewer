#!/usr/bin/env node
/**
 * pick-ios-simulator.mjs — choose the simulator a run should use.
 *
 * Naming a device in the workflow makes the leg fail on someone else's
 * schedule: the GitHub runner image ships a different iPhone generation every
 * few months, and a pinned `iPhone 16` goes red the day it is replaced. The
 * name is resolved here instead, against what the image actually offers.
 *
 * A requested name wins when the image has it, so a run can still target one
 * device deliberately. Otherwise the newest iPhone present is taken, by
 * comparing the numeric part of the name rather than sorting as text: a plain
 * sort puts `iPhone 9` after `iPhone 17`, which would quietly pick the oldest
 * device on an image that still carried one.
 *
 * Lives in a file rather than inline in the workflow because a multi-line
 * script inside a YAML block scalar has to be indented to stay inside it, and
 * a script that must not be re-indented is one nobody can safely edit.
 *
 * Reads `xcrun simctl list devices available -j` on stdin, or runs it.
 * Prints `udid|name`, or nothing when the image has no iPhone at all.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** Trailing number in a device name, for ordering. `iPhone Air` has none. */
export function generationOf(name) {
  const m = /iPhone\s+(\d+)/.exec(name);
  return m ? Number(m[1]) : -1;
}

/**
 * The device a run should use, or null.
 *
 * `wanted` is matched exactly. Nothing fuzzy: a near-match would boot a
 * device the caller did not ask for and report it as the one they did.
 */
export function pickSimulator(listing, wanted = '') {
  const devices = Object.entries(listing.devices ?? {})
    .filter(([runtime]) => runtime.toLowerCase().includes('ios'))
    .flatMap(([, list]) => list)
    .filter((d) => d && d.isAvailable !== false && typeof d.udid === 'string');

  const want = wanted.trim();
  if (want) {
    const exact = devices.find((d) => d.name === want);
    if (exact) return exact;
  }

  const phones = devices.filter((d) => d.name.startsWith('iPhone'));
  if (phones.length === 0) return null;
  // Newest first: generation, then name, so `17 Pro Max` beats `17`.
  phones.sort((a, b) =>
    generationOf(b.name) - generationOf(a.name) || b.name.localeCompare(a.name));
  return phones[0];
}

function main() {
  const raw = process.argv.includes('--stdin')
    ? readFileSync(0, 'utf8')
    : execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'], { encoding: 'utf8' });
  const hit = pickSimulator(JSON.parse(raw), process.env.WANT ?? '');
  if (!hit) {
    process.stderr.write('no iPhone simulator is available on this image\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write(`${hit.udid}|${hit.name}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) main();
