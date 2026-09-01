#!/usr/bin/env node
/**
 * lint-reference-strategy.mjs — the external-validation coverage gate.
 *
 * The oracle-consensus lint proves each record is contract-shaped and
 * test-backed. This lint sits one layer above it and asks a different question:
 * does the framework, taken as a whole, present ONE auditable view of what is
 * validated, by which reference tier, at what verdict class, backed by which
 * test? It builds the coverage matrix (scripts/lib/referenceCoverage.mjs) from
 * WHATEVER records are present and fails if any record cannot be placed in it:
 *   - no derivable verdict class (no truth leg, no matched implementation, not
 *     declared exploratory),
 *   - no backing test file on disk (via expectedTestName), or
 *   - no reference named at all (no external tool, no exploratory reference).
 *
 * On success it prints the matrix and the summary and exits 0. Passing on zero
 * records is intentional: the framework can exist before any family merges. The
 * matrix is computed, never committed, so it cannot drift from the records.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';
import { buildCoverage, coverageSummary } from './lib/referenceCoverage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/oracle-consensus');
const TESTS = resolve(ROOT, 'tests');

/** Read every consensus record present as `{ file, record }`, JSON errors surfaced. */
function readRecords() {
  if (!existsSync(DIR)) return { records: [], jsonErrors: [] };
  const files = readdirSync(DIR).filter((f) => f.endsWith('.consensus.json'));
  const records = [];
  const jsonErrors = [];
  for (const f of files) {
    try {
      records.push({ file: f, record: JSON.parse(readFileSync(resolve(DIR, f), 'utf8')) });
    } catch (e) {
      jsonErrors.push(`${f}: invalid JSON — ${e.message}`);
    }
  }
  return { records, jsonErrors };
}

/** Problems for one coverage row. Pure over the row; test presence checked by caller. */
export function coverageRowProblems(row, testOnDisk) {
  const problems = [];
  if (!row.verdictClass) {
    problems.push(`${row.record}: no derivable verdict class (no truth leg, no matched implementation, not exploratory)`);
  }
  if (!testOnDisk) {
    problems.push(`${row.record}: no backing test on disk (expected tests/${row.test})`);
  }
  if (row.externalTools.length === 0 && row.referenceClasses.length === 0) {
    problems.push(`${row.record}: names no reference at all (no external tool, no reference class)`);
  }
  return problems;
}

function printMatrix(coverage) {
  console.log('reference-strategy coverage matrix:');
  for (const row of coverage) {
    const tools = row.externalTools.length ? row.externalTools.join(', ') : '—';
    console.log(
      `  ${row.quantity}  ->  ${row.verdictClass}` +
        `  [${row.referenceClasses.join(', ')}]  tools: ${tools}` +
        `  (${row.record} -> tests/${row.test})`,
    );
  }
  const summary = coverageSummary(coverage);
  const counts = Object.entries(summary.byVerdictClass)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  console.log(`summary: ${summary.total} record(s); verdict classes: ${counts || '(none)'}`);
  console.log(`quantities: ${summary.quantities.join(', ') || '(none)'}`);
}

function main() {
  const { records, jsonErrors } = readRecords();
  const coverage = buildCoverage(records);
  const problems = [...jsonErrors];

  for (const row of coverage) {
    const testOnDisk = existsSync(resolve(TESTS, row.test));
    problems.push(...coverageRowProblems(row, testOnDisk));
  }

  if (problems.length) {
    console.error('lint:reference-strategy FAILED:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  if (coverage.length === 0) {
    console.log('lint:reference-strategy OK — no oracle-consensus records yet');
    return;
  }
  printMatrix(coverage);
  console.log(
    `lint:reference-strategy OK — ${coverage.length} record(s), each classified, reference-named and test-backed`,
  );
}

if (isCliEntry(import.meta.url)) main();
