#!/usr/bin/env node
/**
 * collect-evidence.mjs — derive the release's test counts from a gate run.
 *
 * Every published figure in the evidence documents used to be typed in by
 * hand after reading a log. That produced a release whose unit count, export
 * count and terrain count were all wrong while its total happened to be
 * right, because the total came from a script and the components came from a
 * person. Nothing in the repository could catch it, because
 * `lint:release-sync` only checks that the documents agree with EACH OTHER,
 * and three documents copying one wrong number agree perfectly.
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
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');
const NPM = requireBinaryOnPath('npm');

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
  // Preferred source: the machine-readable `GATE TALLY bucket=X passed=N
  // skipped=M` line the bucket runner prints from its OWN stdout. The human
  // `Tests N passed` summary comes from a shard's inherited stdio, which can
  // race the gate's tee pipe and go missing from the log on a CI runner; the
  // canonical line cannot, because the parent writes it synchronously. When
  // any canonical line is present it is authoritative and the human summary is
  // ignored (older logs without it fall back to the human parse below).
  const canonical = Object.fromEntries(BUCKETS.map((b) => [b, { passed: 0, skipped: 0, runs: 0 }]));
  let sawCanonical = false;
  for (const m of text.matchAll(/^GATE TALLY bucket=(\w+) passed=(\d+) skipped=(\d+)\s*$/gm)) {
    if (!BUCKETS.includes(m[1])) continue;
    canonical[m[1]].passed += Number(m[2]);
    canonical[m[1]].skipped += Number(m[3]);
    canonical[m[1]].runs += 1;
    sawCanonical = true;
  }
  if (sawCanonical) return canonical;

  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { passed: 0, skipped: 0, runs: 0 }]));
  let current = null;
  for (const line of text.split('\n')) {
    // A stage boundary ends bucket attribution. Without this, the coverage
    // stage — which reruns the whole suite and prints its own `Tests N passed`
    // summary — would be credited to whichever bucket happened to run LAST,
    // roughly doubling that bucket's count in the published evidence.
    if (line.includes('GATE STAGE')) {
      current = null;
      continue;
    }
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

/**
 * Every stage a release run must prove. `gate.sh` appends a
 * `GATE STAGE <name> EXIT: <code>` marker after each one; a stage that never
 * ran leaves no marker, and release evidence refuses to exist without it.
 * This is what stops `gateExit: 0` from silently meaning "the static gate
 * passed and nothing else was checked".
 */
export const MANDATORY_RELEASE_STAGES = [
  'staticGate',
  'e2e',
  'docsBuild',
  'productionAudit',
  'fixtureChecksums',
  'coverage',
];

/**
 * Stages a release run may legitimately NOT execute, provided the record
 * carries the out-of-band result it is standing on instead.
 *
 * `mutation` is here because it costs about two hours per run — the v0.6.2
 * gate took 2 h 20 m end to end, of which mutation was roughly two — while
 * measuring a slice of the tree (three numeric modules) that most releases do
 * not touch. It runs on its own schedule now, and the release record cites
 * that run: score, the commit it was measured at, and the workflow run that
 * produced it. A deferred stage is written into the record as
 * `not-executed`, never omitted: a release that skipped mutation and a
 * release whose record simply forgot to mention it must not look the same.
 */
export const DEFERRED_RELEASE_STAGES = ['mutation'];

/** The three states a stage can be in. `not-executed` is only legal for a deferred stage. */
export const STAGE_STATES = ['passed', 'failed', 'not-executed'];

/** Parse `GATE STAGE <name> EXIT: <code>` markers into { name: exitCode }. */
export function parseGateStages(text) {
  const stages = {};
  for (const m of text.matchAll(/^GATE STAGE (\w+) EXIT: (\d+)\s*$/gm)) {
    stages[m[1]] = Number(m[2]);
  }
  return stages;
}

/**
 * Stage exit codes → the published vocabulary, with the deferred stages always
 * present. `Object.entries` alone would omit a stage that never ran, and an
 * absent key reads as "not applicable" rather than "not measured here".
 */
export function summariseStages(stages) {
  if (!stages) return null;
  const out = {};
  for (const [name, code] of Object.entries(stages)) out[name] = code === 0 ? 'passed' : 'failed';
  for (const s of DEFERRED_RELEASE_STAGES) if (out[s] === undefined) out[s] = 'not-executed';
  return out;
}

/**
 * Validate a mutation result read from `mutation-evidence.json` and bind it to
 * the commit this record describes.
 *
 * Returns `{ problems, reference }`. The reference is written into the record
 * whether or not it covers the release commit — a stale measurement is still
 * the measurement the release stands on, and hiding that fact is the failure
 * mode this whole file exists to prevent. What it must never do is imply
 * currency it does not have, so `coversReleaseCommit` is explicit and
 * `measuredAtCommit` is always named.
 */
export function bindMutationEvidence(mutation, releaseCommit, { required }) {
  const problems = [];
  if (!mutation) {
    if (required) {
      problems.push(
        'no mutation result to stand on: run the Mutation workflow, or set ' +
          'OLV_GATE_MUTATION=1 to run the stage inline',
      );
    }
    return { problems, reference: null };
  }
  const score = typeof mutation.score === 'number' ? mutation.score : null;
  const breakAt = typeof mutation.break === 'number' ? mutation.break : null;
  if (score === null) problems.push('mutation evidence carries no score');
  if (breakAt === null) problems.push('mutation evidence carries no break threshold');
  if (!mutation.commit) problems.push('mutation evidence names no commit');
  if (score !== null && breakAt !== null && score < breakAt) {
    problems.push(`mutation score ${score} is below the break threshold ${breakAt}`);
  }
  const covers = Boolean(releaseCommit) && mutation.commit === releaseCommit;
  return {
    problems,
    reference: {
      score,
      break: breakAt,
      mutants: mutation.mutants ?? null,
      mutate: mutation.mutate ?? null,
      measuredAtCommit: mutation.commit ?? null,
      measuredAt: mutation.measuredAt ?? null,
      coversReleaseCommit: covers,
      ranInThisGate: mutation.ranInThisGate === true,
      workflow: mutation.workflow ?? null,
      workflowRunId: mutation.workflowRunId ?? null,
      workflowRunUrl: mutation.workflowRunUrl ?? null,
      nodeVersion: mutation.nodeVersion ?? null,
      note: covers
        ? 'Measured at this release commit.'
        : 'Measured at a different commit; this figure does not cover the release commit.',
    },
  };
}

/**
 * The canonical release toolchain. Evidence made elsewhere is not authoritative.
 * npm comes from the packageManager pin so there is exactly one place to bump it;
 * a hardcoded copy here is how the pin and the check drift apart.
 */
export const CANONICAL_NODE_MAJOR = 22;
export const CANONICAL_NPM = (() => {
  try {
    const pm = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).packageManager;
    const v = String(pm ?? '').split('@')[1];
    if (v) return v;
  } catch { /* fall through to the last known pin */ }
  return '10.9.2';
})();

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
    stages = null,
    canonicalNode = null,
    mutation = null,
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
    // runtime describes a different build than the one CI reproduces. When the
    // exact canonical version is known (.nvmrc), require it; the major-only
    // check is the fallback for a tree without one.
    if (canonicalNode) {
      if (nodeVersion !== `v${canonicalNode}`) {
        problems.push(`release evidence requires Node ${canonicalNode}, got ${nodeVersion}`);
      }
    } else {
      const major = Number(String(nodeVersion ?? '').replace(/^v/, '').split('.')[0]);
      if (major !== CANONICAL_NODE_MAJOR) {
        problems.push(`release evidence requires Node ${CANONICAL_NODE_MAJOR}, got ${nodeVersion}`);
      }
    }
    // Fail CLOSED on a missing npm version. The old `npmVersion &&` guard meant
    // a machine where `npm --version` failed could mint release evidence with
    // no npm assertion at all — absence of the check looked like passing it.
    if (npmVersion !== CANONICAL_NPM) {
      problems.push(`release evidence requires npm ${CANONICAL_NPM}, got ${npmVersion ?? 'unknown'}`);
    }
    // The E4 scope must be present and internally consistent. This was pinned
    // to "exactly one", which was a snapshot of the day SLOPE-RASTER was the
    // only E4 product, not a rule — the second promotion (ASPECT-RASTER) would
    // have failed release evidence for being correct. The count and the list
    // both come from the claim register, so the useful assertion is that they
    // agree with each other and that the scope is not empty; whether a given
    // claim DESERVES E4 is enforced by its cross-check test and by
    // lint:claim-register, not by a magic number here.
    if (science) {
      if (!(science.e4ClaimCount >= 1)) {
        problems.push(`expected at least one E4 claim, found ${science.e4ClaimCount}`);
      } else if (science.e4ClaimCount !== (science.e4Claims?.length ?? -1)) {
        problems.push(
          `E4 claim count ${science.e4ClaimCount} disagrees with the listed claims ` +
            `[${(science.e4Claims ?? []).join(', ')}]`,
        );
      }
    }
    // Every mandatory stage must have RUN and PASSED in the same log this
    // record is derived from. `gateExit: 0` alone proved only the static gate.
    for (const s of MANDATORY_RELEASE_STAGES) {
      const code = stages?.[s];
      if (code === undefined) problems.push(`mandatory stage "${s}" did not run (no marker in the gate log)`);
      else if (code !== 0) problems.push(`mandatory stage "${s}" exited ${code}`);
    }
    // A deferred stage may be absent, but if it DID run here it still has to
    // have passed — running it and ignoring the result is the worst of both.
    for (const s of DEFERRED_RELEASE_STAGES) {
      const code = stages?.[s];
      if (code !== undefined && code !== 0) problems.push(`deferred stage "${s}" exited ${code}`);
    }
  }

  // The mutation figure is required for a release record and optional for a
  // development one: a developer who has never run Stryker locally still gets
  // usable evidence, it just carries no mutation claim.
  const bound = bindMutationEvidence(mutation, commit, { required: release });
  problems.push(...bound.problems);

  if (problems.length > 0) return { ok: false, problems, record: null };

  const totalPassed = BUCKETS.reduce((n, b) => n + buckets[b].passed, 0);
  const totalSkipped = BUCKETS.reduce((n, b) => n + buckets[b].skipped, 0);

  return {
    ok: true,
    problems: [],
    record: {
      schemaVersion: 3,
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
      stages: summariseStages(stages),
      mutation: bound.reference,
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
    commit = execFileSync(GIT, ['rev-parse', 'HEAD'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
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
    tag = execFileSync(GIT, ['describe', '--exact-match', '--tags', 'HEAD'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
  } catch { /* an untagged commit is normal for a development run */ }

  let npmVersion = null;
  try {
    npmVersion = execFileSync(NPM, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
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

  // The scientific scope, read from the register rather than restated: which
  // claims sit at E4, and how many reference slots are actually supplied.
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

  // The mutation figure this record stands on. `release/` wins over the
  // tracked copy because a gate that ran the stage inline writes there, and a
  // measurement from THIS run beats one from the last scheduled run.
  const MUTATION_SOURCES = ['release/mutation-evidence.json', 'docs/validation/mutation-evidence.json'];
  let mutation = null;
  for (const rel of [flag('mutation-evidence'), ...MUTATION_SOURCES].filter(Boolean)) {
    try {
      mutation = JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'));
      break;
    } catch { /* try the next source; absence is reported by buildEvidenceRecord */ }
  }

  let canonicalNode = null;
  try {
    canonicalNode = readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim() || null;
    // A bare major ("22") is a range, not a version — only an exact pin
    // upgrades the check from major-match to exact-match.
    if (canonicalNode && !/^\d+\.\d+\.\d+$/.test(canonicalNode)) canonicalNode = null;
  } catch { /* no .nvmrc: the major-only check applies */ }

  const built = buildEvidenceRecord({
    mode,
    version,
    commit,
    tag,
    buckets,
    gateExit: 0,
    stages: parseGateStages(text),
    canonicalNode,
    mutation,
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
  const mu = evidence.mutation;
  console.log(
    mu
      ? `mutation ${mu.score} (break ${mu.break}) at ${String(mu.measuredAtCommit).slice(0, 12)} — ` +
        (mu.coversReleaseCommit ? 'this commit' : 'NOT this commit')
      : 'mutation: no measurement cited',
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
