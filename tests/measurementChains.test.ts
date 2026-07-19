/**
 * measurementChains.test.ts
 *
 * Pins the aggregate / dimension routing contract. Tests are pure —
 * synthetic measurements feed `aggregate` and the result is checked
 * against an analytic value.
 */

import { describe, it, expect } from 'vitest';
import {
  aggregate,
  formatChainResult,
  KIND_DIMENSIONS,
  supportedDimensions,
  valueForDimension,
} from '../src/render/measure/measurementChains';
import type { Measurement, MeasurementKind } from '../src/render/measure/types';

let _id = 0;
function freshId(): string {
  return `m${++_id}`;
}

function distanceM(p0: [number, number, number], p1: [number, number, number]): Measurement {
  return {
    id: freshId(),
    kind: 'distance',
    name: 'd',
    points: [p0, p1],
  };
}

function areaSquare(side: number): Measurement {
  return {
    id: freshId(),
    kind: 'area',
    name: 'a',
    points: [
      [0, 0, 0],
      [side, 0, 0],
      [side, side, 0],
      [0, side, 0],
    ],
    closed: true,
  };
}

function heightM(h: number): Measurement {
  return {
    id: freshId(),
    kind: 'height',
    name: 'h',
    points: [
      [0, 0, 0],
      [0, 0, h],
    ],
  };
}

function slopeM(run: number, rise: number): Measurement {
  return {
    id: freshId(),
    kind: 'slope',
    name: 's',
    points: [
      [0, 0, 0],
      [run, 0, rise],
    ],
  };
}

function volumeM(footprintArea: number, fill: number, cut: number): Measurement {
  return {
    id: freshId(),
    kind: 'volume',
    name: 'v',
    points: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
    ],
    closed: true,
    volume: {
      fill,
      cut,
      net: fill - cut,
      referenceZ: 0,
      footprintArea,
      pointsInPolygon: 1000,
      densityNative: 100,
      confidence: 'high',
    },
  };
}

describe('valueForDimension — routing', () => {
  it('routes distance to length', () => {
    const d = distanceM([0, 0, 0], [3, 4, 0]);
    expect(valueForDimension(d, 'length')).toBeCloseTo(5, 6);
  });

  it('routes area to area', () => {
    expect(valueForDimension(areaSquare(10), 'area')).toBe(100);
  });

  it('routes volume to volume-fill, volume-cut, volume-net', () => {
    const v = volumeM(50, 30, 10);
    expect(valueForDimension(v, 'volume-fill')).toBe(30);
    expect(valueForDimension(v, 'volume-cut')).toBe(10);
    expect(valueForDimension(v, 'volume-net')).toBe(20);
    expect(valueForDimension(v, 'area')).toBe(50);
  });

  it('returns null when the dimension is not supported by the kind', () => {
    const d = distanceM([0, 0, 0], [1, 0, 0]);
    expect(valueForDimension(d, 'area')).toBeNull();
    expect(valueForDimension(d, 'angle')).toBeNull();
  });

  it('routes slope to length AND grade', () => {
    const s = slopeM(10, 1);
    expect(valueForDimension(s, 'length')).toBeCloseTo(Math.hypot(10, 1), 6);
    // 10% grade.
    expect(valueForDimension(s, 'grade')).toBeCloseTo(10, 4);
  });

  it('routes height to height', () => {
    expect(valueForDimension(heightM(5), 'height')).toBeCloseTo(5, 6);
  });
});

describe('aggregate — sum', () => {
  it('sums lengths across a mixed selection', () => {
    const ms: Measurement[] = [
      distanceM([0, 0, 0], [3, 0, 0]),
      distanceM([0, 0, 0], [4, 0, 0]),
      // An area contributes nothing to length — should be skipped.
      areaSquare(10),
    ];
    const r = aggregate(ms, 'sum', 'length');
    expect(r.value).toBe(7);
    expect(r.contributingCount).toBe(2);
    expect(r.totalCount).toBe(3);
    expect(r.unit).toBe('m');
  });

  it('sums areas', () => {
    const ms = [areaSquare(5), areaSquare(10)];
    const r = aggregate(ms, 'sum', 'area');
    expect(r.value).toBe(125);
    expect(r.unit).toBe('m²');
  });

  it('returns 0 when nothing contributes', () => {
    const ms = [distanceM([0, 0, 0], [1, 0, 0])];
    expect(aggregate(ms, 'sum', 'angle').value).toBe(0);
  });
});

describe('aggregate — mean', () => {
  it('computes arithmetic mean over the contributors', () => {
    const ms = [
      distanceM([0, 0, 0], [4, 0, 0]),
      distanceM([0, 0, 0], [6, 0, 0]),
    ];
    const r = aggregate(ms, 'mean', 'length');
    expect(r.value).toBe(5);
  });

  it('ignores non-contributing measurements in the denominator', () => {
    const ms = [
      distanceM([0, 0, 0], [10, 0, 0]),
      areaSquare(5),
      areaSquare(15),
    ];
    const r = aggregate(ms, 'mean', 'length');
    // Mean of just [10] = 10 — the areas don't count toward the denominator.
    expect(r.value).toBe(10);
    expect(r.contributingCount).toBe(1);
  });
});

describe('aggregate — min / max', () => {
  it('returns the smallest contributing value for min', () => {
    const ms = [
      distanceM([0, 0, 0], [10, 0, 0]),
      distanceM([0, 0, 0], [3, 0, 0]),
      distanceM([0, 0, 0], [7, 0, 0]),
    ];
    expect(aggregate(ms, 'min', 'length').value).toBe(3);
  });

  it('returns the largest contributing value for max', () => {
    const ms = [
      distanceM([0, 0, 0], [10, 0, 0]),
      distanceM([0, 0, 0], [3, 0, 0]),
      distanceM([0, 0, 0], [7, 0, 0]),
    ];
    expect(aggregate(ms, 'max', 'length').value).toBe(10);
  });

  it('returns NaN for min/max when no measurement contributes', () => {
    expect(aggregate([], 'min', 'length').value).toBeNaN();
    expect(aggregate([areaSquare(5)], 'max', 'length').value).toBeNaN();
  });
});

describe('aggregate — count', () => {
  it('returns the count of contributing measurements', () => {
    const ms = [
      distanceM([0, 0, 0], [3, 0, 0]),
      areaSquare(5),
      distanceM([0, 0, 0], [4, 0, 0]),
    ];
    const r = aggregate(ms, 'count', 'length');
    expect(r.value).toBe(2);
    expect(r.totalCount).toBe(3);
  });
});

describe('supportedDimensions — UI helper', () => {
  it('returns the union of dimensions across the selection', () => {
    const ms: Measurement[] = [
      distanceM([0, 0, 0], [1, 0, 0]),
      areaSquare(5),
      volumeM(50, 10, 5),
    ];
    const dims = supportedDimensions(ms);
    expect(dims).toContain('length');
    expect(dims).toContain('area');
    expect(dims).toContain('volume-fill');
    expect(dims).toContain('volume-net');
  });

  it('returns an empty array for an empty selection', () => {
    expect(supportedDimensions([])).toEqual([]);
  });

  it('returns deterministic ordering', () => {
    const ms: Measurement[] = [
      areaSquare(5),
      distanceM([0, 0, 0], [1, 0, 0]),
    ];
    const a = supportedDimensions(ms);
    const b = supportedDimensions(ms);
    expect(a).toEqual(b);
  });
});

describe('formatChainResult — display sugar', () => {
  it('formats a length sum with 2 decimals + unit', () => {
    const r = aggregate(
      [distanceM([0, 0, 0], [3, 0, 0])],
      'sum',
      'length',
    );
    expect(formatChainResult(r)).toBe('3.00 m');
  });

  it('formats a grade with 1 decimal + %', () => {
    const r = aggregate([slopeM(10, 1)], 'mean', 'grade');
    expect(formatChainResult(r)).toMatch(/10\.0\s*%/);
  });

  it('formats count as "n of total"', () => {
    const ms: Measurement[] = [
      distanceM([0, 0, 0], [1, 0, 0]),
      areaSquare(5),
    ];
    const r = aggregate(ms, 'count', 'length');
    expect(formatChainResult(r)).toBe('1 of 2');
  });

  it('formats an empty min as "—"', () => {
    expect(formatChainResult(aggregate([], 'min', 'length'))).toBe('—');
  });
});

describe('KIND_DIMENSIONS — registry', () => {
  it('lists at least one dimension for every kind', () => {
    const kinds: MeasurementKind[] = [
      'distance',
      'polyline',
      'area',
      'height',
      'angle',
      'slope',
      'profile',
      'box',
      'volume',
    ];
    for (const k of kinds) {
      expect(KIND_DIMENSIONS[k].length).toBeGreaterThan(0);
    }
  });
});

describe('aggregate through the CRS unit factor (v0.4.5, B2)', () => {
  // Foot-CRS fixture: render units are feet, f = 0.3048 m per unit.
  const F = 0.3048;

  it('lengths scale ×f: a 10-unit span sums to 3.048 m', () => {
    const r = aggregate([distanceM([0, 0, 0], [10, 0, 0])], 'sum', 'length', [0, 0, 1], F);
    expect(r.value).toBeCloseTo(3.048, 12);
    expect(r.unit).toBe('m');
  });

  it('areas scale ×f²: a 10-unit square sums to 9.290304 m²', () => {
    // 100 unit² × 0.3048² = 9.290304 m².
    const r = aggregate([areaSquare(10)], 'sum', 'area', [0, 0, 1], F);
    expect(r.value).toBeCloseTo(9.290304, 12);
  });

  it('volumes scale ×f³: a 2×3×4 box fills 0.679604318208 m³', () => {
    // 24 unit³ × 0.3048³ = 24 × 0.028316846592 = 0.679604318208 m³.
    const box: Measurement = {
      id: 'b1',
      kind: 'box',
      name: 'b',
      points: [
        [0, 0, 0],
        [2, 3, 4],
      ],
    };
    const r = aggregate([box], 'sum', 'volume-fill', [0, 0, 1], F);
    expect(r.value).toBeCloseTo(0.679604318208, 12);
  });

  it('dimensionless dimensions ignore the factor entirely', () => {
    const angle: Measurement = {
      id: 'a1',
      kind: 'angle',
      name: 'a',
      points: [
        [1, 0, 0],
        [0, 0, 0],
        [0, 1, 0],
      ],
    };
    const r = aggregate([angle], 'max', 'angle', [0, 0, 1], F);
    expect(r.value).toBeCloseTo(90, 9);
  });

  it('the factor defaults to 1 — pre-B2 call sites are unchanged', () => {
    const r = aggregate([distanceM([0, 0, 0], [10, 0, 0])], 'sum', 'length');
    expect(r.value).toBeCloseTo(10, 12);
  });
});
