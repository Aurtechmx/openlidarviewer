/**
 * crsFoundation.test.ts
 *
 * The CRS foundation — types, registry, and override store. Pure
 * Node tests; no DOM env required for any of these because
 * CrsOverrideStore guards every storage access with the suppressed-by-
 * environment check.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  localCrs,
  resolvedFromCrsInfo,
  unknownCrs,
} from '../src/geo/CoordinateTypes';
import {
  getCrsEntry,
  listCrsEntries,
  listCrsEntriesByRegion,
} from '../src/geo/CrsRegistry';
import {
  _resetSuppressionLatchForTesting,
  clearAllOverrides,
  clearOverride,
  getOverride,
  isSuppressed,
  keyForDataset,
  setOverride,
  snapshotOverrides,
} from '../src/geo/CrsOverrideStore';
import type { CrsInfo } from '../src/io/crs';

describe('CoordinateTypes — resolvedFromCrsInfo', () => {
  it('returns null for undefined input', () => {
    expect(resolvedFromCrsInfo(undefined, 'las-vlr')).toBeNull();
  });

  it('promotes EPSG+WKT to high confidence', () => {
    const info: CrsInfo = {
      source: 'wkt',
      name: 'WGS 84 / UTM zone 12N',
      epsg: 32612,
      wkt: 'PROJCS["WGS 84 / UTM zone 12N",…]',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    const resolved = resolvedFromCrsInfo(info, 'las-vlr');
    expect(resolved?.confidence).toBe('high');
    expect(resolved?.kind).toBe('projected');
    expect(resolved?.epsg).toBe(32612);
    expect(resolved?.source).toBe('las-vlr');
    expect(resolved?.userConfirmed).toBe(false);
  });

  it('marks EPSG-only (no WKT) as medium confidence', () => {
    const info: CrsInfo = {
      source: 'geotiff',
      name: 'WGS 84 / UTM zone 12N',
      epsg: 32612,
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    expect(resolvedFromCrsInfo(info, 'las-vlr')?.confidence).toBe('medium');
  });

  it('marks WKT-only-with-EPSG-prefixed-name as medium confidence', () => {
    const info: CrsInfo = {
      source: 'wkt',
      name: 'EPSG:32612',
      wkt: 'PROJCS[…]',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    expect(resolvedFromCrsInfo(info, 'las-vlr')?.confidence).toBe('medium');
  });

  it('marks bare-name-only as low confidence', () => {
    const info: CrsInfo = {
      source: 'wkt',
      name: 'My survey CRS',
      linearUnit: 'metre',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
    expect(resolvedFromCrsInfo(info, 'las-vlr')?.confidence).toBe('low');
  });

  it('classifies isGeographic=true as geographic kind', () => {
    const info: CrsInfo = {
      source: 'wkt',
      name: 'WGS 84',
      epsg: 4326,
      wkt: 'GEOGCS["WGS 84",…]',
      linearUnit: 'unknown',
      linearUnitToMetres: 1,
      isGeographic: true,
    };
    expect(resolvedFromCrsInfo(info, 'las-vlr')?.kind).toBe('geographic');
  });
});

describe('CoordinateTypes — localCrs + unknownCrs', () => {
  it('localCrs has kind=local and high confidence (we know it is local)', () => {
    const c = localCrs();
    expect(c.kind).toBe('local');
    expect(c.confidence).toBe('high');
    expect(c.epsg).toBeUndefined();
  });

  it('unknownCrs has kind=unknown and confidence=none', () => {
    const c = unknownCrs();
    expect(c.kind).toBe('unknown');
    expect(c.confidence).toBe('none');
    expect(c.epsg).toBeUndefined();
  });
});

describe('CrsRegistry', () => {
  it('lists every entry in display order', () => {
    const entries = listCrsEntries();
    expect(entries.length).toBeGreaterThan(20);
    // Spot-check: WGS84 comes first (global, geographic).
    expect(entries[0]?.epsg).toBe(4326);
  });

  it('looks up by EPSG code', () => {
    const utm12n = getCrsEntry(32612);
    expect(utm12n).toBeDefined();
    expect(utm12n?.label).toContain('UTM zone 12N');
    expect(utm12n?.kind).toBe('projected');
  });

  it('returns undefined for unknown EPSG', () => {
    expect(getCrsEntry(999999)).toBeUndefined();
  });

  it('groups entries by region (global, US, Mexico, Europe)', () => {
    const groups = listCrsEntriesByRegion();
    const regions = groups.map((g) => g.region);
    expect(regions).toContain('global');
    expect(regions).toContain('united-states');
    expect(regions).toContain('mexico');
    expect(regions).toContain('europe');
    // Every group has at least one entry (empty groups are dropped).
    for (const g of groups) expect(g.entries.length).toBeGreaterThan(0);
  });

  it('covers every CONUS UTM zone (10N through 19N) under NAD83', () => {
    for (let zone = 10; zone <= 19; zone++) {
      const epsg = 26900 + zone;
      const entry = getCrsEntry(epsg);
      expect(entry?.label).toContain(`UTM zone ${zone}N`);
    }
  });

  it('carries EPSG:28992 — Dutch RD New, the AHN national LiDAR projection', () => {
    const entry = getCrsEntry(28992);
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe('projected');
    expect(entry?.region).toBe('europe');
    expect(entry?.label).toContain('RD New');
  });

  it('has no duplicate EPSG codes — the picker shows each at most once', () => {
    // Regression guard: when a new region is added it's easy to paste a
    // global entry (WGS84, ETRS89) a second time and end up with a
    // picker that shows the same row twice. Pin uniqueness at the
    // contract.
    const epsgCodes = listCrsEntries().map((e) => e.epsg);
    const unique = new Set(epsgCodes);
    expect(unique.size).toBe(epsgCodes.length);
  });
});

describe('CrsOverrideStore', () => {
  beforeEach(() => {
    _resetSuppressionLatchForTesting();
  });

  it('is suppressed in a Node test env (no window) and returns undefined', () => {
    expect(isSuppressed()).toBe(true);
    expect(getOverride('any-key')).toBeUndefined();
    // set is a no-op under suppression — never throws.
    expect(() => setOverride('any-key', { epsg: 32612, kind: 'projected' })).not.toThrow();
    expect(getOverride('any-key')).toBeUndefined();
  });

  it('clearAllOverrides is a no-op under suppression', () => {
    expect(() => clearAllOverrides()).not.toThrow();
  });

  it('snapshotOverrides returns empty under suppression', () => {
    expect(snapshotOverrides()).toEqual([]);
  });

  it('clearOverride is a no-op under suppression', () => {
    expect(() => clearOverride('any-key')).not.toThrow();
  });

  it('keyForDataset normalises whitespace + case', () => {
    expect(keyForDataset('  East Levee.LAZ  ')).toBe('east levee.laz');
    expect(keyForDataset('east levee.LAZ')).toBe('east levee.laz');
  });

  it('keyForDataset truncates very long names', () => {
    const long = 'a'.repeat(500);
    expect(keyForDataset(long).length).toBeLessThanOrEqual(200);
  });
});
