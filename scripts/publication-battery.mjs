#!/usr/bin/env node
/**
 * publication-battery.mjs: run the validation suites behind the published
 * claims, and report per suite what ran and what did not.
 *
 * THE DISTINCTION THIS FILE EXISTS TO HOLD. A suite that did not run is not a
 * suite that passed. That has mattered twice in this program — a browser
 * benchmark recorded under `notRun` rather than as a zero, and a portability
 * comparison that would have published a one-platform result as if it were a
 * comparison. Every outcome here is one of `passed`, `failed`, `skipped` or
 * `not-run`, they are counted separately in the JSON and printed separately in
 * the summary, and no code path turns a skip into a pass.
 *
 * TIERS.
 *   `quick`  — the fast subset before a push. Correctness suites only.
 *   `verify` — everything whose evidence backs a published claim.
 * `quick` is a strict subset of `verify`, and the summary names what `quick`
 * omitted so nobody reads a green quick run as a publication result.
 *
 * WHAT MAKES IT FAIL. Any suite that ran and failed. Any REQUIRED suite that
 * was skipped, in the `verify` tier — a required suite skipped is the failure
 * mode this file was written for. A suite marked not required carries the
 * reason it cannot run here, and skipping it is reported, not fatal.
 *
 * Not a vitest suite: it spawns npm scripts, several of which are themselves
 * vitest runs. Its pure parts are unit-covered from vitest in
 * `tests/benchmark/cleanClone.test.ts`.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireBinaryOnPath } from './lib/binaryOnPath.mjs';
import { isCliEntry } from './lib/isCliEntry.mjs';

// Spawned programs are resolved to an absolute path by reading PATH, so the
// path that runs is a value this script can name rather than whatever the OS
// picks up. See scripts/lib/binaryOnPath.mjs.
const NPM = requireBinaryOnPath('npm');

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The registry. Every entry names the published claim its evidence backs, so a
 * suite cannot sit here without one, and the `:verify` tier is defined as
 * "everything in this list" rather than as a hand-copied second list.
 *
 * `requires` is a predicate over the environment. It returns null when the
 * suite can run, or the reason it cannot. A reason string is what turns into a
 * `skipped` row; there is no way to skip without one.
 */
export const SUITES = Object.freeze([
  {
    id: 'units',
    script: 'benchmark:units',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'every reported quantity carries the unit it claims across CRS and axis conventions',
  },
  {
    id: 'roundtrip',
    script: 'benchmark:roundtrip',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'LAS/LAZ round-trip preserves coordinates, attributes and the vertical CRS',
  },
  {
    id: 'contours',
    script: 'benchmark:contours',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'contours are correct against analytic surfaces',
  },
  {
    id: 'provenance',
    script: 'benchmark:provenance',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'the processing manifest chain detects an edited result tree',
  },
  {
    id: 'failures',
    script: 'benchmark:failures',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'a failed stage is recorded with its reason and the run continues',
  },
  {
    id: 'seeds',
    script: 'benchmark:seeds',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'the reported science is invariant to the seed where it must be, and its spread is quantified where it is not',
  },
  {
    id: 'archive-portability',
    script: 'benchmark:archive-portability',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'an extracted release archive resolves every link, import and documented script with no repository around it',
  },
  {
    id: 'clean-clone',
    script: 'benchmark:clean-clone',
    tiers: ['quick', 'verify'],
    required: true,
    claim: 'a clone carrying only tracked content has every file the published scripts run',
  },
  {
    id: 'backends',
    script: 'benchmark:backends',
    tiers: ['verify'],
    required: true,
    claim: 'the CPU control agrees with the CPU reference exactly, which is the control on the instrument',
  },
  {
    id: 'repro',
    script: 'benchmark:repro',
    tiers: ['verify'],
    required: true,
    claim: 'ten runs at seed 20260726 produce identical science-scoped output at a tolerance of exactly zero',
  },
  {
    id: 'scaling',
    script: 'benchmark:scaling',
    tiers: ['verify'],
    required: true,
    claim: 'the measured throughput curve over the synthetic ladder, including the falling limb at 1M',
  },
  {
    id: 'result-verify',
    script: 'benchmark:verify',
    tiers: ['verify'],
    required: true,
    // Ordered after repro and scaling on purpose: it re-derives every summary
    // and re-renders every published file from the tree those two wrote.
    claim: 'every published figure is re-derivable from the raw values in the result tree',
  },
  {
    id: 'backends-gpu',
    script: 'benchmark:backends:gpu',
    tiers: ['verify'],
    required: false,
    claim: 'the WGSL compute path agrees with the f64 CPU reference inside the f32 representation floor',
    requires: (env) =>
      env.OLV_BATTERY_GPU === '1'
        ? null
        : 'needs a browser with a real WebGPU adapter; Node exposes none and headless Chromium returns no adapter. Set OLV_BATTERY_GPU=1 on a host that has one.',
  },
  {
    id: 'compare-platforms',
    script: 'benchmark:compare-platforms',
    tiers: ['verify'],
    required: false,
    claim: 'the same commit produces identical science on the platforms whose legs were recorded',
    requires: (env) =>
      env.BENCHMARK_PORTABILITY_DIRS
        ? null
        : 'needs two recorded platform legs; one machine can only produce one. The benchmark-portability workflow records both and sets BENCHMARK_PORTABILITY_DIRS.',
  },
]);

/** The suites a tier runs, in registry order. */
export function suitesForTier(tier, suites = SUITES) {
  return suites.filter((s) => s.tiers.includes(tier));
}

/** The suites `verify` runs that `tier` does not. What a tier omits, by name. */
export function omittedByTier(tier, suites = SUITES) {
  const inTier = new Set(suitesForTier(tier, suites).map((s) => s.id));
  return suitesForTier('verify', suites).filter((s) => !inTier.has(s.id));
}

/**
 * The exit status for a set of outcomes.
 *
 * Fails on any `failed`, and on any `skipped` whose suite is required. A
 * `not-run` — a suite the battery never reached because an earlier one failed —
 * is not itself a failure, but it never counts as a pass either.
 */
export function batteryFailed(outcomes, suites = SUITES) {
  const required = new Map(suites.map((s) => [s.id, s.required]));
  return outcomes.some(
    (o) => o.status === 'failed' || (o.status === 'skipped' && required.get(o.id) === true),
  );
}

export function counts(outcomes) {
  const c = { passed: 0, failed: 0, skipped: 0, 'not-run': 0 };
  for (const o of outcomes) c[o.status] = (c[o.status] ?? 0) + 1;
  return c;
}

/** The human summary. Every suite appears; a skip is never printed as a pass. */
export function renderBattery(report) {
  const lines = [];
  lines.push(`# Publication battery — ${report.tier}`);
  lines.push('');
  lines.push(`- started: ${report.startedAt}`);
  lines.push(`- node: ${report.node}, platform: ${report.platform}`);
  lines.push(`- verdict: **${report.verdict}**`);
  const c = report.counts;
  lines.push(
    `- ${c.passed} passed, ${c.failed} failed, ${c.skipped} skipped, ${c['not-run']} not run`,
  );
  lines.push('');
  lines.push('| suite | script | required | status | seconds | note |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const o of report.outcomes) {
    lines.push(
      `| \`${o.id}\` | \`npm run ${o.script}\` | ${o.required ? 'yes' : 'no'} | **${o.status}** | ` +
        `${o.seconds === null ? '—' : o.seconds.toFixed(1)} | ${o.note ?? ''} |`,
    );
  }
  lines.push('');
  lines.push('## What each suite is evidence for');
  lines.push('');
  for (const o of report.outcomes) lines.push(`- \`${o.id}\` — ${o.claim}`);
  lines.push('');
  if (report.omitted.length > 0) {
    lines.push(`## What the \`${report.tier}\` tier omits`);
    lines.push('');
    lines.push(
      'These suites are in the publication battery and this tier did not run them. A green run of ' +
        'this tier is not a publication result.',
    );
    lines.push('');
    for (const o of report.omitted) lines.push(`- \`${o.id}\` (\`npm run ${o.script}\`) — ${o.claim}`);
    lines.push('');
  }
  const skipped = report.outcomes.filter((o) => o.status === 'skipped');
  if (skipped.length > 0) {
    lines.push('## Skipped, with the reason');
    lines.push('');
    for (const o of skipped) lines.push(`- \`${o.id}\` — ${o.note}`);
    lines.push('');
  }
  const notRun = report.outcomes.filter((o) => o.status === 'not-run');
  if (notRun.length > 0) {
    lines.push('## Not reached');
    lines.push('');
    lines.push('The battery stopped before these. Their status is unknown, which is not a pass.');
    lines.push('');
    for (const o of notRun) lines.push(`- \`${o.id}\``);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function runScript(script, cwd) {
  const started = Date.now();
  const r = spawnSync(NPM, ['run', '--silent', script], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });
  return { code: r.status === null ? 1 : r.status, seconds: (Date.now() - started) / 1000 };
}

async function main() {
  const tier = process.argv[2] === 'verify' ? 'verify' : 'quick';
  const stopOnFailure = !process.argv.includes('--continue');
  const planned = suitesForTier(tier);
  const outcomes = [];
  let halted = false;

  for (const suite of planned) {
    const base = {
      id: suite.id,
      script: suite.script,
      required: suite.required,
      claim: suite.claim,
    };
    if (halted) {
      outcomes.push({ ...base, status: 'not-run', seconds: null, note: 'an earlier suite failed' });
      continue;
    }
    const reason = suite.requires ? suite.requires(process.env) : null;
    if (reason !== null) {
      outcomes.push({ ...base, status: 'skipped', seconds: null, note: reason });
      continue;
    }
    process.stdout.write(`\n═══ ${suite.id} — npm run ${suite.script}\n`);
    const { code, seconds } = runScript(suite.script, REPO_ROOT);
    outcomes.push({
      ...base,
      status: code === 0 ? 'passed' : 'failed',
      seconds,
      note: code === 0 ? null : `exit ${code}`,
    });
    if (code !== 0 && stopOnFailure) halted = true;
  }

  const report = {
    tier,
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    counts: counts(outcomes),
    outcomes,
    omitted: omittedByTier(tier).map((s) => ({ id: s.id, script: s.script, claim: s.claim })),
    verdict: 'pending',
  };
  report.verdict = batteryFailed(outcomes) ? 'FAIL' : 'PASS';

  const outDir = join(REPO_ROOT, 'benchmark-results', 'publication');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `battery-${tier}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const md = renderBattery(report);
  writeFileSync(join(outDir, `battery-${tier}.md`), md, 'utf8');
  process.stdout.write(`\n${md}`);
  process.stdout.write(`machine-readable: benchmark-results/publication/battery-${tier}.json\n`);
  return report.verdict === 'PASS' ? 0 : 1;
}

if (isCliEntry(import.meta.url)) {
  process.exit(await main());
}
