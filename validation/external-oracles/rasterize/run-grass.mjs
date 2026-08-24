#!/usr/bin/env node
/**
 * run-grass.mjs: capture GRASS `r.in.xyz` for each frozen scene.
 *
 * An oracle-generation job, not a repository gate. It writes
 * references/grass-rasterize.json, and tests/rasterizeGrassAgreement.test.ts
 * compares the candidate against that committed file, so ordinary CI needs no
 * GRASS.
 *
 * The candidate never enters this file. GRASS is asked the same question in
 * GRASS's own terms: a region pinned to the fixture grid, then one r.in.xyz
 * pass per binning statistic.
 *
 *   method=mean   the arithmetic mean of the returns in the cell
 *   method=min    the lowest return, the ground-side reduction
 *   method=max    the highest return, the surface-side reduction
 *   method=n      how many returns landed in the cell
 *
 * `type=DCELL` matters. r.in.xyz accumulates into the output map's storage, so
 * an FCELL run would fold single-precision accumulation error into the mean and
 * the residual would be the reference's rounding rather than the candidate's.
 *
 * GRASS needs a project and mapset, which `--tmp-project XY` supplies: a fresh
 * throwaway per scene, so no region, mask or map name leaks between scenes.
 *
 * Set GRASSBIN if `grass` is not on PATH.
 *
 * Usage:  node validation/external-oracles/rasterize/run-grass.mjs
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = resolve(dirname(fileURLToPath(import.meta.url)));
const REFS = resolve(HERE, 'references');
const GRASSBIN = process.env.GRASSBIN || 'grass';

const fixturesRaw = readFileSync(resolve(HERE, 'fixtures.json'), 'utf8');
const fixtures = JSON.parse(fixturesRaw);
const { cols, rows, cellSizeM, originH1, originH2 } = fixtures.grid;

/** Region bounds in GRASS terms. The grid origin is the south-west corner. */
const REGION = {
  w: originH1,
  e: originH1 + cols * cellSizeM,
  s: originH2,
  n: originH2 + rows * cellSizeM,
  res: cellSizeM,
};

const METHODS = ['mean', 'min', 'max', 'n'];
/**
 * Decimal places in the ASCII dump. Seventeen significant figures round-trip a
 * double, and these elevations sit under 128, so twelve decimals is past the
 * last bit the candidate's float32 storage can carry.
 */
const PRECISION = 12;

/** The r.in.xyz command line for one method, as it is actually spelled. */
const inXyzCommand = (method, input, output) =>
  `r.in.xyz input=${input} output=${output} method=${method} separator=comma ` +
  `x=1 y=2 z=3 type=DCELL --overwrite`;

const gRegionCommand = `g.region w=${REGION.w} e=${REGION.e} s=${REGION.s} n=${REGION.n} res=${REGION.res}`;

/**
 * Parse an `r.out.ascii` dump into a south-to-north array.
 *
 * GRASS writes the northernmost row first; a candidate raster indexes row 0 at
 * the south. The flip happens here, once, next to the header that proves the
 * geometry, rather than in the test where a sign error would look like a
 * disagreement.
 */
function parseAscii(text) {
  const lines = text.split('\n');
  const header = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^(north|south|east|west|rows|cols):\s+(\S+)$/.exec(lines[i].trim());
    if (!m) break;
    header[m[1]] = Number(m[2]);
  }
  const north = [];
  for (; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t === '') continue;
    north.push(t.split(/\s+/).map((v) => (v === '*' || v === 'nan' ? null : Number(v))));
  }
  return { header, rowsSouthToNorth: north.slice().reverse() };
}

const version = execFileSync(GRASSBIN, ['--version'], { encoding: 'utf8' }).split('\n')[0].trim();
// PATH resolution, not realpath: the symlink target is under a home directory
// and naming it would put the account into a committed record.
const executablePath =
  execFileSync('/usr/bin/which', [GRASSBIN], { encoding: 'utf8' }).trim() || GRASSBIN;

const work = mkdtempSync(join(tmpdir(), 'olv-grass-rasterize-'));
const results = [];
const commandLines = [];

try {
  for (const c of fixtures.cases) {
    const pointsText = readFileSync(resolve(HERE, c.pointsFile), 'utf8');
    const digest = `sha256:${createHash('sha256').update(pointsText).digest('hex')}`;
    if (digest !== c.pointsSha256) {
      throw new Error(`${c.pointsFile} does not match the hash in fixtures.json; regenerate the fixtures.`);
    }
    writeFileSync(join(work, 'points.xyz'), pointsText);

    const script = [
      'set -e',
      `${gRegionCommand} >/dev/null`,
      ...METHODS.flatMap((m) => [
        `${inXyzCommand(m, 'points.xyz', m === 'n' ? 'count' : m)} >/dev/null`,
        `r.out.ascii input=${m === 'n' ? 'count' : m} output=out-${m}.txt precision=${PRECISION} null_value=nan --overwrite >/dev/null`,
      ]),
    ].join('\n');

    execFileSync(GRASSBIN, ['--tmp-project', 'XY', '--exec', 'bash', '-c', script], {
      cwd: work,
      encoding: 'utf8',
      maxBuffer: 1 << 26,
    });

    const grids = {};
    let header = null;
    for (const m of METHODS) {
      const parsed = parseAscii(readFileSync(join(work, `out-${m}.txt`), 'utf8'));
      header = parsed.header;
      if (parsed.header.rows !== rows || parsed.header.cols !== cols) {
        throw new Error(`${c.id}/${m}: GRASS returned ${parsed.header.rows}x${parsed.header.cols}, expected ${rows}x${cols}`);
      }
      // r.in.xyz method=n writes 0 for a cell with no returns rather than null,
      // so the count grid is kept as integers and emptiness is read from the
      // value grids.
      grids[m] = parsed.rowsSouthToNorth.flat();
    }

    // A cell GRASS could not fill is null in every value method at once. Any
    // other pattern would mean the four passes disagreed about occupancy, which
    // is a fault rather than a result, so it is checked instead of assumed.
    for (let k = 0; k < cols * rows; k++) {
      const empty = grids.mean[k] === null;
      if ((grids.min[k] === null) !== empty || (grids.max[k] === null) !== empty) {
        throw new Error(`${c.id}: cell ${k} is null in some methods and not others`);
      }
      if ((grids.n[k] === 0) !== empty) {
        throw new Error(`${c.id}: cell ${k} count and null state disagree`);
      }
    }

    results.push({
      id: c.id,
      pointsSha256: digest,
      regionHeader: header,
      filledCells: grids.mean.filter((v) => v !== null).length,
      mean: grids.mean,
      min: grids.min,
      max: grids.max,
      counts: grids.n,
    });

    if (commandLines.length === 0) {
      commandLines.push(gRegionCommand, ...METHODS.map((m) => inXyzCommand(m, '<scene>.xyz', m === 'n' ? 'count' : m)),
        `r.out.ascii input=<map> output=<map>.txt precision=${PRECISION} null_value=nan --overwrite`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const record = {
  schemaVersion: 1,
  protocolId: 'RASTERIZE-GRASS-RINXYZ-2026-08',
  generatedBy: 'validation/external-oracles/rasterize/run-grass.mjs',
  fixturesSha256: `sha256:${createHash('sha256').update(fixturesRaw).digest('hex')}`,
  caseCount: results.length,
  grid: fixtures.grid,
  methods: METHODS,
  asciiPrecision: PRECISION,
  environment: { platform: `${process.platform}-${process.arch}`, nodeVersion: process.version },
  oracles: [
    {
      oracleId: 'grass-8.5.0',
      role: 'independent-same-quantity-implementation',
      executablePath,
      versionOutput: version,
      wrapper: `${GRASSBIN} --tmp-project XY --exec bash -c <script>`,
      commandLine: commandLines.join(' ; '),
      parameters: {
        region: REGION,
        separator: 'comma',
        columns: { x: 1, y: 2, z: 3 },
        type: 'DCELL',
        methods: METHODS,
        asciiPrecision: PRECISION,
        nullValue: 'nan',
      },
    },
  ],
  results,
};

mkdirSync(REFS, { recursive: true });
writeFileSync(resolve(REFS, 'grass-rasterize.json'), `${JSON.stringify(record, null, 2)}\n`);

console.log(`run-grass: ${results.length} scene(s) captured from ${version}`);
for (const r of results) {
  const occupied = r.counts.filter((n) => n > 0);
  const total = occupied.reduce((a, b) => a + b, 0);
  console.log(
    `  ${r.id.padEnd(26)} filled ${String(r.filledCells).padStart(4)}   mean ${(total / occupied.length).toFixed(2)} returns per filled cell`,
  );
}
