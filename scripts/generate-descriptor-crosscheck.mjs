#!/usr/bin/env node
/**
 * generate-descriptor-crosscheck.mjs
 *
 * Produces the cross-implementation fixtures and references for the two terrain
 * descriptors, TPI and VRM. Both are analytic surfaces chosen to CONTROL a known
 * confound so the comparison measures the algorithm, not an artifact:
 *
 *   TPI  a low-amplitude quadratic z = c·(x²+y²), re-centred so |z| stays small.
 *        TPI is translation-invariant in elevation, but gdaldem accumulates the
 *        neighbourhood mean in float32, whose spacing scales with |z|. Keeping
 *        |z| small keeps that float32 error far below the tolerance, so the
 *        comparison isolates the "centre minus mean of 8" arithmetic. The
 *        closed-form interior TPI of this surface is exactly −c·mean(Δx²+Δy²).
 *
 *   VRM  a smooth tilted quadratic z = a·x + c·(x²+y²), re-centred. The tilt
 *        keeps the slope non-zero everywhere (no aspect singularity), and the
 *        gentle curvature is well resolved by the grid, so Horn's normal and
 *        SAGA's estimator both converge to the analytic normal. The comparison
 *        is over the interior; the one-cell border truncates the window and is
 *        excluded exactly as the slope cross-check excludes its border.
 *
 * The references are gdaldem 3.13.1 TPI and SAGA 7.8.2 Vector Ruggedness Measure.
 * Neither tool is a project dependency; this script runs them once and commits
 * the outputs. The cross-check tests read the committed references and never
 * invoke the tools, exactly like the slope/contour cross-checks.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import { N, CELL, TPI_C, VRM_A, VRM_C, coord } from './descriptor-fixture-params.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'validation/cross-implementation/descriptor');
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function writeAsc(path, grid) {
  let s = `ncols ${N}\nnrows ${N}\nxllcorner 0\nyllcorner 0\ncellsize ${CELL}\nNODATA_value -9999\n`;
  for (let r = 0; r < N; r++) s += grid[r].map((z) => z.toFixed(6)).join(' ') + '\n';
  writeFileSync(path, s);
}

/** z = c·(x²+y²), re-centred to zero mean. */
function tpiFixture() {
  const raw = [];
  let sum = 0;
  for (let r = 0; r < N; r++) {
    const row = [];
    for (let col = 0; col < N; col++) {
      const z = TPI_C * (coord(col) ** 2 + coord(r) ** 2);
      row.push(z);
      sum += z;
    }
    raw.push(row);
  }
  const mean = sum / (N * N);
  return raw.map((row) => row.map((z) => z - mean));
}

/** z = a·x + c·(x²+y²), re-centred to zero mean. */
function vrmFixture() {
  const raw = [];
  let sum = 0;
  for (let r = 0; r < N; r++) {
    const row = [];
    for (let col = 0; col < N; col++) {
      const z = VRM_A * coord(col) + VRM_C * (coord(col) ** 2 + coord(r) ** 2);
      row.push(z);
      sum += z;
    }
    raw.push(row);
  }
  const mean = sum / (N * N);
  return raw.map((row) => row.map((z) => z - mean));
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error?.message ?? '') };
}
const resolvedPathOf = (name) => {
  const f = binaryOnPath(name);
  if (f === null) return `unavailable: ${name} not on PATH`;
  try { return realpathSync(f); } catch { return `unavailable: ${name}`; }
};

function main() {
  mkdirSync(OUT, { recursive: true });
  const tpiDem = resolve(OUT, 'tpi-quadratic.asc');
  const vrmDem = resolve(OUT, 'vrm-tilted.asc');
  writeAsc(tpiDem, tpiFixture());
  writeAsc(vrmDem, vrmFixture());

  const gdaldem = resolvedPathOf('gdaldem');
  const gdalTranslate = resolvedPathOf('gdal_translate');
  const saga = '/Applications/QGIS-LTR.app/Contents/MacOS/bin/saga_cmd';

  // gdaldem TPI on the quadratic (AAIGrid direct).
  const tpiRef = resolve(OUT, 'tpi-quadratic__tpi.asc');
  if (existsSync(tpiRef)) rmSync(tpiRef);
  const tpiRun = run('gdaldem', ['TPI', rel(tpiDem), rel(tpiRef), '-of', 'AAIGrid']);

  // SAGA VRM on the tilted quadratic: needs a CRS-bearing tif, then transcode.
  const vrmTif = resolve(OUT, 'vrm-tilted_crs.tif');
  run('gdal_translate', ['-of', 'GTiff', '-a_srs', 'EPSG:32633', rel(vrmDem), rel(vrmTif)]);
  const vrmSaga = resolve(OUT, 'vrm-tilted__vrm.tif');
  const sagaRun = run(saga, ['ta_morphometry', '17', `-DEM=${rel(vrmTif)}`, `-VRM=${rel(vrmSaga)}`, '-MODE=1', '-RADIUS=1', '-DW_WEIGHTING=0']);
  const vrmRef = resolve(OUT, 'vrm-tilted__vrm.asc');
  if (existsSync(vrmRef)) rmSync(vrmRef);
  run('gdal_translate', ['-of', 'AAIGrid', '-co', 'DECIMAL_PRECISION=9', rel(vrmSaga), rel(vrmRef)]);
  for (const aux of [`${tpiRef}.aux.xml`, `${vrmRef}.aux.xml`]) if (existsSync(aux)) rmSync(aux);
  if (existsSync(vrmTif)) rmSync(vrmTif);
  if (existsSync(vrmSaga)) rmSync(vrmSaga);

  const record = {
    generatedBy: 'scripts/generate-descriptor-crosscheck.mjs',
    fixtures: { N, CELL, TPI_C, VRM_A, VRM_C },
    tpi: {
      reference: 'gdaldem TPI',
      resolvedPath: gdaldem,
      commandLine: `gdaldem TPI ${rel(tpiDem)} ${rel(tpiRef)} -of AAIGrid`,
      exitCode: tpiRun.code,
      stderr: tpiRun.stderr.trim() || null,
    },
    vrm: {
      reference: 'SAGA 7.8.2 ta_morphometry 17 Vector Ruggedness Measure',
      resolvedPath: saga,
      commandLine: `saga_cmd ta_morphometry 17 -DEM=<crs.tif> -VRM=<out.tif> -MODE=1 -RADIUS=1 -DW_WEIGHTING=0, then gdal_translate -of AAIGrid -co DECIMAL_PRECISION=9`,
      exitCode: sagaRun.code,
      stderr: sagaRun.stderr.trim() || null,
    },
    gdalTranslate,
    platform: `${platform}-${arch}`,
    node: process.version,
  };
  writeFileSync(resolve(OUT, 'reference-runs-descriptor.json'), JSON.stringify(record, null, 2) + '\n');
  const sums = [tpiDem, tpiRef, vrmDem, vrmRef].map((p) => `${sha256(p)}  ${rel(p)}`).join('\n');
  writeFileSync(resolve(OUT, 'descriptor-SHA256SUMS'), sums + '\n');
  process.stdout.write(`descriptor fixtures + references written to ${rel(OUT)} (tpi exit ${tpiRun.code}, vrm saga exit ${sagaRun.code})\n`);
}

if (isCliEntry(import.meta.url)) main();
