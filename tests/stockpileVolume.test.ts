import { describe, test, expect } from 'vitest';
import { stockpileVolume } from '../src/render/measure/stockpileVolume';
import type { Vec3 } from '../src/render/navMath';

/** Square footprint [0,0]–[size,size] on the z=0 plane. */
function squareFootprint(size: number): Vec3[] {
  return [
    [0, 0, 0],
    [size, 0, 0],
    [size, size, 0],
    [0, size, 0],
  ];
}

/** A regular grid of points strictly inside a [0,size]² footprint, height = h(x,y). */
function grid(size: number, step: number, h: (x: number, y: number) => number): Float32Array {
  const out: number[] = [];
  for (let x = step; x < size; x += step) {
    for (let y = step; y < size; y += step) {
      out.push(x, y, h(x, y));
    }
  }
  return Float32Array.from(out);
}

describe('stockpileVolume — volume + auditable band', () => {
  test('uniform slab against an explicit base gives the exact area×thickness volume, ~zero band', () => {
    // 10×10 footprint, every point 2 m above an explicit base of 0 → 100·2 = 200 m³.
    const r = stockpileVolume({
      polygon: squareFootprint(10),
      positions: grid(10, 0.25, () => 2),
      base: { mode: 'explicit', z: 0 },
    });
    expect(r.validity).toBe('ok');
    expect(r.volume).toBeCloseTo(200, 1);
    expect(r.cut).toBeCloseTo(0, 6);
    expect(r.breakdown.footprintArea).toBeCloseTo(100, 1);
    expect(r.breakdown.meanThickness).toBeCloseTo(2, 6);
    expect(r.breakdown.baseZ).toBe(0);
    // Flat top + explicit base ⇒ both error terms vanish ⇒ tight band.
    expect(r.sigma).toBeCloseTo(0, 4);
    expect(r.confidence).toBe('high');
  });

  test('sigma is the quadrature of the sampling and base-plane errors', () => {
    const r = stockpileVolume({
      polygon: squareFootprint(10),
      positions: grid(10, 0.3, (x) => (x / 10) * 4), // a 0→4 m ramp: real thickness variance
      base: { mode: 'explicit', z: 0 },
    });
    expect(r.breakdown.samplingError).toBeGreaterThan(0);
    expect(r.sigma).toBeCloseTo(
      Math.hypot(r.breakdown.samplingError, r.breakdown.basePlaneError),
      6,
    );
    expect(r.low).toBeLessThan(r.volume);
    expect(r.high).toBeGreaterThan(r.volume);
    expect(r.relativeError).toBeGreaterThan(0);
  });

  test('noisy ground produces a non-zero base-plane error term', () => {
    // Deterministic pseudo-noise on the ground band widens the inferred base.
    let s = 1;
    const noise = (): number => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return (s / 0x7fffffff - 0.5) * 0.6; // ±0.3 m
    };
    const r = stockpileVolume({
      polygon: squareFootprint(10),
      positions: grid(10, 0.25, () => 2 + noise()),
      base: { mode: 'lowest-percentile', percentile: 0.05 },
    });
    expect(r.breakdown.baseUncertainty).toBeGreaterThan(0);
    expect(r.breakdown.basePlaneError).toBeGreaterThan(0);
    expect(r.sigma).toBeGreaterThanOrEqual(r.breakdown.basePlaneError - 1e-9);
  });

  test('lowest-percentile base sits on the ground apron under a raised plateau', () => {
    // Apron at z=0, a central plateau at z=3 within radius 3 of the centre.
    const r = stockpileVolume({
      polygon: squareFootprint(10),
      positions: grid(10, 0.25, (x, y) => (Math.hypot(x - 5, y - 5) < 3 ? 3 : 0)),
      base: { mode: 'lowest-percentile', percentile: 0.05 },
    });
    expect(r.breakdown.baseMode).toBe('lowest-percentile');
    expect(r.breakdown.baseZ).toBeLessThan(0.5); // base locked onto the apron
    expect(r.volume).toBeGreaterThan(0);
    expect(r.caveats.join(' ')).toMatch(/base plane/i);
  });

  test('a sparse footprint grades low and says so', () => {
    const r = stockpileVolume({
      polygon: squareFootprint(10),
      positions: grid(10, 2, () => 2), // ~16 points inside
      base: { mode: 'explicit', z: 0 },
    });
    expect(r.breakdown.pointsInPolygon).toBeLessThan(100);
    expect(r.confidence).toBe('low');
    expect(r.caveats.join(' ')).toMatch(/indicative, not measured/i);
  });

  test('a degenerate (collinear) footprint returns zeros, not a fake number', () => {
    const r = stockpileVolume({
      polygon: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 2, 0],
      ],
      positions: grid(10, 0.5, () => 2),
      base: { mode: 'explicit', z: 0 },
    });
    expect(r.validity).not.toBe('ok');
    expect(r.volume).toBe(0);
  });
});
