/**
 * colorModeProvenance.ts
 *
 * Where the colour on screen came from: the scan, or this viewer.
 *
 * Only `rgb` paints a colour the survey itself recorded. Every other mode maps
 * a scalar or a category through a palette chosen here, so the hue is a
 * rendering decision and carries no radiometric meaning. A height ramp is the
 * clearest case — it is computed from position, and a scan that was never
 * photographed still gets one.
 *
 * That distinction matters beyond the opening view. The viewer picks a derived
 * mode whenever a scan has no readable colour, and a reader who sees a
 * confident spectral image with no qualifier can reasonably take it for
 * measured data. Any surface that shows the active mode is expected to say
 * which of the two it is, so keeping the answer in one predicate stops the
 * recommender and the chip rail from drifting apart on it.
 *
 * Pure — no DOM, no three.js.
 */

import type { ColorMode } from './colorModes';

/**
 * The modes whose colour is the scan's own recorded per-point value.
 *
 * A set of one today. It is written as a set rather than an `=== 'rgb'` test
 * because the question a caller asks is "did the survey measure this colour",
 * and a future scanner-native channel would join it here rather than force
 * every call site to learn a second special case.
 */
const MEASURED_COLOR_MODES: ReadonlySet<ColorMode> = new Set<ColorMode>(['rgb']);

/**
 * True when `mode` paints a palette this viewer applied rather than colour the
 * scan recorded.
 *
 * Unknown modes are reported as derived. The conservative answer is the honest
 * one: a mode this predicate has not been taught about is far more likely to be
 * a new computed overlay than a second measured-colour channel, and over-
 * qualifying a rendering is a smaller error than presenting one as measurement.
 */
export function isDerivedColorMode(mode: ColorMode): boolean {
  return !MEASURED_COLOR_MODES.has(mode);
}
