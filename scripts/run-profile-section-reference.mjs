#!/usr/bin/env node
/**
 * run-profile-section-reference.mjs — resolve every fixture point against the
 * section line with OGR, and record what produced the answer.
 *
 * Two columns come back per point.
 *
 *   frac  ST_Line_Locate_Point, the position along the line as a fraction.
 *         It CLAMPS to [0, 1], so `frac * length` is the chainage for a point
 *         beside the line and the nearer endpoint's chainage for a point past
 *         an end. That is the same clamp the corridor applies, so this column
 *         grades the chainage and the endpoint clamp together.
 *
 *   dist  ST_Distance to the finite LINESTRING: the perpendicular offset
 *         between the endpoints, the radial distance past either end.
 *
 * The section is oblique in XY and the scene is Z-up. OGR resolves geometry in
 * the horizontal plane and has no arbitrary up axis, so this leg covers Z-up.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { SECTION_A, SECTION_B, BAND } from './make-profile-section-fixture.mjs';

const BASE = 'validation/cross-implementation/profile';
const FIXTURE = `${BASE}/profile-section.csv`;
const OUT = `${BASE}/profile-section__projection.csv`;
const RECORD = `${BASE}/reference-runs-profile-section.json`;

const LINE = `LINESTRING(${SECTION_A[0]} ${SECTION_A[1]},${SECTION_B[0]} ${SECTION_B[1]})`;
const PT = 'MakePoint(CAST(x AS REAL),CAST(y AS REAL))';
const SQL =
  `SELECT id AS id, ` +
  `ST_Line_Locate_Point(GeomFromText('${LINE}'), ${PT}) AS frac, ` +
  `ST_Distance(GeomFromText('${LINE}'), ${PT}) AS dist ` +
  `FROM "profile-section"`;
const ARGS = ['-q', '-dialect', 'SQLITE', '-sql', SQL, FIXTURE];

function version(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

const raw = execFileSync('ogrinfo', ARGS, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const re = /id \(String\) = (\S+)\n\s*frac \(Real\) = ([\d.eE+-]+)\n\s*dist \(Real\) = ([\d.eE+-]+)/g;
const lines = ['id,frac,dist'];
let m;
let count = 0;
while ((m = re.exec(raw)) !== null) {
  lines.push(`${m[1]},${m[2]},${m[3]}`);
  count++;
}
if (count === 0) throw new Error('ogrinfo returned no features');
writeFileSync(OUT, lines.join('\n') + '\n');

let spatialite = null;
try {
  const sv = execFileSync(
    'ogrinfo',
    ['-q', '-dialect', 'SQLITE', '-sql', "SELECT spatialite_version() AS v", FIXTURE],
    { encoding: 'utf8' },
  );
  spatialite = (sv.match(/v \(String\) = (\S+)/) ?? [])[1] ?? null;
} catch {
  spatialite = null;
}

writeFileSync(
  RECORD,
  JSON.stringify(
    {
      generatedBy: 'scripts/run-profile-section-reference.mjs',
      runs: {
        projection: {
          status: 'ok',
          sql: SQL,
          commandLine: ['ogrinfo', ...ARGS].join(' '),
          output: OUT,
          points: count,
          band: BAND,
          sectionA: SECTION_A,
          sectionB: SECTION_B,
          exitCodes: { ogrinfo: 0 },
          stderr: null,
        },
      },
      geometry: {
        tool: 'GDAL/OGR SQLite dialect with SpatiaLite',
        gdal: version('gdalinfo', ['--version']),
        spatialite,
        functions: ['ST_Line_Locate_Point', 'ST_Distance', 'MakePoint', 'GeomFromText'],
      },
      clampNote:
        'ST_Line_Locate_Point clamps to [0, 1], so frac * length is the chainage beside the line and the nearer endpoint past an end.',
      containerPinning: 'not-executed',
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
    },
    null,
    2,
  ) + '\n',
);
process.stdout.write(`profile-section__projection.csv: ${count} points\n`);
