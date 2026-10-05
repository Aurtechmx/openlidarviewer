/**
 * lasQuantisation.ts: when a LAS export may keep the source file's own scale
 * and offset instead of re-quantising.
 *
 * A LAS coordinate is `int32 * scale + offset`. The viewer holds each point as
 * a Float32 local position beside a Float64 origin, so an export rebuilds
 * `world = float32(local) + origin` and quantises it. With the source's scale
 * and offset the rebuild is `round((world - offset) / scale)`, which returns
 * the source's integer exactly while the Float32 rounding error stays under
 * half a scale step. That error is half a Float32 spacing at the largest
 * local coordinate, so it grows with the extent: at the 1 mm scale it first
 * reaches half a step at 16384 m, and a coarser scale carries further.
 *
 * The decision is made here, once, as a pure function of the points and the
 * facts about them, so the export can state in the file which path it took.
 *
 * Pure data: no DOM.
 */

import { globalBounds, type GlobalPoints } from './globalPoints';

/** A LAS scale and offset triple. */
export interface Quantisation {
  readonly scale: readonly [number, number, number];
  readonly offset: readonly [number, number, number];
}

/** What the planner knows about the cloud being exported. */
export interface QuantisationContext {
  /** Cloud `sourceFormat`; only `las` and `laz` carry a LAS header. */
  readonly sourceFormat: string;
  /** The Float64 origin the cloud's local positions are relative to. */
  readonly sourceOrigin: readonly [number, number, number];
  /** Why the exported coordinates differ from the source's, or null when they do not. */
  readonly coordinatesChanged: string | null;
}

export type QuantisationStatus = 'kept-exact' | 'kept-approximate' | 'requantised';

export interface QuantisationPlan {
  readonly status: QuantisationStatus;
  /** Scale and offset to hand to the writer, or null for the writer's default. */
  readonly use: Quantisation | null;
  /** The provenance line recording which path was taken. */
  readonly line: string;
  /** Largest reconstruction error in integer steps of the scale; set when a source quantisation was usable. */
  readonly errorSteps?: number;
}

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
/** Double-precision rounding allowance, in multiples of 2^-52 of the quantity involved. */
const DOUBLE_ROUNDING_FACTOR = 8 * 2 ** -52;

/** True when `q` has three finite, positive scales and three finite offsets. */
export function isValidQuantisation(q: Quantisation | null | undefined): q is Quantisation {
  if (!q || q.scale?.length !== 3 || q.offset?.length !== 3) return false;
  for (let a = 0; a < 3; a++) {
    if (!Number.isFinite(q.scale[a]) || q.scale[a] <= 0) return false;
    if (!Number.isFinite(q.offset[a])) return false;
  }
  return true;
}

/** True when every coordinate inside `min..max` quantises into int32 under `q`. */
export function quantisationFitsInt32(
  min: readonly number[],
  max: readonly number[],
  q: Quantisation,
): boolean {
  for (let a = 0; a < 3; a++) {
    const lo = Math.round((min[a] - q.offset[a]) / q.scale[a]);
    const hi = Math.round((max[a] - q.offset[a]) / q.scale[a]);
    if (!(lo >= INT32_MIN && lo <= INT32_MAX && hi >= INT32_MIN && hi <= INT32_MAX)) return false;
  }
  return true;
}

/** Half the Float32 spacing at magnitude `v`: the most rounding to Float32 can move a value of that size. */
export function float32HalfSpacing(v: number): number {
  const m = Math.abs(v);
  if (m === 0) return 0;
  let e = Math.floor(Math.log2(m));
  if (2 ** (e + 1) <= m) e++;
  else if (2 ** e > m) e--;
  return 2 ** (e - 24);
}

/** Largest rebuild error, per axis, in coordinate units, for local coordinates up to `maxLocal` about the origin. */
function rebuildError(maxLocal: number, maxWorld: number, offset: number): number {
  return float32HalfSpacing(maxLocal) + DOUBLE_ROUNDING_FACTOR * Math.max(maxLocal, maxWorld, Math.abs(offset));
}

/** True when every point sits within `tolerance` integer steps of a grid node on every axis. */
function pointsOnGrid(g: GlobalPoints, q: Quantisation, tolerance: readonly number[]): boolean {
  const axes = [g.x, g.y, g.z];
  for (let a = 0; a < 3; a++) {
    const v = axes[a];
    const s = q.scale[a];
    const o = q.offset[a];
    const tol = tolerance[a];
    for (let i = 0; i < g.count; i++) {
      const t = (v[i] - o) / s;
      if (Math.abs(t - Math.round(t)) > tol) return false;
    }
  }
  return true;
}

const fmt = (t: readonly number[]): string => t.map((n) => String(n)).join(' ');

function requantised(reason: string): QuantisationPlan {
  return { status: 'requantised', use: null, line: `Scale/offset: re-quantised (${reason}).` };
}

/**
 * Decide whether the export keeps the source scale and offset.
 *
 * Kept only when the source is LAS or LAZ, its header values are valid, the
 * coordinates are the source's own, every one fits int32, and (in the exact
 * case) every point lies on the source grid. Beyond the extent where Float32
 * can return the source integer, the scale and offset are still kept but the
 * line says the integer records may differ, and by how many steps.
 */
export function planQuantisation(
  g: GlobalPoints,
  source: Quantisation | null | undefined,
  ctx: QuantisationContext,
): QuantisationPlan {
  if (ctx.sourceFormat !== 'las' && ctx.sourceFormat !== 'laz') return requantised('the source is not LAS or LAZ');
  if (!source) return requantised('the source scale and offset are not recorded for this cloud');
  if (!isValidQuantisation(source)) return requantised('the source header scale or offset is not valid');
  if (ctx.coordinatesChanged) return requantised(ctx.coordinatesChanged);
  if (g.count === 0) return requantised('there are no points');

  const { min, max } = globalBounds(g);
  if (![...min, ...max].every(Number.isFinite)) return requantised('a coordinate is not finite');
  if (!quantisationFitsInt32(min, max, source)) {
    return requantised('a coordinate does not fit the source scale and offset in int32');
  }

  const err: number[] = [];
  const steps: number[] = [];
  for (let a = 0; a < 3; a++) {
    const maxLocal = Math.max(Math.abs(min[a] - ctx.sourceOrigin[a]), Math.abs(max[a] - ctx.sourceOrigin[a]));
    const maxWorld = Math.max(Math.abs(min[a]), Math.abs(max[a]));
    err[a] = rebuildError(maxLocal, maxWorld, source.offset[a]);
    steps[a] = err[a] / source.scale[a];
  }
  const worst = Math.max(...steps);
  const where = `scale ${fmt(source.scale)}, offset ${fmt(source.offset)}`;
  const use: Quantisation = { scale: [...source.scale], offset: [...source.offset] };

  if (worst < 0.5) {
    if (!pointsOnGrid(g, source, steps.map((s) => s + 1e-6))) {
      return requantised('the coordinates do not lie on the source scale and offset grid');
    }
    return {
      status: 'kept-exact',
      use,
      errorSteps: worst,
      line: `Scale/offset: kept from source (${where}). Each exported X, Y and Z integer record equals the source's.`,
    };
  }
  const wholeSteps = Math.floor(worst + 0.5);
  return {
    status: 'kept-approximate',
    use,
    errorSteps: worst,
    line:
      `Scale/offset: kept from source (${where}). The extent exceeds what Float32 positions resolve at this scale, ` +
      `so an integer record can differ from the source's by up to ${wholeSteps} step${wholeSteps === 1 ? '' : 's'}.`,
  };
}
