/**
 * contextFromCrs.test.ts
 *
 * Pins the bridge between the real CRS machinery and the context core. The
 * bridge is where a capability could silently be assumed rather than probed —
 * a converter that fails at render time after eligibility said yes would put a
 * scan's footprint at a guessed position — so the probe semantics and every
 * null path are pinned here against a scripted fake converter.
 */

import { describe, it, expect } from 'vitest';
import { contextFactsFrom, lonLatTransformFrom } from '../src/geo/context/fromCrs';
import type { CoordinateConverter, ConversionResult } from '../src/geo/CoordinateConverter';
import type { GeographicPoint, ResolvedCrs, Vec3 } from '../src/geo/CoordinateTypes';

/** A converter scripted per-test: `answer` decides every toGeographic call. */
function fakeConverter(
  answer: (p: Vec3) => ConversionResult<GeographicPoint>,
): CoordinateConverter {
  return {
    canConvert: () => true,
    convertPoint: () => ({ ok: false, code: 'unsupported-pair', reason: 'unused' }),
    toGeographic: (p) => answer(p),
    convertBounds: () => ({ ok: false, code: 'unsupported-pair', reason: 'unused' }),
  };
}

const okAt = (lon: number, lat: number): ConversionResult<GeographicPoint> => ({
  ok: true,
  value: { lon, lat },
  method: 'vendored-utm',
});

const FAIL: ConversionResult<GeographicPoint> = {
  ok: false,
  code: 'unsupported-pair',
  reason: 'no converter registered for this pair',
};

function crsOf(over: Partial<ResolvedCrs>): ResolvedCrs {
  return {
    kind: 'projected',
    name: 'Test CRS',
    linearUnit: 'metre',
    linearUnitToMetres: 1,
    source: 'wkt',
    confidence: 'high',
    userConfirmed: false,
    ...over,
  } as ResolvedCrs;
}

describe('lonLatTransformFrom', () => {
  it('routes through toGeographic and returns [lon, lat] on success', () => {
    const t = lonLatTransformFrom(
      fakeConverter((p) => okAt(p.x / 100000, p.y / 100000)),
      crsOf({}),
    );
    expect(t(500000, 4649776)).toEqual([5, 46.49776]);
  });

  it('returns null on a converter failure, never a guessed position', () => {
    const t = lonLatTransformFrom(fakeConverter(() => FAIL), crsOf({}));
    expect(t(1, 2)).toBeNull();
  });

  it('returns null for non-finite input without calling the converter', () => {
    let called = 0;
    const t = lonLatTransformFrom(
      fakeConverter(() => {
        called += 1;
        return okAt(0, 0);
      }),
      crsOf({}),
    );
    expect(t(Number.NaN, 2)).toBeNull();
    expect(t(1, Number.POSITIVE_INFINITY)).toBeNull();
    expect(called).toBe(0);
  });

  it('returns null when the converter answers ok with non-finite output', () => {
    const t = lonLatTransformFrom(fakeConverter(() => okAt(Number.NaN, 10)), crsOf({}));
    expect(t(1, 2)).toBeNull();
  });
});

describe('contextFactsFrom', () => {
  const centre = { x: 10, y: 20 };

  it('derives full facts for a working projected CRS (probe succeeds)', () => {
    const facts = contextFactsFrom(
      crsOf({ horizontalDatum: 'WGS 84' }),
      fakeConverter(() => okAt(5, 46)),
      centre,
      true,
    );
    expect(facts).toEqual({
      crsKnown: true,
      geographic: false,
      projected: true,
      horizontalDatumKnown: true,
      toWgs84Available: true,
      boundsFinite: true,
    });
  });

  it('probes availability instead of assuming it: a failing converter reads unavailable', () => {
    const facts = contextFactsFrom(crsOf({}), fakeConverter(() => FAIL), centre, true);
    expect(facts.crsKnown).toBe(true);
    expect(facts.toWgs84Available).toBe(false);
  });

  it('maps a null CRS to all-false facts without touching the converter', () => {
    let called = 0;
    const facts = contextFactsFrom(
      null,
      fakeConverter(() => {
        called += 1;
        return okAt(0, 0);
      }),
      centre,
      true,
    );
    expect(facts.crsKnown).toBe(false);
    expect(facts.toWgs84Available).toBe(false);
    expect(called).toBe(0);
  });

  it('treats local and unknown CRS kinds as not placeable', () => {
    for (const kind of ['local', 'unknown'] as const) {
      const facts = contextFactsFrom(
        crsOf({ kind }),
        fakeConverter(() => okAt(0, 0)),
        centre,
        true,
      );
      expect(facts.crsKnown).toBe(false);
      expect(facts.geographic).toBe(false);
      expect(facts.projected).toBe(false);
    }
  });

  it('skips the probe when bounds are not finite (no capability from garbage)', () => {
    let called = 0;
    const facts = contextFactsFrom(
      crsOf({}),
      fakeConverter(() => {
        called += 1;
        return okAt(0, 0);
      }),
      centre,
      false,
    );
    expect(facts.boundsFinite).toBe(false);
    expect(facts.toWgs84Available).toBe(false);
    expect(called).toBe(0);
  });

  it('reports an undeclared horizontal datum as unknown, not defaulted', () => {
    const facts = contextFactsFrom(crsOf({}), fakeConverter(() => okAt(0, 0)), centre, true);
    expect(facts.horizontalDatumKnown).toBe(false);
  });
});
