/**
 * The Export readiness rows read the RESOLVED coordinate system, so a CRS the
 * user assigns (or a local override of a declared one) shows there at once,
 * without reopening the file. Reading the file's declaration instead left a
 * scan with an empty WKT record at "Unknown" after the user assigned EPSG:5514.
 */
import { describe, it, expect } from 'vitest';
import { georefKnown } from '../src/app/kmlActions';
import { CrsService, type CrsOverridePort } from '../src/geo/CrsService';
import { crsFromEpsg } from '../src/io/crs';

function memoryPort(): CrsOverridePort {
  const m = new Map<string, unknown>();
  return { get: (k) => m.get(k) as ReturnType<CrsOverridePort['get']>, set: (k, v) => void m.set(k, v), clear: (k) => void m.delete(k) };
}

describe('Export readiness georeferencing', () => {
  it('no scan: no claim either way', () => {
    expect(georefKnown(null)).toEqual({ crsKnown: undefined, datumKnown: undefined });
  });

  it('a file with no CRS: unknown, then known once the user assigns one', () => {
    const svc = new CrsService(memoryPort());
    svc.resolveForScan({ name: 'iPhone.laz', detected: undefined, source: 'las-vlr' });
    expect(georefKnown(svc.current()).crsKnown).toBe(false);
    svc.setOverride({ override: { epsg: 5514, kind: 'projected' }, detected: undefined, source: 'las-vlr' });
    expect(georefKnown(svc.current())).toEqual({ crsKnown: true, datumKnown: false });
  });

  it('a declared CRS overridden to local coordinates is no longer known', () => {
    const svc = new CrsService(memoryPort());
    const declared = crsFromEpsg(32633);
    svc.resolveForScan({ name: 'a.las', detected: declared, source: 'las-vlr' });
    expect(georefKnown(svc.current()).crsKnown).toBe(true);
    svc.setOverride({ override: { epsg: null, kind: 'local' }, detected: declared, source: 'las-vlr' });
    expect(georefKnown(svc.current()).crsKnown).toBe(false);
  });
});
