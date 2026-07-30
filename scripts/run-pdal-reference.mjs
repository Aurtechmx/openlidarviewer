#!/usr/bin/env node
/**
 * run-pdal-reference.mjs — produce the PDAL side of the point-cloud studies.
 *
 * This is the script that makes the point-cloud comparisons
 * CROSS-IMPLEMENTATION. `scripts/generate-point-cloud-fixtures.mjs` writes
 * scenes whose ground membership this project also defined, so comparing our
 * filter against those labels is E3 however many scenes there are. A comparison
 * reaches E4 only when a second, independently written implementation produced
 * the reference, so every output here is stamped with the exact argv, the exit
 * code and the reported version of the tool that produced it, and the consuming
 * test refuses to label a leg cross-implementation unless it found one of these
 * files.
 *
 * NOTHING IS INFERRED. If an invocation fails, the run is recorded with
 * `status: "failed"` and the tool's own stderr, and no output file is written.
 * A zero, a copied neighbour, or a re-run with different options substituted for
 * a failure would be fabricating a reference.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO KINDS OF RUN
 * ─────────────────────────────────────────────────────────────────────────────
 *   ground  `filters.smrf` over a classification fixture, written back out as
 *           text with X, Y, Z and Classification. Point order is the fixture's
 *           order; the consuming test re-reads the coordinates and refuses the
 *           comparison if any row has moved, rather than trusting the order.
 *   dtm     `writers.gdal` over a bare-earth fixture, then a transcode to ESRI
 *           ASCII Grid. Both steps are recorded.
 *
 * WHY THE DTM RUN HAS A SECOND COMMAND. `writers.gdal` creates rasters through
 * the GDAL Create API, and the AAIGrid driver has no Create — it is
 * CreateCopy-only, and asking for it exits 1 with "does not support file
 * creation". So the raster is written as GeoTIFF, which is the byte record of
 * what PDAL computed, and `gdal_translate` transcodes it to the text grid the
 * test parses. Both files are committed and both hashes are recorded, so the
 * transcode is auditable rather than asserted. Reading a GeoTIFF in Node would
 * otherwise need a dependency this project would carry in its SBOM forever.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * REFERENCE PINNING
 * ─────────────────────────────────────────────────────────────────────────────
 * Recorded into `reference-runs.json`: `pdal --version` verbatim, the RESOLVED
 * executable path (following symlinks, so a shim cannot hide which build ran),
 * the same for `gdal_translate`, the platform, the architecture, the Node
 * version, and the full argv, exit code and stderr of every invocation.
 * Container pinning is recorded as `not-executed`: Docker is not running on this
 * host, so no containerised PDAL was used and claiming otherwise would
 * misdescribe the provenance.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PATHS ARE REPO-RELATIVE, ON PURPOSE
 * ─────────────────────────────────────────────────────────────────────────────
 * Every filename in a pipeline and in an argv is relative to the repository
 * root, and each command runs with that root as its working directory. An
 * absolute path would put the machine this ran on into a committed record;
 * `scripts/lint-no-host-paths.mjs` exists because that has happened before.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * PARAMETERS ARE PASSED EXPLICITLY, INCLUDING THE ONES WITH DEFAULTS
 * ─────────────────────────────────────────────────────────────────────────────
 * A default that happens to agree today is not a comparison basis: if either
 * side changed its default, the two results would be computed under different
 * parameters and the study would report a modelling disagreement that is really
 * a parameter disagreement. `PARAMS` below is the single definition, exported so
 * the consuming test configures our side from the same object.
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
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { FIXTURES, PIPELINE_DIR, EXTENT_M, DTM_CELL_M } from './generate-point-cloud-fixtures.mjs';
import { binaryOnPath } from './lib/binaryOnPath.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(PIPELINE_DIR, 'pdal');
const PIPELINES_DIR = resolve(PIPELINE_DIR, 'pipelines');

/** Repo-relative form of an absolute path, with forward slashes. */
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

/**
 * The frozen parameters, one definition for both sides.
 *
 * `smrf.window`. PDAL documents this as "max window size" and our filter takes
 * `maxWindowCells`, a count of cells. Rather than assert which unit PDAL means,
 * the cell size is pinned at 1, where the two readings coincide. A study at a
 * different cell size would have to settle the question first.
 *
 * `smrf.scalar` and our `scalingFactorM` are both 0. Each side otherwise adds a
 * slope-scaled term to the classification tolerance, and each derives the local
 * slope its own way; zeroing it removes an axis that would otherwise be
 * confounded with the morphological core this study is about.
 *
 * `smrf.cut` is 0, which is PDAL's default and disables SMRF's net-cutting
 * refinement. Our filter does not implement that pass at all, so the comparison
 * is between two implementations of the same published core.
 *
 * `dtm.radius` is 0.45, below half a cell. Every bare-earth fixture holds one
 * return per cell at the cell centre, so a disc that small holds exactly the
 * return belonging to that cell: PDAL's radius estimator and our cell estimator
 * then compute the same quantity. At the default radius (`resolution * sqrt(2)`)
 * they could not, because a disc is not a square.
 */
export const PARAMS = {
  smrf: {
    cell: 1.0,
    window: 16,
    slope: 0.15,
    threshold: 0.5,
    scalar: 0.0,
    cut: 0.0,
    groundClass: 2,
    otherClass: 1,
  },
  dtm: {
    outputType: 'min',
    resolution: DTM_CELL_M,
    radius: 0.45,
    originX: 0,
    originY: 0,
    width: Math.round(EXTENT_M / DTM_CELL_M),
    height: Math.round(EXTENT_M / DTM_CELL_M),
    nodata: -9999,
    dataType: 'double',
    decimalPrecision: 6,
  },
};

/**
 * Run a command and RETURN its failure rather than throwing.
 *
 * `execFileSync` throws on a non-zero exit, and a thrown error here would abort
 * the whole set at the first failure, losing every run after it. The exit code
 * and stderr are part of the record, so they have to survive as data.
 */
function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT });
  return {
    exitCode: r.status === null ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  };
}


function resolvedPathOf(name) {
  const found = binaryOnPath(name);
  if (found === null) return `unavailable: ${name} is not on PATH`;
  try {
    return realpathSync(found);
  } catch {
    return `unavailable: could not resolve the symlink for ${name}`;
  }
}

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** The `filters.smrf` pipeline for one classification fixture. */
function groundPipeline(fixtureId) {
  const p = PARAMS.smrf;
  return {
    pipeline: [
      {
        type: 'readers.text',
        filename: `validation/cross-implementation/pdal-pipeline/fixtures/${fixtureId}.csv`,
      },
      {
        type: 'filters.smrf',
        cell: p.cell,
        window: p.window,
        slope: p.slope,
        threshold: p.threshold,
        scalar: p.scalar,
        cut: p.cut,
        ground_class: p.groundClass,
        other_class: p.otherClass,
      },
      {
        type: 'writers.text',
        filename: `validation/cross-implementation/pdal-pipeline/pdal/${fixtureId}__smrf.csv`,
        order: 'X,Y,Z,Classification',
        keep_unspecified: 'false',
        precision: 6,
      },
    ],
  };
}

/** The `writers.gdal` pipeline for one bare-earth fixture. */
function dtmPipeline(fixtureId) {
  const p = PARAMS.dtm;
  return {
    pipeline: [
      {
        type: 'readers.text',
        filename: `validation/cross-implementation/pdal-pipeline/fixtures/${fixtureId}.csv`,
      },
      {
        type: 'writers.gdal',
        filename: `validation/cross-implementation/pdal-pipeline/pdal/${fixtureId}__dtm-min.tif`,
        gdaldriver: 'GTiff',
        output_type: p.outputType,
        resolution: p.resolution,
        radius: p.radius,
        origin_x: p.originX,
        origin_y: p.originY,
        width: p.width,
        height: p.height,
        nodata: p.nodata,
        data_type: p.dataType,
      },
    ],
  };
}

const quoteArgv = (cmd, argv) =>
  [cmd, ...argv.map((a) => (a.includes(' ') ? JSON.stringify(a) : a))].join(' ');

function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(PIPELINES_DIR, { recursive: true });

  const version = run('pdal', ['--version']);
  if (version.exitCode !== 0) {
    // No usable PDAL means no cross-implementation reference at all. Recorded
    // and exited non-zero rather than writing an empty run list that a later
    // reader could mistake for "ran, found nothing".
    process.stderr.write(`pdal --version failed (exit ${version.exitCode}): ${version.stderr}\n`);
    process.exit(1);
  }
  const gdalVersion = run('gdal_translate', ['--version']);

  const runs = [];

  for (const spec of FIXTURES) {
    const isGround = spec.role === 'classification';
    const runId = `${spec.id}__${isGround ? 'smrf' : 'dtm-min'}`;
    const pipeline = isGround ? groundPipeline(spec.id) : dtmPipeline(spec.id);
    const pipelinePath = resolve(PIPELINES_DIR, `${runId}.json`);
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2) + '\n', 'utf8');
    const pipelineRel = rel(pipelinePath);

    const primaryOut = isGround
      ? resolve(OUT_DIR, `${spec.id}__smrf.csv`)
      : resolve(OUT_DIR, `${spec.id}__dtm-min.tif`);
    // Removed first so a stale output from an earlier run can never be mistaken
    // for the product of a command that has since started failing.
    if (existsSync(primaryOut)) rmSync(primaryOut);

    const argv = ['pipeline', pipelineRel];
    const r = run('pdal', argv);
    const base = {
      runId,
      fixtureId: spec.id,
      datasetId: spec.datasetId,
      kind: isGround ? 'ground' : 'dtm',
      reference: 'PDAL',
      pipeline: pipelineRel,
      pipelineSha256: sha256(pipelinePath),
      argv,
      commandLine: quoteArgv('pdal', argv),
      exitCode: r.exitCode,
      stderr: r.stderr.trim() || null,
    };
    if (r.exitCode !== 0 || !existsSync(primaryOut)) {
      runs.push({
        ...base,
        status: 'failed',
        reason: r.stderr.trim() || `exit ${r.exitCode} and no output file`,
      });
      process.stdout.write(`FAILED  ${runId}: exit ${r.exitCode}\n`);
      continue;
    }

    if (isGround) {
      runs.push({
        ...base,
        status: 'ok',
        parameters: PARAMS.smrf,
        output: rel(primaryOut),
        sha256: sha256(primaryOut),
      });
      process.stdout.write(`ok      ${runId}\n`);
      continue;
    }

    // ── the transcode ───────────────────────────────────────────────────────
    const ascPath = resolve(OUT_DIR, `${spec.id}__dtm-min.asc`);
    if (existsSync(ascPath)) rmSync(ascPath);
    // gdal_translate writes a sidecar next to an AAIGrid output; removed too, so
    // a stale one cannot outlive the grid it described.
    const auxPath = `${ascPath}.aux.xml`;
    if (existsSync(auxPath)) rmSync(auxPath);
    const tArgv = [
      '-of', 'AAIGrid',
      '-co', `DECIMAL_PRECISION=${PARAMS.dtm.decimalPrecision}`,
      rel(primaryOut),
      rel(ascPath),
    ];
    const t = run('gdal_translate', tArgv);
    if (t.exitCode !== 0 || !existsSync(ascPath)) {
      runs.push({
        ...base,
        status: 'failed',
        reason: `pdal succeeded but the transcode failed: ${t.stderr.trim() || `exit ${t.exitCode}`}`,
        transcodeArgv: tArgv,
        transcodeCommandLine: quoteArgv('gdal_translate', tArgv),
        transcodeExitCode: t.exitCode,
      });
      process.stdout.write(`FAILED  ${runId}: transcode exit ${t.exitCode}\n`);
      continue;
    }
    if (existsSync(auxPath)) rmSync(auxPath);
    runs.push({
      ...base,
      status: 'ok',
      parameters: PARAMS.dtm,
      rasterOutput: rel(primaryOut),
      rasterSha256: sha256(primaryOut),
      transcodeArgv: tArgv,
      transcodeCommandLine: quoteArgv('gdal_translate', tArgv),
      transcodeExitCode: t.exitCode,
      transcodeStderr: t.stderr.trim() || null,
      output: rel(ascPath),
      sha256: sha256(ascPath),
    });
    process.stdout.write(`ok      ${runId}\n`);
  }

  const record = {
    generatedBy: 'scripts/run-pdal-reference.mjs',
    reference: 'PDAL',
    evidenceNote:
      'These outputs are the ONLY cross-implementation (E4) reference in the PDAL pipeline ' +
      'studies. The by-construction ground labels in fixtures/*.truth are E3 and are labelled ' +
      'as such wherever they are compared.',
    environment: {
      pdalVersion: version.stdout.trim(),
      pdalResolvedPath: resolvedPathOf('pdal'),
      gdalTranslateVersion: gdalVersion.exitCode === 0 ? gdalVersion.stdout.trim() : `unavailable: exit ${gdalVersion.exitCode}`,
      gdalTranslateResolvedPath: resolvedPathOf('gdal_translate'),
      containerPinning: 'not-executed',
      containerPinningReason:
        'The Docker daemon is not running on this host, so no pinned image was pulled and no digest exists to record; PDAL was invoked from the host PATH.',
      platform,
      architecture: arch,
      node: process.version,
    },
    parameters: PARAMS,
    runs,
  };
  writeFileSync(resolve(PIPELINE_DIR, 'reference-runs.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

  const sums = runs
    .filter((r) => r.status === 'ok')
    .flatMap((r) =>
      r.rasterOutput
        ? [`${r.rasterSha256}  ${r.rasterOutput}`, `${r.sha256}  ${r.output}`]
        : [`${r.sha256}  ${r.output}`],
    )
    .join('\n');
  writeFileSync(resolve(PIPELINE_DIR, 'pdal-SHA256SUMS'), sums + '\n', 'utf8');

  const ok = runs.filter((r) => r.status === 'ok').length;
  process.stdout.write(`\n${ok} PDAL outputs written, ${runs.length - ok} not produced.\n`);
  process.stdout.write(`${version.stdout.trim().split('\n').filter(Boolean).join(' | ')}\n`);
  // A failed reference run is a finding, not a build break: the record carries
  // the reason and the study reports the leg as unavailable rather than passing.
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
