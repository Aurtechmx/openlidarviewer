/**
 * A streamed layer is classified and exported on its OWN header CRS and its own
 * override, never on whichever scan happens to be active.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt } from '../src/io/crs';
import { CrsService, datasetIdentity, type CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';
import { makeStreamingCrsResolver } from '../src/app/exportCrsResolver';
import { resolveStreamingCompatibilityFromCrs } from '../src/render/streamingCompatibility';
import type { CrsInfo } from '../src/io/crs';

const UTM12 = crsFromWkt('PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]]');
const UTM13 = crsFromWkt('PROJCS["WGS 84 / UTM zone 13N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32613"]]');

function port(): CrsOverridePort {
  const m = new Map<string, CrsOverride>();
  return { get: (k) => m.get(k), set: (k, o) => void m.set(k, { ...o, updatedAt: 1 }), clear: (k) => void m.delete(k) };
}
const stream = (crs: CrsInfo | undefined) => ({ name: 'tiles.copc.laz', kind: 'copc' as const, crs: () => crs, sourcePointCount: 1000, dataBounds: () => [0, 0, 0, 10, 10, 10] });

function setup(staticCrs: CrsInfo, streamCrs: CrsInfo | undefined, activeIsStatic: boolean) {
  const svc = new CrsService(port());
  const s = stream(streamCrs);
  if (activeIsStatic) svc.resolveForScan({ name: 'static.las', detected: staticCrs, source: 'las-vlr' });
  else svc.resolveForScan({ name: s.name, detected: streamCrs, source: 'copc-meta' });
  const streamCrsOf = makeStreamingCrsResolver(() => s, svc);
  const staticResolved = svc.resolveFor({ name: 'static.las', detected: staticCrs, source: 'las-vlr' });
  return { streamResolved: streamCrsOf().resolved ?? null, staticResolved, svc, s };
}

describe('streamed layer CRS', () => {
  it('static active, stream in a different CRS: stream keeps its own and is incompatible', () => {
    const { streamResolved, staticResolved } = setup(UTM12, UTM13, true);
    expect(streamResolved?.epsg).toBe(32613);
    expect(resolveStreamingCompatibilityFromCrs([staticResolved], streamResolved)).toBe('incompatible');
  });

  it('static active, stream with no CRS: stream is unresolved, not borrowed', () => {
    const { streamResolved, staticResolved } = setup(UTM12, undefined, true);
    expect(streamResolved?.kind).toBe('unknown');
    expect(resolveStreamingCompatibilityFromCrs([staticResolved], streamResolved)).toBe('unknown');
  });

  it('stream active beside a static scan in another CRS: incompatible', () => {
    const { streamResolved, staticResolved } = setup(UTM13, UTM12, false);
    expect(streamResolved?.epsg).toBe(32612);
    expect(resolveStreamingCompatibilityFromCrs([staticResolved], streamResolved)).not.toBe('verified');
  });

  it('both declared in the same projected CRS: not refused on horizontal grounds', () => {
    for (const active of [true, false]) {
      const { streamResolved, staticResolved } = setup(UTM12, UTM12, active);
      expect(streamResolved?.epsg).toBe(32612);
      expect(['verified', 'horizontal-only']).toContain(resolveStreamingCompatibilityFromCrs([staticResolved], streamResolved));
    }
  });

  it("applies the stream's own override", () => {
    const svc = new CrsService(port());
    const s = stream(undefined);
    svc.resolveForScan({ name: s.name, detected: undefined, source: 'copc-meta', identity: datasetIdentity(s) });
    svc.setOverride({ override: { epsg: 32612, kind: 'projected' }, detected: undefined, source: 'copc-meta' });
    svc.resolveForScan({ name: 'static.las', detected: UTM13, source: 'las-vlr' });
    expect(makeStreamingCrsResolver(() => s, svc)().resolved?.epsg).toBe(32612);
  });

  it('no stream open: resolves nothing', () => {
    const svc = new CrsService(port());
    svc.resolveForScan({ name: 'static.las', detected: UTM12, source: 'las-vlr' });
    expect(makeStreamingCrsResolver(() => null, svc)().wkt).toBeNull();
  });
});
