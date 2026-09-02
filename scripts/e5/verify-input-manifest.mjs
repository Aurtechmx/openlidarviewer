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
 * geoids; each classHistogram is a plain object of non-negative integers whose
 * values sum to pointCount, with groundPointCount === classHistogram['2'] and
 * (when present) groundPointFraction the ground/point ratio to six decimals;
 * the summary's tilesWithoutGround and allTilesHaveGround are recomputed from
 * the members, not trusted; and the creation-vs-acquisition separation holds —
 * every tile has a fileCreationYear, no tile still carries a captureYear,
 * acquisitionYear is present (possibly null) with an acquisitionDateSource, and
 * the summary never relabels a creation year as an acquisition year.
 *
 * A non-null acquisitionYear must name an authoritative acquisitionDateSource
 * (the WESM provider manifest), never the `not-established` placeholder — a year
 * is only ever recorded when the provider established it.
 *
 * When the WESM acquisition ledger is supplied, the verifier cross-checks it
 * against the manifest: the authoritative horizontal/vertical EPSG and geoid must
 * equal the manifest's single homogeneous frame (this is what proves the Houston
 * collection is work units 1-3 at 6344 / GEOID18, not unit 4 at 6343 / GEOID12B),
 * every tile's acquisitionYear equals the ledger year, and any summary acquisition
 * block agrees with the ledger's window, project id, work units and QL.
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

/** Acquisition sources the gate accepts for a non-null acquisitionYear. */
export const AUTHORITATIVE_ACQ_SOURCES = new Set(['usgs-wesm']);

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
export function verifyManifest(manifest, { expectedCount, wesm } = {}) {
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

    // Class histogram proves the per-tile point tallies.
    const ch = t.classHistogram;
    if (ch == null || typeof ch !== 'object' || Array.isArray(ch)) {
      fail(`${b}: classHistogram must be a plain object`);
    } else {
      const values = Object.values(ch);
      if (!values.every((v) => Number.isInteger(v) && v >= 0)) {
        fail(`${b}: classHistogram values must be non-negative integers`);
      } else if (Number.isInteger(t.pointCount)) {
        const histSum = values.reduce((a, v) => a + v, 0);
        if (histSum !== t.pointCount) {
          fail(`${b}: classHistogram sum ${histSum} ≠ pointCount ${t.pointCount}`);
        }
      }
      const groundFromHist = ch['2'] ?? 0;
      if (t.groundPointCount !== groundFromHist) {
        fail(`${b}: groundPointCount ${t.groundPointCount} ≠ classHistogram['2'] ${groundFromHist}`);
      }
      if (t.groundPointFraction != null) {
        const expected =
          Number.isInteger(t.pointCount) && t.pointCount > 0
            ? Number((groundFromHist / t.pointCount).toFixed(6))
            : 0;
        if (Math.abs(t.groundPointFraction - expected) > 5e-7) {
          fail(`${b}: groundPointFraction ${t.groundPointFraction} ≠ recomputed ${expected}`);
        }
      }
    }

    // Creation-vs-acquisition separation.
    if (!Number.isInteger(t.fileCreationYear)) fail(`${b}: fileCreationYear must be an integer`);
    if ('captureYear' in t) fail(`${b}: forbidden captureYear leftover (use fileCreationYear/acquisitionYear)`);
    if (!('acquisitionYear' in t)) fail(`${b}: acquisitionYear is missing (null is allowed)`);
    else if (!(t.acquisitionYear === null || Number.isInteger(t.acquisitionYear))) {
      fail(`${b}: acquisitionYear must be an integer or null`);
    }
    if (typeof t.acquisitionDateSource !== 'string' || t.acquisitionDateSource === '') {
      fail(`${b}: acquisitionDateSource is required`);
    } else if (Number.isInteger(t.acquisitionYear) && !AUTHORITATIVE_ACQ_SOURCES.has(t.acquisitionDateSource)) {
      // A recorded year must come from an authoritative provider, never the
      // not-established placeholder or any other unestablished source.
      fail(
        `${b}: acquisitionYear ${t.acquisitionYear} needs an authoritative acquisitionDateSource ` +
          `(one of ${[...AUTHORITATIVE_ACQ_SOURCES].join(', ')}), got "${t.acquisitionDateSource}"`,
      );
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

    // Ground coverage: recompute from the members; don't trust the labels.
    const groundless = tiles
      .filter((t) => (t.groundPointCount ?? 0) === 0)
      .map((t) => t.basename)
      .sort((a, b) => String(a).localeCompare(String(b)));
    if ('tilesWithoutGround' in summary) {
      if (!Array.isArray(summary.tilesWithoutGround)) {
        fail('summary.tilesWithoutGround must be an array');
      } else {
        const claimed = new Set(summary.tilesWithoutGround);
        const actual = new Set(groundless);
        const missing = groundless.filter((n) => !claimed.has(n));
        const extra = [...claimed].filter((n) => !actual.has(n));
        if (missing.length > 0 || extra.length > 0) {
          fail(
            `summary.tilesWithoutGround set mismatch: ` +
              `missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]`,
          );
        }
      }
    }
    if ('allTilesHaveGround' in summary) {
      const expected = groundless.length === 0;
      if (summary.allTilesHaveGround !== expected) {
        fail(
          `summary.allTilesHaveGround=${summary.allTilesHaveGround} but ` +
            `${groundless.length} tile(s) lack ground`,
        );
      }
    }
  }

  // WESM ledger cross-check: the authoritative provider frame must equal the
  // manifest's single homogeneous frame, and the recorded acquisition must match
  // the ledger. Only runs when a ledger entry is supplied.
  if (wesm && typeof wesm === 'object') {
    const single = (sel, label, expected) => {
      const set = new Set(tiles.map(sel));
      if (!(set.size === 1 && set.has(expected))) {
        fail(`WESM ${label} mismatch: ledger ${expected}, members [${[...set].join(', ')}]`);
      }
    };
    single((t) => t.horizontalEpsg, 'horizontalEpsg', wesm.horizontalEpsg);
    single((t) => t.verticalEpsg, 'verticalEpsg', wesm.verticalEpsg);
    single((t) => t.geoidModel, 'geoidModel', wesm.geoidModel);

    const ledgerYear = wesm.acquisitionYear ?? null;
    for (const t of tiles) {
      const y = t.acquisitionYear ?? null;
      if (y !== ledgerYear) {
        fail(`${t.basename ?? '(no basename)'}: acquisitionYear ${y} ≠ WESM ledger ${ledgerYear}`);
      }
    }
    if (summary && Array.isArray(summary.acquisitionYears)) {
      const ay = summary.acquisitionYears;
      if (!(ay.length === 1 && (ay[0] ?? null) === ledgerYear)) {
        fail(`summary.acquisitionYears ${JSON.stringify(ay)} ≠ WESM ledger [${ledgerYear}]`);
      }
    }
    const acq = summary && summary.acquisition;
    if (acq && typeof acq === 'object') {
      if (acq.acquisitionSource !== 'usgs-wesm') {
        fail(`summary.acquisition.acquisitionSource must be "usgs-wesm", got "${acq.acquisitionSource}"`);
      }
      if (acq.projectId !== wesm.projectId) {
        fail(`summary.acquisition.projectId ${acq.projectId} ≠ WESM ledger ${wesm.projectId}`);
      }
      if (acq.ql !== wesm.ql) fail(`summary.acquisition.ql "${acq.ql}" ≠ WESM ledger "${wesm.ql}"`);
      if (acq.acquisitionStart !== wesm.collectStart) {
        fail(`summary.acquisition.acquisitionStart "${acq.acquisitionStart}" ≠ WESM ledger "${wesm.collectStart}"`);
      }
      if (acq.acquisitionEnd !== wesm.collectEnd) {
        fail(`summary.acquisition.acquisitionEnd "${acq.acquisitionEnd}" ≠ WESM ledger "${wesm.collectEnd}"`);
      }
      const lw = Array.isArray(wesm.workunits) ? wesm.workunits : [];
      const aw = Array.isArray(acq.workunits) ? acq.workunits : [];
      if (aw.length !== lw.length || aw.some((w, i) => w !== lw[i])) {
        fail(`summary.acquisition.workunits [${aw.join(', ')}] ≠ WESM ledger [${lw.join(', ')}]`);
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

/** The authoritative WESM acquisition ledger, keyed by collectionId. */
export const WESM_LEDGER = resolve(MANIFEST_DIR, 'wesm-acquisition.json');

/** Load the WESM ledger as a collectionId→entry map. A missing/broken ledger is
 * a loud failure — the acquisition cross-check depends on it. */
export function loadWesmLedger(path = WESM_LEDGER) {
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  const map = new Map();
  for (const c of ledger.collections ?? []) map.set(c.collectionId, c);
  return map;
}

/** Read + verify every pinned manifest. Returns true when all pass. */
export function verifyAll(dir = MANIFEST_DIR) {
  let allOk = true;
  let wesmMap;
  try {
    wesmMap = loadWesmLedger(resolve(dir, 'wesm-acquisition.json'));
  } catch (e) {
    console.error(`FAIL: cannot read WESM acquisition ledger — ${e.message}`);
    return false;
  }
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
    const wesm = wesmMap.get(id);
    if (!wesm) {
      console.error(`FAIL ${id}: no WESM ledger entry for this collection`);
      allOk = false;
      continue;
    }
    const { ok, errors, summary } = verifyManifest(manifest, { expectedCount, wesm });
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
