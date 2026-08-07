/**
 * src/render/class/classifierCues.ts
 *
 * Assemble the OPTIONAL per-point cues {@link deriveClassification} can consume
 * from a cloud — RGB (greenness) and LAS return number/count (multi-return ⇒
 * vegetation). Each is included only when it is actually present, so a bare XYZ
 * cloud degrades to geometry-only. Pure: no mutation, no DOM. Kept out of
 * main.ts so both the "Classify (derive)" and "Fill unclassified" call sites
 * share one honest assembly, and so it is unit-testable.
 */

import type { DeriveClassificationOptions } from './deriveClassification';

/** The cloud attributes the classifier can optionally consume. */
export interface ClassifierCueSource {
  readonly colors?: Uint8Array | Uint16Array;
  readonly returnNumber?: Uint8Array;
  readonly returnCount?: Uint8Array;
}

/**
 * Build the cue subset of {@link DeriveClassificationOptions} present on `cloud`.
 * Returns `{}` for a bare XYZ cloud. Return number + count are included only as a
 * PAIR — the multi-return cue needs both, so one without the other is dropped.
 */
export function classifierCues(
  cloud: ClassifierCueSource,
  opts?: { readonly lowVegByGreenness?: boolean },
): DeriveClassificationOptions {
  const hasColors = !!(cloud.colors && cloud.colors.length > 0);
  const hasReturns = !!(
    cloud.returnNumber &&
    cloud.returnCount &&
    cloud.returnNumber.length > 0 &&
    cloud.returnCount.length > 0
  );
  return {
    ...(hasColors ? { colors: cloud.colors } : {}),
    ...(hasReturns
      ? { returnNumber: cloud.returnNumber, returnCount: cloud.returnCount }
      : {}),
    // A colour-only cue: pointless without RGB, so only surfaced when colours
    // are present and the caller opted in (see DeriveClassificationOptions).
    ...(hasColors && opts?.lowVegByGreenness ? { lowVegByGreenness: true } : {}),
  };
}
