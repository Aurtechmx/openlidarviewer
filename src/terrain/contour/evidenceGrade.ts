/**
 * evidenceGrade.ts
 *
 * Evidence-grade summary for a contour set. `contoursAt` already tags
 * every segment with a grade (solid / dashed / gap) via the shared
 * `gradeForConfidence` grammar; this module aggregates those grades into
 * the numbers a deliverable needs to be honest about itself: how much of
 * the drawn contour length is confident and how much is not, per level and
 * overall. It also holds the one wording of the share line the panel, the
 * map sheet and the SVG print: interpolated and sparse ground apart, since a
 * dashed line is not by itself interpolated (see `contourBasis`).
 *
 * Length-weighted, not count-weighted: a few long confident runs and
 * many short uncertain stubs should not read as "mostly uncertain", so
 * the fraction is by drawn length.
 *
 * Pure data: no DOM, no three.js, no I/O. Deterministic.
 */

import type { ContourDisplayGrade } from '../ground/cellConfidence';
import type { ContourSegment, ContourSet } from './contoursAt';
import { modelLengthShares, type ContourFeatureModel, type ContourLengthShares } from './contourFeatureModel';

/** Per-grade length + count tally. */
export interface GradeTally {
  readonly solid: { count: number; length: number };
  readonly dashed: { count: number; length: number };
  readonly gap: { count: number; length: number };
  /** Total drawn length across all grades. */
  readonly totalLength: number;
  /**
   * Fraction of drawn length that is NOT solid (dashed + gap). 0..1. NaN when
   * nothing was drawn. Dashed covers measured sparse ground as well as
   * interpolated support, so this is not the interpolated share.
   */
  readonly interpolatedFraction: number;
}

function segLength(s: ContourSegment): number {
  return Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
}

/** Tally a flat list of segments by grade, length-weighted. */
export function tallySegments(segments: ReadonlyArray<ContourSegment>): GradeTally {
  const acc: Record<ContourDisplayGrade, { count: number; length: number }> = {
    solid: { count: 0, length: 0 },
    dashed: { count: 0, length: 0 },
    gap: { count: 0, length: 0 },
  };
  let total = 0;
  for (const s of segments) {
    const len = segLength(s);
    acc[s.grade].count += 1;
    acc[s.grade].length += len;
    total += len;
  }
  // Clamp to [0,1]: when every segment is interpolated the ratio can
  // exceed 1 by a floating-point epsilon (sum of parts > recomputed total).
  const interp =
    total > 0 ? Math.min(1, (acc.dashed.length + acc.gap.length) / total) : Number.NaN;
  return {
    solid: acc.solid,
    dashed: acc.dashed,
    gap: acc.gap,
    totalLength: total,
    interpolatedFraction: interp,
  };
}

/** Tally an entire contour set (all levels flattened). */
export function tallyContourSet(set: ContourSet): GradeTally {
  const all: ContourSegment[] = [];
  for (const level of set.levels) all.push(...level.segments);
  return tallySegments(all);
}

/**
 * A short, honest caption for a deliverable, e.g.
 * "18% of contour length is below the solid threshold (sparse ground,
 * interpolated or gap)." Returns a plain "no contours drawn" when the set is
 * empty.
 */
export function interpolatedCaption(tally: GradeTally): string {
  if (tally.totalLength === 0) return 'No contours drawn.';
  return interpolatedShareCaption(tally.interpolatedFraction);
}

/**
 * The same caption from a length-weighted non-solid fraction. One number cannot
 * say how much of it is interpolated, so it names everything it counts; a
 * surface holding the export model prints {@link contourShareCaption} instead.
 */
export function interpolatedShareCaption(fraction: number): string {
  if (!Number.isFinite(fraction)) return 'No contours drawn.';
  const pct = gradePercent(fraction);
  if (pct === 0) return 'All contour length is from confident, measured terrain.';
  return `${pct}% of contour length is below the solid threshold (sparse ground, interpolated or gap).`;
}

/** What every share is measured by, printed with it. */
export const CONTOUR_SHARE_BASIS = '(by contour length)';

/**
 * The model's contour share split by basis, one part each:
 * `["4% interpolated", "45% sparse ground", "1% gap"]`. The gap part is left
 * out when there is no gap length. Interpolated and sparse ground are always
 * named, so neither can be read into the other.
 */
export function contourShareParts(shares: ContourLengthShares): string[] {
  const parts = [
    `${gradePercent(shares.interpolated)}% interpolated`,
    `${gradePercent(shares.sparse)}% sparse ground`,
  ];
  if (shares.gap > 0) parts.push(`${gradePercent(shares.gap)}% gap`);
  return parts;
}

/**
 * The share line the map sheet, the SVG and the panel print, e.g.
 * "4% interpolated · 45% sparse ground (by contour length)".
 */
export function contourShareLine(shares: ContourLengthShares): string {
  if (!Number.isFinite(shares.interpolated)) return 'No contours drawn.';
  return `${contourShareParts(shares).join(' · ')} ${CONTOUR_SHARE_BASIS}`;
}

/**
 * The panel caption for an export model: the share line the map sheet prints,
 * or the plain all-confident sentence when no contour length is below the solid
 * threshold.
 */
export function contourShareCaption(model: ContourFeatureModel): string {
  const shares = modelLengthShares(model);
  if (Number.isFinite(shares.interpolated) && shares.interpolated === 0 && shares.sparse === 0 && shares.gap === 0) {
    return 'All contour length is from confident, measured terrain.';
  }
  return contourShareLine(shares);
}

/**
 * A share of contour length as a whole percent that never rounds away the
 * exception.
 *
 * Plain rounding turns a fraction into a universal claim at both ends. 0.998
 * became "100%", printed on a sheet that drew thirty solid contours; 0.004
 * became 0%, which this module then worded as "ALL contour length is from
 * confident, measured terrain" while some of it was not. Both are statements
 * about every metre of the deliverable, made from a number that says otherwise.
 *
 * So 0 and 100 are reserved for the exact cases. Anything strictly between
 * lands in 1..99, and a reader who sees 99% knows something is not in it.
 */
export function gradePercent(fraction: number): number {
  if (!Number.isFinite(fraction)) return Number.NaN;
  if (fraction <= 0) return 0;
  if (fraction >= 1) return 100;
  return Math.min(99, Math.max(1, Math.round(fraction * 100)));
}
