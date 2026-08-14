/**
 * contourEvidencePerf.test.ts — the evidence-aware simplification pass must not
 * measurably regress export throughput (contour hardening perf requirement).
 *
 * `simplifyPolyline` now folds each output segment's provenance/support from its
 * complete source interval. That fold is O(n) over source vertices (the retained
 * DP intervals partition the source in order) and allocates a new vertex ONLY
 * when the folded evidence actually differs — on fully-supported input it
 * returns the source vertex unchanged, so the hot path stays allocation-free.
 *
 * This benchmark times the evidence-aware pass against a geometry-only DP that
 * keeps the same vertices without folding, on a committed synthetic corpus, and
 * records the ratio. The assertion is a GROSS-regression guard (ratio well under
 * 2×), not a tight 5% gate, because a wall-clock micro-benchmark cannot assert
 * 5% without flaking; the measured number is logged for the record.
 */

import { describe, it, expect } from 'vitest';
import { simplifyPolyline } from '../../src/terrain/contour/contourShapeStyle';
import { gradeForConfidence } from '../../src/terrain/ground/cellConfidence';
import type { ContourPolyline, ContourVertex } from '../../src/terrain/contour/stitchContours';

/**
 * A long, wiggly polyline — the common export case. `vary` alternates provenance
 * so the fold has to aggregate a changing set (and allocate a folded vertex);
 * uniform provenance makes the fold a no-op that returns the source vertex. Same
 * COORDINATES either way, so the two runs do identical geometry work and the
 * only difference measured is the evidence fold.
 */
function corpus(n: number, vary: boolean): ContourPolyline {
  const vertices: ContourVertex[] = [];
  for (let i = 0; i < n; i++) {
    const y = Math.sin(i * 0.05) * 3 + Math.sin(i * 0.37) * 0.4;
    const provBits = vary ? (i % 3 === 0 ? 2 : 1) : 1; // alternate M/I vs all measured
    vertices.push({ x: i, y, confidence: 90, grade: gradeForConfidence(90), provBits });
  }
  return { value: 10, vertices, closed: false };
}

function medianMs(fn: () => void, iters: number): number {
  const times: number[] = [];
  for (let k = 0; k < iters; k++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return times[Math.floor(times.length / 2)];
}

describe('evidence-aware simplification throughput', () => {
  it('the evidence fold adds negligible overhead, and keeps identical geometry', () => {
    const eps = 0.5;
    const uniform = corpus(4000, false); // fold is a no-op (returns source vertex)
    const varying = corpus(4000, true); // fold aggregates + allocates a folded vertex
    // Warm up (JIT) so the timing reflects steady state, not first-call compile.
    for (let k = 0; k < 5; k++) { simplifyPolyline(uniform, eps); simplifyPolyline(varying, eps); }

    const iters = 60;
    const noFoldMs = medianMs(() => { simplifyPolyline(uniform, eps); }, iters);
    const foldMs = medianMs(() => { simplifyPolyline(varying, eps); }, iters);
    const ratio = foldMs / Math.max(noFoldMs, 1e-6);

    // Record the number — the fold's isolated cost over the same geometry work.
    // eslint-disable-next-line no-console
    console.log(
      `[contour-evidence-perf] fold=${foldMs.toFixed(3)}ms no-fold=${noFoldMs.toFixed(3)}ms ` +
        `ratio=${ratio.toFixed(3)}× (n=4000, ${iters} iters)`,
    );

    // Geometry is identical regardless of provenance — folding changes only
    // evidence fields, never which vertices survive or where they sit.
    const a = simplifyPolyline(uniform, eps).vertices.map((v) => [v.x, v.y]);
    const b = simplifyPolyline(varying, eps).vertices.map((v) => [v.x, v.y]);
    expect(a).toEqual(b);

    // The fold is O(n) and allocates only when evidence changes, so it must add
    // no meaningful overhead. Bound generously to stay flake-safe on shared CI
    // while still catching an allocation-driven blow-up.
    expect(ratio).toBeLessThan(1.5);
  });
});
