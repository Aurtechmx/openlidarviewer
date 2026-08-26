#!/usr/bin/env node
/**
 * run-pdal-dsm-reference.mjs — the PDAL side of the DSM (top-surface) study.
 *
 * This is the sibling of `scripts/run-pdal-reference.mjs`. That script produces
 * the ground-filter and DTM references and writes them into `reference-runs.json`;
 * this one produces the DSM reference and writes it into a SEPARATE
 * `reference-runs-dsm.json`. The split is deliberate: the ground-filter and DTM
 * study manifests already froze the exact bytes of `reference-runs.json`, and a
 * study added later must not rewrite an earlier study's provenance to record its
 * own. The DSM scenes are excluded from the other runner (`role: surface`) for
 * the same reason.
 *
 * WHAT IT COMPARES. The DSM is the upper surface: the HIGHEST return in each
 * cell, over ALL returns. PDAL computes it with `writers.gdal` `output_type: max`;
 * this project computes it with `buildDsm`. The DSM study mirrors the DTM study
 * with min -> max, on cell-centred scenes that stack returns above the ground so
 * the maximum is genuinely above the minimum.
 *
 * WHY THE RADIUS IS BELOW HALF A CELL, exactly as the DTM run. `writers.gdal` is
 * a radius estimator (a cell takes its value from every point within `radius` of
 * the cell centre); `buildDsm` is a cell estimator (a point contributes to the
 * one cell it falls in). With every return placed at a cell centre and the radius
 * below half a cell, the disc holds exactly the returns of its own cell, so both
 * estimators take the maximum over the same set and the two compute the same
 * quantity. At the default radius a disc would reach into neighbouring cells and
 * the maxima could not agree.
 *
 * NOTHING IS INFERRED. A failed invocation is recorded with `status: "failed"`
 * and the tool's own stderr, and no output file is written; the consuming test
 * then reports the leg `unavailable` rather than reading a fabricated reference.
 *
 * WHY THE RUN HAS A SECOND COMMAND. `writers.gdal` creates rasters through the
 * GDAL Create API and the AAIGrid driver is CreateCopy-only, so it is written as
 * GeoTIFF (the byte record of what PDAL computed) and `gdal_translate` transcodes
 * it to the ESRI ASCII Grid the test parses. Both files are committed and both
 * hashes are recorded.
 *
 * Parameters are passed explicitly, including the ones with defaults, so a
 * default that happens to agree today cannot silently become the comparison
 * basis. `PARAMS_DSM` is the single definition, exported so the consuming test
 * configures the candidate side from the same object.
 */

import { spawnSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  rmSync,
  realpathSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { platform, arch } from 'node:process';
import { FIXTURES, PIPELINE_DIR, EXTENT_M, DTM_CELL_M } from './generate-point-cloud-fixtures.mjs';
import { binaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(PIPELINE_DIR, 'pdal');
const PIPELINES_DIR = resolve(PIPELINE_DIR, 'pipelines');

/** Repo-relative form of an absolute path, with forward slashes. */
const rel = (abs) => relative(ROOT, abs).split('\\').join('/');

/**
 * The frozen DSM parameters, one definition for both sides.
 *
 * `radius` is 0.45, below half a cell, so each cell's disc holds exactly the
 * returns placed at that cell's centre: the radius estimator and the cell
 * estimator then take the maximum over the same set. `output_type` is `max`,
 * which is the whole difference from the DTM run.
 */
export const PARAMS_DSM = {
  outputType: 'max',
  resolution: DTM_CELL_M,
  radius: 0.45,
  originX: 0,
  originY: 0,
  width: Math.round(EXTENT_M / DTM_CELL_M),
  height: Math.round(EXTENT_M / DTM_CELL_M),
  nodata: -9999,
  dataType: 'double',
  decimalPrecision: 6,
};

/** Run a command and RETURN its failure rather than throwing, so it survives as data. */
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

/** The `writers.gdal` `output_type: max` pipeline for one DSM fixture. */
function dsmPipeline(fixtureId) {
  const p = PARAMS_DSM;
  return {
    pipeline: [
      {
        type: 'readers.text',
        filename: `validation/cross-implementation/pdal-pipeline/fixtures/${fixtureId}.csv`,
      },
      {
        type: 'writers.gdal',
        filename: `validation/cross-implementation/pdal-pipeline/pdal/${fixtureId}__dsm-max.tif`,
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
    process.stderr.write(`pdal --version failed (exit ${version.exitCode}): ${version.stderr}\n`);
    process.exit(1);
  }
  const gdalVersion = run('gdal_translate', ['--version']);

  const runs = [];
  const surfaceFixtures = FIXTURES.filter((f) => f.role === 'surface');

  for (const spec of surfaceFixtures) {
    const runId = `${spec.id}__dsm-max`;
    const pipeline = dsmPipeline(spec.id);
    const pipelinePath = resolve(PIPELINES_DIR, `${runId}.json`);
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2) + '\n', 'utf8');
    const pipelineRel = rel(pipelinePath);

    const tifOut = resolve(OUT_DIR, `${spec.id}__dsm-max.tif`);
    if (existsSync(tifOut)) rmSync(tifOut);

    const argv = ['pipeline', pipelineRel];
    const r = run('pdal', argv);
    const base = {
      runId,
      fixtureId: spec.id,
      datasetId: spec.datasetId,
      kind: 'dsm',
      reference: 'PDAL',
      pipeline: pipelineRel,
      pipelineSha256: sha256(pipelinePath),
      argv,
      commandLine: quoteArgv('pdal', argv),
      exitCode: r.exitCode,
      stderr: r.stderr.trim() || null,
    };
    if (r.exitCode !== 0 || !existsSync(tifOut)) {
      runs.push({ ...base, status: 'failed', reason: r.stderr.trim() || `exit ${r.exitCode} and no output file` });
      process.stdout.write(`FAILED  ${runId}: exit ${r.exitCode}\n`);
      continue;
    }

    const ascPath = resolve(OUT_DIR, `${spec.id}__dsm-max.asc`);
    if (existsSync(ascPath)) rmSync(ascPath);
    const auxPath = `${ascPath}.aux.xml`;
    if (existsSync(auxPath)) rmSync(auxPath);
    const tArgv = [
      '-of', 'AAIGrid',
      '-co', `DECIMAL_PRECISION=${PARAMS_DSM.decimalPrecision}`,
      rel(tifOut),
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
      parameters: PARAMS_DSM,
      rasterOutput: rel(tifOut),
      rasterSha256: sha256(tifOut),
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
    generatedBy: 'scripts/run-pdal-dsm-reference.mjs',
    reference: 'PDAL',
    evidenceNote:
      'These outputs are the cross-implementation (E4) reference for the DSM study. They are the ' +
      'only independent implementation on that side; the by-construction fixture heights are E3.',
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
    parameters: { dsm: PARAMS_DSM },
    runs,
  };
  writeFileSync(resolve(PIPELINE_DIR, 'reference-runs-dsm.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

  const sums = runs
    .filter((r) => r.status === 'ok')
    .flatMap((r) => [`${r.rasterSha256}  ${r.rasterOutput}`, `${r.sha256}  ${r.output}`])
    .join('\n');
  writeFileSync(resolve(PIPELINE_DIR, 'pdal-dsm-SHA256SUMS'), sums + '\n', 'utf8');

  const ok = runs.filter((r) => r.status === 'ok').length;
  process.stdout.write(`\n${ok} PDAL DSM outputs written, ${runs.length - ok} not produced.\n`);
  process.stdout.write(`${version.stdout.trim().split('\n').filter(Boolean).join(' | ')}\n`);
  process.exit(0);
}

if (isCliEntry(import.meta.url)) {
  main();
}
