/**
 * smoothing.ts
 *
 * corner-cutting smoothing that CANNOT fabricate terrain. The
 * honesty risk of "beautiful" contours is that smoothing interpolates
 * across the very gaps where there is no data, inventing a confident-
 * looking line. This module forbids that structurally: a corner is only
 * rounded when the vertex AND both its neighbours are high-confidence.
 * Any vertex at or adjacent to a low-confidence/gap span is preserved at
 * its exact original coordinate — so smoothing can only ever polish
 * terrain the data actually supports.
 *
 * The scheme is Chaikin corner-cutting, applied per interior vertex and
 * gated by a confidence floor. Closed loops smooth with wrap-around;
 * open polylines keep their endpoints pinned.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import { EVIDENCE_THRESHOLDS, gradeForConfidence } from '../ground/cellConfidence';
import type { ContourPolyline, ContourVertex } from './stitchContours';

/** Options for {@link chaikinSmooth}. */
export interface SmoothParams {
  /** Number of corner-cutting passes. Default 2. */
  readonly iterations?: number;
  /**
   * Minimum confidence for a vertex to be eligible for smoothing.
   * Default = the `solid` threshold, so only confident terrain is
   * smoothed. Vertices below this stay exactly where they were.
   */
  readonly confidenceFloor?: number;
}

function lerpVertex(a: ContourVertex, b: ContourVertex, t: number): ContourVertex {
  const conf = Math.min(a.confidence, b.confidence);
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    confidence: conf,
    grade: gradeForConfidence(conf),
  };
}

/**
 * Smooth a polyline with confidence-gated Chaikin corner-cutting.
 * Returns a new polyline; the input is not mutated. Polylines with
 * fewer than 3 vertices are returned unchanged.
 */
export function chaikinSmooth(poly: ContourPolyline, params: SmoothParams = {}): ContourPolyline {
  const iterations = Math.max(0, Math.floor(params.iterations ?? 2));
  const floor = params.confidenceFloor ?? EVIDENCE_THRESHOLDS.solid;
  const smoothable = (v: ContourVertex) => v.confidence >= floor;

  let verts = poly.vertices;
  if (verts.length < 3 || iterations === 0) {
    return { value: poly.value, vertices: verts.slice(), closed: poly.closed };
  }

  for (let pass = 0; pass < iterations; pass++) {
    verts = poly.closed
      ? smoothClosed(verts, smoothable)
      : smoothOpen(verts, smoothable);
  }
  return { value: poly.value, vertices: verts, closed: poly.closed };
}

/** One open-polyline pass: endpoints pinned, interior corners gated. */
function smoothOpen(
  verts: ContourVertex[],
  smoothable: (v: ContourVertex) => boolean,
): ContourVertex[] {
  const out: ContourVertex[] = [verts[0]];
  for (let i = 1; i < verts.length - 1; i++) {
    const prev = verts[i - 1];
    const cur = verts[i];
    const next = verts[i + 1];
    if (smoothable(prev) && smoothable(cur) && smoothable(next)) {
      // Cut the corner at `cur`: a point 1/4 toward prev and 1/4 toward next.
      out.push(lerpVertex(cur, prev, 0.25));
      out.push(lerpVertex(cur, next, 0.25));
    } else {
      out.push(cur); // preserve exactly — no fabrication near uncertainty
    }
  }
  out.push(verts[verts.length - 1]);
  return out;
}

/** One closed-loop pass: every vertex is interior via wrap-around. */
function smoothClosed(
  verts: ContourVertex[],
  smoothable: (v: ContourVertex) => boolean,
): ContourVertex[] {
  const n = verts.length;
  const out: ContourVertex[] = [];
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n];
    const cur = verts[i];
    const next = verts[(i + 1) % n];
    if (smoothable(prev) && smoothable(cur) && smoothable(next)) {
      out.push(lerpVertex(cur, prev, 0.25));
      out.push(lerpVertex(cur, next, 0.25));
    } else {
      out.push(cur);
    }
  }
  return out;
}
