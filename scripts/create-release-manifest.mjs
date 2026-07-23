#!/usr/bin/env node
/**
 * create-release-manifest.mjs
 *
 * The manifest is the one file that binds a published release together: tag,
 * commit, toolchain, evidence, and the hash of every attached artifact. The
 * previous manifest was assembled by interpolating shell strings into a JSON
 * heredoc, which is how a `null` becomes the literal text "null" and a missing
 * value becomes a syntax error nobody notices until a reviewer downloads it.
 * Building it in Node removes that whole class of defect.
 *
 * HASHING, AND THE CYCLE IT AVOIDS. `SHA256SUMS` lists every asset including
 * this manifest. So the manifest cannot also hash `SHA256SUMS` — each would
 * depend on the other's final bytes. The design, documented here because it is
 * not guessable:
 *
 *   manifest   → hashes every PAYLOAD asset (zips, sbom, evidence, gate log,
 *                gate-log hash file, release notes). Not itself. Not SHA256SUMS.
 *   SHA256SUMS → hashes everything, manifest included.
 *
 * `release:verify` walks both directions, so a tampered file fails one or the
 * other regardless of which it is.
 *
 * Usage:
 *   node scripts/create-release-manifest.mjs \
 *     --asset-dir release/staged-v0.6.0-alpha.3 \
 *     --evidence  release/staged-v0.6.0-alpha.3/test-evidence-v0.6.0-alpha.3.json \
 *     --output    release/staged-v0.6.0-alpha.3/release-manifest-v0.6.0-alpha.3.json
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Assets the manifest hashes. `SHA256SUMS` and the manifest are excluded. */
export const PAYLOAD_KINDS = [
  'sourceZip',
  'deployZip',
  'sbom',
  'evidence',
  'gateLog',
  'gateLogSha256',
  'releaseNotes',
];

/** Classify a staged filename. Returns null for anything unrecognised. */
export function classifyAsset(name, version) {
  if (/-source-\d{8}-\d{4}\.zip$/.test(name)) return 'sourceZip';
  if (/-deploy-\d{8}-\d{4}-root\.zip$/.test(name)) return 'deployZip';
  if (name === 'sbom.json') return 'sbom';
  if (name === `test-evidence-v${version}.json`) return 'evidence';
  if (name === 'gate.log') return 'gateLog';
  if (name === 'gate.log.sha256') return 'gateLogSha256';
  if (name === `RELEASE_NOTES_v${version}.md`) return 'releaseNotes';
  if (name === 'SHA256SUMS') return 'checksums';
  if (name === `release-manifest-v${version}.json`) return 'manifest';
  return null;
}

/**
 * Build the manifest object.
 *
 * `assets` is a map of kind → { file, sizeBytes, sha256 }, already hashed by
 * the caller so this stays a pure function of its inputs and can be tested
 * without a staged directory.
 */
export function buildManifest({ version, evidence, assets, builtAt, sourceDateEpoch = null }) {
  const problems = [];
  if (!version) problems.push('package version is missing');
  if (!evidence) problems.push('evidence record is missing');

  if (evidence) {
    if (evidence.version !== version) {
      problems.push(`evidence version ${evidence.version} does not match package ${version}`);
    }
    if (!evidence.commit) problems.push('evidence names no commit');
    if (!evidence.tag) problems.push('evidence names no tag');
    if (evidence.releaseAuthoritative !== true) {
      problems.push('evidence is not release-authoritative — it was not produced by exact-tag CI');
    }
    if (evidence.gateExit !== 0) problems.push(`evidence records gate exit ${evidence.gateExit}`);
    if (!evidence.stages) {
      problems.push('evidence carries no stage record; a release run proves every mandatory stage');
    }
  }

  for (const kind of PAYLOAD_KINDS) {
    if (!assets[kind]) problems.push(`missing required asset: ${kind}`);
  }

  if (problems.length > 0) return { ok: false, problems, manifest: null };

  return {
    ok: true,
    problems: [],
    manifest: {
      schemaVersion: 1,
      project: 'openlidarviewer',
      version,
      releaseChannel: 'prerelease',
      tag: evidence.tag,
      gitCommit: evidence.commit,
      repository: evidence.repository ?? 'Aurtechmx/openlidarviewer',
      builtAt,
      sourceDateEpoch,
      environment: {
        node: evidence.nodeVersion ?? null,
        npm: evidence.npmVersion ?? null,
        platform: evidence.platform ?? null,
        ci: evidence.workflow ? 'github-actions' : null,
        workflowRunId: evidence.workflowRunId ?? null,
        workflowRunAttempt: evidence.workflowRunAttempt ?? null,
      },
      identity: {
        packageVersion: version,
        packageLockSha256: evidence.packageLockSha256 ?? null,
        sbomRootName: evidence.sbom?.rootName ?? null,
        sbomRootVersion: evidence.sbom?.rootVersion ?? null,
        sbomBomRef: evidence.sbom?.bomRef ?? null,
      },
      validation: {
        gateExit: evidence.gateExit,
        testsPassed: evidence.total?.passed ?? null,
        testsSkipped: evidence.total?.skipped ?? null,
        e4ClaimCount: evidence.science?.e4ClaimCount ?? null,
        e4Claims: evidence.science?.e4Claims ?? [],
        referenceTool: 'GDAL',
        referenceVersion: '3.13.1',
        stages: evidence.stages ?? null,
      },
      bundle: {
        liveEntryKiB: evidence.bundle?.liveEntryKiB ?? null,
        ceilingKiB: evidence.bundle?.ceilingKiB ?? null,
      },
      // The manifest hashes payload assets only — never itself, never
      // SHA256SUMS. See the header for why that cycle cannot be closed.
      artifacts: Object.fromEntries(PAYLOAD_KINDS.map((k) => [k, assets[k]])),
    },
  };
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const flag = (n) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? null : argv[i + 1];
  };
  const assetDir = flag('asset-dir');
  const evidencePath = flag('evidence');
  const outPath = flag('output');
  if (!assetDir || !evidencePath || !outPath) {
    console.error(
      'usage: create-release-manifest.mjs --asset-dir <dir> --evidence <file> --output <file>',
    );
    process.exit(2);
  }

  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  if (!existsSync(evidencePath)) {
    console.error(`evidence file not found: ${evidencePath}`);
    process.exit(1);
  }
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));

  const assets = {};
  for (const name of readdirSync(assetDir)) {
    const kind = classifyAsset(name, version);
    if (!kind || kind === 'manifest' || kind === 'checksums') continue;
    const full = resolve(assetDir, name);
    if (!statSync(full).isFile()) continue;
    if (assets[kind]) {
      console.error(`duplicate ${kind}: ${basename(assets[kind].file)} and ${name}`);
      process.exit(1);
    }
    assets[kind] = { file: name, sizeBytes: statSync(full).size, sha256: sha256File(full) };
  }

  const built = buildManifest({
    version,
    evidence,
    assets,
    builtAt: new Date().toISOString(),
    sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null,
  });

  if (!built.ok) {
    console.error('Refusing to write the release manifest:');
    for (const p of built.problems) console.error(`  • ${p}`);
    process.exit(1);
  }

  writeFileSync(outPath, `${JSON.stringify(built.manifest, null, 2)}\n`);
  console.log(`release manifest written: ${outPath}`);
  console.log(`  tag ${built.manifest.tag} @ ${built.manifest.gitCommit.slice(0, 7)}`);
  console.log(`  ${PAYLOAD_KINDS.length} payload artifacts hashed`);
}
