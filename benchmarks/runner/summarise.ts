/**
 * summarise.ts
 *
 * Turn a set of runs' named series into the summary block both suites publish,
 * and the JSON diff both use to say WHERE two runs disagreed.
 *
 * The summariser refuses to summarise a partial series. If ten runs were
 * configured and one of them has no `analysisMs`, the key is reported as
 * unavailable with every run that lacked it named — not summarised over the
 * nine that had one. A median over an unstated subset is the quiet kind of wrong
 * this project's whole benchmark contract is built against: it looks like the
 * number a reader asked for and answers a different question.
 */

import { summariseSeries, type SeriesSummary } from './stats';
import { describeSeries, type RunSeries } from './series';

export interface SeriesBlock {
  readonly key: string;
  readonly meaning: string;
  readonly summary: SeriesSummary;
}

export interface UnavailableSeries {
  readonly key: string;
  readonly meaning: string;
  /** Why the series has no summary, naming the runs that were missing it. */
  readonly reason: string;
}

export interface SummarisedSeries {
  readonly available: readonly SeriesBlock[];
  readonly unavailable: readonly UnavailableSeries[];
}

/**
 * Summarise every series across `runs`, in stable key order.
 *
 * `expectedCount` is passed rather than inferred from the data: the check that
 * matters is "did every configured run contribute", and a series present in
 * zero runs would otherwise be invisible instead of reported missing.
 */
export function summariseRuns(
  runs: readonly RunSeries[],
  expectedCount: number,
): SummarisedSeries {
  const keys = new Set<string>();
  for (const run of runs) {
    for (const key of Object.keys(run.values)) keys.add(key);
    for (const key of Object.keys(run.unavailable)) keys.add(key);
  }

  const available: SeriesBlock[] = [];
  const unavailable: UnavailableSeries[] = [];

  for (const key of [...keys].sort()) {
    const values: number[] = [];
    const missing: string[] = [];
    runs.forEach((run, i) => {
      const value = run.values[key];
      if (typeof value === 'number') values.push(value);
      else missing.push(`run ${i + 1}: ${run.unavailable[key] ?? 'series absent'}`);
    });

    if (missing.length > 0 || values.length !== expectedCount) {
      unavailable.push({
        key,
        meaning: describeSeries(key),
        reason:
          missing.length > 0
            ? `only ${values.length} of ${expectedCount} runs produced this series — ${missing.join('; ')}`
            : `expected ${expectedCount} values, got ${values.length}`,
      });
      continue;
    }
    available.push({ key, meaning: describeSeries(key), summary: summariseSeries(values) });
  }

  return { available, unavailable };
}

/**
 * Every path at which two JSON-shaped values differ, deepest-first ordering
 * irrelevant — what matters is that the report names a PATH.
 *
 * "the complexity output changed" sends a reader back to a 400-line artifact;
 * "complexity.vrm.median: 0.0413 vs 0.0412" is a finding. Capped so a wholesale
 * divergence produces a readable list rather than one line per contour vertex.
 */
export function diffJson(
  a: unknown,
  b: unknown,
  path = '',
  out: string[] = [],
  limit = 25,
): string[] {
  if (out.length >= limit) return out;
  const here = path === '' ? '(root)' : path;

  if (Object.is(a, b)) return out;

  const aIsArray = Array.isArray(a);
  const bIsArray = Array.isArray(b);
  if (aIsArray !== bIsArray) {
    out.push(`${here}: array vs non-array`);
    return out;
  }
  if (aIsArray && bIsArray) {
    if (a.length !== b.length) {
      out.push(`${here}.length: ${a.length} vs ${b.length}`);
      return out;
    }
    for (let i = 0; i < a.length && out.length < limit; i++) {
      diffJson(a[i], b[i], `${path}[${i}]`, out, limit);
    }
    return out;
  }

  const aIsObject = typeof a === 'object' && a !== null;
  const bIsObject = typeof b === 'object' && b !== null;
  if (aIsObject !== bIsObject) {
    out.push(`${here}: ${describe(a)} vs ${describe(b)}`);
    return out;
  }
  if (aIsObject && bIsObject) {
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(bo)])].sort();
    for (const key of keys) {
      if (out.length >= limit) break;
      const child = path === '' ? key : `${path}.${key}`;
      if (!(key in ao)) {
        out.push(`${child}: absent vs present`);
        continue;
      }
      if (!(key in bo)) {
        out.push(`${child}: present vs absent`);
        continue;
      }
      diffJson(ao[key], bo[key], child, out, limit);
    }
    return out;
  }

  out.push(`${here}: ${describe(a)} vs ${describe(b)}`);
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return Array.isArray(value) ? 'array' : typeof value;
}
