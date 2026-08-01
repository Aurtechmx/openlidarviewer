#!/usr/bin/env node
/**
 * verify-ground-filter-metrics.mjs — a regression gate on the ground-filter
 * classification metrics, so a change that makes OLV reject more of the ground
 * PDAL accepts cannot land quietly.
 *
 *   node scripts/verify-ground-filter-metrics.mjs
 *   node scripts/verify-ground-filter-metrics.mjs --file <path>
 *
 * WHY RECALL AND MCC, AND NOT THE AGREEMENT FRACTION. The study's headline is a
 * label-agreement fraction near 82 %. That number is dominated by the non-ground
 * returns both sides reject, so it stays high even when OLV keeps only a fraction
 * of the ground PDAL calls ground. Recall is that fraction (ground is the
 * positive class, PDAL is the truth argument), and MCC moves with it while
 * staying honest at the imbalanced margins. Freezing those two is what turns
 * "OLV rejects valid ground" from a footnote into a gate.
 *
 * WHAT THIS DOES NOT DO. It does not run the filter and it does not recompute a
 * confusion matrix. results-ground-filter-metrics.json is produced by
 * tests/groundFilterPdalAgreement.test.ts, which runs classifyGroundSmrf against
 * the committed PDAL reference and reduces the result through
 * src/validation/classificationAgreement.ts. That test is the recompute; this
 * gate reads its committed record and refuses a regression against the frozen
 * baseline below, the same division of labour verify-cross-implementation-study
 * uses. Run the terrain bucket to refresh the record before trusting a pass.
 *
 * WHAT THE BASELINE IS, AND WHY IT IS NOT A TARGET. The frozen numbers are the
 * measured metrics as of this commit, low ones included. pc-04-plane-lowblunders
 * sits at 0.99 % recall and pc-02-rolling at 44.8 %: OLV keeps almost none of the
 * low-blunder ground and under half of the rolling ground. The gate does not
 * judge those as good. It only refuses to let them fall further. A real
 * improvement raises recall or MCC and passes; the check is one-directional on
 * purpose, because the failure mode being guarded is a drop.
 *
 * WHY THE TOLERANCE IS ALL BUT ZERO. The scenes are synthetic and seeded, the
 * filter is deterministic, and every metric is an exact ratio of integer cell
 * counts, so a faithful re-run reproduces each figure bit for bit. The expected
 * drift is therefore zero. REGRESSION_TOLERANCE is 1e-9, low enough that only a
 * last-bit difference in a re-serialised double passes and any real movement of
 * a return between ground and non-ground trips the gate.
 *
 * Exit 0 when nothing regressed, 1 when a metric fell below its baseline, 2 on a
 * usage, read or parse error.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const METRICS_PATH =
  'validation/cross-implementation/pdal-pipeline/results-ground-filter-metrics.json';

/**
 * The largest drop, in absolute metric units, that is not treated as a
 * regression. See the header: the deterministic pipeline makes the expected
 * drift exactly zero, so this only absorbs float re-serialisation noise.
 */
export const REGRESSION_TOLERANCE = 1e-9;

/**
 * The frozen baseline: recall and MCC for every scene, terrain category and the
 * pool, as measured at the commit that added this gate. These are the values a
 * regression is measured against, not goals to reach. Editing one down to admit
 * a worse result is the move this file exists to make visible in a diff.
 */
export const FROZEN_BASELINE = {
  scenes: {
    'pc-01-plane-buildings': { recall: 1, mcc: 1 },
    'pc-02-rolling-buildings': { recall: 0.4479022300617362, mcc: 0.43485943305173447 },
    'pc-03-ridge-buildings': { recall: 0.7162707306140744, mcc: 0.5806670864883533 },
    'pc-04-plane-lowblunders': { recall: 0.009914529914529915, mcc: 0.08314446932594088 },
    'pc-05-plane-gap': { recall: 1, mcc: 1 },
  },
  categories: {
    plane: { recall: 0.8606285191780163, mcc: 0.8328454932939224 },
    ridge: { recall: 0.7162707306140744, mcc: 0.5806670864883533 },
    rolling: { recall: 0.4479022300617362, mcc: 0.43485943305173447 },
  },
  pooled: { recall: 0.7393730074388948, mcc: 0.6882381941192217 },
};

const pct = (v) => (v === null || v === undefined ? 'n/a' : `${(v * 100).toFixed(2)} %`);

/**
 * Compare a live metrics record against `baseline`. Returns
 * `{ problems, readings }`: `problems` is the list of regressions (empty means a
 * pass), `readings` is every measured recall/MCC in a stable order, so the
 * caller can print the numbers whether or not anything failed.
 */
export function collectMetricRegressions(record, baseline = FROZEN_BASELINE, tol = REGRESSION_TOLERANCE) {
  const problems = [];
  const readings = [];
  const add = (scope, id, message) => problems.push({ scope, id, message });

  // A recall the record reports as null where the baseline holds a number is a
  // metric that stopped being measured, which is a regression and not a pass.
  const check = (scope, id, base, live) => {
    if (!live) {
      add(scope, id, `${scope} "${id}" is in the baseline but absent from the record.`);
      readings.push({ scope, id, recall: null, mcc: null });
      return;
    }
    const recall = live.groundRecall ?? null;
    const mcc = typeof live.mcc === 'number' ? live.mcc : null;
    readings.push({ scope, id, recall, mcc });
    for (const [name, baseVal, liveVal] of [
      ['recall', base.recall, recall],
      ['MCC', base.mcc, mcc],
    ]) {
      if (liveVal === null) {
        add(scope, id, `${scope} "${id}" ${name} is null, baseline ${baseVal}; the metric was measured when the baseline was frozen and is not now.`);
        continue;
      }
      if (baseVal - liveVal > tol) {
        add(
          scope,
          id,
          `${scope} "${id}" ${name} regressed: ${liveVal} is below the frozen ${baseVal} by ` +
            `${(baseVal - liveVal).toExponential(3)}, over the ${tol} tolerance. ` +
            `A drop here is OLV keeping less of the ground PDAL calls ground.`,
        );
      }
    }
  };

  const sceneById = new Map((record.legs ?? []).map((l) => [l.fixtureId, l.metrics]));
  for (const id of Object.keys(baseline.scenes).sort()) {
    check('scene', id, baseline.scenes[id], sceneById.get(id));
  }
  const catBySurface = new Map((record.byCategory ?? []).map((c) => [c.surface, c.metrics]));
  for (const surface of Object.keys(baseline.categories).sort()) {
    check('category', surface, baseline.categories[surface], catBySurface.get(surface));
  }
  check('pooled', 'pooled', baseline.pooled, record.pooled);

  return { problems, readings };
}

function isMain() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMain()) {
  const argv = process.argv.slice(2);
  const fileArg = argv.indexOf('--file') >= 0 ? argv[argv.indexOf('--file') + 1] : undefined;
  const path = resolve(ROOT, fileArg ?? METRICS_PATH);

  let record;
  try {
    if (!existsSync(path)) {
      throw new Error(`${path} is not on disk; run the terrain test bucket to produce it.`);
    }
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`verify:ground-filter-metrics cannot read its input: ${err.message}`);
    process.exit(2);
  }

  const { problems, readings } = collectMetricRegressions(record);

  // Print the readings whichever way it goes, so the low-recall failure mode is
  // visible in the log and not only when the gate trips.
  for (const r of readings) {
    console.log(`  ${r.scope}/${r.id}: recall ${pct(r.recall)}, MCC ${r.mcc === null ? 'n/a' : r.mcc.toFixed(3)}`);
  }

  if (problems.length > 0) {
    console.error('\nverify:ground-filter-metrics FAILED\n');
    for (const p of problems) console.error(`  • ${p.message}`);
    console.error(
      '\nThe frozen baseline is in scripts/verify-ground-filter-metrics.mjs. If a metric\n' +
        'legitimately improved, refresh the record and RAISE the baseline; never lower it to\n' +
        'admit a worse result.',
    );
    process.exit(1);
  }

  console.log(
    `\nverify:ground-filter-metrics OK — ${readings.length} reading(s) at or above the frozen ` +
      `baseline in ${METRICS_PATH}. Recall and MCC are the guarded metrics; a low value that ` +
      'holds steady is a finding, not a failure.',
  );
  process.exit(0);
}
