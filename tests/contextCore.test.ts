/**
 * contextCore.test.ts
 *
 * Pins the pure Context View core: eligibility, footprints, camera placement,
 * consent, providers, and the status vocabulary. Untested, this surface could
 * fail in ways that lie to the user — a local-grid scan silently drawn on a
 * world map, a fabricated heading for a straight-down camera, a corrupt
 * persisted blob parsing into 'granted' and letting tiles fetch without
 * consent, or a refusal shipping with no explanation. Every case here guards
 * one of those honesty promises.
 */

import { describe, it, expect } from 'vitest';
import {
  CONTEXT_STATUS,
  decideContextEligibility,
  buildContextFootprint,
  mapCameraToContext,
  createConsentState,
  parseContextConsent,
  NULL_PROVIDER,
  OSM_PROVIDER,
  type ContextLayerFacts,
  type LonLatTransform,
} from '../src/geo/context/index';

/** All facts satisfied — the only eligible baseline. */
const ALL_TRUE: ContextLayerFacts = {
  crsKnown: true,
  geographic: false,
  projected: true,
  horizontalDatumKnown: true,
  toWgs84Available: true,
  boundsFinite: true,
};

/** Identity-ish fake transform: metres → tiny degrees. Deterministic, no proj4. */
const fakeTransform: LonLatTransform = (x, y) => [x / 1000, y / 1000];

describe('contextEligibility', () => {
  it('is eligible when every fact holds (projected frame)', () => {
    expect(decideContextEligibility(ALL_TRUE)).toEqual({ eligible: true });
  });

  it('is eligible for a geographic frame too', () => {
    expect(
      decideContextEligibility({ ...ALL_TRUE, geographic: true, projected: false }),
    ).toEqual({ eligible: true });
  });

  it('refuses an unknown CRS with exactly the vocabulary string', () => {
    const d = decideContextEligibility({ ...ALL_TRUE, crsKnown: false });
    expect(d).toEqual({ eligible: false, reasons: [CONTEXT_STATUS.crsUnknown] });
  });

  it('refuses an unknown horizontal datum', () => {
    const d = decideContextEligibility({ ...ALL_TRUE, horizontalDatumKnown: false });
    expect(d).toEqual({ eligible: false, reasons: [CONTEXT_STATUS.datumUnknown] });
  });

  it('refuses local/unreferenced coordinates (neither geographic nor projected)', () => {
    const d = decideContextEligibility({ ...ALL_TRUE, geographic: false, projected: false });
    expect(d).toEqual({ eligible: false, reasons: [CONTEXT_STATUS.localCoordinates] });
  });

  it('refuses when no transform to WGS84 exists', () => {
    const d = decideContextEligibility({ ...ALL_TRUE, toWgs84Available: false });
    expect(d).toEqual({ eligible: false, reasons: [CONTEXT_STATUS.transformUnavailable] });
  });

  it('refuses non-finite bounds', () => {
    const d = decideContextEligibility({ ...ALL_TRUE, boundsFinite: false });
    expect(d).toEqual({ eligible: false, reasons: [CONTEXT_STATUS.boundsNotFinite] });
  });

  it('orders multiple reasons deterministically (CRS → transform → bounds)', () => {
    const d = decideContextEligibility({
      crsKnown: false,
      geographic: false,
      projected: false,
      horizontalDatumKnown: false,
      toWgs84Available: false,
      boundsFinite: false,
    });
    expect(d).toEqual({
      eligible: false,
      reasons: [
        CONTEXT_STATUS.crsUnknown,
        CONTEXT_STATUS.transformUnavailable,
        CONTEXT_STATUS.boundsNotFinite,
      ],
    });
  });
});

describe('footprintModel', () => {
  const bounds = { minX: 1000, minY: 2000, maxX: 3000, maxY: 4000 };

  it('builds an 8-point unclosed ring of corners + edge midpoints', () => {
    const fp = buildContextFootprint('layer-1', 'Site scan', bounds, fakeTransform);
    if ('failed' in fp) throw new Error('expected success');
    expect(fp.layerId).toBe('layer-1');
    expect(fp.name).toBe('Site scan');
    expect(fp.ringLonLat).toHaveLength(8);
    // Corners in order, midpoints between them; first point NOT repeated last.
    expect(fp.ringLonLat[0]).toEqual([1, 2]);
    expect(fp.ringLonLat[1]).toEqual([2, 2]); // south edge midpoint
    expect(fp.ringLonLat[2]).toEqual([3, 2]);
    expect(fp.ringLonLat[4]).toEqual([3, 4]);
    expect(fp.ringLonLat[6]).toEqual([1, 4]);
    expect(fp.ringLonLat[7]).not.toEqual(fp.ringLonLat[0]);
  });

  it('refuses (does not partially build) when the transform returns null', () => {
    const flaky: LonLatTransform = (x, y) => (x === 3000 ? null : [x / 1000, y / 1000]);
    const fp = buildContextFootprint('l', 'n', bounds, flaky);
    expect(fp).toEqual({ failed: true, reason: CONTEXT_STATUS.transformUnavailable });
  });

  it('refuses when the transform yields non-finite degrees', () => {
    const nan: LonLatTransform = () => [Number.NaN, 0];
    const fp = buildContextFootprint('l', 'n', bounds, nan);
    expect(fp).toEqual({ failed: true, reason: CONTEXT_STATUS.transformUnavailable });
  });

  it('throws a TypeError naming "bounds" on non-finite input bounds', () => {
    expect(() =>
      buildContextFootprint('l', 'n', { ...bounds, maxY: Number.NaN }, fakeTransform),
    ).toThrowError(TypeError);
    expect(() =>
      buildContextFootprint('l', 'n', { ...bounds, minX: Infinity }, fakeTransform),
    ).toThrowError(/"bounds"/);
  });
});

describe('cameraModel', () => {
  it('maps position through the injected transform', () => {
    const r = mapCameraToContext(1500, 2500, 0, 1, fakeTransform);
    if ('failed' in r) throw new Error('expected placement');
    expect(r.position).toEqual([1.5, 2.5]);
  });

  it('heading is 0 for north (+Y) and 90 for east (+X), clockwise from north', () => {
    const north = mapCameraToContext(0, 0, 0, 1, fakeTransform);
    const east = mapCameraToContext(0, 0, 1, 0, fakeTransform);
    const south = mapCameraToContext(0, 0, 0, -1, fakeTransform);
    if ('failed' in north || 'failed' in east || 'failed' in south) throw new Error('expected placements');
    expect(north.headingDeg).toBe(0);
    expect(east.headingDeg).toBe(90);
    expect(south.headingDeg).toBe(180);
  });

  it('a zero-length direction yields headingDeg null, never a fabricated heading', () => {
    const r = mapCameraToContext(10, 10, 0, 0, fakeTransform);
    if ('failed' in r) throw new Error('expected placement');
    expect(r.headingDeg).toBeNull();
  });

  it('refuses when the transform declines the position', () => {
    const never: LonLatTransform = () => null;
    expect(mapCameraToContext(1, 2, 0, 1, never)).toEqual({ failed: true });
  });

  it('throws TypeError on non-finite position or direction', () => {
    expect(() => mapCameraToContext(Number.NaN, 0, 0, 1, fakeTransform)).toThrowError(TypeError);
    expect(() => mapCameraToContext(0, 0, Infinity, 1, fakeTransform)).toThrowError(TypeError);
  });
});

describe('consent', () => {
  it('starts unasked, with the network NOT permitted', () => {
    const s = createConsentState();
    expect(s.get()).toBe('unasked');
    expect(s.networkPermitted()).toBe(false);
  });

  it('grant/deny/reset transition as expected', () => {
    const s = createConsentState();
    s.grant();
    expect(s.get()).toBe('granted');
    s.deny();
    expect(s.get()).toBe('denied');
    s.reset();
    expect(s.get()).toBe('unasked');
  });

  it('networkPermitted is true ONLY in the granted state', () => {
    const s = createConsentState();
    s.deny();
    expect(s.networkPermitted()).toBe(false);
    s.grant();
    expect(s.networkPermitted()).toBe(true);
    s.reset();
    expect(s.networkPermitted()).toBe(false);
  });

  it('parse tolerates garbage as unasked and never mints granted from junk', () => {
    expect(parseContextConsent(undefined)).toBe('unasked');
    expect(parseContextConsent(null)).toBe('unasked');
    expect(parseContextConsent('')).toBe('unasked');
    expect(parseContextConsent('GRANTED')).toBe('unasked');
    expect(parseContextConsent(' granted ')).toBe('unasked');
    expect(parseContextConsent('{"granted":true}')).toBe('unasked');
    expect(parseContextConsent(42)).toBe('unasked');
  });

  it('parse accepts exactly the serialized granted/denied strings', () => {
    expect(parseContextConsent('granted')).toBe('granted');
    expect(parseContextConsent('denied')).toBe('denied');
  });

  it('serialize round-trips through parse for every state', () => {
    const s = createConsentState();
    expect(parseContextConsent(s.serialize())).toBe('unasked');
    s.grant();
    expect(parseContextConsent(s.serialize())).toBe('granted');
    s.deny();
    expect(parseContextConsent(s.serialize())).toBe('denied');
  });
});

describe('statusVocabulary', () => {
  it('every status string is non-empty prose', () => {
    for (const value of Object.values(CONTEXT_STATUS)) {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
  });

  it('no two statuses share the same string (each surface is distinguishable)', () => {
    const values = Object.values(CONTEXT_STATUS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('is frozen — the vocabulary cannot be mutated at runtime', () => {
    expect(Object.isFrozen(CONTEXT_STATUS)).toBe(true);
  });
});

describe('providerInterface', () => {
  it('OSM is a data-only descriptor that requires consent and carries attribution', () => {
    expect(OSM_PROVIDER.requiresConsent).toBe(true);
    expect(OSM_PROVIDER.attribution).toBe('© OpenStreetMap contributors');
    expect(OSM_PROVIDER.urlTemplate).toContain('{z}');
    expect(OSM_PROVIDER.urlTemplate).toContain('{x}');
    expect(OSM_PROVIDER.urlTemplate).toContain('{y}');
    expect(OSM_PROVIDER.maxZoom).toBeGreaterThan(0);
  });

  it('the NULL provider has NO urlTemplate property at all — nothing to fetch', () => {
    expect(NULL_PROVIDER.id).toBe('none');
    expect(NULL_PROVIDER.attribution).toBe('');
    expect(NULL_PROVIDER.requiresConsent).toBe(false);
    expect('urlTemplate' in NULL_PROVIDER).toBe(false);
  });
});
