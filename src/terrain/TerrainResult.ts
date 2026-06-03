/**
 * TerrainResult.ts
 *
 * Result helpers — the analyser produces these; the cache reads them;
 * the UI badges them. Pure data.
 */

import type {
  TerrainAnalysisResult,
  TerrainCoverageMeta,
  TerrainCoverageMode,
  TerrainQualitySummary,
} from './TerrainContracts';

/**
 * Build the honesty fields every result must carry. Confidence is
 * computed as a coverage-weighted average — full coverage with a
 * dense walk reads as 100; sampled / resident-only is reduced.
 */
export function makeCoverageMeta(args: {
  readonly coverage: TerrainCoverageMode;
  readonly sourcePointCount: number;
  readonly analyzedPointCount: number;
  readonly warnings?: ReadonlyArray<string>;
  /** Optional analyser-supplied confidence override. */
  readonly confidenceOverride?: number;
}): TerrainCoverageMeta {
  const baseFraction =
    args.sourcePointCount > 0
      ? Math.max(0, Math.min(1, args.analyzedPointCount / args.sourcePointCount))
      : 0;
  const coverageMultiplier =
    args.coverage === 'full' ? 1 : args.coverage === 'resident-only' ? 0.65 : 0.5;
  const fromFraction = Math.round(baseFraction * 100 * coverageMultiplier);
  const confidence =
    args.confidenceOverride !== undefined
      ? Math.max(0, Math.min(100, args.confidenceOverride))
      : fromFraction;
  // Use a Set for the auto-caveat dedupe so a caller-supplied
  // warning that happens to share a prefix with our auto-caveat
  // doesn't accidentally suppress the auto-caveat. The exact
  // auto-caveat string is the dedupe key.
  const RESIDENT_CAVEAT =
    'Resident-node analysis only — may refine as streaming loads.';
  const SAMPLED_CAVEAT = 'Sampled — coverage less than full cloud.';
  const seen = new Set<string>();
  const warnings: string[] = [];
  const pushIfNew = (w: string): void => {
    if (seen.has(w)) return;
    seen.add(w);
    warnings.push(w);
  };
  if (args.warnings) for (const w of args.warnings) pushIfNew(w);
  if (args.coverage === 'resident-only') pushIfNew(RESIDENT_CAVEAT);
  if (args.coverage === 'sampled') pushIfNew(SAMPLED_CAVEAT);
  return {
    coverage: args.coverage,
    sourcePointCount: args.sourcePointCount,
    analyzedPointCount: args.analyzedPointCount,
    confidence,
    warnings,
  };
}

/** Compact summary for a quality badge in the UI. */
export function summariseQuality(meta: TerrainCoverageMeta): TerrainQualitySummary {
  return {
    // v0.3.10 honesty pass — `meta.confidence` is now optional
    // (undefined when no engine pass has produced a measurement). The
    // legacy TerrainQualitySummary contract requires a number, so we
    // map `undefined` to `0`. Downstream callers should treat
    // `0` here as "no signal" rather than "low confidence" — the new
    // canonical "no signal" surface is the `confidenceBand` →
    // `'unknown'` branch, used by the Dataset Intelligence card.
    confidence: meta.confidence ?? 0,
    coverage: meta.coverage,
    residentOnly: meta.coverage === 'resident-only',
  };
}

/**
 * Type-guard for "is this result honest?" — required fields present
 * AND the payload object exists. A hand-edited or deserialized
 * result missing the payload would otherwise pass the guard but
 * crash the first consumer that reads a metric array.
 */
export function isHonestTerrainResult(value: unknown): value is TerrainAnalysisResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.coverage === 'string' &&
    typeof v.sourcePointCount === 'number' &&
    typeof v.analyzedPointCount === 'number' &&
    typeof v.confidence === 'number' &&
    Array.isArray(v.warnings) &&
    typeof v.payload === 'object' &&
    v.payload !== null
  );
}
