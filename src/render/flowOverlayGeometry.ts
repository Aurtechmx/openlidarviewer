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
 * Accumulation is drawn log-scaled (§10.11), as a drainage network rather
 * than a full-grid carpet: only cells whose log-scaled upstream count reaches
 * `FLOW_CHANNEL_THRESHOLD` are drawn, each as a ribbon from its centre to its
 * D8 receiver's centre plus a joint quad at its centre, so hillslopes stay
 * clear and the scan underneath stays visible. Width and colour both rise
 * with the count (see the style section below: thin rills to wide trunks, deep blue
 * to near white). A dark casing is written first so lines read over any scan
 * colour. This draws a COUNT of cells, never water: see the Lab's legend text.
 *
 * Catchment cells are flat-shaded quads, centred on the cell like a raster
 * pixel (±half a cell) so neighbours tile without gaps or overlap. NoData
 * cells are skipped outright — nothing is drawn where nothing was measured.
 *
 * Pure: no DOM, no three.js. `FlowOverlay.ts` is the thin binding that uploads
 * these buffers; nothing here mutates `grid`, `routed`, `accumulation` or the
 * DTM they came from, so drawing or toggling the overlay can never move the
 * run's own `fieldDigest`.
 */

import { CELL_NODATA } from '../simulation/flowPulse/flowTypes';
import type { AccumulationResult } from '../simulation/flowPulse/flowAccumulation';
import type { D8Result } from '../simulation/flowPulse/d8Flow';
import type { FlowGrid } from '../simulation/flowPulse/flowTypes';

/* ---- Drainage-network style, shared with the Lab grid and its particles ---- */
/*
 * Every input below is `t`, the log-scaled upstream cell count from
 * `logScale` (0 to 1 against the grid maximum). It is a count of cells, not water.
 */

/** Lowest log-scaled upstream count drawn as a channel. Cells below it are not drawn. */
export const FLOW_CHANNEL_THRESHOLD = 0.4;
/** Link width at the channel threshold, in cell sizes. */
export const FLOW_RIBBON_MIN_WIDTH_CELLS = 0.25;
/** Link width at the grid's largest upstream count, in cell sizes. */
export const FLOW_RIBBON_MAX_WIDTH_CELLS = 1.1;

export type WaterRgb = readonly [number, number, number];

/**
 * Sequential water ramp, 0-255 sRGB: deep blue, blue, cyan, near white.
 * CIELAB lightness rises at every stop, so order survives greyscale and the
 * common colour-vision deficiencies (see tests/flowNetworkStyle.test.ts).
 */
export const WATER_RAMP_STOPS: readonly { readonly t: number; readonly rgb: WaterRgb }[] = [
  { t: 0, rgb: [12, 44, 132] },
  { t: 0.4, rgb: [29, 110, 196] },
  { t: 0.75, rgb: [56, 189, 232] },
  { t: 1, rgb: [232, 247, 255] },
];

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);

/** Water ramp colour at `s` in [0, 1], linear between stops, 0-255 integers. */
export function waterRampColor(s: number): WaterRgb {
  const u = clamp01(s);
  for (let k = 1; k < WATER_RAMP_STOPS.length; k++) {
    const hi = WATER_RAMP_STOPS[k]!;
    if (u > hi.t) continue;
    const lo = WATER_RAMP_STOPS[k - 1]!;
    const f = (u - lo.t) / (hi.t - lo.t);
    return [
      Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * f),
      Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * f),
      Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * f),
    ];
  }
  return WATER_RAMP_STOPS[WATER_RAMP_STOPS.length - 1]!.rgb;
}

/** True when a log-scaled value is drawn as a channel. */
export function isChannel(t: number): boolean {
  return t >= FLOW_CHANNEL_THRESHOLD;
}

/** Position of `t` within the drawn channel range: 0 at the threshold, 1 at the maximum. */
export function channelStrength(t: number): number {
  return clamp01((t - FLOW_CHANNEL_THRESHOLD) / (1 - FLOW_CHANNEL_THRESHOLD));
}

/** Link width in cell sizes for a channel strength in [0, 1] (see {@link channelStrength}). */
export function widthForStrength(strength: number): number {
  return FLOW_RIBBON_MIN_WIDTH_CELLS + (FLOW_RIBBON_MAX_WIDTH_CELLS - FLOW_RIBBON_MIN_WIDTH_CELLS) * clamp01(strength);
}

/** Link width in cell sizes for a log-scaled value. */
export function ribbonWidthCells(t: number): number {
  return widthForStrength(channelStrength(t));
}

/** Smallest whole upstream count drawn as a channel on a grid whose maximum is `max`. */
export function channelMinCount(max: number): number {
  const m = Math.max(1, Math.round(max));
  if (m <= 1) return 1;
  let v = Math.max(1, Math.floor(Math.expm1(FLOW_CHANNEL_THRESHOLD * Math.log1p(m))));
  while (Math.log1p(v) / Math.log1p(m) < FLOW_CHANNEL_THRESHOLD) v++;
  return Math.min(v, m);
}

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
 * Flat-shaded triangle-mesh buffers: two triangles (6 vertices) per quad.
 * Field named `verts`, not `positions` — these are synthetic overlay
 * vertices, never a point cloud's own buffer, and the project's
 * `lint:position-access` gate tracks `.positions` reads specifically because
 * THAT name means "a cloud's points" everywhere else in the tree; reusing it
 * here would make this geometry look like the thing the gate exists to watch.
 */
export interface FlowOverlayMeshBuffers {
  readonly verts: Float32Array;
  /** 0-1 per vertex, matching `verts` 1:1. */
  readonly colors: Float32Array;
  /** Grid cells drawn (catchment cells, or channel cells for the network), not quads. */
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

/** Network lines sit this many cell sizes above the cell elevation, clear of the terrain surface. */
export const FLOW_NETWORK_LIFT_CELLS = 0.15;
/** Extra casing width either side of a network line, in cell sizes. */
export const FLOW_CASING_EXTRA_CELLS = 0.08;
/** Dark casing colour under every network line, 0-255. */
export const FLOW_CASING_RGB: readonly [number, number, number] = [4, 14, 34];

type Rgb01 = readonly [number, number, number];

/**
 * The flow-accumulation overlay as a drainage network: every routed cell whose
 * log-scaled upstream count is at or above `FLOW_CHANNEL_THRESHOLD`, drawn as
 * a ribbon to its D8 receiver plus a joint at its centre; cells below it are
 * not drawn. Counts cells, never water — the Lab's legend states that in
 * words; this only supplies geometry. `cellsDrawn` counts channel cells, not
 * quads. The casing pass is written first so every line sits on top of it.
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
  const channel: number[] = [];
  let links = 0;
  for (let i = 0; i < n; i++) {
    if (routed.status[i] === CELL_NODATA) continue;
    if (logScale(accumulation.upstreamCells[i], maxUpstream) < FLOW_CHANNEL_THRESHOLD) continue;
    channel.push(i);
    if (linkTarget(routed, i) >= 0) links++;
  }
  // Two passes (casing, line), each one joint per channel cell plus one ribbon per link.
  const quads = 2 * (channel.length + links);
  const w: NetworkWriter = {
    grid, frame,
    verts: new Float32Array(quads * QUAD_OFFSETS.length * 3),
    colors: new Float32Array(quads * QUAD_OFFSETS.length * 3),
    p: 0,
    lift: FLOW_NETWORK_LIFT_CELLS * frame.cellSizeM,
  };
  const casing: Rgb01 = [FLOW_CASING_RGB[0] / 255, FLOW_CASING_RGB[1] / 255, FLOW_CASING_RGB[2] / 255];
  for (const pass of ['casing', 'line'] as const) {
    for (const i of channel) {
      const t = logScale(accumulation.upstreamCells[i], maxUpstream);
      let width = ribbonWidthCells(t);
      let rgb = casing;
      if (pass === 'casing') {
        width += 2 * FLOW_CASING_EXTRA_CELLS;
      } else {
        const [r, g, b] = waterRampColor(channelStrength(t));
        rgb = [r / 255, g / 255, b / 255];
      }
      writeJoint(w, i, width, rgb);
      const to = linkTarget(routed, i);
      if (to >= 0) writeRibbon(w, i, to, width, rgb);
    }
  }
  return { verts: w.verts, colors: w.colors, cellsDrawn: channel.length };
}

/** A cell's D8 receiver when that receiver is a routed cell, else -1. */
function linkTarget(routed: D8Result, i: number): number {
  const to = routed.receiver[i];
  return to >= 0 && routed.status[to] !== CELL_NODATA ? to : -1;
}

interface NetworkWriter {
  readonly grid: FlowGrid;
  readonly frame: FlowOverlayFrame;
  readonly verts: Float32Array;
  readonly colors: Float32Array;
  p: number;
  /** Height above the cell elevation, in the DTM's source unit. */
  readonly lift: number;
}

function writeVertex(w: NetworkWriter, col: number, row: number, elev: number, rgb: Rgb01): void {
  place(w.frame, col, row, elev + w.lift, w.verts, w.p);
  w.colors[w.p] = rgb[0]; w.colors[w.p + 1] = rgb[1]; w.colors[w.p + 2] = rgb[2];
  w.p += 3;
}

/** A square `width` cells across, centred on cell `i`, so the links meeting there join cleanly. */
function writeJoint(w: NetworkWriter, i: number, width: number, rgb: Rgb01): void {
  const col = i % w.grid.cols, row = Math.floor(i / w.grid.cols);
  for (const [dc, dr] of QUAD_OFFSETS) writeVertex(w, col + dc * width, row + dr * width, w.grid.z[i], rgb);
}

/** Two triangles `width` cells wide from cell `a`'s centre to cell `b`'s centre. */
function writeRibbon(w: NetworkWriter, a: number, b: number, width: number, rgb: Rgb01): void {
  const cols = w.grid.cols;
  const ac = a % cols, ar = Math.floor(a / cols);
  const bc = b % cols, br = Math.floor(b / cols);
  const len = Math.hypot(bc - ac, br - ar) || 1;
  // Unit normal to the link, scaled to half the width.
  const nc = (-(br - ar) / len) * (width / 2), nr = ((bc - ac) / len) * (width / 2);
  const za = w.grid.z[a], zb = w.grid.z[b];
  writeVertex(w, ac + nc, ar + nr, za, rgb);
  writeVertex(w, ac - nc, ar - nr, za, rgb);
  writeVertex(w, bc - nc, br - nr, zb, rgb);
  writeVertex(w, ac + nc, ar + nr, za, rgb);
  writeVertex(w, bc - nc, br - nr, zb, rgb);
  writeVertex(w, bc + nc, br + nr, zb, rgb);
}

/** Warm, desaturated orange — distinct from the water ramp at every stop. */
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
