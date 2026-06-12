/**
 * labelPlacement.ts
 *
 * elevation labels along index contours. This is the single
 * biggest "looks professional vs. looks amateur" lever after index
 * weighting. Labels are placed ALONG the line (tangent-aligned, the
 * surveyor convention), spaced at a minimum interval, never crowded
 * (collision-avoided against already-placed labels), and never sat on a
 * low-confidence span (we do not stamp an authoritative elevation on a
 * stretch the data does not support).
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic — polylines are
 * walked in order; the first candidate that clears spacing + confidence
 * + separation wins.
 */

import { EVIDENCE_THRESHOLDS } from '../ground/cellConfidence';
import type { ContourPolyline } from './stitchContours';

/** A placed elevation label. */
export interface ContourLabel {
  readonly x: number;
  readonly y: number;
  /** Tangent angle of the contour at the label, radians (−π..π]. */
  readonly angleRad: number;
  /** The contour elevation this label states. */
  readonly value: number;
}

/**
 * Decimal places an elevation label needs so adjacent contour levels stay
 * DISTINGUISHABLE: the smallest d (0..3) for which `interval × 10^d` is a
 * whole number. A 0.25 m interval needs 2 decimals (100.25 vs 100.50); a 0.5 m
 * interval needs 1; metre-and-up intervals need none. Whole-metre rounding
 * collapsed every sub-metre level onto identical labels (v0.4.4 defect).
 * Invalid / non-finite intervals fall back to 0 (label whole units).
 */
export function decimalsForInterval(intervalM: number | null | undefined): number {
  if (intervalM == null || !Number.isFinite(intervalM) || intervalM <= 0) return 0;
  for (let d = 0; d <= 3; d++) {
    const scaled = intervalM * 10 ** d;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return d;
  }
  return 3;
}

/** Options for {@link placeLabels}. */
export interface LabelParams {
  /** Target spacing between labels along a line, source linear units. Must be > 0. */
  readonly spacingM: number;
  /**
   * Minimum Euclidean separation between any two placed labels (across
   * all lines). Defaults to `spacingM`. Prevents crowding where lines
   * bunch up.
   */
  readonly minSeparationM?: number;
  /** Minimum confidence at a label position. Default = `solid` threshold. */
  readonly confidenceFloor?: number;
}

/**
 * Place labels along the given polylines. Pass only the polylines whose
 * level is label-eligible (index contours from `contourStyle`).
 */
export function placeLabels(
  polylines: ReadonlyArray<ContourPolyline>,
  params: LabelParams,
): ContourLabel[] {
  const spacing = params.spacingM > 0 ? params.spacingM : 1;
  const minSep = params.minSeparationM ?? spacing;
  const floor = params.confidenceFloor ?? EVIDENCE_THRESHOLDS.solid;
  const minSepSq = minSep * minSep;

  const labels: ContourLabel[] = [];
  const farEnough = (x: number, y: number): boolean => {
    for (const l of labels) {
      const dx = x - l.x;
      const dy = y - l.y;
      if (dx * dx + dy * dy < minSepSq) return false;
    }
    return true;
  };

  for (const poly of polylines) {
    const v = poly.vertices;
    if (v.length < 2) continue;

    // First label offset half a spacing in, then every `spacing`.
    let nextAt = spacing / 2;
    let acc = 0;
    for (let i = 0; i < v.length - 1; i++) {
      const a = v[i];
      const b = v[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      if (segLen <= 0) continue;
      while (nextAt <= acc + segLen) {
        const t = (nextAt - acc) / segLen;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        // Confidence at the label = min of the bracketing vertices.
        const conf = Math.min(a.confidence, b.confidence);
        if (conf >= floor && farEnough(x, y)) {
          labels.push({ x, y, angleRad: Math.atan2(b.y - a.y, b.x - a.x), value: poly.value });
        }
        nextAt += spacing;
      }
      acc += segLen;
    }
  }
  return labels;
}
