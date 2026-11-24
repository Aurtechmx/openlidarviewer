/** supportVerdict.ts: a measurement's support grade and caption as one line of text. */
import type { MeasurementTrust } from '../render/measure/measurementTrust';

/**
 * The panel's support grade and caption for `m` as one line of text, for the
 * outputs with no column for each. It reads the grade the controller stamped on
 * the measurement, the one `getSummaries` hands the panel; null when there is
 * none, so an ungraded measurement says nothing about its support.
 */
export function supportVerdict(m: { readonly trust?: Pick<MeasurementTrust, 'grade' | 'caption'> | null }): string | null {
  return m.trust ? `${m.trust.grade}. ${m.trust.caption}` : null;
}
