/**
 * contourOverlayGeometry.ts
 *
 * Integration helper (pure data) — turns the contour feature model into
 * render-ready line-segment buffers a three.js overlay can upload
 * directly, WITHOUT this module importing three. Keeping the geometry
 * maths here (and three-free) means it is unit-testable in Node; the
 * actual `LineSegments` creation is a thin, documented binding in the
 * overlay class (see the integration guide).
 *
 * Each segment carries its evidence grade and index flag so the overlay
 * can colour/dash/weight it consistently with the 2D and exported views.
 * Gap segments are excluded by default (a gap is a break, not a line).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { ContourFeatureModel } from './contourFeatureModel';
import type { EvidenceGrade } from '../ground/cellConfidence';

/**
 * Which scene axis is vertical (where the elevation goes).
 *
 * WIRING CAUTION: contours are computed in the canonical Z-up frame (the
 * terrain gather rotates Y-up sources — see `terrain/canonicalFrame.ts`), so
 * placing them into a Y-up SCENE needs the full inverse rotation
 * `(x, y, z) → (x, z, −y)`, not just "put the elevation in Y". Moving the
 * elevation axis alone mirrors the northing and draws every contour flipped —
 * wrong in a way that still looks like a contour map.
 */
export type OverlayVerticalAxis = 'z' | 'y';

const GRADE_CODE: Record<EvidenceGrade, number> = { solid: 0, dashed: 1, gap: 2 };

/** Render-ready buffers for a `THREE.LineSegments`. */
export interface ContourOverlayBuffers {
  /** Interleaved x,y,z per vertex; 2 vertices per segment. */
  readonly positions: Float32Array;
  /** Number of line segments. positions.length === segmentCount * 6. */
  readonly segmentCount: number;
  /** Grade code per segment (0 solid, 1 dashed, 2 gap). */
  readonly grades: Uint8Array;
  /** 1 if the segment belongs to an index contour, else 0. */
  readonly isIndex: Uint8Array;
}

/** Options for {@link buildContourOverlayBuffers}. */
export interface OverlayGeometryParams {
  /** Scene vertical axis. Default 'z' → positions are (x, y, elevation). */
  readonly verticalAxis?: OverlayVerticalAxis;
  /** Vertical exaggeration multiplier on elevation. Default 1. */
  readonly zScale?: number;
  /** Include gap-grade segments (drawn as faint breaks). Default false. */
  readonly includeGap?: boolean;
}

/**
 * Build line-segment buffers from a contour model. Deterministic.
 *
 * Returns empty buffers (segmentCount 0) for an empty model.
 */
export function buildContourOverlayBuffers(
  model: ContourFeatureModel,
  params: OverlayGeometryParams = {},
): ContourOverlayBuffers {
  const vertical = params.verticalAxis ?? 'z';
  const zScale = Number.isFinite(params.zScale) ? (params.zScale as number) : 1;
  const includeGap = params.includeGap ?? false;

  // Count segments first so we can allocate exact typed arrays.
  let segCount = 0;
  for (const f of model.features) {
    if (f.grade === 'gap' && !includeGap) continue;
    if (f.coordinates.length >= 2) segCount += f.coordinates.length - 1;
  }

  const positions = new Float32Array(segCount * 6);
  const grades = new Uint8Array(segCount);
  const isIndex = new Uint8Array(segCount);

  let p = 0;
  let s = 0;
  const place = (x: number, y: number, elev: number) => {
    const e = elev * zScale;
    if (vertical === 'y') {
      positions[p++] = x;
      positions[p++] = e;
      positions[p++] = y;
    } else {
      positions[p++] = x;
      positions[p++] = y;
      positions[p++] = e;
    }
  };

  for (const f of model.features) {
    if (f.grade === 'gap' && !includeGap) continue;
    const code = GRADE_CODE[f.grade];
    const idx = f.isIndex ? 1 : 0;
    for (let i = 0; i < f.coordinates.length - 1; i++) {
      const a = f.coordinates[i];
      const b = f.coordinates[i + 1];
      place(a[0], a[1], f.value);
      place(b[0], b[1], f.value);
      grades[s] = code;
      isIndex[s] = idx;
      s++;
    }
  }

  return { positions, segmentCount: segCount, grades, isIndex };
}
