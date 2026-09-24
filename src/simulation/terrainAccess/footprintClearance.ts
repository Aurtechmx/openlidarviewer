/**
 * footprintClearance.ts — accounting for vehicle width by dilating blocked
 * cells, per §12.7 of the governing prompt.
 *
 * A route centreline threading a one-cell gap between two hard-blocked cells
 * is not a route a platform of nonzero width can actually take. The standard
 * remedy (used throughout mobile-robot configuration-space planning) is to
 * grow every obstacle by half the vehicle's width before planning a
 * zero-width path through what remains: a centreline through the dilated
 * space keeps the real vehicle's edges clear of the real obstacles.
 *
 * ── WHY THIS DILATES ONLY THE NODE-LEVEL HARD BLOCKS ────────────────────────
 * `traversabilityCost.ts` hard-blocks a NODE for reasons that do not depend
 * on the direction of travel (no data, outside ROI, low confidence,
 * ruggedness, obstruction) and hard-blocks an EDGE for reasons that do
 * (longitudinal grade, cross slope, step height). Only the node reasons
 * describe a place the vehicle's body cannot occupy at all; an edge that is
 * too steep in one heading says nothing about whether the cell itself is
 * physically clear, so dilating on edge reasons would block a cell for a
 * heading nobody is trying to use through it. Width clearance is therefore
 * computed from the node mask alone and applied as an ADDITIONAL node reason.
 *
 * ── TRUE PHYSICAL DISTANCE, NOT A SQUARE WINDOW ─────────────────────────────
 * A rectangular dilation (grow by N cells on each axis) over-blocks the
 * corners of its window relative to the vehicle's actual (circular, at this
 * fidelity) footprint, and under- or over-blocks an anisotropic grid
 * depending on which axis N was sized to. This scans a bounding window sized
 * from the two axis scales but accepts a neighbour only when its physical
 * (metres) distance is within `vehicleWidth / 2`, so the dilation is the
 * actual disc the declared width sweeps, on either an isotropic or an
 * anisotropic grid.
 *
 * Vehicle LENGTH is not used here. §12.7 is explicit that width-only
 * clearance, clearly stated, is acceptable for v0.7; full swept-body
 * orientation collision (which would need the vehicle's heading along the
 * route, not just its footprint) is not implemented.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

/**
 * Dilate `blocked` (1 = hard-blocked node, row-major) by `vehicleWidth / 2`
 * physical metres, using the grid's per-axis metric cell size. Returns a NEW
 * mask; `blocked` is not mutated. A `vehicleWidth` of 0 (or non-finite)
 * returns a copy of `blocked` unchanged — no dilation, not an error, since a
 * zero-width platform has nothing to clear.
 */
export function dilateBlocked(
  blocked: Uint8Array,
  cols: number,
  rows: number,
  cellMetresX: number,
  cellMetresY: number,
  vehicleWidth: number,
): Uint8Array {
  const n = cols * rows;
  const out = new Uint8Array(n);
  const radiusM = Number.isFinite(vehicleWidth) && vehicleWidth > 0 ? vehicleWidth / 2 : 0;
  if (radiusM <= 0) {
    out.set(blocked);
    return out;
  }

  const radiusCellsX = cellMetresX > 0 ? Math.ceil(radiusM / cellMetresX) : 0;
  const radiusCellsY = cellMetresY > 0 ? Math.ceil(radiusM / cellMetresY) : 0;

  // Precompute the seed cells once: dilation only ever grows FROM an
  // originally-blocked cell, so scanning the seed list rather than every
  // (target, candidate) pair keeps this proportional to blocked-cell count
  // times window size rather than grid size times window size.
  const seeds: number[] = [];
  for (let i = 0; i < n; i++) if (blocked[i] === 1) seeds.push(i);

  for (const seed of seeds) {
    out[seed] = 1;
    const sr = (seed / cols) | 0;
    const sc = seed - sr * cols;
    for (let dr = -radiusCellsY; dr <= radiusCellsY; dr++) {
      const r = sr + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -radiusCellsX; dc <= radiusCellsX; dc++) {
        const c = sc + dc;
        if (c < 0 || c >= cols) continue;
        if (out[r * cols + c] === 1) continue;
        const distM = Math.hypot(dc * cellMetresX, dr * cellMetresY);
        if (distM <= radiusM) out[r * cols + c] = 1;
      }
    }
  }
  return out;
}
