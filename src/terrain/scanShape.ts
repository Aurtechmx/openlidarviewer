/**
 * scanShape.ts
 *
 * Decide whether a scan is a TERRAIN-like height field (a thin shell over a
 * wide footprint — what the DTM / contour pipeline is built for) or a compact
 * 3-D OBJECT (a phone scan of a sculpture, a chair, a room) where terrain
 * analysis is a category error and would print confident-but-meaningless
 * contours and accuracy figures.
 *
 * Two cheap geometric signals, no ML:
 *   - aspect = vertical extent / horizontal footprint. Terrain is flat-ish
 *     (low aspect); objects are compact or tall (higher aspect).
 *   - overhangFraction = fraction of occupied cells (on the two horizontal
 *     axes) whose returns span a large VERTICAL range — i.e. more than one
 *     surface stacked over the same footprint. Terrain is 2.5-D (one surface
 *     per column → near-zero); objects have undersides / overhangs (high).
 *
 * Up-axis is DETECTED, not assumed: LAS is Z-up but phone / glTF object scans
 * are often Y-up. The true up is the axis along which the surface is most
 * single-valued, so we try each axis as "up" and keep the one with the least
 * overhang. A caller that already knows the vertical axis can override it.
 *
 * Pure data, deterministic. Operates on an interleaved xyz Float32Array.
 */

import type { VerticalAxis } from './ground/groundFilter';

export type ScanKind = 'terrain' | 'object' | 'ambiguous';
/**
 * The decisive routing bucket. `terrain` is the only one the DTM / contour
 * pipeline is built for; `interior` (a room / 360 / iPhone-LiDAR space with a
 * floor + ceiling enclosure) and `object` (a compact 3-D scan) both want the
 * space/object analysis instead.
 */
export type SpaceKind = 'interior' | 'object' | 'terrain';
export type Axis = 'x' | 'y' | 'z';

export interface ScanShape {
  readonly kind: ScanKind;
  /**
   * Decisive routing flag: true for any scan that is NOT a terrain height
   * field — compact objects AND interior spaces. The viewer routes on this.
   */
  readonly nonTerrain: boolean;
  /** Which non-terrain (or terrain) analysis to emphasise. */
  readonly spaceKind: SpaceKind;
  /** 0..1 confidence in `kind`. */
  readonly confidence: number;
  /** Vertical extent / horizontal footprint, in the detected up frame. */
  readonly aspect: number;
  /** Fraction of occupied footprint cells carrying more than one surface. */
  readonly overhangFraction: number;
  /**
   * 0..1 — fraction of occupied footprint cells with a return near the TOP of
   * the vertical extent (a ceiling sitting over the footprint).
   */
  readonly ceilingCoverage: number;
  /**
   * 0..1 — fraction of occupied footprint cells with a return near the BOTTOM
   * of the vertical extent (a floor under the footprint).
   */
  readonly floorCoverage: number;
  /** AABB extents [horizontal1, horizontal2, vertical], source units. */
  readonly extent: readonly [number, number, number];
  /** The detected (or supplied) up axis. */
  readonly up: Axis;
  /** Short human-readable basis for the verdict. */
  readonly reasons: readonly string[];
}

export interface ScanShapeParams {
  /** Force the up axis instead of detecting it. */
  readonly verticalAxis?: VerticalAxis;
  /** Max points to sample for the test. Default 60000. */
  readonly maxSamples?: number;
  /** Grid resolution (cells per axis) for the overhang test. Default 64. */
  readonly gridN?: number;
}

const ASPECT_OBJECT = 0.65;
const OVERHANG_OBJECT = 0.2;
/** Vertical band (fraction of vertical extent) that counts as floor / ceiling. */
const PLANE_BAND = 0.15;
/** Footprint coverage a floor AND a ceiling must each reach to read as enclosed. */
const ENCLOSURE_COVER = 0.45;
const AXIS_NAME: readonly Axis[] = ['x', 'y', 'z'];

interface AxisShape {
  aspect: number;
  overhangFraction: number;
  ex1: number;
  ex2: number;
  exV: number;
}

interface Enclosure {
  /** True when a dominant floor AND a dominant ceiling both span the footprint. */
  ceilingPresent: boolean;
  /** 0..1 occupied-cell fraction with a return in the bottom band (floor). */
  floorCoverage: number;
  /** 0..1 occupied-cell fraction with a return in the top band (ceiling). */
  ceilingCoverage: number;
  /** Point concentration in the floor + ceiling bands — used to pick the up axis. */
  score: number;
}

/** Detect a floor + ceiling enclosure treating `vOff` as up. A room has a
 *  dominant LOW horizontal surface (floor) and a dominant HIGH one (ceiling)
 *  each covering most of the footprint; terrain has neither. */
function enclosureForAxis(
  positions: Float32Array | ReadonlyArray<number>,
  n: number,
  stride: number,
  gridN: number,
  vOff: number,
  h1Off: number,
  h2Off: number,
): Enclosure {
  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    if (h1 < minH1) minH1 = h1; if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2; if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  if (exV <= 0) return { ceilingPresent: false, floorCoverage: 0, ceilingCoverage: 0, score: 0 };

  const band = PLANE_BAND * exV;
  const floorHi = minV + band;
  const ceilLo = maxV - band;
  const cols = gridN, rows = gridN;
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  const cellW = ex1 > 0 ? ex1 / cols : 1;
  const cellH = ex2 > 0 ? ex2 / rows : 1;
  let total = 0, floorBandPts = 0, ceilBandPts = 0;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    total++;
    if (v <= floorHi) floorBandPts++;
    if (v >= ceilLo) ceilBandPts++;
    let c = Math.floor((h1 - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((h2 - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    if (v < zMin[idx]) zMin[idx] = v;
    if (v > zMax[idx]) zMax[idx] = v;
  }
  let occupied = 0, floorCells = 0, ceilCells = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (zMin[i] === Infinity) continue;
    occupied++;
    if (zMin[i] <= floorHi) floorCells++;
    if (zMax[i] >= ceilLo) ceilCells++;
  }
  const floorCoverage = occupied > 0 ? floorCells / occupied : 0;
  const ceilingCoverage = occupied > 0 ? ceilCells / occupied : 0;
  const score = total > 0 ? (floorBandPts + ceilBandPts) / total : 0;
  const ceilingPresent = ceilingCoverage >= ENCLOSURE_COVER && floorCoverage >= ENCLOSURE_COVER;
  return { ceilingPresent, floorCoverage, ceilingCoverage, score };
}

/** Compute aspect + overhang treating `vOff` as up and `h1Off`/`h2Off` as the
 *  horizontal plane (all are interleaved-triple offsets 0/1/2). */
function axisShape(
  positions: Float32Array | ReadonlyArray<number>,
  n: number,
  stride: number,
  gridN: number,
  vOff: number,
  h1Off: number,
  h2Off: number,
): AxisShape {
  let minH1 = Infinity, maxH1 = -Infinity, minH2 = Infinity, maxH2 = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    if (h1 < minH1) minH1 = h1; if (h1 > maxH1) maxH1 = h1;
    if (h2 < minH2) minH2 = h2; if (h2 > maxH2) maxH2 = h2;
    if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const ex1 = Math.max(0, maxH1 - minH1);
  const ex2 = Math.max(0, maxH2 - minH2);
  const exV = Math.max(0, maxV - minV);
  const footprint = Math.max(ex1, ex2, 1e-9);
  const aspect = exV / footprint;

  const cols = gridN, rows = gridN;
  const zMin = new Float32Array(cols * rows).fill(Infinity);
  const zMax = new Float32Array(cols * rows).fill(-Infinity);
  const cellW = ex1 > 0 ? ex1 / cols : 1;
  const cellH = ex2 > 0 ? ex2 / rows : 1;
  const cellDiag = Math.hypot(cellW, cellH) || 1;
  for (let i = 0; i < n; i += stride) {
    const b = i * 3;
    const h1 = positions[b + h1Off], h2 = positions[b + h2Off], v = positions[b + vOff];
    if (!Number.isFinite(h1) || !Number.isFinite(h2) || !Number.isFinite(v)) continue;
    let c = Math.floor((h1 - minH1) / cellW); if (c < 0) c = 0; else if (c >= cols) c = cols - 1;
    let r = Math.floor((h2 - minH2) / cellH); if (r < 0) r = 0; else if (r >= rows) r = rows - 1;
    const idx = r * cols + c;
    if (v < zMin[idx]) zMin[idx] = v;
    if (v > zMax[idx]) zMax[idx] = v;
  }
  let occupied = 0, stacked = 0;
  for (let i = 0; i < cols * rows; i++) {
    if (zMin[i] === Infinity) continue;
    occupied++;
    if (zMax[i] - zMin[i] > 1.5 * cellDiag) stacked++;
  }
  return { aspect, overhangFraction: occupied > 0 ? stacked / occupied : 0, ex1, ex2, exV };
}

/** Classify a scan's shape from its point geometry. */
export function classifyScanShape(
  positions: Float32Array | ReadonlyArray<number>,
  params: ScanShapeParams = {},
): ScanShape {
  const n = Math.floor(positions.length / 3);
  const gridN = Math.max(8, Math.floor(params.gridN ?? 64));
  const maxSamples = Math.max(100, Math.floor(params.maxSamples ?? 60000));

  if (n < 8) {
    return {
      kind: 'ambiguous', nonTerrain: false, spaceKind: 'terrain', confidence: 0,
      aspect: 0, overhangFraction: 0, ceilingCoverage: 0, floorCoverage: 0,
      extent: [0, 0, 0], up: 'z', reasons: ['Too few points to classify.'],
    };
  }
  const stride = Math.max(1, Math.floor(n / maxSamples));

  // Pick the up axis: supplied, or detected as the one with least overhang.
  const ASSIGN: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 2], // x up
    [1, 0, 2], // y up
    [2, 0, 1], // z up
  ];
  let upIdx: number;
  let sh: AxisShape;
  let enc: Enclosure;
  if (params.verticalAxis) {
    // Caller knows the up axis — honour it for shape AND enclosure.
    upIdx = params.verticalAxis === 'y' ? 1 : 2;
    const [v, h1, h2] = ASSIGN[upIdx];
    sh = axisShape(positions, n, stride, gridN, v, h1, h2);
    enc = enclosureForAxis(positions, n, stride, gridN, v, h1, h2);
  } else {
    // Up axis: least overhang for the terrain/object signals (back-compat),
    // but if a floor+ceiling enclosure is found, the enclosure's own axis (the
    // one whose floor+ceiling bands hold the most points) wins — a closed
    // room reads ~1.0 overhang on every axis, so min-overhang can't find up.
    let best = -1, bestOv = Infinity, bestSh: AxisShape | null = null;
    let encBest = -1, encScore = -1, encOf: Enclosure | null = null;
    for (let a = 0; a < 3; a++) {
      const [v, h1, h2] = ASSIGN[a];
      const s = axisShape(positions, n, stride, gridN, v, h1, h2);
      if (s.overhangFraction < bestOv - 1e-9) { bestOv = s.overhangFraction; best = a; bestSh = s; }
      const e = enclosureForAxis(positions, n, stride, gridN, v, h1, h2);
      if (e.score > encScore + 1e-9) { encScore = e.score; encBest = a; encOf = e; }
    }
    if (encOf && encOf.ceilingPresent) {
      upIdx = encBest;
      const [v, h1, h2] = ASSIGN[upIdx];
      sh = axisShape(positions, n, stride, gridN, v, h1, h2);
      enc = encOf;
    } else {
      upIdx = best;
      sh = bestSh as AxisShape;
      const [v, h1, h2] = ASSIGN[upIdx];
      enc = enclosureForAxis(positions, n, stride, gridN, v, h1, h2);
    }
  }
  const up = AXIS_NAME[upIdx];

  const reasons: string[] = [];
  let objectVotes = 0;
  if (sh.aspect >= ASPECT_OBJECT) { objectVotes++; reasons.push(`Compact aspect (height/footprint ${sh.aspect.toFixed(2)}).`); }
  if (sh.overhangFraction >= OVERHANG_OBJECT) { objectVotes++; reasons.push(`${Math.round(sh.overhangFraction * 100)}% of columns stack multiple surfaces (overhangs).`); }

  // Back-compat verdict (terrain | object | ambiguous) on the two original
  // signals only, so existing `kind` callers behave exactly as before.
  let kind: ScanKind;
  let confidence: number;
  if (objectVotes === 2) { kind = 'object'; confidence = 0.9; }
  else if (objectVotes === 1) { kind = 'ambiguous'; confidence = 0.5; }
  else {
    kind = 'terrain'; confidence = 0.85;
    reasons.push(`Flat, single-surface geometry along ${up} (aspect ${sh.aspect.toFixed(2)}, ${Math.round(sh.overhangFraction * 100)}% stacked).`);
  }

  // Decisive routing: a floor+ceiling enclosure makes it an interior space even
  // at low (terrain-like) aspect — that's the iPhone-LiDAR room case. A compact
  // 3-D scan without an enclosure is an object. Everything else is terrain.
  const enclosed = enc.ceilingPresent;
  const nonTerrain = kind === 'object' || enclosed;
  let spaceKind: SpaceKind;
  if (enclosed && sh.aspect < ASPECT_OBJECT) {
    spaceKind = 'interior';
    reasons.unshift(
      `Floor + ceiling enclose ${Math.round(enc.ceilingCoverage * 100)}% of the footprint — interior space.`,
    );
  } else if (nonTerrain) {
    spaceKind = 'object';
    if (enclosed && objectVotes < 2) {
      reasons.unshift(`Enclosed surfaces over ${Math.round(enc.ceilingCoverage * 100)}% of the footprint.`);
    }
  } else {
    spaceKind = 'terrain';
  }

  return {
    kind,
    nonTerrain,
    spaceKind,
    confidence,
    aspect: sh.aspect,
    overhangFraction: sh.overhangFraction,
    ceilingCoverage: enc.ceilingCoverage,
    floorCoverage: enc.floorCoverage,
    extent: [sh.ex1, sh.ex2, sh.exV],
    up,
    reasons,
  };
}
