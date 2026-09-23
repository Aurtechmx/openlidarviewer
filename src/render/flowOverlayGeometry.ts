/**
 * flowOverlayGeometry.ts — pure buffers for drawing routed flow in the scene.
 *
 * Three products, three buffer builders, one placement rule. A cell (col,row)
 * sits at world `(originH1 + col·cellSize, originH2 + row·cellSize, elevation)`
 * in the canonical Z-up survey frame the terrain gather always builds in —
 * `originH1` / `originH2` / `cellSizeM` come straight off the DTM the flow grid
 * was built from. `place()` below carries that into the SCENE frame the same
 * way `contourOverlayGeometry.ts` does for contour lines: `verticalAxis: 'z'`
 * for the survey formats, `'y'` plus a negated northing for a Y-up mesh scan —
 * the same pairing, so a flow overlay can never disagree with the contours
 * drawn over the same terrain.
 *
 * Accumulation is drawn log-scaled (§10.11): contributing area is skewed
 * enough that a linear ramp would show one bright cell and a field of black.
 * The colour comes from `elevationRampColor(t, 'viridis')`, the colour-blind-
 * safe ramp the rest of the app already uses for a scalar field, so a cell
 * count and an elevation never compete for a different palette's meaning —
 * and this draws a COUNT, never water: see the Lab's own legend text.
 *
 * Every cell is a flat-shaded quad, centred on the cell like a raster pixel
 * (±half a cell) so neighbours tile without gaps or overlap. NoData cells are
 * skipped outright — nothing is drawn where nothing was measured.
 *
 * Pure: no DOM, no three.js. `FlowOverlay.ts` is the thin binding that uploads
 * these buffers; nothing here mutates `grid`, `routed`, `accumulation` or the
 * DTM they came from, so drawing or toggling the overlay can never move the
 * run's own `fieldDigest`.
 */

import { elevationRampColor } from './colorModes';
import { CELL_NODATA } from '../simulation/flowPulse/flowTypes';
import type { AccumulationResult } from '../simulation/flowPulse/flowAccumulation';
import type { D8Result } from '../simulation/flowPulse/d8Flow';
import type { FlowGrid } from '../simulation/flowPulse/flowTypes';

/** Which scene axis is vertical — mirrors `contourOverlayGeometry`'s choice. */
export type FlowOverlayVerticalAxis = 'z' | 'y';

/** The frame + grid geometry every buffer builder places cells into. */
export interface FlowOverlayFrame {
  readonly verticalAxis: FlowOverlayVerticalAxis;
  readonly negateNorthing: boolean;
  /** DTM raster origin, horizontal axis 1 (east), in the DTM's source unit. */
  readonly originH1: number;
  /** DTM raster origin, horizontal axis 2 (north), in the DTM's source unit. */
  readonly originH2: number;
  /** Cell length in the DTM's source unit (matches `originH1`/`originH2`). */
  readonly cellSizeM: number;
}

/**
 * Build a {@link FlowOverlayFrame} from the map context's raw scene up-axis
 * (`'z'` for the survey formats, `'y'` for a Y-up mesh scan; defaults to `'z'`,
 * correct for every georeferenced case) and the DTM's own raster origin.
 */
export function flowOverlayFrame(
  sceneUpAxis: FlowOverlayVerticalAxis | null | undefined,
  originH1: number,
  originH2: number,
  cellSizeM: number,
): FlowOverlayFrame {
  const axis = sceneUpAxis ?? 'z';
  return { verticalAxis: axis, negateNorthing: axis === 'y', originH1, originH2, cellSizeM };
}

/** Write one vertex's scene position into `out` at float offset `o`. */
function place(
  frame: FlowOverlayFrame,
  col: number,
  row: number,
  elevation: number,
  out: Float32Array,
  o: number,
): void {
  const x = frame.originH1 + col * frame.cellSizeM;
  const north = frame.originH2 + row * frame.cellSizeM;
  const n = frame.negateNorthing ? -north : north;
  if (frame.verticalAxis === 'y') {
    out[o] = x; out[o + 1] = elevation; out[o + 2] = n;
  } else {
    out[o] = x; out[o + 1] = n; out[o + 2] = elevation;
  }
}

/** log1p-normalised t ∈ [0, 1] for a skewed positive value against its max. */
export function logScale(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  const t = Math.log1p(value) / Math.log1p(max);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/**
 * Flat-shaded triangle-mesh buffers: two triangles (6 vertices) per drawn
 * cell. Field named `verts`, not `positions` — these are synthetic overlay
 * vertices, never a point cloud's own buffer, and the project's
 * `lint:position-access` gate tracks `.positions` reads specifically because
 * THAT name means "a cloud's points" everywhere else in the tree; reusing it
 * here would make this geometry look like the thing the gate exists to watch.
 */
export interface FlowOverlayMeshBuffers {
  readonly verts: Float32Array;
  /** 0-1 per vertex, matching `verts` 1:1. */
  readonly colors: Float32Array;
  readonly cellsDrawn: number;
}

/** Line-segment buffers: one segment (2 vertices) per consecutive path pair. */
export interface FlowOverlayLineBuffers {
  readonly verts: Float32Array;
  readonly segments: number;
}

/** Corner offsets of a unit cell, wound as two triangles (CCW). */
const QUAD_OFFSETS: readonly (readonly [number, number])[] = [
  [-0.5, -0.5], [0.5, -0.5], [0.5, 0.5],
  [-0.5, -0.5], [0.5, 0.5], [-0.5, 0.5],
];

/** Shared quad-mesh builder: every cell `include` accepts, coloured by `colorFor`. */
function buildCellQuads(
  grid: FlowGrid,
  frame: FlowOverlayFrame,
  include: (i: number) => boolean,
  colorFor: (i: number) => readonly [number, number, number],
): FlowOverlayMeshBuffers {
  const { cols, rows } = grid;
  const n = cols * rows;
  let drawn = 0;
  for (let i = 0; i < n; i++) if (include(i)) drawn++;

  const positions = new Float32Array(drawn * QUAD_OFFSETS.length * 3);
  const colors = new Float32Array(drawn * QUAD_OFFSETS.length * 3);
  let p = 0;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const i = row * cols + col;
      if (!include(i)) continue;
      const elev = grid.z[i];
      const [r255, g255, b255] = colorFor(i);
      const r = r255 / 255, g = g255 / 255, b = b255 / 255;
      for (const [dc, dr] of QUAD_OFFSETS) {
        place(frame, col + dc, row + dr, elev, positions, p);
        colors[p] = r; colors[p + 1] = g; colors[p + 2] = b;
        p += 3;
      }
    }
  }

  return { verts: positions, colors, cellsDrawn: drawn };
}

/**
 * The flow-accumulation overlay: every routed (non-NoData) cell, coloured by
 * its log-scaled upstream cell count. Counts cells, never water — the Lab's
 * legend states that in words; this only supplies the geometry.
 */
export function buildFlowAccumulationBuffers(
  grid: FlowGrid,
  routed: D8Result,
  accumulation: AccumulationResult,
  frame: FlowOverlayFrame,
): FlowOverlayMeshBuffers {
  const n = grid.cols * grid.rows;
  let maxUpstream = 0;
  for (let i = 0; i < n; i++) {
    if (routed.status[i] === CELL_NODATA) continue;
    if (accumulation.upstreamCells[i] > maxUpstream) maxUpstream = accumulation.upstreamCells[i];
  }
  return buildCellQuads(
    grid,
    frame,
    (i) => routed.status[i] !== CELL_NODATA,
    (i) => elevationRampColor(logScale(accumulation.upstreamCells[i], maxUpstream), 'viridis'),
  );
}

/** Warm, desaturated orange — distinct from the accumulation ramp at every stop. */
export const CATCHMENT_RGB: readonly [number, number, number] = [255, 140, 38];

/** The upstream-catchment overlay: every cell `mask` marks, one flat colour. */
export function buildFlowCatchmentBuffers(
  grid: FlowGrid,
  mask: Uint8Array,
  frame: FlowOverlayFrame,
): FlowOverlayMeshBuffers {
  return buildCellQuads(grid, frame, (i) => mask[i] === 1, () => CATCHMENT_RGB);
}

/** The click-to-pulse path overlay: a line segment between each consecutive pair. */
export function buildFlowPathBuffers(
  grid: FlowGrid,
  path: Int32Array,
  frame: FlowOverlayFrame,
): FlowOverlayLineBuffers {
  const segments = Math.max(0, path.length - 1);
  const positions = new Float32Array(segments * 6);
  let p = 0;
  for (let k = 0; k < segments; k++) {
    const a = path[k];
    const b = path[k + 1];
    const ac = a % grid.cols, ar = Math.floor(a / grid.cols);
    const bc = b % grid.cols, br = Math.floor(b / grid.cols);
    place(frame, ac, ar, grid.z[a], positions, p); p += 3;
    place(frame, bc, br, grid.z[b], positions, p); p += 3;
  }
  return { verts: positions, segments };
}
