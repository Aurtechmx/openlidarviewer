#!/usr/bin/env node
/**
 * Version-paired replay of every record in validation/defects/defect-registry.json.
 *
 *   node scripts/replay-defects.mjs
 *
 * For each registered defect this runs the regression artifact the registry
 * names against TWO trees: the baseline tag and the current candidate. The same
 * probe file and the same fixture go to both trees, so the pair differs only in
 * the code under test.
 *
 * WHAT IS RECORDED, AND WHAT IS NOT INFERRED
 *
 * Every run writes a raw record under validation/defects/replay/raw/. A raw
 * record holds only things the run produced: the command, the exit code, the
 * full transcript, and the reporter JSON verbatim. Nothing in a raw record is a
 * judgement. The states in the comparison files are derived from those captures
 * by `deriveOutcome` and `deriveState` here, and `scripts/verify-defect-replay.mjs`
 * recomputes all of them from the same captures.
 *
 * The registry already carries a full-suite result at the baseline tag with exit
 * 0. That exit code says the suite passed while the defective code was present.
 * It says nothing about whether any test reached a given defect's code path, so
 * it is never read here. Reachability at the baseline is established per defect,
 * by the probe, or it is not established and the record says so.
 *
 * STATES. These are distinct and none of them is a pass or a zero:
 *   reproduced-then-fixed        the probe failed at the baseline on the
 *                                behaviour the record describes, and passes at
 *                                the candidate
 *   component-absent-at-baseline the probe could not observe the baseline: a
 *                                module it imports, or a binding it calls, did
 *                                not exist in that tree
 *   environment-unavailable      the probe needs a runtime this host does not
 *                                offer, on either side
 *   non-discriminating           the probe passed on both trees, so it shows
 *                                nothing about the old behaviour
 *   not-executed                 the registry names no executable artifact for
 *                                this entry, so nothing was run
 *   inconclusive                 one side produced no readable result
 *
 * Exit 0 when every run completed and the comparison files were written, 1 when
 * a run could not be launched, 2 on a usage, read or setup error.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, cpSync, statSync, readdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative, join } from 'node:path';
import { tmpdir } from 'node:os';
import os from 'node:os';

import {
  RAW_DIR, REPLAY_DIR, REGISTRY_PATH, BASELINE_REF,
  planProbes, deriveOutcome, deriveState, deriveDefectState, renderComparisons,
  redactRoots, digestOf, canonicalJson, STATES,
} from './defect-replay-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

/* ------------------------------------------------------------------ trees */

/** Absolute path of the tree the candidate side runs in. */
const candidateDir = ROOT;

function gitOut(args, cwd = ROOT) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 }).trim();
}

/**
 * Materialize the baseline tag in its own tree.
 *
 * `node_modules` is symlinked from the candidate tree rather than installed:
 * the runtime is then identical on both sides, which is the point of a paired
 * replay, and the record states it so a reader is not left to assume it.
 */
function materializeBaseline() {
  const dir = process.env.OLV_REPLAY_BASELINE_DIR
    ? resolve(process.env.OLV_REPLAY_BASELINE_DIR)
    : join(tmpdir(), `olv-replay-baseline-${process.pid}`);
  if (!existsSync(join(dir, '.git'))) {
    rmSync(dir, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', dir, BASELINE_REF], {
      cwd: ROOT, stdio: 'pipe',
    });
  }
  const mods = join(dir, 'node_modules');
  if (!existsSync(mods)) {
    execFileSync('ln', ['-s', join(candidateDir, 'node_modules'), mods]);
  }
  return dir;
}

/* -------------------------------------------------- probe file injection */

const COPYABLE = ['tests/', 'benchmarks/', 'scripts/', 'validation/reachability/'];

/**
 * Harness data the probes read at run time rather than import.
 *
 * The witness helper several suites call opens the reachability claim list by
 * path, so without it those suites fail to collect at the baseline for a reason
 * that has nothing to do with any defect. Copying it in keeps the pair
 * differing only in the code under test, which is the whole point.
 */
const HARNESS_FILES = ['validation/reachability/claims.json'];
const EXTS = ['', '.ts', '.mts', '.mjs', '.js', '.json', '/index.ts', '/index.mjs'];

/** Resolve a relative import specifier to a repo-relative file, or null. */
function resolveImport(fromRel, spec) {
  const base = resolve(candidateDir, dirname(fromRel), spec);
  for (const ext of EXTS) {
    const candidate = base + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(candidateDir, candidate);
    }
  }
  return null;
}

/**
 * Copy the probe and everything under tests/, benchmarks/ and scripts/ that it
 * imports into the baseline tree, so both sides run the same probe text.
 *
 * `src/` is never copied. The baseline's own source is the thing under test,
 * and overwriting it would make the replay meaningless.
 */
function injectProbe(baselineDir, entryRel, codePath) {
  const injected = [];
  const withheld = [];
  const seen = new Set();
  const queue = [entryRel, ...HARNESS_FILES];
  while (queue.length > 0) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = resolve(candidateDir, rel);
    if (!existsSync(src)) continue;
    if (!COPYABLE.some((p) => rel.startsWith(p))) continue;
    // Never carry the code under test across. Most of a record's code path
    // sits in src/, which is excluded by the copy list already, but some
    // records name files under benchmarks/, and copying one of those would
    // hand the baseline tree the fix and turn the probe into a false pass.
    if (codePath.some((c) => rel === c || (c.endsWith('/') && rel.startsWith(c)))) {
      withheld.push(rel);
      continue;
    }
    const dst = resolve(baselineDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    const before = existsSync(dst) ? readFileSync(dst) : null;
    const text = readFileSync(src, 'utf8');
    if (before === null || before.toString('utf8') !== text) {
      cpSync(src, dst);
      injected.push({ path: rel, action: before === null ? 'added' : 'overwritten' });
    }
    for (const m of text.matchAll(/(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g)) {
      const target = resolveImport(rel, m[1]);
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return {
    injected: injected.sort((a, b) => compareCodeUnits(a.path, b.path)),
    withheld: withheld.sort(compareCodeUnits),
  };
}

/* ----------------------------------------------------------------- runner */

const RUN_TIMEOUT_MS = 900_000;

function environmentOf(label, dir) {
  const commit = gitOut(['rev-parse', 'HEAD'], dir);
  return {
    label,
    ref: label === 'baseline' ? BASELINE_REF : 'candidate working tree',
    commit,
    commitShort: commit.slice(0, 7),
    node: process.version,
    vitest: JSON.parse(readFileSync(resolve(candidateDir, 'node_modules/vitest/package.json'), 'utf8')).version,
    platform: `${process.platform} ${process.arch}`,
    cpus: os.availableParallelism ? os.availableParallelism() : os.cpus().length,
    nodeModules: 'shared with the candidate tree, so the runtime is identical on both sides',
  };
}

/** Run one probe in one tree and capture everything it produced. */
function runProbe(probe, env, dir, roots) {
  const outFile = join(dir, `.replay-reporter-${process.pid}.json`);
  rmSync(outFile, { force: true });

  let argv;
  if (probe.kind === 'script') {
    argv = ['node', probe.file];
  } else if (probe.kind === 'vitest-case') {
    argv = ['npx', 'vitest', 'run', probe.file, '-t', probe.case,
      '--reporter=json', `--outputFile=${outFile}`, '--reporter=default', '--testTimeout=600000'];
  } else {
    argv = ['npx', 'vitest', 'run', probe.file,
      '--reporter=json', `--outputFile=${outFile}`, '--reporter=default', '--testTimeout=600000'];
  }

  const started = Date.now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: dir,
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    maxBuffer: 1 << 28,
    env: { ...process.env, CI: '1', FORCE_COLOR: '0', OLV_REACHABILITY: '0' },
  });
  const durationMs = Date.now() - started;

  if (res.error && res.error.code === 'ENOENT') {
    fail(`cannot launch ${argv[0]}: ${res.error.message}`, 1);
  }

  // Both reporters run: the JSON file is the machine capture, the default
  // reporter's summary is the second, independently written encoding of the
  // same counts that `crossCheck` reads the first one against.
  const scrub = (text) => redactRoots(text, roots)
    .replace(/\.replay-reporter-\d+\.json/g, '<reporter-output>');
  const transcript = scrub(`${res.stdout ?? ''}${res.stderr ?? ''}`);
  const reporterJson = existsSync(outFile) ? scrub(readFileSync(outFile, 'utf8')) : null;
  rmSync(outFile, { force: true });

  return {
    command: argv.map((a) => (/[\s]/.test(a) ? JSON.stringify(a) : a)).join(' ')
      .replace(outFile, '<reporter-output>'),
    exitCode: res.status === null ? -1 : res.status,
    signal: res.signal ?? null,
    timedOut: res.error?.code === 'ETIMEDOUT' || res.signal === 'SIGTERM',
    durationMs,
    transcript,
    reporterJson,
  };
}

/* ------------------------------------------------------------------- main */

const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const probes = planProbes(registry, candidateDir);
let currentDefect = null;

// Rebuilding the comparison files after a rendering change must not require
// re-running the probes: a re-run would produce new raw records, and then the
// files would agree with a different set of runs rather than with the recorded
// one. --render-only projects the raw records already on disk, which is the
// only way to correct a rendering defect without touching the evidence.
if (process.argv.includes('--render-only')) {
  if (!existsSync(RAW_DIR)) fail('no raw records to render from', 2);
  const existing = readdirSync(RAW_DIR).filter((f) => f.endsWith('.json')).sort()
    .map((f) => JSON.parse(readFileSync(join(RAW_DIR, f), 'utf8')));
  const rendered = renderComparisons(registry, probes, existing);
  for (const [name, text] of Object.entries(rendered)) {
    writeFileSync(join(REPLAY_DIR, name), text);
  }
  console.log(`rendered ${Object.keys(rendered).length} comparison files from ${existing.length} raw records`);
  process.exit(0);
}

/** Return the baseline tree to the tag exactly, keeping the shared modules. */
function resetBaseline(dir) {
  execFileSync('git', ['checkout', '--force', 'HEAD', '--', '.'], { cwd: dir, stdio: 'pipe' });
  execFileSync('git', ['clean', '-fdq', '-e', 'node_modules'], { cwd: dir, stdio: 'pipe' });
}

const baselineDir = materializeBaseline();
const roots = [
  { from: candidateDir, to: '<candidate-tree>' },
  { from: baselineDir, to: '<baseline-tree>' },
  // The repository root, ahead of the home directory. node_modules resolves
  // through the main checkout rather than the worktree, so a stack frame
  // names this path and not candidateDir. Replacing only the home prefix
  // leaves the rest of one host's directory layout in a shipped record.
  { from: ROOT, to: '<repo>' },
  { from: os.homedir(), to: '<home>' },
  { from: tmpdir(), to: '<temp>' },
  { from: '/private/var/folders', to: '<temp-root>' },
  { from: '/var/folders', to: '<temp-root>' },
];

const envs = [
  { env: environmentOf('baseline', baselineDir), dir: baselineDir },
  { env: environmentOf('candidate', candidateDir), dir: candidateDir },
];

rmSync(RAW_DIR, { recursive: true, force: true });
mkdirSync(RAW_DIR, { recursive: true });

const records = [];
let launched = 0;
for (const probe of probes) {
  if (probe.kind === 'none') {
    console.log(`${probe.defect} probe ${probe.index}: nothing to run (${probe.reason})`);
    continue;
  }
  const codePath = registry.defects.find((d) => d.id === probe.defect).codePath;
  if (probe.defect !== currentDefect) {
    // Back to the tag before each record's probes. Injection is cumulative
    // otherwise, and a file withheld here because it is THIS record's code
    // under test may have been copied in for an earlier record that only
    // imports it, which would hand this probe the fix.
    resetBaseline(baselineDir);
    currentDefect = probe.defect;
  }
  for (const { env, dir } of envs) {
    const { injected, withheld } = env.label === 'baseline'
      ? injectProbe(dir, probe.file, codePath)
      : { injected: [], withheld: [] };
    process.stdout.write(`${probe.defect} probe ${probe.index} @ ${env.label} … `);
    const run = runProbe(probe, env, dir, roots);
    launched += 1;
    const record = {
      schemaVersion: 1,
      defect: probe.defect,
      probeIndex: probe.index,
      probeKind: probe.kind,
      probeFile: probe.file,
      probeCase: probe.case,
      registryCase: probe.registryCase,
      environment: env,
      injectedFiles: injected,
      withheldFiles: withheld,
      command: run.command,
      exitCode: run.exitCode,
      signal: run.signal,
      timedOut: run.timedOut,
      durationMs: run.durationMs,
      transcript: run.transcript,
      reporterJson: run.reporterJson,
    };
    const outcome = deriveOutcome(record);
    console.log(`exit ${run.exitCode}, ${outcome.outcome} (${run.durationMs} ms)`);
    writeFileSync(
      join(RAW_DIR, `${probe.defect}--probe-${String(probe.index).padStart(2, '0')}--${env.label}.json`),
      `${canonicalJson(record)}\n`,
    );
    records.push(record);
  }
}

const comparisons = renderComparisons(registry, probes, records);
mkdirSync(REPLAY_DIR, { recursive: true });
for (const [name, text] of Object.entries(comparisons)) {
  writeFileSync(join(REPLAY_DIR, name), text);
}

const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
for (const d of registry.defects) counts[deriveDefectState(d.id, probes, records)] += 1;
console.log('');
console.log(`runs launched: ${launched}; raw records: ${records.length}`);
for (const state of STATES) console.log(`  ${state}: ${counts[state]}`);
console.log(`raw digest: ${digestOf(records.map((r) => canonicalJson(r)).join('\n'))}`);
process.exit(0);
