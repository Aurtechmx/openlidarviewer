#!/usr/bin/env node
/**
 * build-impact-summary.mjs — one summary over the impact records, built only
 * from records that verify.
 *
 *   node scripts/build-impact-summary.mjs          write the summary
 *   node scripts/build-impact-summary.mjs --check  fail if it is stale
 *
 * Every number in validation/impact/summary.json comes from here, and three
 * properties matter more than the arithmetic:
 *
 *   1. Nothing unverified is summarised. The records go through
 *      scripts/verify-impact-record.mjs first and one rejection stops the
 *      build. A summary is a claim about a set of records; it may not be
 *      assembled from records that failed their own checks.
 *
 *   2. Only "verified" reaches a count, and an example record never does
 *      whatever its status. Recorded-but-unchecked is not weak impact, it is
 *      not impact — counting it is how a list of hopes becomes a table that
 *      looks like adoption. Everything excluded is listed under
 *      `excludedFromCounts` with the reason, so the queue is visible without
 *      being added up.
 *
 *   3. Work by this project's own members is counted separately from work by
 *      anyone else. Both are real; only one of them is adoption.
 *
 * The output carries no timestamp, so re-running on an unchanged tree
 * reproduces it byte for byte and `--check` means something.
 *
 * Exit 0 on success, 1 on a verification failure or a stale check, 2 on a read
 * or write error.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import { compareCodeUnits } from './lib/codeUnitOrder.mjs';
import {
  verifyImpactRecords,
  UNCOUNTED_STATUSES,
  IMPACT_STATUSES,
  PUBLIC_SOURCE_KINDS,
} from './verify-impact-record.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'validation/impact/summary.json');

/** Why a record is out of the counts. Null means it counts. */
export function exclusionReason(record) {
  if (record.example === true) return 'example record: a template, not an impact';
  if (UNCOUNTED_STATUSES.has(record.status)) {
    return `status "${record.status}": nothing was verified, so there is nothing to count`;
  }
  return null;
}

/** Sorted-key object, so the written file is stable across runs. */
const sorted = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => compareCodeUnits(a, b)));

/** Build the summary from verified records. Pure. */
export function summarise(records) {
  const excluded = [];
  const counted = [];
  for (const { record } of records) {
    const why = exclusionReason(record);
    if (why) {
      excluded.push({ recordId: record.recordId, kind: record.kind, status: record.status, why });
    } else counted.push(record);
  }

  const byKind = {};
  for (const r of counted) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  const bySourceKind = {};
  for (const r of counted) bySourceKind[r.source.kind] = (bySourceKind[r.source.kind] ?? 0) + 1;

  const byProjectMembers = counted.filter((r) => r.relationToProject.byProjectMembers).length;

  return {
    schemaVersion: 1,
    generatedBy: 'scripts/build-impact-summary.mjs',
    source: 'validation/impact/records',
    evidenceEffect:
      'None. Impact is not evidence. This file counts records of use and citation; evidence levels live in docs/validation/claim-register.yaml and move only by a human change to that file.',
    permittedStatuses: [...IMPACT_STATUSES],
    uncountedStatuses: [...UNCOUNTED_STATUSES].sort(compareCodeUnits),
    countableSourceKinds: [...PUBLIC_SOURCE_KINDS].sort(compareCodeUnits),
    recordsRead: records.length,
    countedRecords: counted.length,
    byKind: sorted(byKind),
    bySourceKind: sorted(bySourceKind),
    independence: {
      byProjectMembers,
      byOthers: counted.length - byProjectMembers,
      meaning:
        'byOthers is the only figure that describes adoption. A record authored by this project\'s own members is a publication, not somebody else taking the software up.',
    },
    excludedFromCounts: excluded.sort((a, b) => compareCodeUnits(a.recordId, b.recordId)),
  };
}

/**
 * The guard behind the counting rules. A summary is the wrong place to discover
 * a broken one by reading it, so the build refuses to write instead.
 */
export function selfCheckProblems(summary) {
  const problems = [];
  const total = Object.values(summary.byKind).reduce((a, b) => a + b, 0);
  if (total !== summary.countedRecords) {
    problems.push(`byKind sums to ${total} but countedRecords is ${summary.countedRecords}.`);
  }
  const sourceTotal = Object.values(summary.bySourceKind).reduce((a, b) => a + b, 0);
  if (sourceTotal !== summary.countedRecords) {
    problems.push(`bySourceKind sums to ${sourceTotal} but countedRecords is ${summary.countedRecords}.`);
  }
  for (const kind of Object.keys(summary.bySourceKind)) {
    if (!summary.countableSourceKinds.includes(kind)) {
      problems.push(`bySourceKind counts "${kind}", which is not a source a reader can resolve.`);
    }
  }
  if (summary.countedRecords + summary.excludedFromCounts.length !== summary.recordsRead) {
    problems.push(
      `counted (${summary.countedRecords}) plus excluded (${summary.excludedFromCounts.length}) does not account for the ${summary.recordsRead} record(s) read.`,
    );
  }
  if (summary.independence.byProjectMembers + summary.independence.byOthers !== summary.countedRecords) {
    problems.push('the independence split does not sum to countedRecords.');
  }
  return problems;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const opt = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const checkOnly = argv.includes('--check');
  const outPath = resolve(opt('--out') ?? DEFAULT_OUT);

  let verified;
  try {
    verified = verifyImpactRecords({ recordsDir: opt('--records'), registerPath: opt('--register') });
  } catch (err) {
    console.error(`build:impact-summary cannot read the records: ${err.message}`);
    process.exit(2);
  }

  if (verified.problems.length > 0) {
    console.error('build:impact-summary FAILED — the records do not verify\n');
    for (const p of verified.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nNo summary is written from records that failed their own checks.');
    process.exit(1);
  }

  const summary = summarise(verified.records);
  const selfProblems = selfCheckProblems(summary);
  if (selfProblems.length > 0) {
    console.error('build:impact-summary FAILED — the summary contradicts its own rules\n');
    for (const p of selfProblems) console.error(`  • ${p}`);
    process.exit(1);
  }

  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (checkOnly) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
    if (current !== text) {
      console.error(`build:impact-summary FAILED — ${outPath} is stale. Re-run without --check.`);
      process.exit(1);
    }
    console.log(`build:impact-summary OK — ${outPath} is current.`);
    process.exit(0);
  }

  try {
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, text);
  } catch (err) {
    console.error(`cannot write ${outPath}: ${err.message}`);
    process.exit(2);
  }

  console.log(
    `build:impact-summary OK — ${summary.recordsRead} record(s) read, ${summary.countedRecords} counted, ` +
      `${summary.excludedFromCounts.length} excluded (unverified / example). Written to ${outPath}.`,
  );
  process.exit(0);
}
