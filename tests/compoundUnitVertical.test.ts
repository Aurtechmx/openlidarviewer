/**
 * compoundUnitVertical.test.ts — one unit factor is not enough.
 *
 * A compound CRS states two linear units: a metre horizontal grid over
 * US-survey-foot heights, say. Four surfaces scaled every axis by the
 * HORIZONTAL factor, so a height stored in feet was reported as metres —
 * 3.2808× over, in figures nothing disclosed as mixed.
 *
 * These tests pin the vertical factor where it belongs, and pin the far more
 * common case too: when the two factors are equal (every single-unit scan)
 * the answers must be byte-for-byte what they were, or the fix has moved
 * numbers it had no business touching.
 */

import { describe, it, expect } from 'vitest';

import { spaceMetrics } from '../src/terrain/spaceMetrics';
import { positionsInMetres, scaleAxes } from '../src/terrain/sourceScale';
import { knownUnit } from '../src/units/units';
import { extractConductorCandidate } from '../src/features/FeatureExtractionService';

/** US survey foot. A 3.00 m height is 9.8425 of these. */
const FT = 1200 / 3937;

function pts(triples: Array<[number, number, number]>): Float32Array {
  const a = new Float32Array(triples.length * 3);
  triples.forEach(([x, y, z], i) => { a[i * 3] = x; a[i * 3 + 1] = y; a[i * 3 + 2] = z; });
  return a;
}

/** A deterministic room: metre-grid footprint, heights in survey feet. */
function room(widthM: number, depthM: number, heightM: number, heightUnit: number): Float32Array {
  const out: Array<[number, number, number]> = [];
  const hTop = heightM / heightUnit;
  let s = 12345;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 4000; i++) {
    const x = rnd() * widthM;
    const y = rnd() * depthM;
    const r = rnd();
    // Floor, ceiling and walls, so a ceiling is genuinely detected.
    if (r < 0.34) out.push([x, y, rnd() * 0.02 / heightUnit]);
    else if (r < 0.68) out.push([x, y, hTop - rnd() * 0.02 / heightUnit]);
    else {
      const onX = rnd() < 0.5;
      out.push([onX ? (rnd() < 0.5 ? 0 : widthM) : x, onX ? y : (rnd() < 0.5 ? 0 : depthM), rnd() * hTop]);
    }
  }
  return pts(out);
}

describe('space metrics read the height in the height unit', () => {
  // A 3.00 m ceiling stored as 9.8425 survey feet over a metre grid.
  const compound = room(8, 6, 3, FT);

  it('reports the true ceiling height rather than the foot count', () => {
    const wrong = spaceMetrics(compound, { upAxis: 'z', spaceKind: 'interior', unitToMetres: 1 });
    const right = spaceMetrics(compound, {
      upAxis: 'z', spaceKind: 'interior', unitToMetres: 1, verticalUnitToMetres: FT,
    });
    // Without the vertical factor the height is the foot count read as metres.
    expect(wrong.dims.heightM).toBeCloseTo(3 / FT, 1);
    expect(right.dims.heightM).toBeCloseTo(3, 1);
    // Which is the 3.2808 the compound CRS is worth.
    expect(wrong.dims.heightM / right.dims.heightM).toBeCloseTo(1 / FT, 2);
  });

  it('leaves the horizontal footprint alone', () => {
    const right = spaceMetrics(compound, {
      upAxis: 'z', spaceKind: 'interior', unitToMetres: 1, verticalUnitToMetres: FT,
    });
    const wrong = spaceMetrics(compound, { upAxis: 'z', spaceKind: 'interior', unitToMetres: 1 });
    // The grid was always metres; the fix must not have touched it.
    expect(right.dims.widthM).toBeCloseTo(wrong.dims.widthM, 9);
    expect(right.dims.lengthM).toBeCloseTo(wrong.dims.lengthM, 9);
  });

  it('is unchanged when the two units agree, which is every ordinary scan', () => {
    const metres = room(8, 6, 3, 1);
    const a = spaceMetrics(metres, { upAxis: 'z', spaceKind: 'interior', unitToMetres: 1 });
    const b = spaceMetrics(metres, {
      upAxis: 'z', spaceKind: 'interior', unitToMetres: 1, verticalUnitToMetres: 1,
    });
    expect(b.dims.heightM).toBe(a.dims.heightM);
    expect(b.dims.widthM).toBe(a.dims.widthM);
    expect(b.dims.lengthM).toBe(a.dims.lengthM);
    expect(b.enclosedVolumeM3).toBe(a.enclosedVolumeM3);
  });
});

describe('positions scaled to metres respect the up-axis', () => {
  const p = pts([[10, 20, 30]]);

  it('scales the vertical component by the vertical factor', () => {
    const out = positionsInMetres(p, knownUnit(1), { metresPerUnit: FT, axis: 2 }) as Float32Array;
    // Float32 storage, so the tolerance is the type's, not the maths'.
    expect(out[0]).toBeCloseTo(10, 5);
    expect(out[1]).toBeCloseTo(20, 5);
    expect(out[2]).toBeCloseTo(30 * FT, 5);
  });

  it.each([0, 1, 2] as const)('honours up-axis %i', (axis) => {
    const out = positionsInMetres(p, knownUnit(2), { metresPerUnit: 5, axis }) as Float32Array;
    for (let i = 0; i < 3; i++) expect(out[i]).toBeCloseTo(p[i] * (i === axis ? 5 : 2), 5);
  });

  it('returns the identical buffer when both factors are 1', () => {
    expect(positionsInMetres(p, knownUnit(1), { metresPerUnit: 1, axis: 2 })).toBe(p);
  });

  it('falls back to the single-scalar path when the factors agree', () => {
    const iso = positionsInMetres(p, knownUnit(3)) as Float32Array;
    const same = positionsInMetres(p, knownUnit(3), { metresPerUnit: 3, axis: 2 }) as Float32Array;
    expect([...same]).toEqual([...iso]);
  });

  it('ignores a vertical factor that is not a usable number', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = positionsInMetres(p, knownUnit(2), { metresPerUnit: bad, axis: 2 }) as Float32Array;
      expect([...out], String(bad)).toEqual([20, 40, 60]);
    }
  });

  it('still refuses to scale anything when the unit is unknown', () => {
    const unknown = { known: false, metresPerUnit: 1 } as never;
    expect(positionsInMetres(p, unknown, { metresPerUnit: FT, axis: 2 })).toBe(p);
  });

  it('scaleAxes touches every triple, not just the first', () => {
    const many = pts([[1, 1, 1], [2, 2, 2], [3, 3, 3]]);
    const out = scaleAxes(many, 10, 100, 2);
    expect([...out]).toEqual([10, 10, 100, 20, 20, 200, 30, 30, 300]);
  });
});

describe('a conductor sag is a vertical magnitude', () => {
  // A catenary in the x–z plane: 40 m span, 1.50 m sag, heights in survey feet.
  const points: Array<[number, number, number]> = [];
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const dropM = 1.5 * 4 * t * (1 - t); // parabola, max 1.5 m at midspan
    points.push([i, 0, (10 - dropM) / FT]);
  }

  it('converts the sag with the vertical factor and the span with the horizontal', () => {
    const c = extractConductorCandidate(points, knownUnit(1), [0, 0, 1], 0.5, knownUnit(FT));
    expect(c).not.toBeNull();
    expect(c!.spanM).toBeCloseTo(40, 1);
    expect(c!.sagM!).toBeCloseTo(1.5, 1);
  });

  it('reads the sag as the foot count when the vertical factor is withheld', () => {
    const c = extractConductorCandidate(points, knownUnit(1), [0, 0, 1], 0.5);
    expect(c).not.toBeNull();
    // 3.2808x over, and beside a span that is right — which is what made the
    // pair look self-consistent.
    expect(c!.sagM! / 1.5).toBeCloseTo(1 / FT, 1);
    expect(c!.spanM).toBeCloseTo(40, 1);
  });
});

// Two regressions the review caught in the fix itself, pinned so they cannot
// come back.
describe('the anisotropic path does not break the degenerate inputs', () => {
  const p = new Float32Array([1, 2, 3]);

  it('does not throw when the horizontal factor is not a number', () => {
    // NaN equals nothing, including itself, so `h === v` was false even with no
    // vertical argument — and the anisotropic branch then read an axis off
    // `undefined`. The answer is the same NaN-scaled copy it always was.
    const out = positionsInMetres(p, { known: true, metresPerUnit: Number.NaN } as never);
    expect([...(out as Float32Array)].every(Number.isNaN)).toBe(true);
  });

  it.each([0, -1, Number.POSITIVE_INFINITY])('is unchanged for metresPerUnit %p', (mpu) => {
    const out = positionsInMetres(p, { known: true, metresPerUnit: mpu } as never) as Float32Array;
    expect([...out]).toEqual([1 * mpu, 2 * mpu, 3 * mpu]);
  });
});
