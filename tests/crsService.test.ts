/**
 * crsService.test.ts
 *
 * Contract tests for the centralised CRS service. Each test exercises
 * one boundary of the service — detection, override, validation, UTM,
 * subscribe / unsubscribe, disposal — using a fake override port so
 * no localStorage is touched.
 */

import { describe, it, expect, vi } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

// ── port factories ──────────────────────────────────────────────────

/** A fresh in-memory port that mimics the real override store. */
function makePort(): CrsOverridePort & {
  store: Map<string, CrsOverride>;
} {
  const store = new Map<string, CrsOverride>();
  return {
    store,
    get: (k) => store.get(k),
    set: (k, override) =>
      void store.set(k, { ...override, updatedAt: Date.now() }),
    clear: (k) => void store.delete(k),
  };
}

const NAD83_UTM_18N: CrsInfo = {
  source: 'wkt',
  name: 'NAD83 / UTM zone 18N',
  epsg: 26918,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
};

const WGS84_GEOGRAPHIC: CrsInfo = {
  source: 'wkt',
  name: 'WGS 84',
  epsg: 4326,
  linearUnit: 'unknown',
  linearUnitToMetres: 1,
  isGeographic: true,
};

// ── tests ───────────────────────────────────────────────────────────

describe('CrsService — initial state', () => {
  it('starts with no current CRS', () => {
    const svc = new CrsService(makePort());
    expect(svc.current()).toBeNull();
    expect(svc.currentDatasetKey()).toBeUndefined();
  });

  it('reports unknown-needs-confirmation validation when no scan is open', () => {
    const svc = new CrsService(makePort());
    expect(svc.validation().validity).toBe('unknown-needs-confirmation');
  });

  it('displayLabel reads "No scan loaded" before any resolve', () => {
    const svc = new CrsService(makePort());
    expect(svc.displayLabel()).toBe('No scan loaded');
  });
});

describe('CrsService.resolveForScan — detection path', () => {
  it('caches the resolved CRS for the active scan', () => {
    const svc = new CrsService(makePort());
    const resolved = svc.resolveForScan({
      name: 'East Levee.copc.laz',
      detected: NAD83_UTM_18N,
      source: 'copc-meta',
    });
    expect(resolved.kind).toBe('projected');
    expect(resolved.epsg).toBe(26918);
    expect(svc.current()).toBe(resolved);
  });

  it('normalises the dataset key (case + whitespace)', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: '  East Levee.LAZ  ',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(svc.currentDatasetKey()).toBe('east levee.laz');
  });

  it('falls back to unknown CRS when no detection signal is present', () => {
    const svc = new CrsService(makePort());
    const resolved = svc.resolveForScan({
      name: 'mystery.laz',
      detected: undefined,
      source: 'las-vlr',
    });
    expect(resolved.kind).toBe('unknown');
  });
});

describe('CrsService.resolveForScan — override precedence', () => {
  it('uses a persisted override over the detected CRS', () => {
    const port = makePort();
    port.store.set('east levee.copc.laz', {
      epsg: 32618,
      kind: 'projected',
      updatedAt: Date.now(),
    });
    const svc = new CrsService(port);
    const resolved = svc.resolveForScan({
      name: 'east levee.copc.laz',
      detected: NAD83_UTM_18N,
      source: 'copc-meta',
    });
    expect(resolved.epsg).toBe(32618);
    expect(resolved.source).toBe('user-override');
    expect(resolved.userConfirmed).toBe(true);
  });

  it('borrows the detector\'s WKT when the override matches its EPSG', () => {
    const detected: CrsInfo = {
      ...NAD83_UTM_18N,
      wkt: 'PROJCS["NAD83 / UTM zone 18N",GEOGCS["NAD83",DATUM["..."]],PROJECTION["Transverse_Mercator"]]',
    };
    const port = makePort();
    port.store.set('match.laz', {
      epsg: 26918,
      kind: 'projected',
      updatedAt: Date.now(),
    });
    const svc = new CrsService(port);
    const resolved = svc.resolveForScan({
      name: 'match.laz',
      detected,
      source: 'las-vlr',
    });
    expect(resolved.wkt).toContain('PROJCS');
  });

  it('falls back to local override when override is the local sentinel', () => {
    const port = makePort();
    port.store.set('phone.ply', {
      epsg: null,
      kind: 'local',
      updatedAt: Date.now(),
    });
    const svc = new CrsService(port);
    const resolved = svc.resolveForScan({
      name: 'phone.ply',
      detected: undefined,
      source: 'las-vlr',
    });
    expect(resolved.kind).toBe('local');
    expect(resolved.userConfirmed).toBe(true);
  });
});

describe('CrsService.setOverride', () => {
  it('persists a new override and re-resolves immediately', () => {
    const port = makePort();
    const svc = new CrsService(port);
    svc.resolveForScan({
      name: 'levee.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    const next = svc.setOverride({
      override: { epsg: 32618, kind: 'projected' },
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(next?.epsg).toBe(32618);
    expect(next?.userConfirmed).toBe(true);
    expect(port.store.get('levee.laz')?.epsg).toBe(32618);
  });

  it('clears a persisted override on the "use detected" sentinel', () => {
    const port = makePort();
    port.store.set('levee.laz', {
      epsg: 32618,
      kind: 'projected',
      updatedAt: Date.now(),
    });
    const svc = new CrsService(port);
    svc.resolveForScan({
      name: 'levee.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    const next = svc.setOverride({
      override: { epsg: null, kind: 'local' },
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(port.store.has('levee.laz')).toBe(false);
    // Falls back to the detected CRS (26918), NOT the local fallback.
    expect(next?.epsg).toBe(26918);
    expect(next?.userConfirmed).toBe(false);
  });

  it('is a no-op when there is no active scan', () => {
    const port = makePort();
    const svc = new CrsService(port);
    const next = svc.setOverride({
      override: { epsg: 26918, kind: 'projected' },
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(next).toBeNull();
    expect(port.store.size).toBe(0);
  });
});

describe('CrsService.clear — disposal contract', () => {
  it('clears the current CRS and dataset key', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'one.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    svc.clear();
    expect(svc.current()).toBeNull();
    expect(svc.currentDatasetKey()).toBeUndefined();
  });

  it('is idempotent — clearing twice does not throw', () => {
    const svc = new CrsService(makePort());
    expect(() => {
      svc.clear();
      svc.clear();
    }).not.toThrow();
  });

  it('broadcasts null to subscribers on clear', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'one.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    const seen: (string | null)[] = [];
    svc.subscribe((crs) => {
      seen.push(crs ? `${crs.epsg ?? 'none'}` : null);
    });
    svc.clear();
    // [initial-on-subscribe, clear]
    expect(seen[seen.length - 1]).toBeNull();
  });
});

describe('CrsService — repeated open/close cycles', () => {
  it('does not leak state across distinct scans', () => {
    const port = makePort();
    const svc = new CrsService(port);

    svc.resolveForScan({
      name: 'first.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(svc.currentDatasetKey()).toBe('first.laz');
    svc.clear();

    svc.resolveForScan({
      name: 'second.laz',
      detected: WGS84_GEOGRAPHIC,
      source: 'las-vlr',
    });
    expect(svc.currentDatasetKey()).toBe('second.laz');
    expect(svc.current()?.epsg).toBe(4326);
  });

  it('survives a tight open / close / open loop without retaining stale validation', () => {
    const svc = new CrsService(makePort());
    for (let i = 0; i < 50; i++) {
      svc.resolveForScan({
        name: `scan-${i}.laz`,
        detected: NAD83_UTM_18N,
        source: 'las-vlr',
      });
      svc.clear();
    }
    // After 50 cycles ending in clear(), the validation is the "no scan"
    // verdict, not stale projected metric.
    expect(svc.validation().validity).toBe('unknown-needs-confirmation');
  });
});

describe('CrsService.validation — bridges to CrsValidation', () => {
  it('returns safe-metric for a projected detected CRS', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'projected.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(svc.validation().canDisplayMetric).toBe(true);
    expect(svc.validation().canSaveMeasurement).toBe(true);
  });

  it('returns requires-projection for a geographic detected CRS', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'geo.laz',
      detected: WGS84_GEOGRAPHIC,
      source: 'las-vlr',
    });
    expect(svc.validation().canDisplayMetric).toBe(false);
    expect(svc.validation().canSaveMeasurement).toBe(false);
  });
});

describe('CrsService.utmFor — passthrough', () => {
  it('returns the same UTM result as the underlying helper', () => {
    const svc = new CrsService(makePort());
    const result = svc.utmFor(40.7128, -74.006);
    expect(result.zone).toBe(18);
    expect(result.hemisphere).toBe('N');
    expect(Number.isFinite(result.easting)).toBe(true);
  });

  it('utmZoneFor returns the canonical zone + hemisphere', () => {
    const svc = new CrsService(makePort());
    expect(svc.utmZoneFor(48.8566, 2.3522).zone).toBe(31);
    expect(svc.utmZoneFor(-33.8688, 151.2093).hemisphere).toBe('S');
  });
});

describe('CrsService.subscribe — pub/sub contract', () => {
  it('fires the listener immediately with the current value', () => {
    const svc = new CrsService(makePort());
    const listener = vi.fn();
    svc.subscribe(listener);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(null);
  });

  it('broadcasts on every resolve', () => {
    const svc = new CrsService(makePort());
    const listener = vi.fn();
    svc.subscribe(listener);
    svc.resolveForScan({
      name: 'a.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    // initial + resolve
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('returns an unsubscribe function that actually detaches', () => {
    const svc = new CrsService(makePort());
    const listener = vi.fn();
    const unsubscribe = svc.subscribe(listener);
    unsubscribe();
    svc.resolveForScan({
      name: 'a.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    // Only the initial-on-subscribe firing.
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates a buggy subscriber so others still fire', () => {
    const svc = new CrsService(makePort());
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    svc.subscribe(bad);
    svc.subscribe(good);
    svc.resolveForScan({
      name: 'a.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(good).toHaveBeenCalledTimes(2);
  });

  it('subscriberCount tracks add + remove accurately', () => {
    const svc = new CrsService(makePort());
    expect(svc.subscriberCount()).toBe(0);
    const u1 = svc.subscribe(() => {});
    const u2 = svc.subscribe(() => {});
    expect(svc.subscriberCount()).toBe(2);
    u1();
    expect(svc.subscriberCount()).toBe(1);
    u2();
    expect(svc.subscriberCount()).toBe(0);
  });
});

describe('CrsService.displayLabel', () => {
  it('formats EPSG + name when both are known', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'levee.laz',
      detected: NAD83_UTM_18N,
      source: 'las-vlr',
    });
    expect(svc.displayLabel()).toContain('EPSG:26918');
  });

  it('reads "Local coordinates" for a local-kind CRS', () => {
    const port = makePort();
    port.store.set('phone.ply', {
      epsg: null,
      kind: 'local',
      updatedAt: Date.now(),
    });
    const svc = new CrsService(port);
    svc.resolveForScan({
      name: 'phone.ply',
      detected: undefined,
      source: 'las-vlr',
    });
    expect(svc.displayLabel()).toBe('Local coordinates');
  });

  it('reads "CRS unknown" when nothing was detected', () => {
    const svc = new CrsService(makePort());
    svc.resolveForScan({
      name: 'mystery.laz',
      detected: undefined,
      source: 'las-vlr',
    });
    expect(svc.displayLabel()).toBe('CRS unknown');
  });
});
