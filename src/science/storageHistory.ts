/**
 * storageHistory.ts: the storage-grid test behind the scan report's "Storage history" row.
 *
 * A LAS or LAZ file stores X = offset + scale * N with N an integer. When the coordinates were
 * rounded onto another grid before they were written (a coarser step, another unit, a rotated
 * frame), that grid can remain as a lattice in the integers. `diagnostics/latticeForensics.ts`
 * tests a candidate grid for that lattice; this module decides which candidates to test for an
 * open file, recovers the stored integers from the loaded positions, runs the test and reduces
 * the result to one outcome the report can print.
 *
 * Candidates, in the file's own horizontal frame:
 *   - same-frame refinements of the storage step: 2, 5, 10, 20, 50, 100 and 1000 times the
 *     scale (1000 only when that is at most 1 m), tested whatever the linear unit;
 *   - with a known linear unit that is not the metre: 0.001, 0.01 and 0.1 m grids;
 *   - with a known linear unit within 1 % of the metre: 0.01 ft and 0.1 ft grids with the
 *     grid axes turned 0, +-1 ... +-5 whole degrees from the file axes (international foot),
 *     and the same two steps in US survey feet turned 0 degrees. At the window sizes used
 *     here the two foot definitions (2 ppm apart) are not told apart, so both report "ft".
 *
 * A grid turned by an angle not in the sweep is not found: the peak moves off the predicted
 * wavevector by |k| times the angle error, and the windows resolve about 1 / (2 w) cycles per
 * storage unit. The sweep is a set of exact candidates, not a search.
 *
 * Budget: at most 12 000 points in at least 20 windows and 300 null wavevectors, so the test
 * costs about the same whatever the file size once the integers are recovered. The empirical
 * p-value of one peak cannot fall below 1 / 301; the Fisher-combined value and the Bonferroni
 * correction over the tested candidates follow from the library.
 *
 * Pure: no DOM, no three, no proj4. Runs unchanged in a worker and in Node tests.
 */

import {
  decodeHistories,
  packWindows,
  type CandidateHistory,
  type CandidateResult,
  type Mat2,
} from '../diagnostics/latticeForensics';
import type { StorageHistoryOutcome, StorageHistoryUnit } from '../analysis/storageHistoryRow';
import { UNIT_FACTORS } from '../units/units';

/** The registered method id of this test. */
export const STORAGE_HISTORY_METHOD_ID = 'olv.storage.grid-history';

/** Fewer points than this and no window test is attempted. */
export const MIN_POINTS = 2_000;
/** At most this many points enter the window test. */
export const MAX_POINTS = 12_000;
/** Windows holding fewer points are dropped; the library default. */
export const MIN_WINDOW_POINTS = 40;
/** The test needs at least this many windows after packing. */
export const MIN_WINDOWS = 20;
/** Random wavevectors scored for the empirical null. */
export const N_NULL = 300;
/** Whole degrees either side of zero the foot grids are swept over. */
export const ROTATION_SWEEP_DEG = 5;
/** Points beyond this are strided before the integers are recovered. */
export const MAX_RECOVERED_POINTS = 2_000_000;
/** The largest distance from an integer a recovered stored coordinate may show. */
export const MAX_RESIDUAL = 0.25;

const M_PER_INTL_FT = UNIT_FACTORS.M_PER_FT;
const M_PER_US_FT = UNIT_FACTORS.M_PER_US_FT;
const SAME_FRAME_MULTIPLES = [2, 5, 10, 20, 50, 100, 1000] as const;
const METRE_STEPS = [0.001, 0.01, 0.1] as const;
const FOOT_STEPS = [0.01, 0.1] as const;

/** What the main thread hands over: the loaded XY, the frame they were decoded in, and the file's grid. */
export interface StorageHistoryRequest {
  /** Interleaved local X, Y (Float32, relative to `sourceOrigin`) for the points to analyse. */
  readonly xy: Float32Array;
  readonly sourceOrigin: readonly [number, number];
  /** The LAS header scale and offset on X and Y. */
  readonly scale: readonly [number, number];
  readonly offset: readonly [number, number];
  /** File linear unit in metres, or null when the unit is not established. */
  readonly unitToMetres: number | null;
}

/** One candidate grid with the words the row needs beside the library's description. */
interface Candidate {
  readonly history: CandidateHistory;
  readonly unit: StorageHistoryUnit;
  /** Step in the reported unit (metres, feet or file units). */
  readonly stepShown: number;
  readonly rotationDeg: number;
}

const rotation = (deg: number): Mat2 => {
  const t = (deg * Math.PI) / 180;
  const c = Math.cos(t), s = Math.sin(t);
  return [[c, -s], [s, c]];
};

/** True when `u` metres per file unit is within 1 % of a metre. */
function unitIsMetre(u: number): boolean {
  return Math.abs(u - 1) < 0.01;
}

/** The unit a same-frame step is shown in: the file's own unit when it is a metre or a foot. */
function sameFrameUnit(u: number | null): StorageHistoryUnit {
  if (u === null) return 'source';
  if (unitIsMetre(u)) return 'm';
  if (Math.abs(u / M_PER_INTL_FT - 1) < 0.01) return 'ft';
  return 'source';
}

/**
 * The candidate grids for a file stored at `scale` file units per integer step, in file units.
 * `unitToMetres` null means the linear unit is not established: only the unit-free same-frame
 * refinements are tested then.
 */
export function storageHistoryCandidates(scale: number, unitToMetres: number | null): Candidate[] {
  const out: Candidate[] = [];
  const u = unitToMetres;
  for (const m of SAME_FRAME_MULTIPLES) {
    const step = m * scale;
    if (m === 1000 && u !== null && step * u > 1) continue;
    // One label for every refinement: the library reports the coarsest supported step of a
    // label, so points on a 0.01 grid, which also sit on the nested 0.005 and 0.002 grids,
    // read as 0.01.
    out.push({
      history: { label: 'same frame', step, jacobian: rotation(0), sameFrame: true },
      unit: sameFrameUnit(u),
      stepShown: step,
      rotationDeg: 0,
    });
  }
  if (u === null) return out;
  if (!unitIsMetre(u)) {
    for (const s of METRE_STEPS) {
      out.push({ history: { label: 'metre grid', step: s / u, jacobian: rotation(0) }, unit: 'm', stepShown: s, rotationDeg: 0 });
    }
    return out;
  }
  for (let deg = -ROTATION_SWEEP_DEG; deg <= ROTATION_SWEEP_DEG; deg++) {
    for (const s of FOOT_STEPS) {
      out.push({
        history: { label: `international foot grid ${deg}`, step: (s * M_PER_INTL_FT) / u, jacobian: rotation(deg) },
        unit: 'ft',
        stepShown: s,
        rotationDeg: deg,
      });
    }
  }
  for (const s of FOOT_STEPS) {
    out.push({
      history: { label: 'US survey foot grid 0', step: (s * M_PER_US_FT) / u, jacobian: rotation(0) },
      unit: 'ft',
      stepShown: s,
      rotationDeg: 0,
    });
  }
  return out;
}

/** Recovered stored integers, or the reason they could not be recovered. */
export type RecoveredIntegers =
  | { readonly ok: true; readonly nx: Int32Array; readonly ny: Int32Array; readonly maxResidual: number }
  | { readonly ok: false; readonly reason: string };

/**
 * N = round((local + origin - offset) / scale) per axis, refused when any recovered value
 * sits further than `MAX_RESIDUAL` from an integer or outside the 32-bit range the file could
 * have stored. A Float32 position whose magnitude exceeds about 2^22 storage steps carries
 * more than a quarter step of representation error and fails this check, as does a cloud whose
 * points were moved or merged after decoding.
 */
export function recoverStoredIntegers(req: StorageHistoryRequest): RecoveredIntegers {
  const n = req.xy.length >> 1;
  const nx = new Int32Array(n), ny = new Int32Array(n);
  const ox = req.sourceOrigin[0] - req.offset[0], oy = req.sourceOrigin[1] - req.offset[1];
  const sx = req.scale[0], sy = req.scale[1];
  let worst = 0;
  for (let i = 0; i < n; i++) {
    const vx = (req.xy[2 * i] + ox) / sx, vy = (req.xy[2 * i + 1] + oy) / sy;
    const rx = Math.round(vx), ry = Math.round(vy);
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || Math.abs(rx) > 0x7fffffff || Math.abs(ry) > 0x7fffffff) {
      return { ok: false, reason: 'stored integers not recoverable from the loaded positions' };
    }
    const d = Math.max(Math.abs(vx - rx), Math.abs(vy - ry));
    if (d > worst) worst = d;
    nx[i] = rx; ny[i] = ry;
  }
  if (worst > MAX_RESIDUAL) return { ok: false, reason: 'stored integers not recoverable from the loaded positions' };
  return { ok: true, nx, ny, maxResidual: worst };
}

/**
 * The window edge, in storage units, that puts about `MAX_POINTS / MIN_WINDOWS` points in a
 * window over a uniform spread, and never more than a 6 x 6 grid over the footprint.
 */
export function windowUnitsFor(nx: ArrayLike<number>, ny: ArrayLike<number>): number | null {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < nx.length; i++) {
    const x = nx[i], y = ny[i];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const area = (maxX - minX) * (maxY - minY);
  if (!(area > 0)) return null;
  const perWindow = Math.min(MAX_POINTS / MIN_WINDOWS, nx.length / 36);
  const w = Math.sqrt((perWindow * area) / nx.length);
  return Number.isFinite(w) && w >= 1 ? Math.ceil(w) : null;
}

function notTested(reason: string): StorageHistoryOutcome {
  return { kind: 'not-tested', reason };
}

/** Run the whole test for one request. Synchronous; about one to two seconds at the budget above. */
export function runStorageHistory(req: StorageHistoryRequest): StorageHistoryOutcome {
  const n = req.xy.length >> 1;
  if (n < MIN_POINTS) return notTested('too few points');
  if (req.scale[0] !== req.scale[1] || !(req.scale[0] > 0)) return notTested('unequal X and Y scale factors');
  const recovered = recoverStoredIntegers(req);
  if (!recovered.ok) return notTested(recovered.reason);
  const windowUnits = windowUnitsFor(recovered.nx, recovered.ny);
  if (windowUnits === null) return notTested('degenerate footprint');
  const pack = packWindows(recovered.nx, recovered.ny, windowUnits, { minPoints: MIN_WINDOW_POINTS, maxPoints: MAX_POINTS });
  if (pack.counts.length < MIN_WINDOWS) return notTested('points too sparse for the window test');
  const candidates = storageHistoryCandidates(req.scale[0], req.unitToMetres);
  const results = decodeHistories(pack, req.scale[0], candidates.map((c) => c.history), { nNull: N_NULL });
  return reduceOutcome(candidates, results, pack.counts.length, pack.lx.length);
}

/** One outcome from the per-candidate results: the most specific supported grid with the smallest corrected p. */
export function reduceOutcome(
  candidates: readonly Candidate[],
  results: readonly CandidateResult[],
  windows: number,
  points: number,
): StorageHistoryOutcome {
  const tested = results.filter((r) => r.status === 'tested').length;
  if (tested === 0) return notTested('no candidate grid is testable at this storage step');
  let best: { c: Candidate; r: CandidateResult } | null = null;
  let supportedCount = 0;
  results.forEach((r, i) => {
    if (!r.mostSpecific) return;
    supportedCount++;
    if (!best || r.pBonferroni < best.r.pBonferroni) best = { c: candidates[i], r };
  });
  if (best === null) return { kind: 'none', candidatesTested: tested, windows, points };
  const { c, r } = best as { c: Candidate; r: CandidateResult };
  return {
    kind: 'supported',
    step: c.stepShown,
    unit: c.unit,
    rotationDeg: c.rotationDeg,
    pJoint: r.pJoint,
    pBonferroni: r.pBonferroni,
    amplitudeRatio: r.amplitudeRatio,
    candidatesTested: tested,
    supportedCount,
    windows,
    points,
  };
}
