/**
 * contourCorrectness.test.ts
 *
 * Publication-validation suite 6: contour correctness. Four questions, asked
 * of the shipped pipeline (`contoursAt` → `stitchContourSet` → `styleLevels` →
 * `buildFeatureModel` → writers):
 *
 *  1. Does the geometry agree with surfaces whose isolines are known in closed
 *     form (plane, cone, paraboloid, saddle)?
 *  2. Does it satisfy the topological invariants of a level set — no free ends
 *     inside the domain, no crossings between levels, monotone nesting?
 *  3. Does every declared property match the geometry it describes — interval,
 *     count, unit, bounds?
 *  4. Do degenerate inputs (flat, out-of-range, plateau-on-level, NaN) and the
 *     generalization pass behave, or do they fabricate?
 *
 * TOLERANCES ARE PRE-REGISTERED. Each constant below states the geometric
 * magnitude that sets it and is derived before any output is compared. Where a
 * bound depends on the fixture (cell size, level, curvature) it is computed
 * from those inputs, not typed in.
 *
 * NEGATIVE CONTROLS: every predicate that can pass vacuously is also run
 * against input constructed to violate it, in `negative controls`.
 *
 * This is E3 evidence — self-consistency against analytic surfaces and against
 * the pipeline's own declarations. It is not independent field accuracy.
 */

import { describe, it, expect } from 'vitest';
import { contoursAt, type ContourSet } from '../../src/terrain/contour/contoursAt';
import {
  stitchContourSet,
  stitchLevel,
  quantumForCellSize,
} from '../../src/terrain/contour/stitchContours';
import { styleLevels } from '../../src/terrain/contour/contourStyle';
import {
  buildFeatureModel,
  type ContourFeatureModel,
} from '../../src/terrain/contour/contourFeatureModel';
import { toGeoJSON, toGeoJSONWgs84 } from '../../src/terrain/contour/geojsonContours';
import {
  analyticalProduct,
  cartographicProduct,
} from '../../src/terrain/contourStudio/contourGeometryProduct';
import { terrainAwareCartographicProduct } from '../../src/terrain/contourStudio/contourAdaptiveGeneralize';
import { knownUnit } from '../../src/units/units';
import {
  allSegments,
  bilinearAt,
  crossingCount,
  distanceToPolyline,
  levelVertices,
  oddDegreeNodes,
  onRectBoundary,
  pointInRing,
  properlyIntersect,
  selfIntersections,
  surfaceGrid,
  tracedDomain,
  type Pt,
} from './contourSurfaces';

import { witnessSuite } from './reachability';

witnessSuite('contour-generation');

// ── pre-registered tolerances ──────────────────────────────────────────────

/**
 * Level-set membership, in source vertical units.
 *
 * A contour vertex is placed by linear interpolation along one cell edge, and
 * the bilinear surface restricted to that edge IS that same linear function,
 * so in exact arithmetic the residual is zero. What remains is representation:
 * grid heights are stored as Float32 (relative step 2^-24 ≈ 6e-8), and every
 * fixture here keeps |z| ≤ 1e3, giving ≈ 6e-5 of storage error, plus a few
 * ulps from the interpolation and the independent bilinear evaluation. 1e-3 is
 * roughly 15× that bound and still four orders below the smallest interval
 * used (1 unit), so a genuinely misplaced vertex cannot hide under it.
 */
const MEMBERSHIP_TOL = 1e-3;

/**
 * Endpoint coincidence, as a fraction of a cell. The stitcher matches
 * endpoints at cell/1000; a topology check that reads endpoints must use the
 * same grain or it will disagree with the geometry it is checking.
 */
const ENDPOINT_QUANTUM_CELLS = 1e-3;

/**
 * Radial agreement with an analytic circular isoline, in source horizontal
 * units. The generator interpolates the surface linearly along a cell edge of
 * length h; for a curve of radius R the chord error of that interpolation is
 * at most h²/(8R) in VALUE, and both fixtures here have |∇z| = 1 at the
 * relevant radius after normalisation, so the same figure bounds the RADIAL
 * error. `radialTolerance` applies a factor of 2 for the Float32 grid and the
 * clamped-parameter branch.
 */
function radialTolerance(cellSize: number, radius: number): number {
  return (2 * (cellSize * cellSize)) / (8 * radius);
}

/**
 * Exact-arithmetic agreement for a planar surface. A plane's isolines are
 * straight and marching squares reproduces them with no interpolation error at
 * all, so the only budget is Float32 storage of the corner heights (6e-8
 * relative on |z| ≤ 1e3 → 6e-5) divided by the gradient used (0.5), plus
 * rounding. 1e-4 source units.
 */
const PLANE_TOL = 1e-4;

// ── fixtures ───────────────────────────────────────────────────────────────

const CELL = 1;

/** Cone z = |r| about a world centre; contour at L is the circle r = L. */
function coneGrid(cols: number, rows: number, cx: number, cy: number) {
  return surfaceGrid(
    (col, row) => Math.hypot(col + 0.5 - cx, row + 0.5 - cy),
    { cols, rows, cellSizeM: CELL },
  );
}

/** Paraboloid z = a·r²; contour at L is the circle r = √(L/a). */
function paraboloidGrid(cols: number, rows: number, cx: number, cy: number, a: number) {
  return surfaceGrid(
    (col, row) => a * ((col + 0.5 - cx) ** 2 + (row + 0.5 - cy) ** 2),
    { cols, rows, cellSizeM: CELL },
  );
}

/** Saddle z = a(x² − y²) about a world centre; the level 0 set is y = ±x. */
function saddleGrid(cols: number, rows: number, cx: number, cy: number, a: number) {
  return surfaceGrid(
    (col, row) => a * ((col + 0.5 - cx) ** 2 - (row + 0.5 - cy) ** 2),
    { cols, rows, cellSizeM: CELL },
  );
}

/** Tilted plane z = g·x in world coordinates. */
function planeGrid(cols: number, rows: number, g: number) {
  return surfaceGrid((col) => g * (col + 0.5), { cols, rows, cellSizeM: CELL });
}

function modelFor(dtm: ReturnType<typeof surfaceGrid>, set: ContourSet): ContourFeatureModel {
  const stitched = stitchContourSet(set, dtm.cellSizeM);
  // These fixtures build level lists from an interval, so the set always
  // reports a spacing; the null case is the explicit-levels API.
  const emitted = set.intervalM ?? set.requestedIntervalM;
  const styled = styleLevels(
    set.levels.map((l) => l.value),
    { intervalM: emitted },
  );
  return buildFeatureModel(stitched, styled.levels, {
    crs: dtm.crs,
    verticalDatum: dtm.verticalDatum,
    verticalUnitToMetres: dtm.verticalUnitToMetres ?? 1,
    intervalM: emitted,
    requestedIntervalM: set.requestedIntervalM,
    contourStyle: 'crisp',
  });
}

// ── 1. analytic agreement ──────────────────────────────────────────────────

describe('contour correctness — analytic agreement', () => {
  it('a tilted plane produces straight contours at the exact analytic abscissa', () => {
    const g = 0.5;
    const dtm = planeGrid(40, 6, g);
    const set = contoursAt(dtm, { intervalM: 2 });
    expect(set.levels.length).toBeGreaterThan(3);
    for (const level of set.levels) {
      if (level.segments.length === 0) continue;
      // z = g·x → the level set is the vertical line x = value / g.
      const expectedX = level.value / g;
      for (const s of level.segments) {
        expect(Math.abs(s.x1 - expectedX)).toBeLessThan(PLANE_TOL);
        expect(Math.abs(s.x2 - expectedX)).toBeLessThan(PLANE_TOL);
      }
    }
  });

  it('a tilted plane spaces adjacent contours by interval / gradient', () => {
    const g = 0.5;
    const interval = 2;
    const dtm = planeGrid(40, 6, g);
    const set = contoursAt(dtm, { intervalM: interval });
    const xs = set.levels
      .filter((l) => l.segments.length > 0)
      .map((l) => l.segments[0].x1);
    for (let i = 1; i < xs.length; i++) {
      expect(Math.abs(xs[i] - xs[i - 1] - interval / g)).toBeLessThan(PLANE_TOL);
    }
  });

  it('a cone produces concentric circles of the analytic radius', () => {
    const cx = 20.5;
    const cy = 20.5;
    const dtm = coneGrid(41, 41, cx, cy);
    const levels = [5, 10, 15];
    const set = contoursAt(dtm, { intervalM: 5, levels });
    expect(set.levels.length).toBe(3);
    for (const level of set.levels) {
      expect(level.segments.length).toBeGreaterThan(0);
      const tol = radialTolerance(CELL, level.value);
      for (const v of levelVertices(set, level.value)) {
        const r = Math.hypot(v.x - cx, v.y - cy);
        expect(Math.abs(r - level.value)).toBeLessThan(tol);
      }
    }
  });

  it('a paraboloid produces circles of radius sqrt(level / a)', () => {
    const cx = 25.5;
    const cy = 25.5;
    const a = 0.02;
    const dtm = paraboloidGrid(51, 51, cx, cy, a);
    const set = contoursAt(dtm, { intervalM: 2, levels: [2, 8] });
    for (const level of set.levels) {
      const expectedR = Math.sqrt(level.value / a);
      // |∇z| = 2·a·r at the isoline, so the value-space chord bound
      // h²·(2a)/8 becomes a radial bound of h² / (8r).
      const tol = radialTolerance(CELL, expectedR);
      for (const v of levelVertices(set, level.value)) {
        const r = Math.hypot(v.x - cx, v.y - cy);
        expect(Math.abs(r - expectedR)).toBeLessThan(tol);
      }
    }
  });

  it('a saddle crosses at the critical point along both analytic branches', () => {
    const cx = 20.5;
    const cy = 20.5;
    const dtm = saddleGrid(41, 41, cx, cy, 0.05);
    const set = contoursAt(dtm, { intervalM: 1, levels: [0] });
    const verts = levelVertices(set, 0);
    expect(verts.length).toBeGreaterThan(0);
    // The zero level set of a(x² − y²) is the pair of lines y = ±x through the
    // centre. Every vertex must sit on one of them; the residual budget is the
    // planar one, since each branch is straight.
    for (const v of verts) {
      const dx = v.x - cx;
      const dy = v.y - cy;
      const offBranch = Math.min(Math.abs(dy - dx), Math.abs(dy + dx));
      expect(offBranch).toBeLessThan(PLANE_TOL);
    }
    // Both branches are present, and they meet at the critical point.
    const onPos = verts.filter((v) => Math.abs(v.y - cy - (v.x - cx)) < PLANE_TOL);
    const onNeg = verts.filter((v) => Math.abs(v.y - cy + (v.x - cx)) < PLANE_TOL);
    expect(onPos.length).toBeGreaterThan(4);
    expect(onNeg.length).toBeGreaterThan(4);
    const nearCentre = verts.filter((v) => Math.hypot(v.x - cx, v.y - cy) < CELL);
    expect(nearCentre.length).toBeGreaterThan(0);
  });
});

// ── 2. level-set membership ────────────────────────────────────────────────

describe('contour correctness — level-set membership', () => {
  const cases: Array<[string, ReturnType<typeof surfaceGrid>, number]> = [
    ['cone', coneGrid(41, 41, 20.5, 20.5), 5],
    ['paraboloid', paraboloidGrid(51, 51, 25.5, 25.5, 0.02), 2],
    ['saddle', saddleGrid(41, 41, 20.5, 20.5, 0.05), 2],
    ['plane', planeGrid(40, 20, 0.5), 2],
  ];

  for (const [name, dtm, interval] of cases) {
    it(`every ${name} vertex interpolates to its own level on the source grid`, () => {
      const set = contoursAt(dtm, { intervalM: interval });
      let checked = 0;
      for (const level of set.levels) {
        for (const v of levelVertices(set, level.value)) {
          const z = bilinearAt(dtm, v.x, v.y);
          expect(Number.isFinite(z)).toBe(true);
          expect(Math.abs(z - level.value)).toBeLessThan(MEMBERSHIP_TOL);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(50);
    });
  }

  it('membership survives stitching, styling and the feature model', () => {
    const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
    const set = contoursAt(dtm, { intervalM: 2 });
    const model = modelFor(dtm, set);
    expect(model.features.length).toBeGreaterThan(0);
    for (const f of model.features) {
      for (const [x, y] of f.coordinates) {
        expect(Math.abs(bilinearAt(dtm, x, y) - f.value)).toBeLessThan(MEMBERSHIP_TOL);
      }
    }
  });
});

// ── 3. topological invariants ──────────────────────────────────────────────

describe('contour correctness — topological invariants', () => {
  it('no contour dangles inside the domain (odd-degree nodes only on the boundary)', () => {
    const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
    const set = contoursAt(dtm, { intervalM: 2 });
    const rect = tracedDomain(dtm);
    const q = quantumForCellSize(dtm.cellSizeM);
    for (const level of set.levels) {
      const odd = oddDegreeNodes(level.segments, q);
      const interior = odd.filter((p) => !onRectBoundary(p, rect, CELL * ENDPOINT_QUANTUM_CELLS));
      expect(interior).toEqual([]);
    }
  });

  it('an open contour terminates on the grid boundary, a closed one loops', () => {
    // A plane's contours run clean across the grid: every polyline is open and
    // both its ends must land on the traced rectangle.
    const dtm = planeGrid(30, 12, 0.5);
    const set = contoursAt(dtm, { intervalM: 2 });
    const rect = tracedDomain(dtm);
    const stitched = stitchContourSet(set, dtm.cellSizeM);
    let open = 0;
    for (const level of stitched) {
      for (const poly of level.polylines) {
        if (poly.closed) continue;
        open += 1;
        const first = poly.vertices[0];
        const last = poly.vertices[poly.vertices.length - 1];
        for (const p of [first, last] as Pt[]) {
          expect(onRectBoundary(p, rect, CELL * ENDPOINT_QUANTUM_CELLS)).toBe(true);
        }
      }
    }
    expect(open).toBeGreaterThan(3);

    // A dome's contours close: the ring's ends coincide.
    const dome = paraboloidGrid(51, 51, 25.5, 25.5, -0.02);
    const domeSet = contoursAt(dome, { intervalM: 2, levels: [-4, -8] });
    const domeStitched = stitchContourSet(domeSet, dome.cellSizeM);
    let closed = 0;
    for (const level of domeStitched) {
      for (const poly of level.polylines) if (poly.closed) closed += 1;
    }
    expect(closed).toBeGreaterThan(0);
  });

  it('a level exactly on the saddle value produces no interior free end', () => {
    // Two peaks joined by a col. The level is set exactly at the col height,
    // the marching-squares ambiguous case: whichever way each saddle cell is
    // resolved, the result must still be a closed curve system.
    const peak = (x: number, y: number, px: number, py: number) =>
      12 * Math.exp(-(((x - px) ** 2 + (y - py) ** 2) / 60));
    const zfn = (col: number, row: number) => {
      const x = col + 0.5;
      const y = row + 0.5;
      return peak(x, y, 15, 25) + peak(x, y, 35, 25);
    };
    const dtm = surfaceGrid(zfn, { cols: 51, rows: 51, cellSizeM: CELL });
    const colHeight = zfn(24, 24); // the saddle cell value between the peaks
    const rect = tracedDomain(dtm);
    const q = quantumForCellSize(dtm.cellSizeM);
    for (const level of [colHeight, colHeight - 1e-6, colHeight + 1e-6]) {
      const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
      const segments = set.levels[0].segments;
      expect(segments.length).toBeGreaterThan(10);
      const odd = oddDegreeNodes(segments, q);
      expect(odd.filter((p) => !onRectBoundary(p, rect, CELL * ENDPOINT_QUANTUM_CELLS))).toEqual(
        [],
      );
      for (const v of levelVertices(set, level)) {
        expect(Math.abs(bilinearAt(dtm, v.x, v.y) - level)).toBeLessThan(MEMBERSHIP_TOL);
      }
    }
  });

  it('an ambiguous cell separates the high corners on the analytic side of the saddle', () => {
    // One marching square, corners (BL, BR, TR, TL) = (10, 0, 3, 2.9). The
    // bilinear saddle value is z* = (v0·v2 − v1·v3) / (v0 + v2 − v1 − v3)
    // = 30 / 10.1 = 2.9703…, so the {z ≥ level} region contains the cell
    // centre only while level ≤ z*. Walking the BL→TR diagonal therefore
    // crosses the contour zero times below z* and twice above it. The corner
    // MEAN is 3.975 here, far from z*, so a cell-average decider gives the
    // wrong answer on one of these two levels.
    const zByIndex = [10, 0, 2.9, 3]; // row-major: [BL, BR], [TL, TR]
    const dtm = surfaceGrid((col, row) => zByIndex[row * 2 + col], {
      cols: 2,
      rows: 2,
      cellSizeM: CELL,
    });
    const zStar = (10 * 3 - 0 * 2.9) / (10 + 3 - 0 - 2.9);
    const diagonalCrossings = (level: number) => {
      const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
      let n = 0;
      for (const s of set.levels[0].segments) {
        if (
          properlyIntersect(
            { x: 0.5, y: 0.5 }, // BL cell centre (the high corner)
            { x: 1.5, y: 1.5 }, // TR cell centre (the other high corner)
            { x: s.x1, y: s.y1 },
            { x: s.x2, y: s.y2 },
          )
        ) {
          n += 1;
        }
      }
      return n;
    };
    expect(zStar).toBeGreaterThan(2.95);
    expect(zStar).toBeLessThan(3);
    // 2.99 sits above z* but strictly below the corner value 3, so neither
    // crossing degenerates onto a corner.
    expect(diagonalCrossings(2.95)).toBe(0); // level ≤ z*: high corners joined
    expect(diagonalCrossings(2.99)).toBe(2); // level > z*: high corners isolated
  });

  it('connectivity changes at the col: one ring below it, two above', () => {
    // Two Gaussian peaks joined by a col at z ≈ 4.53. Below the col the
    // {z ≥ level} region is one connected component, so its boundary is a
    // single ring; above it the two summits separate. Nothing but the
    // saddle-cell resolution decides which side of that transition a given
    // cell lands on, so this is the grid-scale consequence of the exact
    // bilinear rule.
    const peak = (x: number, y: number, px: number, py: number) =>
      12 * Math.exp(-(((x - px) ** 2 + (y - py) ** 2) / 60));
    const dtm = surfaceGrid(
      (col, row) => peak(col + 0.5, row + 0.5, 15, 25) + peak(col + 0.5, row + 0.5, 35, 25),
      { cols: 51, rows: 51, cellSizeM: CELL },
    );
    const ringsAt = (level: number) => {
      const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
      const stitched = stitchContourSet(set, dtm.cellSizeM);
      return stitched[0].polylines.filter((p) => p.closed && p.vertices.length > 8);
    };
    const below = ringsAt(4.0);
    const above = ringsAt(6.0);
    expect(below.length).toBe(1);
    expect(above.length).toBe(2);
    // The two upper rings are disjoint: neither contains a vertex of the other.
    const [a, b] = above.map((p) => p.vertices.map((v) => [v.x, v.y] as [number, number]));
    expect(a.some(([x, y]) => pointInRing({ x, y }, b))).toBe(false);
    expect(b.some(([x, y]) => pointInRing({ x, y }, a))).toBe(false);
    // Both upper rings sit inside the single lower one.
    const lower = below[0].vertices.map((v) => [v.x, v.y] as [number, number]);
    for (const ring of [a, b]) {
      for (const [x, y] of ring) expect(pointInRing({ x, y }, lower)).toBe(true);
    }
  });

  it('a contour reaching a no-data hole ends on the hole edge, not in open ground', () => {
    const cx = 20.5;
    const cy = 20.5;
    const hole = { c0: 14, c1: 20, r0: 14, r1: 20 };
    const inHole = (col: number, row: number) =>
      col >= hole.c0 && col <= hole.c1 && row >= hole.r0 && row <= hole.r1;
    const dtm = surfaceGrid(
      (col, row) => Math.hypot(col + 0.5 - cx, row + 0.5 - cy),
      {
        cols: 41,
        rows: 41,
        cellSizeM: CELL,
        coverageFn: (col, row) => (inHole(col, row) ? 0 : 2),
      },
    );
    const set = contoursAt(dtm, { intervalM: 2, levels: [8] });
    const rect = tracedDomain(dtm);
    const stitched = stitchContourSet(set, dtm.cellSizeM);
    let openEnds = 0;
    for (const level of stitched) {
      for (const poly of level.polylines) {
        if (poly.closed) continue;
        for (const p of [poly.vertices[0], poly.vertices[poly.vertices.length - 1]]) {
          openEnds += 1;
          const onDomain = onRectBoundary(p, rect, CELL * ENDPOINT_QUANTUM_CELLS);
          // The hole's traced margin: a cell whose corner is uncovered is never
          // traced, so an end may sit one cell outside the uncovered block.
          const nearHole =
            p.x >= hole.c0 - 0.5 - 1e-9 &&
            p.x <= hole.c1 + 1.5 + 1e-9 &&
            p.y >= hole.r0 - 0.5 - 1e-9 &&
            p.y <= hole.r1 + 1.5 + 1e-9;
          expect(onDomain || nearHole).toBe(true);
        }
      }
    }
    expect(openEnds).toBeGreaterThan(0);
  });

  it('contours of different levels never cross', () => {
    const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
    const set = contoursAt(dtm, { intervalM: 2 });
    const nonEmpty = set.levels.filter((l) => l.segments.length > 0);
    expect(nonEmpty.length).toBeGreaterThan(2);
    for (let i = 0; i < nonEmpty.length; i++) {
      for (let j = i + 1; j < nonEmpty.length; j++) {
        expect(crossingCount(nonEmpty[i].segments, nonEmpty[j].segments)).toBe(0);
      }
    }
  });

  it('nesting is monotone in elevation on a single dome', () => {
    // z = 10 − 0.02·r² : one summit, so each higher level's ring must lie
    // strictly inside the ring below it.
    const cx = 25.5;
    const cy = 25.5;
    const dtm = surfaceGrid(
      (col, row) => 10 - 0.02 * ((col + 0.5 - cx) ** 2 + (row + 0.5 - cy) ** 2),
      { cols: 51, rows: 51, cellSizeM: CELL },
    );
    const set = contoursAt(dtm, { intervalM: 2, levels: [2, 4, 6, 8] });
    const model = modelFor(dtm, set);
    const ringFor = (value: number) => {
      const f = model.features.filter((x) => x.value === value);
      expect(f.length).toBe(1);
      return f[0].coordinates;
    };
    const values = [2, 4, 6, 8];
    for (let i = 1; i < values.length; i++) {
      const inner = ringFor(values[i]);
      const outer = ringFor(values[i - 1]);
      for (const [x, y] of inner) {
        expect(pointInRing({ x, y }, outer)).toBe(true);
      }
    }
  });
});

// ── 4. declared vs actual ──────────────────────────────────────────────────

describe('contour correctness — declared properties match the geometry', () => {
  it('the declared interval equals the actual spacing of adjacent levels', () => {
    for (const interval of [0.5, 1, 2.5]) {
      const dtm = coneGrid(41, 41, 20.5, 20.5);
      const set = contoursAt(dtm, { intervalM: interval });
      expect(set.intervalM).toBe(interval);
      const values = set.levels.map((l) => l.value);
      expect(values.length).toBeGreaterThan(1);
      for (let i = 1; i < values.length; i++) {
        // Levels are generated as first + k·interval, so the spacing is exact
        // to the float representation of the interval itself.
        expect(Math.abs(values[i] - values[i - 1] - interval)).toBeLessThan(interval * 1e-9);
      }
    }
  });

  it('an over-fine interval thins the levels and the declared interval follows', () => {
    // Input: a cone spanning ~0…14 with intervalM = 0.01 and the default
    // 200-level cap. Property: ContourSet.intervalM is the interval of the
    // levels that were EMITTED, and the requested value survives beside it.
    const dtm = coneGrid(41, 41, 20.5, 20.5);
    const requested = 0.01;
    const set = contoursAt(dtm, { intervalM: requested });
    expect(set.warnings.join(' ')).toContain('exceeds cap');
    expect(set.requestedIntervalM).toBe(requested);
    const values = set.levels.map((l) => l.value);
    expect(values.length).toBeLessThanOrEqual(200);
    const spacing = values[1] - values[0];
    expect(spacing).toBeGreaterThan(requested * 5);
    // The declared interval IS the emitted spacing.
    expect(set.intervalM).toBeCloseTo(spacing, 9);
    expect(set.intervalM).not.toBe(requested);
    // Both values reach the export: the emitted one under the name every
    // consumer reads, the requested one under its own name.
    const model = modelFor(dtm, set);
    expect(model.intervalM).toBe(set.intervalM);
    expect(model.requestedIntervalM).toBe(requested);
    const geo = toGeoJSON(model);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.intervalM).toBe(set.intervalM);
    expect(metadata.requestedIntervalM).toBe(requested);
    for (const f of geo.features as Array<{ properties: Record<string, unknown> }>) {
      expect(f.properties.interval).toBe(set.intervalM);
    }
    // Index classification is anchored to the emitted interval, so the kept
    // levels land on the round elevations a reader expects.
    const styled = styleLevels(values, { intervalM: set.intervalM! });
    expect(styled.levels.filter((l) => l.isIndex).length).toBeGreaterThan(0);
  });

  it('the emitted level set covers the data range and nothing beyond it', () => {
    // The base elevation is offset off any multiple of the interval, so the
    // first level has to be computed rather than landing on zero by luck.
    const dtm = surfaceGrid(
      (col, row) => 0.37 + Math.hypot(col + 0.5 - 20.5, row + 0.5 - 20.5),
      { cols: 41, rows: 41, cellSizeM: CELL },
    );
    const interval = 2;
    const set = contoursAt(dtm, { intervalM: interval });
    const values = set.levels.map((l) => l.value);
    expect(values[0]).toBeGreaterThanOrEqual(set.minZ);
    expect(values[0] - interval).toBeLessThan(set.minZ);
    expect(values[values.length - 1]).toBeLessThanOrEqual(set.maxZ);
    expect(values[values.length - 1] + interval).toBeGreaterThan(set.maxZ);
  });

  it('the declared level count equals the emitted count', () => {
    const dtm = coneGrid(41, 41, 20.5, 20.5);
    const set = contoursAt(dtm, { intervalM: 1 });
    const stitched = stitchContourSet(set, dtm.cellSizeM);
    expect(stitched.length).toBe(set.levels.length);
    const model = modelFor(dtm, set);
    const geo = toGeoJSON(model);
    expect((geo.features as unknown[]).length).toBe(model.features.length);
    const declaredValues = new Set(set.levels.map((l) => l.value));
    for (const f of model.features) expect(declaredValues.has(f.value)).toBe(true);
  });

  it('the declared bbox contains every coordinate and is tight', () => {
    const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
    const model = modelFor(dtm, contoursAt(dtm, { intervalM: 2 }));
    const bbox = model.bbox;
    expect(bbox).not.toBeNull();
    if (!bbox) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const f of model.features) {
      for (const [x, y] of f.coordinates) {
        expect(x).toBeGreaterThanOrEqual(bbox.minX);
        expect(x).toBeLessThanOrEqual(bbox.maxX);
        expect(y).toBeGreaterThanOrEqual(bbox.minY);
        expect(y).toBeLessThanOrEqual(bbox.maxY);
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
    }
    expect(bbox.minX).toBe(minX);
    expect(bbox.maxX).toBe(maxX);
    expect(bbox.minY).toBe(minY);
    expect(bbox.maxY).toBe(maxY);
    // The geometry stays inside the traced lattice of cell centres.
    const rect = tracedDomain(dtm);
    expect(bbox.minX).toBeGreaterThanOrEqual(rect.minX - 1e-9);
    expect(bbox.maxX).toBeLessThanOrEqual(rect.maxX + 1e-9);
  });

  it('the GeoJSON interval property matches the set interval on every feature', () => {
    const dtm = coneGrid(41, 41, 20.5, 20.5);
    const set = contoursAt(dtm, { intervalM: 2.5 });
    const model = modelFor(dtm, set);
    const geo = toGeoJSON(model);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.intervalM).toBe(2.5);
    for (const f of geo.features as Array<Record<string, unknown>>) {
      const props = f.properties as Record<string, unknown>;
      expect(props.interval).toBe(2.5);
    }
  });

  it('the native GeoJSON third ordinate equals the feature elevation', () => {
    const dtm = coneGrid(21, 21, 10.5, 10.5);
    const model = modelFor(dtm, contoursAt(dtm, { intervalM: 2 }));
    const geo = toGeoJSON(model);
    for (const f of geo.features as Array<Record<string, unknown>>) {
      const props = f.properties as Record<string, unknown>;
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) {
        expect(c.length).toBe(3);
        expect(c[2]).toBe(props.elevation);
      }
    }
  });
});

// ── the documented third-ordinate unit gap ─────────────────────────────────

describe('contour correctness — the documented third-ordinate unit gap', () => {
  const identityLonLat = (p: readonly [number, number, number]): [number, number, number] => [
    p[0],
    p[1],
    p[2],
  ];

  function footModel(verticalDatum: string | null): ContourFeatureModel {
    // Heights in US survey feet (0.3048006… m per unit); the horizontal grid is
    // irrelevant to the ordinate question.
    const dtm = surfaceGrid((col) => 0.5 * (col + 0.5), {
      cols: 30,
      rows: 8,
      cellSizeM: CELL,
      verticalDatum,
      verticalUnitToMetres: 0.3048,
    });
    return modelFor(dtm, contoursAt(dtm, { intervalM: 2 }));
  }

  it('RFC 7946 output is 2D when the vertical reference is not WGS 84 ellipsoidal', () => {
    const geo = toGeoJSONWgs84(footModel('EPSG:5703'), identityLonLat);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.elevationIn3d).toBe(false);
    for (const f of geo.features as Array<Record<string, unknown>>) {
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) expect(c.length).toBe(2);
      expect((f.properties as Record<string, unknown>).elevationUnit).toBe('foot');
    }
  });

  it('EPSG:4979 with a foot vertical factor writes the METRE equivalent into the ordinate', () => {
    // RFC 7946 §3.1.1 fixes the third position element as metres above the WGS
    // 84 ellipsoid. The source elevation is in feet, so the ordinate carries
    // elevation × 0.3048 while the property keeps the source value and names
    // its own unit.
    const geo = toGeoJSONWgs84(footModel('EPSG:4979'), identityLonLat);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.elevationIn3d).toBe(true);
    expect(metadata.elevationOrdinateUnit).toBe('metre');
    const features = geo.features as Array<Record<string, unknown>>;
    expect(features.length).toBeGreaterThan(0);
    for (const f of features) {
      const props = f.properties as Record<string, unknown>;
      expect(props.elevationUnit).toBe('foot');
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) {
        expect(c.length).toBe(3);
        expect(c[2]).toBeCloseTo((props.elevation as number) * 0.3048, 9);
      }
    }
  });

  it('EPSG:4979 with an unresolved vertical factor falls back to 2D', () => {
    // Without a factor the metre value cannot be computed, and an unconverted
    // ordinate would assert metres about a number of unknown unit.
    const model = { ...footModel('EPSG:4979'), verticalUnitToMetres: null };
    const geo = toGeoJSONWgs84(model, identityLonLat);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.elevationIn3d).toBe(false);
    expect(metadata.elevationNote).toMatch(/vertical unit/i);
    for (const f of geo.features as Array<Record<string, unknown>>) {
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) expect(c.length).toBe(2);
    }
  });

  it('EPSG:4979 already in metres leaves the ordinate equal to the elevation', () => {
    const dtm = surfaceGrid((col) => 0.5 * (col + 0.5), {
      cols: 30,
      rows: 8,
      cellSizeM: CELL,
      verticalDatum: 'EPSG:4979',
      verticalUnitToMetres: 1,
    });
    const geo = toGeoJSONWgs84(modelFor(dtm, contoursAt(dtm, { intervalM: 2 })), identityLonLat);
    for (const f of geo.features as Array<Record<string, unknown>>) {
      const props = f.properties as Record<string, unknown>;
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) expect(c[2]).toBe(props.elevation);
    }
  });

  it('the native writer writes the third ordinate unconditionally, in source units', () => {
    // The native (non-RFC) file has no ellipsoidal-height gate at all: a foot
    // elevation on an orthometric datum still rides in the coordinate Z.
    const geo = toGeoJSON(footModel('EPSG:5703'));
    const features = geo.features as Array<Record<string, unknown>>;
    for (const f of features) {
      const geom = f.geometry as { coordinates: number[][] };
      for (const c of geom.coordinates) expect(c.length).toBe(3);
    }
    // And with no provenance argument the file carries no unit token at all:
    // `intervalM` names metres while the value is 2 feet, and neither the
    // metadata nor any feature states the elevation unit.
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.intervalM).toBe(2);
    expect(Object.keys(metadata)).not.toContain('intervalUnit');
    expect(Object.keys(metadata)).not.toContain('contourIntervalUnit');
    expect(Object.keys(metadata)).not.toContain('elevationUnit');
    for (const f of features) {
      expect(Object.keys(f.properties as Record<string, unknown>)).not.toContain('elevationUnit');
    }
  });

  it('the native writer states the interval unit only when provenance is supplied', () => {
    // `contourDownload` passes `opts.provenance` through, and it is optional.
    // With it, the unit is recoverable from `contourIntervalUnit` — while the
    // two interval keys are still named for metres and hold feet.
    const provenance = {
      software: 'OpenLiDARViewer',
      softwareVersion: '0.0.0-test',
      build: null,
      metricVersion: 'test',
      generated: '1970-01-01T00:00:00.000Z',
      source: null,
      horizontalCrs: 'EPSG:32610',
      crsKnown: true,
      verticalDatum: 'EPSG:5703',
      datumKnown: true,
      coverageMode: 'full',
      contourIntervalM: 2,
      contourIntervalUnit: 'ft',
      contourStyle: 'crisp',
      contourStyleLabel: 'Crisp',
      contourMethod: null,
      deliverablePurpose: null,
      surfaceQuality: null,
      exportReadiness: null,
      exportReason: null,
      accuracy: null,
      complexity: null,
      pointDensityPerM2: null,
      measuredCells: null,
      totalCells: null,
      classScope: null,
      warnings: [],
      notSurveyGrade: 'Not survey-grade unless validated against ground-truth control.',
      exportPermit: null,
    } as unknown as Parameters<typeof toGeoJSON>[1];
    const geo = toGeoJSON(footModel('EPSG:5703'), provenance);
    const metadata = geo.metadata as Record<string, unknown>;
    expect(metadata.contourIntervalUnit).toBe('ft');
    expect(metadata.contourIntervalM).toBe(2);
    expect(metadata.intervalM).toBe(2);
  });
});

// ── 5. degenerate inputs ───────────────────────────────────────────────────

describe('contour correctness — degenerate inputs', () => {
  it('a flat surface emits no contour geometry', () => {
    const dtm = surfaceGrid(() => 10, { cols: 20, rows: 20, cellSizeM: CELL });
    const set = contoursAt(dtm, { intervalM: 5 });
    expect(set.minZ).toBe(10);
    expect(set.maxZ).toBe(10);
    const segments = allSegments(set);
    expect(segments).toEqual([]);
    const model = modelFor(dtm, set);
    expect(model.features).toEqual([]);
    expect(model.bbox).toBeNull();
    expect(set.levels.length).toBe(1);
    expect(set.levels[0].value).toBe(10);
    // The set says WHY it is empty, in the same shape the all-gap path uses,
    // so a consumer never has to count segments to learn the surface is flat.
    expect(set.warnings.join(' ')).toContain('flat surface');
  });

  it('a range that falls between adjacent levels says so', () => {
    // z spans 10.2 … 10.8 with a 5 m interval: no level lies inside the range,
    // so the surface is effectively flat at this interval and produces nothing.
    const dtm = surfaceGrid((col) => 10.2 + (col % 4) * 0.2, {
      cols: 20,
      rows: 20,
      cellSizeM: CELL,
    });
    const set = contoursAt(dtm, { intervalM: 5 });
    expect(allSegments(set)).toEqual([]);
    expect(set.warnings.join(' ')).toContain('no contours');
    expect(set.warnings.join(' ')).not.toContain('flat surface');
  });

  it('a surface entirely below the requested levels emits nothing', () => {
    const dtm = coneGrid(21, 21, 10.5, 10.5); // z spans 0 … ~14
    const below = contoursAt(dtm, { intervalM: 10, levels: [100, 110] });
    expect(allSegments(below)).toEqual([]);
    const above = contoursAt(dtm, { intervalM: 10, levels: [-100, -50] });
    expect(allSegments(above)).toEqual([]);
    // The range is still reported honestly.
    expect(below.minZ).toBeCloseTo(0, 6);
    expect(below.maxZ).toBeGreaterThan(13);
  });

  it('a level exactly on a plateau stays on the plateau edge and does not dangle', () => {
    // Half the grid is a plateau at exactly 10; the other half ramps below it.
    const level = 10;
    const dtm = surfaceGrid(
      (col) => (col >= 10 ? level : level - (10 - col)),
      { cols: 24, rows: 12, cellSizeM: CELL },
    );
    const set = contoursAt(dtm, { intervalM: 1, levels: [level] });
    const segments = set.levels[0].segments;
    expect(segments.length).toBeGreaterThan(0);
    // Membership: the plateau boundary is at the ramp's last cell centre.
    for (const v of levelVertices(set, level)) {
      expect(Math.abs(bilinearAt(dtm, v.x, v.y) - level)).toBeLessThan(MEMBERSHIP_TOL);
    }
    // No interior free ends.
    const rect = tracedDomain(dtm);
    const odd = oddDegreeNodes(segments, quantumForCellSize(dtm.cellSizeM));
    expect(odd.filter((p) => !onRectBoundary(p, rect, CELL * ENDPOINT_QUANTUM_CELLS))).toEqual([]);
    // The interior of the plateau carries no contour: nothing beyond the first
    // plateau column, whose cell centre is at x = 10.5.
    for (const v of levelVertices(set, level)) expect(v.x).toBeLessThanOrEqual(10.5 + 1e-9);
  });

  it('NaN cells break the contour instead of being traced through', () => {
    const cx = 20.5;
    const cy = 20.5;
    const hole = { c0: 14, c1: 20, r0: 14, r1: 20 };
    const dtm = surfaceGrid(
      (col, row) =>
        col >= hole.c0 && col <= hole.c1 && row >= hole.r0 && row <= hole.r1
          ? Number.NaN
          : Math.hypot(col + 0.5 - cx, row + 0.5 - cy),
      { cols: 41, rows: 41, cellSizeM: CELL },
    );
    const set = contoursAt(dtm, { intervalM: 2, levels: [4, 8] });
    const segments = allSegments(set);
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) {
      for (const c of [s.x1, s.y1, s.x2, s.y2]) expect(Number.isFinite(c)).toBe(true);
    }
    // No vertex inside the NaN block's cell-centre extent.
    for (const s of segments) {
      for (const [x, y] of [
        [s.x1, s.y1],
        [s.x2, s.y2],
      ]) {
        const insideHole =
          x > hole.c0 + 0.5 && x < hole.c1 + 0.5 && y > hole.r0 + 0.5 && y < hole.r1 + 0.5;
        expect(insideHole).toBe(false);
      }
    }
    // The level range itself excludes the NaN cells rather than absorbing them.
    expect(Number.isFinite(set.minZ)).toBe(true);
    expect(Number.isFinite(set.maxZ)).toBe(true);
  });

  it('an all-gap grid produces no levels and says why', () => {
    const dtm = surfaceGrid(() => 5, {
      cols: 10,
      rows: 10,
      cellSizeM: CELL,
      coverageFn: () => 0,
    });
    const set = contoursAt(dtm, { intervalM: 1 });
    expect(set.levels).toEqual([]);
    expect(set.warnings.join(' ')).toContain('insufficient covered cells');
    expect(Number.isNaN(set.minZ)).toBe(true);
  });
});

// ── 6. generalization ──────────────────────────────────────────────────────

describe('contour correctness — generalization stays within its tolerance', () => {
  const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
  const model = modelFor(dtm, contoursAt(dtm, { intervalM: 2 }));

  it('every original vertex stays within the declared tolerance of the simplified line', () => {
    const tol = 0.5; // source units — half a cell
    const analytical = analyticalProduct(model.features);
    const product = cartographicProduct(analytical, {
      toleranceSource: tol,
      horizontalUnit: knownUnit(1),
    });
    expect(product.features.length).toBe(analytical.features.length);
    // Recomputed independently of the record the generalizer wrote.
    let worst = 0;
    for (let i = 0; i < analytical.features.length; i++) {
      const before = analytical.features[i].coordinates;
      const after = product.features[i].coordinates;
      for (const p of before) worst = Math.max(worst, distanceToPolyline(p, after));
    }
    expect(worst).toBeLessThanOrEqual(tol);
    const record = product.generalization;
    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.toleranceSource).toBe(tol);
    expect(Math.abs(record.maxDisplacementSource - worst)).toBeLessThan(1e-9);
    expect(record.maxDisplacementSource).toBeLessThanOrEqual(tol);
  });

  it('simplification introduces no self-intersection and preserves the feature set', () => {
    const analytical = analyticalProduct(model.features);
    for (const tol of [0.25, 0.5, 1, 2]) {
      const product = cartographicProduct(analytical, {
        toleranceSource: tol,
        horizontalUnit: knownUnit(1),
      });
      expect(product.features.length).toBe(analytical.features.length);
      for (let i = 0; i < product.features.length; i++) {
        expect(product.features[i].value).toBe(analytical.features[i].value);
        expect(product.features[i].closed).toBe(analytical.features[i].closed);
        expect(selfIntersections(product.features[i].coordinates)).toBe(0);
      }
      // The analytical product is not mutated by deriving from it.
      expect(analyticalProduct(model.features).contentHash).toBe(analytical.contentHash);
    }
  });

  it('generalized levels still do not cross each other', () => {
    const analytical = analyticalProduct(model.features);
    const product = cartographicProduct(analytical, {
      toleranceSource: 1,
      horizontalUnit: knownUnit(1),
    });
    const byValue = new Map<number, Array<{ x1: number; y1: number; x2: number; y2: number }>>();
    for (const f of product.features) {
      const segs = byValue.get(f.value) ?? [];
      for (let i = 0; i + 1 < f.coordinates.length; i++) {
        segs.push({
          x1: f.coordinates[i][0],
          y1: f.coordinates[i][1],
          x2: f.coordinates[i + 1][0],
          y2: f.coordinates[i + 1][1],
        });
      }
      byValue.set(f.value, segs);
    }
    const values = [...byValue.keys()].sort((a, b) => a - b);
    for (let i = 1; i < values.length; i++) {
      const a = byValue.get(values[i - 1]) ?? [];
      const b = byValue.get(values[i]) ?? [];
      expect(
        crossingCount(
          a as never,
          b as never,
        ),
      ).toBe(0);
    }
  });

  it('the terrain-adaptive tolerance stays inside its declared band', () => {
    const analytical = analyticalProduct(model.features);
    const base = 0.5;
    const product = terrainAwareCartographicProduct(analytical, {
      baseToleranceSource: base,
      horizontalUnit: knownUnit(1),
    });
    // The per-feature factor is bounded to [0.25, 2], so no vertex may move
    // further than 2 × the base tolerance.
    let worst = 0;
    for (let i = 0; i < analytical.features.length; i++) {
      for (const p of analytical.features[i].coordinates) {
        worst = Math.max(worst, distanceToPolyline(p, product.features[i].coordinates));
      }
    }
    expect(worst).toBeLessThanOrEqual(2 * base);
    expect(product.sourceAnalyticalHash).toBe(analytical.contentHash);
  });
});

// ── 7. negative controls ───────────────────────────────────────────────────

describe('contour correctness — negative controls', () => {
  const dtm = paraboloidGrid(51, 51, 25.5, 25.5, 0.02);
  const set = contoursAt(dtm, { intervalM: 2 });

  it('the membership check rejects a deliberately wrong level set', () => {
    // Same geometry, claimed at level + half an interval. If membership passed
    // here it would be measuring nothing.
    let failures = 0;
    for (const level of set.levels) {
      for (const v of levelVertices(set, level.value)) {
        if (Math.abs(bilinearAt(dtm, v.x, v.y) - (level.value + 1)) >= MEMBERSHIP_TOL) {
          failures += 1;
        }
      }
    }
    expect(failures).toBeGreaterThan(50);
  });

  it('the membership check rejects a vertex displaced across the surface', () => {
    const level = set.levels.find((l) => l.segments.length > 0);
    expect(level).toBeDefined();
    if (!level) return;
    const v = levelVertices(set, level.value)[0];
    // A one-cell radial shift on a paraboloid changes the height by ≫ the
    // membership tolerance.
    const shifted = bilinearAt(dtm, v.x + 1, v.y + 1);
    expect(Math.abs(shifted - level.value)).toBeGreaterThan(MEMBERSHIP_TOL);
  });

  it('the dangling-end check flags a hand-made free end', () => {
    const q = quantumForCellSize(1);
    const seg = (x1: number, y1: number, x2: number, y2: number) => ({
      x1,
      y1,
      x2,
      y2,
      confidence: 100,
      grade: 'solid' as const,
    });
    // A closed triangle has no odd node; adding one spur creates exactly two.
    const closedLoop = [seg(0, 0, 1, 0), seg(1, 0, 1, 1), seg(1, 1, 0, 0)];
    expect(oddDegreeNodes(closedLoop, q)).toEqual([]);
    const withSpur = [...closedLoop, seg(1, 1, 2, 2)];
    expect(oddDegreeNodes(withSpur, q).length).toBe(2);
  });

  it('the crossing check flags two segments that genuinely cross', () => {
    expect(
      properlyIntersect({ x: 0, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }, { x: 2, y: 0 }),
    ).toBe(true);
    // Touching at a shared endpoint is not a crossing.
    expect(
      properlyIntersect({ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 0 }),
    ).toBe(false);
  });

  it('the nesting check rejects a reversed containment order', () => {
    const outer: Array<[number, number]> = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ];
    const inner: Array<[number, number]> = [
      [4, 4],
      [6, 4],
      [6, 6],
      [4, 6],
    ];
    expect(inner.every(([x, y]) => pointInRing({ x, y }, outer))).toBe(true);
    expect(outer.every(([x, y]) => pointInRing({ x, y }, inner))).toBe(false);
  });

  it('the displacement check fails at a tolerance the geometry does not meet', () => {
    const model = modelFor(dtm, set);
    const analytical = analyticalProduct(model.features);
    const product = cartographicProduct(analytical, {
      toleranceSource: 1,
      horizontalUnit: knownUnit(1),
    });
    const record = product.generalization;
    expect(record).not.toBeNull();
    if (!record) return;
    expect(record.maxDisplacementSource).toBeGreaterThan(0);
    // A tenth of the tolerance the pass actually ran at must not be satisfied.
    expect(record.maxDisplacementSource).toBeGreaterThan(0.1);
  });

  it('the self-intersection check flags a bow-tie ring', () => {
    const bowtie: Array<[number, number]> = [
      [0, 0],
      [2, 2],
      [2, 0],
      [0, 2],
      [0, 0],
    ];
    expect(selfIntersections(bowtie)).toBeGreaterThan(0);
  });

  it('the stitcher covers every input segment exactly once', () => {
    const level = set.levels.find((l) => l.segments.length > 10);
    expect(level).toBeDefined();
    if (!level) return;
    const polys = stitchLevel(level.value, level.segments, quantumForCellSize(dtm.cellSizeM));
    let edges = 0;
    for (const p of polys) edges += p.closed ? p.vertices.length : p.vertices.length - 1;
    expect(edges).toBe(level.segments.length);
  });
});
