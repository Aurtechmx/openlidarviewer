/**
 * render.ts: the seed-sensitivity report, rendered from the evaluation.
 *
 * Every figure comes out of `SweepEvaluation`, so the Markdown and the JSON can
 * never disagree: a reader recomputing a spread from the raw values in
 * `sweep.json` lands on the printed number. Rounding is `toFixed` throughout,
 * for the reason `benchmarks/runner/render.ts` gives — a locale formatter puts
 * a machine-dependent separator into a file another tool parses.
 */

import { formatFixed, formatInteger } from '../runner/render';
import { SWEEP_SEED_COUNT, UNCOVERED, specOf } from './classification';
import type { SweepEvaluation } from './sweep';

/** Significant-figure formatting for a spread that may span many decades. */
function sig(value: number | null, digits = 3): string {
  if (value === null || !Number.isFinite(value)) return 'unavailable';
  if (value === 0) return '0';
  return value.toPrecision(digits);
}

export function renderSeedSummary(ev: SweepEvaluation): string {
  const lines: string[] = [];
  lines.push('# Seed sensitivity');
  lines.push('');
  lines.push(
    'How much of a reported figure is the pipeline and how much is the particular draw. ' +
      'The reproducibility suite fixes one seed and shows the pipeline repeats there; that is determinism, ' +
      'not stability. This sweep runs the same analysis over independently seeded fixtures from the same ' +
      'generator and the same distribution.',
  );
  lines.push('');
  lines.push('## Configuration');
  lines.push('');
  lines.push(`- seeds: ${ev.seedCount}, from ${ev.seeds[0]} to ${ev.seeds[ev.seeds.length - 1]}`);
  lines.push(`- points per fixture: ${formatInteger(ev.pointCount)}`);
  lines.push(`- cell size: ${formatFixed(ev.cellSizeM, 2)} m`);
  lines.push(`- quantile convention: ${ev.quantileConvention}`);
  lines.push(
    `- relative standard error of a CV at n = ${ev.seedCount}: ${formatFixed(ev.cvRelativeStandardError, 3)} ` +
      `(1/sqrt(2(n-1))). A CV printed below is good to about ±${formatFixed(ev.cvRelativeStandardError * 100, 0)} % ` +
      `of itself at one standard error, and roughly ±${formatFixed(ev.cvRelativeStandardError * 196, 0)} % across ` +
      'a 95 % interval. It does not separate two CVs that differ by less than that.',
  );
  lines.push(
    `- min and max are the two most extreme of ${ev.seedCount} draws. They bound nothing about a rarer seed.`,
  );
  lines.push('');

  lines.push('## Invariant group — asserted');
  lines.push('');
  lines.push(
    'Quantities fixed by the configuration or by the surface definition rather than by which points ' +
      'were drawn. Each is asserted against a range tolerance registered in `benchmarks/seed/classification.ts` ' +
      'before the sweep ran, with the magnitude that justifies it.',
  );
  lines.push('');
  lines.push('| quantity | unit | n | value or range | observed range | tolerance | headroom |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const q of ev.quantities) {
    if (q.group !== 'invariant') continue;
    const spec = specOf(q.name);
    const tol = spec?.toleranceRange ?? null;
    const headroom = tol === null || tol === 0 ? (q.range === 0 ? 'exact' : 'CONSUMED') : `${sig(q.range / tol)}x of it`;
    const value =
      q.distinctCount === 1 ? sig(q.summary.min, 6) : `${sig(q.summary.min, 6)}–${sig(q.summary.max, 6)}`;
    lines.push(
      `| \`${q.name}\` | ${q.unit} | ${q.summary.count} | ${value} | ${sig(q.range)} | ${tol === null ? 'unavailable' : sig(tol)} | ${headroom} |`,
    );
  }
  lines.push('');
  if (ev.invariantViolations.length === 0) {
    lines.push(`No invariant quantity moved past its tolerance over these ${ev.seedCount} seeds.`);
  } else {
    lines.push('**Invariant tolerance exceeded.** Each row is a finding:');
    lines.push('');
    for (const v of ev.invariantViolations) {
      lines.push(
        `- \`${v.name}\`: range ${sig(v.range)} against a tolerance of ${sig(v.tolerance)} ` +
          `(${sig(v.min, 6)} to ${sig(v.max, 6)}). Tolerance basis: ${v.toleranceBasis}`,
      );
    }
  }
  lines.push('');

  lines.push('## Variable group — reported, not asserted');
  lines.push('');
  lines.push(
    'Properties of the sample. Nothing here is a pass condition: an assertion over a random quantity ' +
      'either holds by construction or fails at a rate nobody chose.',
  );
  lines.push('');
  lines.push('| quantity | unit | n | mean | sd | CV | min | max | distinct |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const q of ev.quantities) {
    if (q.group !== 'variable') continue;
    const s = q.summary;
    // sd/mean describes a scale only for a quantity whose mean is positive.
    // `elevationMinM` sits below zero here, where a ratio to the mean flips
    // sign and reads as a spread it is not.
    const cv = s.mean > 0 ? sig(s.cv) : 'not meaningful (mean is not positive)';
    lines.push(
      `| \`${q.name}\` | ${q.unit} | ${s.count} | ${sig(s.mean, 6)} | ${sig(s.stdDev)} | ${cv} | ` +
        `${sig(s.min, 6)} | ${sig(s.max, 6)} | ${q.distinctCount} |`,
    );
  }
  lines.push('');

  lines.push('## Non-numeric outputs');
  lines.push('');
  for (const c of ev.categorical) {
    const shown = c.counts.slice(0, 6).map(([v, n]) => `${v} x${n}`).join(', ');
    const tail = c.counts.length > 6 ? `, and ${c.counts.length - 6} more` : '';
    lines.push(`- \`${c.name}\`: ${c.distinctCount} distinct over ${ev.seedCount} seeds — ${shown}${tail}`);
  }
  lines.push('');

  lines.push('## Precision findings');
  lines.push('');
  if (ev.precisionFindings.length === 0) {
    lines.push('Every quantity is published at a precision its seed-to-seed spread supports.');
  } else {
    lines.push(
      'Each quantity below moves more between seeds than the quantum it is published at, so its ' +
        'published figure carries digits the measurement does not support. The comparison is against the ' +
        'sample standard deviation rather than the range, because sd is the scale a reader attaches to a ' +
        'single figure and does not grow with n.',
    );
    lines.push('');
    lines.push('| quantity | unit | sd across seeds | published decimals | published quantum | decimals supported |');
    lines.push('| --- | --- | --- | --- | --- | --- |');
    for (const f of ev.precisionFindings) {
      lines.push(
        `| \`${f.name}\` | ${f.unit} | ${sig(f.stdDev)} | ${f.publishedDecimals} | ${sig(f.publishedQuantum)} | ${f.supportedDecimals} |`,
      );
    }
  }
  lines.push('');

  if (ev.missing.length > 0) {
    lines.push('## Not collected');
    lines.push('');
    lines.push(
      'A classified quantity for which no finite value was produced on every seed. Reported rather than ' +
        'dropped, because a missing series is not a passing one.',
    );
    lines.push('');
    for (const m of ev.missing) lines.push(`- \`${m}\``);
    lines.push('');
  }

  lines.push('## What this sweep does not cover');
  lines.push('');
  for (const u of UNCOVERED) lines.push(`- ${u}`);
  lines.push('');
  lines.push(
    `The sweep is ${SWEEP_SEED_COUNT} draws from one synthetic generator on one machine at one commit. ` +
      'It is a statement about that generator, and it generalises to no field dataset.',
  );
  lines.push('');
  return `${lines.join('\n')}\n`;
}
