/**
 * terrainAccessEvidenceIntegrity.test.ts — Terrain Access evidence,
 * diagnostics and provenance:
 *
 *   - an above-ground obstruction limit is never accepted without aligned
 *     above-ground evidence, and the run record says which constraints were
 *     evaluated, disabled or unavailable;
 *   - the weak-evidence share of a route is computed over every route cell
 *     against the profile's own minimum confidence, separately from the
 *     measured/interpolated provenance split, and the warning, run record and
 *     exported CSV all carry the same figure;
 *   - an above-ground surface is subtracted only when its origin, lengths,
 *     orientation and frame/unit identity match the terrain's; an invalid ROI
 *     mask is refused rather than widened to the full grid;
 *   - the run's input digest moves with every input that changes routing
 *     (confidence, scale, latitude basis, ROI, above-ground layer) and not
 *     with presentation state.
 */
import { describe, expect, it } from 'vitest';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import {
  terrainDtmToAccessGrid, type AboveGroundSurface,
} from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import { ABOVE_GROUND_UNAVAILABLE } from '../src/simulation/terrainAccess/terrainAccessPrepare';
import {
  TERRAIN_ACCESS_INPUT_DIGEST_SCHEME, terrainAccessSimulationInputDigest,
} from '../src/simulation/terrainAccess/terrainAccessInputDigest';
import {
  evidenceSplitText, runLabTerrainAccess, terrainAccessAboveGroundAvailable, type TerrainAccessLabInput,
} from '../src/ui/fieldSimulation/terrainAccessLab';
import { AnalysePanel } from '../src/ui/AnalysePanel';
import { dtmProductDigest } from '../src/science/dtmProductDigest';
import { buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { jsonOf, textOf } from './helpers/zipReader';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function dtmOf(values: (number | null)[][], override: Partial<DtmGrid> = {}): DtmGrid {
  const rows = values.length, cols = values[0].length, n = cols * rows;
  const z = new Float32Array(n), coverage = new Uint8Array(n), confidence = new Float32Array(n);
  values.flat().forEach((v, i) => { if (v !== null) { z[i] = v; coverage[i] = 2; confidence[i] = 100; } });
  return {
    z, coverage, confidence, counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [], ...override,
  };
}
const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'same-layer', filename: 'same.las', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};

/** An above-ground surface on exactly the DTM's grid and frame. */
function alignedSurface(dtm: DtmGrid, z: number[], over: Partial<AboveGroundSurface> = {}): AboveGroundSurface {
  return {
    z: new Float32Array(z), coverage: new Uint8Array(z.length).fill(1),
    cols: dtm.cols, rows: dtm.rows, cellSizeM: dtm.cellSizeM, originH1: dtm.originH1, originH2: dtm.originH2,
    frame: {
      crs: dtm.crs, horizontalEpsg: dtm.horizontalEpsg ?? null,
      verticalUnitToMetres: dtm.verticalUnitToMetres ?? null, orientation: 'rows-north-from-origin',
    },
    ...over,
  };
}

function labInput(dtm: DtmGrid, over: Partial<TerrainAccessLabInput> = {}): TerrainAccessLabInput {
  return { dtm, scale, layerId: 'same-layer', filename: 'site', verticalScaleResolved: true, ...over };
}

describe('above-ground obstruction is never accepted without aligned evidence', () => {
  it('the production panel input supplies no above-ground evidence, so a run asking for the limit is refused', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const fakeResult = {
      dtm, horizontalScaleResolved: true, verticalScaleResolved: true,
      surface: { canopy: { heightM: new Float32Array([10, 10, 10]), coveredCells: 3, maxHeightM: 10, meanHeightM: 10, p95HeightM: 10 } },
    };
    const fakePanel = {
      currentResultForProvenance: () => fakeResult,
      _cb: { getMapContext: () => ({ resolvedUnitToMetres: 1, sceneUpAxis: 'z' }), getExportBasename: () => 'site' },
      _resultScanId: 'same-layer', _contourFrame: null,
    };
    const input = AnalysePanel.prototype.terrainAccessInput.call(fakePanel as unknown as AnalysePanel);
    expect(input).not.toBeNull();
    expect(terrainAccessAboveGroundAvailable(input)).toBe(false);
    const r = runLabTerrainAccess(input!, { ...PERMISSIVE, obstacleHeightThreshold: 0.5 }, 0, 2);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('OBSTRUCTION_EVIDENCE_UNAVAILABLE');
    expect(r.reason).toContain(ABOVE_GROUND_UNAVAILABLE);
    expect(ABOVE_GROUND_UNAVAILABLE).toBe('Above-ground evidence unavailable; this constraint cannot be evaluated.');
  });

  it('a programmatic profile with the limit and no surface is refused by the core too, never run as clear', () => {
    const r = runTerrainAccess(dtmOf([[0, 0, 0]]), scale, { ...PERMISSIVE, obstacleHeightThreshold: 0.5 },
      0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('OBSTRUCTION_EVIDENCE_UNAVAILABLE');
  });

  it('with an aligned surface the limit is evaluated, and blocks a 10 m return', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const input = labInput(dtm, { dsm: alignedSurface(dtm, [10, 10, 10]) });
    expect(terrainAccessAboveGroundAvailable(input)).toBe(true);
    const r = runLabTerrainAccess(input, { ...PERMISSIVE, obstacleHeightThreshold: 0.5 }, 0, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).not.toBe('OBSTRUCTION_EVIDENCE_UNAVAILABLE');
  });

  it('the run record and the export say which constraints were evaluated, disabled or unavailable', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const without = runLabTerrainAccess(labInput(dtm), { ...PERMISSIVE, vehicleLength: 2 }, 0, 2);
    expect(without.ok).toBe(true);
    if (!without.ok) return;
    expect(without.record.schemaVersion).toBe(2);
    expect(without.record.result.constraints).toEqual({
      longitudinalGrade: 'evaluated', crossSlope: 'evaluated', stepHeight: 'evaluated',
      minimumTerrainConfidence: 'evaluated', vehicleWidth: 'evaluated',
      ruggedness: 'disabled', vehicleLength: 'recorded-not-enforced', aboveGroundObstruction: 'unavailable',
    });
    const zip = buildTerrainAccessPackage(without, { basename: 'c' });
    expect(jsonOf<{ result: { constraints: Record<string, string> } }>(zip, 'c-simulation-run.json')
      .result.constraints.aboveGroundObstruction).toBe('unavailable');
    expect(textOf(zip, 'c-README.txt')).toContain('Above-ground obstruction   unavailable');

    const withSurface = runLabTerrainAccess(labInput(dtm, { dsm: alignedSurface(dtm, [0.1, 0.1, 0.1]) }),
      { ...PERMISSIVE, obstacleHeightThreshold: 0.5 }, 0, 2);
    expect(withSurface.ok).toBe(true);
    if (withSurface.ok) expect(withSurface.record.result.constraints).toMatchObject({ aboveGroundObstruction: 'evaluated' });

    const offWithSurface = runLabTerrainAccess(labInput(dtm, { dsm: alignedSurface(dtm, [0.1, 0.1, 0.1]) }), PERMISSIVE, 0, 2);
    if (offWithSurface.ok) expect(offWithSurface.record.result.constraints).toMatchObject({ aboveGroundObstruction: 'disabled' });
  });

  it('a route over cells the surface has no return for says the limit was not evaluated there', () => {
    const dtm = dtmOf([[0, 0, 0]]);
    const dsm = alignedSurface(dtm, [0.1, Number.NaN, 0.1], { coverage: new Uint8Array([1, 0, 1]) });
    const r = runLabTerrainAccess(labInput(dtm, { dsm }), { ...PERMISSIVE, obstacleHeightThreshold: 0.5 }, 0, 2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(1);
    expect(r.limitations.join(' ')).toMatch(/1 of 3 route cells.*no above-ground evidence/);
  });
});

describe('weak-evidence share is computed against the profile minimum over every route cell', () => {
  it('an entirely low-confidence measured route reports 100% below the minimum, warns, and exports the same figure', () => {
    const dtm = dtmOf([[0, 0, 0]], { confidence: new Float32Array([10, 10, 10]) });
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'penalize' },
      0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics.minTerrainConfidence).toBe(10);
    expect(r.diagnostics.fractionMeasured).toBe(1);
    expect(r.diagnostics.fractionInterpolated).toBe(0);
    expect(r.diagnostics.fractionBelowProfileConfidence).toBe(1);
    expect(r.diagnostics.profileMinimumTerrainConfidence).toBe(50);
    expect(r.diagnostics).not.toHaveProperty('fractionLowConfidenceOrEdgeRisk');
    const warning = r.limitations.find((l) => l.includes('below the profile\'s minimum terrain confidence'));
    expect(warning).toContain('100% of route cells');
    expect(warning).toContain('(50)');
    expect(r.limitations.join(' ')).not.toMatch(/edge-risk/);
    expect(r.record.result.fractionBelowProfileConfidence).toBe(1);
    expect(evidenceSplitText(r.diagnostics)).toBe('100% measured, 0% interpolated; 100% below the profile\'s minimum confidence (50)');
    const zip = buildTerrainAccessPackage(r, { basename: 'weak-evidence' });
    const csv = textOf(zip, 'weak-evidence-diagnostics.csv');
    expect(csv).toContain('fractionBelowProfileConfidence,1\n');
    expect(csv).toContain('profileMinimumTerrainConfidence,50\n');
    expect(csv).not.toContain('fractionLowConfidenceOrEdgeRisk');
  });

  it('provenance and the profile threshold are independent: a trusted interpolated cell counts as interpolated, not weak', () => {
    const dtm = dtmOf([[0, 0, 0]], { coverage: new Uint8Array([2, 1, 2]), confidence: new Float32Array([100, 60, 30]) });
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE, minimumTerrainConfidence: 50, unknownPolicy: 'penalize' },
      0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics.fractionMeasured).toBeCloseTo(2 / 3, 9);
    expect(r.diagnostics.fractionInterpolated).toBeCloseTo(1 / 3, 9);
    expect(r.diagnostics.fractionBelowProfileConfidence).toBeCloseTo(1 / 3, 9); // the measured cell at 30
  });
});

describe('an above-ground surface is subtracted only when it is aligned', () => {
  const dtm = dtmOf([[0, 0, 0]]);
  it('refuses a surface with a different origin', () => {
    const r = terrainDtmToAccessGrid(dtm, scale, { dsm: alignedSurface(dtm, [10, 0, 0], { originH1: 100, originH2: 200 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SURFACE_MISALIGNED');
      expect(r.reason).toMatch(/origin/);
    }
  });

  it('accepts an origin difference within the alignment tolerance', () => {
    const r = terrainDtmToAccessGrid(dtm, scale, { dsm: alignedSurface(dtm, [10, 0, 0], { originH1: 1e-9 }) });
    expect(r.ok).toBe(true);
    if (r.ok) expect(Array.from(r.grid.heightAboveGround!)).toEqual([10, 0, 0]);
  });

  it.each([
    ['array lengths', { z: new Float32Array(2) }, /length/],
    ['grid size', { cols: 1, rows: 3 }, /cols\/rows/],
    ['cell size', { cellSizeM: 2 }, /cell size/],
    ['missing frame', { frame: undefined as never }, /frame/],
    ['orientation', { frame: { crs: 'EPSG:32610', horizontalEpsg: 32610, verticalUnitToMetres: 1, orientation: 'rows-south-from-origin' as never } }, /orientation/],
    ['horizontal CRS', { frame: { crs: 'EPSG:32611', horizontalEpsg: 32611, verticalUnitToMetres: 1, orientation: 'rows-north-from-origin' as const } }, /CRS/],
    ['vertical unit', { frame: { crs: 'EPSG:32610', horizontalEpsg: 32610, verticalUnitToMetres: 0.3048, orientation: 'rows-north-from-origin' as const } }, /vertical unit/],
  ])('refuses a surface whose %s differs', (_name, over, pattern) => {
    const r = terrainDtmToAccessGrid(dtm, scale, { dsm: alignedSurface(dtm, [10, 0, 0], over as Partial<AboveGroundSurface>) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('SURFACE_MISALIGNED');
      expect(r.reason).toMatch(pattern);
    }
  });

  it('a misaligned surface refuses the run with a typed code', () => {
    const r = runLabTerrainAccess(labInput(dtm, { dsm: alignedSurface(dtm, [0, 0, 0], { originH1: 5 }) }), PERMISSIVE, 0, 2);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('SURFACE_MISALIGNED');
  });

  it.each([
    ['wrong length', new Uint8Array(2)],
    ['non-binary values', new Uint8Array([1, 2, 1])],
  ])('refuses an ROI mask with %s instead of widening to the full grid', (_name, roi) => {
    const r = terrainDtmToAccessGrid(dtm, scale, { roi });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_ROI');
    const run = runTerrainAccess(dtm, scale, PERMISSIVE, 0, 2, { ...TERRAIN_ACCESS_DEFAULTS, roi }, identity);
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.code).toBe('INVALID_ROI');
  });
});

describe('the simulation input digest moves with every routing input', () => {
  const a = dtmOf([[0, 1, 0]]);
  const base = { dtm: a, scale, dsm: null, roi: null };
  const ref = terrainAccessSimulationInputDigest(base);

  it('the surface digest stays blind to confidence and vertical factor, as documented', () => {
    const lowConfidence: DtmGrid = { ...a, confidence: new Float32Array([1, 1, 1]) };
    const feet: DtmGrid = { ...a, verticalUnitToMetres: 0.3048 };
    expect(dtmProductDigest(lowConfidence)).toBe(dtmProductDigest(a));
    expect(dtmProductDigest(feet)).toBe(dtmProductDigest(a));
  });

  it.each([
    ['confidence', { dtm: { ...a, confidence: new Float32Array([1, 1, 1]) } }],
    ['vertical factor', { dtm: { ...a, verticalUnitToMetres: 0.3048 } }],
    ['surface heights', { dtm: { ...a, z: new Float32Array([0, 2, 0]) } }],
    ['horizontal unit', { scale: { ...scale, unitToMetres: 0.3048 } }],
    ['latitude basis', { scale: { isGeographic: true, latitudeDeg: 45, unitToMetres: 1, resolved: true } }],
    ['ROI', { roi: new Uint8Array([1, 1, 0]) }],
    ['above-ground surface', { dsm: alignedSurface(a, [1, 1, 1]) }],
  ])('changes when the %s changes', (_name, over) => {
    expect(terrainAccessSimulationInputDigest({ ...base, ...over } as typeof base)).not.toBe(ref);
  });

  it('is deterministic and versioned', () => {
    expect(terrainAccessSimulationInputDigest(base)).toBe(ref);
    expect(ref).toMatch(/^[0-9a-f]{64}$/);
    expect(TERRAIN_ACCESS_INPUT_DIGEST_SCHEME).toMatch(/v1$/);
  });

  it('is the run\'s analysisInputDigest, and presentation state does not move it', () => {
    const profile = { ...PERMISSIVE, maxStepHeight: 0.5 };
    const flat = dtmOf([[0, 0.2, 0]]);
    const one = runLabTerrainAccess(labInput(flat), profile, 0, 2);
    const two = runLabTerrainAccess(labInput(flat, {
      sceneUpAxis: 'y', worldOriginX: 5, worldOriginY: 6, worldOriginZ: 7, crsName: 'other label',
      isStale: () => false, overlayHost: null,
    }), profile, 0, 2);
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.record.source.analysisInputDigest).toBe(terrainAccessSimulationInputDigest({ dtm: flat, scale, dsm: null, roi: null }));
    expect(one.record.source.analysisInputDigestScheme).toBe(TERRAIN_ACCESS_INPUT_DIGEST_SCHEME);
    expect(one.record.source.surfaceDigest).toBe(dtmProductDigest(flat));
    expect(two.record.source.analysisInputDigest).toBe(one.record.source.analysisInputDigest);
    expect(two.record.id).not.toBe(one.record.id);

    const feet = runLabTerrainAccess(labInput({ ...flat, verticalUnitToMetres: 0.3048 }), profile, 0, 2);
    expect(feet.ok).toBe(true);
    if (feet.ok) expect(feet.record.source.analysisInputDigest).not.toBe(one.record.source.analysisInputDigest);
  });
});
