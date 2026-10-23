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
 * `FLOW_CHANNEL_THRESHOLD` are drawn, so hillslopes stay clear and the scan
 * underneath stays visible. The channel cells are traced along their D8
 * receivers into lines, each line smoothed (its cell steps averaged, then
 * corner-cut) and draped on the terrain, and drawn as one continuous ribbon.
 * Width and colour both rise with the count (see the style section below:
 * thin rills to wide trunks, deep blue to near white). A dark casing is
 * written first so lines read over any scan colour. This draws a COUNT of
 * cells, never water: see the Lab's legend text.
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
 * Triangle-mesh buffers: two triangles (6 vertices) per quad, or, with
 * `index`, triangles over shared vertices (the drainage network's ribbons).
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
  /** Three vertex indices per triangle; absent, every three vertices are a triangle. */
  readonly index?: Uint32Array;
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

/** Network lines sit this many cell sizes above the terrain under them, clear of the surface. */
export const FLOW_NETWORK_LIFT_CELLS = 0.15;
/** Extra casing width either side of a network line, in cell sizes. */
export const FLOW_CASING_EXTRA_CELLS = 0.08;
/** Dark casing colour under every network line, 0-255. */
export const FLOW_CASING_RGB: readonly [number, number, number] = [4, 14, 34];
/**
 * Shading across a network line, in water-ramp steps: its edges sit this far
 * down the ramp and its centre {@link FLOW_RIBBON_CORE_LIFT} up it, so a line
 * reads as a rounded channel. Both still rise with the count.
 */
export const FLOW_RIBBON_EDGE_SHADE = 0.2;
/** See {@link FLOW_RIBBON_EDGE_SHADE}. */
export const FLOW_RIBBON_CORE_LIFT = 0.2;

/** Neighbour-averaging passes over a traced line before corner cutting; one removes the D8 zigzag. */
const RELAX_PASSES = 1;
/** Corner-cutting passes (Chaikin); each doubles the points and roughly halves every bend. */
const SMOOTH_PASSES = 2;
/** A smoothed point is dropped when it lies this close to the chord between its kept neighbours, in cells. */
const SIMPLIFY_TOL_CELLS = 0.02;
/** Strength a dropped point may differ from the chord's, so widths stay smooth. */
const SIMPLIFY_TOL_STRENGTH = 0.02;
/** Longest chord between kept points, in cells, so a line keeps following the terrain. */
const SIMPLIFY_MAX_SPAN_CELLS = 1;
/** Segments in a round end cap. */
const CAP_SEGMENTS = 4;
/** A bend may stretch a line's half-width at most this many times. */
const MITER_LIMIT = 2;
/** Values per smoothed point in {@link FlowNetworkLine.points}. */
export const FLOW_LINE_STRIDE = 4;

/** Edge and centre colours of a network line at a channel strength, 0-255. */
export function flowRibbonShades(strength: number): { readonly edge: WaterRgb; readonly core: WaterRgb } {
  return {
    edge: waterRampColor(strength - FLOW_RIBBON_EDGE_SHADE),
    core: waterRampColor(strength + FLOW_RIBBON_CORE_LIFT),
  };
}

/**
 * One line of the drainage network: channel cells from a channel head down to
 * an outlet, or to the cell where it drains into a larger line.
 */
export interface FlowNetworkStem {
  /** Channel cells as grid indices, upstream end first. */
  readonly cells: Int32Array;
  /** Index of the stem this one drains into, or -1 when it ends at an outlet. */
  readonly parent: number;
  /** Position in the parent's `cells` of the cell this stem drains into, or -1. */
  readonly joinAt: number;
}

export interface FlowNetwork {
  /** Every stem, each parent before the stems that drain into it. */
  readonly stems: readonly FlowNetworkStem[];
  /** Cells whose log-scaled upstream count reaches the channel threshold. */
  readonly channelCells: number;
  /** Largest upstream count on the grid, the log scale's maximum. */
  readonly maxUpstream: number;
}

/** Largest upstream count over the cells that carry an elevation. */
function maxRoutedUpstream(status: Uint8Array, up: Uint32Array): number {
  let max = 0;
  for (let i = 0; i < status.length; i++) if (status[i] !== CELL_NODATA && up[i] > max) max = up[i];
  return max;
}

/**
 * The channel cells in index order, each numbered into `ord` (-1 elsewhere).
 * `count >= minCount` picks the same cells as `isChannel(logScale(count, max))`
 * (see {@link channelMinCount}) without a logarithm per cell.
 */
function numberChannels(status: Uint8Array, up: Uint32Array, minCount: number, ord: Int32Array): Int32Array {
  const cells: number[] = [];
  for (let i = 0; i < ord.length; i++) {
    if (status[i] !== CELL_NODATA && up[i] >= minCount) { ord[i] = cells.length; cells.push(i); } else ord[i] = -1;
  }
  return new Int32Array(cells);
}

/**
 * Trace the channel cells into lines. Each line starts at an outlet (a channel
 * cell whose D8 receiver is not a channel cell) and walks upstream; at every
 * confluence it carries on up the donor with the largest upstream count (ties:
 * the lowest cell index) and the other donors start lines of their own that
 * end on it. So a trunk stays one line through its confluences and every
 * tributary meets it. Every channel cell lands in exactly one stem.
 */
export function traceFlowNetwork(grid: FlowGrid, routed: D8Result, accumulation: AccumulationResult): FlowNetwork {
  const up = accumulation.upstreamCells;
  const maxUpstream = maxRoutedUpstream(routed.status, up);
  if (maxUpstream === 0) return { stems: [], channelCells: 0, maxUpstream };
  const ord = new Int32Array(grid.cols * grid.rows);
  const cells = numberChannels(routed.status, up, channelMinCount(maxUpstream), ord);
  const m = cells.length;
  // Each channel cell's channel donors, packed by receiver, in cell order.
  const receiver = new Int32Array(m);
  const first = new Int32Array(m + 1);
  for (let k = 0; k < m; k++) {
    const to = routed.receiver[cells[k]];
    const r = to >= 0 ? ord[to] : -1;
    receiver[k] = r;
    if (r >= 0) first[r + 1]++;
  }
  for (let k = 0; k < m; k++) first[k + 1] += first[k];
  const donors = new Int32Array(first[m]);
  const next = first.slice(0, m);
  for (let k = 0; k < m; k++) if (receiver[k] >= 0) donors[next[receiver[k]]++] = k;

  const done = new Uint8Array(m);
  const stems: FlowNetworkStem[] = [];
  const pending: number[] = []; // (donor, parent stem, join position) triples
  const traceStem = (start: number, parent: number, joinAt: number): void => {
    const path: number[] = [];
    const branches: number[] = [];
    for (let k = start; ;) {
      done[k] = 1;
      path.push(k);
      let main = -1;
      for (let e = first[k]; e < first[k + 1]; e++) {
        const d = donors[e];
        if (!done[d] && (main < 0 || up[cells[d]] > up[cells[main]])) main = d;
      }
      if (main < 0) break;
      for (let e = first[k]; e < first[k + 1]; e++) {
        const d = donors[e];
        if (!done[d] && d !== main) branches.push(d, path.length - 1);
      }
      k = main;
    }
    const len = path.length;
    const stemCells = new Int32Array(len);
    for (let p = 0; p < len; p++) stemCells[p] = cells[path[len - 1 - p]];
    const id = stems.length;
    stems.push({ cells: stemCells, parent, joinAt });
    for (let b = 0; b < branches.length; b += 2) pending.push(branches[b], id, len - 1 - branches[b + 1]);
  };
  const traceFrom = (start: number): void => {
    traceStem(start, -1, -1);
    for (let q = 0; q < pending.length; q += 3) traceStem(pending[q], pending[q + 1], pending[q + 2]);
    pending.length = 0;
  };
  for (let k = 0; k < m; k++) if (receiver[k] < 0) traceFrom(k);
  // Cells on a receiver cycle reach no outlet; draw them from their lowest index.
  for (let k = 0; k < m; k++) if (!done[k]) traceFrom(k);
  return { stems, channelCells: m, maxUpstream };
}

/** A stem's smoothed centreline, ready to draw. */
export interface FlowNetworkLine {
  /**
   * {@link FLOW_LINE_STRIDE} values per point, upstream end first: column and
   * row (fractional cells), channel strength, and terrain elevation there.
   */
  readonly points: Float64Array;
  /** Index of the line this one ends on, or -1 when it ends at an outlet. */
  readonly parent: number;
}

/** True when the cell under fractional position (c, r) is on the grid and carries an elevation. */
function onSurface(grid: FlowGrid, routed: D8Result, c: number, r: number): boolean {
  const col = Math.round(c), row = Math.round(r);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return false;
  return routed.status[row * grid.cols + col] !== CELL_NODATA;
}

/** Bilinear terrain elevation at (c, r) over the cells that carry one; NaN when none does. */
function drapeAt(grid: FlowGrid, routed: D8Result, c: number, r: number): number {
  const c0 = Math.floor(c), r0 = Math.floor(r);
  const fc = c - c0, fr = r - r0;
  let wSum = 0, zSum = 0;
  for (let k = 0; k < 4; k++) {
    const dc = k & 1, dr = k >> 1;
    const w = (dc ? fc : 1 - fc) * (dr ? fr : 1 - fr);
    const col = c0 + dc, row = r0 + dr;
    if (w <= 0 || col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) continue;
    const i = row * grid.cols + col;
    if (routed.status[i] === CELL_NODATA) continue;
    wSum += w;
    zSum += w * grid.z[i];
  }
  return wSum > 0 ? zSum / wSum : Number.NaN;
}

/** One [1, 2, 1] / 4 averaging pass over every value of the interior points; the ends stay put. */
function relaxPoints(a: Float64Array, n: number): Float64Array {
  const S = FLOW_LINE_STRIDE;
  if (n < 3) return a;
  const b = new Float64Array(a.length);
  b.set(a.subarray(0, S));
  b.set(a.subarray((n - 1) * S, n * S), (n - 1) * S);
  for (let i = 1; i < n - 1; i++) {
    for (let d = 0; d < S; d++) b[i * S + d] = (a[(i - 1) * S + d] + 2 * a[i * S + d] + a[(i + 1) * S + d]) / 4;
  }
  return b;
}

/**
 * One Chaikin pass keeping both ends: every segment is replaced by its
 * quarter and three-quarter points. The midpoint of every segment survives as
 * the midpoint of a new one, which is what lets a tributary end exactly on
 * its trunk (see {@link junctionOf}).
 */
function cutCorners(a: Float64Array, n: number): Float64Array {
  const S = FLOW_LINE_STRIDE;
  const b = new Float64Array(2 * n * S);
  b.set(a.subarray(0, S));
  for (let i = 0; i < n - 1; i++) {
    const o = (1 + 2 * i) * S;
    for (let d = 0; d < S; d++) {
      const p = a[i * S + d], q = a[(i + 1) * S + d];
      b[o + d] = 0.75 * p + 0.25 * q;
      b[o + S + d] = 0.25 * p + 0.75 * q;
    }
  }
  b.set(a.subarray((n - 1) * S, n * S), (2 * n - 1) * S);
  return b;
}

/**
 * Where a tributary ends on its parent: the point the parent's smoothed line
 * passes for control point `j`, (R[j-1] + 6 R[j] + R[j+1]) / 8 of its averaged
 * control points, or its end point. Corner cutting keeps that point on the
 * parent's line at every pass, so the two lines meet.
 */
function junctionOf(parent: Float64Array, j: number, out: Float64Array, o: number): void {
  const S = FLOW_LINE_STRIDE;
  const n = parent.length / S;
  for (let d = 0; d < 3; d++) {
    out[o + d] = j >= n - 1
      ? parent[(n - 1) * S + d]
      : (parent[(j - 1) * S + d] + 6 * parent[j * S + d] + parent[(j + 1) * S + d]) / 8;
  }
}

/**
 * Smooth every stem of `network` into a draped centreline. Each stem's cell
 * centres are averaged once with their neighbours, then corner-cut
 * {@link SMOOTH_PASSES} times, keeping its ends: its head, its outlet, or the
 * point on its parent where it joins. Strength is smoothed with the position,
 * so widths and colours taper rather than step. A smoothed point that drifts
 * over a cell with no elevation goes back onto the traced cell path, so a
 * line never leaves the surface. The points a straight chord can stand in for
 * are dropped (see {@link simplifyLine}), and the rest are draped on the
 * bilinear terrain of the cells around them that carry an elevation.
 */
export function flowNetworkLines(
  grid: FlowGrid,
  routed: D8Result,
  accumulation: AccumulationResult,
  network: FlowNetwork = traceFlowNetwork(grid, routed, accumulation),
): FlowNetworkLine[] {
  const S = FLOW_LINE_STRIDE;
  const { cols } = grid;
  const up = accumulation.upstreamCells;
  const strengthOf = (i: number): number => channelStrength(logScale(up[i], network.maxUpstream));
  const averaged: Float64Array[] = [];
  const lines: FlowNetworkLine[] = [];
  for (const stem of network.stems) {
    const len = stem.cells.length;
    const n = len + (stem.parent >= 0 ? 1 : 0);
    // Control points: column, row, strength, and position along the traced path.
    const raw = new Float64Array(n * S);
    for (let p = 0; p < len; p++) {
      const i = stem.cells[p];
      const col = i % cols;
      raw[p * S] = col; raw[p * S + 1] = (i - col) / cols; raw[p * S + 2] = strengthOf(i); raw[p * S + 3] = p;
    }
    if (stem.parent >= 0) {
      const o = len * S;
      junctionOf(averaged[stem.parent], stem.joinAt, raw, o);
      if (!onSurface(grid, routed, raw[o], raw[o + 1])) {
        const at = network.stems[stem.parent].cells[stem.joinAt];
        raw[o] = at % cols; raw[o + 1] = (at - (at % cols)) / cols; raw[o + 2] = strengthOf(at);
      }
      raw[o + 3] = len;
    }
    let pts: Float64Array = raw;
    for (let k = 0; k < RELAX_PASSES; k++) pts = relaxPoints(pts, n);
    averaged.push(pts);
    let count = n;
    if (n >= 2) for (let k = 0; k < SMOOTH_PASSES; k++) { pts = cutCorners(pts, count); count *= 2; }
    for (let o = 0; o < count * S; o += S) {
      if (onSurface(grid, routed, pts[o], pts[o + 1])) continue;
      const u = Math.min(Math.max(pts[o + 3], 0), n - 1);
      const a = Math.floor(u), b = Math.min(a + 1, n - 1), f = u - a;
      pts[o] = raw[a * S] + (raw[b * S] - raw[a * S]) * f;
      pts[o + 1] = raw[a * S + 1] + (raw[b * S + 1] - raw[a * S + 1]) * f;
      if (!onSurface(grid, routed, pts[o], pts[o + 1])) {
        const near = Math.round(u);
        pts[o] = raw[near * S]; pts[o + 1] = raw[near * S + 1];
      }
    }
    const line = simplifyLine(pts, count);
    for (let o = 0; o < line.length; o += S) {
      const zs = drapeAt(grid, routed, line[o], line[o + 1]);
      line[o + 3] = Number.isFinite(zs) ? zs : grid.z[stem.cells[Math.min(Math.round(line[o + 3]), len - 1)]];
    }
    lines.push({ points: line, parent: stem.parent });
  }
  return lines;
}

/**
 * The points of a smoothed line a straight chord cannot stand in for: each
 * chord grows while every point it skips lies within
 * {@link SIMPLIFY_TOL_CELLS} of it and within {@link SIMPLIFY_TOL_STRENGTH}
 * of its strength, up to {@link SIMPLIFY_MAX_SPAN_CELLS} long, so a line still
 * meets the terrain at least once a cell. Copies the kept points out.
 */
function simplifyLine(pts: Float64Array, count: number): Float64Array {
  const S = FLOW_LINE_STRIDE;
  const tol2 = SIMPLIFY_TOL_CELLS * SIMPLIFY_TOL_CELLS;
  const fits = (a: number, b: number): boolean => {
    const ac = pts[a * S], ar = pts[a * S + 1], as = pts[a * S + 2];
    const dc = pts[b * S] - ac, dr = pts[b * S + 1] - ar, ds = pts[b * S + 2] - as;
    const len2 = dc * dc + dr * dr;
    if (len2 > SIMPLIFY_MAX_SPAN_CELLS * SIMPLIFY_MAX_SPAN_CELLS) return false;
    for (let i = a + 1; i < b; i++) {
      const pc = pts[i * S] - ac, pr = pts[i * S + 1] - ar;
      const t = len2 > 0 ? Math.min(Math.max((pc * dc + pr * dr) / len2, 0), 1) : 0;
      const ec = pc - t * dc, er = pr - t * dr;
      if (ec * ec + er * er > tol2 || Math.abs(pts[i * S + 2] - as - ds * t) > SIMPLIFY_TOL_STRENGTH) return false;
    }
    return true;
  };
  const keep: number[] = [0];
  for (let a = 0; a < count - 1;) {
    let b = a + 1;
    while (b + 1 < count && fits(a, b + 1)) b++;
    keep.push(b);
    a = b;
  }
  const out = new Float64Array(keep.length * S);
  for (let k = 0; k < keep.length; k++) out.set(pts.subarray(keep[k] * S, keep[k] * S + S), k * S);
  return out;
}

/**
 * The flow-accumulation overlay as a drainage network: every routed cell whose
 * log-scaled upstream count is at or above `FLOW_CHANNEL_THRESHOLD`, traced
 * into lines ({@link traceFlowNetwork}), smoothed and draped
 * ({@link flowNetworkLines}) and drawn as continuous ribbons with round free
 * ends; cells below it are not drawn. Counts cells, never water — the Lab's
 * legend states that in words; this only supplies geometry. `cellsDrawn`
 * counts channel cells, not triangles. Vertices are shared along a line, so
 * the buffers carry an `index`. Every casing triangle comes before every line
 * triangle, and each tributary before the line it joins, so trunks draw on top.
 */
export function buildFlowAccumulationBuffers(
  grid: FlowGrid,
  routed: D8Result,
  accumulation: AccumulationResult,
  frame: FlowOverlayFrame,
): FlowOverlayMeshBuffers {
  const network = traceFlowNetwork(grid, routed, accumulation);
  const lines = flowNetworkLines(grid, routed, accumulation, network);
  const K = CAP_SEGMENTS;
  let vertices = 0, casingIndices = 0, lineIndices = 0;
  for (const line of lines) {
    const pts = line.points.length / FLOW_LINE_STRIDE;
    const caps = line.parent >= 0 ? 1 : 2;
    vertices += ROW_VERTICES * pts + caps * 2 * (K - 1);
    casingIndices += 6 * (pts - 1) + caps * 3 * (K - 1);
    lineIndices += 12 * (pts - 1) + caps * 3 * K;
  }
  const w: RibbonWriter = {
    grid, routed, frame,
    verts: new Float32Array(vertices * 3),
    colors: new Float32Array(vertices * 3),
    index: new Uint32Array(casingIndices + lineIndices),
    v: 0, ci: 0, li: casingIndices,
    lift: FLOW_NETWORK_LIFT_CELLS * frame.cellSizeM,
    shade: new Float32Array(6), z: 0,
  };
  for (let k = lines.length - 1; k >= 0; k--) writeLine(w, lines[k]);
  return { verts: w.verts, colors: w.colors, index: w.index, cellsDrawn: network.channelCells };
}

/** Vertices per centreline point: casing left and right, then line left, centre and right. */
const ROW_VERTICES = 5;
const CASING_RGB01 = Float32Array.from(FLOW_CASING_RGB, (v) => v / 255);

/** {@link waterRampColor}`(s)` as 0-1 values into `out` at `o`, without allocating. */
function rampInto(s: number, out: Float32Array, o: number): void {
  const u = clamp01(s);
  let k = 1;
  while (k < WATER_RAMP_STOPS.length - 1 && u > WATER_RAMP_STOPS[k].t) k++;
  const lo = WATER_RAMP_STOPS[k - 1], hi = WATER_RAMP_STOPS[k];
  const f = (u - lo.t) / (hi.t - lo.t);
  for (let d = 0; d < 3; d++) out[o + d] = Math.round(lo.rgb[d] + (hi.rgb[d] - lo.rgb[d]) * f) / 255;
}

interface RibbonWriter {
  readonly grid: FlowGrid;
  readonly routed: D8Result;
  readonly frame: FlowOverlayFrame;
  readonly verts: Float32Array;
  readonly colors: Float32Array;
  readonly index: Uint32Array;
  /** Next vertex, next casing index, next line index. */
  v: number;
  ci: number;
  li: number;
  /** Height above the terrain, in the DTM's source unit. */
  readonly lift: number;
  /** Scratch: edge colour at 0, centre colour at 3 (see {@link flowRibbonShades}). */
  readonly shade: Float32Array;
  /** Scratch: the elevation the last {@link ribbonVertex} was draped at. */
  z: number;
}

/**
 * Write one vertex at `(c, r)` moved by `(dc, dr)`, coloured `rgb[ro..ro+2]`,
 * and return its index. The move is shortened a quarter at a time until the
 * cell under the vertex carries an elevation (the centreline's own cell always
 * does), so nothing is drawn over a cell with no data. The vertex sits `lift`
 * above `zAt` when that is given, else above the terrain draped under it
 * (falling back to the centreline's `z`).
 */
function ribbonVertex(
  w: RibbonWriter, c: number, r: number, z: number, dc: number, dr: number,
  rgb: Float32Array, ro: number, zAt = Number.NaN,
): number {
  let vc = c, vr = r;
  for (let f = 4; f > 0 && (dc !== 0 || dr !== 0); f--) {
    const oc = c + (dc * f) / 4, or = r + (dr * f) / 4;
    if (onSurface(w.grid, w.routed, oc, or)) { vc = oc; vr = or; break; }
  }
  let zv = zAt;
  if (Number.isNaN(zv)) {
    zv = vc === c && vr === r ? z : drapeAt(w.grid, w.routed, vc, vr);
    if (!Number.isFinite(zv)) zv = z;
  }
  w.z = zv;
  const o = w.v * 3;
  place(w.frame, vc, vr, zv + w.lift, w.verts, o);
  w.colors[o] = rgb[ro]; w.colors[o + 1] = rgb[ro + 1]; w.colors[o + 2] = rgb[ro + 2];
  return w.v++;
}

/** Append triangle (a, b, c) to the casing or the line triangles. */
function triangle(w: RibbonWriter, casing: boolean, a: number, b: number, c: number): void {
  const ix = w.index;
  const o = casing ? w.ci : w.li;
  ix[o] = a; ix[o + 1] = b; ix[o + 2] = c;
  if (casing) w.ci += 3; else w.li += 3;
}

/** Append quad a-b-c-d as two triangles. */
function quad(w: RibbonWriter, casing: boolean, a: number, b: number, c: number, d: number): void {
  triangle(w, casing, a, b, c);
  triangle(w, casing, a, c, d);
}

/** Unit vector from (ac, ar) to (bc, br) into `out`, or (0, 0) when they coincide. */
function unitStep(ac: number, ar: number, bc: number, br: number, out: [number, number]): void {
  const dc = bc - ac, dr = br - ar;
  const l = Math.sqrt(dc * dc + dr * dr);
  if (l > 1e-9) { out[0] = dc / l; out[1] = dr / l; } else { out[0] = 0; out[1] = 0; }
}

/**
 * One network line as a ribbon: a casing strip under a three-vertex line strip
 * (edge, centre, edge), mitred at each bend, with round free ends. The casing
 * edges are draped on the terrain; the line edges, just inside them, take the
 * elevation between the centre and the casing edge.
 */
function writeLine(w: RibbonWriter, line: FlowNetworkLine): void {
  const S = FLOW_LINE_STRIDE;
  const p = line.points;
  const n = p.length / S;
  const sh = w.shade;
  const back: [number, number] = [0, 0], ahead: [number, number] = [0, 0];
  let firstRow = -1, lastRow = -1;
  let headNc = 0, headNr = 0, tailNc = 0, tailNr = 0;
  for (let i = 0; i < n; i++) {
    const o = i * S;
    const c = p[o], r = p[o + 1], s = p[o + 2], z = p[o + 3];
    if (i > 0) unitStep(p[o - S], p[o - S + 1], c, r, back); else { back[0] = 0; back[1] = 0; }
    if (i < n - 1) unitStep(c, r, p[o + S], p[o + S + 1], ahead); else { ahead[0] = 0; ahead[1] = 0; }
    // Tangent: the mean of the two segment directions; a lone point lies along the column axis.
    let tc = back[0] + ahead[0], tr = back[1] + ahead[1];
    const tl = Math.sqrt(tc * tc + tr * tr);
    if (tl > 1e-9) { tc /= tl; tr /= tl; } else if (back[0] !== 0 || back[1] !== 0) { tc = back[0]; tr = back[1]; } else { tc = 1; tr = 0; }
    const cosHalf = ahead[0] !== 0 || ahead[1] !== 0 ? tc * ahead[0] + tr * ahead[1] : 1;
    const miter = 1 / Math.max(1 / MITER_LIMIT, cosHalf);
    const nc = -tr * miter, nr = tc * miter;
    const hw = widthForStrength(s) / 2;
    const hc = hw + FLOW_CASING_EXTRA_CELLS;
    const inner = hw / hc;
    rampInto(s - FLOW_RIBBON_EDGE_SHADE, sh, 0);
    rampInto(s + FLOW_RIBBON_CORE_LIFT, sh, 3);
    const row = ribbonVertex(w, c, r, z, nc * hc, nr * hc, CASING_RGB01, 0);
    const zLeft = w.z;
    ribbonVertex(w, c, r, z, -nc * hc, -nr * hc, CASING_RGB01, 0);
    const zRight = w.z;
    ribbonVertex(w, c, r, z, nc * hw, nr * hw, sh, 0, z + (zLeft - z) * inner);
    ribbonVertex(w, c, r, z, 0, 0, sh, 3, z);
    ribbonVertex(w, c, r, z, -nc * hw, -nr * hw, sh, 0, z + (zRight - z) * inner);
    if (lastRow >= 0) {
      const a = lastRow, b = row;
      quad(w, true, a, a + 1, b + 1, b);
      quad(w, false, a + 2, a + 3, b + 3, b + 2);
      quad(w, false, a + 3, a + 4, b + 4, b + 3);
    }
    if (i === 0) { firstRow = row; headNc = -tr; headNr = tc; }
    if (i === n - 1) { tailNc = -tr; tailNr = tc; }
    lastRow = row;
  }
  // The head is always a free end; the tail only at an outlet, since a tributary ends inside its trunk.
  writeCap(w, firstRow, p, 0, headNc, headNr, -1);
  if (line.parent < 0) writeCap(w, lastRow, p, (n - 1) * S, tailNc, tailNr, 1);
}

/**
 * A half-disc cap on the end row starting at vertex `row`, centred on the
 * line point at `p[o]` and bulging away from the line (`sign` -1 at the head,
 * 1 at the tail). The casing fans from its left vertex, the line from its
 * centre, so the cap shades the way the line does.
 */
function writeCap(w: RibbonWriter, row: number, p: Float64Array, o: number, nc: number, nr: number, sign: number): void {
  const K = CAP_SEGMENTS;
  const c = p[o], r = p[o + 1], s = p[o + 2], z = p[o + 3];
  // Outward along the line: the left normal turned a quarter, back at the head, on at the tail.
  const oc = sign * nr, or = -sign * nc;
  const hw = widthForStrength(s) / 2;
  const hc = hw + FLOW_CASING_EXTRA_CELLS;
  rampInto(s - FLOW_RIBBON_EDGE_SHADE, w.shade, 0);
  let prevCasing = row, prevRim = row + 2;
  for (let k = 1; k <= K; k++) {
    const a = (k * Math.PI) / K;
    const uc = nc * Math.cos(a) + oc * Math.sin(a), ur = nr * Math.cos(a) + or * Math.sin(a);
    const casing = k === K ? row + 1 : ribbonVertex(w, c, r, z, uc * hc, ur * hc, CASING_RGB01, 0);
    const rim = k === K ? row + 4 : ribbonVertex(w, c, r, z, uc * hw, ur * hw, w.shade, 0);
    if (k > 1) triangle(w, true, row, prevCasing, casing);
    triangle(w, false, row + 3, prevRim, rim);
    prevCasing = casing;
    prevRim = rim;
  }
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
