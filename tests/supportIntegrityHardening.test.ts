/**
 * supportIntegrityHardening.test.ts — locks the v0.6.5 support-integrity
 * hardenings, each enforcing one rule: a numerical result may not look more
 * supported, complete, or authoritative than the computation that produced it.
 */

import { describe, it, expect } from 'vitest';
import { rasterizeDtm } from '../src/terrain/ground/rasterizeDtm';
import { buildDtmGrid } from '../src/terrain/ground/cellConfidence';
import { rigidSolve } from '../src/registration/rigidSolve';
import { selectRegistrationModel } from '../src/registration/registrationModel';
import { evaluateCapabilities, capabilityFor } from '../src/process/processCapabilities';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { ScanFacts, ProductCapability } from '../src/process/ProcessPlan';

function changeCap(scans: ScanFacts[], projectFrameCompatible: boolean): ProductCapability {
  const plan = evaluateCapabilities({ scans, projectFrameCompatible });
  return capabilityFor(plan, 'cross-epoch-change')!;
}

describe('#1 interpolation does not silently fill beyond its support radius', () => {
  it('leaves a void unreachable by IDW as NaN, not a nearest-neighbour guess', () => {
    // Two tiny clusters of measured ground far apart on a wide grid: the centre
    // is beyond IDW's reach from either.
    const cols = 80, rows = 4, cell = 1;
    const raster = rasterizeDtm(
      [{ x: 1, y: 1, z: 10 }, { x: 78, y: 1, z: 10 }],
      new Uint8Array(2).fill(1),
      { grid: { originH1: 0, originH2: 0, cols, rows, cellSizeM: cell }, aggregation: 'mean' },
    );
    const { z, coverage } = buildDtmGrid(raster, {});
    const midIdx = 2 * cols + 40; // a far-from-data cell
    expect(Number.isNaN(z[midIdx])).toBe(true);
    expect(coverage[midIdx]).toBe(0); // unsupported
  });

  it('an explicit bounded nearest policy fills within its distance and NaN beyond', () => {
    const cols = 80, rows = 4, cell = 1;
    const raster = rasterizeDtm(
      [{ x: 1, y: 1, z: 10 }, { x: 78, y: 1, z: 10 }],
      new Uint8Array(2).fill(1),
      { grid: { originH1: 0, originH2: 0, cols, rows, cellSizeM: cell }, aggregation: 'mean' },
    );
    const { z } = buildDtmGrid(raster, { nearestFallbackMaxCells: 3 });
    expect(Number.isFinite(z[2 * cols + 2])).toBe(true); // 1 cell from data
    expect(Number.isNaN(z[2 * cols + 40])).toBe(true); // beyond the bound
  });
});

describe('#2 rasterizeDtm rejects points materially outside the grid', () => {
  it('does not edge-clamp an outside point onto the border; counts it instead', () => {
    const grid = { originH1: 0, originH2: 0, cols: 4, rows: 4, cellSizeM: 1 } as const;
    const pts: TerrainPoint[] = [{ x: 1.5, y: 1.5, z: 5 }, { x: 100, y: 1.5, z: 999 }];
    const r = rasterizeDtm(pts, new Uint8Array(2).fill(1), { grid, aggregation: 'mean' });
    expect(r.outsideGridPointCount).toBe(1);
    // The border cell the outside point would have clamped into is untouched.
    expect(r.counts[1 * 4 + 3]).toBe(0);
  });
  it('keeps a point exactly on the far edge (numerical boundary)', () => {
    const grid = { originH1: 0, originH2: 0, cols: 4, rows: 4, cellSizeM: 1 } as const;
    const r = rasterizeDtm([{ x: 4, y: 4, z: 7 }], new Uint8Array(1).fill(1), { grid, aggregation: 'mean' });
    expect(r.outsideGridPointCount).toBe(0);
    expect(r.filledCellCount).toBe(1);
  });
});

describe('#4 two-scan products require full coverage on both scans', () => {
  const base = (coverage: ScanFacts['coverage']): ScanFacts => ({
    kind: 'static', coverage, crs: { source: 'epsg', name: 'X', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false, verticalDatum: 'NAVD88' } as ScanFacts['crs'],
    pointCount: 1000, hasRgb: false, hasIntensity: false, hasGpsTime: false, hasReturnNumber: false, hasPointSourceId: false,
    classification: 'full', groundClassified: true, hasBuildingClass: false,
  });
  it('two resident-only scans do NOT reach ready for change/volume', () => {
    const cap = changeCap([base('resident-only'), base('resident-only')], true);
    expect(cap.readiness).not.toBe('ready');
    expect(cap.reasonCode).toBe('RESIDENT_OVERLAP_ONLY');
  });
  it('two full scans in a compatible frame do reach ready', () => {
    const cap = changeCap([base('full'), base('full')], true);
    expect(cap.readiness).toBe('ready');
  });
});

describe('#9 rigidSolve refuses ill-posed correspondence sets', () => {
  it('rejects mismatched correspondence counts instead of truncating', () => {
    const r = rigidSolve([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 0, 0], [1, 0, 0], [0, 1, 0]]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('CORRESPONDENCE_COUNT_MISMATCH');
  });
  it('rejects a non-finite coordinate', () => {
    const r = rigidSolve([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [1, 0, 0], [0, NaN, 0]]);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('NON_FINITE_CORRESPONDENCE');
  });
});

describe('#10 planar-icp is recommended but not authorized (no solver)', () => {
  it('withholds airborne-epoch registration rather than run 6-DOF', () => {
    const d = selectRegistrationModel({
      crsCompatible: false, originsKnown: false, capture: 'airborne', sameAreaEpochs: true,
    } as Parameters<typeof selectRegistrationModel>[0]);
    expect(d.model).toBe('planar-icp');
    expect(d.allowed).toBe(false);
    expect(d.reasonCode).toBe('PLANAR_ICP_NOT_IMPLEMENTED');
  });
});
