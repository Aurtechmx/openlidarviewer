/**
 * polygonHygiene.test.ts
 *
 * Pure-data contract tests for the volumetric guard layer. Each test
 * pins one validity tag so a regression flips a known case rather than
 * a vague "polygon was wrong".
 */

import { describe, it, expect } from 'vitest';
import {
  bbox2D,
  describeValidity,
  isPolygonDegenerate,
  isPolygonSelfIntersecting,
  polygonXY,
  signedArea2D,
  validatePolygon,
} from '../src/render/measure/polygonHygiene';

const SQUARE_CCW = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

const SQUARE_CW = [
  { x: 0, y: 0 },
  { x: 0, y: 10 },
  { x: 10, y: 10 },
  { x: 10, y: 0 },
];

describe('signedArea2D — shoelace integral with sign', () => {
  it('returns positive area for a counter-clockwise polygon', () => {
    expect(signedArea2D(SQUARE_CCW)).toBe(100);
  });

  it('returns negative area for a clockwise polygon', () => {
    expect(signedArea2D(SQUARE_CW)).toBe(-100);
  });

  it('returns 0 for a triangle of fewer than 3 vertices', () => {
    expect(signedArea2D([])).toBe(0);
    expect(signedArea2D([{ x: 0, y: 0 }])).toBe(0);
    expect(signedArea2D([{ x: 0, y: 0 }, { x: 1, y: 0 }])).toBe(0);
  });

  it('is translation-invariant', () => {
    const shifted = SQUARE_CCW.map((p) => ({ x: p.x + 1000, y: p.y - 5000 }));
    expect(signedArea2D(shifted)).toBe(100);
  });

  it('handles a known triangle exactly', () => {
    // 3-4-5 right triangle, area = 6.
    const tri = [
      { x: 0, y: 0 },
      { x: 3, y: 0 },
      { x: 0, y: 4 },
    ];
    expect(Math.abs(signedArea2D(tri))).toBe(6);
  });

  it('returns 0 for a polygon with a non-finite vertex', () => {
    const bad = [
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(signedArea2D(bad)).toBe(0);
  });
});

describe('bbox2D — axis-aligned span', () => {
  it('returns zero spans for an empty polygon', () => {
    expect(bbox2D([])).toEqual({ width: 0, height: 0 });
  });

  it('returns the correct width and height for a unit square', () => {
    expect(bbox2D(SQUARE_CCW)).toEqual({ width: 10, height: 10 });
  });

  it('returns zero spans when any vertex is non-finite', () => {
    const bad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: Number.POSITIVE_INFINITY },
    ];
    expect(bbox2D(bad)).toEqual({ width: 0, height: 0 });
  });

  it('handles a colinear vertical set (zero width)', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 0, y: 5 },
      { x: 0, y: 10 },
    ];
    expect(bbox2D(line)).toEqual({ width: 0, height: 10 });
  });
});

describe('isPolygonSelfIntersecting — detects bow-tie / figure-eight shapes', () => {
  it('returns false for a simple square', () => {
    expect(isPolygonSelfIntersecting(SQUARE_CCW)).toBe(false);
  });

  it('returns false for a triangle (no possible crossing)', () => {
    expect(isPolygonSelfIntersecting([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ])).toBe(false);
  });

  it('returns true for a bow-tie (classic self-intersection)', () => {
    // Vertices ordered so edges 0→1 and 2→3 cross.
    const bowtie = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    expect(isPolygonSelfIntersecting(bowtie)).toBe(true);
  });

  it('returns false for a convex pentagon', () => {
    const pent = [
      { x: 0, y: 0 },
      { x: 4, y: 0 },
      { x: 5, y: 3 },
      { x: 2, y: 5 },
      { x: -1, y: 3 },
    ];
    expect(isPolygonSelfIntersecting(pent)).toBe(false);
  });

  it('does NOT flag shared-vertex contact as self-intersecting', () => {
    // Adjacent edges share a vertex — must NOT register.
    const tri = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.5, y: 1 },
    ];
    expect(isPolygonSelfIntersecting(tri)).toBe(false);
  });
});

describe('isPolygonDegenerate — fast yes/no for "is this drawable as area?"', () => {
  it('returns false for a healthy square', () => {
    expect(isPolygonDegenerate(SQUARE_CCW)).toBe(false);
  });

  it('returns true for fewer than 3 vertices', () => {
    expect(isPolygonDegenerate([])).toBe(true);
    expect(isPolygonDegenerate([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(true);
  });

  it('returns true for collinear vertices (zero area)', () => {
    const line = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
    ];
    expect(isPolygonDegenerate(line)).toBe(true);
  });

  it('returns true for coincident vertices', () => {
    const stack = [
      { x: 5, y: 5 },
      { x: 5, y: 5 },
      { x: 5, y: 5 },
    ];
    expect(isPolygonDegenerate(stack)).toBe(true);
  });

  it('returns true when a vertex is non-finite', () => {
    const bad = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: Number.NaN },
    ];
    expect(isPolygonDegenerate(bad)).toBe(true);
  });
});

describe('validatePolygon — structured verdict', () => {
  it('returns ok for a CCW square', () => {
    const r = validatePolygon(SQUARE_CCW);
    expect(r.validity).toBe('ok');
    expect(r.signedArea).toBe(100);
    expect(r.absoluteArea).toBe(100);
    expect(r.bboxWidth).toBe(10);
    expect(r.bboxHeight).toBe(10);
  });

  it('returns ok for a CW square (sign is informative, not failing)', () => {
    const r = validatePolygon(SQUARE_CW);
    expect(r.validity).toBe('ok');
    expect(r.signedArea).toBeLessThan(0);
    expect(r.absoluteArea).toBe(100);
  });

  it('returns too-few-vertices for under 3 points', () => {
    expect(validatePolygon([]).validity).toBe('too-few-vertices');
    expect(validatePolygon([{ x: 0, y: 0 }]).validity).toBe('too-few-vertices');
    expect(
      validatePolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }]).validity,
    ).toBe('too-few-vertices');
  });

  it('returns non-finite-vertex for NaN / Infinity coordinates', () => {
    const r = validatePolygon([
      { x: 0, y: 0 },
      { x: Number.NaN, y: 0 },
      { x: 1, y: 1 },
    ]);
    expect(r.validity).toBe('non-finite-vertex');
    expect(r.signedArea).toBe(0);
  });

  it('returns zero-area for a collinear input', () => {
    const r = validatePolygon([
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(r.validity).toBe('zero-area');
    expect(r.absoluteArea).toBeLessThan(1e-9);
  });

  it('returns self-intersecting for a bow-tie', () => {
    const r = validatePolygon([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ]);
    expect(r.validity).toBe('self-intersecting');
  });
});

describe('polygonXY — drop the z axis for hygiene checks', () => {
  it('preserves the x and y components', () => {
    const xy = polygonXY([
      [0, 0, 5],
      [1, 0, 5],
      [1, 1, 5],
    ]);
    expect(xy).toEqual([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
    ]);
  });

  it('preserves non-finite components so the validator can flag them', () => {
    const xy = polygonXY([
      [0, 0, 5],
      [Number.NaN, 0, 5],
      [1, 1, 5],
    ]);
    expect(Number.isNaN(xy[1].x)).toBe(true);
  });
});

describe('describeValidity — surfaces a human reason string per tag', () => {
  it('returns a distinct string for every tag', () => {
    const seen = new Set<string>();
    for (const tag of [
      'ok',
      'too-few-vertices',
      'non-finite-vertex',
      'zero-area',
      'degenerate-bbox',
      'self-intersecting',
    ] as const) {
      const reason = describeValidity(tag);
      expect(reason.length).toBeGreaterThan(0);
      expect(seen.has(reason)).toBe(false);
      seen.add(reason);
    }
  });
});
