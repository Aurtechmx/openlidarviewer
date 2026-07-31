/**
 * cameraBridge.ts
 *
 * The seam between the viewer's camera state and the pure Context View camera
 * model, plus the one presentational fact the map marker needs: which of the
 * eight compass points a heading falls in.
 *
 * {@link contextCameraFrom} deliberately adds NOTHING. It renames the arguments
 * in the viewer's own words (`cameraX`, `cameraY`, the XY part of the view
 * direction) and hands them straight to {@link mapCameraToContext}, returning
 * its answer — placement or refusal — completely unchanged. A bridge that
 * recomputed any part of the mapping would become a second place for the
 * heading rule to live, and the two would drift; the value of this function is
 * that it is a named, tested place for the hookup to be written down, not that
 * it does anything. In particular the honest-heading promise stays entirely in
 * the camera model: a zero-length view direction still yields `headingDeg:
 * null`, and this module never turns that null into a bearing.
 *
 * {@link headingLabel} is where that null becomes words. It answers 'unknown
 * heading' — never 'N', which would be a fabricated bearing dressed as a fact,
 * since 0° IS north and a camera looking straight down has no heading at all.
 *
 * Pure and deterministic: no I/O, no DOM, no three.js, no proj4. Reprojection
 * is injected by the caller exactly as everywhere else in this layer.
 */

import { mapCameraToContext, type ContextCameraResult } from './cameraModel';
import type { LonLatTransform } from './footprintModel';

/** The eight compass points {@link headingLabel} can name. */
export type CompassPoint = 'N' | 'NE' | 'E' | 'SE' | 'S' | 'SW' | 'W' | 'NW';

/**
 * What {@link headingLabel} says when there is no heading to report.
 *
 * Kept here rather than in `CONTEXT_STATUS` (statusVocabulary.ts): that
 * vocabulary carries the full-sentence explanations of refusals and consent
 * states the Context View panel renders as prose, and this is a two-word inline
 * marker that sits where a compass point would. It is exported so the panel and
 * its tests share one literal instead of each spelling it out; if it ever needs
 * to appear as user-facing prose on more than one surface, it belongs in the
 * shared vocabulary and should move there.
 */
export const UNKNOWN_HEADING_LABEL = 'unknown heading';

/** A compass point, or the honest admission that there is no heading. */
export type HeadingLabel = CompassPoint | typeof UNKNOWN_HEADING_LABEL;

/** Clockwise from north, one entry per 45° sector. */
const COMPASS_POINTS: readonly CompassPoint[] = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Degrees covered by one of the eight sectors. */
const SECTOR_DEGREES = 360 / 8;

/**
 * Place the viewer's camera on the world map.
 *
 * A straight pass-through to {@link mapCameraToContext}: the result is returned
 * unchanged, including its refusal (`{ failed: true }`) when the injected
 * transform cannot place the camera position, and including a `null`
 * `headingDeg` when the view direction has no XY component. Non-finite inputs
 * throw a TypeError from the camera model, which is left to propagate — the
 * caller's bug should surface at the caller, not be quietly converted into a
 * refusal that reads like a data condition.
 *
 * `dirX`/`dirY` are the XY component of the camera's view direction in the
 * layer's native frame; they need not be normalised, and may be zero-length.
 */
export function contextCameraFrom(
  cameraX: number,
  cameraY: number,
  dirX: number,
  dirY: number,
  transform: LonLatTransform,
): ContextCameraResult {
  return mapCameraToContext(cameraX, cameraY, dirX, dirY, transform);
}

/**
 * Name the 45° compass sector a heading falls in, or admit there is none.
 *
 * `null` — the camera model's answer for a degenerate view direction — becomes
 * {@link UNKNOWN_HEADING_LABEL}, never a compass point. Any other value is
 * normalised into [0, 360), so -45 and 675 both read 'NW'; a bearing outside
 * the principal range is unambiguous and not worth refusing.
 *
 * Sector boundaries belong to the clockwise-NEXT point: exactly 22.5° reads
 * 'NE', not 'N'. The tie-break is arbitrary, but it is fixed and stated, so the
 * same bearing always produces the same word.
 *
 * A non-finite number is a caller bug, not a missing heading, and throws a
 * TypeError naming the argument — pass `null` to say "no heading".
 */
export function headingLabel(headingDeg: number | null): HeadingLabel {
  if (headingDeg === null) {
    return UNKNOWN_HEADING_LABEL;
  }
  if (!Number.isFinite(headingDeg)) {
    throw new TypeError('headingLabel: "headingDeg" must be a finite number or null');
  }

  const normalised = ((headingDeg % 360) + 360) % 360;
  const sector = Math.round(normalised / SECTOR_DEGREES) % COMPASS_POINTS.length;
  return COMPASS_POINTS[sector];
}
