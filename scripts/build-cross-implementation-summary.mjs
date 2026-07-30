#!/usr/bin/env node
/**
 * build-cross-implementation-summary.mjs — one summary over the study manifests,
 * built only from records that verify.
 *
 *   node scripts/build-cross-implementation-summary.mjs          write the summary
 *   node scripts/build-cross-implementation-summary.mjs --check  fail if it is stale
 *
 * Accepts --studies, --artifact-root, --register and --dataset-register and
 * passes them to the verification step unchanged.
 *
 * Every number in validation/cross-implementation/summary.json comes from here.
 * Two properties matter more than the arithmetic:
 *
 *   1. Nothing unverified is summarised. The manifests go through
 *      scripts/verify-cross-implementation-study.mjs first, and one rejection
 *      stops the build. A summary is a claim about a set of records; it may not
 *      be assembled from records that failed their own checks.
 *
 *   2. `pending` and `not-executed` never reach a count, and neither does an
 *      example manifest. Work that has not run is not a weak result, it is not a
 *      result — counting it as one is how a queue of intentions turns into a
 *      table that looks like evidence. They are listed under
 *      `excludedFromCounts` with the reason, so the reader can see the queue
 *      without it being added up.
 *
 * The output carries no timestamp, so re-running on an unchanged tree reproduces
 * it byte for byte and `--check` is meaningful.
 *
 * Exit 0 on success, 1 on a verification failure or a stale check, 2 on a read
 * or write error.
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

import {
  verifyStudies,
  UNCOUNTED_STATUSES,
  RESULT_STATUSES,
  STUDY_STATUSES,
} from './verify-cross-implementation-study.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_OUT = join(ROOT, 'validation/cross-implementation/summary.json');

/** Why a study is out of the counts. Null means it counts. */
export function exclusionReason(manifest) {
  if (manifest.example === true) return 'example manifest: a template, not a study';
  if (UNCOUNTED_STATUSES.has(manifest.status)) {
    return `status "${manifest.status}": nothing was measured, so there is nothing to count`;
  }
  return null;
}

/** Sorted-key object, so the written file is stable across runs. */
const sorted = (obj) =>
  Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Build the summary from verified manifests. Pure: takes `[{ manifest }]`,
 * returns the object to write.
 */
export function summarise(studies) {
  const excluded = [];
  const counted = [];
  for (const { manifest } of studies) {
    const why = exclusionReason(manifest);
    if (why) {
      excluded.push({
        studyId: manifest.studyId,
        claimId: manifest.claimId,
        status: manifest.status,
        why,
      });
    } else counted.push(manifest);
  }

  const byStatus = {};
  for (const m of counted) byStatus[m.status] = (byStatus[m.status] ?? 0) + 1;

  const byClaim = {};
  for (const m of counted) {
    const entry = (byClaim[m.claimId] ??= {
      studies: 0,
      byStatus: {},
      datasetIds: [],
      parameterSetIds: [],
    });
    entry.studies += 1;
    entry.byStatus[m.status] = (entry.byStatus[m.status] ?? 0) + 1;
    for (const d of m.datasets) if (!entry.datasetIds.includes(d.datasetId)) entry.datasetIds.push(d.datasetId);
    for (const p of m.parameterSets) if (!entry.parameterSetIds.includes(p.id)) entry.parameterSetIds.push(p.id);
  }
  for (const entry of Object.values(byClaim)) {
    entry.byStatus = sorted(entry.byStatus);
    entry.datasetIds.sort();
    entry.parameterSetIds.sort();
  }

  // The agreement fraction's denominator is the studies that produced a
  // comparison, never the studies that exist. Stated in the file so a reader
  // does not have to infer it.
  const resultStudies = counted.filter((m) => RESULT_STATUSES.has(m.status));
  const agreeing = resultStudies.filter((m) => m.status === 'agree').length;

  return {
    schemaVersion: 1,
    generatedBy: 'scripts/build-cross-implementation-summary.mjs',
    source: 'validation/cross-implementation/studies',
    evidenceEffect:
      'None. This file counts study outcomes. Evidence levels live in docs/validation/claim-register.yaml and move only by a human change to that file.',
    permittedStatuses: [...STUDY_STATUSES],
    uncountedStatuses: [...UNCOUNTED_STATUSES].sort(),
    studiesRead: studies.length,
    countedStudies: counted.length,
    byStatus: sorted(byStatus),
    byClaim: sorted(byClaim),
    agreement: {
      denominator: resultStudies.length,
      denominatorMeaning: 'studies whose status is agree, partial or disagree',
      agree: agreeing,
      fraction: resultStudies.length > 0 ? agreeing / resultStudies.length : null,
    },
    excludedFromCounts: excluded.sort((a, b) => (a.studyId < b.studyId ? -1 : 1)),
  };
}

/**
 * The guard behind property 2 above. A summary is the wrong place to discover
 * this by reading it, so the build refuses to write instead.
 */
export function selfCheckProblems(summary) {
  const problems = [];
  const excludedIds = new Set(summary.excludedFromCounts.map((e) => e.studyId));
  for (const status of summary.uncountedStatuses) {
    if (summary.byStatus[status] !== undefined) {
      problems.push(`byStatus counts "${status}", which may never reach a count.`);
    }
    for (const [claimId, entry] of Object.entries(summary.byClaim)) {
      if (entry.byStatus[status] !== undefined) {
        problems.push(`byClaim.${claimId} counts "${status}", which may never reach a count.`);
      }
    }
  }
  const total = Object.values(summary.byStatus).reduce((a, b) => a + b, 0);
  if (total !== summary.countedStudies) {
    problems.push(`byStatus sums to ${total} but countedStudies is ${summary.countedStudies}.`);
  }
  if (summary.countedStudies + excludedIds.size !== summary.studiesRead) {
    problems.push(
      `counted (${summary.countedStudies}) plus excluded (${excludedIds.size}) does not account for the ${summary.studiesRead} manifest(s) read.`,
    );
  }
  if (summary.agreement.denominator > summary.countedStudies) {
    problems.push('the agreement denominator exceeds the number of counted studies.');
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
    verified = verifyStudies({
      studiesDir: opt('--studies'),
      artifactRoot: opt('--artifact-root'),
      registerPath: opt('--register'),
      // Forwarded so a caller can name the dataset register the verification
      // step checks membership against, rather than inheriting whatever the tree
      // happens to hold. No summary number depends on it.
      datasetRegisterPath: opt('--dataset-register'),
    });
  } catch (err) {
    console.error(`build:cross-implementation-summary cannot read the manifests: ${err.message}`);
    process.exit(2);
  }

  if (verified.problems.length > 0) {
    console.error('build:cross-implementation-summary FAILED — the manifests do not verify\n');
    for (const p of verified.problems) console.error(`  • [${p.rule}] ${p.message}`);
    console.error('\nNo summary is written from records that failed their own checks.');
    process.exit(1);
  }

  const summary = summarise(verified.studies);
  const selfProblems = selfCheckProblems(summary);
  if (selfProblems.length > 0) {
    console.error('build:cross-implementation-summary FAILED — the summary contradicts its own rules\n');
    for (const p of selfProblems) console.error(`  • ${p}`);
    process.exit(1);
  }

  const text = `${JSON.stringify(summary, null, 2)}\n`;
  if (checkOnly) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;
    if (current !== text) {
      console.error(`build:cross-implementation-summary FAILED — ${outPath} is stale. Re-run without --check.`);
      process.exit(1);
    }
    console.log(`build:cross-implementation-summary OK — ${outPath} is current.`);
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
    `build:cross-implementation-summary OK — ${summary.studiesRead} manifest(s) read, ` +
      `${summary.countedStudies} counted, ${summary.excludedFromCounts.length} excluded ` +
      `(pending / not-executed / example). Written to ${outPath}.`,
  );
  process.exit(0);
}
