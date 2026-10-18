/**
 * terrainGatherUpAxis.test.ts
 *
 * The terrain gather decides the buffer's up axis from metadata, never from
 * the scan's shape, whenever metadata can decide it. A surveyed facade stored
 * as a PLY under EPSG:32613 (easting, northing and height in X, Y and Z) reads
 * as Y-up to the shape detector, and the gather used to rotate it, so the DTM,
 * contours, map sheet and terrain exports were built with the wall as ground.
 *
 * Pinned here: a georeferenced PLY or OBJ passes through unrotated with
 * sourceUpAxis 'z'; the same geometry with no CRS still gets detection; a glTF
 * under a CRS is declined with a stated reason; a horizontal terrain control is
 * unchanged. The gather itself runs on a fake `this` holding real clouds.
 */

import { describe, it, expect, vi } from 'vitest';
import { Viewer } from '../src/render/Viewer';
import { PointCloud } from '../src/model/PointCloud';
import type { SourceFormat } from '../src/io/sniffFormat';
import type { CrsInfo } from '../src/io/crs';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { localCrs } from '../src/geo/CoordinateTypes';
import type { ExportCloudCrs } from '../src/render/exportAdapter';
import { classifyScanShape } from '../src/terrain/scanShape';
import { yUpToCanonicalZUp } from '../src/terrain/canonicalFrame';
import {
  detectedUpAxisNote,
  hasHorizontalCrs,
  MIXED_FRAME_REASON,
  settleTerrainGatherFrame,
} from '../src/terrain/gatherUpAxis';
import { createTerrainAnalysisRunner } from '../src/app/terrainAnalysisRunner';
import type { AnalysePanel } from '../src/ui/AnalysePanel';
import type { CrsService } from '../src/geo/CrsService';

/** A deterministic pseudo-random sequence, so the fixtures never change. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/**
 * A building facade in a Z-up survey frame, recentred: 40 m along X (easting),
 * 30 m tall in Z (height), 0.3 m of relief in Y (northing), with a strip of
 * ground in front. To the shape detector this is a flat, filled surface lying
 * in X-Z, which is what a Y-up model looks like.
 */
function facade(): Float32Array {
  const r = rng(7);
  const out: number[] = [];
  for (let i = 0; i < 6000; i++) out.push(r() * 40, r() * 0.3, r() * 30);
  for (let i = 0; i < 300; i++) out.push(r() * 40, -r() * 1.5, r() * 0.05);
  return Float32Array.from(out);
}

/** A gently sloping, Z-up terrain patch: 60 m x 60 m with 3 m of relief. */
function terrain(): Float32Array {
  const r = rng(11);
  const out: number[] = [];
  for (let i = 0; i < 6000; i++) {
    const x = r() * 60;
    const y = r() * 60;
    out.push(x, y, 0.05 * x + 0.5 * Math.sin(y / 9) + r() * 0.05);
  }
  return Float32Array.from(out);
}

const UTM13N: CrsInfo = {
  source: 'wkt',
  wkt: 'PROJCS["WGS 84 / UTM zone 13N",AUTHORITY["EPSG","32613"]]',
  name: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  isGeographic: false,
} as CrsInfo;

const UTM13N_RESOLVED: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
} as ResolvedCrs;

describe('fixture', () => {
  it('the facade reads as Y-up to the shape detector, so the CRS rule is what keeps it unrotated', () => {
    expect(classifyScanShape(facade()).up).toBe('y');
    expect(classifyScanShape(terrain()).up).toBe('z');
  });
});

describe('hasHorizontalCrs', () => {
  it('counts a projected resolution, an EPSG code, a WKT and a declared CRS', () => {
    expect(hasHorizontalCrs(UTM13N_RESOLVED)).toBe(true);
    expect(hasHorizontalCrs(UTM13N)).toBe(true);
    expect(hasHorizontalCrs({ ...UTM13N_RESOLVED, kind: 'unknown' })).toBe(true);
  });

  it('does not count Local, an empty unknown resolution, or nothing', () => {
    expect(hasHorizontalCrs(localCrs())).toBe(false);
    expect(hasHorizontalCrs({ ...localCrs(), kind: 'unknown' })).toBe(false);
    expect(hasHorizontalCrs(null)).toBe(false);
    expect(hasHorizontalCrs(undefined)).toBe(false);
  });
});

describe('settleTerrainGatherFrame', () => {
  it('passes a georeferenced facade PLY through unrotated, as Z-up by its CRS', () => {
    for (const crs of [UTM13N, UTM13N_RESOLVED]) {
      for (const format of ['ply', 'obj'] as SourceFormat[]) {
        const p = facade();
        const before = Float32Array.from(p);
        expect(settleTerrainGatherFrame([{ format, crs }], false, p)).toEqual({ ok: true, up: 'z', basis: 'crs' });
        expect(p).toEqual(before);
      }
    }
  });

  it('still detects and rotates the same geometry when it has no CRS', () => {
    const p = facade();
    const expected = yUpToCanonicalZUp(Float32Array.from(p));
    expect(settleTerrainGatherFrame([{ format: 'ply', crs: null }], false, p)).toEqual({ ok: true, up: 'y', basis: 'detected' });
    expect(p).toEqual(expected);
  });

  it('treats a scan set to Local as having no CRS', () => {
    const p = facade();
    expect(settleTerrainGatherFrame([{ format: 'ply', crs: localCrs() }], false, p)).toMatchObject({ up: 'y', basis: 'detected' });
  });

  it('declines a glTF or GLB under a CRS, naming the CRS and the way to reconcile the axes', () => {
    for (const format of ['gltf', 'glb'] as SourceFormat[]) {
      const p = facade();
      const before = Float32Array.from(p);
      const frame = settleTerrainGatherFrame([{ format, crs: UTM13N_RESOLVED }], false, p);
      expect(frame?.ok).toBe(false);
      const reason = frame && !frame.ok ? frame.reason : '';
      expect(reason).toMatch(/glTF stores Y as the up axis by specification/);
      expect(reason).toMatch(/EPSG:32613/);
      expect(reason).toMatch(/set the scan's coordinate system to Local/);
      expect(p).toEqual(before);
    }
  });

  it('keeps detection for a glTF with no CRS', () => {
    expect(settleTerrainGatherFrame([{ format: 'glb', crs: null }], false, facade())).toMatchObject({ ok: true, up: 'y', basis: 'detected' });
  });

  it('leaves a horizontal terrain unchanged under every basis', () => {
    const cases: Array<[SourceFormat, CrsInfo | null, string]> = [
      ['las', UTM13N, 'specification'],
      ['las', null, 'specification'],
      ['ply', UTM13N, 'crs'],
      ['ply', null, 'detected'],
    ];
    for (const [format, crs, basis] of cases) {
      const p = terrain();
      const before = Float32Array.from(p);
      expect(settleTerrainGatherFrame([{ format, crs }], false, p)).toEqual({ ok: true, up: 'z', basis });
      expect(p).toEqual(before);
    }
  });

  it('declines a local mesh that reads as Y-up beside a Z-up layer, georeferenced or by specification', () => {
    for (const other of [{ format: 'ply' as const, crs: UTM13N }, { format: 'las' as const, crs: null }]) {
      const frame = settleTerrainGatherFrame([other, { format: 'ply', crs: null }], false, facade());
      expect(frame).toEqual({ ok: false, reason: MIXED_FRAME_REASON });
    }
  });

  it('returns null for an empty gather', () => {
    expect(settleTerrainGatherFrame([], false, new Float32Array(0))).toBeNull();
  });
});

describe('detectedUpAxisNote', () => {
  it('states a detected axis and says nothing for a specification or a CRS', () => {
    expect(detectedUpAxisNote('detected', 'y')).toMatch(/read from the point layout: it reads as Y-up and was rotated to Z-up/);
    expect(detectedUpAxisNote('detected', 'z')).toMatch(/reads as Z-up and was analysed as stored/);
    expect(detectedUpAxisNote('crs', 'z')).toBeNull();
    expect(detectedUpAxisNote('specification', 'z')).toBeNull();
    expect(detectedUpAxisNote(undefined, undefined)).toBeNull();
  });
});

/** The shipped gather over a fake `this` holding one real cloud. */
function gatherFor(opts: {
  format: SourceFormat;
  positions: Float32Array;
  declared?: CrsInfo;
  resolved?: ResolvedCrs | null;
}) {
  const cloud = new PointCloud({
    positions: Float32Array.from(opts.positions),
    origin: [0, 0, 0],
    sourceFormat: opts.format,
    name: `facade.${opts.format}`,
    ...(opts.declared ? { metadata: { crs: opts.declared } } : {}),
  });
  const v = Object.assign(Object.create(Viewer.prototype) as object, {
    _clouds: new Map([['a', { cloud, mesh: { visible: true }, locked: false }]]),
    _streamingMayCombine: () => false,
    _streamingPickData: new Map(),
    profileSeam: { fullyResident: () => true },
    _exportCrsResolver:
      opts.resolved === undefined
        ? null
        : (): ExportCloudCrs => ({ wkt: null, key: null, name: null, unit: null, epsg: null, resolved: opts.resolved }),
  }) as unknown as Viewer;
  return { v, cloud };
}

describe('Viewer.gatherTerrainPositions', () => {
  it('gathers a facade PLY declared EPSG:32613 without rotation', () => {
    const { v, cloud } = gatherFor({ format: 'ply', positions: facade(), declared: UTM13N });
    const g = v.gatherTerrainPositions();
    expect(g?.sourceUpAxis).toBe('z');
    expect(g?.upAxisBasis).toBe('crs');
    expect(g?.positions).toEqual(cloud.positions);
    expect(v.terrainGatherDecline).toBeNull();
  });

  it('reads the app-resolved CRS: an assigned EPSG:32613 keeps the facade, a Local override opts back into detection', () => {
    const assigned = gatherFor({ format: 'ply', positions: facade(), resolved: UTM13N_RESOLVED });
    expect(assigned.v.gatherTerrainPositions()?.positions).toEqual(assigned.cloud.positions);
    const local = gatherFor({ format: 'ply', positions: facade(), declared: UTM13N, resolved: localCrs() });
    expect(local.v.gatherTerrainPositions()?.sourceUpAxis).toBe('y');
  });

  it('still detects and rotates the same facade with no CRS', () => {
    const { v, cloud } = gatherFor({ format: 'ply', positions: facade() });
    const g = v.gatherTerrainPositions();
    expect(g?.sourceUpAxis).toBe('y');
    expect(g?.upAxisBasis).toBe('detected');
    expect(g?.positions).toEqual(yUpToCanonicalZUp(Float32Array.from(cloud.positions!)));
  });

  it('declines a GLB under a CRS and records why; the next gather clears it', () => {
    const glb = gatherFor({ format: 'glb', positions: facade(), resolved: UTM13N_RESOLVED });
    expect(glb.v.gatherTerrainPositions()).toBeNull();
    expect(glb.v.terrainGatherDecline).toMatch(/glTF stores Y as the up axis/);
    (glb.v as unknown as { _exportCrsResolver: null })._exportCrsResolver = null;
    expect(glb.v.gatherTerrainPositions()?.sourceUpAxis).toBe('y');
    expect(glb.v.terrainGatherDecline).toBeNull();
  });

  it('leaves a horizontal LAS terrain unchanged', () => {
    const { v, cloud } = gatherFor({ format: 'las', positions: terrain(), declared: UTM13N });
    const g = v.gatherTerrainPositions();
    expect(g?.sourceUpAxis).toBe('z');
    expect(g?.upAxisBasis).toBe('specification');
    expect(g?.positions).toEqual(cloud.positions);
  });
});

describe('terrain runner', () => {
  it('shows the gather decline reason instead of asking for a scan', async () => {
    const statuses: string[] = [];
    const reason = 'Terrain analysis did not run. glTF stores Y as the up axis by specification.';
    const runner = createTerrainAnalysisRunner({
      getViewer: () => ({ gatherTerrainPositions: () => null, terrainGatherDecline: reason, clouds: () => ['a'] }) as unknown as Viewer,
      getAnalysePanel: () => ({ isVisible: () => true, setBusy: vi.fn(), setStatus: (t: string) => { statuses.push(t); } }) as unknown as AnalysePanel,
      getActiveId: () => 'a',
      crsService: { crsRevision: () => 0, current: () => null, context: () => ({}) } as unknown as CrsService,
    });
    await runner.run();
    expect(statuses.at(-1)).toBe(reason);
    await expect(runner.buildResultForExport({ intervalM: 1, shapeStyle: 'smooth' })).rejects.toThrow(reason);
  });
});
