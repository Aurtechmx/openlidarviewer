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
import { sceneUpAxisPolicy, type SourceFormat } from '../io/sniffFormat';
import { datasetIdentity, type CrsService } from '../geo/CrsService';
import { elevationWorkflowRefusal, spatialContextFrom, type SpatialContext } from '../geo/SpatialContext';
import { truncationOf, type Truncation } from '../io/truncation';
import {
  compareSpatialFrames,
  epochFrameFacts,
  epochFrameOptions,
  epochVerticalScalesComparable,
  type EpochFrameFacts,
  type EpochFrameOptions,
} from '../geo/frameCompatibility';

/** The minimal epoch-cloud shape the frame prep reads. */
export interface EpochFrameInput {
  readonly name: string;
  /** The loader's format tag, for the up-axis contract. */
  readonly sourceFormat?: SourceFormat;
  readonly positions: Float32Array;
  readonly sourceOrigin?: readonly [number, number, number];
  readonly metadata?: { readonly crs?: CrsInfo | null } | null;
  /** Source total and bounds, so a remembered CRS override is verified against this epoch. */
  readonly sourceDeclaredPointCount?: number;
  readonly pointCount?: number;
  readonly bounds?: () => { readonly min: readonly number[]; readonly max: readonly number[] };
}

/** One epoch cloud handed to the aligner / DTM builder (facts spread in). */
export type PreparedEpochCloud = {
  readonly positions: Float32Array;
  readonly origin?: readonly [number, number, number];
} & EpochFrameFacts;

export interface PreparedEpochFrames {
  /** The BEFORE epoch's context — its vertical factor scales the Δz result. */
  readonly ctxA: SpatialContext;
  /** The AFTER epoch's context. */
  readonly ctxB: SpatialContext;
  /** False when the epochs cannot be honestly compared; `reason` says why. */
  readonly comparable: boolean;
  /** Why the comparison was refused, or null when it may proceed. */
  readonly reason: EpochRefusal | null;
  /** The frame refusal message when `reason` is `'frame'`, else null. */
  readonly frameRefusal: string | null;
  readonly frames: EpochFrameOptions;
  readonly beforeCloud: PreparedEpochCloud;
  readonly afterCloud: PreparedEpochCloud;
}

/** Why a comparison was refused. */
export type EpochRefusal = 'vertical-unit' | 'up-axis' | 'frame';

/**
 * Whether BOTH epochs are Z-up, which the change pipeline requires.
 *
 * `compareEpochs` reads X/Y as the ground plane and Z as elevation, and says so
 * (`verticalAxis: 'z'`, hard-coded). The terrain-analysis path earns that
 * assumption — `Viewer.gatherTerrainPositions` runs up-axis detection and
 * rotates a Y-up mesh into the canonical frame first. The compare path never
 * did: it handed the raw buffers straight in, so a Y-up PLY/OBJ/glTF pair
 * produced a ground filter, a DTM and a change surface built from one
 * horizontal axis and the elevation axis. The output looked entirely ordinary.
 *
 * This refuses rather than rotating. Canonicalising here would mean rotating
 * each buffer AND its origin, and carrying that through the aligner and the
 * ASCII raster — a change that has to be validated, not assumed, and one this
 * release does not make. Mesh formats carry no mandated up-axis, so a mesh on
 * either side is enough to withhold the comparison.
 */
function epochUpAxisContractHolds(a: EpochFrameInput, b: EpochFrameInput): boolean {
  const formats = [a.sourceFormat, b.sourceFormat].filter(
    (f): f is SourceFormat => f !== undefined,
  );
  // An unstated format is not evidence of Z-up.
  if (formats.length !== 2) return false;
  return sceneUpAxisPolicy(formats, false)?.kind === 'z';
}

/** Compare-panel lines shown when the two epochs cannot be compared. */
export function epochUnitMismatchLines(header: string, reason: EpochRefusal = 'vertical-unit', frameReason?: string): string[] {
  if (reason === 'frame') {
    return [header, `Cannot compare — ${frameReason ?? 'an epoch is in a frame elevation workflows refuse.'}`];
  }
  if (reason === 'up-axis') {
    return [
      header,
      'Cannot compare — the change pipeline measures elevation on Z, and at least one ' +
        'of these epochs is a mesh format with no declared up-axis. Comparing them ' +
        'could difference a horizontal axis and report it as height change. ' +
        'Re-export both epochs in a Z-up survey format first.',
    ];
  }
  return [
    header,
    // Covers all three refusals the vertical-scale check now makes: a proven
    // mismatch, a scale resolved on one side only, and a declared but
    // degenerate factor. Naming only the mismatch would have described the
    // other two wrongly.
    'Cannot compare — the two epochs are not on a common vertical scale: they ' +
      'declare different vertical units, or only one of them states a usable ' +
      'unit at all. Declare the missing frame (a CRS override in the Inspector ' +
      'names the unit), or re-export both in one declared vertical unit.',
  ];
}

/**
 * Two epochs in named local frames with different names are in different
 * frames: a difference between them would measure the frames, not the ground.
 */
function localFrameRefusal(a: SpatialContext, b: SpatialContext): string | null {
  if (!a.localFrameName || !b.localFrameName) return null;
  if (!compareSpatialFrames(a, b).horizontalFrameConflict) return null;
  return `the epochs are in different local frames (${a.localFrameName} vs ${b.localFrameName}).`;
}

/** Resolve both epochs' frames (override-aware) and the comparability verdict. */
export function prepareEpochFrames(
  crsService: CrsService,
  a: EpochFrameInput,
  b: EpochFrameInput,
): PreparedEpochFrames {
  const ctxA = spatialContextFrom(
    crsService.resolveFor({ name: a.name, detected: a.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(a) }),
  );
  const ctxB = spatialContextFrom(
    crsService.resolveFor({ name: b.name, detected: b.metadata?.crs ?? undefined, source: 'las-vlr', identity: datasetIdentity(b) }),
  );
  // A depth-down, geocentric or Web Mercator epoch is refused before anything
  // else: d = (after − before) would read a depth decrease (a physical rise) as
  // a loss, and the other two have no ground-metre plane to grid on.
  const frameRefusal =
    elevationWorkflowRefusal(ctxA) ?? elevationWorkflowRefusal(ctxB) ?? localFrameRefusal(ctxA, ctxB);
  const unitsOk = epochVerticalScalesComparable(ctxA, ctxB);
  const axisOk = epochUpAxisContractHolds(a, b);
  let reason: EpochRefusal | null = null;
  if (frameRefusal !== null) reason = 'frame';
  else if (!unitsOk) reason = 'vertical-unit';
  else if (!axisOk) reason = 'up-axis';
  return {
    ctxA,
    ctxB,
    comparable: reason === null,
    reason,
    frameRefusal,
    frames: epochFrameOptions(ctxA, ctxB),
    beforeCloud: { positions: a.positions, origin: a.sourceOrigin, ...epochFrameFacts(ctxA) },
    afterCloud: { positions: b.positions, origin: b.sourceOrigin, ...epochFrameFacts(ctxB) },
  };
}

/** An epoch as the compare suggestion reads it: frame inputs plus any truncation. */
export type CompareSuggestionEpoch = EpochFrameInput & {
  readonly metadata?: { readonly crs?: CrsInfo | null; readonly truncation?: Truncation } | null;
};

/**
 * Whether the app may suggest a before/after comparison for the loaded scans:
 * exactly two, both present.
 *
 * Stricter than the compare run itself, which still runs on request and states
 * its caveats: a suggestion is only made when the comparison
 * {@link prepareEpochFrames} would allow is also planimetrically sound by
 * {@link compareSpatialFrames} (both CRS declared and the same, both linear
 * units known and equal, not geographic), and neither scan is a truncated load.
 */
export function compareSuggestionAllowed(
  crsService: CrsService,
  clouds: readonly (CompareSuggestionEpoch | undefined)[],
): boolean {
  const [a, b] = clouds;
  if (clouds.length !== 2 || !a || !b) return false;
  if (truncationOf(a) !== null || truncationOf(b) !== null) return false;
  const prepared = prepareEpochFrames(crsService, a, b);
  if (!prepared.comparable) return false;
  return compareSpatialFrames(prepared.ctxA, prepared.ctxB).planimetricComparable;
}
