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

import { isMeasured, type ArtifactRecord, type EnvValue, type Metric } from '../types';

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
  if (!a.volatilityStripped) {
    return `not stripped — ${a.unstrippedReason ?? 'no reason recorded'}`;
  }
  return a.strippedFields.length === 0 ? '(none)' : a.strippedFields.join(', ');
}
