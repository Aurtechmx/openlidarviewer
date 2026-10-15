/**
 * terrainAccessAboveGroundEvidence.test.ts — the above-ground obstruction
 * limit, fed by the DSM the SAME terrain run built:
 *
 *   - the terrain run keeps its DSM on the DTM's exact grid, and the panel
 *     turns it into an above-ground surface bound to that run's DTM;
 *   - an aligned surface blocks cells whose return height is above the
 *     threshold and leaves cells below it eligible, so a route goes round;
 *   - a cell with no above-ground return is blocked under the conservative
 *     evidence policy and allowed but disclosed under the exploratory one,
 *     and the run record names the policy;
 *   - a misaligned surface, or one bound to a different terrain run, is
 *     refused with a typed code and never subtracted;
 *   - the surface binding and the evidence policy are part of the input digest.
 */
import { describe, expect, it } from 'vitest';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { prepareTerrainAccessPreview } from '../src/simulation/terrainAccess/terrainAccessPreview';
import {
  aboveGroundSurfaceFromAnalysis, type AboveGroundSurface,
} from '../src/simulation/terrainAccess/aboveGroundSurface';
import { terrainAccessSimulationInputDigest } from '../src/simulation/terrainAccess/terrainAccessInputDigest';
import {
  runLabTerrainAccess, terrainAccessAboveGroundAvailable, type TerrainAccessLabInput,
} from '../src/ui/fieldSimulation/terrainAccessLab';
import { AnalysePanel } from '../src/ui/AnalysePanel';
import { analyseContours } from '../src/terrain/contour/analyseContours';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../src/terrain/surface/buildDsm';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';

const COLS = 11;
const ROWS = 9;
const idx = (col: number, row: number): number => row * COLS + col;

function flatDtm(override: Partial<DtmGrid> = {}): DtmGrid {
  const n = COLS * ROWS;
  return {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [], ...override,
  };
}

/**
 * A DSM over the flat DTM: a 2 m wall on cols 4..6, rows 0 and 2..6 and 8;
 * row 1 of those columns carries a 0.5 m return (below a 1 m threshold), row 7
 * a 1.01 m one (just above it). Everything else is bare ground. The only gap
 * past the wall is row 1.
 */
function boxDsm(missing: readonly number[] = []): SurfaceGrid {
  const n = COLS * ROWS;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n).fill(1);
  for (let col = 4; col <= 6; col++) {
    for (let row = 2; row <= 6; row++) z[idx(col, row)] = 2;
    z[idx(col, 0)] = 2;
    z[idx(col, 1)] = 0.5;
    z[idx(col, 7)] = 1.01;
    z[idx(col, 8)] = 2;
  }
  for (const i of missing) { coverage[i] = 0; z[i] = Number.NaN; }
  return { z, coverage, cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0 };
}

const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'l', filename: 'f', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};
const START = idx(1, 4);
const GOAL = idx(9, 4);

function profile(policy: 'conservative' | 'exploratory'): TerrainAccessProfile {
  return { ...PERMISSIVE, obstacleHeightThreshold: 1, evidenceGapPolicy: policy };
}

function surfaceFor(dtm: DtmGrid, dsm: SurfaceGrid): AboveGroundSurface {
  const s = aboveGroundSurfaceFromAnalysis(dtm, dsm);
  if (!s) throw new Error('expected an aligned surface');
  return s;
}

describe('the surface comes from the same terrain run, on the DTM grid', () => {
  it('the terrain run keeps its DSM on exactly the DTM grid', () => {
    const pts: TerrainPoint[] = [];
    const cls: number[] = [];
    for (let x = 0; x < 20; x++) {
      for (let y = 0; y < 20; y++) {
        pts.push({ x: x + 0.5, y: y + 0.5, z: 10 }); cls.push(2);
        if (x >= 8 && x <= 11 && y >= 8 && y <= 11) { pts.push({ x: x + 0.5, y: y + 0.5, z: 13 }); cls.push(6); }
      }
    }
    const r = analyseContours(pts, { cellSizeM: 1, crs: 'EPSG:32610', classification: Uint8Array.from(cls) });
    const g = r.surface.dsmGrid;
    expect([g.cols, g.rows, g.cellSizeM, g.originH1, g.originH2])
      .toEqual([r.dtm.cols, r.dtm.rows, r.dtm.cellSizeM, r.dtm.originH1, r.dtm.originH2]);
    const surface = surfaceFor(r.dtm, g);
    expect(surface.frame.crs).toBe(r.dtm.crs);
    expect(surface.frame.verticalUnitToMetres).toBe(r.dtm.verticalUnitToMetres);
    // The box top reads 3 m above the bare earth beneath it.
    const c = Math.floor((9.5 - r.dtm.originH1) / r.dtm.cellSizeM);
    const rr = Math.floor((9.5 - r.dtm.originH2) / r.dtm.cellSizeM);
    const i = rr * r.dtm.cols + c;
    expect(surface.z[i] - r.dtm.z[i]).toBeCloseTo(3, 5);
  });

  it('the panel supplies a bound, aligned surface when the run kept its DSM, and none otherwise', () => {
    const dtm = flatDtm();
    const fakePanel = (dsmGrid: SurfaceGrid | undefined) => ({
      currentResultForProvenance: () => ({
        dtm, horizontalScaleResolved: true, verticalScaleResolved: true,
        surface: { dsmGrid },
      }),
      _cb: { getMapContext: () => ({ resolvedUnitToMetres: 1, sceneUpAxis: 'z' }), getExportBasename: () => 'site' },
      _resultScanId: 'layer', _contourFrame: null,
    });
    const withDsm = AnalysePanel.prototype.terrainAccessInput.call(fakePanel(boxDsm()) as unknown as AnalysePanel);
    expect(terrainAccessAboveGroundAvailable(withDsm)).toBe(true);
    const run = runLabTerrainAccess(withDsm, profile('exploratory'), START, GOAL);
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.record.result.constraints).toMatchObject({ aboveGroundObstruction: 'evaluated' });

    const without = AnalysePanel.prototype.terrainAccessInput.call(fakePanel(undefined) as unknown as AnalysePanel);
    expect(without?.dsm ?? null).toBeNull();
    expect(terrainAccessAboveGroundAvailable(without)).toBe(false);
    const refused = runLabTerrainAccess(without, profile('exploratory'), START, GOAL);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toBe('OBSTRUCTION_EVIDENCE_UNAVAILABLE');
  });

  it('a DSM on a different grid gives no surface at all', () => {
    const dtm = flatDtm();
    expect(aboveGroundSurfaceFromAnalysis(dtm, { ...boxDsm(), originH1: 3 })).toBeNull();
    expect(aboveGroundSurfaceFromAnalysis(dtm, null)).toBeNull();
  });
});

describe('an aligned surface gates eligibility against the threshold', () => {
  const dtm = flatDtm();

  it('blocks cells above the threshold, allows those below, and the route goes round', () => {
    const r = runTerrainAccess(dtm, scale, profile('exploratory'), START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: surfaceFor(dtm, boxDsm()) }, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (let col = 4; col <= 6; col++) {
      for (const row of [0, 2, 3, 4, 5, 6, 7, 8]) {
        expect(r.eligibility.reason[idx(col, row)]).toBe('obstruction');
        expect(r.path).not.toContain(idx(col, row));
      }
      expect(r.features.obstruction[idx(col, 1)]).toBe('clear');
      expect(r.eligibility.blocked[idx(col, 1)]).toBe(0);
    }
    // The only way past is the 0.5 m strip on row 1.
    expect(r.path).toEqual(expect.arrayContaining([idx(4, 1), idx(5, 1), idx(6, 1)]));
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(0);
  });

  it('without the limit the same surface is not applied and the route goes straight', () => {
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE }, START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: surfaceFor(dtm, boxDsm()) }, identity);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.path).toContain(idx(5, 4));
  });
});

describe('a cell with no above-ground return follows the declared evidence policy', () => {
  const dtm = flatDtm();
  const gap = idx(5, 1);
  const dsm = (): AboveGroundSurface => surfaceFor(dtm, boxDsm([gap]));

  it('conservative: the cell is blocked as unknown, so the only gap closes', () => {
    const preview = prepareTerrainAccessPreview(dtm, scale, profile('conservative'), { ...TERRAIN_ACCESS_DEFAULTS, dsm: dsm() });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      expect(preview.eligibility.reason[gap]).toBe('obstruction-unknown');
      expect(preview.map[gap].state).toBe('blocked');
    }
    const r = runTerrainAccess(dtm, scale, profile('conservative'), START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: dsm() }, identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NO_ROUTE');
  });

  it('conservative with full evidence runs and records the blocking policy', () => {
    const r = runTerrainAccess(dtm, scale, profile('conservative'), START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: surfaceFor(dtm, boxDsm()) }, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.result.evidenceGapPolicy).toBe('conservative');
    expect(r.record.result.unknownObstructionPolicy).toBe('block');
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(0);
  });

  it('exploratory: the cell is allowed, crossed, and disclosed in the record and limitations', () => {
    const r = runTerrainAccess(dtm, scale, profile('exploratory'), START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: dsm() }, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.eligibility.blocked[gap]).toBe(0);
    expect(r.path).toContain(gap);
    expect(r.record.result.evidenceGapPolicy).toBe('exploratory');
    expect(r.record.result.unknownObstructionPolicy).toBe('disclose');
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(1);
    expect(r.limitations.join(' ')).toMatch(/could not be checked on 1 of \d+ route cells/);
  });

  it('a profile that states no policy runs as exploratory and the record says so', () => {
    const { evidenceGapPolicy: _omit, ...noPolicy } = profile('exploratory');
    const r = runTerrainAccess(dtm, scale, noPolicy, START, GOAL, { ...TERRAIN_ACCESS_DEFAULTS, dsm: dsm() }, identity);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.result.evidenceGapPolicy).toBe('exploratory');
  });

  it('with no obstruction limit the unknown-obstruction policy is not applicable', () => {
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE, evidenceGapPolicy: 'exploratory' }, START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: dsm() }, identity);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.record.result.unknownObstructionPolicy).toBeNull();
  });
});

describe('a misaligned or stale surface is refused', () => {
  const dtm = flatDtm();

  it('refuses a surface bound to a different terrain run', () => {
    const other = flatDtm({ z: new Float32Array(COLS * ROWS).fill(0.25) });
    const stale = surfaceFor(other, boxDsm());
    const input: TerrainAccessLabInput = { dtm, scale, layerId: 'l', filename: 'f', verticalScaleResolved: true, dsm: stale };
    expect(terrainAccessAboveGroundAvailable(input)).toBe(false);
    const r = runLabTerrainAccess(input, profile('exploratory'), START, GOAL);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SURFACE_STALE');
      expect(r.reason).toMatch(/different terrain/);
    }
  });

  it('refuses a surface whose origin moved after binding', () => {
    const shifted: AboveGroundSurface = { ...surfaceFor(dtm, boxDsm()), originH1: 2 };
    const r = runTerrainAccess(dtm, scale, profile('exploratory'), START, GOAL,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: shifted }, identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SURFACE_MISALIGNED');
  });
});

describe('the input digest carries the surface binding and the evidence policy', () => {
  const dtm = flatDtm();
  const base = { dtm, scale, dsm: surfaceFor(dtm, boxDsm()), roi: null, evidenceGapPolicy: 'exploratory' as const };
  const ref = terrainAccessSimulationInputDigest(base);

  it('changes with the policy', () => {
    expect(terrainAccessSimulationInputDigest({ ...base, evidenceGapPolicy: 'conservative' })).not.toBe(ref);
  });

  it('changes with the terrain the surface is bound to', () => {
    const rebound: AboveGroundSurface = { ...base.dsm, terrainDigest: '0'.repeat(64) };
    expect(terrainAccessSimulationInputDigest({ ...base, dsm: rebound })).not.toBe(ref);
  });

  it('the run records the digest computed with its own policy', () => {
    const input: TerrainAccessLabInput = { dtm, scale, layerId: 'l', filename: 'f', verticalScaleResolved: true, dsm: base.dsm };
    const r = runLabTerrainAccess(input, profile('conservative'), START, GOAL);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.record.source.analysisInputDigest)
        .toBe(terrainAccessSimulationInputDigest({ ...base, evidenceGapPolicy: 'conservative' }));
    }
  });
});
