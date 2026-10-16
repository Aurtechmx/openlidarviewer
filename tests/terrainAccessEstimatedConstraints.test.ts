/**
 * terrainAccessEstimatedConstraints.test.ts — a slope-derived limit (cross
 * slope, longitudinal grade, ruggedness) is reported as `estimated`, not
 * `evaluated`, when a route cell's Horn window used a substituted neighbour.
 *
 * Reproduction: a 3×3 DTM with elevations only in the middle column (all 0).
 * Horn substitutes the centre value for the missing east and west
 * neighbours, so every route cell reads a cross slope of exactly 0 without a
 * single lateral sample. The route [1, 4, 7] passes a 0.01 cross-slope limit
 * that nothing measured.
 *
 *   - exploratory: the run is found, and crossSlope / longitudinalGrade are
 *     'estimated' with the count of affected route cells, split by cause, in
 *     the same words on the run card, limitations, CSV, README and record;
 *   - conservative: the substituted cells are blocked, so the run is refused.
 *
 * Expected masks are enumerated here from the definition (window leaves the
 * grid, or touches a NoData cell; that NoData cell is connected to the grid
 * edge or not), independently of the code under test.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { installRecordingDom, type RecordingEl } from './helpers/recordingDom';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import { textOf } from './helpers/zipReader';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import type { HorizontalScale } from '../src/simulation/terrainAccess/dtmTerrainAccessGrid';
import type { TerrainAccessProfile } from '../src/simulation/terrainAccess/terrainAccessTypes';

beforeAll(() => {
  installRecordingDom();
  (globalThis as unknown as Record<string, unknown>).HTMLInputElement = class HTMLInputElement {};
});

const { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } = await import('../src/simulation/terrainAccess/terrainAccessRunner');
const { prepareTerrainAccessPreview } = await import('../src/simulation/terrainAccess/terrainAccessPreview');
const { whyNotSentence } = await import('../src/simulation/terrainAccess/terrainAccessGridCursor');
const { buildTerrainAccessPackage } = await import('../src/export/terrainAccessPackage');
const lab = await import('../src/ui/fieldSimulation/terrainAccessLab');

function dtmOf(values: readonly (readonly (number | null)[])[], over: Partial<DtmGrid> = {}): DtmGrid {
  const rows = values.length;
  const cols = values[0].length;
  const n = rows * cols;
  const z = new Float32Array(n).fill(Number.NaN);
  const coverage = new Uint8Array(n);
  const confidence = new Float32Array(n);
  values.flat().forEach((v, i) => {
    if (v !== null) { z[i] = v; coverage[i] = 2; confidence[i] = 100; }
  });
  return {
    z, coverage, confidence, counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols, rows, cellSizeM: 1, originH1: 0, originH2: 0, crs: 'EPSG:32610', horizontalEpsg: 32610,
    verticalDatum: null, verticalEpsg: null, verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n,
    analyzedPointCount: n, withheldExcluded: true, meanConfidence: 100, warnings: [], ...over,
  };
}

const scale: HorizontalScale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'l', filename: 'f', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};
const exploratory = (over: Partial<TerrainAccessProfile> = {}): TerrainAccessProfile =>
  ({ ...PERMISSIVE, evidenceGapPolicy: 'exploratory', ...over });
const conservative = (over: Partial<TerrainAccessProfile> = {}): TerrainAccessProfile =>
  ({ ...PERMISSIVE, evidenceGapPolicy: 'conservative', ...over });

const statement = (subject: string, n: number, boundary: number, hole: number): string =>
  `${subject} estimated from substituted neighbours on ${n} route cells `
  + `(${boundary} at the outer boundary, ${hole} beside interior NoData holes).`;

/** Plane z = 0.1·x + 0.05·y on cols×rows, with NoData at `holes`. */
function plane(cols: number, rows: number, holes: readonly (readonly [number, number])[] = []): (number | null)[][] {
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) =>
    holes.some(([hc, hr]) => hc === c && hr === r) ? null : 0.1 * c + 0.05 * r));
}

describe('reproduction: one-cell-wide corridor', () => {
  const dtm = dtmOf([[null, 0, null], [null, 0, null], [null, 0, null]]);
  const limits = { maxCrossSlope: 0.01, vehicleWidth: 0.5 };

  it('exploratory: the route is found and the slope limits are estimated, not evaluated', () => {
    const r = runTerrainAccess(dtm, scale, exploratory(limits), 1, 7, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toEqual([1, 4, 7]);
    expect(r.diagnostics.maxCrossSlope).toBe(0);
    const c = r.record.result.constraints as Record<string, string>;
    expect(c.crossSlope).toBe('estimated');
    expect(c.longitudinalGrade).toBe('estimated');
    // Step height is a raw height difference between two cells: no Horn window.
    expect(c.stepHeight).toBe('evaluated');
    // All three cells touch NoData that reaches the grid edge, or leave the grid.
    expect(r.record.result.derivativeSynthesisedBoundaryRouteCells).toBe(3);
    expect(r.record.result.derivativeSynthesisedHoleRouteCells).toBe(0);
    const notes = r.record.result.constraintEstimates as Record<string, string>;
    expect(notes.crossSlope).toBe(statement('Cross-slope', 3, 3, 0));
    expect(notes.longitudinalGrade).toBe(statement('Longitudinal grade', 3, 3, 0));
    expect(r.limitations).toContain(statement('Cross-slope', 3, 3, 0));
  });

  it('exploratory: run card, CSV, README and run record carry the identical sentence and status', () => {
    const r = runTerrainAccess(dtm, scale, exploratory(limits), 1, 7, TERRAIN_ACCESS_DEFAULTS, identity);
    if (!r.ok) throw new Error(r.reason);
    const sentence = statement('Cross-slope', 3, 3, 0);
    const card = (lab.renderTerrainAccessRunCard(r) as unknown as RecordingEl).textContent;
    expect(card).toContain(sentence);
    expect(card).toMatch(/Cross slope\s*estimated/);
    const zip = buildTerrainAccessPackage(r, { basename: 'd' });
    const csv = textOf(zip, 'd-diagnostics.csv');
    expect(csv).toContain('constraint.crossSlope,estimated\n');
    expect(csv).toContain('constraint.stepHeight,evaluated\n');
    expect(csv).toContain(`constraintEstimate.crossSlope,"${sentence}"\n`);
    expect(csv).toContain('derivativeSynthesisedBoundaryRouteCells,3\n');
    expect(csv).toContain('derivativeSynthesisedHoleRouteCells,0\n');
    const readme = textOf(zip, 'd-README.txt');
    expect(readme).toMatch(/Cross slope\s+estimated/);
    expect(readme).toContain(sentence);
    const record = JSON.parse(textOf(zip, 'd-simulation-run.json'));
    expect(record.result.constraints.crossSlope).toBe('estimated');
    expect(record.result.constraintEstimates.crossSlope).toBe(sentence);
    expect(record.limitations).toContain(sentence);
  });

  it('conservative: the substituted cells are blocked, so the run is refused', () => {
    const r = runTerrainAccess(dtm, scale, conservative(limits), 1, 7, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(['START_BLOCKED', 'END_BLOCKED', 'NO_ROUTE', 'INSUFFICIENT_EVIDENCE']).toContain(r.code);
  });

  it('a control with real lateral samples is refused by the cross-slope limit', () => {
    const control = runTerrainAccess(dtmOf([[-0.5, 0, 0.5], [-0.5, 0, 0.5], [-0.5, 0, 0.5]]), scale,
      exploratory(limits), 1, 7, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(control.ok).toBe(false);
  });

  it('preview and why-not use the same status word', () => {
    const p = prepareTerrainAccessPreview(dtm, scale, exploratory(limits), TERRAIN_ACCESS_DEFAULTS);
    if (!p.ok) throw new Error(p.reason);
    expect(p.limitations.join(' ')).toMatch(
      /Longitudinal grade and cross-slope estimated from substituted neighbours on 3 grid cells \(3 at the outer boundary, 0 beside interior NoData holes\)/,
    );
    const why = whyNotSentence(p.grid, p.features, p.eligibility, exploratory(limits), { col: 1, row: 1 });
    expect(why).toMatch(/grade and cross-slope here are estimated from substituted neighbours \(outer boundary\)/);
  });
});

describe('interior NoData holes', () => {
  // 9×7 plane, hole at (4, 3): its 8-cell halo is interior and touches no edge.
  const dtm = dtmOf(plane(9, 7, [[4, 3]]));

  it('a route through the halo counts hole cells, not boundary cells', () => {
    const idx = (c: number, r: number): number => r * 9 + c;
    const r = runTerrainAccess(dtm, scale, exploratory(), idx(3, 3), idx(5, 3), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const halo = (i: number): boolean => {
      const c = i % 9; const row = Math.floor(i / 9);
      return Math.abs(c - 4) <= 1 && Math.abs(row - 3) <= 1;
    };
    const holeCells = r.path.filter(halo).length;
    expect(holeCells).toBe(r.path.length);
    expect(r.record.result.derivativeSynthesisedHoleRouteCells).toBe(holeCells);
    expect(r.record.result.derivativeSynthesisedBoundaryRouteCells).toBe(0);
    expect((r.record.result.constraints as Record<string, string>).crossSlope).toBe('estimated');
    expect(r.limitations).toContain(statement('Cross-slope', holeCells, 0, holeCells));
  });

  it('the why-not sentence names the interior hole', () => {
    const profile = exploratory();
    const p = prepareTerrainAccessPreview(dtm, scale, profile, TERRAIN_ACCESS_DEFAULTS);
    if (!p.ok) throw new Error(p.reason);
    expect(whyNotSentence(p.grid, p.features, p.eligibility, profile, { col: 3, row: 3 }))
      .toMatch(/estimated from substituted neighbours \(interior NoData hole\)/);
    expect(whyNotSentence(p.grid, p.features, p.eligibility, profile, { col: 2, row: 2 }))
      .not.toMatch(/estimated/);
  });

  it('conservative blocks the halo, and a route around it stays evaluated', () => {
    const idx = (c: number, r: number): number => r * 9 + c;
    const blocked = runTerrainAccess(dtm, scale, conservative(), idx(3, 3), idx(5, 3), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(blocked.ok).toBe(false);
    const around = runTerrainAccess(dtm, scale, conservative(), idx(2, 2), idx(6, 4), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(around.ok).toBe(true);
    if (!around.ok) return;
    const c = around.record.result.constraints as Record<string, string>;
    expect(c.crossSlope).toBe('evaluated');
    expect(c.longitudinalGrade).toBe('evaluated');
  });
});

describe('outer boundaries', () => {
  it('a route along the grid edge counts boundary cells', () => {
    const dtm = dtmOf(plane(9, 7));
    const r = runTerrainAccess(dtm, scale, exploratory(), 0, 8, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.path).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(r.record.result.derivativeSynthesisedBoundaryRouteCells).toBe(9);
    expect(r.record.result.derivativeSynthesisedHoleRouteCells).toBe(0);
    expect(r.limitations).toContain(statement('Cross-slope', 9, 9, 0));
  });

  it('NoData connected to the grid edge counts as outer boundary, not as a hole', () => {
    // Column 0 is NoData along its whole length: the survey's outer edge.
    const values = plane(9, 7).map((row) => row.map((v, c) => (c === 0 ? null : v)));
    const dtm = dtmOf(values);
    const p = prepareTerrainAccessPreview(dtm, scale, exploratory(), TERRAIN_ACCESS_DEFAULTS);
    if (!p.ok) throw new Error(p.reason);
    // Column 1 (interior rows 1..5) touches the NoData column: boundary.
    expect(whyNotSentence(p.grid, p.features, p.eligibility, exploratory(), { col: 1, row: 3 }))
      .toMatch(/\(outer boundary\)/);
  });
});

describe('fully supported tilted plane', () => {
  it('an interior route stays evaluated and says nothing about substituted neighbours', () => {
    const dtm = dtmOf(plane(9, 7));
    const idx = (c: number, r: number): number => r * 9 + c;
    const r = runTerrainAccess(dtm, scale, exploratory(), idx(2, 2), idx(6, 4), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.record.result.constraints as Record<string, string>;
    expect(c.crossSlope).toBe('evaluated');
    expect(c.longitudinalGrade).toBe('evaluated');
    expect(r.record.result.constraintEstimates).toEqual({});
    expect(r.limitations.join(' ')).not.toMatch(/substituted neighbours/);
    const zip = buildTerrainAccessPackage(r, { basename: 'd' });
    expect(textOf(zip, 'd-diagnostics.csv')).toContain('constraint.crossSlope,evaluated\n');
    expect(textOf(zip, 'd-diagnostics.csv')).not.toContain('constraintEstimate.');
  });
});

describe('rectangular cells', () => {
  // A geographic grid at 60°N: cells are half as wide east-west as tall north-south.
  const geo: HorizontalScale = { isGeographic: true, latitudeDeg: 60, unitToMetres: 1, resolved: true };
  const deg = 1e-5;

  it('the corridor reproduction is estimated on a rectangular grid too', () => {
    const dtm = dtmOf([[null, 0, null], [null, 0, null], [null, 0, null]], { cellSizeM: deg });
    const r = runTerrainAccess(dtm, geo, exploratory({ maxCrossSlope: 0.01 }), 1, 7, TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.grid.cellMetresX).not.toBeCloseTo(r.grid.cellMetresY, 3);
    expect((r.record.result.constraints as Record<string, string>).crossSlope).toBe('estimated');
    expect(r.limitations).toContain(statement('Cross-slope', 3, 3, 0));
  });

  it('an interior route on a fully supported rectangular grid stays evaluated', () => {
    const dtm = dtmOf(Array.from({ length: 7 }, () => Array(9).fill(0)), { cellSizeM: deg });
    const idx = (c: number, r: number): number => r * 9 + c;
    const r = runTerrainAccess(dtm, geo, exploratory(), idx(2, 2), idx(6, 4), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect((r.record.result.constraints as Record<string, string>).crossSlope).toBe('evaluated');
  });
});

describe('ruggedness', () => {
  it('a route cell whose VRM window holds a substituted-slope cell reports ruggedness as estimated', () => {
    const dtm = dtmOf(plane(9, 7));
    const idx = (c: number, r: number): number => r * 9 + c;
    // Row 1 is interior (fully supported Horn windows), but its VRM window reaches row 0.
    const r = runTerrainAccess(dtm, scale, exploratory({ maxRuggedness: 1 }), idx(2, 1), idx(6, 1),
      TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.record.result.constraints as Record<string, string>;
    expect(c.crossSlope).toBe('evaluated');
    expect(c.ruggedness).toBe('estimated');
    expect(r.limitations).toContain(
      `Ruggedness estimated from substituted neighbours on ${r.path.length} route cells `
      + '(its window holds a cell whose slope used a substituted neighbour).',
    );
  });
});
