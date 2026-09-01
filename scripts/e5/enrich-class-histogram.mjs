#!/usr/bin/env node
/**
 * enrich-class-histogram.mjs — add per-tile ASPRS class histograms to an E5
 * input manifest.
 *
 * The header-only manifest records point counts but not how those points are
 * classified; the DTM candidate consumes producer Class-2 ground returns, so the
 * manifest should state, per tile, how many Class-2 points exist. This runs a
 * full PDAL point scan (filters.stats count:Classification) per tile, records the
 * exact per-class counts, and derives a ground fraction. Counts are read from the
 * file; nothing is invented.
 *
 * Usage: node scripts/e5/enrich-class-histogram.mjs <dir> <manifest.json>
 */
import { readFileSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const [, , dir, manifestPath] = process.argv;
if (!dir || !manifestPath) {
  console.error('usage: enrich-class-histogram.mjs <dir> <manifest.json>');
  process.exit(2);
}
const GROUND_CLASS = 2;

function classHistogram(path) {
  const pipeline = JSON.stringify([
    { type: 'readers.las', filename: path },
    { type: 'filters.stats', count: 'Classification' },
  ]);
  const tmp = `/tmp/e5-hist-${process.pid}.json`;
  writeFileSync(tmp, pipeline);
  execFileSync('pdal', ['pipeline', tmp, '--metadata', `/tmp/e5-meta-${process.pid}.json`], {
    maxBuffer: 64 << 20,
  });
  const meta = JSON.parse(readFileSync(`/tmp/e5-meta-${process.pid}.json`, 'utf8'));
  let counts = null;
  const walk = (o) => {
    if (counts) return;
    if (Array.isArray(o)) return o.forEach(walk);
    if (o && typeof o === 'object') {
      if (o.name === 'Classification' && Array.isArray(o.counts)) {
        counts = o.counts;
        return;
      }
      Object.values(o).forEach(walk);
    }
  };
  walk(meta);
  if (!counts) throw new Error('no Classification counts in pdal output');
  // Each entry is "value/count" as decimal strings.
  const hist = {};
  for (const e of counts) {
    const [v, c] = e.split('/');
    hist[String(Math.round(Number(v)))] = Number(c);
  }
  return hist;
}

const manifest = JSON.parse(readFileSync(resolve(manifestPath), 'utf8'));
let collGround = 0;
let collTotal = 0;
for (const tile of manifest.tiles) {
  const hist = classHistogram(join(dir, tile.basename));
  const ground = hist[String(GROUND_CLASS)] ?? 0;
  const total = Object.values(hist).reduce((a, b) => a + b, 0);
  tile.classHistogram = hist;
  tile.groundPointCount = ground;
  tile.groundPointFraction = total > 0 ? Number((ground / total).toFixed(6)) : 0;
  collGround += ground;
  collTotal += total;
  writeSync(2, `  ${tile.basename}  ground=${ground}  frac=${tile.groundPointFraction}\n`);
}
manifest.summary.groundPointFraction = collTotal > 0 ? Number((collGround / collTotal).toFixed(6)) : 0;
manifest.summary.allTilesHaveGround = manifest.tiles.every((t) => t.groundPointCount > 0);
manifest.$schemaNote = manifest.$schemaNote.replace(
  'collectionDigest fixes',
  'Per-tile class histograms are exact point-scan counts. collectionDigest fixes',
);
writeFileSync(resolve(manifestPath), JSON.stringify(manifest, null, 2) + '\n');
writeSync(
  2,
  `\n→ ${manifestPath}: groundPointFraction=${manifest.summary.groundPointFraction}, allTilesHaveGround=${manifest.summary.allTilesHaveGround}\n`,
);
