/**
 * verify-input-manifest.mjs — check the E5 input manifests are immutable,
 * self-consistent scientific inputs, not editable notes.
 *
 * For each manifest the verifier confirms: the exact expected tile count; every
 * tile carries a 64-hex sha256, a positive byte size, a point count, and a
 * non-null horizontal/vertical EPSG, vertical datum and geoid; no basename or
 * derived tileId repeats; the recorded collectionDigest recomputes from the
 * per-tile sha256 list with the same formula the generator used (sha256 of
 * `${basename}:${sha256}` lines, tiles sorted by basename); the homogeneity
 * claim matches the members (homogeneousFrame ⇔ one horizontalEpsg + one
 * verticalEpsg + one geoidModel); the geoid summary equals the set of member
 * geoids; and the creation-vs-acquisition separation holds — every tile has a
 * fileCreationYear, no tile still carries a captureYear, acquisitionYear is
 * present (possibly null) with an acquisitionDateSource, and the summary never
 * relabels a creation year as an acquisition year.
 *
 * A missing manifest file is a loud failure, never a silent pass.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isCliEntry } from '../lib/isCliEntry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MANIFEST_DIR = resolve(HERE, '../../validation/e5/manifests');

/** The collections this gate pins, with the tile count each must carry. */
export const EXPECTED = {
  ROGUE25: { file: 'ROGUE25.input.json', expectedCount: 25 },
  HOUSTON17: { file: 'HOUSTON17.input.json', expectedCount: 17 },
};

const HEX64 = /^[0-9a-f]{64}$/;

/** tileId is the last underscore-delimited token of the basename (sans .la[sz]). */
export function tileIdOf(basename) {
  const stem = String(basename).replace(/\.la[sz]$/i, '');
  const parts = stem.split('_');
  return parts[parts.length - 1];
}

/** The generator's digest: sha256 over `${basename}:${sha256}` lines, sorted by basename. */
export function collectionDigestOf(tiles) {
  const sorted = [...tiles].sort((a, b) => a.basename.localeCompare(b.basename));
  return createHash('sha256')
    .update(sorted.map((t) => `${t.basename}:${t.sha256}`).join('\n'))
    .digest('hex');
}

/**
 * Check one parsed manifest. Returns { ok, errors[], summary }. Pure: no I/O,
 * so tests can feed crafted objects.
 */
export function verifyManifest(manifest, { expectedCount } = {}) {
  const errors = [];
  const fail = (m) => errors.push(m);

  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: ['manifest is not an object'], summary: null };
  }
  const tiles = Array.isArray(manifest.tiles) ? manifest.tiles : null;
  if (!tiles) {
    return { ok: false, errors: ['tiles[] is missing or not an array'], summary: null };
  }
  const summary = manifest.summary;
  if (!summary || typeof summary !== 'object') fail('summary is missing or not an object');

  // Exact tile count.
  if (typeof expectedCount === 'number' && tiles.length !== expectedCount) {
    fail(`tile count ${tiles.length} ≠ expected ${expectedCount}`);
  }
  if (summary && summary.tileCount !== tiles.length) {
    fail(`summary.tileCount ${summary.tileCount} ≠ tiles.length ${tiles.length}`);
  }

  // Per-tile fields + duplicate detection.
  const basenames = new Set();
  const tileIds = new Set();
  for (const t of tiles) {
    const b = t.basename ?? '(no basename)';
    if (!t.basename) fail('a tile has no basename');
    else {
      if (basenames.has(t.basename)) fail(`duplicate basename: ${t.basename}`);
      basenames.add(t.basename);
      const id = tileIdOf(t.basename);
      if (tileIds.has(id)) fail(`duplicate tileId: ${id} (from ${t.basename})`);
      tileIds.add(id);
    }
    if (typeof t.sha256 !== 'string' || !HEX64.test(t.sha256)) fail(`${b}: sha256 is not 64-hex`);
    if (!(Number.isInteger(t.bytes) && t.bytes > 0)) fail(`${b}: bytes must be a positive integer`);
    if (!Number.isInteger(t.pointCount)) fail(`${b}: pointCount must be an integer`);
    if (t.horizontalEpsg == null) fail(`${b}: horizontalEpsg is null`);
    if (t.verticalEpsg == null) fail(`${b}: verticalEpsg is null`);
    if (t.verticalDatum == null || t.verticalDatum === '') fail(`${b}: verticalDatum is null`);
    if (t.geoidModel == null || t.geoidModel === '') fail(`${b}: geoidModel is null`);

    // Creation-vs-acquisition separation.
    if (!Number.isInteger(t.fileCreationYear)) fail(`${b}: fileCreationYear must be an integer`);
    if ('captureYear' in t) fail(`${b}: forbidden captureYear leftover (use fileCreationYear/acquisitionYear)`);
    if (!('acquisitionYear' in t)) fail(`${b}: acquisitionYear is missing (null is allowed)`);
    else if (!(t.acquisitionYear === null || Number.isInteger(t.acquisitionYear))) {
      fail(`${b}: acquisitionYear must be an integer or null`);
    }
    if (typeof t.acquisitionDateSource !== 'string' || t.acquisitionDateSource === '') {
      fail(`${b}: acquisitionDateSource is required`);
    }
  }

  // collectionDigest recomputes.
  if (basenames.size === tiles.length && tiles.every((t) => HEX64.test(String(t.sha256)))) {
    const expected = collectionDigestOf(tiles);
    if (manifest.collectionDigest !== expected) {
      fail(`collectionDigest mismatch: recorded ${manifest.collectionDigest}, recomputed ${expected}`);
    }
  }

  // CRS homogeneity: claim must match the members.
  if (summary) {
    const hEpsg = new Set(tiles.map((t) => t.horizontalEpsg));
    const vEpsg = new Set(tiles.map((t) => t.verticalEpsg));
    const geoids = new Set(tiles.map((t) => t.geoidModel));
    const actuallyHomogeneous = hEpsg.size === 1 && vEpsg.size === 1 && geoids.size === 1;
    if (Boolean(summary.homogeneousFrame) !== actuallyHomogeneous) {
      fail(
        `homogeneousFrame=${summary.homogeneousFrame} but members give ` +
          `${hEpsg.size} horizontalEpsg / ${vEpsg.size} verticalEpsg / ${geoids.size} geoid`,
      );
    }
    // Geoid summary matches the member set.
    if (Array.isArray(summary.geoidModel)) {
      const claimed = new Set(summary.geoidModel);
      const sameSet = claimed.size === geoids.size && [...geoids].every((g) => claimed.has(g));
      if (!sameSet) {
        fail(
          `summary.geoidModel [${[...claimed].join(', ')}] ≠ member geoids [${[...geoids].join(', ')}]`,
        );
      }
    } else {
      fail('summary.geoidModel must be an array');
    }
    // Summary must not relabel creation years as acquisition years.
    if ('captureYears' in summary) fail('summary.captureYears is forbidden');
    if (!Array.isArray(summary.fileCreationYears) || summary.fileCreationYears.length === 0) {
      fail('summary.fileCreationYears must be a non-empty array');
    }
    if (!('acquisitionYears' in summary)) fail('summary.acquisitionYears is missing (may hold null)');
    if (Array.isArray(summary.acquisitionYears) && Array.isArray(summary.fileCreationYears)) {
      const acq = summary.acquisitionYears.filter((y) => y != null);
      const overlap = acq.filter((y) => summary.fileCreationYears.includes(y));
      if (overlap.length > 0) {
        fail(`summary.acquisitionYears relabels creation year(s): ${overlap.join(', ')}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    summary: {
      tiles: tiles.length,
      digestOk: !errors.some((e) => e.includes('collectionDigest')),
      geoids: summary && Array.isArray(summary.geoidModel) ? summary.geoidModel : [],
      homogeneous: summary ? Boolean(summary.homogeneousFrame) : null,
    },
  };
}

/** Read + verify every pinned manifest. Returns true when all pass. */
export function verifyAll(dir = MANIFEST_DIR) {
  let allOk = true;
  for (const [id, { file, expectedCount }] of Object.entries(EXPECTED)) {
    const path = resolve(dir, file);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      console.error(`FAIL ${id}: cannot read manifest ${path} — ${e.message}`);
      allOk = false;
      continue;
    }
    const { ok, errors, summary } = verifyManifest(manifest, { expectedCount });
    if (ok) {
      console.log(
        `PASS ${id}: ${summary.tiles} tiles, digest ok, ` +
          `geoid ${summary.geoids.join('/')}, homogeneousFrame=${summary.homogeneous}`,
      );
    } else {
      allOk = false;
      console.error(`FAIL ${id} (${errors.length} problem(s)):`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  }
  return allOk;
}

if (isCliEntry(import.meta.url)) {
  process.exit(verifyAll() ? 0 : 1);
}
