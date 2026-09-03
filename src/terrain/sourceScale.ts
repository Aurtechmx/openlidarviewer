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
): Float32Array | ReadonlyArray<number> {
  if (!scale.known || scale.metresPerUnit === 1) return positions;
  return scalePositions(positions, scale.metresPerUnit);
}
