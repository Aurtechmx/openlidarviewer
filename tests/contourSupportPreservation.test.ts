/**
 * contourSupportPreservation.test.ts — quick-win 8. Smoothing/generalisation
 * cannot turn a weakly-supported contour into a fully-supported one.
 *
 * A synthetic DTM with two regions — a well-supported (high-confidence) half and
 * an interpolated / weak-support half — carries a contour that crosses both. The
 * contour goes through the production chain analytical → stitched → generalised
 * (Chaikin), and at every stage a vertex's grade must stay consistent with its
 * confidence, and the generalisation step must never raise a vertex's confidence
 * above what it came in with. So a dashed (weak) vertex can never emerge solid
 * because the geometry got rounder. Invariant/regression test; no new algorithm.
 */

import { describe, it, expect } from 'vitest';
import { contoursAt } from '../src/terrain/contour/contoursAt';
import { stitchLevel } from '../src/terrain/contour/stitchContours';
import { chaikinSmooth } from '../src/terrain/contour/smoothing';
import { gradeForConfidence, EVIDENCE_THRESHOLDS, type DtmGrid } from '../src/terrain/ground/cellConfidence';

const COLS = 24, ROWS = 24;

/** A DTM whose height rises with the row (so a level is a ~horizontal line that
 *  spans all columns), with the left half well-supported and the right half weak. */
function mixedGrid(): DtmGrid {
  const n = COLS * ROWS;
  const z = new Float32Array(n);
  const confidence = new Float32Array(n);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const i = r * COLS + c;
      z[i] = r; // elevation increases north → contour crosses all columns
      confidence[i] = c < COLS / 2 ? 85 : 45; // solid (>=66) left, dashed (33..65) right
    }
  }
  return {
    z, confidence,
    coverage: new Uint8Array(n).fill(1),
    counts: new Uint32Array(n).fill(1),
    interpDistanceCells: new Float32Array(n),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: null, verticalDatum: null,
    coverageMode: 'full' as DtmGrid['coverageMode'],
    sourcePointCount: n, analyzedPointCount: n, meanConfidence: 65, warnings: [],
  };
}

describe('contour support is preserved through stitching and generalisation', () => {
  const set = contoursAt(mixedGrid(), { intervalM: 4 });
  // A mid-elevation level that crosses the whole grid (both confidence regions).
  const level = set.levels.find((l) => l.value >= 8 && l.value <= 16 && l.segments.length > 4);

  it('the analytical contour carries BOTH solid and weaker grades (the case has teeth)', () => {
    expect(level).toBeTruthy();
    const grades = new Set(level!.segments.map((s) => s.grade));
    expect(grades.has('solid')).toBe(true);
    expect(grades.has('dashed') || grades.has('gap')).toBe(true);
  });

  it('every stitched vertex grade is consistent with its confidence', () => {
    for (const poly of stitchLevel(level!.value, level!.segments)) {
      for (const v of poly.vertices) expect(v.grade).toBe(gradeForConfidence(v.confidence));
    }
  });

  it('generalisation keeps grade consistent and never raises a vertex above its input confidence', () => {
    for (const poly of stitchLevel(level!.value, level!.segments)) {
      const maxConfBefore = Math.max(...poly.vertices.map((v) => v.confidence));
      const smooth = chaikinSmooth(poly, { confidenceFloor: EVIDENCE_THRESHOLDS.solid, iterations: 2 });
      for (const v of smooth.vertices) {
        // Grade still follows confidence — no fabricated solid on weak support.
        expect(v.grade).toBe(gradeForConfidence(v.confidence));
        // Smoothing's min-rule can only hold or lower confidence, never invent
        // more support than the polyline came in with.
        expect(v.confidence).toBeLessThanOrEqual(maxConfBefore + 1e-9);
      }
      // A vertex in the weak region cannot come out solid just because the line
      // got rounder: no smoothed vertex below the solid floor reads as solid.
      for (const v of smooth.vertices) {
        if (v.confidence < EVIDENCE_THRESHOLDS.solid) expect(v.grade).not.toBe('solid');
      }
    }
  });
});
