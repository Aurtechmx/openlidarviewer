#!/usr/bin/env node
/**
 * collect-evidence.mjs — derive the release's test counts from a gate run.
 *
 * Every published figure in the evidence documents used to be typed in by
 * hand after reading a log. That produced a release whose unit count, export
 * count and terrain count were all wrong while its total happened to be
 * right, because the total came from a script and the components came from a
 * person. An external reviewer caught it by adding them up; nothing in the
 * repository could, because `lint:release-sync` only checks that the
 * documents agree with EACH OTHER — three documents copying one wrong number
 * agree perfectly.
 *
 * So the counts are read out of the gate's own output here, once, into a file
 * the documents are then checked against. The total is computed, never
 * quoted. Usage:
 *
 *   npm run evidence
 *
 * which runs the gate, captures its EXIT CODE, and collects only on zero.
 * The exit code is passed in rather than sniffed from the log: the gate emits
 * no success banner, so grepping for one would be a check that always passes
 * — a guard that cannot fail is worse than none, because it reads like
 * protection. Writes `docs/validation/test-evidence.json`.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Which bucket a shard banner names.
 *
 * The gate prints `──── unit shard 2/3 ────` before each sub-shard and the
 * npm lifecycle line `> openlidarviewer@x.y.z test:export` before each
 * bucket. Either is enough to attribute the `Tests N passed` line that
 * follows; both are matched so a change to one does not silently drop counts
 * into the wrong bucket.
 */
const BUCKETS = ['unit', 'export', 'terrain', 'ui', 'slow'];

export function parseGateLog(text) {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { passed: 0, skipped: 0, runs: 0 }]));
  let current = null;
  for (const line of text.split('\n')) {
    const shard = /────\s*(\w+)\s+shard\s+\d+\/\d+\s*────/.exec(line);
    if (shard && BUCKETS.includes(shard[1])) current = shard[1];
    const script = /^>\s*\S+\s+test:(\w+)$/.exec(line.trim());
    if (script && BUCKETS.includes(script[1])) current = script[1];
    const tally = /^\s*Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/.exec(line);
    if (tally && current) {
      buckets[current].passed += Number(tally[1]);
      buckets[current].skipped += Number(tally[2] ?? 0);
      buckets[current].runs += 1;
    }
  }
  return buckets;
}

/** The canonical release toolchain. Evidence made elsewhere is not authoritative. */
export const CANONICAL_NODE_MAJOR = 22;
export const CANONICAL_NPM = '10.9.2';

/**
 * Assemble the evidence record, and refuse to assemble a misleading one.
 *
 * Split out from `main` so the fail-closed rules can be exercised directly:
 * a release record is only worth the guarantees it refuses to make.
 *
 * `mode` is 'development' (a local run, recorded as NOT authoritative) or
 * 'release' (exact-tag CI, the only source of a publishable record).
 */
export function buildEvidenceRecord(input) {
  const {
    mode = 'development',
    version,
    commit,
    tag = null,
    buckets,
    gateExit,
    bundle,
    nodeVersion,
    npmVersion = null,
    platform,
    generatedAt,
    gateLogSha256,
    repository = null,
    workflow = null,
    workflowRunId = null,
    workflowRunAttempt = null,
    workflowSha = null,
    packageLockSha256 = null,
    sbom = null,
    science = null,
  } = input;

  const problems = [];
  const release = mode === 'release';

  if (gateExit !== 0) problems.push(`gate exited ${gateExit}; evidence comes only from a green run`);
  if (!version) problems.push('package version is missing');
  for (const b of BUCKETS) {
    if (!buckets?.[b] || buckets[b].runs === 0) problems.push(`no test tally for the ${b} bucket`);
  }
  if (!commit) problems.push('git commit is unknown');

  if (release) {
    // A release record names the tag it describes, or it is not one.
    if (!tag) problems.push('release mode requires a tag');
    else if (version && tag !== `v${version}`) {
      problems.push(`tag ${tag} does not match v${version}`);
    }
    if (bundle?.liveEntryKiB == null || bundle?.ceilingKiB == null) {
      problems.push('bundle measurement missing from the gate log');
    }
    // The pinned toolchain is part of the claim. Evidence produced on another
    // runtime describes a different build than the one CI reproduces.
    const major = Number(String(nodeVersion ?? '').replace(/^v/, '').split('.')[0]);
    if (major !== CANONICAL_NODE_MAJOR) {
      problems.push(`release evidence requires Node ${CANONICAL_NODE_MAJOR}, got ${nodeVersion}`);
    }
    if (npmVersion && npmVersion !== CANONICAL_NPM) {
      problems.push(`release evidence requires npm ${CANONICAL_NPM}, got ${npmVersion}`);
    }
    if (science && science.e4ClaimCount !== 1) {
      problems.push(`expected exactly one E4 claim, found ${science.e4ClaimCount}`);
    }
  }

  if (problems.length > 0) return { ok: false, problems, record: null };

  const totalPassed = BUCKETS.reduce((n, b) => n + buckets[b].passed, 0);
  const totalSkipped = BUCKETS.reduce((n, b) => n + buckets[b].skipped, 0);

  return {
    ok: true,
    problems: [],
    record: {
      schemaVersion: 2,
      project: 'openlidarviewer',
      version,
      releaseChannel: release ? 'prerelease' : 'development',
      releaseAuthoritative: release,
      tag,
      commit,
      repository,
      generatedAt,
      nodeVersion,
      npmVersion,
      platform,
      workflow,
      workflowRunId,
      workflowRunAttempt,
      workflowSha,
      gateExit: 0,
      gateLog: 'release/gate.log',
      gateLogSha256,
      buckets,
      total: { passed: totalPassed, skipped: totalSkipped },
      bundle,
      packageLockSha256,
      sbom,
      science,
    },
  };
}

function main() {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? null : argv[i + 1];
  };
  const mode = flag('mode') ?? 'development';
  const logPath = flag('gate-log') ?? argv[0];
  const gateExit = flag('gate-exit') ?? argv[1];
  if (!logPath || gateExit === undefined || gateExit === null) {
    console.error(
      'usage: node scripts/collect-evidence.mjs <gate-log> <gate-exit-code>\n' +
        '   or: node scripts/collect-evidence.mjs --mode release --gate-log <path> --gate-exit 0 --output <path>',
    );
    process.exit(2);
  }
  if (gateExit !== '0') {
    // Publishing figures from a run that did not finish green would be the
    // same failure in a new costume.
    console.error(`Gate exited ${gateExit}. Evidence is only collected from a run that passed.`);
    process.exit(1);
  }
  const text = readFileSync(logPath, 'utf8');
  const buckets = parseGateLog(text);
  const empty = BUCKETS.filter((b) => buckets[b].runs === 0);
  if (empty.length > 0) {
    console.error(`No test tally found for: ${empty.join(', ')}. Was this a complete gate run?`);
    process.exit(1);
  }

  const version = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).version;
  let commit = null;
  try {
    commit = execSync('git rev-parse HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch { /* building without git is legitimate */ }

  // The bundle figure is the same class of hand-typed number as the test
  // counts — three documents quoted 699 KiB while the build produced 715.
  // Read it from the budget report the gate already prints.
  const bundle = /^\s*[⚠✓]\s+\S*\s*index\s+(\d+)\s*KiB\s*\/\s*(\d+)\s*KiB/m.exec(text);
  const liveEntryKiB = bundle ? Number(bundle[1]) : null;
  const ceilingKiB = bundle ? Number(bundle[2]) : null;

  const totalPassed = BUCKETS.reduce((n, b) => n + buckets[b].passed, 0);
  const totalSkipped = BUCKETS.reduce((n, b) => n + buckets[b].skipped, 0);

  // Preserve the log this was derived from, and hash it. Naming a path under
  // /tmp told a reader where the numbers came from and gave them no way to
  // check: the file was not in the package. A recomputable artefact beats a
  // citation of one that no longer exists.
  mkdirSync(resolve(ROOT, 'release'), { recursive: true });
  const keptLog = resolve(ROOT, 'release/gate.log');
  // Scrub absolute paths before keeping it. This log is a release artefact —
  // it may be attached to a published release — and a build log reproduces
  // whatever the machine's directory layout happens to be. The counts, the
  // shard banners and the exit lines are what a reviewer needs; the operator's
  // home directory is not.
  const scrubbed = readFileSync(logPath, 'utf8')
    .split(ROOT).join('.')
    .replace(/\/(?:Users|home)\/[^/\s"']+/g, '~');
  writeFileSync(keptLog, scrubbed);
  const gateLogSha256 = createHash('sha256').update(readFileSync(keptLog)).digest('hex');
  writeFileSync(`${keptLog}.sha256`, `${gateLogSha256}  gate.log\n`);

  // Exact-tag identity, the toolchain, and the artefact hashes a reviewer
  // needs to bind this record to one specific build.
  let tag = null;
  try {
    tag = execSync('git describe --exact-match --tags HEAD', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { /* an untagged commit is normal for a development run */ }

  let npmVersion = null;
  try {
    npmVersion = execSync('npm --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { /* npm not on PATH is survivable */ }

  const sha256Of = (rel) => {
    try {
      return createHash('sha256').update(readFileSync(resolve(ROOT, rel))).digest('hex');
    } catch {
      return null;
    }
  };

  let sbomInfo = null;
  try {
    const s = JSON.parse(readFileSync(resolve(ROOT, 'sbom.json'), 'utf8'));
    sbomInfo = {
      sha256: sha256Of('sbom.json'),
      rootName: s?.metadata?.component?.name ?? null,
      rootVersion: s?.metadata?.component?.version ?? null,
      bomRef: s?.metadata?.component?.['bom-ref'] ?? null,
      components: Array.isArray(s.components) ? s.components.length : null,
    };
  } catch { /* the SBOM lint reports its absence */ }

  // The scientific scope, read from the register rather than restated: exactly
  // one claim may sit at E4, and the record says which.
  let science = null;
  try {
    const reg = readFileSync(resolve(ROOT, 'docs/validation/claim-register.yaml'), 'utf8');
    const e4 = [...reg.matchAll(/claimId:\s*([A-Z0-9-]+)[\s\S]*?currentEvidence:\s*(E\d)_/g)]
      .filter((m) => m[2] === 'E4')
      .map((m) => m[1]);
    const cc = readFileSync(resolve(ROOT, 'src/validation/crossCheck.ts'), 'utf8');
    science = {
      e4ClaimCount: e4.length,
      e4Claims: e4,
      suppliedReferenceSlots: (cc.match(/status:\s*'supplied'/g) || []).length,
    };
  } catch { /* the claim-register lint reports its absence */ }

  const built = buildEvidenceRecord({
    mode,
    version,
    commit,
    tag,
    buckets,
    gateExit: 0,
    bundle: { liveEntryKiB, ceilingKiB },
    nodeVersion: process.version,
    npmVersion,
    platform: `${process.platform}-${process.arch}`,
    generatedAt: new Date().toISOString(),
    gateLogSha256,
    repository: process.env.GITHUB_REPOSITORY ?? null,
    workflow: process.env.GITHUB_WORKFLOW ?? null,
    workflowRunId: process.env.GITHUB_RUN_ID ?? null,
    workflowRunAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    workflowSha: process.env.GITHUB_SHA ?? null,
    packageLockSha256: sha256Of('package-lock.json'),
    sbom: sbomInfo,
    science,
  });

  if (!built.ok) {
    console.error(`Refusing to write ${mode} evidence:`);
    for (const p of built.problems) console.error(`  • ${p}`);
    process.exit(1);
  }
  const evidence = built.record;

  mkdirSync(resolve(ROOT, 'docs/validation'), { recursive: true });
  const out = resolve(ROOT, flag('output') ?? 'docs/validation/test-evidence.json');
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`test-evidence.json written: ${BUCKETS.map((b) => `${b} ${buckets[b].passed}`).join(' · ')}`);
  console.log(`total ${totalPassed} passed / ${totalSkipped} skipped`);
  console.log(`live entry ${liveEntryKiB ?? '?'} KiB / ${ceilingKiB ?? '?'} KiB`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
