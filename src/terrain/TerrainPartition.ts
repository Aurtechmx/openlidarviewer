/**
 * TerrainPartition.ts
 *
 * Spatial partitioning + neighborhood queries for terrain analyses.
 * Pure data — no DOM, no three.js, no I/O. Used by the foundation
 * metrics and ground-confidence scaffold.
 *
 * Grid partitioning is the foundation: every consumer below
 * (radius queries, bbox queries, neighborhood walks) reuses the
 * same grid. Tile partitioning is a sparse-friendly variant for
 * very-large clouds where most cells are empty.
 *
 * Part of the foundation layer: an internal, feature-flag-gated seam.
 * The live confidence-aware DTM / DSM / contour pipeline shipped in the
 * Analyse panel lives under `src/terrain/contour/`, `ground/`, and
 * `surface/` and does not route through these helpers.
 */

import type {
  TerrainNeighborhood,
  TerrainPoint,
  TerrainTile,
} from './TerrainContracts';

/** A flat positions buffer (interleaved x/y/z). */
export type PositionsBuffer = Float32Array;

// ── grid partitioning ──────────────────────────────────────────────

/** A regular 2D grid over the source cloud's horizontal bounding box. */
export interface TerrainGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly origin: { readonly x: number; readonly y: number };
  /** Point indices by cell — `cells[row * cols + col]`. */
  readonly cells: ReadonlyArray<ReadonlyArray<number>>;
}

/** Build a regular grid over the cloud's XY footprint. */
export function buildGrid(
  positions: PositionsBuffer,
  cellSize: number,
): TerrainGrid {
  if (cellSize <= 0) throw new Error('buildGrid: cellSize must be positive');
  const n = Math.floor(positions.length / 3);
  if (n === 0) {
    return {
      cols: 0,
      rows: 0,
      cellSize,
      origin: { x: 0, y: 0 },
      cells: [],
    };
  }
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellSize));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellSize));
  const cells: number[][] = new Array(cols * rows);
  for (let i = 0; i < cells.length; i++) cells[i] = [];
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const col = Math.min(cols - 1, Math.floor((x - minX) / cellSize));
    const row = Math.min(rows - 1, Math.floor((y - minY) / cellSize));
    cells[row * cols + col].push(i);
  }
  return { cols, rows, cellSize, origin: { x: minX, y: minY }, cells };
}

// ── tile partitioning (sparse over the grid) ───────────────────────

/** Build tiles from a populated grid — empty cells are skipped. */
export function buildTilesFromGrid(
  grid: TerrainGrid,
  positions: PositionsBuffer,
): ReadonlyArray<TerrainTile> {
  const tiles: TerrainTile[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const indices = grid.cells[row * grid.cols + col];
      if (indices.length === 0) continue;
      let minX = Infinity,
        minY = Infinity,
        minZ = Infinity,
        maxX = -Infinity,
        maxY = -Infinity,
        maxZ = -Infinity;
      for (const idx of indices) {
        const x = positions[idx * 3];
        const y = positions[idx * 3 + 1];
        const z = positions[idx * 3 + 2];
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (z < minZ) minZ = z;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        if (z > maxZ) maxZ = z;
      }
      tiles.push({
        id: row * grid.cols + col,
        col,
        row,
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
        pointIndices: indices,
      });
    }
  }
  return tiles;
}

// ── queries ────────────────────────────────────────────────────────

/** Convert a positions index into a TerrainPoint. */
function pointAt(positions: PositionsBuffer, index: number): TerrainPoint {
  return {
    x: positions[index * 3],
    y: positions[index * 3 + 1],
    z: positions[index * 3 + 2],
    sourceIndex: index,
  };
}

/**
 * Radius query — every point within XY `radius` of `(cx, cy)`. The
 * query is CYLINDRICAL: the Z coordinate of returned points is not
 * filtered. Callers that need a 3D radius must filter the result on
 * Z themselves.
 */
export function radiusQuery(
  grid: TerrainGrid,
  positions: PositionsBuffer,
  cx: number,
  cy: number,
  radius: number,
): ReadonlyArray<TerrainPoint> {
  if (radius <= 0 || grid.cols === 0) return [];
  const c0 = Math.max(0, Math.floor((cx - grid.origin.x - radius) / grid.cellSize));
  const c1 = Math.min(
    grid.cols - 1,
    Math.floor((cx - grid.origin.x + radius) / grid.cellSize),
  );
  const r0 = Math.max(0, Math.floor((cy - grid.origin.y - radius) / grid.cellSize));
  const r1 = Math.min(
    grid.rows - 1,
    Math.floor((cy - grid.origin.y + radius) / grid.cellSize),
  );
  const r2 = radius * radius;
  const out: TerrainPoint[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = grid.cells[row * grid.cols + col];
      for (const idx of cell) {
        const dx = positions[idx * 3] - cx;
        const dy = positions[idx * 3 + 1] - cy;
        if (dx * dx + dy * dy <= r2) out.push(pointAt(positions, idx));
      }
    }
  }
  return out;
}

/** Axis-aligned bounding-box query. */
export function bboxQuery(
  grid: TerrainGrid,
  positions: PositionsBuffer,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): ReadonlyArray<TerrainPoint> {
  if (grid.cols === 0) return [];
  const c0 = Math.max(0, Math.floor((minX - grid.origin.x) / grid.cellSize));
  const c1 = Math.min(grid.cols - 1, Math.floor((maxX - grid.origin.x) / grid.cellSize));
  const r0 = Math.max(0, Math.floor((minY - grid.origin.y) / grid.cellSize));
  const r1 = Math.min(grid.rows - 1, Math.floor((maxY - grid.origin.y) / grid.cellSize));
  const out: TerrainPoint[] = [];
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const cell = grid.cells[row * grid.cols + col];
      for (const idx of cell) {
        const x = positions[idx * 3];
        const y = positions[idx * 3 + 1];
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          out.push(pointAt(positions, idx));
        }
      }
    }
  }
  return out;
}

/** Build a neighborhood around a query point — `centre` plus samples within radius. */
export function buildNeighborhood(
  grid: TerrainGrid,
  positions: PositionsBuffer,
  centreIndex: number,
  radius: number,
): TerrainNeighborhood {
  const centre = pointAt(positions, centreIndex);
  const samples = radiusQuery(grid, positions, centre.x, centre.y, radius).filter(
    (p) => p.sourceIndex !== centreIndex,
  );
  return { centre, samples, radius };
}

/**
 * Resident-aware filter — given a set of source indices, return only
 * those marked resident by the streaming layer. Used by future
 * producers so they can honestly tag results as
 * `coverage: 'resident-only'` when streaming.
 */
export function filterResident(
  indices: ReadonlyArray<number>,
  isResident: (sourceIndex: number) => boolean,
): ReadonlyArray<number> {
  const out: number[] = [];
  for (const i of indices) if (isResident(i)) out.push(i);
  return out;
}
