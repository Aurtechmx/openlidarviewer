/**
 * Named local / engineering CRSs (WKT1 LOCAL_CS, WKT2 ENGCRS) keep their name
 * and key on it. Different names are different frames; the same name is
 * unverified, never a match. Unknown-CRS layers are unaffected.
 */
import { describe, it, expect } from 'vitest';
import { crsFromWkt, type CrsInfo } from '../src/io/crs';
import { horizontalKey, detectCrsMismatch, type LayerInfo } from '../src/model/layerModel';
import { classifyLayerCompatibility } from '../src/model/layerCompatibility';
import { compareSpatialFrames } from '../src/geo/frameCompatibility';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import { resolvedFromCrsInfo } from '../src/geo/CoordinateTypes';
import { prepareEpochFrames } from '../src/app/epochFramePrep';
import { CrsService } from '../src/geo/CrsService';
import type { CrsOverridePort } from '../src/geo/CrsService';
import type { CrsOverride } from '../src/geo/CrsOverrideStore';

const LOCAL_A = 'LOCAL_CS["Site A grid",LOCAL_DATUM["A",0],UNIT["metre",1]]';
const LOCAL_B = 'LOCAL_CS["Site B grid",LOCAL_DATUM["B",0],UNIT["metre",1]]';
const ENG_A = 'ENGCRS["Plant A",EDATUM["A"],CS[Cartesian,2],AXIS["x",east],AXIS["y",north],LENGTHUNIT["metre",1]]';
const ENG_B = 'ENGCRS["Plant B",EDATUM["B"],CS[Cartesian,2],AXIS["x",east],AXIS["y",north],LENGTHUNIT["metre",1]]';

function layer(id: string, crs: CrsInfo): LayerInfo {
  const r = resolvedFromCrsInfo(crs, 'las-vlr')!;
  return {
    id, name: id, pointCount: 1, visible: true, locked: false,
    crsName: r.name, ...(r.localFrameName ? { localFrameName: r.localFrameName } : {}),
  };
}

function makePort(): CrsOverridePort {
  const store = new Map<string, CrsOverride>();
  return {
    get: (k) => store.get(k),
    set: (k, o) => void store.set(k, { ...o, updatedAt: 1 }),
    clear: (k) => void store.delete(k),
  };
}

const epoch = (name: string, crs: CrsInfo) => ({
  name, sourceFormat: 'las' as const,
  positions: new Float32Array([0, 0, 0, 1, 1, 1]),
  sourceOrigin: [0, 0, 0] as [number, number, number],
  metadata: { crs },
});

describe('named local frames', () => {
  it('keeps the LOCAL_CS and ENGCRS name and marks the frame local', () => {
    for (const [wkt, name] of [[LOCAL_A, 'Site A grid'], [ENG_A, 'Plant A']] as const) {
      const c = crsFromWkt(wkt);
      expect(c.name).toBe(name);
      expect(c.localFrame).toBe(true);
      expect(resolvedFromCrsInfo(c, 'las-vlr')!.kind).toBe('local');
    }
  });

  it('keys layers as local:<normalised name>', () => {
    expect(horizontalKey(layer('a', crsFromWkt(LOCAL_A)))).toBe('local:site a grid');
    expect(horizontalKey(layer('e', crsFromWkt(ENG_A)))).toBe('local:plant a');
  });

  it('flags two differently named local frames as a mismatch', () => {
    const m = detectCrsMismatch([layer('a', crsFromWkt(LOCAL_A)), layer('b', crsFromWkt(LOCAL_B))]);
    expect(m.hasMismatch).toBe(true);
  });

  it('reports two same-name local frames as unverified, not matching', () => {
    const m = detectCrsMismatch([layer('a', crsFromWkt(LOCAL_A)), layer('b', crsFromWkt(LOCAL_A))]);
    expect(m.hasMismatch).toBe(false);
    expect(m.localUnverified).toEqual(['a', 'b']);
    expect(m.summary).toMatch(/unverified/);
  });

  it('marks differently named local frames incompatible for combining', () => {
    const inputs = [layer('a', crsFromWkt(ENG_A)), layer('b', crsFromWkt(ENG_B))];
    const c = classifyLayerCompatibility(inputs);
    expect([...c.values()]).toContain('incompatible');
    expect([...c.values()]).not.toContain('verified');
  });

  it('never classifies same-name local frames as verified', () => {
    const c = classifyLayerCompatibility([layer('a', crsFromWkt(LOCAL_A)), layer('b', crsFromWkt(LOCAL_A))]);
    expect(c.get('a')).toBe('unknown');
    expect(c.get('b')).toBe('unknown');
  });

  it('frame comparison: different names conflict, same names stay unverified', () => {
    const ctx = (w: string) => spatialContextFrom(crsFromWkt(w));
    const diff = compareSpatialFrames(ctx(LOCAL_A), ctx(LOCAL_B));
    expect(diff.horizontalFrameConflict).toBe(true);
    const same = compareSpatialFrames(ctx(LOCAL_A), ctx(LOCAL_A));
    expect(same.horizontalFrameConflict).toBe(false);
    expect(same.horizontalFrameUnverified).toBe(true);
    expect(same.planimetricComparable).toBe(false);
  });

  it('change detection refuses two differently named local frames', () => {
    const svc = new CrsService(makePort());
    const r = prepareEpochFrames(svc, epoch('a.las', crsFromWkt(LOCAL_A)), epoch('b.las', crsFromWkt(LOCAL_B)));
    expect(r.comparable).toBe(false);
    expect(r.reason).toBe('frame');
    expect(r.frameRefusal).toMatch(/different local frames/);
  });

  it('leaves undeclared layers on the unknown path', () => {
    const none: LayerInfo = { id: 'n', name: 'n', pointCount: 1, visible: true, locked: false };
    const unk: LayerInfo = { ...none, id: 'u', crsName: 'Unknown CRS' };
    expect(horizontalKey(none)).toBeNull();
    expect(horizontalKey(unk)).toBeNull();
    expect(detectCrsMismatch([none, unk]).unknown).toEqual(['n', 'u']);
    expect(detectCrsMismatch([none, unk]).localUnverified).toBeUndefined();
  });
});
