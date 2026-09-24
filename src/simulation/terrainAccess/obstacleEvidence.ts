/**
 * obstacleEvidence.ts — what an above-ground return says, and what it does
 * not.
 *
 * `dtmTerrainAccessGrid.ts` already computes `heightAboveGround = DSM − DTM`
 * per cell when a DSM was supplied. This module turns that height into an
 * eligibility signal against the profile's declared threshold — nothing more.
 *
 * §12.4 of the governing prompt is explicit about the honesty line: a cell
 * above the threshold is "above-ground return evidence", not a "confirmed
 * obstacle". A DSM return above a DTM cell can be a tree canopy, an overhead
 * wire, a parked vehicle, or a building — none of which OLV's classification
 * is asked to disambiguate here. So this module answers exactly one question
 * ("is the return height, if any, above the declared threshold") and leaves
 * the labelling to the caller's wording, never to a class name this module
 * would have to invent.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { TerrainAccessGrid } from './terrainAccessTypes';

/** Whether a cell's above-ground evidence exceeds a declared threshold. */
export type ObstructionState =
  /** No DSM was supplied, or no threshold was declared: not evaluated. */
  | 'not-evaluated'
  /** A DSM was supplied and a threshold was declared; evidence is below it. */
  | 'clear'
  /** A DSM was supplied and a threshold was declared; evidence exceeds it. */
  | 'obstructed';

/**
 * Per-cell obstruction state against `thresholdM`. `thresholdM === null`
 * (the profile left obstruction unconstrained) or `grid.heightAboveGround ===
 * null` (no DSM/nDSM was supplied) both yield `'not-evaluated'` everywhere —
 * distinct from `'clear'`, so a cell nobody looked at is never presented as
 * one that was checked and found clear.
 */
export function classifyObstruction(
  grid: TerrainAccessGrid,
  thresholdM: number | null,
): ObstructionState[] {
  const n = grid.cols * grid.rows;
  const out: ObstructionState[] = new Array(n).fill('not-evaluated');
  if (thresholdM == null || !grid.heightAboveGround) return out;
  const hag = grid.heightAboveGround;
  for (let i = 0; i < n; i++) {
    if (grid.valid[i] === 0) continue;
    const h = hag[i];
    if (!Number.isFinite(h)) continue; // no DSM return at this cell either
    out[i] = h > thresholdM ? 'obstructed' : 'clear';
  }
  return out;
}

/** The obstruction state at one cell, without building the whole array. */
export function obstructionAt(
  grid: TerrainAccessGrid,
  index: number,
  thresholdM: number | null,
): ObstructionState {
  if (thresholdM == null || !grid.heightAboveGround || grid.valid[index] === 0) return 'not-evaluated';
  const h = grid.heightAboveGround[index];
  if (!Number.isFinite(h)) return 'not-evaluated';
  return h > thresholdM ? 'obstructed' : 'clear';
}
