/**
 * drawPrecisionLod.ts: certified level-of-detail selection for one draw, the
 * single-node case of the controller in "Per-Draw Precision Bounds for
 * Large-Coordinate Rendering in WebGL2 and WebGPU".
 *
 * Level k replaces the stored points by one representative per occupied cell
 * of a grid with cell size q_k = q_0 * 2^k, at the cell centre, stored in
 * Float32. Level 0 is the stored points themselves. The rule picks the
 * coarsest level with
 *
 *     sigma * H_k + B_k <= tau      (faithful rounding)
 *
 * where
 *   - H_k bounds the distance, both ways, between the stored points and the
 *     level's stored representatives: sqrt(3) * q / 2 from a point to its cell
 *     centre, plus the Float32 narrowing of that centre, ||rho_k||. Every point
 *     is that close to its cell's representative, and every representative to
 *     a point of its cell. Level 0 has H_0 = 0.
 *   - sigma bounds how far the model-view stretches a distance (1 for a rigid
 *     view), so sigma * H_k bounds the same distance in eye space.
 *   - B_k is the checker's Euclidean bound on the eye-space error of the
 *     level's own draw. Cell centres reach at most q/2 past the data, so the
 *     level's extent is taken as r_0 + q/2, which can only enlarge B_k.
 * By the triangle inequality every stored point then lies within tau of the
 * computed eye position of some drawn representative, and every drawn
 * representative within tau of some stored point.
 *
 * What this module does not do: it selects and certifies a level; nothing
 * here draws it. One node is the whole draw; there are no camera regions and
 * no multi-node selection.
 *
 * Pure: no DOM, no three.js.
 */

import { float32Spacing } from '../geo/inMemoryPrecision';
import {
  evaluateDrawPrecision,
  type DrawPrecisionDiagnostic,
  type DrawPrecisionUnit,
  type DrawPrecisionView,
  type DrawTile,
} from './drawPrecision';

export const DRAW_PRECISION_LOD_METHOD_ID = 'olv.render.draw-precision-lod';

/** The base cell size, in metres: level k has cells of 1 mm * 2^k. */
export const LOD_BASE_CELL_METRES = 0.001;

/** Bytes a drawn point's position takes (three Float32 values). */
const POSITION_BYTES = 12;

/** Coarsest level ever considered: a 1 mm * 2^40 cell is far past any scan. */
const MAX_LEVEL = 40;

export type LodState = 'CERTIFIED' | 'NONE' | 'UNGRADED' | 'NOT_TESTED';

export interface LodSelection {
  /** CERTIFIED: a level fits tau. NONE: not even the stored points do. */
  readonly state: LodState;
  /** 0 is the stored points; k > 0 has cells of 1 mm * 2^k. */
  readonly level: number;
  readonly cellSizeMetres: number | null;
  /** sigma * H_k in metres. */
  readonly hMetres: number | null;
  /** B_k in metres, faithful rounding. */
  readonly bMetres: number | null;
  readonly tauMetres: number;
  /** The model-view's stretch bound, sigma. */
  readonly stretch: number;
  readonly pointsFull: number;
  /** Representatives drawn at this level; null when not counted. */
  readonly pointsKept: number | null;
  readonly bytesFull: number;
  readonly bytesKept: number | null;
  /** Wall time of the selection, and of the count when one ran. */
  readonly selectionMs: number;
  readonly reason: string | null;
}

/**
 * An upper bound on the largest stretch of the model-view's linear part, from
 * Gershgorin's theorem on A^T A. Exactly 1 for a rigid view, up to rounding,
 * which the factor covers.
 */
export function stretchBound(modelView64: ArrayLike<number>): number {
  const m = modelView64;
  // Column-major: column c is (m[4c], m[4c + 1], m[4c + 2]).
  const col = [0, 1, 2].map((c) => [m[4 * c]!, m[4 * c + 1]!, m[4 * c + 2]!]);
  let worst = 0;
  for (let i = 0; i < 3; i++) {
    let row = 0;
    for (let j = 0; j < 3; j++) {
      row += Math.abs(col[i]![0]! * col[j]![0]! + col[i]![1]! * col[j]![1]! + col[i]![2]! * col[j]![2]!);
    }
    worst = Math.max(worst, row);
  }
  return Math.sqrt(worst) * (1 + 1e-12);
}

/** The tile of a level: the stored extent grown by half a cell, and its Float32 narrowing. */
export function levelTile(base: DrawTile, q: number): DrawTile {
  const r = base.r.map((v) => v + q / 2) as [number, number, number];
  const rho = r.map((v) => float32Spacing(v) / 2) as [number, number, number];
  return { r, rho, basis: 'narrowing-bound' };
}

/** H_k in source units: a point to its cell centre, plus the centre's Float32 narrowing. */
export function levelH(tile: DrawTile, q: number): number {
  return (Math.sqrt(3) * q) / 2 + Math.hypot(tile.rho[0], tile.rho[1], tile.rho[2]);
}

const countCache = new WeakMap<Float32Array, Map<number, number | null>>();

/**
 * Occupied cells of size q among the stored points, or null when the grid is
 * too large to key exactly in a double. Cached per buffer and cell size.
 */
export function occupiedCells(positions: Float32Array, q: number): number | null {
  let byQ = countCache.get(positions);
  if (!byQ) countCache.set(positions, (byQ = new Map()));
  if (byQ.has(q)) return byQ.get(q)!;
  const n = Math.floor(positions.length / 3);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      const c = Math.floor(positions[3 * i + a]! / q);
      if (c < lo[a]!) lo[a] = c;
      if (c > hi[a]!) hi[a] = c;
    }
  }
  const dy = hi[1]! - lo[1]! + 1;
  const dz = hi[2]! - lo[2]! + 1;
  let result: number | null = null;
  if (n === 0) result = 0;
  else if ((hi[0]! - lo[0]! + 1) * dy * dz <= Number.MAX_SAFE_INTEGER) {
    const keys = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const cx = Math.floor(positions[3 * i]! / q) - lo[0]!;
      const cy = Math.floor(positions[3 * i + 1]! / q) - lo[1]!;
      const cz = Math.floor(positions[3 * i + 2]! / q) - lo[2]!;
      keys[i] = (cx * dy + cy) * dz + cz;
    }
    keys.sort();
    result = 1;
    for (let i = 1; i < n; i++) if (keys[i] !== keys[i - 1]) result++;
  }
  byQ.set(q, result);
  return result;
}

function bound(tile: DrawTile, view: DrawPrecisionView, unit: DrawPrecisionUnit, tau: number): DrawPrecisionDiagnostic {
  return evaluateDrawPrecision(tile, view, unit, tau, 'faithful');
}

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Select the coarsest level that fits `tauMetres` for this draw. `count`
 * also counts the level's representatives, for the bytes it would draw; the
 * selection itself needs no pass over the points.
 */
export function selectCertifiedLevel(
  positions: Float32Array,
  base: DrawTile,
  view: DrawPrecisionView,
  unit: DrawPrecisionUnit,
  tauMetres: number,
  options: { readonly count?: boolean } = {},
): LodSelection {
  const t0 = clock();
  const pointsFull = Math.floor(positions.length / 3);
  const stretch = stretchBound(view.modelView64);
  const empty = {
    level: 0, cellSizeMetres: null, hMetres: null, tauMetres, stretch,
    pointsFull, pointsKept: null, bytesFull: pointsFull * POSITION_BYTES, bytesKept: null,
  };
  const d0 = bound(base, view, unit, tauMetres);
  if (d0.state === 'NOT_TESTED' || d0.state === 'UNGRADED') {
    return { ...empty, state: d0.state, bMetres: null, selectionMs: clock() - t0, reason: d0.reason };
  }
  const f = unit.linearUnitToMetres;
  const b0 = d0.boundMetres!;
  if (b0 > tauMetres) {
    return {
      ...empty, state: 'NONE', bMetres: b0, hMetres: 0, selectionMs: clock() - t0,
      reason: 'the stored points themselves are not within the limit at this view',
    };
  }
  // Every level needs sigma * sqrt(3) * q / 2 <= tau - B_0 at least, since
  // B_k >= B_0: start at the coarsest level that could pass and step finer.
  const q0 = LOD_BASE_CELL_METRES / f;
  const qMax = (2 * (tauMetres - b0)) / (Math.sqrt(3) * stretch * f);
  let level = 0;
  let bk = b0;
  let hk = 0;
  for (let k = Math.min(MAX_LEVEL, Math.floor(Math.log2(qMax / q0))); k >= 1; k--) {
    const q = q0 * 2 ** k;
    const tile = levelTile(base, q);
    const d = bound(tile, view, unit, tauMetres);
    if (d.boundMetres == null) continue;
    const h = stretch * levelH(tile, q) * f;
    if (h + d.boundMetres <= tauMetres) {
      level = k;
      bk = d.boundMetres;
      hk = h;
      break;
    }
  }
  const q = level > 0 ? q0 * 2 ** level : null;
  const kept = level === 0 ? pointsFull : options.count ? occupiedCells(positions, q!) : null;
  return {
    ...empty,
    state: 'CERTIFIED',
    level,
    cellSizeMetres: q !== null ? q * f : null,
    hMetres: hk,
    bMetres: bk,
    pointsKept: kept,
    bytesKept: kept !== null ? kept * POSITION_BYTES : null,
    selectionMs: clock() - t0,
    reason: null,
  };
}
