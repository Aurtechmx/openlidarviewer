import { describe, it, expect } from 'vitest';
import {
  resolveLiveDtmDescriptor,
  dtmMethodDigest,
  type LiveDtmDescriptor,
} from '../src/science/liveDtmDescriptor';
import { METHOD_REGISTRY } from '../src/science/methodRegistry';
import {
  LIVE_INTERPOLATION,
  LIVE_EXTRAPOLATION_GUARD,
} from '../src/terrain/ground/surfaceFromRaster';
import {
  LIVE_DTM_AGGREGATION,
  ASPRS_GROUND_CLASS,
} from '../src/terrain/ground/liveDtmConstants';

describe('resolveLiveDtmDescriptor', () => {
  it('resolves to the documented production DTM method values', () => {
    const d = resolveLiveDtmDescriptor();
    expect(d.methodId).toBe('olv.dtm.idw-fill');
    expect(d.methodVersion).toBe(METHOD_REGISTRY['olv.dtm.idw-fill'].version);
    // Track the production source of truth, not a hardcoded literal: the
    // descriptor must equal the constants the delivered surface is built from.
    expect(d.aggregation).toBe(LIVE_DTM_AGGREGATION);
    expect(d.groundClass).toBe(ASPRS_GROUND_CLASS);
    // Sanity: the documented production values.
    expect(LIVE_DTM_AGGREGATION).toBe('median');
    expect(ASPRS_GROUND_CLASS).toBe(2);
    expect(d.verticalAxis).toBe('z');
    expect(d.trustGroundClassification).toBe(true);
    expect(d.despikeApplied).toBe(false);
    expect(d.interpolation).toBe('geodesic');
    expect(d.interpolation).toBe(LIVE_INTERPOLATION);
    expect(d.samplingConvention).toBe('bilinear-cell-centres');
    // Guard read from the production source of truth, not re-typed here.
    expect(d.extrapolationGuard.radiusCells).toBe(LIVE_EXTRAPOLATION_GUARD.radiusCells);
    expect(d.extrapolationGuard.penalty).toBe(LIVE_EXTRAPOLATION_GUARD.penalty);
    // Method identity defaults for the unit scales.
    expect(d.horizontalUnitToMetres).toBe(1);
    expect(d.verticalUnitToMetres).toBe(1);
  });

  it('treats cell size as a caller-supplied per-run input', () => {
    expect(resolveLiveDtmDescriptor().cellSizeM).toBeNull();
    const d = resolveLiveDtmDescriptor({ cellSizeM: 0.5 });
    expect(d.cellSizeM).toBe(0.5);
    expect(d.cellSizeSource).toBe('caller-supplied');
  });

  it('accepts per-dataset unit-scale overrides', () => {
    const d = resolveLiveDtmDescriptor({
      horizontalUnitToMetres: 0.3048,
      verticalUnitToMetres: 0.3048,
    });
    expect(d.horizontalUnitToMetres).toBeCloseTo(0.3048, 6);
    expect(d.verticalUnitToMetres).toBeCloseTo(0.3048, 6);
  });
});

describe('dtmMethodDigest', () => {
  it('is deterministic: same behaviour → same hex', () => {
    const a = dtmMethodDigest(resolveLiveDtmDescriptor());
    const b = dtmMethodDigest(resolveLiveDtmDescriptor());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is independent of per-run cell size (context, not behaviour)', () => {
    const base = dtmMethodDigest(resolveLiveDtmDescriptor());
    const withCell = dtmMethodDigest(resolveLiveDtmDescriptor({ cellSizeM: 1.0 }));
    expect(withCell).toBe(base);
  });

  it('changes when any method-behaviour field changes (negative control)', () => {
    const base = resolveLiveDtmDescriptor();
    const baseDigest = dtmMethodDigest(base);
    const mutations: Array<Partial<LiveDtmDescriptor>> = [
      { aggregation: 'mean' },
      { despikeApplied: true },
      { interpolation: 'idw' as LiveDtmDescriptor['interpolation'] },
      { groundClass: 9 },
      { trustGroundClassification: false },
      { verticalAxis: 'y' },
      { methodVersion: base.methodVersion + 1 },
      { samplingConvention: 'nearest' as LiveDtmDescriptor['samplingConvention'] },
      { horizontalUnitToMetres: 0.3048 },
      { verticalUnitToMetres: 0.3048 },
      { extrapolationGuard: { radiusCells: 4, penalty: 0.5 } },
      { extrapolationGuard: { radiusCells: 8, penalty: 0.25 } },
    ];
    for (const m of mutations) {
      const mutated = { ...base, ...m } as LiveDtmDescriptor;
      expect(dtmMethodDigest(mutated), JSON.stringify(m)).not.toBe(baseDigest);
    }
  });

  it('does not fold CRS/datum/geoid into the digest', () => {
    const base = resolveLiveDtmDescriptor();
    const baseDigest = dtmMethodDigest(base);
    // Attach dataset-frame fields the descriptor does not model; the digest
    // reads only the method-behaviour projection, so they cannot move it.
    const withFrame = {
      ...base,
      crs: 'EPSG:6342',
      datum: 'NAD83(2011)',
      geoid: 'GEOID18',
    } as LiveDtmDescriptor;
    expect(dtmMethodDigest(withFrame)).toBe(baseDigest);
  });
});
