#!/usr/bin/env node
/**
 * run-profile-reference.mjs — produce the independent side of the MEAS-PROFILE
 * comparison.
 *
 * WHAT MAKES THIS A CROSS-IMPLEMENTATION REFERENCE. A corridor profile is two
 * operations: place every point on the section line (chainage and perpendicular
 * distance in the map plane), then reduce each station's corridor to one
 * elevation with a type-7 quantile. Neither is done here. The first is done by
 * OGR's SpatiaLite SQL functions — ST_Line_Locate_Point and ST_Distance, GEOS
 * geometry with no connection to this project — and the second by R's
 * `quantile(type = 7)`, the implementation the type numbering comes from. This
 * script only moves files between them and records what ran.
 *
 * WHAT IT DOES NOT DO. It does not compute a chainage, a distance or a quantile,
 * and it never re-prints an elevation: the SQL selects the fixture's z column as
 * TEXT, so the value R reduces is byte-for-byte the value the sampler read. A
 * comparison that agreed only because both sides had been through the same
 * formatter would prove nothing about either.
 *
 * NOTHING IS INFERRED. A failing stage is recorded with its exit code and its
 * stderr and no output file is written.
 *
 * Usage: node scripts/run-profile-reference.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import {
  RAMP_A, RAMP_B, RAMP_SAMPLES, RAMP_BAND, RAMP_BIN_STEP,
  SCATTER_A, SCATTER_B, SCATTER_SAMPLES, SCATTER_BAND, SCATTER_BIN_STEP,
  PERCENTILE_PRIMARY, PERCENTILE_SECONDARY, EXCLUDED_CLASSES,
} from './profile-fixture-params.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/cross-implementation/profile');
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

const OGR2OGR = 'ogr2ogr';
const RSCRIPT = 'Rscript';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? String(r.error?.message ?? ''),
  };
}

const resolvedPathOf = (name) => {
  const found = binaryOnPath(name);
  if (found === null) return `unavailable: ${name} not on PATH`;
  try { return realpathSync(found); } catch { return `unavailable: ${name}`; }
};

const wkt = (a, b) => `LINESTRING(${a[0]} ${a[1]},${b[0]} ${b[1]})`;

/**
 * The corridor query. `bin` is the nearest station, which is the sampler's
 * documented rule; the fixtures keep every point clear of a bin boundary so the
 * rounding step cannot be what decides the comparison. The corridor test is
 * SpatiaLite's distance to the section line. `z` is selected unconverted.
 */
function corridorSql(layer, line, band, binStep, classFilter) {
  const pt = 'MakePoint(CAST(x AS REAL), CAST(y AS REAL))';
  const geom = `GeomFromText('${line}')`;
  const where = classFilter ? ` AND cls NOT IN (${EXCLUDED_CLASSES.join(',')})` : '';
  return (
    `SELECT CAST(ST_Line_Locate_Point(${geom}, ${pt}) * ST_Length(${geom}) / ${binStep} + 0.5 AS INTEGER) AS bin, `
    + `z AS z FROM "${layer}" WHERE ST_Distance(${geom}, ${pt}) <= ${band}${where}`
  );
}

const JOBS = [
  {
    id: 'ramp',
    layer: 'profile-ramp',
    fixture: resolve(DIR, 'profile-ramp.csv'),
    corridor: resolve(DIR, 'profile-ramp__corridor.csv'),
    series: resolve(DIR, 'profile-ramp__profile.csv'),
    line: wkt(RAMP_A, RAMP_B),
    band: RAMP_BAND,
    binStep: RAMP_BIN_STEP,
    stations: RAMP_SAMPLES,
    classFilter: false,
    percentiles: [PERCENTILE_PRIMARY, PERCENTILE_SECONDARY],
  },
  {
    id: 'scatter',
    layer: 'profile-scatter',
    fixture: resolve(DIR, 'profile-scatter.csv'),
    corridor: resolve(DIR, 'profile-scatter__corridor.csv'),
    series: resolve(DIR, 'profile-scatter__profile.csv'),
    line: wkt(SCATTER_A, SCATTER_B),
    band: SCATTER_BAND,
    binStep: SCATTER_BIN_STEP,
    stations: SCATTER_SAMPLES,
    classFilter: true,
    percentiles: [PERCENTILE_PRIMARY],
  },
];

const record = { generatedBy: 'scripts/run-profile-reference.mjs', runs: {} };
let failed = 0;

for (const job of JOBS) {
  if (!existsSync(job.fixture)) {
    record.runs[job.id] = { status: 'unavailable', detail: `${rel(job.fixture)} is missing; run scripts/make-profile-fixture.mjs` };
    failed++;
    continue;
  }
  const sql = corridorSql(job.layer, job.line, job.band, job.binStep, job.classFilter);
  for (const p of [job.corridor, job.series]) if (existsSync(p)) rmSync(p);

  // STRING_QUOTING=IF_NEEDED keeps the passed-through elevation unquoted. The
  // default quotes a string field that looks like a number, which is exactly
  // what this one is, and R then refuses to read the column as numeric.
  const ogrArgs = [
    '-f', 'CSV', rel(job.corridor), rel(job.fixture),
    '-lco', 'STRING_QUOTING=IF_NEEDED',
    '-dialect', 'SQLITE', '-sql', sql,
  ];
  const ogr = run(OGR2OGR, ogrArgs);
  if (ogr.code !== 0 || !existsSync(job.corridor)) {
    record.runs[job.id] = { status: 'failed', stage: 'ogr2ogr', exitCode: ogr.code, stderr: ogr.stderr.trim() || null };
    failed++;
    continue;
  }

  const rArgs = [
    rel(resolve(DIR, 'profile-quantile.R')),
    rel(job.corridor),
    rel(job.series),
    String(job.stations),
    job.percentiles.join(','),
  ];
  const r = run(RSCRIPT, rArgs);
  if (r.code !== 0 || !existsSync(job.series)) {
    record.runs[job.id] = { status: 'failed', stage: 'Rscript', exitCode: r.code, stderr: r.stderr.trim() || null };
    failed++;
    continue;
  }

  record.runs[job.id] = {
    status: 'ok',
    corridorSql: sql,
    corridorCommandLine: `${OGR2OGR} ${ogrArgs.join(' ')}`,
    quantileCommandLine: `${RSCRIPT} ${rArgs.join(' ')}`,
    corridorOutput: rel(job.corridor),
    seriesOutput: rel(job.series),
    percentiles: job.percentiles,
    exitCodes: { ogr2ogr: ogr.code, Rscript: r.code },
    stderr: [ogr.stderr.trim(), r.stderr.trim()].filter(Boolean).join('\n') || null,
  };
}

const version = (cmd, args) => run(cmd, args).stdout.split('\n')[0].trim() || 'unavailable';

record.geometry = {
  tool: 'GDAL/OGR SQLite dialect with SpatiaLite',
  gdal: version('ogr2ogr', ['--version']),
  spatialite: run('ogrinfo', ['-q', '-dialect', 'SQLITE', '-sql', 'SELECT spatialite_version()', rel(JOBS[0].fixture)])
    .stdout.split('=').pop().trim() || 'unavailable',
  resolvedPath: resolvedPathOf(OGR2OGR),
  functions: ['ST_Line_Locate_Point', 'ST_Length', 'ST_Distance', 'MakePoint'],
};
record.statistic = {
  tool: 'R quantile(type = 7)',
  version: version('Rscript', ['-e', 'cat(R.version.string)']),
  resolvedPath: resolvedPathOf(RSCRIPT),
  script: 'validation/cross-implementation/profile/profile-quantile.R',
};
record.containerPinning = 'not-executed';
record.containerPinningNote =
  'No containerised GDAL or R was used; the resolved executable paths, the reported versions and the exact command lines stand in for an image digest.';
record.platform = `${platform}-${arch}`;
record.node = process.version;

writeFileSync(resolve(DIR, 'reference-runs-profile.json'), `${JSON.stringify(record, null, 2)}\n`);

for (const [id, r] of Object.entries(record.runs)) console.log(`${id}: ${r.status}`);
console.log(`record written to ${rel(resolve(DIR, 'reference-runs-profile.json'))}`);
if (failed > 0) process.exitCode = 1;
