/**
 * acceptance.ts
 *
 * The comparison a continuity capability has to survive before it is switched
 * on, and the rule that reads it.
 *
 * Written before any of these numbers exist, which is the only time it can be
 * written honestly. A rule composed after the measurements is a rule composed
 * to fit them, and the programme's own line is that a feature does not graduate
 * because it is visually interesting.
 *
 * So the rule refuses rather than judges. A candidate that improves everything
 * graduates on its own. A candidate that regresses anything is refused, and the
 * refusal names what regressed, because whether a trade is worth making is a
 * decision a person makes with the cost in front of them rather than something
 * a threshold can settle. Nothing here will ever return "graduate" for a
 * capability that made something worse.
 *
 * A missing measurement is not a pass. Most of these need a device, and a
 * comparison with holes in it is undecided rather than clean, on the same
 * reasoning that an empty frame reports no reconstruction share rather than a
 * share of zero.
 *
 * Validation only.
 */

/** Which way is better for a given metric. */
export type Direction = 'lower-is-better' | 'higher-is-better';

/** One metric in the comparison. */
export interface MetricSpec {
  readonly key: string;
  readonly label: string;
  readonly direction: Direction;
  readonly unit: string;
}

/**
 * The comparison the programme asks for. Fixed here so a later run cannot
 * quietly drop the column it did badly on.
 */
export const ACCEPTANCE_METRICS: readonly MetricSpec[] = [
  { key: 'gpuFrameMs', label: 'GPU frame', direction: 'lower-is-better', unit: 'ms' },
  { key: 'attributeBytes', label: 'GPU attributes', direction: 'lower-is-better', unit: 'B' },
  { key: 'submittedPoints', label: 'submitted points', direction: 'lower-is-better', unit: '' },
  { key: 'directCoverage', label: 'direct coverage', direction: 'higher-is-better', unit: '' },
  { key: 'finalCoverage', label: 'final coverage', direction: 'higher-is-better', unit: '' },
  { key: 'temporalVariance', label: 'temporal variance', direction: 'lower-is-better', unit: '' },
  { key: 'edgeLeakage', label: 'edge leakage', direction: 'lower-is-better', unit: '' },
  { key: 'settleMs', label: 'settle', direction: 'lower-is-better', unit: 'ms' },
];

/** A measured pair, or nulls where nothing was measured. */
export type Samples = Readonly<Record<string, { baseline: number | null; candidate: number | null }>>;

/** How one metric moved. */
export interface Row {
  readonly spec: MetricSpec;
  readonly baseline: number | null;
  readonly candidate: number | null;
  /** Candidate minus baseline, or null when either is missing. */
  readonly delta: number | null;
  /** Which way the change went, judged by the metric's own direction. */
  readonly movement: 'better' | 'worse' | 'unchanged' | 'unmeasured';
}

/** The verdict a comparison supports. */
export type Verdict = 'graduate' | 'refuse' | 'undecided';

/** Build the comparison rows for a sample set. */
export function compare(samples: Samples, specs: readonly MetricSpec[] = ACCEPTANCE_METRICS): Row[] {
  return specs.map((spec) => {
    const s = samples[spec.key];
    const baseline = s?.baseline ?? null;
    const candidate = s?.candidate ?? null;
    if (baseline === null || candidate === null || !Number.isFinite(baseline) || !Number.isFinite(candidate)) {
      return { spec, baseline, candidate, delta: null, movement: 'unmeasured' as const };
    }
    const delta = candidate - baseline;
    if (delta === 0) return { spec, baseline, candidate, delta, movement: 'unchanged' as const };
    const better = spec.direction === 'lower-is-better' ? delta < 0 : delta > 0;
    return { spec, baseline, candidate, delta, movement: better ? ('better' as const) : ('worse' as const) };
  });
}

/** The metrics a comparison could not decide. */
export function unmeasured(rows: readonly Row[]): string[] {
  return rows.filter((r) => r.movement === 'unmeasured').map((r) => r.spec.key);
}

/** The metrics a candidate made worse. */
export function regressions(rows: readonly Row[]): string[] {
  return rows.filter((r) => r.movement === 'worse').map((r) => r.spec.key);
}

/**
 * Read the comparison.
 *
 * Undecided outranks everything: a hole in the evidence is not a result, and a
 * candidate cannot be refused for a number nobody took either.
 */
export function verdict(rows: readonly Row[]): Verdict {
  if (rows.length === 0) return 'undecided';
  if (unmeasured(rows).length > 0) return 'undecided';
  return regressions(rows).length > 0 ? 'refuse' : 'graduate';
}

/** Render the comparison as the table the programme asks for. */
export function table(rows: readonly Row[]): string {
  const cell = (v: number | null, unit: string): string =>
    v === null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(3)}${unit ? ` ${unit}` : ''}`;
  const lines = ['| Metric | Baseline | Candidate | Delta |', '|---|---:|---:|---:|'];
  for (const r of rows) {
    const delta =
      r.delta === null ? '—' : `${r.delta > 0 ? '+' : ''}${Number.isInteger(r.delta) ? r.delta : r.delta.toFixed(3)}`;
    lines.push(`| ${r.spec.label} | ${cell(r.baseline, r.spec.unit)} | ${cell(r.candidate, r.spec.unit)} | ${delta} |`);
  }
  return lines.join('\n');
}
