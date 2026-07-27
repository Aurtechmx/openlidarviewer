#!/usr/bin/env node
/**
 * verify-reachability.mjs — collect the witnesses the validations left behind.
 *
 * Every claim in validation/reachability/claims.json says a validation reaches
 * some production path. A coverage claim is witnessed inside its own suite (see
 * tests/benchmark/reachability.ts) and leaves a ledger entry. An artifact claim
 * is witnessed by the file the checked code emits. An unwitnessed claim states,
 * with a reason, that no witness can be produced from Node.
 *
 * This script does not re-run anything. It reads what the last run left and
 * reports one line per claim:
 *
 *   witnessed     the path executed and the witness says so
 *   unreached     the validation ran and did not enter the path  (exit 1)
 *   unwitnessed   registered as unwitnessable, with a reason
 *   not-executed  no witness from this run; the validation was not run
 *
 * Usage:
 *   node scripts/verify-reachability.mjs
 *   node scripts/verify-reachability.mjs --strict   # not-executed also fails
 *   node scripts/verify-reachability.mjs --json <path>
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'validation/reachability/claims.json');
const LEDGER_DIR = join(ROOT, 'validation/reachability/ledger');

export function loadClaims(root = ROOT) {
  return JSON.parse(readFileSync(join(root, 'validation/reachability/claims.json'), 'utf8')).claims;
}

/**
 * Judge an artifact claim against the result object the checked code emitted.
 *
 * The witness is the emitted file, so the questions are whether it shows the
 * work being done on real inputs and whether every check the claim names is
 * accounted for. A check that is absent from the results never ran, and a
 * `skipped` check stays skipped: it is neither a pass nor a failure, but it
 * must carry a reason, or the skip is indistinguishable from an omission.
 */
export function judgeArtifactClaim(claim, result) {
  const problems = [];
  if (!result || typeof result !== 'object') {
    return { state: 'not-executed', problems: ['no result object'], executed: [], skipped: [] };
  }
  if (!(Number(result.fileCount) > 0)) {
    problems.push('the result reports no files examined, so no check read anything');
  }
  const byId = new Map((result.results ?? []).map((r) => [r.id, r]));
  const executed = [];
  const skipped = [];
  for (const id of claim.requiredChecks ?? []) {
    const r = byId.get(id);
    if (!r) {
      problems.push(`check "${id}" is absent from the result: it did not run`);
      continue;
    }
    if (r.status === 'skipped') {
      if (!r.reason) problems.push(`check "${id}" is skipped with no reason`);
      skipped.push(id);
      continue;
    }
    if (r.status !== 'pass' && r.status !== 'fail') {
      problems.push(`check "${id}" reports an unknown status "${r.status}"`);
      continue;
    }
    executed.push(id);
  }
  if (executed.length === 0) problems.push('no required check executed');
  return {
    state: problems.length === 0 ? 'witnessed' : 'unreached',
    problems,
    executed,
    skipped,
  };
}

function judgeCoverageClaim(claim, ledgerDir) {
  const path = join(ledgerDir, `${claim.id}.json`);
  if (!existsSync(path)) {
    return { state: 'not-executed', detail: 'no ledger entry from this run', problems: [] };
  }
  const entry = JSON.parse(readFileSync(path, 'utf8'));
  if (entry.state === 'not-executed') {
    return { state: 'not-executed', detail: entry.reason ?? '', problems: [] };
  }
  const missing = (entry.missing ?? []).map((m) => `${m.file}:${m.fn}`);
  return {
    state: missing.length === 0 ? 'witnessed' : 'unreached',
    detail: (entry.entered ?? []).map((e) => `${e.fn}×${e.calls}`).join(' '),
    problems: missing.map((m) => `never entered ${m}`),
    recordedAt: entry.recordedAt,
  };
}

export function judgeAll(root = ROOT) {
  const claims = loadClaims(root);
  const ledgerDir = join(root, 'validation/reachability/ledger');
  return claims.map((claim) => {
    if (claim.mode === 'unwitnessed') {
      return { id: claim.id, title: claim.title, mode: claim.mode, state: 'unwitnessed', detail: claim.reason ?? '', problems: [] };
    }
    if (claim.mode === 'artifact') {
      const path = join(root, claim.artifact);
      if (!existsSync(path)) {
        return { id: claim.id, title: claim.title, mode: claim.mode, state: 'not-executed', detail: `${claim.artifact} is not present`, problems: [] };
      }
      const judged = judgeArtifactClaim(claim, JSON.parse(readFileSync(path, 'utf8')));
      return {
        id: claim.id,
        title: claim.title,
        mode: claim.mode,
        state: judged.state,
        detail: `${judged.executed.length} checks executed, ${judged.skipped.length} skipped`,
        problems: judged.problems,
      };
    }
    return { id: claim.id, title: claim.title, mode: claim.mode, ...judgeCoverageClaim(claim, ledgerDir) };
  });
}

function main() {
  const argv = process.argv.slice(2);
  const strict = argv.includes('--strict');
  const jsonIdx = argv.indexOf('--json');
  const jsonPath = jsonIdx >= 0 ? resolve(argv[jsonIdx + 1]) : join(ROOT, 'validation/reachability/summary.json');

  const rows = judgeAll();
  const mark = { witnessed: '✓', unreached: '✗', unwitnessed: '·', 'not-executed': '○' };
  console.log('Validation-path reachability\n');
  for (const r of rows) {
    console.log(`  ${mark[r.state] ?? '?'} ${r.state.padEnd(13)} ${r.id}`);
    if (r.detail) console.log(`      ${r.detail}`);
    for (const p of r.problems) console.log(`      [problem] ${p}`);
  }
  const count = (s) => rows.filter((r) => r.state === s).length;
  const failed = count('unreached') + (strict ? count('not-executed') : 0);
  console.log(
    `\n${failed === 0 ? '✓' : '✗'} ${count('witnessed')} witnessed, ${count('unreached')} unreached, ` +
      `${count('unwitnessed')} unwitnessed, ${count('not-executed')} not executed`,
  );
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, `${JSON.stringify({ generatedAt: new Date().toISOString(), strict, rows }, null, 2)}\n`);
  console.log(`  result: ${jsonPath}`);
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main();

export { REGISTRY, LEDGER_DIR };
