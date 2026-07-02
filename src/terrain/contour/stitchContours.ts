/**
 * stitchContours.ts
 *
 * Precursor step. `contoursAt` emits an unordered soup of per-cell
 * line segments; smoothing, labelling, and clean export all need ordered
 * polylines. This module joins segments that share an endpoint into
 * connected polylines, preserving per-vertex confidence (and therefore
 * the evidence grade) so the honesty information survives into the
 * pretty output.
 *
 * Adjacent marching-squares cells produce the crossing on their shared
 * edge from identical corner data, so shared endpoints match exactly;
 * a cell-size-scaled quantisation key (cell/1000; metric 1 mm default
 * when no cell size is supplied) makes the join robust to any float
 * residue in ANY source unit — a fixed millimetre key was ≈111 m in
 * degrees. A shared vertex inherits the MIN confidence of the segments
 * meeting there — a junction is only as trustworthy as its weakest side.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic (segments are
 * walked in input order; ties at junctions resolve by index).
 */

import { gradeForConfidence, type EvidenceGrade } from '../ground/cellConfidence';
import type { ContourSegment, ContourSet } from './contoursAt';

/** A single point on a stitched contour, carrying its evidence. */
export interface ContourVertex {
  readonly x: number;
  readonly y: number;
  readonly confidence: number;
  readonly grade: EvidenceGrade;
}

/** An ordered contour polyline at one elevation. */
export interface ContourPolyline {
  readonly value: number;
  readonly vertices: ContourVertex[];
  /** True when the polyline forms a closed loop (first ≈ last). */
  readonly closed: boolean;
}

/** Stitched polylines for one elevation level. */
export interface StitchedLevel {
  readonly value: number;
  readonly polylines: ContourPolyline[];
}

/**
 * Default endpoint-matching quantum: 1 mm in METRE source units — right for
 * projected metric CRSs, the overwhelmingly common case, and the historical
 * behaviour. It is NOT right for other units: 1e-3 DEGREES is ≈ 111 m, which
 * would weld every endpoint of a fine geographic grid into one blob. Callers
 * with a known cell size should pass `quantum` (see {@link stitchLevel}).
 */
const DEFAULT_Q = 1e-3;

/**
 * Endpoint quantum from a grid cell size: one thousandth of a cell. Scale-
 * free — segments live inside single cells, so endpoints of adjacent
 * segments differ by ≥ the edge-crossing spacing (≫ cell/1000) while float
 * residue from identical corner arithmetic is many orders below it. Works
 * identically for metre, foot and degree grids.
 */
export function quantumForCellSize(cellSizeM: number): number {
  return Number.isFinite(cellSizeM) && cellSizeM > 0 ? cellSizeM * 1e-3 : DEFAULT_Q;
}

/**
 * Join one level's segments into ordered polylines. `quantum` is the
 * endpoint-matching quantisation in source units; pass
 * {@link quantumForCellSize} of the grid's cell size so the join is
 * unit-aware (the fixed 1 mm default mis-scales on degree grids).
 */
export function stitchLevel(
  value: number,
  segments: ReadonlyArray<ContourSegment>,
  quantum: number = DEFAULT_Q,
): ContourPolyline[] {
  const n = segments.length;
  if (n === 0) return [];
  const Q = Number.isFinite(quantum) && quantum > 0 ? quantum : DEFAULT_Q;
  const keyOf = (x: number, y: number): string => `${Math.round(x / Q)}:${Math.round(y / Q)}`;

  const used = new Uint8Array(n);
  const segKeys: Array<[string, string]> = new Array(n);
  const incident = new Map<string, number[]>();
  const addIncident = (k: string, i: number) => {
    const list = incident.get(k);
    if (list) list.push(i);
    else incident.set(k, [i]);
  };
  for (let i = 0; i < n; i++) {
    const s = segments[i];
    const ka = keyOf(s.x1, s.y1);
    const kb = keyOf(s.x2, s.y2);
    segKeys[i] = [ka, kb];
    addIncident(ka, i);
    addIncident(kb, i);
  }

  const nextUnused = (k: string): number => {
    const list = incident.get(k);
    if (!list) return -1;
    for (const j of list) if (!used[j]) return j;
    return -1;
  };

  const polylines: ContourPolyline[] = [];
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const s = segments[i];
    const vertices: ContourVertex[] = [
      { x: s.x1, y: s.y1, confidence: s.confidence, grade: s.grade },
      { x: s.x2, y: s.y2, confidence: s.confidence, grade: s.grade },
    ];

    // Extend the tail (growing from x2,y2).
    let tailKey = segKeys[i][1];
    for (;;) {
      const j = nextUnused(tailKey);
      if (j < 0) break;
      used[j] = 1;
      const sj = segments[j];
      const [ka, kb] = segKeys[j];
      let nx: number;
      let ny: number;
      if (ka === tailKey) {
        nx = sj.x2;
        ny = sj.y2;
        tailKey = kb;
      } else {
        nx = sj.x1;
        ny = sj.y1;
        tailKey = ka;
      }
      mergeShared(vertices[vertices.length - 1], sj.confidence);
      vertices.push({ x: nx, y: ny, confidence: sj.confidence, grade: sj.grade });
    }

    // Extend the head (growing from x1,y1).
    let headKey = segKeys[i][0];
    for (;;) {
      const j = nextUnused(headKey);
      if (j < 0) break;
      used[j] = 1;
      const sj = segments[j];
      const [ka, kb] = segKeys[j];
      let nx: number;
      let ny: number;
      if (ka === headKey) {
        nx = sj.x2;
        ny = sj.y2;
        headKey = kb;
      } else {
        nx = sj.x1;
        ny = sj.y1;
        headKey = ka;
      }
      mergeShared(vertices[0], sj.confidence);
      vertices.unshift({ x: nx, y: ny, confidence: sj.confidence, grade: sj.grade });
    }

    const closed =
      vertices.length > 3 &&
      keyOf(vertices[0].x, vertices[0].y) ===
        keyOf(vertices[vertices.length - 1].x, vertices[vertices.length - 1].y);
    if (closed) vertices.pop(); // drop duplicate closing vertex
    polylines.push({ value, vertices, closed });
  }
  return polylines;
}

/** Lower a vertex's confidence to the min of itself and an incoming segment. */
function mergeShared(v: ContourVertex, segConfidence: number): void {
  const mc = Math.min(v.confidence, segConfidence);
  // ContourVertex is readonly to consumers, but we own it during build.
  (v as { confidence: number; grade: EvidenceGrade }).confidence = mc;
  (v as { confidence: number; grade: EvidenceGrade }).grade = gradeForConfidence(mc);
}

/**
 * Stitch an entire contour set. `cellSizeM` (source units) makes the
 * endpoint quantum unit-aware via {@link quantumForCellSize}; omitted keeps
 * the metric 1 mm default.
 */
export function stitchContourSet(set: ContourSet, cellSizeM?: number): StitchedLevel[] {
  const quantum = cellSizeM != null ? quantumForCellSize(cellSizeM) : DEFAULT_Q;
  return set.levels.map((l) => ({
    value: l.value,
    polylines: stitchLevel(l.value, l.segments, quantum),
  }));
}
