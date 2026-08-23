#!/usr/bin/env node
/**
 * run-profile-endcap-reference.mjs: the independent side of the end-cap
 * MEMBERSHIP reference.
 *
 * WHAT THIS ANSWERS THAT THE OTHER RUNS DO NOT. scripts/run-profile-reference.mjs
 * compares reduced series: a percentile per station. A percentile can only show
 * a membership rule indirectly, through a value that moves when a point leaks
 * in, and it cannot show anything at all about a point sitting exactly on the
 * threshold, because both fixtures hold every point clear of one. The
 * MEAS-PROFILE-OGR-R-CORRIDOR study says so in its own scope.unsupported. This
 * run asks the membership question directly, probe by probe.
 *
 * WHAT MAKES IT A CROSS-IMPLEMENTATION REFERENCE. The distance is SpatiaLite's
 * ST_Distance against a two-point LINESTRING, which is GEOS point-to-segment
 * geometry with no connection to this project. This script computes no distance
 * and no verdict of its own; it runs ogrinfo, copies what came back, and records
 * what ran.
 *
 * THREE COLUMNS, NOT ONE.
 *   dist      ST_Distance itself, printed at full precision. The verdict is a
 *             comparison, and a comparison written on this side would be this
 *             repository's opinion; the distance is the reference's.
 *   capsule   ST_Distance <= band, the corridor the sampler documents.
 *   rect      ST_Intersects against an explicit POLYGON with square ends, the
 *             rule the capsule has to be distinguished FROM. Case 3 is the probe
 *             the two disagree about, so this column is what turns "the shapes
 *             differ" into something the reference states rather than this file.
 *
 * A SEPARATE RECORD. reference-runs-profile.json is a listed artifact of the
 * MEAS-PROFILE-OGR-R-CORRIDOR study with its own sha256, and
 * reference-runs-profile-caps.json belongs to the supplementary caps run. This
 * writes a third file so neither of those moves.
 *
 * NOTHING IS INFERRED. A failing stage is recorded with its exit code and its
 * stderr and no output file is written.
 *
 * Usage: node scripts/run-profile-endcap-reference.mjs
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import { ENDCAP_A, ENDCAP_B, ENDCAP_BAND } from './profile-fixture-params.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/cross-implementation/profile');
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

const OGRINFO = 'ogrinfo';
const LAYER = 'profile-endcap';
const FIXTURE = resolve(DIR, 'profile-endcap.csv');
const OUTPUT = resolve(DIR, 'profile-endcap__membership.csv');
const RECORD = resolve(DIR, 'reference-runs-profile-endcap.json');

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

const version = (cmd, args) => run(cmd, args).stdout.split('\n')[0].trim() || 'unavailable';

const line = `LINESTRING(${ENDCAP_A[0]} ${ENDCAP_A[1]},${ENDCAP_B[0]} ${ENDCAP_B[1]})`;
/** The square-ended corridor: half-width band, extended band past either end. */
const rectRing = [
  [ENDCAP_A[0] - ENDCAP_BAND, -ENDCAP_BAND],
  [ENDCAP_B[0] + ENDCAP_BAND, -ENDCAP_BAND],
  [ENDCAP_B[0] + ENDCAP_BAND, ENDCAP_BAND],
  [ENDCAP_A[0] - ENDCAP_BAND, ENDCAP_BAND],
  [ENDCAP_A[0] - ENDCAP_BAND, -ENDCAP_BAND],
];
const rect = `POLYGON((${rectRing.map(([x, y]) => `${x} ${y}`).join(',')}))`;

/**
 * The membership query. Every value below is interpolated into SQL text,
 * because ogrinfo's -sql takes a statement and not bind parameters. They all
 * come from the frozen constants in profile-fixture-params.mjs and this script
 * reads neither argv nor env, so nothing outside the repository reaches here.
 * These assertions keep that true.
 */
function membershipSql() {
  if (typeof ENDCAP_BAND !== 'number' || !Number.isFinite(ENDCAP_BAND)) {
    throw new TypeError(`membershipSql: band must be a finite number, got ${String(ENDCAP_BAND)}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(LAYER)) {
    throw new TypeError(`membershipSql: layer name is not a bare identifier: ${LAYER}`);
  }
  if (!/^LINESTRING\(-?[\d.]+ -?[\d.]+,-?[\d.]+ -?[\d.]+\)$/.test(line)) {
    throw new TypeError(`membershipSql: line is not a two-point WKT LINESTRING: ${line}`);
  }
  if (!/^POLYGON\(\((-?[\d.]+ -?[\d.]+,){4}-?[\d.]+ -?[\d.]+\)\)$/.test(rect)) {
    throw new TypeError(`membershipSql: rect is not a five-vertex WKT POLYGON: ${rect}`);
  }
  const pt = 'MakePoint(CAST(x AS REAL), CAST(y AS REAL))';
  const seg = `GeomFromText('${line}')`;
  const box = `GeomFromText('${rect}')`;
  const d = `ST_Distance(${seg}, ${pt})`;
  return (
    `SELECT id AS id, ${d} AS dist, `
    + `CASE WHEN ${d} <= ${ENDCAP_BAND} THEN 1 ELSE 0 END AS capsule, `
    + `CASE WHEN ST_Intersects(${box}, ${pt}) THEN 1 ELSE 0 END AS rect, `
    + `CASE WHEN ${d} = ${ENDCAP_BAND} THEN 1 ELSE 0 END AS onBoundary `
    + `FROM "${LAYER}"`
  );
}

/**
 * ogrinfo prints a feature block per row. Reading it back into a CSV here is a
 * transcription, not a computation: `dist` is copied as the literal text
 * ogrinfo printed, so nothing in this repository reformats a reference number.
 */
function parseFeatures(stdout) {
  const rows = [];
  let current = null;
  for (const raw of stdout.split('\n')) {
    if (/^OGRFeature/.test(raw)) {
      if (current) rows.push(current);
      current = {};
      continue;
    }
    const m = /^\s{2}(\w+) \([^)]+\) = (.*)$/.exec(raw);
    if (m && current) current[m[1]] = m[2].trim();
  }
  if (current) rows.push(current);
  return rows;
}

const record = { generatedBy: 'scripts/run-profile-endcap-reference.mjs', runs: {} };

if (!existsSync(FIXTURE)) {
  record.runs.endcap = {
    status: 'unavailable',
    detail: `${rel(FIXTURE)} is missing; run scripts/make-profile-fixture.mjs`,
  };
} else {
  const sql = membershipSql();
  if (existsSync(OUTPUT)) rmSync(OUTPUT);
  // -q drops the layer banner; the feature blocks carry every value at the
  // precision ogrinfo prints them, which is what gets copied through.
  const args = ['-q', '-dialect', 'SQLITE', '-sql', sql, rel(FIXTURE)];
  const ogr = run(OGRINFO, args);
  const rows = ogr.code === 0 ? parseFeatures(ogr.stdout) : [];
  if (ogr.code !== 0 || rows.length === 0) {
    record.runs.endcap = {
      status: 'failed',
      stage: 'ogrinfo',
      exitCode: ogr.code,
      stderr: ogr.stderr.trim() || null,
    };
    process.exitCode = 1;
  } else {
    const header = 'id,dist,capsule,rect,onBoundary';
    const lines = [header];
    for (const r of rows) lines.push([r.id, r.dist, r.capsule, r.rect, r.onBoundary].join(','));
    writeFileSync(OUTPUT, `${lines.join('\n')}\n`);
    record.runs.endcap = {
      status: 'ok',
      membershipSql: sql,
      membershipCommandLine: `${OGRINFO} ${args.join(' ')}`,
      membershipOutput: rel(OUTPUT),
      probes: rows.length,
      band: ENDCAP_BAND,
      exitCodes: { ogrinfo: ogr.code },
      stderr: ogr.stderr.trim() || null,
    };
  }
}

record.geometry = {
  tool: 'GDAL/OGR SQLite dialect with SpatiaLite',
  gdal: version(OGRINFO, ['--version']),
  spatialite: run(OGRINFO, ['-q', '-dialect', 'SQLITE', '-sql', 'SELECT spatialite_version()', rel(FIXTURE)])
    .stdout.split('=').pop().trim() || 'unavailable',
  resolvedPath: resolvedPathOf(OGRINFO),
  functions: ['ST_Distance', 'ST_Intersects', 'MakePoint', 'GeomFromText'],
};
record.containerPinning = 'not-executed';
record.containerPinningNote =
  'No containerised GDAL was used; the resolved executable path, the reported version and the exact command line stand in for an image digest.';
record.platform = `${platform}-${arch}`;
record.node = process.version;

writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`);
console.log(`endcap: ${record.runs.endcap.status}`);
console.log(`record written to ${rel(RECORD)}`);
