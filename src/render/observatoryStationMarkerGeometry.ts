/**
 * observatoryStationMarkerGeometry.ts: pure line-segment buffers for the
 * Observatory's 3D station markers (`ObservatoryStationMarkers.ts`).
 *
 * PRESENTATION ONLY. Two glyphs that differ in shape, not only in colour, so
 * the difference survives colour-blind viewing and greyscale screenshots:
 *
 * - an observed source station is a SOLID glyph: a closed diamond outline
 *   with both diagonals filled in, standing on a continuous mast;
 * - a suggested station is a HOLLOW, DASHED glyph: a ring drawn as alternate
 *   dashes around an empty centre, on a dashed mast.
 *
 * Every position is already in the render (local) frame; this module never
 * converts frames and never reads the evidence ledger.
 */

export type MarkerPosition = readonly [number, number, number];

/** Dashes around the suggested-station ring; every other one is drawn. */
export const SUGGESTED_RING_SEGMENTS = 16;
/** Dashes along the suggested-station mast; every other one is drawn. */
export const SUGGESTED_MAST_DASHES = 6;

function push(out: number[], a: MarkerPosition, b: MarkerPosition): void {
  out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/**
 * The solid source-station glyph, one per position: a continuous mast from
 * `size` below the station up to it, and a diamond around the station with
 * both diagonals, in the horizontal plane.
 */
export function buildObservedStationBuffer(positions: readonly MarkerPosition[], size: number): Float32Array {
  const out: number[] = [];
  const r = size / 2;
  for (const [x, y, z] of positions) {
    push(out, [x, y, z - size], [x, y, z]);
    const n: MarkerPosition = [x, y + r, z];
    const e: MarkerPosition = [x + r, y, z];
    const s: MarkerPosition = [x, y - r, z];
    const w: MarkerPosition = [x - r, y, z];
    push(out, n, e); push(out, e, s); push(out, s, w); push(out, w, n);
    push(out, n, s); push(out, e, w);
  }
  return new Float32Array(out);
}

/**
 * The hollow, dashed suggested-station glyph, one per position: a ring of
 * {@link SUGGESTED_RING_SEGMENTS} arcs with every other one drawn, and a
 * mast of {@link SUGGESTED_MAST_DASHES} steps with every other one drawn.
 * Nothing crosses the ring's centre, so the glyph reads as empty.
 */
export function buildSuggestedStationBuffer(positions: readonly MarkerPosition[], size: number): Float32Array {
  const out: number[] = [];
  const r = size / 2;
  for (const [x, y, z] of positions) {
    for (let i = 0; i < SUGGESTED_RING_SEGMENTS; i += 2) {
      const a0 = (i / SUGGESTED_RING_SEGMENTS) * Math.PI * 2;
      const a1 = ((i + 1) / SUGGESTED_RING_SEGMENTS) * Math.PI * 2;
      push(out, [x + r * Math.cos(a0), y + r * Math.sin(a0), z], [x + r * Math.cos(a1), y + r * Math.sin(a1), z]);
    }
    const step = size / SUGGESTED_MAST_DASHES;
    for (let i = 0; i < SUGGESTED_MAST_DASHES; i += 2) {
      push(out, [x, y, z - size + i * step], [x, y, z - size + (i + 1) * step]);
    }
  }
  return new Float32Array(out);
}

/** Marker size from the run's voxel edge: large enough to see over the voxels, never zero. */
export function stationMarkerSize(voxelEdge: number): number {
  return Number.isFinite(voxelEdge) && voxelEdge > 0 ? voxelEdge * 3 : 1;
}
