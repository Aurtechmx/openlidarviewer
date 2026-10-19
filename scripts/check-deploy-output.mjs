#!/usr/bin/env node
/**
 * check-deploy-output.mjs: run the post-build checks on a deploy directory.
 *
 *   node scripts/check-deploy-output.mjs <deployDir>
 *
 * The directory is the output of `vite build --mode live` as it will ship: the
 * staged copy that package.sh zips, or the extraction of the finished archive.
 * Three checks run on it, each a script of its own that can also be run alone:
 *
 *   check-no-test-seam    no Playwright seam in the bundle
 *   check-no-dev-flags    no maintainer A/B flag handling
 *   check-built-csp       every inline <script>/<style> in every HTML file is
 *                         named by the Content-Security-Policy that ships
 *
 * A `dist/` left over from an earlier build was once all that anything checked;
 * the bytes that get zipped or served are what must pass. The exit status is
 * non-zero when any check fails, and all three always run so one report lists
 * everything wrong.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isCliEntry } from './lib/isCliEntry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The checks, in the order they run. */
export const DEPLOY_CHECKS = [
  { name: 'no-test-seam', script: 'check-no-test-seam.mjs' },
  { name: 'no-dev-flags', script: 'check-no-dev-flags.mjs' },
  { name: 'built-csp', script: 'check-built-csp.mjs' },
];

/**
 * Run every check on `dir`. Returns `{ name, ok, output }` for each; a missing
 * directory fails all of them.
 */
export function runDeployChecks(dir, checks = DEPLOY_CHECKS) {
  const target = resolve(dir);
  return checks.map(({ name, script }) => {
    if (!existsSync(join(target, 'index.html'))) {
      return { name, ok: false, output: `no build at ${target} (no index.html)` };
    }
    const r = spawnSync(process.execPath, [join(HERE, script), target], { encoding: 'utf8' });
    return { name, ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  });
}

if (isCliEntry(import.meta.url)) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: node scripts/check-deploy-output.mjs <deployDir>');
    process.exit(2);
  }
  const results = runDeployChecks(dir);
  for (const r of results) {
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}`);
    if (r.output) console.log(r.output.replace(/^/gm, '     '));
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.error(`check-deploy-output FAILED: ${failed.map((r) => r.name).join(', ')} (${resolve(dir)})`);
    process.exit(1);
  }
  console.log(`check-deploy-output OK: ${results.length} checks on ${resolve(dir)}`);
}
