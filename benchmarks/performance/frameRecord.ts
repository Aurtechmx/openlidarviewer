/**
 * frameRecord.ts
 *
 * The record a performance run writes, and the rules that keep it honest.
 *
 * Two rules matter more than the schema.
 *
 * A missing measurement is `null`, never `0`. Zero is a legitimate reading for
 * a long-task total or a discarded-node count, so a harness that writes `0`
 * for "the browser did not expose this" makes an absent measurement
 * indistinguishable from a good one. Every optional field here is
 * `number | null` for that reason, and `validateRecord` refuses a record whose
 * unavailable fields were filled with zeros.
 *
 * A comparison names its environment. Frame times from different machines,
 * browsers or backends are not comparable, and pooling them produces a figure
 * that describes nothing. `comparable()` refuses the pair rather than
 * returning a number nobody should use.
 *
 * Deliberately no capture code here. This is the part that can be tested
 * without a browser, and the part a reviewer has to trust.
 */

/** Where a run happened. Two records are comparable only when these match. */
export interface RunEnvironment {
  readonly browser: string;
  readonly os: string;
  readonly architecture: string;
  /** The backend actually used, not the one requested. */
  readonly backend: 'webgpu' | 'webgl2';
  /** Adapter string, or why it could not be read. */
  readonly adapter: string | 'unavailable';
}

/** One measured run against one dataset on one code revision. */
export interface FrameRunRecord {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly datasetId: string;
  readonly label: string;
  readonly environment: RunEnvironment;
  /** Cold and warm runs are summarised separately, never pooled. */
  readonly coldOrWarm: 'cold' | 'warm';
  /** Raw frame durations in ms, retained so a summary can be re-derived. */
  readonly frameSamples: readonly number[];
  /** Total long-task time in ms, or null where the browser exposes none. */
  readonly longTaskMs: number | null;
  /** Time to the first committed node, or null when not measured. */
  readonly firstRenderMs: number | null;
  /** Time until refinement settled, or null when not measured. */
  readonly settledMs: number | null;
}

/** A run summarised. Percentiles are re-derived from `frameSamples`. */
export interface FrameSummary {
  readonly samples: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly iqr: number;
}

/** Why a record was refused. */
export type RecordProblem =
  | 'no-frame-samples'
  | 'negative-frame-sample'
  | 'zero-for-unavailable'
  | 'missing-revision';

/**
 * Refuse a record that cannot support a comparison.
 *
 * `zero-for-unavailable` is the one worth explaining: a harness that cannot
 * read long-task time and writes `0` is asserting a perfect result. The field
 * is nullable precisely so that "not measured" has its own value, and a run
 * with no frame samples at all cannot honestly report a zero long-task total.
 */
export function validateRecord(rec: FrameRunRecord): RecordProblem[] {
  const problems: RecordProblem[] = [];
  if (!rec.revision) problems.push('missing-revision');
  if (rec.frameSamples.length === 0) problems.push('no-frame-samples');
  if (rec.frameSamples.some((f) => f < 0)) problems.push('negative-frame-sample');
  if (rec.frameSamples.length === 0 && rec.longTaskMs === 0) {
    problems.push('zero-for-unavailable');
  }
  return problems;
}

/** Nearest-rank percentile over an ascending copy. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.min(idx, sorted.length - 1)];
}

/** Summarise a run. Median and IQR lead, because frame times are not normal. */
export function summarise(rec: FrameRunRecord): FrameSummary {
  const sorted = [...rec.frameSamples].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    iqr: percentile(sorted, 75) - percentile(sorted, 25),
  };
}

/** Whether two runs describe the same conditions closely enough to compare. */
export function comparable(a: FrameRunRecord, b: FrameRunRecord): boolean {
  const ea = a.environment;
  const eb = b.environment;
  return (
    a.datasetId === b.datasetId &&
    a.coldOrWarm === b.coldOrWarm &&
    ea.browser === eb.browser &&
    ea.os === eb.os &&
    ea.architecture === eb.architecture &&
    ea.backend === eb.backend
  );
}

/** The verdict of one baseline-to-candidate comparison. */
export interface FrameComparison {
  readonly status: 'improved' | 'unchanged' | 'regressed' | 'incomparable' | 'invalid';
  readonly reason?: string;
  readonly baseline?: FrameSummary;
  readonly candidate?: FrameSummary;
  readonly p95DeltaMs?: number;
  readonly p95DeltaPct?: number;
}

/**
 * Fraction of p95 a run may move before it counts as changed.
 *
 * Frozen before any measurement, so the threshold cannot be chosen after
 * seeing which side of it a result fell.
 */
export const P95_TOLERANCE = 0.05;

/**
 * Compare a candidate against a baseline on p95 frame time.
 *
 * p95 rather than the mean because a hitch is what a user notices, and a mean
 * hides it. An incomparable pair returns `incomparable` rather than a number:
 * a comparison across machines or backends is not a weaker result, it is a
 * meaningless one.
 */
export function compareRuns(
  baseline: FrameRunRecord,
  candidate: FrameRunRecord,
): FrameComparison {
  const problems = [...validateRecord(baseline), ...validateRecord(candidate)];
  if (problems.length > 0) {
    return { status: 'invalid', reason: problems.join(', ') };
  }
  if (!comparable(baseline, candidate)) {
    return {
      status: 'incomparable',
      reason: 'dataset, thermal state, browser, os, architecture or backend differ',
    };
  }
  const b = summarise(baseline);
  const c = summarise(candidate);
  const deltaMs = c.p95 - b.p95;
  const deltaPct = b.p95 === 0 ? 0 : deltaMs / b.p95;
  const status =
    Math.abs(deltaPct) <= P95_TOLERANCE
      ? 'unchanged'
      : deltaPct < 0
        ? 'improved'
        : 'regressed';
  return { status, baseline: b, candidate: c, p95DeltaMs: deltaMs, p95DeltaPct: deltaPct };
}
