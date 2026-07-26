/**
 * metricText.ts
 *
 * The one place a metric is turned into text, shared by all four reporters.
 *
 * It exists so the honesty contract cannot be broken in three formats out of
 * four: an unavailable metric is rendered as the WORD "unavailable" followed by
 * its reason, never as '', '-', '0' or 'n/a'. Each of those reads to a human as
 * a measurement — a dash in a timing column is taken as "negligible" — and once
 * a table is in a paper, the distinction is unrecoverable.
 *
 * Numbers are printed with `String(value)`: no rounding, no thousands
 * separators, no locale. A reporter that rounds is deciding how precise the
 * measurement was, which is the measurer's call, not the formatter's.
 */

import {
  isMeasured,
  type ArtifactRecord,
  type BenchmarkEnvironment,
  type EnvValue,
  type Metric,
} from '../types';

/** The literal that must appear wherever a metric was not measured. */
export const UNAVAILABLE_LABEL = 'unavailable';

/** `12.5 ms`, or `unavailable — <reason>`. */
export function formatMetric(m: Metric): string {
  return isMeasured(m) ? `${m.value} ${m.unit}` : `${UNAVAILABLE_LABEL} — ${m.reason}`;
}

/** The value column on its own: a number, or the word — never blank. */
export function metricValueCell(m: Metric): string {
  return isMeasured(m) ? String(m.value) : UNAVAILABLE_LABEL;
}

/** The unit column. Empty for an unavailable metric, which genuinely has none. */
export function metricUnitCell(m: Metric): string {
  return isMeasured(m) ? m.unit : '';
}

/** The reason column. Empty for a measured metric, which needs no excuse. */
export function metricReasonCell(m: Metric): string {
  return isMeasured(m) ? '' : m.reason;
}

/**
 * Every environment field, in report order, with its human label.
 *
 * The typed `Record<keyof BenchmarkEnvironment, string>` is the point: the HTML
 * and Markdown reporters used to hard-code their own arrays, so adding a
 * provenance field put it in the JSON and the CSV and silently dropped it from
 * the other two — with no test failing. A provenance field that is present in
 * the machine-readable output and missing from the HTML attached to a paper is
 * the worst version of that. Now a new field fails the typecheck here until it
 * is labelled, and both reporters pick it up from this one list.
 */
export const ENVIRONMENT_LABELS: Record<keyof BenchmarkEnvironment, string> = {
  releaseVersion: 'release version',
  gitCommitShort: 'git commit',
  gitCommitFull: 'git commit (full)',
  gitDirty: 'working tree',
  os: 'OS',
  cpuModel: 'CPU',
  arch: 'arch',
  nodeVersion: 'Node',
};

/** The label map as ordered pairs, ready for a reporter to render. */
export function environmentRows(
  env: BenchmarkEnvironment,
): ReadonlyArray<readonly [string, EnvValue]> {
  const keys = Object.keys(ENVIRONMENT_LABELS) as (keyof BenchmarkEnvironment)[];
  return keys.map((k) => [ENVIRONMENT_LABELS[k], env[k]] as const);
}

/** An environment field: the captured string, or the word plus its reason. */
export function formatEnvValue(e: EnvValue): string {
  return e.status === 'captured' ? e.value : `${UNAVAILABLE_LABEL} — ${e.reason}`;
}

/**
 * What a hash comparison of this artifact deliberately ignores.
 *
 * The three cases are genuinely different and must not collapse into one blank
 * cell: fields were excluded, nothing needed excluding, or no strip could run
 * at all. Only the last carries a caveat about the hash itself, so it is the
 * one that must never render as an empty list.
 */
export function describeHashExclusions(a: ArtifactRecord): string {
  // No fallback for a missing reason: `ArtifactRecord` makes an unexplained gap
  // a compile error, so there is no unexplained case left to invent text for.
  if (!a.volatilityStripped) return `not stripped — ${a.unstrippedReason}`;
  return a.strippedFields.length === 0 ? '(none)' : a.strippedFields.join(', ');
}
