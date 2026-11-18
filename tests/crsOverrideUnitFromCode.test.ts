/**
 * An override EPSG that neither the file nor the curated registry describes
 * takes its kind and linear unit from the EPSG code itself.
 *
 * A session file, a catalogue record or an old stored record can carry any
 * code. A projected code in US survey feet was resolved as metres, and a
 * geographic code sent as projected passed every metric gate. The code's own
 * kind and unit now decide: a foot code converts by its foot, a code whose
 * kind contradicts the override resolves to an unknown CRS, and a code the
 * tables do not hold keeps its source units with metric claims withheld.
 */
import { describe, expect, it } from 'vitest';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import type { PcStacItem } from '../src/io/catalog/planetaryComputer';
import { recordCatalogueCrs } from '../src/app/pcCatalogueCrs';

function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** A scan with no declared CRS, then the override a session restore applies. */
function sessionOverride(epsg: number, kind: 'projected' | 'geographic' = 'projected'): CrsService {
  const svc = new CrsService(memoryPort());
  svc.resolveForScan({ name: 'scan.laz', detected: undefined, source: 'las-vlr' });
  svc.setOverride({ override: { epsg, kind }, detected: undefined, source: 'user-override', persist: false });
  return svc;
}

describe('a projected override outside the registry takes its unit from the code', () => {
  it('EPSG:2229 is in US survey feet', () => {
    const svc = sessionOverride(2229);
    const crs = svc.current()!;
    expect(crs.kind).toBe('projected');
    expect(crs.epsg).toBe(2229);
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.linearUnitToMetres).toBe(1200 / 3937);
  });

  it('EPSG:2222 is in international feet', () => {
    const crs = sessionOverride(2222).current()!;
    expect(crs.linearUnit).toBe('foot');
    expect(crs.linearUnitToMetres).toBe(0.3048);
  });

  it('a code the tables do not hold keeps source units and withholds metres', () => {
    const svc = sessionOverride(90000);
    const crs = svc.current()!;
    expect(crs.linearUnit).toBe('unknown');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(crs.linearUnitByFactor).toBeUndefined();
    expect(svc.context().linearUnitKnown).toBe(false);
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});

describe('an override whose kind contradicts its code resolves to an unknown CRS', () => {
  it('EPSG:4269 (geographic) sent as projected', () => {
    const svc = sessionOverride(4269);
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe('EPSG:4269 (the code is a geographic CRS, not projected)');
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('EPSG:2229 (projected) sent as geographic', () => {
    const svc = sessionOverride(2229, 'geographic');
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:2229 (the code is a projected CRS, not geographic)');
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('EPSG:4978 (geocentric) sent as projected', () => {
    const svc = sessionOverride(4978);
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:4978 (the code is a geocentric CRS, not projected)');
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});

/** A stream that declares no CRS, opened from a catalogue item whose record states `epsg`. */
function catalogueResolve(epsg: number): { svc: CrsService; crs: ReturnType<CrsService['resolveForScan']> } {
  const item: PcStacItem = {
    id: `Tile_${epsg}`,
    source: 'copc',
    assetUrl: `https://example.blob.core.windows.net/lidar/Tile_${epsg}.copc.laz`,
    bbox: [-118.3, 34.0, -118.2, 34.1],
    epsg,
  };
  const port = memoryPort();
  recordCatalogueCrs(item, port);
  const svc = new CrsService(port);
  const identity = datasetIdentity({
    sourcePointCount: 1000,
    renderOrigin: [6_400_000, 1_800_000, 300],
    dataBounds: () => [0, 0, 0, 100, 100, 10],
    catalogItem: { id: item.id, bbox: item.bbox },
  });
  const crs = svc.resolveForScan({ name: `Tile_${epsg}.copc.laz`, detected: undefined, source: 'copc-meta', identity });
  return { svc, crs };
}

describe('a catalogue record on a stream that declares no CRS', () => {
  it('EPSG:2229 from the catalogue is in US survey feet', () => {
    const { crs } = catalogueResolve(2229);
    expect(crs.source).toBe('catalog-tile');
    expect(crs.linearUnit).toBe('us-survey-foot');
    expect(crs.linearUnitToMetres).toBe(1200 / 3937);
  });
});

describe('a registry override whose kind contradicts the registry entry', () => {
  it.each([4326, 4258, 4979])('EPSG:%i (geographic) sent as projected resolves to an unknown CRS', (epsg) => {
    const svc = sessionOverride(epsg);
    const crs = svc.current()!;
    expect(crs.kind).toBe('unknown');
    expect(crs.name).toBe(`EPSG:${epsg} (the code is a geographic CRS, not projected)`);
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('EPSG:32612 (projected) sent as geographic resolves to an unknown CRS', () => {
    const svc = sessionOverride(32612, 'geographic');
    expect(svc.current()!.kind).toBe('unknown');
    expect(svc.current()!.name).toBe('EPSG:32612 (the code is a projected CRS, not geographic)');
    expect(svc.current()!.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it('a catalogue record 4326 on a stream that declares no CRS resolves to an unknown CRS', () => {
    const { svc, crs } = catalogueResolve(4326);
    expect(crs.source).toBe('catalog-tile');
    expect(crs.kind).toBe('unknown');
    expect(crs.epsg).toBeUndefined();
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });

  it.each([[4326, 'geographic'], [4979, 'geographic'], [32612, 'projected'], [25832, 'projected']] as const)(
    'EPSG:%i picked as %s is unchanged',
    (epsg, kind) => {
      const crs = sessionOverride(epsg, kind).current()!;
      expect(crs.kind).toBe(kind);
      expect(crs.epsg).toBe(epsg);
      expect(crs.linearUnit).toBe(kind === 'geographic' ? 'unknown' : 'metre');
      expect(crs.linearUnitToMetres).toBe(1);
    },
  );
});

describe('codes that resolve today are unchanged', () => {
  it.each([32612, 6339, 25832, 3577, 5070])('EPSG:%i stays metre with factor 1', (epsg) => {
    const svc = sessionOverride(epsg);
    const crs = svc.current()!;
    expect(crs.kind).toBe('projected');
    expect(crs.epsg).toBe(epsg);
    expect(crs.linearUnit).toBe('metre');
    expect(crs.linearUnitToMetres).toBe(1);
    expect(svc.context().metricClaimsPermitted).toBe(true);
  });

  it('EPSG:3857 stays grid-only', () => {
    const svc = sessionOverride(3857);
    expect(svc.current()!.linearUnit).toBe('metre');
    expect(svc.context().metricValidity).toBe('grid-only');
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});

describe('setOverride refuses a code outside the EPSG range', () => {
  it.each([163684, 3.5, -1, 0, 1023, 100000, Number.NaN])('EPSG %s returns null and leaves the CRS as it was', (epsg) => {
    const port = memoryPort();
    const svc = new CrsService(port);
    const before = svc.resolveForScan({ name: 'scan.laz', detected: undefined, source: 'las-vlr' });
    expect(svc.setOverride({ override: { epsg, kind: 'projected' }, detected: undefined, source: 'user-override' })).toBeNull();
    expect(svc.current()).toBe(before);
    expect(port.get('scan.laz')).toBeUndefined();
  });

  it('accepts the ends of the range', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: undefined, source: 'las-vlr' });
    expect(svc.setOverride({ override: { epsg: 1024, kind: 'projected' }, detected: undefined, source: 'user-override' })).not.toBeNull();
    expect(svc.setOverride({ override: { epsg: 99999, kind: 'projected' }, detected: undefined, source: 'user-override' })).not.toBeNull();
  });
});
