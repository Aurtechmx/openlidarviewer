#!/usr/bin/env node
/**
 * run-gdaldem-reference.mjs — produce the GDAL side of the raster agreement
 * matrix.
 *
 * This is the script that makes a comparison CROSS-IMPLEMENTATION. Everything
 * `scripts/generate-raster-fixtures.mjs` produces is analytic: comparing our
 * kernel against a closed form on those grids is E2, and against a synthetic
 * surface E3. A comparison only reaches E4 when a second, independently written
 * implementation produced the reference, so every output here is stamped with
 * `reference: "GDAL"` and the exact argv that produced it, and the test refuses
 * to label a leg cross-implementation unless it found one of these files.
 *
 * NOTHING IS INFERRED. If a gdaldem invocation fails, or the tool does not
 * support the option the comparison needs, the run is recorded with
 * `status: "failed"` or `status: "unavailable"` and the operator's own stderr,
 * and no output file is written. A zero, a copied neighbour or a re-run with
 * different options substituted for a failure would be fabricating a reference.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERENCE PINNING
 * ─────────────────────────────────────────────────────────────────────────────
 * Recorded into `reference-runs.json`: `gdalinfo --version` verbatim, the
 * RESOLVED executable path (following symlinks, so a Homebrew shim cannot hide
 * which build ran), platform, architecture, Node version, and the full argv of
 * every invocation together with its exit code and any stderr. Container pinning
 * is recorded as `not-executed`: Docker is installed on this host but the daemon
 * is not running, so no containerised GDAL was used and claiming otherwise would
 * misdescribe the provenance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY DECIMAL_PRECISION IS SET ON THE FLOAT OUTPUTS
 * ─────────────────────────────────────────────────────────────────────────────
 * AAIGrid otherwise writes a full double expansion per cell, which triples the
 * size of the committed tree for digits that sit ~10 orders of magnitude below
 * every tolerance in the comparison. Six decimals keeps the outputs reviewable.
 * It is NOT applied to hillshade: that band is Byte, and forcing six decimals on
 * integers 0-255 would only pad the file.
 */

import { spawnSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
  accessSync,
  constants,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, basename } from 'node:path';
import { platform, arch } from 'node:process';
import { FIXTURES, MATRIX_DIR, FIXTURE_DIR, SUNS, cellMetres } from './generate-raster-fixtures.mjs';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const OUT_DIR = resolve(MATRIX_DIR, 'gdal');
const GDALDEM = 'gdaldem';

/**
 * Run a command and RETURN its failure rather than throwing.
 *
 * `execFileSync` throws on a non-zero exit, and a thrown error here would abort
 * the whole matrix at the first unsupported option, losing every run after it.
 * The exit code and stderr are part of the record, so they have to survive as
 * data.
 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    exitCode: r.status === null ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  };
}

/**
 * The gdaldem invocation for each product name used in the fixture matrix.
 *
 * Every parameter both tools have a default for is passed EXPLICITLY. A default
 * that happens to agree today is not a comparison basis: if either side changed
 * its default the two grids would be computed under different parameters and the
 * cross-check would report a modelling disagreement that is really a parameter
 * disagreement.
 *
 * `-xscale`/`-yscale` convert the horizontal unit to metres and are required on
 * the geographic fixture, where the two axes have different metre lengths. Note
 * which subcommands accept them (verified from `gdaldem <sub> --help` on GDAL
 * 3.13.1): `slope` and `hillshade` do, `aspect` does NOT. That asymmetry is a
 * limit of the reference tool and is recorded per-run in `axisScaling`, not
 * papered over.
 */
function buildArgs(spec, product, inPath, outPath) {
  const m = cellMetres(spec);
  const geo = spec.crs === 'geographic';
  // gdaldem requires xscale and yscale together or not at all (verified: passing
  // only -xscale exits 1 with "both must be specified").
  const scale = geo ? ['-xscale', String(m.x / spec.cellsize), '-yscale', String(m.y / spec.cellsize)] : [];
  const floatCo = ['-co', 'DECIMAL_PRECISION=6'];

  if (product === 'slope-deg') {
    return { argv: ['slope', inPath, outPath, '-alg', 'Horn', '-of', 'AAIGrid', ...scale, ...floatCo],
      unit: 'degree', axisScaling: geo ? 'xscale/yscale in metres per degree' : 'none (metre grid)' };
  }
  if (product === 'slope-pct') {
    return { argv: ['slope', inPath, outPath, '-alg', 'Horn', '-p', '-of', 'AAIGrid', ...scale, ...floatCo],
      unit: 'percent rise', axisScaling: geo ? 'xscale/yscale in metres per degree' : 'none (metre grid)' };
  }
  if (product === 'slope-deg-edges') {
    return { argv: ['slope', inPath, outPath, '-alg', 'Horn', '-compute_edges', '-of', 'AAIGrid', ...scale, ...floatCo],
      unit: 'degree', axisScaling: geo ? 'xscale/yscale in metres per degree' : 'none (metre grid)' };
  }
  if (product === 'tpi') {
    // gdaldem TPI is the Topographic Position Index: centre minus the mean of the
    // eight surrounding cells, in the DEM's own Z unit. It accepts NEITHER -alg
    // (there is one algorithm) NOR -xscale/-yscale/-s (verified from
    // `gdaldem TPI --help` on GDAL 3.13.1: the only options are -compute_edges,
    // -b, -co, -of, -q). It operates on the raw Z neighbourhood and is therefore
    // independent of cell size and CRS. No -compute_edges: the border ring is left
    // as nodata, exactly the interior-only set the comparison uses, matching the
    // no-edges convention of the plain `slope-deg` run.
    return { argv: ['TPI', inPath, outPath, '-of', 'AAIGrid', ...floatCo],
      unit: 'Z unit (grid elevation unit)',
      // Recorded as a fact, not a workaround: for aspect the missing -xscale/-yscale
      // was a limit of the reference tool; for TPI it is the definition — TPI carries
      // no horizontal unit — so the geographic fixture is compared with no caveat.
      axisScaling: geo
        ? 'none: gdaldem TPI has no -xscale/-yscale and none is needed — TPI is a raw-Z neighbourhood, independent of the horizontal unit'
        : 'none (raw-Z neighbourhood; no horizontal scaling)' };
  }
  if (product === 'aspect') {
    return { argv: ['aspect', inPath, outPath, '-alg', 'Horn', '-of', 'AAIGrid', ...floatCo],
      unit: 'compass degree clockwise from north, -9999 on flat',
      // Stated per run rather than in prose: gdaldem aspect has no -xscale or
      // -yscale, so on the geographic fixture this reference is computed with
      // EQUAL degree spacing on both axes and is not the physically correct
      // bearing. The test reports that separately instead of pretending
      // otherwise.
      axisScaling: geo ? 'UNSUPPORTED by gdaldem aspect: computed on equal degree spacing' : 'none (metre grid)' };
  }
  if (product === 'aspect-zero-flat') {
    return { argv: ['aspect', inPath, outPath, '-alg', 'Horn', '-zero_for_flat', '-of', 'AAIGrid', ...floatCo],
      unit: 'compass degree clockwise from north, 0 on flat',
      axisScaling: geo ? 'UNSUPPORTED by gdaldem aspect: computed on equal degree spacing' : 'none (metre grid)' };
  }
  if (product === 'hillshade-multi') {
    // No -az: gdaldem's multidirectional model lights from four fixed obliques
    // and an azimuth would be meaningless. Altitude and z-factor still apply.
    const sun = SUNS[0];
    return { argv: ['hillshade', inPath, outPath, '-alt', String(sun.altitudeDeg), '-z', String(sun.zFactor),
      '-alg', 'Horn', '-multidirectional', '-of', 'AAIGrid', ...scale],
      unit: 'Byte 0-255, nodata 0', axisScaling: geo ? 'xscale/yscale in metres per degree' : 'none (metre grid)' };
  }
  if (product.startsWith('hillshade-')) {
    const sunId = product.slice('hillshade-'.length);
    const sun = SUNS.find((s) => s.id === sunId);
    if (!sun) return null;
    // `-s 1` states the metre-grid vertical:horizontal ratio explicitly, but it
    // is mutually exclusive with the per-axis form, so the geographic fixture
    // carries -xscale/-yscale instead.
    const vertical = geo ? [] : ['-s', '1'];
    return { argv: ['hillshade', inPath, outPath, '-az', String(sun.azimuthDeg), '-alt', String(sun.altitudeDeg),
      '-z', String(sun.zFactor), ...vertical, '-alg', 'Horn', '-of', 'AAIGrid', ...scale],
      unit: 'Byte 0-255, nodata 0', axisScaling: geo ? 'xscale/yscale in metres per degree' : 'none (metre grid)' };
  }
  return null;
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');


function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const version = run('gdalinfo', ['--version']);
  if (version.exitCode !== 0) {
    // No usable GDAL means no cross-implementation reference at all. Recorded
    // and exited non-zero rather than writing an empty run list that a later
    // reader could mistake for "ran, found nothing".
    process.stderr.write(`gdalinfo --version failed (exit ${version.exitCode}): ${version.stderr}\n`);
    process.exit(1);
  }

  let resolvedPath;
  const found = binaryOnPath(GDALDEM);
  try {
    resolvedPath = found === null ? 'unavailable: not on PATH' : realpathSync(found);
  } catch {
    resolvedPath = 'unavailable: could not resolve symlink';
  }

  const runs = [];
  for (const spec of FIXTURES) {
    const inPath = resolve(FIXTURE_DIR, `${spec.id}.asc`);
    for (const product of spec.products) {
      const runId = `${spec.id}__${product}`;
      const outPath = resolve(OUT_DIR, `${runId}.asc`);
      const built = buildArgs(spec, product, inPath, outPath);
      if (!built) {
        runs.push({ runId, fixtureId: spec.id, product, reference: 'GDAL', status: 'unavailable',
          reason: `no gdaldem invocation is defined for product "${product}"`, argv: null, exitCode: null });
        continue;
      }
      // Removed first so a stale output from an earlier run can never be
      // mistaken for the product of a command that has since started failing.
      if (existsSync(outPath)) rmSync(outPath);
      const r = run(GDALDEM, built.argv);
      const commandLine = [GDALDEM, ...built.argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a))].join(' ');
      if (r.exitCode !== 0 || !existsSync(outPath)) {
        runs.push({ runId, fixtureId: spec.id, product, reference: 'GDAL', status: 'failed',
          reason: r.stderr.trim() || `exit ${r.exitCode} and no output file`,
          argv: built.argv, commandLine, exitCode: r.exitCode, unit: built.unit, axisScaling: built.axisScaling });
        process.stdout.write(`FAILED  ${runId}: exit ${r.exitCode}\n`);
        continue;
      }
      runs.push({ runId, fixtureId: spec.id, product, reference: 'GDAL', status: 'ok',
        argv: built.argv, commandLine, exitCode: r.exitCode,
        stderr: r.stderr.trim() || null,
        unit: built.unit, axisScaling: built.axisScaling,
        output: `gdal/${basename(outPath)}`, sha256: sha256(outPath) });
      process.stdout.write(`ok      ${runId}\n`);
    }
  }

  const record = {
    generatedBy: 'scripts/run-gdaldem-reference.mjs',
    reference: 'GDAL',
    evidenceNote:
      'These outputs are the ONLY cross-implementation (E4) reference in this matrix. ' +
      'The analytic legs in tests/rasterAgreementMatrix.test.ts are E2/E3 and are labelled as such.',
    environment: {
      gdalinfoVersion: version.stdout.trim(),
      gdaldemResolvedPath: resolvedPath,
      // Not omitted: recorded as not-executed so the provenance says what did
      // NOT happen. Docker is installed here but the daemon is not running, so
      // no pinned container image was used.
      containerPinning: 'not-executed',
      containerPinningReason: 'Docker daemon is not running on this host; GDAL was invoked from the host PATH.',
      projVersion: 'not-recorded: projinfo on this host has no --version flag and gdaldem does not report PROJ',
      platform,
      architecture: arch,
      node: process.version,
    },
    runs,
  };
  writeFileSync(resolve(MATRIX_DIR, 'reference-runs.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

  const sums = runs
    .filter((r) => r.status === 'ok')
    .map((r) => `${r.sha256}  ${r.output}`)
    .join('\n');
  writeFileSync(resolve(MATRIX_DIR, 'gdal-SHA256SUMS'), sums + '\n', 'utf8');

  const ok = runs.filter((r) => r.status === 'ok').length;
  const bad = runs.length - ok;
  process.stdout.write(`\n${ok} gdaldem outputs written, ${bad} not produced.\n`);
  process.stdout.write(`${version.stdout.trim()}\n${resolvedPath}\n`);
  // A failed reference run is a finding, not a build break: the record carries
  // the reason and the test reports the leg as unavailable rather than passing.
  process.exit(0);
}

export { buildArgs };

if (isCliEntry(import.meta.url)) {
  main();
}
