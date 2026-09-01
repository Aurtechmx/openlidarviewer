/**
 * stockpileAreaGrid.test.ts — the area-weighted stockpile volume against
 * ANALYTIC truth and adversarial cases, not against its own control flow.
 *
 * The method integrates V = Σ_c A_c·max(0, z_surf,c − z_base,c) over a regular
 * grid, weighting horizontal AREA rather than point count. The tests pin:
 *   - closed-form shapes (prism, ramp, pyramid, cone) within raster tolerance;
 *   - the property the whole method exists for — density-gradient invariance;
 *   - coverage honesty (a missing quadrant is unobserved, not zero);
 *   - order / unit / translation invariance;
 *   - the Sutherland–Hodgman cell clip against analytic areas.
 */

import { describe, it, expect } from 'vitest';
import {
  stockpileAreaGrid,
  clippedCellArea,
  deriveCellSize,
  type AreaGridPoint,
  type Vec2,
} from '../src/render/measure/stockpileAreaGrid';

/** A square footprint [0,S]×[0,S]. */
function square(S: number): Vec2[] {
  return [
    { x: 0, y: 0 },
    { x: S, y: 0 },
    { x: S, y: S },
    { x: 0, y: S },
  ];
}

/** A dense n×n grid of points over [0,S]×[0,S] with height from `zf(x,y)`. */
function sample(S: number, n: number, zf: (x: number, y: number) => number): AreaGridPoint[] {
  const pts: AreaGridPoint[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ((i + 0.5) / n) * S;
      const y = ((j + 0.5) / n) * S;
      pts.push({ x, y, z: zf(x, y) });
    }
  }
  return pts;
}

const flatBase = { kind: 'constant', zM: 0 } as const;

describe('stockpileAreaGrid — analytic shapes', () => {
  it('rectangular prism: V = A·h', () => {
    const S = 10, h = 5;
    const r = stockpileAreaGrid({
      points: sample(S, 60, () => h),
      polygon: square(S),
      base: flatBase,
      cellSizeM: 0.5,
    });
    expect(r.fillM3).toBeCloseTo(S * S * h, 0); // 500 m³, tight (flat top)
    expect(r.cutM3).toBe(0);
    expect(r.coverage).toBe('measured');
    expect(r.supportFraction).toBeGreaterThan(0.99);
  });

  it('planar ramp: V = A·h/2', () => {
    const S = 10, h = 6;
    const r = stockpileAreaGrid({
      points: sample(S, 80, (x) => (x / S) * h), // 0 → h across x
      polygon: square(S),
      base: flatBase,
      cellSizeM: 0.25,
    });
    expect(r.fillM3).toBeCloseTo((S * S * h) / 2, 0); // 300 m³
  });

  it('square pyramid: V = A·h/3', () => {
    const S = 10, h = 9, c = S / 2;
    // z = h·(1 − max(|x−c|,|y−c|)/c): a pyramid peaking at the centre.
    const r = stockpileAreaGrid({
      points: sample(S, 120, (x, y) => h * (1 - Math.max(Math.abs(x - c), Math.abs(y - c)) / c)),
      polygon: square(S),
      base: flatBase,
      cellSizeM: 0.1,
    });
    expect(r.fillM3).toBeCloseTo((S * S * h) / 3, -1); // 300 m³, within raster tol
  });

  it('cone: V = (1/3)·π·R²·h', () => {
    const R = 6, h = 9, c = R; // disc of radius R centred at (R,R) in a 2R box
    const inCircle = (x: number, y: number): boolean => Math.hypot(x - c, y - c) <= R;
    // Circular footprint approximated by a 48-gon.
    const poly: Vec2[] = [];
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * 2 * Math.PI;
      poly.push({ x: c + R * Math.cos(a), y: c + R * Math.sin(a) });
    }
    const pts = sample(2 * R, 160, (x, y) => (inCircle(x, y) ? h * (1 - Math.hypot(x - c, y - c) / R) : 0))
      .filter((p) => inCircle(p.x, p.y));
    const r = stockpileAreaGrid({ points: pts, polygon: poly, base: flatBase, cellSizeM: 0.15 });
    const expected = (1 / 3) * Math.PI * R * R * h; // ≈ 339.29 m³
    expect(r.fillM3).toBeGreaterThan(expected * 0.95);
    expect(r.fillM3).toBeLessThan(expected * 1.05);
  });
});

describe('stockpileAreaGrid — the anti-bias property', () => {
  it('is invariant to a density gradient (the whole point of area weighting)', () => {
    const S = 10, h = 4;
    const uniform = sample(S, 40, () => h);
    // The same flat surface, but 10× denser on the right half.
    const dense: AreaGridPoint[] = [...uniform];
    for (const p of uniform) if (p.x > S / 2) for (let k = 0; k < 9; k++) dense.push(p);

    const a = stockpileAreaGrid({ points: uniform, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    const b = stockpileAreaGrid({ points: dense, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    // Area weighting: each cell's median is h regardless of how many points hit it.
    expect(b.fillM3).toBeCloseTo(a.fillM3, 6);
  });
});

describe('stockpileAreaGrid — coverage honesty', () => {
  it('a missing quadrant is unobserved, not zero, and downgrades coverage', () => {
    const S = 10, h = 5;
    const pts = sample(S, 60, () => h).filter((p) => !(p.x > S / 2 && p.y > S / 2));
    const r = stockpileAreaGrid({ points: pts, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    // Three quadrants supported → ~75% coverage, and the volume covers only them.
    expect(r.supportFraction).toBeGreaterThan(0.7);
    expect(r.supportFraction).toBeLessThan(0.8);
    expect(r.unobservedAreaM2).toBeCloseTo((S * S) / 4, 0);
    expect(r.fillM3).toBeCloseTo(S * S * h * 0.75, 0); // supported area only
    expect(r.coverage).toBe('preview'); // 0.6 ≤ frac < 0.9
  });

  it('refuses coverage when most of the footprint is unobserved', () => {
    const S = 10, h = 5;
    // Only a thin strip near x=0 has points.
    const pts = sample(S, 60, () => h).filter((p) => p.x < S * 0.2);
    const r = stockpileAreaGrid({ points: pts, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    expect(r.supportFraction).toBeLessThan(0.6);
    expect(r.coverage).toBe('refused');
  });
});

describe('stockpileAreaGrid — invariances', () => {
  const S = 10, h = 5;
  const base = () => sample(S, 50, () => h);

  it('is invariant to point order', () => {
    const pts = base();
    const shuffled = [...pts].sort(() => 0.5 - ((pts.length * 2654435761) % 2)); // deterministic-ish reshuffle
    const a = stockpileAreaGrid({ points: pts, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    const b = stockpileAreaGrid({ points: shuffled, polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    expect(b.fillM3).toBeCloseTo(a.fillM3, 9);
  });

  it('is invariant to a large coordinate translation', () => {
    const T = 500_000;
    const a = stockpileAreaGrid({ points: base(), polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    const shifted = base().map((p) => ({ x: p.x + T, y: p.y + T, z: p.z }));
    const poly = square(S).map((v) => ({ x: v.x + T, y: v.y + T }));
    const b = stockpileAreaGrid({ points: shifted, polygon: poly, base: flatBase, cellSizeM: 0.5 });
    expect(b.fillM3).toBeCloseTo(a.fillM3, 6);
  });

  it('agrees across metre and foot representations after unit conversion', () => {
    const metres = stockpileAreaGrid({ points: base(), polygon: square(S), base: flatBase, cellSizeM: 0.5 });
    // Same geometry expressed in feet: coordinates ÷ 0.3048, unit factor 0.3048.
    const FT = 1 / 0.3048;
    const ptsFt = base().map((p) => ({ x: p.x * FT, y: p.y * FT, z: p.z * FT }));
    const polyFt = square(S).map((v) => ({ x: v.x * FT, y: v.y * FT }));
    const feet = stockpileAreaGrid({
      points: ptsFt,
      polygon: polyFt,
      base: { kind: 'constant', zM: 0 },
      cellSizeM: 0.5 * FT,
      linearUnitToMetres: 0.3048,
    });
    expect(feet.fillM3).toBeCloseTo(metres.fillM3, 0);
  });
});

describe('stockpileAreaGrid — base surface modes', () => {
  it('a tilted plane base cancels a matching tilted surface to ~zero volume', () => {
    const S = 10;
    // Surface z = 2 + 0.5x; base plane identical → no volume above base.
    const r = stockpileAreaGrid({
      points: sample(S, 60, (x) => 2 + 0.5 * x),
      polygon: square(S),
      base: { kind: 'plane', a: 0.5, b: 0, c: 2 },
      cellSizeM: 0.5,
    });
    expect(Math.abs(r.netM3)).toBeLessThan(1); // ~0 within cell-centre quadrature
  });
});

describe('clippedCellArea — Sutherland–Hodgman against analytic areas', () => {
  const S = 10;
  it('a cell fully inside the footprint clips to the full cell area', () => {
    expect(clippedCellArea(square(S), 2, 2, 3, 3)).toBeCloseTo(1, 9);
  });
  it('a cell fully outside clips to zero', () => {
    expect(clippedCellArea(square(S), 12, 12, 13, 13)).toBeCloseTo(0, 9);
  });
  it('a boundary cell clips to the overlap area', () => {
    // Cell [9,11]×[4,6] overlaps the footprint only on x∈[9,10] → area 1×2 = 2.
    expect(clippedCellArea(square(S), 9, 4, 11, 6)).toBeCloseTo(2, 9);
  });
  it('clips a rotated (diamond) footprint correctly', () => {
    const diamond: Vec2[] = [
      { x: 5, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 10 }, { x: 0, y: 5 },
    ]; // area = 50
    // A central cell fully inside the diamond → full area.
    expect(clippedCellArea(diamond, 4, 4, 6, 6)).toBeCloseTo(4, 9);
    // A corner cell entirely outside the diamond → 0.
    expect(clippedCellArea(diamond, 0, 0, 1, 1)).toBeCloseTo(0, 9);
  });
  it('handles a concave (L-shaped) footprint', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
      { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
    ];
    // A cell in the notch (the removed top-right) clips to zero.
    expect(clippedCellArea(L, 6, 6, 7, 7)).toBeCloseTo(0, 9);
    // A cell in the solid lower band clips to full.
    expect(clippedCellArea(L, 6, 1, 7, 2)).toBeCloseTo(1, 9);
  });
});

describe('stockpileAreaGrid — tilted base evaluated at the clipped centroid', () => {
  it('a single boundary cell over a right triangle matches the closed-form volume', () => {
    // Right triangle (0,0),(10,0),(0,10): area 50, centroid (10/3, 10/3).
    // One grid cell (cellSizeM larger than the footprint) makes the WHOLE
    // triangle a single boundary cell, so its clipped-polygon centroid is
    // the triangle centroid — while the grid-cell centre (bbox midpoint) is
    // (5, 5), a different point. Base z = x (a=1,b=0,c=0), flat top z = h.
    // Exact volume = ∫∫(h − x) dA = A·(h − x̄) since the base is linear.
    const tri: Vec2[] = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }];
    const A = 50;
    const xbar = 10 / 3;
    const h = 15;
    const exact = A * (h - xbar); // 1750/3 ≈ 583.333
    const cellCentreVolume = A * (h - 5); // what the OLD (bug) evaluation gives: 500

    const r = stockpileAreaGrid({
      points: sample(10, 60, () => h),
      polygon: tri,
      base: { kind: 'plane', a: 1, b: 0, c: 0 },
      cellSizeM: 20, // forces exactly one cell covering the whole footprint
    });

    expect(r.cells.length).toBe(1);
    expect(r.fillM3).toBeCloseTo(exact, 1);
    // The centroid-correct answer is measurably different from the
    // cell-centre evaluation the bug produced (≈83 m³ off here).
    expect(Math.abs(r.fillM3 - cellCentreVolume)).toBeGreaterThan(50);
  });
});

describe('stockpileAreaGrid — point-in-polygon filtering', () => {
  it('excludes a bbox-inside, polygon-outside point from a concave (L-shaped) footprint', () => {
    const L: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 4 },
      { x: 4, y: 4 }, { x: 4, y: 10 }, { x: 0, y: 10 },
    ];
    // Cell [3,6)×[3,6): the x<4 half is inside the L (left column extends to
    // y=10), the x>=4,y>=4 corner is the removed notch. A contaminant point
    // sits in the notch — inside this cell's bounding box, outside the polygon.
    const legit: AreaGridPoint[] = [
      { x: 3.2, y: 3.3, z: 1 },
      { x: 3.6, y: 5.5, z: 1 },
      { x: 3.9, y: 3.9, z: 1 },
    ];
    const contaminant: AreaGridPoint = { x: 4.5, y: 5.5, z: 1000 };

    const r = stockpileAreaGrid({
      points: [...legit, contaminant],
      polygon: L,
      base: flatBase,
      cellSizeM: 3,
      minSupportPerCell: 1,
    });

    const cell = r.cells.find((c) => c.ix === 1 && c.iy === 1);
    expect(cell).toBeDefined();
    // Only the 3 legitimate points contributed — the notch point was rejected.
    expect(cell!.support).toBe(3);
    expect(cell!.surfaceZ).toBeCloseTo(1, 9);
  });
});

describe('deriveCellSize', () => {
  it('scales with point spacing and clamps to bounds', () => {
    // 400 points over 100 m² → spacing 0.5 m → ×2.5 = 1.25 m.
    expect(deriveCellSize(100, 400)).toBeCloseTo(1.25, 6);
    // Clamps: a tiny cloud does not produce an unbounded cell.
    expect(deriveCellSize(1e9, 1, 0.05, 50)).toBe(50);
    expect(deriveCellSize(0, 0)).toBe(50); // degenerate → max
  });
});
