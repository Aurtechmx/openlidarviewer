/**
 * contextViewMount.test.ts
 *
 * Pins the mount controller's state assembly — the last pure step before the
 * main.ts hookup. What must never regress: an ineligible app produces reasons
 * and zero footprints; an eligible app collects only the layers whose corners
 * genuinely transform (a failing layer is omitted, never guessed); non-finite
 * layer bounds are skipped rather than poisoning the ring.
 */

import { describe, it, expect } from 'vitest';
import { buildContextViewState } from '../src/ui/contextView/contextViewMount';
import type { ContextViewHost } from '../src/ui/contextView/contextViewMount';
import type { CoordinateConverter, ConversionResult } from '../src/geo/CoordinateConverter';
import type { GeographicPoint, ResolvedCrs } from '../src/geo/CoordinateTypes';
import { CONTEXT_STATUS } from '../src/geo/context/statusVocabulary';

const PROJECTED = {
  kind: 'projected',
  name: 'Test CRS',
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
  horizontalDatum: 'WGS 84',
} as unknown as ResolvedCrs;

function converterWhere(
  answer: (x: number, y: number) => ConversionResult<GeographicPoint>,
): CoordinateConverter {
  return {
    canConvert: () => true,
    convertPoint: () => ({ ok: false, code: 'unsupported-pair', reason: 'unused' }),
    toGeographic: (p) => answer(p.x, p.y),
    convertBounds: () => ({ ok: false, code: 'unsupported-pair', reason: 'unused' }),
  };
}

const scaled = (x: number, y: number): ConversionResult<GeographicPoint> => ({
  ok: true,
  value: { lon: x / 1000, lat: y / 1000 },
  method: 'vendored-utm',
});

function hostOf(over: Partial<{ [K in keyof ContextViewHost]: ContextViewHost[K] }>): ContextViewHost {
  return {
    listLayers: () => [
      { id: 'a', name: 'Scan A', bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } },
    ],
    currentCrs: () => PROJECTED,
    converter: () => converterWhere(scaled),
    ...over,
  };
}

describe('buildContextViewState', () => {
  it('assembles an eligible state with one footprint per transformable layer', () => {
    const state = buildContextViewState(hostOf({}), 'unasked');
    expect(state.eligible).toBe(true);
    expect(state.reasons).toEqual([]);
    expect(state.footprints).toHaveLength(1);
    expect(state.footprints[0].layerId).toBe('a');
    expect(state.footprints[0].ringLonLat.length).toBe(8);
    expect(state.consent).toBe('unasked');
  });

  it('reports ineligibility with reasons and no footprints when the CRS is absent', () => {
    const state = buildContextViewState(hostOf({ currentCrs: () => null }), 'unasked');
    expect(state.eligible).toBe(false);
    expect(state.reasons.length).toBeGreaterThan(0);
    expect(state.footprints).toEqual([]);
  });

  it('goes ineligible when the converter probe fails (no capability assumed)', () => {
    const failing = converterWhere(() => ({
      ok: false,
      code: 'unsupported-pair',
      reason: 'nothing registered',
    }));
    const state = buildContextViewState(hostOf({ converter: () => failing }), 'unasked');
    expect(state.eligible).toBe(false);
  });

  it('omits a layer whose corners stop transforming, never guessing its outline', () => {
    // The probe (centre of layer a) succeeds; layer b's corners are out of the
    // converter's range and fail. b must be omitted, a kept.
    const rangeLimited = converterWhere((x, y) =>
      x > 2000 || y > 2000
        ? { ok: false, code: 'out-of-bounds', reason: 'outside valid range' }
        : scaled(x, y),
    );
    const state = buildContextViewState(
      hostOf({
        converter: () => rangeLimited,
        listLayers: () => [
          { id: 'a', name: 'In range', bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } },
          { id: 'b', name: 'Out of range', bounds: { minX: 5000, minY: 5000, maxX: 6000, maxY: 6000 } },
        ],
      }),
      'granted',
    );
    expect(state.eligible).toBe(true);
    expect(state.footprints.map((f: { layerId: string }) => f.layerId)).toEqual(['a']);
  });

  it('skips a layer with non-finite bounds instead of throwing at mount time', () => {
    const state = buildContextViewState(
      hostOf({
        listLayers: () => [
          { id: 'a', name: 'Good', bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } },
          { id: 'bad', name: 'Poisoned', bounds: { minX: Number.NaN, minY: 0, maxX: 1, maxY: 1 } },
        ],
      }),
      'unasked',
    );
    expect(state.eligible).toBe(true);
    expect(state.footprints.map((f: { layerId: string }) => f.layerId)).toEqual(['a']);
  });

  it('handles an empty layer list as ineligible rather than probing at a fabricated point', () => {
    const state = buildContextViewState(hostOf({ listLayers: () => [] }), 'unasked');
    expect(state.eligible).toBe(false);
    expect(state.footprints).toEqual([]);
  });

  // --- honesty of the refusal itself -------------------------------------

  it('judges bounds per layer: a non-finite FIRST layer does not refuse its placeable siblings', () => {
    const state = buildContextViewState(
      hostOf({
        listLayers: () => [
          { id: 'bad', name: 'Poisoned first', bounds: { minX: Number.NaN, minY: 0, maxX: 1, maxY: 1 } },
          { id: 'good', name: 'Perfectly placeable', bounds: { minX: 0, minY: 0, maxX: 1000, maxY: 1000 } },
        ],
      }),
      'granted',
    );
    expect(state.eligible).toBe(true);
    expect(state.reasons).toEqual([]);
    expect(state.footprints.map((f: { layerId: string }) => f.layerId)).toEqual(['good']);
  });

  it('does not claim a transform is unavailable when no probe was attempted', () => {
    // Every layer has non-finite bounds, so there is no honest probe point.
    // The state may say the bounds are not finite; it may NOT report a probe
    // result it never obtained.
    const state = buildContextViewState(
      hostOf({
        listLayers: () => [
          { id: 'bad', name: 'Poisoned', bounds: { minX: Number.NaN, minY: 0, maxX: 1, maxY: 1 } },
          { id: 'worse', name: 'Also poisoned', bounds: { minX: 0, minY: 0, maxX: Number.POSITIVE_INFINITY, maxY: 1 } },
        ],
      }),
      'unasked',
    );
    expect(state.eligible).toBe(false);
    expect(state.empty).not.toBe(true);
    expect(state.reasons).toContain(CONTEXT_STATUS.boundsNotFinite);
    expect(state.reasons).not.toContain(CONTEXT_STATUS.transformUnavailable);
    expect(state.footprints).toEqual([]);
  });

  it('gives an empty layer list its own state, with no transform claim at all', () => {
    const state = buildContextViewState(hostOf({ listLayers: () => [] }), 'unasked');
    expect(state.empty).toBe(true);
    expect(state.eligible).toBe(false);
    expect(state.reasons).toEqual([]);
    expect(state.reasons).not.toContain(CONTEXT_STATUS.transformUnavailable);
    expect(state.reasons).not.toContain(CONTEXT_STATUS.boundsNotFinite);
    expect(state.footprints).toEqual([]);
  });

  it('still refuses honestly when the CRS itself is unusable and bounds are fine', () => {
    const state = buildContextViewState(hostOf({ currentCrs: () => null }), 'unasked');
    expect(state.empty).not.toBe(true);
    expect(state.reasons).toContain(CONTEXT_STATUS.crsUnknown);
    expect(state.reasons).toContain(CONTEXT_STATUS.transformUnavailable);
  });
});
