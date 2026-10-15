/**
 * lasDataOrigin.ts — choose the local origin a LAS/LAZ load recentres about.
 *
 * Every LAS path decodes `local = (int * scale + offset) - origin` in float64
 * and narrows the residual to Float32. The origin is the floored header
 * minimum, which keeps the residual small only when the header's min/max
 * actually describe the records. A file whose bounds were left at zero (or are
 * stale) while its records carry projected coordinates would put the origin at
 * 0, so Float32 would hold full projected values and lose millimetres.
 *
 * The rule: decode record 0 to world coordinates. When it lies outside the
 * header box by more than one scale step on any axis, or the box itself is not
 * a box (a non-finite value, or a min above its max), the header bounds are not
 * trusted: the origin is the floored record 0 instead, and the load carries
 * {@link HEADER_BOUNDS_UNTRUSTED_WARNING}. A file whose bounds enclose record 0
 * gets exactly the origin it always did. Pure; every path shares it.
 */
import { computeOrigin } from './coordinateBridge';
import type { LasHeader } from './lasHeader';

export const HEADER_BOUNDS_UNTRUSTED_WARNING =
  'Header bounds do not enclose the data; origin taken from the points.';

export type Vec3 = [number, number, number];

export interface LasOriginChoice {
  readonly origin: Vec3;
  /** False when the header min/max cannot stand for the data's extent. */
  readonly boundsTrusted: boolean;
  readonly warning?: string;
}

/** World coordinates of the record whose X/Y/Z integers start at `base`. */
export function recordWorld(
  view: DataView,
  base: number,
  header: Pick<LasHeader, 'scale' | 'offset'>,
): Vec3 {
  return [
    view.getInt32(base, true) * header.scale[0] + header.offset[0],
    view.getInt32(base + 4, true) * header.scale[1] + header.offset[1],
    view.getInt32(base + 8, true) * header.scale[2] + header.offset[2],
  ];
}

/**
 * Record 0 of an uncompressed LAS held in `buffer`, or null when the file
 * declares no points or is too short to hold one record's coordinates.
 */
export function lasRecord0(
  buffer: ArrayBuffer,
  header: Pick<LasHeader, 'scale' | 'offset' | 'pointCount' | 'offsetToPointData'>,
): Vec3 | null {
  if (!(header.pointCount > 0)) return null;
  if (header.offsetToPointData + 12 > buffer.byteLength) return null;
  return recordWorld(new DataView(buffer), header.offsetToPointData, header);
}

function boxIsSane(min: readonly number[], max: readonly number[]): boolean {
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(min[a]) || !Number.isFinite(max[a])) return false;
    if (min[a] > max[a]) return false;
  }
  return true;
}

/**
 * The origin for a load from its header and its first record's world
 * coordinates (null when no record could be read, which keeps the header
 * origin).
 */
export function lasOriginFor(
  header: Pick<LasHeader, 'min' | 'max' | 'scale'>,
  record0: readonly number[] | null,
): LasOriginChoice {
  const sane = boxIsSane(header.min, header.max);
  const usable = record0 !== null && record0.length >= 3 && record0.every((v) => Number.isFinite(v));
  if (!usable) {
    return { origin: computeOrigin(sane ? header.min : [0, 0, 0]), boundsTrusted: sane };
  }
  let enclosed = sane;
  for (let a = 0; enclosed && a < 3; a++) {
    const step = Math.abs(header.scale[a]);
    if (record0[a] < header.min[a] - step || record0[a] > header.max[a] + step) enclosed = false;
  }
  if (enclosed) return { origin: computeOrigin(header.min), boundsTrusted: true };
  return {
    origin: computeOrigin(record0 as number[]),
    boundsTrusted: false,
    warning: HEADER_BOUNDS_UNTRUSTED_WARNING,
  };
}
