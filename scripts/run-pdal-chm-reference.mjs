#!/usr/bin/env node
/**
 * run-pdal-chm-reference.mjs
 *
 * The CHM (canopy height model) cross-implementation reference. CHM is
 * DSM − DTM per cell, clamped at zero. The DSM reference for the structure
 * fixtures already exists (scripts/run-pdal-dsm-reference.mjs writes
 * `<id>__dsm-max.asc`). This script adds the missing half: a `writers.gdal`
 * `output_type: min` grid over the SAME structure fixtures, written as
 * `<id>__dtm-min.asc`. The CHM leg in tests/groundFilterPdalAgreement.test.ts
 * differences the two committed PDAL grids and compares against OLV's
 * `heightAboveGround`.
 *
 * The structure fixtures place a ground return in EVERY cell plus roof/facade
 * returns above it (see scripts/generate-point-cloud-fixtures.mjs,
 * `cell-centred-structured`), so the per-cell minimum is the ground and the
 * per-cell maximum is the top surface: CHM = max − min is a real height above
 * ground. `radius` is 0.45, below half a cell, so PDAL's radius estimator and
 * OLV's cell estimator hold the same returns, exactly as the DSM and DTM
 * studies arrange it. This tests the gridding arithmetic, not a neighbourhood
 * search.
 */
import { spawnSync } from 'node:child_process';
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  rmSync,
  realpathSync,
  readFileSync,
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
 * The frozen DTM-min parameters. Identical to the DSM run except `output_type`
 * is `min`, so the two grids align cell-for-cell and CHM = max − min is exact.
 */
export const PARAMS_DTM_MIN = {
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

/** The `writers.gdal` `output_type: min` pipeline for one structure fixture. */
function dtmMinPipeline(fixtureId) {
  const p = PARAMS_DTM_MIN;
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
    process.stderr.write(`pdal --version failed (exit ${version.exitCode}): ${version.stderr}\n`);
    process.exit(1);
  }
  const gdalVersion = run('gdal_translate', ['--version']);

  const runs = [];
  const surfaceFixtures = FIXTURES.filter((f) => f.role === 'surface');

  for (const spec of surfaceFixtures) {
    const runId = `${spec.id}__dtm-min`;
    const pipeline = dtmMinPipeline(spec.id);
    const pipelinePath = resolve(PIPELINES_DIR, `${runId}.json`);
    writeFileSync(pipelinePath, JSON.stringify(pipeline, null, 2) + '\n', 'utf8');
    const pipelineRel = rel(pipelinePath);

    const tifOut = resolve(OUT_DIR, `${spec.id}__dtm-min.tif`);
    if (existsSync(tifOut)) rmSync(tifOut);

    const argv = ['pipeline', pipelineRel];
    const r = run('pdal', argv);
    const base = {
      runId,
      fixtureId: spec.id,
      datasetId: spec.datasetId,
      kind: 'dtm-min',
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

    const ascPath = resolve(OUT_DIR, `${spec.id}__dtm-min.asc`);
    if (existsSync(ascPath)) rmSync(ascPath);
    const auxPath = `${ascPath}.aux.xml`;
    if (existsSync(auxPath)) rmSync(auxPath);
    const tArgv = [
      '-of', 'AAIGrid',
      '-co', `DECIMAL_PRECISION=${PARAMS_DTM_MIN.decimalPrecision}`,
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
      parameters: PARAMS_DTM_MIN,
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
    generatedBy: 'scripts/run-pdal-chm-reference.mjs',
    reference: 'PDAL',
    evidenceNote:
      'These `output_type: min` grids are the ground half of the CHM (E4) reference for the ' +
      'structure fixtures; the DSM half is `<id>__dsm-max.asc` from run-pdal-dsm-reference.mjs. ' +
      'CHM = max − min, clamped at zero. The by-construction fixture heights are E3.',
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
    parameters: { dtmMin: PARAMS_DTM_MIN },
    runs,
  };
  writeFileSync(resolve(PIPELINE_DIR, 'reference-runs-chm.json'), JSON.stringify(record, null, 2) + '\n', 'utf8');

  const sums = runs
    .filter((r) => r.status === 'ok')
    .flatMap((r) => [`${r.rasterSha256}  ${r.rasterOutput}`, `${r.sha256}  ${r.output}`])
    .join('\n');
  writeFileSync(resolve(PIPELINE_DIR, 'pdal-chm-SHA256SUMS'), sums + '\n', 'utf8');

  const ok = runs.filter((r) => r.status === 'ok').length;
  process.stdout.write(`\n${ok} PDAL DTM-min outputs written, ${runs.length - ok} not produced.\n`);
  process.stdout.write(`${version.stdout.trim().split('\n').filter(Boolean).join(' | ')}\n`);
  process.exit(0);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
