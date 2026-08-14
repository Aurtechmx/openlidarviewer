/**
 * floorPlanPositions.ts: the position set a floor-plan trace should run on.
 *
 * A space/room export carries its own routing-snapshot positions, but the viewer
 * can usually gather a denser terrain sample; prefer that when it is genuinely
 * larger, and fall back to the snapshot on any error so the export never blocks
 * on a best-effort densification. Pulled out of `main.ts` so the composition
 * root just calls it.
 */

/** The minimal viewer surface this needs — a dense terrain-position gather. */
export interface TerrainPositionSource {
  gatherTerrainPositions: (maxPoints: number) => { positions: Float32Array } | null;
}

/** Anything carrying a positions buffer — the space-export routing snapshot. */
export interface PositionsCarrier {
  readonly positions: Float32Array;
}

/**
 * The denser of the viewer's terrain sample and the export's own positions.
 * `gatherPoints` caps the gather; `fallback` is the routing snapshot returned
 * when the gather is absent, smaller, or throws. It takes the carrier (not the
 * raw buffer) so both `.positions` reads stay in this one classified site.
 */
export function floorPlanPositions(
  viewer: TerrainPositionSource,
  fallback: PositionsCarrier,
  gatherPoints: number,
): Float32Array {
  try {
    const dense = viewer.gatherTerrainPositions(gatherPoints);
    if (dense && dense.positions.length > fallback.positions.length) return dense.positions;
  } catch {
    /* best-effort — the routing snapshot is always valid */
  }
  return fallback.positions;
}
