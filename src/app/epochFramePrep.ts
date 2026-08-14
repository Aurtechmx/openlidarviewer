/**
 * epochFramePrep.ts — resolve the two epochs' spatial frames for a change
 * comparison.
 *
 * Both epochs' CRS is resolved through {@link CrsService.resolveFor} (detected +
 * any user override), NOT raw file metadata, so a CRS the user corrected in the
 * Inspector drives the comparison too (C5). resolveFor is per-cloud and
 * non-mutating, so both epochs resolve independently even though only one scan
 * is the "active" one. The vertical-comparability verdict (C6) rides along: the
 * Δz math subtracts raw source-unit Z then scales by ONE factor, valid only when
 * both epochs share the vertical scale — a known metre-vs-foot mismatch must be
 * refused rather than reported as a wrong elevation change.
 *
 * Pure w.r.t. the DOM; extracted from `main.ts`'s compareLoadedLayers so the
 * frame resolution is unit-testable and the shell stays a thin orchestrator.
 */

import type { CrsInfo } from '../io/crs';
import type { CrsService } from '../geo/CrsService';
import { spatialContextFrom, type SpatialContext } from '../geo/SpatialContext';
import {
  epochFrameFacts,
  epochFrameOptions,
  epochVerticalScalesComparable,
  type EpochFrameFacts,
  type EpochFrameOptions,
} from '../geo/frameCompatibility';

/** The minimal epoch-cloud shape the frame prep reads. */
export interface EpochFrameInput {
  readonly name: string;
  readonly positions: Float32Array;
  readonly sourceOrigin?: readonly [number, number, number];
  readonly metadata?: { readonly crs?: CrsInfo | null } | null;
}

/** One epoch cloud handed to the aligner / DTM builder (facts spread in). */
export type PreparedEpochCloud = {
  readonly positions: Float32Array;
  readonly origin?: readonly [number, number, number];
} & EpochFrameFacts;

export interface PreparedEpochFrames {
  /** The BEFORE epoch's context — its vertical factor scales the Δz result. */
  readonly ctxA: SpatialContext;
  /** False when the two epochs declare different (known) vertical units. */
  readonly comparable: boolean;
  readonly frames: EpochFrameOptions;
  readonly beforeCloud: PreparedEpochCloud;
  readonly afterCloud: PreparedEpochCloud;
}

/** Compare-panel lines shown when the two epochs declare different vertical units. */
export function epochUnitMismatchLines(header: string): string[] {
  return [
    header,
    'Cannot compare — the two epochs declare different vertical units. ' +
      'Re-export them in a common vertical unit first.',
  ];
}

/** Resolve both epochs' frames (override-aware) and the comparability verdict. */
export function prepareEpochFrames(
  crsService: CrsService,
  a: EpochFrameInput,
  b: EpochFrameInput,
): PreparedEpochFrames {
  const ctxA = spatialContextFrom(
    crsService.resolveFor({ name: a.name, detected: a.metadata?.crs ?? undefined, source: 'las-vlr' }),
  );
  const ctxB = spatialContextFrom(
    crsService.resolveFor({ name: b.name, detected: b.metadata?.crs ?? undefined, source: 'las-vlr' }),
  );
  return {
    ctxA,
    comparable: epochVerticalScalesComparable(ctxA, ctxB),
    frames: epochFrameOptions(ctxA, ctxB),
    beforeCloud: { positions: a.positions, origin: a.sourceOrigin, ...epochFrameFacts(ctxA) },
    afterCloud: { positions: b.positions, origin: b.sourceOrigin, ...epochFrameFacts(ctxB) },
  };
}
