#!/usr/bin/env node
/**
 * run-grass.mjs — capture GRASS's answer for each frozen epoch pair.
 *
 * An oracle-generation job, not a repository gate. It writes
 * references/grass-change.json, and tests/changeGrassAgreement.test.ts then
 * compares OLV against that committed file, so ordinary CI needs no GRASS.
 *
 * The candidate never enters this file. GRASS is asked the same question OLV
 * answers, in GRASS's own terms:
 *
 *   d    = epochB - epochA                    per-cell elevation change
 *   gain = if(d >  lod,  d, null())           only above-threshold cells count
 *   loss = if(d < -lod, -d, null())
 *
 * then `r.univar` sums each. That mirrors detectChange's rule exactly, and the
 * mirroring is the point: a leg configured to a different threshold rule would
 * disagree for a reason that has nothing to do with either implementation
 * being wrong. Null propagates through `r.mapcalc` the way NaN propagates
 * through the candidate, so a cell missing on either side is comparable in
 * neither.
 *
 * Set GRASSBIN if `grass` is not on PATH.
 *
 * Usage:  node validation/external-oracles/change/run-grass.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const GRIDS = resolve(HERE, 'grids');
const REFS = resolve(HERE, 'references');
const GRASSBIN = process.env.GRASSBIN || 'grass';

const fixturesRaw = readFileSync(resolve(HERE, 'fixtures.json'), 'utf8');
const fixtures = JSON.parse(fixturesRaw);
const LOD = fixtures.levelOfDetectionM;

const grass = (script) =>
  execFileSync(GRASSBIN, ['--tmp-project', 'XY', '--exec', 'bash', '-c', script], {
    cwd: GRIDS,
    encoding: 'utf8',
    maxBuffer: 1 << 24,
  });

/**
 * `r.univar -g` prints `key=value` lines. An all-null map still prints keys,
 * with `sum=nan` rather than nothing, so a nullish check would let NaN through
 * and a case whose correct answer is zero would report NaN instead.
 */
const parseUnivar = (text, prefix) => {
  const out = {};
  for (const line of text.split('\n')) {
    const m = new RegExp(`^${prefix}_(\\w+)=(.+)$`).exec(line.trim());
    if (m) {
      const v = Number(m[2]);
      out[m[1]] = Number.isFinite(v) ? v : 0;
    }
  }
  return out;
};

const version = execFileSync(GRASSBIN, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();

const results = [];
for (const c of fixtures.cases) {
  // Each case runs in its own temporary project so no region or mask leaks
  // from the previous one.
  const script = `
    set -e
    r.in.ascii input=${c.id}__a.asc output=ea --overwrite >/dev/null 2>&1
    r.in.ascii input=${c.id}__b.asc output=eb --overwrite >/dev/null 2>&1
    g.region raster=ea >/dev/null 2>&1
    r.mapcalc "d = eb - ea" --overwrite >/dev/null 2>&1
    r.mapcalc "gain = if(d > ${LOD}, d, null())" --overwrite >/dev/null 2>&1
    r.mapcalc "loss = if(d < -${LOD}, -d, null())" --overwrite >/dev/null 2>&1
    r.univar map=d    -g 2>/dev/null | sed 's/^/d_/'
    r.univar map=gain -g 2>/dev/null | sed 's/^/gain_/'
    r.univar map=loss -g 2>/dev/null | sed 's/^/loss_/'
  `;
  const out = grass(script);
  const d = parseUnivar(out, 'd');
  const gain = parseUnivar(out, 'gain');
  const loss = parseUnivar(out, 'loss');

  results.push({
    id: c.id,
    // Cell area is 1 m² by construction, so a sum of differences is already a
    // volume; the multiplication is written out rather than assumed.
    comparableCells: d.n ?? 0,
    gainedCells: gain.n ?? 0,
    lostCells: loss.n ?? 0,
    gainVolumeM3: (gain.sum ?? 0) * fixtures.cellSizeM * fixtures.cellSizeM,
    lossVolumeM3: (loss.sum ?? 0) * fixtures.cellSizeM * fixtures.cellSizeM,
    maxGainM: d.max ?? 0,
    maxLossM: d.min ?? 0,
    meanAbsChangeM: null,
    rawUnivar: { d, gain, loss },
  });
}

const record = {
  schemaVersion: 1,
  protocolId: 'CHANGE-GRASS-MAPCALC-2026-08',
  generatedBy: 'validation/external-oracles/change/run-grass.mjs',
  fixturesSha256: `sha256:${createHash('sha256').update(fixturesRaw).digest('hex')}`,
  caseCount: results.length,
  levelOfDetectionM: LOD,
  environment: { platform: `${process.platform}-${process.arch}`, nodeVersion: process.version },
  oracles: [
    {
      oracleId: 'grass-8.5.0',
      role: 'independent-same-quantity-implementation',
      executablePath: execFileSync('/usr/bin/which', [GRASSBIN], { encoding: 'utf8' }).trim() || GRASSBIN,
      versionOutput: version,
      commandLine: 'r.mapcalc "d = eb - ea" ; r.mapcalc gain/loss with the same LoD rule ; r.univar -g',
    },
  ],
  results,
};

mkdirSync(REFS, { recursive: true });
writeFileSync(resolve(REFS, 'grass-change.json'), `${JSON.stringify(record, null, 2)}\n`);

console.log(`run-grass: ${results.length} case(s) captured from ${version}`);
for (const r of results) {
  console.log(
    `  ${r.id.padEnd(24)} gain ${r.gainVolumeM3.toFixed(3).padStart(9)} m3   loss ${r.lossVolumeM3.toFixed(3).padStart(9)} m3   comparable ${r.comparableCells}`,
  );
}
