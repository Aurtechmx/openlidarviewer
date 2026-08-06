#!/usr/bin/env node
/**
 * verify-classifier-corpus.mjs — the gate on the classifier corpus record.
 *
 *   node scripts/verify-classifier-corpus.mjs
 *   node scripts/verify-classifier-corpus.mjs --file <path>
 *
 * TWO CHECKS, AND THEY GUARD DIFFERENT THINGS.
 *
 *   1. THE CORPUS DIGEST IS EXACT. `EXPECTED_CORPUS` below is the corpus as
 *      published. The check is equality in both directions, not a threshold: a
 *      corpus that changed at all invalidates every metric measured against the
 *      old one, and a metric that rose because the scenes got easier reads
 *      exactly like a classifier that improved. Editing a scene means editing
 *      this constant, which puts the change in the diff where a reviewer sees
 *      it beside the numbers it moved.
 *
 *   2. THE METRICS DID NOT FALL. `FROZEN_BASELINE` is the measured result at
 *      the commit that last moved it, low figures included. The gate does not
 *      call those figures good — `rolling-terrain` sits at 0.40 ground recall
 *      and `walls-roofs` at 0.33 macro-F1. It refuses a DROP and nothing else,
 *      because the failure mode being guarded is a silent regression.
 *
 * WHAT THIS DOES NOT DO. It does not run the classifier and it does not
 * recompute a confusion matrix. `tests/classifierCorpusEval.test.ts` is the
 * recompute: it builds the corpus, runs `deriveClassification`, reduces through
 * `src/validation/classifierCorpus.ts` and writes the record this file reads.
 * Run the unit bucket to refresh the record before trusting a pass. The same
 * division of labour `verify-ground-filter-metrics.mjs` uses.
 *
 * WHAT THE NUMBERS ARE. Synthetic scenes with labels this project generated:
 * one implementation measured against a generator the same project wrote. Not
 * field validation, not survey truth, and not a statement about a real scan.
 *
 * WHY THE TOLERANCE IS ALL BUT ZERO. The corpus is seeded and quantised and the
 * classifier is deterministic, so every metric is an exact ratio of integer
 * point counts and a faithful re-run reproduces it. The expected drift is zero;
 * REGRESSION_TOLERANCE only absorbs the last bit of a re-serialised double.
 *
 * Exit 0 when nothing regressed, 1 when a check failed, 2 on a usage, read or
 * parse error.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const RECORD_PATH = 'validation/classifier-corpus/results-classifier-corpus.json';

/** See the header: float re-serialisation only, never a real movement. */
export const REGRESSION_TOLERANCE = 1e-9;

/** The corpus as published. Equality, both directions. */
export const EXPECTED_CORPUS = {
  version: 1,
  digest: 'sha256:2a0c01654d979210dd2b95ef343c3b25a5a4ae97a237afaddf8662197173b1db',
  sceneIds: [
    'aerial-urban',
    'aerial-vegetation',
    'scan-edge-void',
    'walls-roofs',
    'low-vegetation',
    'steep-terrain',
    'rolling-terrain',
    'low-outliers',
    'urban-no-rgb',
    'vegetation-no-returns',
    'units-metre',
    'units-foot',
  ],
};

/**
 * The measured metrics at the commit that last moved this line, not targets.
 * `macroF1` is the mean F1 over the five emittable classes; `groundRecall` is
 * the recall of ASPRS 2. A real improvement raises one and passes; the check is
 * one-directional on purpose.
 */
export const FROZEN_BASELINE = {
  scenes: {
    'aerial-urban': { macroF1: 0.9991111111111112, groundRecall: 1 },
    'aerial-vegetation': { macroF1: 0.9901007905138339, groundRecall: 1 },
    'scan-edge-void': { macroF1: 0.9919991432146027, groundRecall: 1 },
    'walls-roofs': { macroF1: 0.32544967041385714, groundRecall: 1 },
    'low-vegetation': { macroF1: 0.9987985556475145, groundRecall: 1 },
    'steep-terrain': { macroF1: 0.38020672712009773, groundRecall: 0.63625 },
    'rolling-terrain': { macroF1: 0.28191705148677226, groundRecall: 0.4 },
    'low-outliers': { macroF1: 0.08274159159891112, groundRecall: 0 },
    'urban-no-rgb': { macroF1: 0.9991111111111112, groundRecall: 1 },
    'vegetation-no-returns': { macroF1: 0.9901007905138339, groundRecall: 1 },
    'units-metre': { macroF1: 0.989786971754634, groundRecall: 1 },
    'units-foot': { macroF1: 0.989786971754634, groundRecall: 1 },
  },
  pooled: { macroF1: 0.6113389074840996, groundRecall: 0.8342782817502669 },
};

const f3 = (v) => (v === null || v === undefined ? 'n/a' : Number(v).toFixed(4));

/** Ground recall (ASPRS 2) out of a reduced score object. */
function groundRecallOf(metrics) {
  const row = (metrics?.byClass ?? []).find((m) => m.code === 2);
  return row && typeof row.recall === 'number' ? row.recall : null;
}

/**
 * Compare a live record against the expected corpus and the frozen baseline.
 * Returns `{ problems, readings }`; an empty `problems` is a pass.
 */
export function collectCorpusProblems(
  record,
  expected = EXPECTED_CORPUS,
  baseline = FROZEN_BASELINE,
  tol = REGRESSION_TOLERANCE,
) {
  const problems = [];
  const readings = [];

  if (record.corpusVersion !== expected.version) {
    problems.push(
      `corpus version is ${record.corpusVersion}, expected ${expected.version}. ` +
        'A corpus at a different version is not the corpus this baseline was measured on.',
    );
  }
  if (record.corpusDigest !== expected.digest) {
    problems.push(
      `corpus digest is ${record.corpusDigest}, expected ${expected.digest}. ` +
        'The scenes moved, so every metric below was measured against a different corpus.',
    );
  }
  const liveIds = (record.scenes ?? []).map((s) => s.id);
  if (liveIds.join('|') !== expected.sceneIds.join('|')) {
    problems.push(
      `scene list is [${liveIds.join(', ')}], expected [${expected.sceneIds.join(', ')}]. ` +
        'A dropped scene turns the coverage claim into a claim about scenes that are gone.',
    );
  }

  const sceneById = new Map((record.scenes ?? []).map((s) => [s.id, s.metrics]));
  const check = (scope, id, base, metrics) => {
    if (!metrics) {
      problems.push(`${scope} "${id}" is in the baseline but absent from the record.`);
      readings.push({ scope, id, macroF1: null, groundRecall: null });
      return;
    }
    const macroF1 = typeof metrics.macroF1 === 'number' ? metrics.macroF1 : null;
    const groundRecall = groundRecallOf(metrics);
    readings.push({ scope, id, macroF1, groundRecall });
    for (const [name, baseVal, liveVal] of [
      ['macro-F1', base.macroF1, macroF1],
      ['ground recall', base.groundRecall, groundRecall],
    ]) {
      if (liveVal === null) {
        problems.push(
          `${scope} "${id}" ${name} is null, baseline ${baseVal}. The metric was measured ` +
            'when the baseline was frozen and is not now.',
        );
        continue;
      }
      if (baseVal - liveVal > tol) {
        problems.push(
          `${scope} "${id}" ${name} regressed: ${liveVal} is below the frozen ${baseVal} by ` +
            `${(baseVal - liveVal).toExponential(3)}, over the ${tol} tolerance.`,
        );
      }
    }
  };

  for (const id of Object.keys(baseline.scenes)) {
    check('scene', id, baseline.scenes[id], sceneById.get(id));
  }
  check('pooled', 'pooled', baseline.pooled, record.pooled);

  return { problems, readings };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const fileFlag = argv.indexOf('--file');
  const path = resolve(ROOT, fileFlag >= 0 ? argv[fileFlag + 1] : RECORD_PATH);

  let record;
  try {
    if (!existsSync(path)) {
      throw new Error(`${path} is not on disk; run the unit test bucket to produce it.`);
    }
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`verify:classifier-corpus cannot read its input: ${err.message}`);
    process.exit(2);
  }

  const { problems, readings } = collectCorpusProblems(record);

  // Print every reading whichever way it goes, so the weak scenes stay visible
  // in the log rather than only when the gate trips.
  for (const r of readings) {
    console.log(`  ${r.scope}/${r.id}: macro-F1 ${f3(r.macroF1)}, ground recall ${f3(r.groundRecall)}`);
  }

  if (problems.length > 0) {
    console.error('\nverify:classifier-corpus FAILED\n');
    for (const p of problems) console.error(`  • ${p}`);
    console.error(
      '\nThe corpus digest and the frozen baseline are in scripts/verify-classifier-corpus.mjs.\n' +
        'If a metric legitimately improved, refresh the record and RAISE the baseline. Never\n' +
        'lower it to admit a worse result, and never edit the digest to admit a moved corpus\n' +
        'without saying in the same commit what moved.',
    );
    process.exit(1);
  }

  console.log(
    `\nverify:classifier-corpus OK — corpus digest matches and ${readings.length} reading(s) sit ` +
      `at or above the frozen baseline in ${RECORD_PATH}. A low figure that holds steady is a ` +
      'finding, not a failure; these are synthetic scenes and not field validation.',
  );
  process.exit(0);
}
