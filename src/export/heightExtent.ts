/**
 * heightExtent.ts — the scan's height extent in SOURCE units, for card rows.
 *
 * `adapter.localBoundsAabb()` is measured in the render frame, which the
 * loaders shift by a per-cloud origin so Float32 positions stay precise. Card
 * rows that print elevations must add that origin back on the up axis, the
 * same reconstruction the elevation colorbar performs for its labels, or a
 * tile at −7.86…39.72 m loaded with a −8 m origin reads "14.0 cm … 47.7 m".
 */

import type { ExportContext } from './types';

/** What to call each component in a card row, so "Min Y" says which it is. */
const AXIS_NAME = ['X', 'Y', 'Z'] as const;

export interface SourceHeightExtent {
  readonly min: number;
  readonly max: number;
  readonly range: number;
  /** Axis name of the up axis ("Z" for survey sources, "Y" for a Y-up mesh). */
  readonly axis: 'X' | 'Y' | 'Z';
}

/** Up-axis extent with the frame origin added back, or null when nothing is loaded. */
export function sourceHeightExtent(context: ExportContext): SourceHeightExtent | null {
  const aabb = context.adapter.localBoundsAabb();
  if (!aabb) return null;
  const axis = context.adapter.worldUpAxis();
  const origin = context.adapter.heightOrigin?.() ?? 0;
  const min = aabb[axis] + origin;
  const max = aabb[axis + 3] + origin;
  return { min, max, range: aabb[axis + 3] - aabb[axis], axis: AXIS_NAME[axis] };
}
