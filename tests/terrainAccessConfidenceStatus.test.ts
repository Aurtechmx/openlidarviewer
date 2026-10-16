/**
 * terrainAccessConfidenceStatus.test.ts: the status the run record gives the
 * profile's minimum terrain confidence matches what the model did with it.
 *
 * Under the `block` unknown policy a cell below the minimum is blocked, so the
 * limit is `evaluated`. Under `penalize` the minimum changes neither
 * eligibility nor edge cost (the support term reads the confidence itself,
 * not the minimum); it only sets the reported share of route cells below it.
 * The record, the run card, the diagnostics CSV and the export README then say
 * `disclosed` and never that the minimum was evaluated.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { TerrainAccessGrid, TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';

beforeAll(() => {
  installRecordingDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement = class HTMLInputElement {};
});

const lab = await import('../src/ui/fieldSimulation/terrainAccessLab');
const {
  DEFAULT_COST_WEIGHTS, applyWidthClearance, edgeCost, nodeEligibility, prepareTerrainAccessFeatures,
} = await import('../src/simulation/terrainAccess/traversabilityCost');
const { aStarTerrain } = await import('../src/simulation/terrainAccess/aStarTerrain');
const {
  runTerrainAccess, terrainAccessConstraintStatus, TERRAIN_ACCESS_DEFAULTS,
} = await import('../src/simulation/terrainAccess/terrainAccessRunner');
const { buildTerrainAccessPackage } = await import('../src/export/terrainAccessPackage');
const { jsonOf, textOf } = await import('./helpers/zipReader');
const { PERMISSIVE } = await import('./helpers/terrainAccessFixtures');

const PENALIZE: TerrainAccessProfile = { ...PERMISSIVE, unknownPolicy: 'penalize' };

/** A flat 7×5 grid at confidence 90 with a column at 20 every west-east route must cross. */
function weakColumnGrid(): TerrainAccessGrid {
  const cols = 7;
  const rows = 5;
  const n = cols * rows;
  const confidence = new Float32Array(n).fill(90);
  for (let r = 0; r < rows; r++) confidence[r * cols + 3] = 20;
  return {
    z: new Float32Array(n), valid: new Uint8Array(n).fill(1), confidence, coverage: null,
    heightAboveGround: null, allowed: null, cols, rows, cellMetresX: 1, cellMetresY: 1,
  };
}

function dtmOf(confidence: number[]): DtmGrid {
  const n = confidence.length;
  return {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(confidence),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: n, rows: 1, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 50, warnings: [],
  } as DtmGrid;
}

const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'layer', filename: 'site', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'run', generatedAt: '2026-10-16T00:00:00Z', processingManifestHead: null,
};

describe("under 'penalize' the minimum changes nothing the model computes", () => {
  it('eligibility, edge cost and the route are identical for minimum 0 and minimum 80', () => {
    const g = weakColumnGrid();
    const a = { ...PENALIZE, minimumTerrainConfidence: 0 };
    const b = { ...PENALIZE, minimumTerrainConfidence: 80 };
    const fa = prepareTerrainAccessFeatures(g, a);
    const fb = prepareTerrainAccessFeatures(g, b);
    const ea = applyWidthClearance(g, nodeEligibility(g, fa, a), a);
    const eb = applyWidthClearance(g, nodeEligibility(g, fb, b), b);
    expect(Array.from(eb.blocked)).toEqual(Array.from(ea.blocked));
    const from = 2 * 7 + 2;
    expect(edgeCost(g, fb, b, from, from + 1, 1, 0)).toBe(edgeCost(g, fa, a, from, from + 1, 1, 0));
    const ra = aStarTerrain(g, fa, ea, a, 2 * 7, 2 * 7 + 6, DEFAULT_COST_WEIGHTS);
    const rb = aStarTerrain(g, fb, eb, b, 2 * 7, 2 * 7 + 6, DEFAULT_COST_WEIGHTS);
    expect(rb.path).toEqual(ra.path);
    expect(rb.cost).toBe(ra.cost);
  });

  it("so the status is 'disclosed', not 'evaluated'", () => {
    const g = weakColumnGrid();
    const status = terrainAccessConstraintStatus({ ...PENALIZE, minimumTerrainConfidence: 80 }, g);
    expect(status.minimumTerrainConfidence).toBe('disclosed');
    expect(status.minimumTerrainConfidence).not.toBe('evaluated');
  });
});

describe("under 'block' the minimum blocks cells", () => {
  it("a cell below it is blocked, and the status is 'evaluated'", () => {
    const g = weakColumnGrid();
    const p = { ...PERMISSIVE, unknownPolicy: 'block' as const, minimumTerrainConfidence: 50 };
    const e = nodeEligibility(g, prepareTerrainAccessFeatures(g, p), p);
    expect(e.blocked[3]).toBe(1);
    expect(e.reason[3]).toBe('low-confidence');
    expect(terrainAccessConstraintStatus(p, g).minimumTerrainConfidence).toBe('evaluated');
  });
});

describe('the record, run card, CSV and README agree', () => {
  const dtm = dtmOf([90, 30, 90]);

  it("penalize: every output says 'disclosed' and none says the minimum was evaluated", () => {
    const r = runTerrainAccess(dtm, scale, { ...PENALIZE, minimumTerrainConfidence: 50 }, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics.fractionBelowProfileConfidence).toBeCloseTo(1 / 3, 12);
    const constraints = r.record.result.constraints as Record<string, string>;
    expect(constraints.minimumTerrainConfidence).toBe('disclosed');

    const limitation = r.limitations.find((l) => l.includes('minimum terrain confidence'));
    expect(limitation).toContain('not enforced');
    expect(limitation).not.toMatch(/cost-penali[sz]ed/);

    const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
    expect(card).toContain('Minimum confidence share of route cells below 50 reported, not enforced (penalize policy)');
    expect(card).not.toMatch(/Minimum confidence\s+evaluated/);
    expect(card).not.toContain('cells below 50 blocked');

    const zip = buildTerrainAccessPackage(r, { basename: 'pen' });
    const csv = textOf(zip, 'pen-diagnostics.csv');
    expect(csv).toContain('constraint.minimumTerrainConfidence,disclosed\n');
    expect(csv).not.toContain('constraint.minimumTerrainConfidence,evaluated');
    const readme = textOf(zip, 'pen-README.txt');
    expect(readme).toMatch(/Minimum confidence\s+disclosed/);
    expect(readme).not.toMatch(/Minimum confidence\s+evaluated/);
    const record = jsonOf<{ result: { constraints: Record<string, string> } }>(zip, 'pen-simulation-run.json');
    expect(record.result.constraints.minimumTerrainConfidence).toBe('disclosed');
  });

  it("block: every output says 'evaluated'", () => {
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE, minimumTerrainConfidence: 20 }, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.record.result.constraints as Record<string, string>).minimumTerrainConfidence).toBe('evaluated');
    const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
    expect(card).toContain('Minimum confidence cells below 20 blocked (block policy)');
    const zip = buildTerrainAccessPackage(r, { basename: 'blk' });
    expect(textOf(zip, 'blk-diagnostics.csv')).toContain('constraint.minimumTerrainConfidence,evaluated\n');
    expect(textOf(zip, 'blk-README.txt')).toMatch(/Minimum confidence\s+evaluated/);
  });

  it('the status is not part of the result digest: penalize runs at minimum 0 and 50 share it', () => {
    const p0 = runTerrainAccess(dtm, scale, { ...PENALIZE, minimumTerrainConfidence: 0 }, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    const p50 = runTerrainAccess(dtm, scale, { ...PENALIZE, minimumTerrainConfidence: 50 }, 0, 2, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(p0.ok && p50.ok).toBe(true);
    if (!p0.ok || !p50.ok) return;
    expect(p50.record.result.resultDigest).toBe(p0.record.result.resultDigest);
  });
});
