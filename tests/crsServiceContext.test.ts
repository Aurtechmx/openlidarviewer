/**
 * crsServiceContext.test.ts
 *
 * `CrsService.context()` is the application boundary where the one
 * SpatialContext for the active scan is built. Two things must hold, and both
 * are load-bearing for the migration:
 *
 *   1. Two reads inside one frame return the SAME object, so two consumers
 *      cannot end up holding contexts that disagree about the same scan.
 *   2. A CRS change invalidates it, so a stale context can never outlive the
 *      override that replaced it.
 *
 * Plus the fail-closed edge: with no scan open the context is the explicit
 * unknown frame, not null, so a consumer that reads it early withholds its
 * claim instead of throwing.
 */

import { describe, it, expect } from 'vitest';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsInfo } from '../src/io/crs';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { spatialContextFrom } from '../src/geo/SpatialContext';

/** An in-memory override port so the test never touches browser storage. */
function memoryPort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return {
    get: (k) => store.get(k),
    set: (k, override) => void store.set(k, { ...override, updatedAt: Date.now() }),
    clear: (k) => void store.delete(k),
  };
}

const utm12: CrsInfo = {
  source: 'wkt',
  name: 'WGS 84 / UTM zone 12N',
  epsg: 32612,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
  verticalEpsg: 5703,
  verticalDatum: 'NAVD88',
  verticalUnitToMetres: 1,
};

describe('CrsService.context()', () => {
  it('is never null, and fails closed before a scan is open', () => {
    const svc = new CrsService(memoryPort());
    const ctx = svc.context();
    expect(ctx.kind).toBe('unknown');
    expect(ctx.linearUnitKnown).toBe(false);
    expect(ctx.metricClaimsPermitted).toBe(false);
    expect(ctx.verticalScaleKnown).toBe(false);
    expect(ctx.verticalReferenceKnown).toBe(false);
  });

  it('returns the SAME object on repeated reads, so consumers cannot diverge', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: utm12, source: 'las-vlr' });
    expect(svc.context()).toBe(svc.context());
  });

  it('agrees with a context built directly from the resolved CRS', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: utm12, source: 'las-vlr' });
    expect(svc.context()).toEqual(spatialContextFrom(svc.current()));
  });

  it('carries the metric permission for a projected metre CRS', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: utm12, source: 'las-vlr' });
    const ctx = svc.context();
    expect(ctx.linearUnitKnown).toBe(true);
    expect(ctx.metricClaimsPermitted).toBe(true);
    expect(ctx.verticalReference).toBe('orthometric');
    expect(ctx.verticalScaleKnown).toBe(true);
  });

  it('rebuilds after an override, so no consumer keeps a stale frame', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: utm12, source: 'las-vlr' });
    const before = svc.context();
    svc.setOverride({
      override: { epsg: null, kind: 'local' },
      detected: undefined,
      source: 'user-override',
    });
    const after = svc.context();
    expect(after).not.toBe(before);
    expect(after.kind).toBe('unknown');
    expect(after.metricClaimsPermitted).toBe(false);
  });

  it('rebuilds on clear()', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'scan.laz', detected: utm12, source: 'las-vlr' });
    const before = svc.context();
    svc.clear();
    expect(svc.context()).not.toBe(before);
    expect(svc.context().metricClaimsPermitted).toBe(false);
  });
});
