/**
 * contourLabelEngine.ts
 *
 * Print-aware contour label placement (v0.5.9 spec §17). Pure and
 * deterministic: given contour features and a page/scale spec, it picks label
 * positions along the lines and returns the placed labels plus an audit of why
 * candidates were suppressed.
 *
 * Priorities (§17.1): index contours first, then longer intermediates. Scoring
 * (§17.2): prefer a straight, low-curvature run with real support and central
 * position; suppress on unsupported spans, sharp curvature, page edges,
 * collisions, and features too small for the scale. Behaviour (§17.4): text is
 * kept upright, follows the local tangent, and an unsupported span is never
 * labelled as if measured — it is dropped, recorded as a support suppression.
 *
 * This operates on a copy of geometry; it never mutates the analytical features,
 * so GIS geometry is untouched (§17.4).
 */

import type { ContourFeature } from '../contour/contourFeatureModel';

export type LabelSupport = 'measured' | 'interpolated' | 'unsupported';

export interface PlacedLabel {
  readonly value: number;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  /** Baseline angle in radians, corrected to read left-to-right (upright). */
  readonly angle: number;
  readonly support: LabelSupport;
  readonly isIndex: boolean;
}

export interface ContourLabelAudit {
  readonly candidates: number;
  readonly placed: number;
  readonly suppressedByCollision: number;
  readonly suppressedByCurvature: number;
  readonly suppressedBySupport: number;
  readonly suppressedByPageEdge: number;
  readonly suppressedByScale: number;
}

export interface LabelEngineParams {
  /** Sheet bounds in map units. */
  readonly page: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  /** Minimum straight run (map units) required to host a label. */
  readonly minStraightLen: number;
  /** Maximum local turning (radians) tolerated within the label's run. */
  readonly maxCurvature: number;
  /** Keep label boxes at least this far from the page edge (map units). */
  readonly edgeMargin: number;
  /** Label box height in map units. */
  readonly labelHeight: number;
  /** Per-character width in map units (label width = text.length × this). */
  readonly charWidth: number;
  /** Features shorter than this (map units) are below the scale and skipped. */
  readonly minFeatureLenForScale: number;
  /** Label only index contours (presentation default). */
  readonly indexOnly?: boolean;
  /** Optional hard cap on labels placed. */
  readonly maxLabels?: number;
  /**
   * When set (> 0), REPEAT labels along each contour: instead of one label at
   * the single best run, place a label every ~`repeatEveryLen` map units on the
   * feature's low-curvature, supported runs (collision-avoided). This is the
   * printed-map convention (an index line reads its height wherever you look).
   * Unset ⇒ the single-best-run behaviour (one label per contour) is unchanged.
   */
  readonly repeatEveryLen?: number;
  /** Elevation → label text. Default: the number as-is. Inject a locale format. */
  readonly formatValue?: (value: number) => string;
}

type Pt = [number, number];
interface Box { minX: number; minY: number; maxX: number; maxY: number }

function supportOf(f: ContourFeature): LabelSupport {
  if (f.grade === 'solid') return 'measured';
  if (f.grade === 'dashed') return 'interpolated';
  return 'unsupported';
}

function polylineLength(pts: ReadonlyArray<Pt>): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return len;
}

/** Turning angle (radians) at interior vertex i — 0 is straight. */
function turnAt(pts: ReadonlyArray<Pt>, i: number): number {
  const a = pts[i - 1], b = pts[i], c = pts[i + 1];
  const a1 = Math.atan2(b[1] - a[1], b[0] - a[0]);
  const a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
  let d = Math.abs(a2 - a1);
  if (d > Math.PI) d = 2 * Math.PI - d;
  return d;
}

/**
 * Find the best candidate: the longest contiguous low-curvature run whose
 * straight length clears `minStraightLen`. Returns the run's midpoint + tangent
 * angle, and the peak curvature seen in the run. Null when no run qualifies.
 */
function bestRun(
  pts: ReadonlyArray<Pt>,
  minStraightLen: number,
  maxCurvature: number,
): { x: number; y: number; angle: number; peakCurvature: number } | null {
  if (pts.length < 2) return null;
  // Segment-level: a run is a maximal span of vertices whose interior turns are
  // all within maxCurvature.
  let bestStart = 0, bestEnd = 0, bestLen = -1, bestPeak = 0;
  let runStart = 0, runPeak = 0;
  const flush = (end: number): void => {
    const segLen = polylineLength(pts.slice(runStart, end + 1));
    if (segLen > bestLen) {
      bestLen = segLen; bestStart = runStart; bestEnd = end; bestPeak = runPeak;
    }
  };
  for (let i = 1; i < pts.length - 1; i++) {
    const t = turnAt(pts, i);
    if (t > maxCurvature) {
      flush(i);           // close the run at the kink
      runStart = i;       // start a new run
      runPeak = 0;
    } else {
      runPeak = Math.max(runPeak, t);
    }
  }
  flush(pts.length - 1);
  if (bestLen < minStraightLen) return null;
  // Midpoint of the winning run.
  const run = pts.slice(bestStart, bestEnd + 1);
  const mid = pointAtFraction(run, 0.5);
  return { x: mid.x, y: mid.y, angle: uprightAngle(mid.angle), peakCurvature: bestPeak };
}

/**
 * Every low-curvature run of length ≥ `minStraightLen`, each yielding one or
 * more upright label placements: a short run gets a single midpoint label; a
 * long run gets labels spaced ~`repeatEveryLen` apart so a long index contour
 * reads its height along its whole length. The placements are candidates —
 * collision + edge + support gating happens in the caller.
 */
function runPlacements(
  pts: ReadonlyArray<Pt>,
  minStraightLen: number,
  maxCurvature: number,
  repeatEveryLen: number,
): Array<{ x: number; y: number; angle: number }> {
  if (pts.length < 2) return [];
  const runs: Array<readonly [number, number]> = [];
  let runStart = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    if (turnAt(pts, i) > maxCurvature) {
      runs.push([runStart, i]);
      runStart = i;
    }
  }
  runs.push([runStart, pts.length - 1]);
  const out: Array<{ x: number; y: number; angle: number }> = [];
  for (const [a, b] of runs) {
    const run = pts.slice(a, b + 1);
    const len = polylineLength(run);
    if (len < minStraightLen) continue;
    const n = repeatEveryLen > 0 ? Math.max(1, Math.floor(len / repeatEveryLen)) : 1;
    for (let k = 0; k < n; k++) {
      const p = pointAtFraction(run, (k + 0.5) / n);
      out.push({ x: p.x, y: p.y, angle: uprightAngle(p.angle) });
    }
  }
  return out;
}

function pointAtFraction(pts: ReadonlyArray<Pt>, frac: number): { x: number; y: number; angle: number } {
  const total = polylineLength(pts);
  const target = total * frac;
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (acc + segLen >= target || i === pts.length - 1) {
      const t = segLen === 0 ? 0 : (target - acc) / segLen;
      return {
        x: pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]),
        y: pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1]),
        angle: Math.atan2(pts[i][1] - pts[i - 1][1], pts[i][0] - pts[i - 1][0]),
      };
    }
    acc += segLen;
  }
  return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

/** Flip a baseline angle so text reads left-to-right (never upside-down). */
function uprightAngle(a: number): number {
  let angle = a;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle < -Math.PI / 2) angle += Math.PI;
  return angle;
}

function labelBox(x: number, y: number, w: number, h: number): Box {
  return { minX: x - w / 2, minY: y - h / 2, maxX: x + w / 2, maxY: y + h / 2 };
}
function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minY < b.maxY && a.maxY > b.minY;
}
function withinEdge(b: Box, page: LabelEngineParams['page'], margin: number): boolean {
  return b.minX >= page.minX + margin && b.minY >= page.minY + margin && b.maxX <= page.maxX - margin && b.maxY <= page.maxY - margin;
}

/** Place labels + return the audit. Pure; features are not mutated. */
export function placeContourLabels(
  features: readonly ContourFeature[],
  params: LabelEngineParams,
): { labels: PlacedLabel[]; audit: ContourLabelAudit } {
  const fmt = params.formatValue ?? ((v: number) => String(v));
  const placed: PlacedLabel[] = [];
  const placedBoxes: Box[] = [];
  let candidates = 0, suppressedByCollision = 0, suppressedByCurvature = 0;
  let suppressedBySupport = 0, suppressedByPageEdge = 0, suppressedByScale = 0;

  // Priority order: index first, then longer features.
  const ordered = features
    .map((f, i) => ({ f, i, len: polylineLength(f.coordinates) }))
    .filter(({ f }) => !(params.indexOnly && !f.isIndex))
    .sort((a, b) =>
      a.f.isIndex !== b.f.isIndex ? (a.f.isIndex ? -1 : 1) : b.len - a.len || a.i - b.i,
    );

  for (const { f, len } of ordered) {
    if (params.maxLabels != null && placed.length >= params.maxLabels) break;

    if (len < params.minFeatureLenForScale) { suppressedByScale++; continue; }

    // REPEAT MODE (printed map): multiple labels per contour along its straight,
    // supported runs. Opt-in via repeatEveryLen; the single-best-run path below
    // is untouched when it is unset.
    if (params.repeatEveryLen && params.repeatEveryLen > 0) {
      const support = supportOf(f);
      if (support === 'unsupported') { suppressedBySupport++; continue; }
      const positions = runPlacements(f.coordinates, params.minStraightLen, params.maxCurvature, params.repeatEveryLen);
      if (positions.length === 0) { suppressedByCurvature++; continue; }
      candidates++;
      const text = fmt(f.value);
      const w = Math.max(1, text.length) * params.charWidth;
      for (const pos of positions) {
        if (params.maxLabels != null && placed.length >= params.maxLabels) break;
        const box = labelBox(pos.x, pos.y, w, params.labelHeight);
        if (!withinEdge(box, params.page, params.edgeMargin)) { suppressedByPageEdge++; continue; }
        if (placedBoxes.some((b) => overlaps(b, box))) { suppressedByCollision++; continue; }
        placed.push({ value: f.value, text, x: pos.x, y: pos.y, angle: pos.angle, support, isIndex: f.isIndex });
        placedBoxes.push(box);
      }
      continue;
    }

    const run = bestRun(f.coordinates, params.minStraightLen, params.maxCurvature);
    if (!run) { suppressedByCurvature++; continue; }
    candidates++;

    const support = supportOf(f);
    // Never label an unsupported span as if measured (§17.4).
    if (support === 'unsupported') { suppressedBySupport++; continue; }

    const text = fmt(f.value);
    const box = labelBox(run.x, run.y, Math.max(1, text.length) * params.charWidth, params.labelHeight);

    if (!withinEdge(box, params.page, params.edgeMargin)) { suppressedByPageEdge++; continue; }
    if (placedBoxes.some((b) => overlaps(b, box))) { suppressedByCollision++; continue; }

    placed.push({ value: f.value, text, x: run.x, y: run.y, angle: run.angle, support, isIndex: f.isIndex });
    placedBoxes.push(box);
  }

  return {
    labels: placed,
    audit: {
      candidates,
      placed: placed.length,
      suppressedByCollision,
      suppressedByCurvature,
      suppressedBySupport,
      suppressedByPageEdge,
      suppressedByScale,
    },
  };
}
