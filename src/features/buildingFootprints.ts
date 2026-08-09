/**
 * buildingFootprints.ts — extract per-building footprints from classified
 * building points (Phase 6, feature extraction).
 *
 * Building points are rasterised to a binary occupancy grid (a cell is occupied
 * when it holds at least `minPointsPerCell` building points), the occupied cells
 * are grouped into connected components (8-connectivity), and each component that
 * clears the noise-area floor becomes one footprint with its area, cell count,
 * centroid and axis-aligned extent. Trace/simplify/orthogonalise of the outline
 * are later steps; this is the detection-and-measure core they build on.
 *
 * It is HONEST about what it is: a footprint is a DERIVED candidate, not a
 * surveyed building. Points on trees or noise that survive classification will
 * form components too — the caller reviews them; this module does not claim a
 * component is a building, only that building-classified points occupy that
 * area. Pure and deterministic.
 */

export interface FootprintGrid {
  readonly originX: number;
  readonly originY: number;
  readonly cellSizeM: number;
  /** At least this many building points make a cell occupied. Default 1. */
  readonly minPointsPerCell?: number;
  /** Components below this area (m²) are dropped as noise. Default 4. */
  readonly minAreaM2?: number;
}

export interface Footprint {
  readonly cellCount: number;
  readonly areaM2: number;
  readonly centroidX: number;
  readonly centroidY: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface BuildingPoint {
  readonly x: number;
  readonly y: number;
}

/** Extract footprints from building points over the given grid. */
export function extractBuildingFootprints(points: readonly BuildingPoint[], grid: FootprintGrid): Footprint[] {
  const cell = grid.cellSizeM;
  // cell must be a positive, FINITE size. `Number.isFinite` rejects NaN AND
  // Infinity in one check — an Infinity cell would bin every point into one
  // cell and report an Infinity area.
  if (!Number.isFinite(cell) || cell <= 0 || points.length === 0) return [];
  // minPoints/minArea thresholds must be real numbers; a NaN or negative
  // threshold silently disables the filter (`n >= NaN` and `area < NaN` are both
  // false), which would admit noise as a building. Fall back to the defaults.
  const rawMinPts = grid.minPointsPerCell ?? 1;
  const minPts = Number.isFinite(rawMinPts) && rawMinPts >= 1 ? rawMinPts : 1;
  const rawMinArea = grid.minAreaM2 ?? 4;
  const minArea = Number.isFinite(rawMinArea) && rawMinArea >= 0 ? rawMinArea : 4;

  // Bin points to integer cell coordinates and count per cell.
  const counts = new Map<string, number>();
  let cMinCx = Infinity, cMinCy = Infinity, cMaxCx = -Infinity, cMaxCy = -Infinity;
  for (const p of points) {
    // Reject non-finite XY: a NaN/Infinity coordinate floors to a NaN cell index
    // ("NaN:NaN") and poisons the occupancy bbox. Skip it rather than let one
    // bad point invent or corrupt a footprint.
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const cx = Math.floor((p.x - grid.originX) / cell);
    const cy = Math.floor((p.y - grid.originY) / cell);
    const k = `${cx}:${cy}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
    if (cx < cMinCx) cMinCx = cx;
    if (cx > cMaxCx) cMaxCx = cx;
    if (cy < cMinCy) cMinCy = cy;
    if (cy > cMaxCy) cMaxCy = cy;
  }
  // Occupied set.
  const occ = new Set<string>();
  for (const [k, n] of counts) if (n >= minPts) occ.add(k);
  if (occ.size === 0) return [];

  // Connected components (8-connectivity) via iterative flood fill.
  const visited = new Set<string>();
  const footprints: Footprint[] = [];
  for (const start of occ) {
    if (visited.has(start)) continue;
    const stack = [start];
    visited.add(start);
    const cells: Array<[number, number]> = [];
    while (stack.length) {
      const k = stack.pop()!;
      const [cx, cy] = k.split(':').map(Number);
      cells.push([cx, cy]);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          const nk = `${cx + dx}:${cy + dy}`;
          if (occ.has(nk) && !visited.has(nk)) { visited.add(nk); stack.push(nk); }
        }
      }
    }
    const areaM2 = cells.length * cell * cell;
    if (areaM2 < minArea) continue;
    // Footprint geometry from the cell block (cell centres in world coords).
    let sx = 0, sy = 0, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [cx, cy] of cells) {
      const wx = grid.originX + (cx + 0.5) * cell;
      const wy = grid.originY + (cy + 0.5) * cell;
      sx += wx; sy += wy;
      const lx = grid.originX + cx * cell, ly = grid.originY + cy * cell;
      if (lx < minX) minX = lx;
      if (lx + cell > maxX) maxX = lx + cell;
      if (ly < minY) minY = ly;
      if (ly + cell > maxY) maxY = ly + cell;
    }
    footprints.push({
      cellCount: cells.length, areaM2,
      centroidX: sx / cells.length, centroidY: sy / cells.length,
      minX, minY, maxX, maxY,
    });
  }
  // Deterministic order: largest footprint first, then by centroid.
  footprints.sort((a, b) => b.areaM2 - a.areaM2 || a.centroidX - b.centroidX || a.centroidY - b.centroidY);
  return footprints;
}
