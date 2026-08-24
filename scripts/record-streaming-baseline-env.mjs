#!/usr/bin/env node
/**
 * record-streaming-baseline-env.mjs
 *
 * Record the module graph and the live bundle figures alongside the streaming
 * scheduler baseline, from the repo's own checkers rather than by counting.
 *
 * Both checkers already print the figures they enforce against. This runs them,
 * keeps their stdout verbatim, and writes the result next to the scheduler
 * record, so the two halves of the baseline are dated to the same tree.
 *
 * `check:bundle` measures `dist/assets`, so a build has to exist. Without one it
 * says so and exits non-zero; that exit code is recorded rather than swallowed.
 *
 *   npm run build && node scripts/record-streaming-baseline-env.mjs
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'validation/streaming-baseline/module-graph-and-bundle.json');

/** Run one checker and keep what it printed. */
function run(script) {
  const result = spawnSync(process.execPath, [join(ROOT, 'scripts', script)], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  return {
    command: `node scripts/${script}`,
    exitCode: result.status,
    stdout: (result.stdout ?? '').split('\n').filter((l) => l.length > 0),
    stderr: (result.stderr ?? '').split('\n').filter((l) => l.length > 0),
  };
}

const record = {
  schema: 'openlidarviewer.streaming-baseline-env/1',
  note:
    'Verbatim output of the repository checkers, not a hand count. The module ' +
    'graph figures are the ones lint-module-graph.mjs enforces against its own ' +
    'banked baseline; the bundle figures are measured from the built dist/assets.',
  moduleGraph: run('lint-module-graph.mjs'),
  bundle: run('check-bundle-budget.mjs'),
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(record, null, 2) + '\n');
console.log(`wrote ${OUT.slice(ROOT.length + 1)}`);
