/**
 * terrainAccessObstructionBasis.test.ts — what the above-ground obstruction
 * limit is evaluated against, and when its status may read `evaluated`.
 *
 *   - the obstruction surface is the top return per cell from the points the
 *     terrain run read, without ASPRS noise (classes 7 and 18); Withheld
 *     points are left out by the gather before the surface is built. The
 *     full-cloud DSM other products read is unchanged;
 *   - when those points are a sample of the scan, the limit reads `estimated`
 *     with one sentence naming the sample, carried identically by the run
 *     card, the diagnostics CSV, the README and the run record; a full basis
 *     reads `evaluated`;
 *   - the sample basis is part of the surface identity in the input digest;
 *   - route cells with no above-ground return (exploratory policy) make the
 *     limit `estimated` with their count;
 *   - under the conservative policy a ruggedness limit blocks every cell whose
 *     VRM window holds a substituted-neighbour cell, so a route found under it
 *     reads ruggedness `evaluated`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import { textOf } from './helpers/zipReader';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { SurfaceGrid } from '../src/terrain/surface/buildDsm';
import type { TerrainPoint } from '../src/terrain/TerrainContracts';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';
import type { AboveGroundSurface } from '../src/simulation/terrainAccess/aboveGroundSurface';

beforeAll(() => {
  installRecordingDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement = class HTMLInputElement {};
});

const { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } = await import('../src/simulation/terrainAccess/terrainAccessRunner');
const { aboveGroundSurfaceFromAnalysis } = await import('../src/simulation/terrainAccess/aboveGroundSurface');
const { terrainAccessSimulationInputDigest } = await import('../src/simulation/terrainAccess/terrainAccessInputDigest');
const { analyseContours } = await import('../src/terrain/contour/analyseContours');
const { sampleStridedTerrain } = await import('../src/render/terrainStreamSample');
const { encodeExtendedClassificationFlags } = await import('../src/lasSemantics');
const { buildTerrainAccessPackage } = await import('../src/export/terrainAccessPackage');
const { AnalysePanel } = await import('../src/ui/AnalysePanel');
const lab = await import('../src/ui/fieldSimulation/terrainAccessLab');

const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'l', filename: 'f', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};
const obstructionProfile = (policy: 'conservative' | 'exploratory', over: Partial<TerrainAccessProfile> = {}): TerrainAccessProfile =>
  ({ ...PERMISSIVE, obstacleHeightThreshold: 1, evidenceGapPolicy: policy, ...over });

// ── a 20 × 20 m flat ground cloud, one point per square metre ────────────────
const SIDE = 20;
function groundCloud(): { pts: TerrainPoint[]; cls: number[] } {
  const pts: TerrainPoint[] = [];
  const cls: number[] = [];
  for (let x = 0; x < SIDE; x++) {
    for (let y = 0; y < SIDE; y++) { pts.push({ x: x + 0.5, y: y + 0.5, z: 10 }); cls.push(2); }
  }
  return { pts, cls };
}
const cellOf = (dtm: DtmGrid, x: number, y: number): number =>
  Math.floor((y - dtm.originH2) / dtm.cellSizeM) * dtm.cols + Math.floor((x - dtm.originH1) / dtm.cellSizeM);

/** The obstruction surface the panel hands Terrain Access for an analysis result. */
function panelSurface(result: ReturnType<typeof analyseContours>): AboveGroundSurface | null {
  const fakePanel = {
    currentResultForProvenance: () => ({ ...result, horizontalScaleResolved: true, verticalScaleResolved: true }),
    _cb: { getMapContext: () => ({ resolvedUnitToMetres: 1, sceneUpAxis: 'z' }), getExportBasename: () => 'site' },
    _resultScanId: 'layer', _contourFrame: null,
  };
  return AnalysePanel.prototype.terrainAccessInput.call(fakePanel as unknown as InstanceType<typeof AnalysePanel>)?.dsm ?? null;
}

describe('noise returns do not feed the obstruction surface', () => {
  const { pts, cls } = groundCloud();
  // A 40 m bird return (high noise) and a 25 m low-noise return over open ground,
  // and a 3 m building return that must still block.
  pts.push({ x: 5.5, y: 10.5, z: 50 }); cls.push(18);
  pts.push({ x: 6.5, y: 10.5, z: 35 }); cls.push(7);
  pts.push({ x: 14.5, y: 3.5, z: 13 }); cls.push(6);
  const r = analyseContours(pts, { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1, classification: Uint8Array.from(cls) });
  const bird = cellOf(r.dtm, 5.5, 10.5);
  const lowNoise = cellOf(r.dtm, 6.5, 10.5);
  const roof = cellOf(r.dtm, 14.5, 3.5);

  it('the obstruction surface leaves classes 7 and 18 out; the full-cloud DSM keeps them', () => {
    const surface = panelSurface(r);
    expect(surface).not.toBeNull();
    if (!surface) return;
    expect(surface.z[bird]).toBeCloseTo(10, 5);
    expect(surface.z[lowNoise]).toBeCloseTo(10, 5);
    expect(surface.z[roof]).toBeCloseTo(13, 5);
    expect(surface.basis?.noiseExcluded).toBe(2);
    // Other DSM products are unchanged: the full-cloud DSM and its statistics still read every return.
    expect(r.surface.dsmGrid.z[bird]).toBeCloseTo(50, 5);
    expect(r.surface.dsm.maxZ).toBeCloseTo(50, 5);
  });

  it('a single noise return does not block its cell; a building return still does', () => {
    const surface = panelSurface(r);
    const run = runTerrainAccess(r.dtm, scale, obstructionProfile('exploratory'), cellOf(r.dtm, 2.5, 10.5),
      cellOf(r.dtm, 17.5, 10.5), { ...TERRAIN_ACCESS_DEFAULTS, dsm: surface }, identity);
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.eligibility.reason[bird]).not.toBe('obstruction');
    expect(run.eligibility.reason[lowNoise]).not.toBe('obstruction');
    expect(run.eligibility.reason[roof]).toBe('obstruction');
  });

  it('without noise in the cloud the obstruction surface is the DSM itself', () => {
    const clean = groundCloud();
    const rc = analyseContours(clean.pts, { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1, classification: Uint8Array.from(clean.cls) });
    expect(rc.surface.obstructionGrid).toBeNull();
    expect(rc.surface.obstructionBasis.noiseExcluded).toBe(0);
    expect(panelSurface(rc)?.z).toBe(rc.surface.dsmGrid.z);
  });

  it('a Withheld return is left out by the gather, so it never reaches the surface', () => {
    const { pts: g } = groundCloud();
    const flat = new Float32Array((g.length + 1) * 3);
    g.forEach((p, i) => { flat[i * 3] = p.x; flat[i * 3 + 1] = p.y; flat[i * 3 + 2] = p.z; });
    flat.set([5.5, 10.5, 50], g.length * 3);
    const flags = new Uint8Array(g.length + 1);
    flags[g.length] = encodeExtendedClassificationFlags({ withheld: true });
    const sample = sampleStridedTerrain([{ pos: flat, flags }], [], g.length + 1, 1_000_000, false);
    expect(sample?.withheldExcluded).toBe(true);
    expect(sample?.withheldExcludedCount).toBe(1);
    const p = sample!.positions;
    const ptsOut: TerrainPoint[] = [];
    for (let i = 0; i < p.length; i += 3) ptsOut.push({ x: p[i], y: p[i + 1], z: p[i + 2] });
    const rw = analyseContours(ptsOut, {
      cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1, withheldExcluded: true, withheldExcludedCount: 1, samplePointScale: (g.length + 1) / g.length,
    });
    const surface = panelSurface(rw);
    expect(surface?.z[cellOf(rw.dtm, 5.5, 10.5)]).toBeCloseTo(10, 5);
    expect(surface?.basis?.withheldExcluded).toBe(true);
    // Every point that was not Withheld was read: this is not a sample.
    expect(surface?.basis?.sampled).toBe(false);
  });
});

describe('a sampled obstruction basis reads estimated, in every output', () => {
  const { pts, cls } = groundCloud();
  const sampled = analyseContours(pts, {
    cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1, classification: Uint8Array.from(cls), samplePointScale: 4,
  });
  const full = analyseContours(pts, { cellSizeM: 1, crs: 'EPSG:32610', verticalUnitToMetres: 1, classification: Uint8Array.from(cls) });
  const start = cellOf(full.dtm, 2.5, 10.5);
  const goal = cellOf(full.dtm, 17.5, 10.5);
  const sentence = 'Above-ground obstruction is estimated from a sample of 400 of 1,600 points; '
    + 'thin returns such as posts or wires can be missed.';

  it('the basis records the sample and its counts', () => {
    expect(sampled.surface.obstructionBasis).toMatchObject({ sampled: true, pointsRead: 400, sourcePoints: 1600 });
    expect(full.surface.obstructionBasis).toMatchObject({ sampled: false, pointsRead: 400, sourcePoints: 400 });
  });

  it('full basis: the limit reads evaluated and no obstruction estimate is written', () => {
    const r = runTerrainAccess(full.dtm, scale, obstructionProfile('exploratory'), start, goal,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: panelSurface(full) }, identity);
    if (!r.ok) throw new Error(r.reason);
    expect((r.record.result.constraints as Record<string, string>).aboveGroundObstruction).toBe('evaluated');
    expect((r.record.result.constraintEstimates as Record<string, string>).aboveGroundObstruction).toBeUndefined();
    const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
    expect(card).toMatch(/Above-ground obstruction\s*evaluated against the above-ground surface/);
    expect(card).not.toContain('Above-ground evidence unavailable');
    expect(card).not.toMatch(/Above-ground obstruction\s*estimated/);
  });

  for (const policy of ['exploratory', 'conservative'] as const) {
    it(`sampled basis (${policy}): estimated with the sample sentence in the card, CSV, README and record`, () => {
      const r = runTerrainAccess(sampled.dtm, scale, obstructionProfile(policy), start, goal,
        { ...TERRAIN_ACCESS_DEFAULTS, dsm: panelSurface(sampled) }, identity);
      if (!r.ok) throw new Error(r.reason);
      expect((r.record.result.constraints as Record<string, string>).aboveGroundObstruction).toBe('estimated');
      expect((r.record.result.constraintEstimates as Record<string, string>).aboveGroundObstruction).toBe(sentence);
      expect(r.limitations).toContain(sentence);
      const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
      expect(card).toContain(sentence);
      expect(card).toMatch(/Above-ground obstruction\s*estimated against the above-ground surface/);
      // One status only: never "unavailable" or "evaluated" beside the estimate.
      expect(card).not.toContain('Above-ground evidence unavailable');
      expect(card).not.toContain('evaluated against the above-ground surface');
      expect(card.match(/Above-ground obstruction\s*estimated/g)).toHaveLength(1);
      const zip = buildTerrainAccessPackage(r, { basename: 'd' });
      const csv = textOf(zip, 'd-diagnostics.csv');
      expect(csv).toContain('constraint.aboveGroundObstruction,estimated\n');
      expect(csv).toContain(`constraintEstimate.aboveGroundObstruction,"${sentence}"\n`);
      const readme = textOf(zip, 'd-README.txt');
      expect(readme).toMatch(/Above-ground obstruction\s+estimated/);
      expect(readme).toContain(sentence);
      const record = JSON.parse(textOf(zip, 'd-simulation-run.json'));
      expect(record.result.constraints.aboveGroundObstruction).toBe('estimated');
      expect(record.result.constraintEstimates.aboveGroundObstruction).toBe(sentence);
      expect(record.limitations).toContain(sentence);
    });
  }

  it('a surface with no stated basis follows the terrain coverage mode', () => {
    const z = new Float32Array(full.dtm.z);
    const grid: SurfaceGrid = {
      z, coverage: new Uint8Array(z.length).fill(1), cols: full.dtm.cols, rows: full.dtm.rows,
      cellSizeM: full.dtm.cellSizeM, originH1: full.dtm.originH1, originH2: full.dtm.originH2,
    };
    expect(aboveGroundSurfaceFromAnalysis(full.dtm, grid)?.basis?.sampled).toBe(false);
    const streamed = { ...full.dtm, coverageMode: 'resident-only' as const };
    const s = aboveGroundSurfaceFromAnalysis(streamed, grid);
    expect(s?.basis?.sampled).toBe(true);
    const r = runTerrainAccess(streamed, scale, obstructionProfile('exploratory'), start, goal,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: s }, identity);
    if (!r.ok) throw new Error(r.reason);
    expect((r.record.result.constraints as Record<string, string>).aboveGroundObstruction).toBe('estimated');
    expect((r.record.result.constraintEstimates as Record<string, string>).aboveGroundObstruction)
      .toMatch(/^Above-ground obstruction is estimated from a sample of the points; thin returns such as posts or wires can be missed\.$/);
  });

  it('the input digest changes with the obstruction basis alone', () => {
    const surface = panelSurface(full)!;
    const base = { dtm: full.dtm, scale, roi: null, evidenceGapPolicy: 'exploratory' as const };
    const ref = terrainAccessSimulationInputDigest({ ...base, dsm: surface });
    const resampled: AboveGroundSurface = { ...surface, basis: { ...surface.basis!, sampled: true, sourcePoints: 1600 } };
    expect(terrainAccessSimulationInputDigest({ ...base, dsm: resampled })).not.toBe(ref);
    const denoised: AboveGroundSurface = { ...surface, basis: { ...surface.basis!, noiseExcluded: 1 } };
    expect(terrainAccessSimulationInputDigest({ ...base, dsm: denoised })).not.toBe(ref);
  });
});

describe('route cells with no above-ground return make the limit estimated', () => {
  const COLS = 11;
  const ROWS = 9;
  const n = COLS * ROWS;
  const dtm: DtmGrid = {
    z: new Float32Array(n), coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
  const coverage = new Uint8Array(n).fill(1);
  const z = new Float32Array(n);
  // Two cells straight across the middle row have no return.
  for (const i of [4 * COLS + 5, 4 * COLS + 6]) { coverage[i] = 0; z[i] = Number.NaN; }
  const grid: SurfaceGrid = { z, coverage, cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0 };

  it('exploratory: estimated, with the count, in the record and limitations', () => {
    const surface = aboveGroundSurfaceFromAnalysis(dtm, grid);
    const r = runTerrainAccess(dtm, scale, obstructionProfile('exploratory'), 4 * COLS + 1, 4 * COLS + 9,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: surface }, identity);
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(2);
    expect((r.record.result.constraints as Record<string, string>).aboveGroundObstruction).toBe('estimated');
    const note = (r.record.result.constraintEstimates as Record<string, string>).aboveGroundObstruction;
    expect(note).toBe(`Above-ground obstruction could not be checked on 2 of ${r.diagnostics.cellCount} route cells: `
      + 'the surface has no above-ground evidence there, so those cells are not known to be clear.');
    expect(r.limitations.filter((l) => l === note)).toHaveLength(1);
    const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
    expect(card).toContain(note);
    expect(card).toMatch(/Above-ground obstruction\s*estimated against the above-ground surface/);
    expect(card).not.toContain('Above-ground evidence unavailable');
    expect(card).not.toContain('fully supported');
  });

  it('conservative: those cells are blocked, so a found route reads evaluated', () => {
    const surface = aboveGroundSurfaceFromAnalysis(dtm, grid);
    const r = runTerrainAccess(dtm, scale, obstructionProfile('conservative'), 2 * COLS + 2, 2 * COLS + 8,
      { ...TERRAIN_ACCESS_DEFAULTS, dsm: surface }, identity);
    if (!r.ok) throw new Error(r.reason);
    expect(r.record.result.obstructionUnevaluatedRouteCells).toBe(0);
    expect((r.record.result.constraints as Record<string, string>).aboveGroundObstruction).toBe('evaluated');
  });
});

describe('conservative ruggedness blocks cells whose VRM window holds a substituted-neighbour cell', () => {
  const COLS = 7;
  const ROWS = 7;
  const n = COLS * ROWS;
  const dtm: DtmGrid = {
    z: Float32Array.from({ length: n }, (_, i) => 0.1 * (i % COLS) + 0.05 * Math.floor(i / COLS)),
    coverage: new Uint8Array(n).fill(2), confidence: new Float32Array(n).fill(100),
    counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
  const at = (c: number, r: number): number => r * COLS + c;
  const rugged = (policy: 'conservative' | 'exploratory'): TerrainAccessProfile =>
    ({ ...PERMISSIVE, maxRuggedness: 1, evidenceGapPolicy: policy });

  it('the second ring is blocked, the interior is not', () => {
    const r = runTerrainAccess(dtm, scale, rugged('conservative'), at(2, 3), at(4, 3), TERRAIN_ACCESS_DEFAULTS, identity);
    if (!r.ok) throw new Error(r.reason);
    for (const [c, rr] of [[1, 1], [1, 3], [3, 1], [5, 3], [3, 5], [5, 5]] as const) {
      expect(r.eligibility.blocked[at(c, rr)]).toBe(1);
      expect(r.eligibility.reason[at(c, rr)]).toBe('derivative-support');
    }
    for (const [c, rr] of [[2, 2], [3, 3], [4, 4], [2, 4]] as const) expect(r.eligibility.blocked[at(c, rr)]).toBe(0);
    expect(r.record.result.ruggednessSynthesisedRouteCells).toBe(0);
    expect((r.record.result.constraints as Record<string, string>).ruggedness).toBe('evaluated');
  });

  it('a route that would start on the second ring is refused rather than estimated', () => {
    const r = runTerrainAccess(dtm, scale, rugged('conservative'), at(1, 3), at(4, 3), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('START_BLOCKED');
  });

  it('without a ruggedness limit the second ring stays eligible under conservative', () => {
    const r = runTerrainAccess(dtm, scale, { ...PERMISSIVE, evidenceGapPolicy: 'conservative' }, at(1, 3), at(4, 3),
      TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
  });

  it('exploratory keeps allowing it and reports ruggedness estimated', () => {
    const r = runTerrainAccess(dtm, scale, rugged('exploratory'), at(1, 3), at(4, 3), TERRAIN_ACCESS_DEFAULTS, identity);
    if (!r.ok) throw new Error(r.reason);
    expect((r.record.result.constraints as Record<string, string>).ruggedness).toBe('estimated');
  });
});

describe('the obstruction row names exactly one status', () => {
  it('each status the runner writes has its own wording', () => {
    const unavailable = 'Above-ground evidence unavailable; this constraint cannot be evaluated.';
    const texts = {
      evaluated: lab.obstructionStatusText('evaluated', 'allow'),
      estimated: lab.obstructionStatusText('estimated', 'allow'),
      disabled: lab.obstructionStatusText('disabled', 'allow'),
      unavailable: lab.obstructionStatusText('unavailable', 'allow'),
    };
    expect(texts.evaluated).toMatch(/^evaluated /);
    expect(texts.estimated).toMatch(/^estimated /);
    expect(texts.disabled).toBe('off in this profile');
    expect(texts.unavailable).toBe(unavailable);
    for (const [status, text] of Object.entries(texts)) {
      if (status !== 'unavailable') expect(text).not.toContain(unavailable);
    }
    expect(lab.obstructionStatusText('estimated', 'block')).toContain('blocked (conservative)');
    expect(lab.obstructionStatusText(undefined, 'allow')).toBe('not recorded');
  });
});
