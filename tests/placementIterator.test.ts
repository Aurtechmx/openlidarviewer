/**
 * placementIterator.test.ts
 *
 * Pins the single placement-aware point walk. Three things matter enough to be
 * checked rather than trusted: the placement is applied EXACTLY once (a second
 * application is silent — the points land somewhere plausible and wrong, which
 * is how a doubled offset survives a screenshot), non-finite points are skipped
 * AND counted so an estimator can disclose them instead of averaging garbage,
 * and a poison placement fails loudly at the call rather than turning every
 * point downstream into NaN.
 */

import { describe, it, expect } from 'vitest';
import {
  forEachPlacedPoint,
  iteratePlacedPoints,
  type PlacedPoint,
} from '../src/geo/placementIterator';

/** A layer whose source origin sits 100 m E, 50 m N and 1 m above the project's. */
const OFFSET = { sourceToProject: [100, 50, 1] as const };
const IDENTITY = { sourceToProject: [0, 0, 0] as const };

/** Collect a walk's output as plain tuples — the out-object is reused. */
function collect(
  points: Float32Array | Float64Array,
  placement: { sourceToProject: readonly [number, number, number] } | null,
): { placed: Array<[number, number, number]>; indices: number[] } {
  const placed: Array<[number, number, number]> = [];
  const indices: number[] = [];
  forEachPlacedPoint(points, placement, (p: Readonly<PlacedPoint>) => {
    placed.push([p.x, p.y, p.z]);
    indices.push(p.index);
  });
  return { placed, indices };
}

describe('forEachPlacedPoint — placement application', () => {
  it('applies the placement exactly once (hand-math, so a double-apply fails)', () => {
    const points = new Float32Array([1, 2, 3, 10, 20, 30]);
    const { placed } = collect(points, OFFSET);
    // Once: [1,2,3] + [100,50,1]. Twice would be [201,102,5].
    expect(placed).toEqual([
      [101, 52, 4],
      [110, 70, 31],
    ]);
  });

  it('lands where the project frame says it should — the FRAME-001 shape', () => {
    // The layer's file origin, the project's shared origin, and the resulting
    // translation, exactly as `layerTransform` derives it.
    const sourceOrigin = [1000, 2000, 30] as const;
    const projectOrigin = [900, 1950, 29] as const;
    const placement = {
      sourceToProject: [
        sourceOrigin[0] - projectOrigin[0],
        sourceOrigin[1] - projectOrigin[1],
        sourceOrigin[2] - projectOrigin[2],
      ] as const,
    };
    const sourceLocal = [1, 2, 3] as const;
    const world = [
      sourceLocal[0] + sourceOrigin[0],
      sourceLocal[1] + sourceOrigin[1],
      sourceLocal[2] + sourceOrigin[2],
    ];

    const { placed } = collect(new Float64Array(sourceLocal), placement);
    const projectLocal = placed[0];
    expect(projectLocal).toEqual([101, 52, 4]);

    // Lifting the placed point by the PROJECT origin recovers the true world
    // coordinates. Lifting it by the layer's own source origin instead — which
    // is what the inspector card does today — applies the placement a second
    // time and lands 100 m / 50 m / 1 m out.
    expect([
      projectLocal[0] + projectOrigin[0],
      projectLocal[1] + projectOrigin[1],
      projectLocal[2] + projectOrigin[2],
    ]).toEqual(world);
    expect([
      projectLocal[0] + sourceOrigin[0],
      projectLocal[1] + sourceOrigin[1],
      projectLocal[2] + sourceOrigin[2],
    ]).not.toEqual(world);
  });

  it('treats a null / identity placement as a pass-through', () => {
    const points = new Float32Array([1, 2, 3]);
    expect(collect(points, null).placed).toEqual([[1, 2, 3]]);
    expect(collect(points, IDENTITY).placed).toEqual([[1, 2, 3]]);
  });

  it('reports the triplet index, not the element index', () => {
    const points = new Float32Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(collect(points, IDENTITY).indices).toEqual([0, 1, 2]);
  });
});

describe('forEachPlacedPoint — non-finite points', () => {
  it('skips non-finite points and counts them', () => {
    const points = new Float32Array([
      Number.NaN, 0, 0, // poison X
      1, 2, 3, // good
      0, Number.POSITIVE_INFINITY, 0, // poison Y
      0, 0, Number.NaN, // poison Z
    ]);
    const seen: Array<[number, number, number]> = [];
    const tally = forEachPlacedPoint(points, OFFSET, (p) => {
      seen.push([p.x, p.y, p.z]);
    });
    expect(seen).toEqual([[101, 52, 4]]);
    expect(tally).toEqual({ total: 4, visited: 1, skipped: 3 });
  });

  it('reports every point skipped rather than an empty success', () => {
    const points = new Float32Array([Number.NaN, Number.NaN, Number.NaN]);
    const tally = forEachPlacedPoint(points, OFFSET, () => {
      throw new Error('must not visit a non-finite point');
    });
    expect(tally).toEqual({ total: 1, visited: 0, skipped: 1 });
  });
});

describe('forEachPlacedPoint — degenerate input', () => {
  it('walks an empty buffer without calling back', () => {
    const tally = forEachPlacedPoint(new Float32Array(0), OFFSET, () => {
      throw new Error('must not visit anything');
    });
    expect(tally).toEqual({ total: 0, visited: 0, skipped: 0 });
  });

  it('ignores a trailing partial triplet', () => {
    const points = new Float32Array([1, 2, 3, 9, 9]); // 5 elements, 1 whole point
    const { placed } = collect(points, IDENTITY);
    expect(placed).toEqual([[1, 2, 3]]);
  });

  it('honours pointCount, clamped to what the buffer holds', () => {
    const points = new Float32Array([1, 2, 3, 4, 5, 6]);
    const one: Array<[number, number, number]> = [];
    const tally = forEachPlacedPoint(points, IDENTITY, (p) => {
      one.push([p.x, p.y, p.z]);
    }, { pointCount: 1 });
    expect(one).toEqual([[1, 2, 3]]);
    expect(tally.total).toBe(1);

    const over = forEachPlacedPoint(points, IDENTITY, () => {}, { pointCount: 99 });
    expect(over.total).toBe(2);
  });
});

describe('forEachPlacedPoint — poison arguments', () => {
  it('throws a TypeError naming the placement argument', () => {
    const points = new Float32Array([1, 2, 3]);
    expect(() =>
      forEachPlacedPoint(points, { sourceToProject: [Number.NaN, 0, 0] as const }, () => {}),
    ).toThrow(TypeError);
    expect(() =>
      forEachPlacedPoint(
        points,
        { sourceToProject: [0, Number.POSITIVE_INFINITY, 0] as const },
        () => {},
      ),
    ).toThrow(/placement\.sourceToProject/);
  });

  it('throws a TypeError naming a nonsense pointCount', () => {
    const points = new Float32Array([1, 2, 3]);
    expect(() =>
      forEachPlacedPoint(points, IDENTITY, () => {}, { pointCount: Number.NaN }),
    ).toThrow(/options\.pointCount/);
    expect(() =>
      forEachPlacedPoint(points, IDENTITY, () => {}, { pointCount: -1 }),
    ).toThrow(TypeError);
  });
});

describe('forEachPlacedPoint — allocation contract', () => {
  it('hands back the SAME out-object every time (documented, so pinned)', () => {
    const points = new Float32Array([1, 2, 3, 4, 5, 6]);
    const refs: Array<Readonly<PlacedPoint>> = [];
    forEachPlacedPoint(points, IDENTITY, (p) => {
      refs.push(p);
    });
    expect(refs).toHaveLength(2);
    expect(refs[0]).toBe(refs[1]);
    // …which is exactly why a caller must copy: the retained reference now
    // holds the LAST point, not the first.
    expect(refs[0].index).toBe(1);
  });
});

describe('iteratePlacedPoints', () => {
  it('yields the same placed points as the callback form', () => {
    const points = new Float32Array([1, 2, 3, 10, 20, 30]);
    const placed: Array<[number, number, number]> = [];
    for (const p of iteratePlacedPoints(points, OFFSET)) {
      placed.push([p.x, p.y, p.z]);
    }
    expect(placed).toEqual([
      [101, 52, 4],
      [110, 70, 31],
    ]);
  });

  it('returns the tally when driven by hand', () => {
    const points = new Float32Array([1, 2, 3, Number.NaN, 0, 0]);
    const it = iteratePlacedPoints(points, OFFSET);
    let step = it.next();
    while (!step.done) step = it.next();
    expect(step.value).toEqual({ total: 2, visited: 1, skipped: 1 });
  });

  it('throws a TypeError on a poison placement before yielding anything', () => {
    const it = iteratePlacedPoints(new Float32Array([1, 2, 3]), {
      sourceToProject: [0, 0, Number.NaN] as const,
    });
    expect(() => it.next()).toThrow(TypeError);
  });
});
