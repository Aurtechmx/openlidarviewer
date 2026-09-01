#!/usr/bin/env node
/**
 * lint-oracle-consensus.mjs — shape guard for the oracle-triangulation framework.
 *
 * Each `validation/oracle-consensus/*.consensus.json` record triangulates one
 * OLV quantity against analytic truth and/or matched independent implementations
 * (GDAL, GRASS, PROJ, PDAL, ...). The records only mean something if they all
 * carry the same canonical contract and are each backed by a live CI test — a
 * record with no test is an unverified claim, and a record missing its truth or
 * matched-implementation legs is not a triangulation.
 *
 * This lint enforces that contract over WHATEVER records are present, without a
 * hardcoded roster: it activates on each family as it lands rather than needing
 * a central list kept in sync. The rules are a pure function of the parsed
 * records so tests/oracleConsensusFramework.test.ts exercises the rules, not the
 * repository's current contents.
 *
 * Passing on zero records is intentional: the framework can be introduced before
 * any family merges, and each family is validated as it arrives.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isCliEntry } from './lib/isCliEntry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, 'validation/oracle-consensus');
const TESTS = resolve(ROOT, 'tests');

const REFERENCE_CLASSES = new Set(['analytic-truth', 'matched-implementation', 'exploratory-reference']);

/** Collect every oracle entry a record carries, whether flat or under `cases`. */
function collectOracles(record) {
  if (Array.isArray(record.oracles)) return record.oracles;
  if (Array.isArray(record.cases)) return record.cases.flatMap((c) => c.oracles ?? []);
  return [];
}

/**
 * Rule check for one parsed record. Returns an array of problem strings (empty =
 * clean). Exported shape: { file, record } in, string[] out.
 */
export function collectRecordProblems(file, record) {
  const problems = [];
  const contract = record.contract;
  if (!contract || typeof contract !== 'object') {
    problems.push(`${file}: missing "contract" object`);
    return problems; // nothing else is checkable
  }
  if (!contract.id) problems.push(`${file}: contract.id is required`);
  if (!contract.quantity) problems.push(`${file}: contract.quantity is required`);

  // A quantitative triangulation states a tolerance; an exploratory record
  // states a sensitivity threshold instead — accept either shape.
  const exploratory = record.evidenceRole === 'exploratory';
  const hasBound = Object.keys(contract).some((k) => /tolerance|threshold/i.test(k));
  if (!hasBound) {
    problems.push(`${file}: contract needs a tolerance (or, for exploratory records, a threshold) field`);
  }

  const oracles = collectOracles(record);
  // An exploratory record documents a spread across scenes rather than a single
  // triangulated answer, so it carries a `scenes` array instead of oracle legs.
  if (exploratory) {
    if (!Array.isArray(record.scenes) || record.scenes.length === 0) {
      problems.push(`${file}: exploratory record needs a non-empty "scenes" array`);
    }
  } else if (oracles.length === 0) {
    problems.push(`${file}: no oracle legs found (flat "oracles" or per-case)`);
  }

  for (const o of oracles) {
    if (!o.id) problems.push(`${file}: an oracle leg has no id`);
    if (!REFERENCE_CLASSES.has(o.referenceClass)) {
      problems.push(`${file}: oracle "${o.id}" has unknown referenceClass "${o.referenceClass}"`);
    }
  }

  // A triangulation needs at least a truth anchor OR two independent references.
  // An exploratory record (declared) is exempt — it documents disagreement, not
  // a single answer.
  const hasTruth = oracles.some((o) => o.referenceClass === 'analytic-truth');
  const matchedCount = oracles.filter((o) => o.referenceClass === 'matched-implementation').length;
  if (!exploratory && !hasTruth && matchedCount < 2) {
    problems.push(
      `${file}: not a triangulation — needs an analytic-truth leg or >=2 matched implementations ` +
        `(or evidenceRole:"exploratory")`,
    );
  }

  return problems;
}

/** Map a record filename to the test file that must back it. */
export function expectedTestName(consensusFile) {
  // slope-horn.consensus.json -> oracleConsensusSlopeHorn... : we match by the
  // leading token so the test naming stays readable rather than mechanical.
  const stem = basename(consensusFile).replace(/\.consensus\.json$/, '');
  const key = stem.split('-')[0]; // slope, aspect, hillshade, crs, ground, ...
  return `oracleConsensus${key.charAt(0).toUpperCase()}${key.slice(1)}.test.ts`;
}

function main() {
  if (!existsSync(DIR)) {
    console.log('lint:oracle-consensus OK — no oracle-consensus records yet');
    return;
  }
  const files = readdirSync(DIR).filter((f) => f.endsWith('.consensus.json'));
  const problems = [];

  for (const f of files) {
    let record;
    try {
      record = JSON.parse(readFileSync(resolve(DIR, f), 'utf8'));
    } catch (e) {
      problems.push(`${f}: invalid JSON — ${e.message}`);
      continue;
    }
    problems.push(...collectRecordProblems(f, record));

    const testFile = expectedTestName(f);
    if (!existsSync(resolve(TESTS, testFile))) {
      problems.push(`${f}: no backing CI test (expected tests/${testFile})`);
    }
  }

  if (problems.length) {
    console.error('lint:oracle-consensus FAILED:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }
  console.log(`lint:oracle-consensus OK — ${files.length} record(s), each contract-shaped and test-backed`);
}

// Only run when invoked directly, not when imported by the test.
if (isCliEntry(import.meta.url)) main();
