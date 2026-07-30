#!/usr/bin/env node
/**
 * run-campaign.mjs — targeted defect-pattern mutations over the modules that
 * carried real defects.
 *
 * Each entry below edits ONE line into a defect a developer could plausibly
 * write, runs three configurations against it, and reverts. Nothing is
 * committed while mutated; the script restores every file it touches, including
 * on failure.
 *
 * The three configurations are kept separate on purpose:
 *
 *   conventional — the test tree as it stood at tag v0.6.1, checked out over
 *                  `tests/` for the duration of the phase and restored after.
 *   specialized  — the current suite that targets the mutated module.
 *   gate         — `npm run test:release:execute`, the whole release gate.
 *
 * Outcome vocabulary, never collapsed:
 *   detected              new failures appeared that the baseline did not have
 *   survived              the configuration ran green with the defect in place
 *   not-applicable        the mutated file did not exist in that configuration
 *   not-executed          the configuration was not run for this mutation
 *   environment-unavailable  the run needed something this machine lacks
 *   invalid-test-setup    the baseline itself was not usable
 *
 * Scope: the listed mutations over the listed modules. Nothing here measures
 * mutation coverage of the repository as a whole.
 *
 * Usage:
 *   node validation/mutations/run-campaign.mjs            # conventional + specialized
 *   node validation/mutations/run-campaign.mjs --gate     # + gate for survivors
 *   node validation/mutations/run-campaign.mjs --gate=all # + gate for every mutation
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { compareCodeUnits } from '../../scripts/lib/codeUnitOrder.mjs';
import { requireBinaryOnPath } from '../../scripts/lib/binaryOnPath.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const GIT = requireBinaryOnPath('git');
const NPX = requireBinaryOnPath('npx');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = HERE;
const RAW_PATH = join(OUT_DIR, 'results.json');
const SUMMARY_PATH = join(OUT_DIR, 'summary.md');
const TMP_DIR = join(ROOT, 'node_modules', '.cache', 'mutation-campaign');

/** The reference the conventional configuration is reconstructed from. */
const CONVENTIONAL_REF = 'v0.6.1';

// ── The mutation set ────────────────────────────────────────────────────────

const MUTATIONS = [
  {
    id: 'M01',
    pattern: 'remove a required unit conversion',
    module: 'terrain derivatives and units',
    file: 'src/terrain/contour/analyseContours.ts',
    find: '    dtm.z, dtm.cols, dtm.rows, horizCellEwM, horizCellNsM, params.verticalUnitToMetres,\n',
    replace: '    dtm.z, dtm.cols, dtm.rows, horizCellEwM, horizCellNsM,\n',
    effect: 'slope is computed from a native-unit rise against a metre run, so a foot-CRS grid reads 3.28x too steep',
    specialized: {
      kind: 'vitest',
      files: [
        'tests/benchmark/unitIntegrity.test.ts',
        'tests/groundFilterUnitFrame.test.ts',
        'tests/slopeCrossCheck.test.ts',
        'tests/verticalAccuracy.test.ts',
        'tests/terrainTruth.surface.test.ts',
      ],
    },
  },
  {
    id: 'M02',
    pattern: 'swap Y-up and Z-up interpretation',
    module: 'terrain derivatives and units',
    file: 'src/terrain/canonicalFrame.ts',
    find: '    positions[i + 1] = -z;\n    positions[i + 2] = y;\n',
    replace: '    positions[i + 1] = z;\n    positions[i + 2] = y;\n',
    effect: 'the Y-up intake becomes a reflection instead of a rotation, mirroring northing and handing every aspect backwards',
    specialized: {
      kind: 'vitest',
      files: ['tests/canonicalFrame.test.ts', 'tests/terrainCanonicalEquivalence.test.ts'],
    },
  },
  {
    id: 'M03',
    pattern: 'use the requested contour interval instead of the emitted interval',
    module: 'contour generation and declarations',
    file: 'src/terrain/contour/geojsonContours.ts',
    find: '      intervalM: model.intervalM,\n',
    replace: '      intervalM: model.requestedIntervalM ?? model.intervalM,\n',
    effect: 'a thinned level list ships declaring the interval that was asked for, not the one in the file',
    specialized: { kind: 'vitest', files: ['tests/benchmark/contourCorrectness.test.ts'] },
  },
  {
    id: 'M04',
    pattern: 'change the saddle ambiguity rule',
    module: 'contour generation and declarations',
    file: 'src/terrain/contour/contoursAt.ts',
    find: '  if (zSaddle >= level) {\n',
    replace: '  if (zSaddle > level) {\n',
    effect: 'a saddle exactly at the level takes the other pairing, relinking contour topology at the ambiguous cell',
    specialized: {
      kind: 'vitest',
      files: [
        'tests/benchmark/contourCorrectness.test.ts',
        // The dedicated tie fixture: pairing, connectivity through the
        // neighbouring cell, and the translated and scaled equivalents. Listed
        // so a re-run attributes the kill to the file that states the property
        // rather than to the surface suite it happens to sit beside.
        'tests/contourSaddleExactLevel.test.ts',
      ],
    },
  },
  {
    id: 'M05',
    pattern: 'introduce a floor/ceil off-by-one',
    module: 'contour generation and declarations',
    file: 'src/terrain/contour/contoursAt.ts',
    find: '    const count = Math.floor((maxZ - first) / interval + 1e-9) + 1;\n',
    replace: '    const count = Math.floor((maxZ - first) / interval + 1e-9);\n',
    effect: 'the top contour level is dropped from every derived level list',
    specialized: { kind: 'vitest', files: ['tests/benchmark/contourCorrectness.test.ts'] },
  },
  {
    id: 'M06',
    pattern: 'label CPU fallback as GPU execution',
    module: 'GPU backend selection',
    file: 'src/terrain/engine/TerrainRasterEngine.ts',
    find: "    this.info = { path: 'cpu', reason: 'gpu-dispatch-failed', probe: this.info.probe };\n",
    replace: "    this.info = { path: 'gpu', reason: 'gpu-dispatch-failed', probe: this.info.probe };\n",
    effect: 'a session demoted to the CPU reference keeps reporting the GPU path in its telemetry',
    specialized: {
      kind: 'vitest',
      files: ['tests/terrainRasterEngine.test.ts', 'tests/gpuBackendDispatch.test.ts'],
    },
  },
  {
    id: 'M07',
    pattern: 'skip verification of one generated artifact',
    module: 'provenance and benchmark verification',
    file: 'benchmarks/runner/verify.ts',
    find: "  const files = ['manifest.json', 'environment.json', 'summary.md', 'summary.html'];\n",
    replace: "  const files = ['manifest.json', 'environment.json', 'summary.md'];\n",
    effect: 'a result tree missing summary.html verifies clean',
    absentAtConventionalRef: true,
    // `benchmark:verify` itself is not usable here: it verifies a published
    // result tree and this checkout has none, so it would report the same
    // failure mutated or not. The two suites below build synthetic trees in a
    // temporary directory and call the same verifier, which is the part the
    // mutation touches.
    notes: 'benchmark:verify against a published result tree is environment-unavailable in this checkout (no benchmark-results/latest).',
    specialized: {
      kind: 'vitest',
      files: [
        'tests/benchmark/runnerOutput.test.ts',
        'tests/benchmark/provenanceIntegrity.test.ts',
        // The inventory checked against a tree the writer produced, which is
        // the part the mutation removes. The re-render check rejects a tree
        // missing the page either way, so a suite that only asks "does
        // verification fail" cannot see this mutation.
        'tests/benchmark/requiredArtifactInventory.test.ts',
      ],
    },
  },
  {
    id: 'M08',
    pattern: 'replace a safe map with a prototype-sensitive object',
    module: 'provenance and benchmark verification',
    file: 'benchmarks/framework/artifacts.ts',
    find: '      const bag = Object.create(null) as Record<string, unknown>;\n',
    replace: '      const bag = {} as Record<string, unknown>;\n',
    effect: 'a __proto__ key re-parents the bag instead of becoming an own property, so it vanishes from the hash',
    specialized: {
      kind: 'vitest',
      files: ['tests/benchmark/artifacts.test.ts', 'tests/benchmark/provenanceIntegrity.test.ts'],
    },
  },
  {
    id: 'M09',
    pattern: 'remove a required archive include',
    module: 'archive portability',
    file: '.gitattributes',
    append: '\nCLAIMS_AND_LIMITATIONS.md export-ignore\n',
    effect: 'a document the shipped markdown links to is dropped from the archive',
    // The portability check extracts `git archive HEAD`, which reads
    // `.gitattributes` from the commit and never from the working tree. A
    // worktree-only edit would therefore be invisible and score as a survival
    // that says nothing, so this one is committed for the duration of the run
    // and the commit is discarded with the mutation.
    commitRequired: true,
    specialized: { kind: 'exec', argv: ['node', 'scripts/verify-archive-portability.mjs'] },
  },
  {
    id: 'M10',
    pattern: 'replace an unavailable value with zero',
    module: 'failure formatting',
    file: 'benchmarks/framework/reporters/metricText.ts',
    find: '  return isMeasured(m) ? String(m.value) : UNAVAILABLE_LABEL;\n',
    replace: "  return isMeasured(m) ? String(m.value) : '0';\n",
    effect: 'an unmeasured quantity prints as 0 and reads as a measurement',
    specialized: {
      kind: 'vitest',
      files: ['tests/benchmark/reporters.test.ts', 'tests/benchmark/failureRecovery.test.ts'],
      env: { BENCHMARK_FAILURES: '1' },
    },
  },
  {
    id: 'M11',
    pattern: 'allow NaN or Infinity into a formatted quantity',
    module: 'failure formatting',
    file: 'benchmarks/framework/types.ts',
    find:
      '  if (!Number.isFinite(value)) {\n' +
      '    throw new Error(`benchmark metric: value must be finite, got ${String(value)}`);\n' +
      '  }\n',
    replace: '',
    effect: 'NaN and Infinity become reportable metric values',
    specialized: {
      kind: 'vitest',
      files: ['tests/benchmark/schema.test.ts', 'tests/benchmark/failureRecovery.test.ts'],
      env: { BENCHMARK_FAILURES: '1' },
    },
  },
  {
    id: 'M12',
    pattern: 'discard vertical CRS metadata when WKT is present',
    module: 'LAS CRS read and write',
    file: 'src/io/crs.ts',
    find: '    if (geokeyBytes == null) return fromWkt;\n',
    replace: '    if (geokeyBytes == null || wktPayload) return fromWkt;\n',
    effect: 'the GeoKey vertical datum and vertical unit beside a WKT VLR are thrown away',
    specialized: {
      kind: 'vitest',
      files: [
        'tests/benchmark/roundtripFidelity.test.ts',
        'tests/writeLas14.test.ts',
        'tests/crsVerticalHardening.test.ts',
        'tests/crs.test.ts',
      ],
    },
  },
];

// ── Small helpers ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const gateArg = args.find((a) => a === '--gate' || a.startsWith('--gate='));
const gateMode = gateArg == null ? 'off' : gateArg === '--gate' ? 'survivors' : gateArg.slice('--gate='.length);

function git(...argv) {
  return execFileSync(GIT, argv, { cwd: ROOT, encoding: 'utf8' });
}

function readFile(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

function writeFile(rel, text) {
  writeFileSync(join(ROOT, rel), text);
}

function requireCleanTree() {
  const dirty = git('status', '--porcelain').trim();
  if (dirty !== '') {
    throw new Error(`working tree is not clean; refusing to mutate:\n${dirty}`);
  }
}

/** Apply one mutation. Returns a function that restores the file exactly. */
function applyMutation(m, opts = {}) {
  const before = readFile(m.file);
  let after;
  if (m.append != null) {
    after = before + m.append;
  } else {
    const occurrences = before.split(m.find).length - 1;
    if (occurrences !== 1) {
      throw new Error(`${m.id}: anchor matched ${occurrences} times in ${m.file}, expected exactly 1`);
    }
    after = before.replace(m.find, m.replace);
  }
  if (after === before) throw new Error(`${m.id}: mutation changed nothing in ${m.file}`);
  writeFile(m.file, after);
  // Committing is only safe where the rest of the tree matches the index; the
  // conventional phase holds an out-of-index `tests/`, so it never asks for it.
  if (!m.commitRequired || opts.commit !== true) return () => writeFile(m.file, before);
  const head = git('rev-parse', 'HEAD').trim();
  git('add', '--', m.file);
  git('-c', 'user.name=mutation-campaign', '-c', 'user.email=campaign@localhost', 'commit', '-q', '-m', `temporary mutation ${m.id}`);
  return () => {
    git('reset', '--hard', '--quiet', head);
    const still = readFile(m.file);
    if (still !== before) writeFile(m.file, before);
  };
}

function now() {
  return process.hrtime.bigint();
}

function msSince(t0) {
  return Number((now() - t0) / 1_000_000n);
}

// ── Running a configuration ─────────────────────────────────────────────────

let runCounter = 0;

/**
 * Run vitest over specific files and return the set of failing test ids.
 * Returns `{ exitCode, failures, ran }` — `ran` counts executed assertions, so
 * a run that executed nothing is distinguishable from a run that passed.
 */
function runVitest(files, env) {
  mkdirSync(TMP_DIR, { recursive: true });
  const outFile = join(TMP_DIR, `run-${++runCounter}.json`);
  rmSync(outFile, { force: true });
  const argv = ['vitest', 'run', ...files, '--reporter=json', `--outputFile=${outFile}`];
  const t0 = now();
  const res = spawnSync(NPX, argv, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}), CI: '1' },
    maxBuffer: 256 * 1024 * 1024,
  });
  const durationMs = msSince(t0);
  const failures = [];
  let ran = 0;
  let parsed = false;
  if (existsSync(outFile)) {
    try {
      const json = JSON.parse(readFileSync(outFile, 'utf8'));
      parsed = true;
      for (const file of json.testResults ?? []) {
        for (const a of file.assertionResults ?? []) {
          ran += 1;
          if (a.status === 'failed') failures.push(`${file.name?.replace(ROOT + '/', '') ?? '?'} :: ${a.fullName}`);
        }
      }
    } catch {
      parsed = false;
    }
  }
  return {
    exitCode: res.status,
    durationMs,
    failures: failures.sort(compareCodeUnits),
    ran,
    parsed,
    stderrTail: (res.stderr ?? '').split('\n').slice(-8).join('\n'),
  };
}

/**
 * Replace host-specific roots in captured output.
 *
 * The results file ships inside the source archive. A macOS temp root carries
 * a per-user identifier and a stack frame carries the checkout location.
 */
function redactHostPaths(text) {
  const roots = [
    [ROOT, '<repo>'],
    [os.tmpdir(), '<temp>'],
    ['/private/var/folders', '<temp>'],
    ['/var/folders', '<temp>'],
    [os.homedir(), '<home>'],
  ].sort((a, b) => b[0].length - a[0].length);
  let out = text;
  for (const [from, to] of roots) out = out.split(from).join(to);
  return out;
}


/** Run an arbitrary command; detection is by exit code against a baseline. */
function runExec(argv, env) {
  const t0 = now();
  const res = spawnSync(argv[0], argv.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}), CI: '1' },
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    exitCode: res.status,
    durationMs: msSince(t0),
    stderrTail: (res.stderr ?? '').split('\n').slice(-8).join('\n'),
    // This tail is written into a results file that ships in the source
    // archive, and a test tail can carry an absolute path from a stack frame
    // or a temp directory whose name identifies the host.
    stdoutTail: redactHostPaths((res.stdout ?? '').split('\n').slice(-8).join('\n')),
  };
}

/**
 * Classify a run against its baseline.
 * A vitest configuration is `detected` only on failures the baseline did not
 * already have, so drift between the reconstructed tree and current source
 * cannot be read as a kill.
 */
function classifyVitest(baseline, run) {
  if (!baseline.parsed) return { state: 'invalid-test-setup', newFailures: [], detail: 'baseline produced no parseable report' };
  if (baseline.ran === 0) return { state: 'invalid-test-setup', newFailures: [], detail: 'baseline executed no tests' };
  if (!run.parsed) return { state: 'invalid-test-setup', newFailures: [], detail: 'mutated run produced no parseable report' };
  const baseSet = new Set(baseline.failures);
  const newFailures = run.failures.filter((f) => !baseSet.has(f));
  return newFailures.length > 0
    ? { state: 'detected', newFailures, detail: '' }
    : { state: 'survived', newFailures: [], detail: '' };
}

function classifyExec(baseline, run) {
  if (baseline.exitCode !== 0) {
    return { state: 'invalid-test-setup', newFailures: [], detail: `baseline exit ${baseline.exitCode}` };
  }
  return run.exitCode === 0
    ? { state: 'survived', newFailures: [], detail: '' }
    : { state: 'detected', newFailures: [`exit ${run.exitCode}`], detail: '' };
}

// ── Phases ──────────────────────────────────────────────────────────────────

/** Swap `tests/` for the tree at CONVENTIONAL_REF. Returns a restore function. */
function useConventionalTests() {
  rmSync(join(ROOT, 'tests'), { recursive: true, force: true });
  git('restore', `--source=${CONVENTIONAL_REF}`, '--worktree', '--', 'tests');
  return () => {
    rmSync(join(ROOT, 'tests'), { recursive: true, force: true });
    git('restore', '--worktree', '--', 'tests');
  };
}

function conventionalPhase(results) {
  const restoreTests = useConventionalTests();
  try {
    const baseline = runVitest([], undefined);
    results.conventional = {
      ref: CONVENTIONAL_REF,
      baselineExitCode: baseline.exitCode,
      baselineDurationMs: baseline.durationMs,
      baselineTestsRun: baseline.ran,
      baselineFailures: baseline.failures,
    };
    for (const m of MUTATIONS) {
      const entry = results.mutations[m.id];
      if (m.absentAtConventionalRef) {
        entry.conventional = {
          state: 'not-applicable',
          detail: `${m.file} did not exist at ${CONVENTIONAL_REF}`,
          durationMs: 0,
          newFailures: [],
        };
        continue;
      }
      const revert = applyMutation(m);
      try {
        const run = runVitest([], undefined);
        const c = classifyVitest(baseline, run);
        entry.conventional = {
          state: c.state,
          detail: c.detail,
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          newFailures: c.newFailures,
        };
      } finally {
        revert();
      }
    }
  } finally {
    restoreTests();
  }
}

function specializedPhase(results) {
  const baselines = new Map();
  for (const m of MUTATIONS) {
    const s = m.specialized;
    const key = JSON.stringify(s);
    if (!baselines.has(key)) {
      baselines.set(key, s.kind === 'vitest' ? runVitest(s.files, s.env) : runExec(s.argv, s.env));
    }
    const baseline = baselines.get(key);
    const entry = results.mutations[m.id];
    const revert = applyMutation(m, { commit: true });
    let run;
    try {
      run = s.kind === 'vitest' ? runVitest(s.files, s.env) : runExec(s.argv, s.env);
    } finally {
      revert();
    }
    const c = s.kind === 'vitest' ? classifyVitest(baseline, run) : classifyExec(baseline, run);
    entry.specialized = {
      command: s.kind === 'vitest' ? `vitest run ${s.files.join(' ')}` : s.argv.join(' '),
      env: s.env ?? {},
      state: c.state,
      detail: c.detail,
      durationMs: run.durationMs,
      baselineDurationMs: baseline.durationMs,
      exitCode: run.exitCode,
      newFailures: c.newFailures,
    };
  }
}

function gatePhase(results) {
  if (gateMode === 'off') {
    for (const m of MUTATIONS) {
      results.mutations[m.id].gate = {
        state: 'not-executed',
        detail: 'the gate phase was not requested (--gate)',
        durationMs: 0,
      };
    }
    results.gate = { baseline: null, policy: 'not run' };
    return;
  }
  const baseline = runExec(['npm', 'run', 'test:release:execute']);
  results.gate = {
    baselineExitCode: baseline.exitCode,
    baselineDurationMs: baseline.durationMs,
    policy: gateMode === 'all' ? 'every mutation' : 'mutations that survived both other configurations',
  };
  for (const m of MUTATIONS) {
    const entry = results.mutations[m.id];
    const survivedBoth =
      (entry.conventional?.state === 'survived' || entry.conventional?.state === 'not-applicable') &&
      entry.specialized?.state === 'survived';
    if (gateMode !== 'all' && !survivedBoth) {
      entry.gate = {
        state: 'not-executed',
        detail: 'another configuration already detected it; the gate was reserved for survivors',
        durationMs: 0,
      };
      continue;
    }
    const revert = applyMutation(m, { commit: true });
    let run;
    try {
      run = runExec(['npm', 'run', 'test:release:execute']);
    } finally {
      revert();
    }
    const c = classifyExec(baseline, run);
    entry.gate = {
      state: c.state,
      detail: c.detail,
      durationMs: run.durationMs,
      exitCode: run.exitCode,
      tail: run.stdoutTail,
    };
  }
}

// ── Summary rendering, derived from the raw file only ────────────────────────

function renderSummary(raw) {
  const cell = (c) => (c == null ? 'not-executed' : c.state);
  const lines = [];
  lines.push('# Targeted mutation campaign');
  lines.push('');
  lines.push('Generated by `validation/mutations/run-campaign.mjs` from `results.json`. Do not edit by hand.');
  lines.push('');
  lines.push(`Run at ${raw.runAt} on ${raw.machine.os} / ${raw.machine.cpu} / Node ${raw.machine.node}.`);
  lines.push(`Source under mutation: commit ${raw.commit}.`);
  lines.push('');
  lines.push('Scope: the mutations listed below, over the modules listed below. Nothing here');
  lines.push('measures mutation coverage of the rest of the repository.');
  lines.push('');
  lines.push('## Detection by configuration');
  lines.push('');
  lines.push('| id | module | mutation | conventional | specialized | gate |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const m of raw.order) {
    const e = raw.mutations[m];
    lines.push(
      `| ${m} | ${e.module} | ${e.pattern} | ${cell(e.conventional)} | ${cell(e.specialized)} | ${cell(e.gate)} |`,
    );
  }
  lines.push('');
  lines.push('## Informative cells');
  lines.push('');
  const informative = raw.order.filter(
    (m) => raw.mutations[m].conventional?.state === 'survived' && raw.mutations[m].specialized?.state === 'detected',
  );
  if (informative.length === 0) {
    lines.push('None: no mutation survived the conventional set and died in a specialized suite.');
  } else {
    lines.push('Survived the conventional set, killed by a specialized suite.');
    lines.push('');
    for (const m of informative) {
      const e = raw.mutations[m];
      lines.push(`- ${m} (${e.file}) — ${e.effect}. Killed by \`${e.specialized.command}\`.`);
    }
  }
  lines.push('');
  lines.push('## Gaps');
  lines.push('');
  const gaps = raw.order.filter((m) => {
    const e = raw.mutations[m];
    return ['conventional', 'specialized', 'gate'].every((k) => e[k]?.state !== 'detected');
  });
  if (gaps.length === 0) {
    lines.push('No mutation went undetected in every configuration that ran.');
  } else {
    lines.push('Detected by nothing that ran. Each is a real hole, not a rounding of one.');
    lines.push('');
    for (const m of gaps) {
      const e = raw.mutations[m];
      lines.push(
        `- ${m} (${e.file}) — ${e.effect}. conventional: ${cell(e.conventional)}; specialized: ${cell(e.specialized)}; gate: ${cell(e.gate)}.`,
      );
    }
  }
  lines.push('');
  lines.push('## Runtime');
  lines.push('');
  lines.push(`Single machine: ${raw.machine.os} / ${raw.machine.cpu} / Node ${raw.machine.node}. Times are per run, not pooled.`);
  lines.push('');
  lines.push('| id | conventional (s) | specialized (s) | gate (s) |');
  lines.push('| --- | --- | --- | --- |');
  const s = (c) => (c?.durationMs ? (c.durationMs / 1000).toFixed(1) : '-');
  for (const m of raw.order) {
    const e = raw.mutations[m];
    lines.push(`| ${m} | ${s(e.conventional)} | ${s(e.specialized)} | ${s(e.gate)} |`);
  }
  lines.push('');
  lines.push(
    `Baselines: conventional ${(raw.conventional.baselineDurationMs / 1000).toFixed(1)} s` +
      (raw.gate?.baselineDurationMs ? `, gate ${(raw.gate.baselineDurationMs / 1000).toFixed(1)} s` : ', gate not run') +
      '.',
  );
  lines.push('');
  lines.push('## Conventional set reconstruction');
  lines.push('');
  lines.push(
    `\`tests/\` was replaced with the tree at \`${raw.conventional.ref}\` (\`git restore --source=${raw.conventional.ref} --worktree -- tests\` after removing the current one) and restored from the index afterwards. Runner configuration, source and dependencies stayed at the current commit, so the configuration measures the OLD TESTS against the CURRENT source.`,
  );
  lines.push('');
  lines.push(
    `That reconstruction is not green on its own: the baseline exits ${raw.conventional.baselineExitCode} with ${raw.conventional.baselineFailures.length} failing tests out of ${raw.conventional.baselineTestsRun} executed, from drift between the old assertions and the current source. Detection is therefore scored on NEW failures against that baseline, never on the run being red.`,
  );
  lines.push('');
  return lines.join('\n') + '\n';
}

// ── Main ────────────────────────────────────────────────────────────────────

function main() {
  requireCleanTree();
  const results = {
    runAt: new Date().toISOString(),
    commit: git('rev-parse', 'HEAD').trim(),
    machine: {
      os: `${os.type()} ${os.release()} ${os.arch()}`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      node: process.version,
    },
    scope: {
      modules: [...new Set(MUTATIONS.map((m) => m.module))],
      note: 'Detection states apply to these mutations over these modules only.',
    },
    order: MUTATIONS.map((m) => m.id),
    mutations: Object.fromEntries(
      MUTATIONS.map((m) => [
        m.id,
        {
          id: m.id,
          pattern: m.pattern,
          module: m.module,
          file: m.file,
          effect: m.effect,
          ...(m.notes ? { notes: m.notes } : {}),
        },
      ]),
    ),
  };

  conventionalPhase(results);
  specializedPhase(results);
  gatePhase(results);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(RAW_PATH, JSON.stringify(results, null, 2) + '\n');
  writeFileSync(SUMMARY_PATH, renderSummary(JSON.parse(readFileSync(RAW_PATH, 'utf8'))));

  const dirty = git('status', '--porcelain').trim();
  const stray = dirty
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.includes('validation/mutations/'));
  if (stray.length > 0) {
    console.error('a mutation was not reverted:\n' + stray.join('\n'));
    process.exit(2);
  }
  console.log(`wrote ${RAW_PATH}`);
  console.log(`wrote ${SUMMARY_PATH}`);
}

main();
