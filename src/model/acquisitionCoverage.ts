/**
 * acquisitionCoverage.ts — was a world-space position INTERROGATED by any
 * scanner setup, or did nobody ever look that way?
 *
 * A terrain raster records a void as one undifferentiated absence: a cell no
 * point landed in. The acquisition grid behind an organized cloud already
 * separates two situations that absence merges:
 *
 *   INTERROGATED    a setup's grid addresses that direction, and the cell it
 *                   addresses is one the source described. A NO_RETURN cell is
 *                   the interesting member: the grid fired that way and nothing
 *                   came back.
 *   UNINTERROGATED  no setup's grid addresses that direction at all, or the one
 *                   that does was never decoded and never supplied. Nobody
 *                   looked, or this session never read what was looked at.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT.
 *
 * This module proves RAY COVERAGE, NOT SURFACE ABSENCE. A verdict of
 * "interrogated" says a scanner setup's acquisition grid addresses that
 * direction and the source described the cell. It says NOTHING about why no
 * return came back from it. A no return can be dark asphalt, glass, water, a
 * mirrored surface, or a distance past the instrument. This code names none of
 * those and no caller may name them on its behalf.
 *
 * OCCLUSION IS NOT HANDLED. A ray can be stopped by geometry nearer the setup
 * than the position asked about, so "inside the grid extent" is an UPPER BOUND
 * on what was actually seen. A position behind a wall reads interrogated here
 * while the wall, not the position, is what the grid observed. Any claim built
 * on this must carry that bound.
 *
 * A DERIVED PARAMETERIZATION, NOT A DECLARED ONE. `OrganizedRangeFrame` stores
 * cell state, record identity and range; it stores no angular start or step,
 * because no supported source hands one over in a form worth trusting. The
 * per-setup angular extent here is therefore FITTED from the frame's own valid
 * cells, whose directions come from the display records they produced. Where a
 * frame supplies too few distinct rows or columns to fit, the answer is
 * `indeterminate` and never `uninterrogated`.
 *
 * ALLOCATION. Every array sized here is sized from `cellState.length`, the
 * bytes that actually exist, and a frame whose declared `width * height`
 * disagrees with that length is refused rather than sized from the
 * declaration. Clouds with no acquisition grid allocate nothing at all:
 * `buildAcquisitionCoverage` returns `null` before it touches a buffer.
 *
 * Pure and DOM-free, so it runs under Node and inside a worker.
 */

import {
  CellState,
  cellIndexOf,
  type CellStateValue,
  type OrganizedRangeFrame,
  type OrganizedRangeSet,
} from './OrganizedRange';

/** Which source-frame axis points up. Matches the terrain pipeline's convention. */
export type UpAxis = 'y' | 'z';

/**
 * The answer for one world position.
 *
 * `indeterminate` is a first-class third answer, not a failure. A cloud with no
 * acquisition grid, or a setup whose extent cannot be fitted, has said nothing
 * about whether anyone looked, and reporting that as `uninterrogated` would
 * invent evidence.
 */
export type CoverageVerdict = 'interrogated' | 'uninterrogated' | 'indeterminate';

/** Where a record sits in the same world frame the queried positions use. */
export type RecordPosition = (record: number) => readonly [number, number, number] | null;

export interface AcquisitionCoverageOptions {
  readonly recordPosition: RecordPosition;
  /** Default `'z'`. */
  readonly upAxis?: UpAxis;
}

/** One setup's fitted angular extent, ready to answer queries. */
interface SetupCoverage {
  readonly frame: OrganizedRangeFrame;
  readonly originH1: number;
  readonly originH2: number;
  readonly originV: number;
  /** Azimuth of column 0, and radians per column. */
  readonly azimuth0: number;
  readonly azimuthStep: number;
  /** Polar angle of row 0, and radians per row. */
  readonly polar0: number;
  readonly polarStep: number;
}

export interface AcquisitionCoverageIndex {
  readonly setups: readonly SetupCoverage[];
  /** Frames present that could not be fitted. A query they might have answered reads indeterminate. */
  readonly unfittedFrames: number;
}

/** Cell states that mean the source described the cell, so a ray addressed it. */
function isDescribed(state: CellStateValue): boolean {
  // NOT_DECODED is a decision this session took, not an observation, so it can
  // never count as interrogation. SOURCE_RECORD_MISSING is a cell the grid
  // declared and the file never supplied, which is equally silent about the
  // scene. Everything else was described by the source.
  return state !== CellState.NOT_DECODED && state !== CellState.SOURCE_RECORD_MISSING;
}

function project(
  x: number,
  y: number,
  z: number,
  upAxis: UpAxis,
): { h1: number; h2: number; v: number } {
  return upAxis === 'y' ? { h1: x, h2: z, v: y } : { h1: x, h2: y, v: z };
}

/** Least squares slope and intercept of `y` against `x`, or null when degenerate. */
function fitLine(
  xs: readonly number[],
  ys: readonly number[],
): { readonly intercept: number; readonly slope: number } | null {
  const n = xs.length;
  if (n < 2) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / n;
  const my = sy / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - mx;
    sxx += dx * dx;
    sxy += dx * (ys[i]! - my);
  }
  if (!(Math.abs(sxx) > 0)) return null;
  const slope = sxy / sxx;
  if (!Number.isFinite(slope) || slope === 0) return null;
  const intercept = my - slope * mx;
  if (!Number.isFinite(intercept)) return null;
  return { intercept, slope };
}

/** Fit one frame's angular extent from the cells it actually decoded. */
function fitFrame(
  frame: OrganizedRangeFrame,
  options: AcquisitionCoverageOptions,
): SetupCoverage | null {
  const pose = frame.acquisitionPose;
  if (!pose) return null;
  const width = frame.width;
  const height = frame.height;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 2 || height < 2) return null;
  // The declaration is never trusted to size anything. `cellState` is the data
  // that exists; a grid header claiming more cells than the file delivered has
  // already cost this project three oversized allocations.
  if (frame.cellState.length !== width * height) return null;

  const upAxis = options.upAxis ?? 'z';
  const [ox, oy, oz] = pose.worldTranslation;
  const origin = project(ox, oy, oz, upAxis);
  if (!Number.isFinite(origin.h1) || !Number.isFinite(origin.h2) || !Number.isFinite(origin.v)) {
    return null;
  }

  // Sized from the grid the buffer proves, one accumulator per column and row.
  const colCos = new Float64Array(width);
  const colSin = new Float64Array(width);
  const colN = new Uint32Array(width);
  const rowPolar = new Float64Array(height);
  const rowN = new Uint32Array(height);

  for (let row = 0; row < height; row++) {
    for (let column = 0; column < width; column++) {
      const idx = cellIndexOf(row, column, width);
      if (frame.cellState[idx] !== CellState.VALID_RETURN) continue;
      const record = frame.cellToRecord[idx]!;
      if (record < 0) continue;
      const p = options.recordPosition(record);
      if (!p) continue;
      const q = project(p[0], p[1], p[2], upAxis);
      const dh1 = q.h1 - origin.h1;
      const dh2 = q.h2 - origin.h2;
      const dv = q.v - origin.v;
      const len = Math.hypot(dh1, dh2, dv);
      if (!(len > 0) || !Number.isFinite(len)) continue;
      const azimuth = Math.atan2(dh2, dh1);
      colCos[column] += Math.cos(azimuth);
      colSin[column] += Math.sin(azimuth);
      colN[column]!++;
      rowPolar[row] += Math.acos(Math.min(1, Math.max(-1, dv / len)));
      rowN[row]!++;
    }
  }

  // Azimuth is circular, so a column's representative angle is the direction of
  // its summed unit vector, not the mean of its atan2 values. The columns are
  // then unwrapped in increasing order so a grid crossing the atan2 branch cut
  // fits the same straight line as one that does not.
  const colX: number[] = [];
  const colY: number[] = [];
  let previous = Number.NaN;
  for (let column = 0; column < width; column++) {
    if (colN[column] === 0) continue;
    let azimuth = Math.atan2(colSin[column]!, colCos[column]!);
    if (Number.isFinite(previous)) {
      azimuth += 2 * Math.PI * Math.round((previous - azimuth) / (2 * Math.PI));
    }
    previous = azimuth;
    colX.push(column);
    colY.push(azimuth);
  }

  const rowX: number[] = [];
  const rowY: number[] = [];
  for (let row = 0; row < height; row++) {
    if (rowN[row] === 0) continue;
    rowX.push(row);
    rowY.push(rowPolar[row]! / rowN[row]!);
  }

  const azimuthFit = fitLine(colX, colY);
  const polarFit = fitLine(rowX, rowY);
  if (!azimuthFit || !polarFit) return null;

  return {
    frame,
    originH1: origin.h1,
    originH2: origin.h2,
    originV: origin.v,
    azimuth0: azimuthFit.intercept,
    azimuthStep: azimuthFit.slope,
    polar0: polarFit.intercept,
    polarStep: polarFit.slope,
  };
}

/**
 * Build the queryable index for a cloud's acquisition grids.
 *
 * Returns `null` when there is no grid to read. An ordinary cloud (a LAS, say)
 * therefore pays one property read and allocates nothing.
 */
export function buildAcquisitionCoverage(
  set: OrganizedRangeSet | undefined,
  options: AcquisitionCoverageOptions,
): AcquisitionCoverageIndex | null {
  if (!set || set.frames.length === 0) return null;
  const setups: SetupCoverage[] = [];
  let unfittedFrames = 0;
  for (const frame of set.frames) {
    const fitted = fitFrame(frame, options);
    if (fitted) setups.push(fitted);
    else unfittedFrames++;
  }
  return { setups, unfittedFrames };
}

/** What one setup says about one world position. */
function verdictForSetup(
  setup: SetupCoverage,
  x: number,
  y: number,
  z: number,
  upAxis: UpAxis,
): CoverageVerdict {
  const q = project(x, y, z, upAxis);
  const dh1 = q.h1 - setup.originH1;
  const dh2 = q.h2 - setup.originH2;
  const dv = q.v - setup.originV;
  const len = Math.hypot(dh1, dh2, dv);
  // A position AT the setup origin has no direction, so this setup cannot say.
  if (!(len > 0) || !Number.isFinite(len)) return 'indeterminate';

  const frame = setup.frame;
  const polar = Math.acos(Math.min(1, Math.max(-1, dv / len)));
  const row = Math.round((polar - setup.polar0) / setup.polarStep);
  if (!Number.isFinite(row) || row < 0 || row >= frame.height) return 'uninterrogated';

  // Bring the queried azimuth onto the same branch the fit lives on before
  // inverting it, using the grid's own centre column as the reference.
  const centre = setup.azimuth0 + setup.azimuthStep * ((frame.width - 1) / 2);
  let azimuth = Math.atan2(dh2, dh1);
  azimuth += 2 * Math.PI * Math.round((centre - azimuth) / (2 * Math.PI));
  const column = Math.round((azimuth - setup.azimuth0) / setup.azimuthStep);
  if (!Number.isFinite(column) || column < 0 || column >= frame.width) return 'uninterrogated';

  const state = frame.cellState[cellIndexOf(row, column, frame.width)] as CellStateValue;
  return isDescribed(state) ? 'interrogated' : 'uninterrogated';
}

/**
 * Was this world position interrogated by ANY setup in the index?
 *
 * One setup saying yes settles it, which is why `interrogated` short-circuits.
 * Otherwise an indeterminate setup outranks a uninterrogated one: a setup that
 * could not be fitted has not shown that nobody looked.
 *
 * Remember the two limits stated at the top of this file: the answer is ray
 * coverage, not surface absence, and occlusion is not modelled.
 */
export function coverageAtWorldPoint(
  index: AcquisitionCoverageIndex | null,
  x: number,
  y: number,
  z: number,
  upAxis: UpAxis = 'z',
): CoverageVerdict {
  if (!index) return 'indeterminate';
  let sawUninterrogated = false;
  for (const setup of index.setups) {
    const verdict = verdictForSetup(setup, x, y, z, upAxis);
    if (verdict === 'interrogated') return 'interrogated';
    if (verdict === 'uninterrogated') sawUninterrogated = true;
  }
  if (index.unfittedFrames > 0) return 'indeterminate';
  return sawUninterrogated ? 'uninterrogated' : 'indeterminate';
}
