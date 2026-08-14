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

// ── WI-5: complete-source evidence through simplification ─────────────────────
import { simplifyPolyline } from '../src/terrain/contour/contourShapeStyle';
import { buildFeatureModel, featureEvidence } from '../src/terrain/contour/contourFeatureModel';
import { PROV_M, PROV_I } from '../src/terrain/contour/contourSegmentEvidence';
import type { ContourPolyline, ContourVertex } from '../src/terrain/contour/stitchContours';

/** A straight (collinear) polyline so Douglas–Peucker removes every interior vertex. */
function line(specs: Array<{ c: number; prov: number }>, closed = false): ContourPolyline {
  const vertices: ContourVertex[] = specs.map((s, i) => ({
    x: i, y: 0, confidence: s.c, grade: gradeForConfidence(s.c), provBits: s.prov,
  }));
  return { value: 10, vertices, closed };
}

describe('WI-4/WI-5: simplification derives evidence from the complete source interval', () => {
  it('returns retainedIndices that reconstruct the kept source positions', () => {
    const poly = line([
      { c: 90, prov: PROV_M }, { c: 92, prov: PROV_M }, { c: 91, prov: PROV_M },
      { c: 93, prov: PROV_M }, { c: 90, prov: PROV_M },
    ]);
    const out = simplifyPolyline(poly, 1);
    // A straight, uniformly-supported line collapses to its two endpoints.
    expect(out.retainedIndices).toEqual([0, poly.vertices.length - 1]);
    expect(out.retainedIndices.length).toBe(out.vertices.length);
  });

  it('mixed provenance on a REMOVED interior vertex survives (union), never collapsed to one', () => {
    // Interior is measured; endpoints interpolated. DP removes the interior, but
    // its provenance must union into the output so the segment reads mixed.
    const poly = line([
      { c: 90, prov: PROV_I }, { c: 92, prov: PROV_M }, { c: 90, prov: PROV_I },
    ]);
    const out = simplifyPolyline(poly, 1);
    expect(out.vertices.length).toBe(2); // interior removed
    const unionBits = out.vertices.reduce((acc, v) => acc | v.provBits, 0);
    expect(unionBits & PROV_M).toBeTruthy(); // measured ancestry preserved
    expect(unionBits & PROV_I).toBeTruthy(); // interpolated ancestry preserved
  });

  it('a removed weaker interior vertex caps the output support (interval minimum)', () => {
    // All above the protection floor so DP is free to remove the interior; the
    // folded confidence must not exceed the weakest value over the interval.
    const weak = EVIDENCE_THRESHOLDS.solid + 4; // still solid, but the interval min
    const poly = line([
      { c: 98, prov: PROV_M }, { c: weak, prov: PROV_M }, { c: 99, prov: PROV_M },
    ]);
    const out = simplifyPolyline(poly, 1);
    expect(out.vertices.length).toBe(2);
    const minConf = Math.min(...out.vertices.map((v) => v.confidence));
    expect(minConf).toBeLessThanOrEqual(weak);
  });

  it('a sub-floor (weak) interior vertex is PROTECTED, so its low support cannot be simplified away', () => {
    const poly = line([
      { c: 95, prov: PROV_M }, { c: 15, prov: PROV_I }, { c: 95, prov: PROV_M },
    ]);
    const out = simplifyPolyline(poly, 5); // huge epsilon: would drop it if unguarded
    // The weak vertex is kept at its exact low confidence.
    expect(out.vertices.some((v) => v.confidence === 15)).toBe(true);
  });

  it('identical retained geometry with and without evidence folding (fully supported input)', () => {
    // Fully supported (uniform) input: folding changes no evidence, and the
    // coordinates/retained set are exactly what plain DP would keep.
    const uniform = line([
      { c: 90, prov: PROV_M }, { c: 90, prov: PROV_M }, { c: 90, prov: PROV_M },
      { c: 90, prov: PROV_M }, { c: 90, prov: PROV_M },
    ]);
    const out = simplifyPolyline(uniform, 1);
    expect(out.vertices.map((v) => [v.x, v.y])).toEqual([[0, 0], [4, 0]]);
    // No fabricated support: every retained vertex still 90 / measured.
    for (const v of out.vertices) {
      expect(v.confidence).toBe(90);
      expect(v.provBits).toBe(PROV_M);
    }
  });

  it('closed rings fold the cyclic interval deterministically (evidence at the cut)', () => {
    // A square ring, all collinear-per-edge, with one measured spur vertex on the
    // closing span. The closing fold must carry that measured ancestry into the ring.
    const ring: ContourPolyline = {
      value: 10, closed: true,
      vertices: [
        { x: 0, y: 0, confidence: 90, grade: 'solid', provBits: PROV_I },
        { x: 2, y: 0, confidence: 90, grade: 'solid', provBits: PROV_I },
        { x: 2, y: 2, confidence: 90, grade: 'solid', provBits: PROV_I },
        { x: 1, y: 2, confidence: 90, grade: 'solid', provBits: PROV_M }, // interior of the top edge
        { x: 0, y: 2, confidence: 90, grade: 'solid', provBits: PROV_I },
      ],
    };
    const out = simplifyPolyline(ring, 0.5);
    expect(out.closed).toBe(true);
    const unionBits = out.vertices.reduce((acc, v) => acc | v.provBits, 0);
    expect(unionBits & PROV_M).toBeTruthy(); // the measured interior survived the cut fold
  });

  it('a hand-built feature with no evidence serializes provenance as unavailable (fail closed)', () => {
    const model = buildFeatureModel([], [], { crs: 'EPSG:32610', intervalM: 1 });
    // featureEvidence over a feature with no provBits ⇒ empty provenance set.
    const ev = featureEvidence({ value: 10, isIndex: false, grade: 'solid', meanConfidence: 90, closed: false, coordinates: [[0, 0], [1, 1]] });
    expect(ev.provenance.size).toBe(0);
    expect(model.features).toHaveLength(0);
  });
});
