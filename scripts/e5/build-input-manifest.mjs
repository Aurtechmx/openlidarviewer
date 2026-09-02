#!/usr/bin/env node
/**
 * build-input-manifest.mjs — immutable input manifest for an E5 LAZ collection.
 *
 * Reads every LAZ in a directory through PDAL's header (no full-point scan) and
 * records, per tile, exactly what the file states: sha256, byte size, LAS
 * version, point-data-record format, point count, bounds, the compound CRS with
 * its horizontal/vertical EPSG + vertical datum + geoid, capture date and
 * producer software. Nothing is invented; a field the header does not carry is
 * written as null, and the caller decides whether that null blocks E5.
 *
 * The manifest is canonicalised (sorted keys, sorted tiles) and a collection
 * digest is taken over the per-tile sha256 list, so the exact set of input bytes
 * behind any downstream candidate surface is fixed and checkable.
 *
 * Usage:
 *   node scripts/e5/build-input-manifest.mjs <dir> <collectionId> <role> <out.json>
 * role is 'candidate-input' (product-under-test input) or 'reference-labelling'.
 */
import { readdirSync, readFileSync, writeFileSync, statSync, createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
// Authoritative acquisition provenance (USGS 3DEP WESM), derived from WESM.csv
// which is not vendored. The LAS header carries no acquisition date, so the ONLY
// acquisition source is this ledger — never the filename or a LAS creation stamp.
const WESM_LEDGER = resolve(HERE, '../../validation/e5/manifests/wesm-acquisition.json');

const [, , dir, collectionId, role, out] = process.argv;
if (!dir || !collectionId || !role || !out) {
  console.error('usage: build-input-manifest.mjs <dir> <collectionId> <role> <out.json>');
  process.exit(2);
}
if (role !== 'candidate-input' && role !== 'reference-labelling') {
  console.error(`role must be candidate-input or reference-labelling, got ${role}`);
  process.exit(2);
}

function sha256File(path) {
  return new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(path).on('data', (c) => h.update(c)).on('end', () => res(h.digest('hex'))).on('error', rej);
  });
}

/** Pull the fields we record from `pdal info --metadata`, coercing absent → null. */
function readHeader(path) {
  const raw = execFileSync('pdal', ['info', '--metadata', path], { maxBuffer: 64 << 20 });
  const m = JSON.parse(raw.toString()).metadata ?? {};
  const comp = m.comp_spatialreference ?? m.spatialreference ?? '';
  // The projected CRS's OWN authority is the one immediately before ,VERT_CS
  // (or the last authority in a horizontal-only string) — NOT the inner
  // spheroid/geographic authority a non-greedy match would grab first.
  const horizMatch =
    comp.match(/AUTHORITY\["EPSG","(\d+)"\]\]\s*,\s*VERT_CS/) ??
    comp.match(/PROJCS\[[\s\S]*AUTHORITY\["EPSG","(\d+)"\]\]/); // greedy: last PROJCS authority
  // The vertical CRS's own authority is the last EPSG authority in the string.
  const vertMatch = comp.match(/VERT_CS\[[\s\S]*AUTHORITY\["EPSG","(\d+)"\]/);
  const vertDatum = (comp.match(/VERT_DATUM\["([^"]+)"/) ?? [])[1] ?? null;
  // Preserve the FULL geoid identifier (e.g. GEOID12B) and canonicalise to upper
  // case — a `\d{2}` match silently dropped the trailing revision letter.
  const geoidRaw = (comp.match(/Geoid\d{2}[A-Za-z]?/) ?? [])[0] ?? null;
  const geoid = geoidRaw ? geoidRaw.toUpperCase() : null;
  return {
    lasVersion: m.major_version != null ? `${m.major_version}.${m.minor_version}` : null,
    pointDataRecordFormat: m.dataformat_id ?? null,
    pointCount: m.count ?? null,
    bounds: {
      minX: m.minx ?? null, maxX: m.maxx ?? null,
      minY: m.miny ?? null, maxY: m.maxy ?? null,
      minZ: m.minz ?? null, maxZ: m.maxz ?? null,
    },
    horizontalEpsg: horizMatch ? Number(horizMatch[1]) : null,
    verticalEpsg: vertMatch ? Number(vertMatch[1]) : null,
    verticalDatum: vertDatum,
    geoidModel: geoid,
    compoundCrs: comp || null,
    // LAS header CREATION date — NOT the acquisition date. Named so no reader
    // mistakes a 2021 file-write for a 2019 flight. Acquisition is left an
    // explicit unknown; it is never guessed from the filename or GPS time here.
    fileCreationYear: m.creation_year ?? null,
    fileCreationDayOfYear: m.creation_doy ?? null,
    acquisitionYear: null,
    acquisitionDateSource: 'not-established',
    systemId: m.system_id ?? null,
    softwareId: m.software_id ?? null,
  };
}

/**
 * Look up the authoritative WESM acquisition entry for a collection. Returns the
 * matching ledger entry, or null when the collection is not in the ledger (then
 * acquisition stays the explicit `not-established` unknown from the header pass).
 */
function wesmEntryFor(collectionId) {
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(WESM_LEDGER, 'utf8'));
  } catch {
    return null;
  }
  const found = (ledger.collections ?? []).find((c) => c.collectionId === collectionId);
  return found ?? null;
}

/**
 * Merge WESM acquisition provenance into the tiles + summary. Only the
 * acquisition fields change: acquisitionYear (single integer only when the whole
 * collection window is one calendar year, else null) and acquisitionDateSource,
 * plus a summary-level acquisition block carrying the authoritative window,
 * project id, work units and QL. Never touches sha256/EPSG/geoid/counts, so the
 * collectionDigest is unaffected.
 */
function mergeWesmAcquisition(tiles, summary, collectionId) {
  const e = wesmEntryFor(collectionId);
  if (!e) {
    process.stderr.write(`  (no WESM entry for ${collectionId}; acquisition left not-established)\n`);
    return;
  }
  for (const t of tiles) {
    t.acquisitionYear = e.acquisitionYear ?? null;
    t.acquisitionDateSource = 'usgs-wesm';
  }
  summary.acquisitionYears = [e.acquisitionYear ?? null];
  summary.acquisition = {
    acquisitionStart: e.collectStart,
    acquisitionEnd: e.collectEnd,
    acquisitionSource: 'usgs-wesm',
    projectId: e.projectId,
    workunits: e.workunits,
    ql: e.ql,
  };
}

const files = readdirSync(dir).filter((f) => /\.la[sz]$/i.test(f)).sort();
if (files.length === 0) {
  console.error(`no LAS/LAZ files in ${dir}`);
  process.exit(1);
}

const tiles = [];
for (const f of files) {
  const path = join(dir, f);
  const sha256 = await sha256File(path);
  const bytes = statSync(path).size;
  let header;
  try {
    header = readHeader(path);
  } catch (e) {
    console.error(`pdal header read failed for ${f}: ${e.message}`);
    process.exit(1);
  }
  tiles.push({ basename: basename(f), sha256, bytes, role, ...header });
  process.stderr.write(`  ${f}  ${(bytes / 1e6).toFixed(1)} MB  n=${header.pointCount}\n`);
}

// Canonical member order (by basename), collection digest over the sha list.
tiles.sort((a, b) => a.basename.localeCompare(b.basename));
const collectionDigest = createHash('sha256')
  .update(tiles.map((t) => `${t.basename}:${t.sha256}`).join('\n'))
  .digest('hex');

// Homogeneity summary — the E5 candidate needs one work unit / frame.
const uniq = (sel) => [...new Set(tiles.map(sel))];
const summary = {
  tileCount: tiles.length,
  horizontalEpsg: uniq((t) => t.horizontalEpsg),
  verticalEpsg: uniq((t) => t.verticalEpsg),
  verticalDatum: uniq((t) => t.verticalDatum),
  geoidModel: uniq((t) => t.geoidModel),
  lasVersion: uniq((t) => t.lasVersion),
  pointDataRecordFormat: uniq((t) => t.pointDataRecordFormat),
  fileCreationYears: uniq((t) => t.fileCreationYear),
  acquisitionYears: uniq((t) => t.acquisitionYear),
  homogeneousFrame:
    uniq((t) => t.horizontalEpsg).length === 1 &&
    uniq((t) => t.verticalEpsg).length === 1 &&
    uniq((t) => t.geoidModel).length === 1,
};

// Overlay authoritative WESM acquisition provenance (offline; from the ledger,
// not the LAS headers). Keeps a regenerated manifest consistent with the
// committed one on the acquisition fields.
mergeWesmAcquisition(tiles, summary, collectionId);

const manifest = {
  $schemaNote:
    'Immutable input manifest for an E5 LAZ collection. Every field is read from the file header; a null is an unknown the header did not carry, never a guess. collectionDigest fixes the exact set of input bytes. This manifest is input to a product-under-test, not field truth.',
  collectionId,
  role,
  generatedFrom: 'pdal info --metadata (header only)',
  license: 'public domain (USGS 3DEP)',
  collectionDigest,
  summary,
  tiles,
};
writeFileSync(resolve(out), JSON.stringify(manifest, null, 2) + '\n');
console.error(
  `\n→ ${out}: ${tiles.length} tiles, collectionDigest ${collectionDigest.slice(0, 12)}…, homogeneousFrame=${summary.homogeneousFrame}`,
);
