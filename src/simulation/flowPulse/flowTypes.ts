/**
 * flowTypes.ts — the grid a flow routing model reads, and what it may say.
 *
 * Routing is kept away from `DemRaster` on purpose. The rasteriser's product
 * carries provenance, coverage mode and point tallies that routing has no
 * business reading, and a core that accepted it could not be exercised on a
 * hand-built 3×3 terrain. So the adapter lives at the call site and this
 * module describes only what D8 actually needs: elevations, which cells are
 * real, and how long a cell is on each axis in metres.
 *
 * The per-axis cell size is not a convenience. A geographic grid has square
 * cells in degrees and rectangular ones in metres, so a diagonal step is
 * `sqrt((dx·mx)² + (dy·my)²)` and never `sqrt(2)·cell`. Routing that used
 * raster-index distance would send flow along the wrong neighbour off the
 * equator while every number it printed still looked plausible.
 */

/** A cell's fate under a routing model. */
export const CELL_ROUTED = 0;
/** No lower neighbour, and no equal-elevation neighbour either: a pit. */
export const CELL_SINK = 1;
/** No lower neighbour, but an equal one exists. Unresolved in raw mode. */
export const CELL_FLAT = 2;
/** Not part of the surface. Flow neither enters nor leaves. */
export const CELL_NODATA = 3;
/** Routed off the edge of the grid. */
export const CELL_OUTLET = 4;

/** The status values a routed grid reports, one per cell. */
export type CellStatus =
  | typeof CELL_ROUTED
  | typeof CELL_SINK
  | typeof CELL_FLAT
  | typeof CELL_NODATA
  | typeof CELL_OUTLET;

/**
 * An elevation surface to route over.
 *
 * `valid` is a mask rather than a sentinel elevation because every sentinel
 * anyone picks (-9999, NaN, 0) is a real elevation somewhere, and a grid that
 * encodes absence in the same channel as height will eventually route through
 * it. `z` at an invalid cell is not read.
 */
export interface FlowGrid {
  readonly z: Float32Array;
  /** 1 where the cell carries an elevation, 0 where it does not. */
  readonly valid: Uint8Array;
  readonly cols: number;
  readonly rows: number;
  /** East–west cell length in metres. */
  readonly cellMetresX: number;
  /** North–south cell length in metres. */
  readonly cellMetresY: number;
}

/**
 * The eight neighbour offsets, in the order ties are broken.
 *
 * The order is part of the method, not an implementation detail: two
 * neighbours can offer exactly the same drop per unit distance on a symmetric
 * surface, and something has to decide. Taking the first in this fixed order
 * makes the choice reproducible across runs and platforms. A different order
 * would be equally defensible and would produce a different flow field, which
 * is why it is frozen here and pinned by test rather than left to the loop.
 */
export const D8_NEIGHBOURS: readonly (readonly [number, number])[] = Object.freeze([
  [1, 0],   // E
  [1, 1],   // SE
  [0, 1],   // S
  [-1, 1],  // SW
  [-1, 0],  // W
  [-1, -1], // NW
  [0, -1],  // N
  [1, -1],  // NE
]);

/** Throws unless the grid's dimensions and arrays agree. */
export function assertFlowGrid(grid: FlowGrid): void {
  const { cols, rows, z, valid, cellMetresX, cellMetresY } = grid;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) {
    throw new RangeError(`flowGrid: cols and rows must be positive integers; got ${cols}×${rows}`);
  }
  if (z.length !== cols * rows || valid.length !== cols * rows) {
    throw new RangeError(
      `flowGrid: z (${z.length}) and valid (${valid.length}) must both be cols×rows (${cols * rows})`,
    );
  }
  for (const [name, m] of [['cellMetresX', cellMetresX], ['cellMetresY', cellMetresY]] as const) {
    if (!(Number.isFinite(m) && m > 0)) {
      throw new RangeError(`flowGrid: ${name} must be a finite positive length; got ${m}`);
    }
  }
}
