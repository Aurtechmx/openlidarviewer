/**
 * mainChannel.ts — the longest flow path of a catchment, its profile and the
 * slopes read from it.
 *
 * The main channel is the D8 path from the cell with the longest flow length
 * to the outlet (ties go to the lowest cell index), followed downstream with
 * `receiver`. `cells` runs from the divide end to the outlet.
 *
 * Profile. `distanceM[i]` is the flow distance from the divide end to cell i,
 * so the first entry is 0 and the last is the channel length. `elevationM[i]`
 * is the height of the cell above the outlet cell, in metres (height
 * differences times `verticalToMetres`); it is NaN when the vertical unit is
 * not known in metres. `interpolated[i]` is 1 where the DTM `coverage` of the
 * cell is 1 (filled from neighbours, not measured), else 0.
 *
 * Slopes, both metres of fall per metre of channel:
 *  - 10-85: (E85 - E10) / (0.75 L), where E10 and E85 are the heights at 10 %
 *    and 85 % of the length measured up the channel from the outlet, read from
 *    the profile by linear interpolation.
 *  - Taylor-Schwarz: [L / sum(l_i / sqrt(S_i))]^2 over 10 equal reaches by
 *    length, S_i the fall over reach i. A reach that does not fall
 *    (S_i <= 0) uses S_i = 1e-4 so that it counts as nearly level rather than
 *    dividing by zero.
 *  - Three reaches (thirds, from the divide end) are reported for the report's
 *    reach table; their slopes are the plain fall over length, and may be zero
 *    or negative on a channel that rises over a short stretch.
 *
 * Why a figure is withheld, in order: 'open-catchment' (the channel may extend
 * beyond the data, so only its length is stated, as a minimum), then
 * 'vertical-unresolved' (no height in metres), then 'too-small' (a channel
 * without length) or 'not-applicable' (a cell without a height).
 *
 * D8 lengths run a little long: a path made of steps in 8 directions is
 * longer than the straight line it follows by up to 8.2 %. That bound is
 * carried in `d8LengthBiasMax` so the report can state it.
 *
 * Pure: no DOM. Reads the grid, the routing and the mask; changes none.
 */

import type { FlowGrid } from '../flowTypes';
import { traceDownstream, type D8Result } from '../d8Flow';
import { flowLengthToOutlet } from '../flowLength';
import type { Figure, Withheld, WithheldReason } from './catchmentMorphometrics';

export const TAYLOR_SCHWARZ_REACHES = 10;
/** Slope used for a reach that does not fall (m/m). */
export const TAYLOR_SCHWARZ_FLOOR_SLOPE = 1e-4;
const REPORT_REACHES = 3;

export interface MainChannel {
  /** Divide end to outlet. */
  readonly cells: Int32Array;
  /** Bound 'minimum' when the catchment is open. */
  readonly lengthM: Figure<number>;
  readonly profile: {
    /** Flow distance from the divide end. */
    readonly distanceM: Float64Array;
    /** Height above the outlet cell; NaN when the vertical unit is unresolved. */
    readonly elevationM: Float64Array;
    /** 1 where the cell's DTM coverage is 1 (interpolated). */
    readonly interpolated: Uint8Array;
  };
  /** (E85 - E10) / (0.75 L), m/m. */
  readonly slope1085: Figure<number>;
  /** [L / sum(l_i / sqrt(S_i))]^2 over 10 equal reaches, m/m. */
  readonly slopeTaylorSchwarz: Figure<number>;
  /** Three reaches (thirds from the divide end); empty when slopes are withheld. */
  readonly reachSlopes: readonly { readonly fromM: number; readonly toM: number; readonly slope: number }[];
  readonly d8LengthBiasMax: 0.082;
}

function withheld(reason: WithheldReason): Withheld {
  return { withheld: reason };
}

/** Height at distance `d` from the divide end, by linear interpolation along the profile. */
function elevationAt(distance: Float64Array, elevation: Float64Array, d: number): number {
  const last = distance.length - 1;
  if (d <= distance[0]) return elevation[0];
  if (d >= distance[last]) return elevation[last];
  // Binary search for the segment holding d.
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (distance[mid] <= d) lo = mid; else hi = mid;
  }
  const span = distance[hi] - distance[lo];
  if (!(span > 0)) return elevation[lo];
  return elevation[lo] + ((elevation[hi] - elevation[lo]) * (d - distance[lo])) / span;
}

export function mainChannel(input: {
  grid: FlowGrid;
  routed: D8Result;
  outlet: number;
  mask: Uint8Array;
  complete: boolean;
  verticalToMetres: number | null;
  coverage: Uint8Array;
}): MainChannel {
  const { grid, routed, outlet, mask, complete, coverage } = input;
  const vertical = input.verticalToMetres != null && Number.isFinite(input.verticalToMetres) && input.verticalToMetres > 0
    ? input.verticalToMetres
    : null;

  // --- The longest path ----------------------------------------------------
  const flow = flowLengthToOutlet(grid, routed, outlet, 'm');
  let start = -1;
  let best = -1;
  for (let i = 0; i < flow.length.length; i++) {
    const len = flow.length[i];
    if (mask[i] === 0 || Number.isNaN(len)) continue;
    if (len > best) { best = len; start = i; } // strict: the lowest index wins a tie
  }

  let cells = new Int32Array(0);
  if (start >= 0) {
    const path = traceDownstream(routed, start);
    const stop = path.indexOf(outlet);
    cells = stop >= 0 ? Int32Array.from(path.subarray(0, stop + 1)) : Int32Array.from(path);
  }

  const n = cells.length;
  const lengthValue = start >= 0 ? best : 0;
  const open = !complete;
  const lengthM: Figure<number> = start < 0 && !open ? withheld('too-small')
    : open ? { value: lengthValue, bound: 'minimum' } : { value: lengthValue };

  // --- Profile -------------------------------------------------------------
  const distanceM = new Float64Array(n);
  const elevationM = new Float64Array(n);
  const interpolated = new Uint8Array(n);
  const outletZ = outlet >= 0 && outlet < grid.z.length ? grid.z[outlet] : NaN;
  for (let k = 0; k < n; k++) {
    const cell = cells[k];
    distanceM[k] = lengthValue - flow.length[cell];
    elevationM[k] = vertical === null ? NaN : (grid.z[cell] - outletZ) * vertical;
    interpolated[k] = coverage[cell] === 1 ? 1 : 0;
  }
  const profile = { distanceM, elevationM, interpolated };

  // --- Slopes --------------------------------------------------------------
  let gate: Withheld | null = null;
  if (open) gate = withheld('open-catchment');
  else if (vertical === null) gate = withheld('vertical-unresolved');
  else if (!(lengthValue > 0) || n < 2) gate = withheld('too-small');
  else if (elevationM.some((e) => !Number.isFinite(e))) gate = withheld('not-applicable');

  if (gate !== null) {
    return { cells, lengthM, profile, slope1085: gate, slopeTaylorSchwarz: gate, reachSlopes: [], d8LengthBiasMax: 0.082 };
  }

  const L = lengthValue;
  const heightAt = (d: number) => elevationAt(distanceM, elevationM, d);

  // Up the channel from the outlet: 85 % is 0.15 L from the divide end, 10 % is 0.90 L.
  const e85 = heightAt(0.15 * L);
  const e10 = heightAt(0.9 * L);
  const slope1085: Figure<number> = { value: (e85 - e10) / (0.75 * L) };

  const reachLength = L / TAYLOR_SCHWARZ_REACHES;
  let sum = 0;
  for (let r = 0; r < TAYLOR_SCHWARZ_REACHES; r++) {
    const fall = heightAt(r * reachLength) - heightAt((r + 1) * reachLength);
    const slope = fall / reachLength;
    sum += reachLength / Math.sqrt(slope > 0 ? slope : TAYLOR_SCHWARZ_FLOOR_SLOPE);
  }
  const slopeTaylorSchwarz: Figure<number> = { value: (L / sum) ** 2 };

  const reachSlopes: { fromM: number; toM: number; slope: number }[] = [];
  for (let r = 0; r < REPORT_REACHES; r++) {
    const fromM = (r * L) / REPORT_REACHES;
    const toM = ((r + 1) * L) / REPORT_REACHES;
    reachSlopes.push({ fromM, toM, slope: (heightAt(fromM) - heightAt(toM)) / (toM - fromM) });
  }

  return { cells, lengthM, profile, slope1085, slopeTaylorSchwarz, reachSlopes, d8LengthBiasMax: 0.082 };
}
