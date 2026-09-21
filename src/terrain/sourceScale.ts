/**
 * sourceScale.ts
 *
 * ONE implementation of "put these coordinates in metres".
 *
 * Two seams need it: `spaceMetrics` (which measures an object's envelope volume
 * through `objectMetrics`) and the Object-panel host in `main.ts` (which calls
 * `objectMetrics` directly). The host used to pass RAW source coordinates, so a
 * foot CRS produced foot dimensions, foot spacing, square-foot areas and cubic
 * foot volumes, all printed and exported as metres. Both call sites now scale
 * through the helpers here, so the two can never drift apart.
 */

import type { LinearUnitScale } from '../units/units';

/** Copy `positions` with every component multiplied by `s`. */
export function scalePositions(
  positions: Float32Array | ReadonlyArray<number>,
  s: number,
): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] * s;
  return out;
}

/**
 * Positions expressed in metres when the linear unit is KNOWN, and untouched
 * when it is not.
 *
 * An unknown unit is not a licence to assume metres: the coordinates stay in
 * the file's own units and the presentation layer reads the same
 * {@link LinearUnitScale} to drop every metre, foot and centimetre claim. A
 * known factor of exactly 1 is a declared metre CRS, so no copy is made.
 */
export function positionsInMetres(
  positions: Float32Array | ReadonlyArray<number>,
  scale: LinearUnitScale,
  /**
   * Metres per source unit on the VERTICAL axis, and which component that is.
   *
   * A compound CRS states the two separately (a metre grid over US-survey-foot
   * heights), and one scalar across all three components put the height in the
   * wrong unit: a 2.00 m object stored as 6.562 ft reported 6.56 m, and its
   * envelope volume 3.281x over. Omitted, or equal to the horizontal factor,
   * this behaves exactly as before, which is every single-unit scan.
   */
  vertical?: { readonly metresPerUnit: number; readonly axis: 0 | 1 | 2 },
): Float32Array | ReadonlyArray<number> {
  if (!scale.known) return positions;
  const h = scale.metresPerUnit;
  const v = vertical && Number.isFinite(vertical.metresPerUnit) && vertical.metresPerUnit > 0
    ? vertical.metresPerUnit
    : h;
  if (h === 1 && v === 1) return positions;
  // `!vertical` matters as much as `h === v`: a corrupt horizontal factor makes
  // `h === v` false even with no vertical argument at all, because NaN equals
  // nothing including itself — and the anisotropic branch would then read an
  // axis off `undefined`. Falling back to the single-scalar path keeps the
  // previous answer for that input exactly (a NaN-scaled copy, which is
  // visibly broken rather than silently assuming metres).
  if (h === v || !vertical) return scalePositions(positions, h);
  return scaleAxes(positions, h, v, vertical.axis);
}

/**
 * Copy `positions` with the two horizontal components scaled by `h` and the
 * component at `upAxis` scaled by `v`.
 */
export function scaleAxes(
  positions: Float32Array | ReadonlyArray<number>,
  h: number,
  v: number,
  upAxis: 0 | 1 | 2,
): Float32Array {
  const out = new Float32Array(positions.length);
  for (let i = 0; i < positions.length; i++) out[i] = positions[i] * (i % 3 === upAxis ? v : h);
  return out;
}
