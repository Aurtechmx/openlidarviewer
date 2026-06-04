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
export type Axis = 'x' | 'y' | 'z';

export interface ScanShape {
  readonly kind: ScanKind;
  /** 0..1 confidence in `kind`. */
  readonly confidence: number;
  /** Vertical extent / horizontal footprint, in the detected up frame. */
  readonly aspect: number;
  /** Fraction of occupied footprint cells carrying more than one surface. */
  readonly overhangFraction: number;
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
const AXIS_NAME: readonly Axis[] = ['x', 'y', 'z'];

interface AxisShape {
  aspect: number;
  overhangFraction: number;
  ex1: number;
  ex2: number;
  exV: number;
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
      kind: 'ambiguous', confidence: 0, aspect: 0, overhangFraction: 0,
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
  if (params.verticalAxis) {
    upIdx = params.verticalAxis === 'y' ? 1 : 2;
    const [v, h1, h2] = ASSIGN[upIdx];
    sh = axisShape(positions, n, stride, gridN, v, h1, h2);
  } else {
    let best = -1, bestOv = Infinity, bestSh: AxisShape | null = null;
    for (let a = 0; a < 3; a++) {
      const [v, h1, h2] = ASSIGN[a];
      const s = axisShape(positions, n, stride, gridN, v, h1, h2);
      if (s.overhangFraction < bestOv - 1e-9) { bestOv = s.overhangFraction; best = a; bestSh = s; }
    }
    upIdx = best;
    sh = bestSh as AxisShape;
  }
  const up = AXIS_NAME[upIdx];

  const reasons: string[] = [];
  let objectVotes = 0;
  if (sh.aspect >= ASPECT_OBJECT) { objectVotes++; reasons.push(`Compact aspect (height/footprint ${sh.aspect.toFixed(2)}).`); }
  if (sh.overhangFraction >= OVERHANG_OBJECT) { objectVotes++; reasons.push(`${Math.round(sh.overhangFraction * 100)}% of columns stack multiple surfaces (overhangs).`); }

  let kind: ScanKind;
  let confidence: number;
  if (objectVotes === 2) { kind = 'object'; confidence = 0.9; }
  else if (objectVotes === 1) { kind = 'ambiguous'; confidence = 0.5; }
  else {
    kind = 'terrain'; confidence = 0.85;
    reasons.push(`Flat, single-surface geometry along ${up} (aspect ${sh.aspect.toFixed(2)}, ${Math.round(sh.overhangFraction * 100)}% stacked).`);
  }

  return {
    kind,
    confidence,
    aspect: sh.aspect,
    overhangFraction: sh.overhangFraction,
    extent: [sh.ex1, sh.ex2, sh.exV],
    up,
    reasons,
  };
}
