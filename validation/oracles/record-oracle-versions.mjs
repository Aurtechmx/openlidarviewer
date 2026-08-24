#!/usr/bin/env node
/**
 * record-oracle-versions.mjs — the environment block a reference run writes.
 *
 * scripts/run-pdal-reference.mjs, run-pdal-dsm-reference.mjs,
 * run-pdal-chm-reference.mjs and run-gdaldem-reference.mjs each build an
 * `environment` object by hand, and each builds a slightly different one. The
 * shape they agree on is:
 *
 *   <tool>Version         the tool's own --version output, verbatim
 *   <tool>ResolvedPath    the executable after symlinks are followed
 *   containerPinning      "executed" or "not-executed"
 *   containerPinningReason
 *   platform, architecture, node
 *
 * This module produces that object for every oracle at once, so a run inside
 * the pinned image records what it actually used rather than what the image is
 * supposed to contain. It adds nothing the existing readers would choke on: the
 * field names are the ones already in the committed records, and the new fields
 * sit beside them.
 *
 * It never invents a version. A tool that is missing is recorded as
 * `unavailable: ...`, which is the exact wording the existing runners use, and
 * the study that needed it records `status: "failed"` as it already does.
 *
 * `containerPinning` is the field the whole image exists to change. Every
 * committed record says `not-executed` today, with a reason naming a stopped
 * Docker daemon. Inside the image this reads `executed` and carries the base
 * image digest and the lock digest, which is a pin a later reader can act on.
 *
 * Usage:
 *   node record-oracle-versions.mjs                  print the block as JSON
 *   node record-oracle-versions.mjs out.json         write it
 *   import { oracleEnvironment } from './record-oracle-versions.mjs'
 */

import { spawnSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute, delimiter } from 'node:path';
import { platform, arch } from 'node:process';

/** Where the Dockerfile bakes the identity of the image itself. */
const IMAGE_FACTS = '/etc/olv-oracle-image.json';

/** PATH lookup, kept local so this file can be copied into the image alone. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = resolve(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return {
    exitCode: r.status === null ? -1 : r.status,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? (r.error ? String(r.error.message) : ''),
  };
}

/**
 * One tool's version and resolved path, or the `unavailable:` string the
 * existing records use.
 */
function probe(exe, args) {
  const found = onPath(exe);
  if (found === null) {
    return { version: `unavailable: ${exe} is not on PATH`, resolvedPath: `unavailable: ${exe} is not on PATH` };
  }
  let resolvedPath;
  try {
    resolvedPath = realpathSync(found);
  } catch {
    resolvedPath = `unavailable: could not resolve the symlink for ${exe}`;
  }
  const r = run(found, args);
  if (r.exitCode !== 0) {
    // The failure mode this project has already met: the binary is present,
    // the shell finds it, and it aborts before printing anything. Recorded as
    // unavailable WITH the exit code, because "absent" and "installed and
    // broken" are different findings.
    return {
      version: `unavailable: exit ${r.exitCode} — ${(r.stderr || r.stdout).trim().split('\n')[0] || 'no output'}`,
      resolvedPath,
    };
  }
  return { version: `${r.stdout}${r.stderr}`.trim(), resolvedPath };
}

/**
 * Which LAZ backends laspy can actually use, and which one it would pick.
 *
 * This is recorded because it decides whether a leg is independent at all.
 * lazrs and WhiteboxTools both wrap laz-rs, the same upstream decoder, so a
 * laspy-with-lazrs against WhiteboxTools comparison is one implementation
 * compared with itself. The laszip backend wraps LASzip, which is a different
 * codebase, and only that pairing is cross-implementation.
 */
function laspyBackends() {
  const python = onPath('python3') ?? onPath('python');
  if (python === null) return { available: 'unavailable: no python on PATH' };
  const code =
    'import json,laspy\n' +
    'from laspy import LazBackend\n' +
    'a=[b.name for b in LazBackend if b.is_available()]\n' +
    'print(json.dumps({"laspyVersion":laspy.__version__,"available":a,"preferred":a[0] if a else None}))';
  const r = run(python, ['-c', code]);
  if (r.exitCode !== 0) {
    return { available: `unavailable: exit ${r.exitCode} — ${(r.stderr || '').trim().split('\n').slice(-1)[0]}` };
  }
  try {
    return JSON.parse(r.stdout.trim());
  } catch {
    return { available: `unavailable: laspy printed ${r.stdout.trim().slice(0, 120)}` };
  }
}

/** The image's own identity, when this is running inside it. */
function containerFacts() {
  if (!existsSync(IMAGE_FACTS)) {
    return {
      containerPinning: 'not-executed',
      containerPinningReason:
        'This run was not inside the pinned oracle image, so no image digest exists to record; ' +
        'the resolved executable paths and the versions the tools report stand in for it.',
    };
  }
  try {
    const facts = JSON.parse(readFileSync(IMAGE_FACTS, 'utf8'));
    return {
      containerPinning: 'executed',
      containerPinningReason:
        'This run was inside the pinned oracle image; the base image digest and the digest of ' +
        'the package lock it installed are recorded below.',
      containerBaseImage: facts.baseImage ?? null,
      containerBaseImageDigest: facts.baseImageDigest ?? null,
      containerLockSha256: facts.lockSha256 ?? null,
      containerBuiltAt: facts.builtAt ?? null,
      containerPlatform: facts.platform ?? null,
    };
  } catch {
    return {
      containerPinning: 'not-executed',
      containerPinningReason: `${IMAGE_FACTS} exists but is not readable JSON, so the image cannot identify itself.`,
    };
  }
}

/** The full environment block. */
export function oracleEnvironment() {
  const pdal = probe('pdal', ['--version']);
  const gdalinfo = probe('gdalinfo', ['--version']);
  const gdalTranslate = probe('gdal_translate', ['--version']);
  const gdaldem = probe('gdaldem', ['--version']);
  const ogrinfo = probe('ogrinfo', ['--version']);
  const wbt = probe('whitebox_tools', ['--version']);
  const nodeExe = probe('node', ['--version']);
  return {
    // The names the committed records already use.
    pdalVersion: pdal.version,
    pdalResolvedPath: pdal.resolvedPath,
    gdalinfoVersion: gdalinfo.version,
    gdalTranslateVersion: gdalTranslate.version,
    gdalTranslateResolvedPath: gdalTranslate.resolvedPath,
    gdaldemResolvedPath: gdaldem.resolvedPath,
    ogrinfoVersion: ogrinfo.version,
    ogrinfoResolvedPath: ogrinfo.resolvedPath,
    // Added by the image.
    whiteboxToolsVersion: wbt.version,
    whiteboxToolsResolvedPath: wbt.resolvedPath,
    whiteboxToolsSettings: readWbtSettings(),
    laspy: laspyBackends(),
    nodeExecutableVersion: nodeExe.version,
    ...containerFacts(),
    platform,
    architecture: arch,
    node: process.version,
  };
}

/**
 * The settings.json that sits next to the WhiteboxTools executable.
 *
 * It is hidden mutable state: it persists `compress_rasters` and `max_procs`,
 * both of which change output bytes, and the copy shipped inside the Python
 * package carries the upstream author's own home directory as
 * `working_directory`. Recording its contents is how a reader can tell which
 * settings a run was under.
 */
function readWbtSettings() {
  const path = process.env.WBT_SETTINGS_PATH ?? null;
  if (path === null) {
    return 'unavailable: WBT_SETTINGS_PATH is not set to an existing file';
  }
  // Read and handle absence together. Checking first leaves a window in which
  // the answer stops being true before the read runs.
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return 'unavailable: WBT_SETTINGS_PATH is not set to an existing file';
    }
    return `unavailable: ${path} is not readable JSON`;
  }
}

function main() {
  const env = oracleEnvironment();
  const out = JSON.stringify({ generatedBy: 'validation/oracles/record-oracle-versions.mjs', environment: env }, null, 2) + '\n';
  // argv reaches the file system here, so the path is resolved before it is
  // opened. Resolving collapses any parent segments, and a target whose
  // directory does not exist stops the run rather than being written blind.
  const target = process.argv[2] ? resolve(process.argv[2]) : null;
  if (target) {
    // Canonicalising a path from argv says what it points at; it does not say
    // the caller was allowed to point there. The resolved target is held
    // inside the directory the run was started in, so a parent segment names
    // a refusal rather than a file outside the tree.
    const rel = relative(process.cwd(), target);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      process.stderr.write(`refusing to write outside ${process.cwd()}: ${target}\n`);
      process.exitCode = 1;
      return;
    }
    if (!existsSync(dirname(target))) {
      process.stderr.write(`no such directory for output: ${dirname(target)}\n`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(target, out, 'utf8');
    process.stdout.write(`wrote ${target}\n`);
  } else {
    process.stdout.write(out);
  }
}

if (process.argv[1] && /record-oracle-versions\.mjs$/.test(process.argv[1])) main();
