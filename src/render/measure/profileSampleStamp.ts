/**
 * profileSampleStamp.ts
 *
 * Writes a profile-sampler result onto its measurement record. Kept apart
 * from the controller so the commit path and the resample path share one
 * stamp without the controller carrying it.
 */
import type { Measurement, ProfileChartSample } from './types';
import type { ProfileSamplerResult } from './MeasureController';
import { buildProfileProvenance } from './profileProvenance';

/**
 * Stamp a profile-sampler result onto a measurement record. Normalises
 * both legacy (raw array) and current ({samples, residentOnly, …}) sampler
 * return shapes; keeps the B4 provenance fields (corridor / percentile, in
 * render units) so the PDF/CSV print the values that actually shaped the
 * estimate. Shared by the commit path and the resample path (B7/B8) so the
 * two can never stamp differently.
 */
export function stampProfileSample(
  m: Measurement,
  result: ProfileChartSample[] | ProfileSamplerResult,
): void {
  const samples = Array.isArray(result) ? result : result.samples;
  const residentOnly = Array.isArray(result) ? false : result.residentOnly;
  if (!samples || samples.length === 0) return;
  m.profileChart = samples;
  // Resident-only reflects the LATEST sample — a re-sample after streaming
  // completes may clear the caveat, so assign rather than only-set-true.
  m.profileChartResidentOnly = residentOnly || undefined;
  // Assigned, not only set: a resample replaces the counts with its own.
  m.profileWithheld = Array.isArray(result) ? undefined : result.withheld;
  m.profileMethod = Array.isArray(result) ? undefined : result.method;
  m.profileCoverageNote = Array.isArray(result) ? undefined : result.coverageNote;
  // Assigned, not only set: a resample's record replaces the last one. The
  // capture time is read here, at the app boundary; the builder never reads
  // the clock.
  m.profileProvenance =
    !Array.isArray(result) && result.provenanceInput
      ? buildProfileProvenance({ ...result.provenanceInput, capturedAt: new Date().toISOString() })
      : undefined;
  if (!Array.isArray(result)) {
    if (
      typeof result.corridorWidth === 'number' &&
      Number.isFinite(result.corridorWidth)
    ) {
      m.profileCorridorWidth = result.corridorWidth;
    }
    if (
      typeof result.groundPercentile === 'number' &&
      Number.isFinite(result.groundPercentile)
    ) {
      m.profileGroundPercentile = result.groundPercentile;
    }
  }
}
