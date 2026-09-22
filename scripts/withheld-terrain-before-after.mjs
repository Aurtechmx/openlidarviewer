#!/usr/bin/env node
/**
 * withheld-terrain-before-after.mjs: what the Withheld policy does to terrain.
 *
 * For each LAS/LAZ file, decode it in full, gather it the way the application
 * does (the same stride walk, capped at 300,000 points) with the policy on and
 * with it off, and report the Withheld count, the class-2 ground returns in the
 * gather, and the DTM summary from the real terrain core. When the two gathers
 * are byte-identical the DTMs are identical by construction and the core is
 * not run twice.
 *
 * Files come from the arguments. With none, it reads the repository's own LAS
 * fixtures plus the terrain-field manifest's source clouds found under
 * OLV_TERRAIN_SOURCES (a directory; the raw clouds are not committed).
 *
 *   OLV_TERRAIN_SOURCES=/path/to/clouds npx tsx scripts/withheld-terrain-before-after.mjs
 *   npx tsx scripts/withheld-terrain-before-after.mjs a.las b.laz
 *
 * It writes nothing. The recorded evidence is not touched.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const GATHER_CAP = 300_000;

function findUnder(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (entry === name) return p;
    if (statSync(p).isDirectory()) {
      const hit = findUnder(p, name);
      if (hit) return hit;
    }
  }
  return null;
}

function defaultTargets() {
  const out = [];
  for (const f of ['tiny.las', 'tiny.laz', 'tiny-pdrf0.laz', 'tiny-pdrf1.laz', 'multichunk.laz',
    'gate2-origin-a.las', 'gate2-origin-b.las', 'gate2-axis-zup-survey.las', 'withheld-flags.las',
    'las-pdal/utm15.las', 'las-pdal/synthetic_test.las']) {
    out.push({ label: `fixture ${f}`, path: join(ROOT, 'tests/fixtures', f) });
  }
  out.push({ label: 'public/samples/tiny.las', path: join(ROOT, 'public/samples/tiny.las') });
  const manifest = JSON.parse(readFileSync(join(ROOT, 'validation/terrain-field/datasets/manifest.json'), 'utf8'));
  const dir = process.env.OLV_TERRAIN_SOURCES;
  for (const d of manifest.datasets) {
    const label = `terrain-field ${d.sourceId}`;
    if (!d.sourceFile) { out.push({ label, path: null, note: 'no source file recorded' }); continue; }
    const hit = dir && existsSync(dir) ? findUnder(dir, d.sourceFile) : null;
    out.push({ label, path: hit, note: hit ? undefined : `absent: ${d.sourceFile}` });
  }
  return out;
}

function summarise(core) {
  const { dtm } = core;
  let measured = 0, returns = 0, zMin = Infinity, zMax = -Infinity, zSum = 0;
  for (let i = 0; i < dtm.coverage.length; i++) {
    returns += dtm.counts[i];
    if (dtm.counts[i] === 0) continue;
    measured++;
    const z = dtm.z[i];
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    zSum += z;
  }
  return { measured, returns, zMin, zMax, zMean: measured ? zSum / measured : NaN };
}

const class2 = (cls) => (cls ? cls.reduce((n, c) => n + (c === 2 ? 1 : 0), 0) : null);
const sameBytes = (a, b) => a.length === b.length && Buffer.compare(
  Buffer.from(a.buffer, a.byteOffset, a.byteLength), Buffer.from(b.buffer, b.byteOffset, b.byteLength),
) === 0;

/**
 * Decode the whole file. Small files take the application's parse path; a
 * large LAZ goes through `decodeLaz` directly, because the application hands
 * those to a Web Worker that Node does not have. Both read the same decoder.
 */
async function load(path, mods) {
  const bytes = readFileSync(path);
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const isLaz = path.toLowerCase().endsWith('.laz');
  if (!isLaz || bytes.byteLength < 8 * 1024 * 1024) {
    const { cloud } = await mods.parseBuffer(ab, isLaz ? 'laz' : 'las', basename(path), 1e9);
    return cloud;
  }
  const header = mods.parseLasHeader(ab);
  const raw = await mods.decodeLaz(ab, header, [header.min[0], header.min[1], header.min[2]], 1);
  const n = raw.positions.length / 3;
  return {
    pointCount: n,
    positions: raw.positions,
    classification: raw.classification,
    classificationFlags: raw.classificationFlags,
  };
}

async function measure(path, mods) {
  const { sampleStridedTerrain, computeTerrainCore, withheldCount } = mods;
  const cloud = await load(path, mods);
  const buf = { pos: cloud.positions, cls: cloud.classification, flags: cloud.classificationFlags };
  const gather = (includeWithheld) =>
    sampleStridedTerrain([buf], [], cloud.pointCount, GATHER_CAP, !!cloud.classification, { includeWithheld });
  const on = gather(false);
  const off = gather(true);
  const row = {
    points: cloud.pointCount,
    flags: cloud.classificationFlags ? 'yes' : 'no',
    withheld: cloud.classificationFlags ? withheldCount(cloud.classificationFlags) : null,
    declared: on?.withheldExcluded ?? null,
    droppedInGather: on?.withheldExcludedCount ?? 0,
    groundBefore: class2(off?.classification),
    groundAfter: class2(on?.classification),
  };
  if (!on || !off) return { ...row, identical: on === off, before: null, after: null };
  const identical = sameBytes(on.positions, off.positions)
    && (!on.classification || sameBytes(on.classification, off.classification));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < off.positions.length; i += 3) {
    const x = off.positions[i], y = off.positions[i + 1];
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  const extent = Math.max(maxX - minX, maxY - minY, 1);
  const cellSizeM = Math.max(0.25, extent / 256);
  const coreOf = (s) => computeTerrainCore(s.positions, { cellSizeM, classification: s.classification });
  const before = summarise(coreOf(off));
  const after = identical ? before : summarise(coreOf(on));
  return { ...row, identical, cellSizeM, before, after };
}

const fmt = (v, d = 3) => (v == null || Number.isNaN(v) ? '-' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(d)) : String(v));

async function main() {
  const mods = {
    ...(await import('../src/io/parseBuffer.ts')),
    ...(await import('../src/io/lasHeader.ts')),
    ...(await import('../src/io/lazDecode.ts')),
    ...(await import('../src/render/terrainStreamSample.ts')),
    ...(await import('../src/terrain/contour/analyseContours.ts')),
    ...(await import('../src/science/withheldPolicy.ts')),
  };
  const args = process.argv.slice(2);
  const targets = args.length ? args.map((p) => ({ label: basename(p), path: resolve(p) })) : defaultTargets();
  const head = ['dataset', 'points', 'flags', 'withheld', 'declared', 'dropped', 'ground b/a',
    'DTM cells b/a', 'DTM returns b/a', 'zmin b/a', 'zmax b/a', 'zmean b/a', 'changes'];
  console.log(`| ${head.join(' | ')} |`);
  console.log(`|${head.map(() => '---').join('|')}|`);
  for (const t of targets) {
    if (!t.path || !existsSync(t.path)) {
      console.log(`| ${t.label} | ${t.note ?? 'absent'} |${' |'.repeat(head.length - 2)}`);
      continue;
    }
    try {
      const r = await measure(t.path, mods);
      const b = r.before, a = r.after;
      const pair = (x, y, d) => `${fmt(x, d)} / ${fmt(y, d)}`;
      console.log(`| ${[t.label, r.points, r.flags, fmt(r.withheld), String(r.declared), r.droppedInGather,
        pair(r.groundBefore, r.groundAfter), pair(b?.measured, a?.measured), pair(b?.returns, a?.returns),
        pair(b?.zMin, a?.zMin), pair(b?.zMax, a?.zMax), pair(b?.zMean, a?.zMean, 4),
        r.identical ? 'no (gather byte-identical)' : 'YES'].join(' | ')} |`);
    } catch (err) {
      // Error text can carry the file's absolute path; only its name is printed.
      const msg = (err instanceof Error ? err.message : String(err)).split(t.path).join(basename(t.path));
      console.log(`| ${t.label} | error: ${msg} |${' |'.repeat(head.length - 2)}`);
    }
  }
}

if (isCliEntry(import.meta.url)) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
