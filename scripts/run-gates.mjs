#!/usr/bin/env node
/**
 * run-gates.mjs — run the release chain (`npm run test:release:execute`) from
 * scripts/gates.json.
 *
 * The chain used to be one `&&` string in package.json: every step serial, and
 * the first failure hid every step after it. This runs the same steps, with the
 * same pass/fail meaning (exit non-zero when any step fails), but:
 *
 *   - independent read-only checks (a manifest `group`) run in parallel with a
 *     bounded pool, default min(8, cores);
 *   - steps with `after` / `needs` wait for their dependencies, so builds and
 *     the test buckets keep their order;
 *   - a failing step does not stop the run. Every failure is reported at the
 *     end with its exit code and the tail of its output. A step whose `needs`
 *     failed is reported as skipped and counts as a failure.
 *
 * Usage:
 *   node scripts/run-gates.mjs                 # parallel where the manifest allows
 *   node scripts/run-gates.mjs --serial        # one at a time, in the old chain order
 *   node scripts/run-gates.mjs --jobs=4        # pool size
 *   node scripts/run-gates.mjs --stop-before=test:smoke   # run only the steps before it
 *   node scripts/run-gates.mjs --only-group=static        # run one group
 *   node scripts/run-gates.mjs --list          # print the serial order and exit
 */

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { ROOT, loadGates } from './lib/gates.mjs';
import { runSchedule } from './lib/gateScheduler.mjs';

const TAIL_LINES = 40;
// Lines collect-evidence.mjs reads from the gate log. A passing step's output
// is otherwise dropped, so these are forwarded as each step finishes.
const EVIDENCE_LINE = /^(GATE (TALLY|STAGE) .*|\s*[⚠✓]\s+\S*\s*index\s+\d+\s*KiB\s*\/\s*\d+\s*KiB.*)$/;

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');

const serial = flag('serial');
const jobsOpt = opt('jobs');
if (jobsOpt !== undefined && !/^[1-9]\d*$/.test(jobsOpt)) {
  console.error(`run-gates: --jobs=${jobsOpt} is not a whole number of 1 or more`);
  process.exit(2);
}
const jobs = serial ? 1 : Number(jobsOpt ?? Math.min(8, availableParallelism()));

let gates;
try {
  gates = loadGates();
} catch (err) {
  console.error(`run-gates: ${err.message}`);
  process.exit(2);
}
let steps = gates.steps;

const stopBefore = opt('stop-before');
if (stopBefore !== undefined) {
  const at = steps.findIndex((s) => s.script === stopBefore);
  if (at < 0) {
    console.error(`run-gates: --stop-before=${stopBefore} names no step`);
    process.exit(2);
  }
  steps = steps.slice(0, at);
}
const onlyGroup = opt('only-group');
if (onlyGroup !== undefined) {
  if (!gates.steps.some((s) => s.group === onlyGroup)) {
    console.error(`run-gates: --only-group=${onlyGroup} names no group`);
    process.exit(2);
  }
  steps = steps.filter((s) => s.group === onlyGroup);
}
if (steps.length === 0) {
  console.error('run-gates: the flags leave no step to run');
  process.exit(2);
}

if (flag('list')) {
  for (const s of steps) console.log(s.script);
  process.exit(0);
}

const t0 = Date.now();
const fmt = (ms) => `${(ms / 1000).toFixed(1)}s`;

function runStep(step) {
  return new Promise((resolveStep) => {
    const started = Date.now();
    const chunks = [];
    const child = spawn('npm', ['run', step.script], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (b) => chunks.push(b));
    child.stderr.on('data', (b) => chunks.push(b));
    child.on('error', (err) => chunks.push(Buffer.from(`spawn failed: ${err.message}\n`)));
    child.on('close', (code, signal) => {
      resolveStep({
        code: code ?? (signal ? 128 : 1),
        signal,
        ms: Date.now() - started,
        output: Buffer.concat(chunks).toString('utf8'),
      });
    });
  });
}

async function main() {
  console.log(
    `run-gates: ${steps.length} step(s), ${serial ? 'serial (chain order)' : `parallel, ${jobs} job(s)`}`,
  );
  let outcome;
  try {
    outcome = await runSchedule({
      steps,
      gates,
      jobs,
      serial,
      runStep,
      onSkip: (step, need) => console.log(`  SKIP ${step.script} (needs ${need})`),
      onDone: (step, r) => {
        console.log(`  ${r.code === 0 ? 'ok  ' : 'FAIL'} ${step.script} ${fmt(r.ms)}${r.code === 0 ? '' : ` exit=${r.code}`}`);
        for (const line of r.output.split('\n')) if (EVIDENCE_LINE.test(line)) console.log(line);
      },
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const { state, results } = outcome;

  const failed = steps.filter((s) => state.get(s.script) !== 'passed');
  for (const s of failed) {
    const r = results.get(s.script);
    const tail = r.output.trimEnd().split('\n').slice(-TAIL_LINES).join('\n');
    console.log(`\n==== ${s.script}: ${state.get(s.script) === 'skipped' ? 'skipped' : `exit ${r.code}`} ====\n${tail}`);
  }
  console.log(
    `\nrun-gates: ${steps.length - failed.length}/${steps.length} passed in ${fmt(Date.now() - t0)}` +
      (failed.length > 0 ? `; FAILED: ${failed.map((s) => s.script).join(', ')}` : ''),
  );
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
