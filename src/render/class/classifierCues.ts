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
import { classifierParamsForFrame } from './classifierFrame';
import { verticalMetresPerUnit, type SpatialContext } from '../../geo/SpatialContext';

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

/**
 * Why the height bands cannot be applied in this frame, or null. The classifier
 * states its height thresholds in metres and restates them in the cloud's
 * vertical unit; a vertical unit the source declares but that cannot be read
 * has no such restatement, and the horizontal unit is not evidence about Z.
 */
export function classifierVerticalRefusal(ctx: SpatialContext): string | null {
  return ctx.verticalScaleState === 'invalid'
    ? 'the height unit of this scan\u2019s coordinate system could not be read, so the metre height bands cannot be applied. Correct the vertical unit of the CRS first.'
    : null;
}

/**
 * The full classifier options for a cloud in its resolved CRS frame: the optional
 * cues plus the physical (metre) parameters restated in the cloud's SOURCE units
 * (see {@link classifierParamsForFrame}). Production MUST pass this so a foot or
 * mixed-unit cloud classifies the same physical terrain as a metre one; passing
 * the bare cues would run the metre defaults against foot coordinates.
 *
 * A frame with an unreadable vertical unit (see {@link classifierVerticalRefusal})
 * must not reach this function: callers refuse first.
 */
export function classifierOptions(
  cloud: ClassifierCueSource,
  ctx: SpatialContext,
  opts?: { readonly lowVegByGreenness?: boolean },
): DeriveClassificationOptions {
  return {
    ...classifierCues(cloud, opts),
    // The derive reads index 2 as height. A Y-up source — which is exactly the
    // raw photogrammetry this feature exists for — needs saying so, or the
    // ground grid is built over the X/height plane and "ground" comes back as
    // the lowest-northing slab. Only an axis the frame actually resolved is
    // passed: 'unknown' leaves the Z-up default, which fails the same way the
    // whole app does on an unresolved frame rather than guessing a rotation.
    upAxis: ctx.upAxis === 'y' ? 'y' : 'z',
    ...classifierParamsForFrame({
      linearUnitToMetres: ctx.linearUnitToMetres,
      verticalUnitToMetres: verticalMetresPerUnit(ctx, 'horizontal') ?? ctx.linearUnitToMetres,
    }),
  };
}
