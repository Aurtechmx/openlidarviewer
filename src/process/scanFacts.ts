/**
 * scanFacts.ts — normalise loose scan signals into the ScanFacts the capability
 * evaluator reasons over, fail-closed.
 *
 * The shell assembles scan facts from several existing sources (scan report,
 * CRS resolver, streaming coverage, classification presence), each of which may
 * be missing or not-yet-known. This is the one place that turns those loose
 * signals into a clean ScanFacts, and it defaults every unknown to the SAFE
 * side: an unknown CRS is null (not assumed metre), an unknown streaming
 * coverage is resident-only (not full), ground is trusted only when
 * classification actually carries it. So a fact the shell failed to supply can
 * only make the capability model MORE conservative, never falsely enable a
 * product. Pure and worker-safe — no live objects.
 */

import type { CrsInfo } from '../io/crs';
import type { ScanFacts, Coverage, ClassPresence, ClassificationProvenance } from './ProcessPlan';

/** Loose, possibly-incomplete signals from the shell. Every field is optional. */
export interface RawScanSignals {
  readonly kind?: 'static' | 'streaming';
  readonly coverage?: Coverage;
  readonly crs?: CrsInfo | null;
  readonly pointCount?: number;
  readonly hasRgb?: boolean;
  readonly hasIntensity?: boolean;
  readonly hasGpsTime?: boolean;
  readonly hasReturnNumber?: boolean;
  readonly hasPointSourceId?: boolean;
  readonly classification?: ClassPresence;
  /** Where the classification came from. Omitted ⇒ `producer` (the historical
   *  assumption); the live shell supplies it explicitly so OLV-derived ground
   *  is not mistaken for surveyed ground. */
  readonly classificationProvenance?: ClassificationProvenance;
  readonly groundClassified?: boolean;
  readonly hasBuildingClass?: boolean;
  readonly medianSpacing?: number;
}

/**
 * Turn loose signals into ScanFacts with fail-closed defaults.
 *
 * - `kind` defaults to `static` (a whole-file cloud).
 * - `coverage`: a static cloud is `full`; a streaming cloud whose coverage the
 *   shell did not report is `resident-only` (the honest floor — we cannot claim
 *   to have seen more than the resident set). An explicit coverage is kept.
 * - `crs` defaults to null — an unknown CRS is never assumed to be anything.
 * - feature flags default to false; `classification` defaults to `none`.
 * - `groundClassified` is true only when it is explicitly true AND some
 *   classification is present, so "trusted ground" can never sit on an
 *   unclassified cloud.
 */
export function deriveScanFacts(raw: RawScanSignals): ScanFacts {
  const kind = raw.kind ?? 'static';
  const coverage: Coverage = raw.coverage ?? (kind === 'streaming' ? 'resident-only' : 'full');
  const classification: ClassPresence = raw.classification ?? 'none';
  // Provenance: none when unclassified, else the shell's word, defaulting to
  // `producer` when unstated (backward-compatible with pre-provenance callers).
  const classificationProvenance: ClassificationProvenance =
    classification === 'none' ? 'none' : (raw.classificationProvenance ?? 'producer');
  // Only PRODUCER classes are trusted for a `ready` verdict: OLV-derived or
  // manually-edited ground/buildings are estimates, so they set neither flag and
  // fall to `review` in the capability model (never falsely GROUND_TRUSTED).
  const trusted = classificationProvenance === 'producer';
  const groundClassified = raw.groundClassified === true && classification !== 'none' && trusted;
  const facts: ScanFacts = {
    kind,
    coverage,
    crs: raw.crs ?? null,
    pointCount: Number.isFinite(raw.pointCount) ? Math.max(0, raw.pointCount as number) : 0,
    hasRgb: raw.hasRgb === true,
    hasIntensity: raw.hasIntensity === true,
    hasGpsTime: raw.hasGpsTime === true,
    hasReturnNumber: raw.hasReturnNumber === true,
    hasPointSourceId: raw.hasPointSourceId === true,
    classification,
    classificationProvenance,
    groundClassified,
    hasBuildingClass: raw.hasBuildingClass === true && trusted,
  };
  return raw.medianSpacing !== undefined && Number.isFinite(raw.medianSpacing)
    ? { ...facts, medianSpacing: raw.medianSpacing }
    : facts;
}
