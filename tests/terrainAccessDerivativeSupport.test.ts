/**
 * terrainAccessDerivativeSupport.test.ts — Terrain Access carries the Horn
 * derivative-support state of every cell into eligibility and diagnostics.
 *
 * Fixture: an analytic plane z = 0.1·x + 0.05·y on a 9×7 grid of 1 m cells
 * with two interior holes. A cell's slope and aspect lean on a synthesised
 * neighbour when its 3×3 window leaves the grid (the outer ring) or touches a
 * hole (the halo). The expected mask is enumerated here from that definition,
 * independently of the code under test.
 *
 *   - conservative: every such cell is blocked with reason
 *     'derivative-support'; every other valid cell is not;
 *   - exploratory: those cells stay eligible, and the exact share of route
 *     cells among them is reported in the diagnostics, the run record, the
 *     exported CSV and the run card.
 */
import { describe, expect, it } from 'vitest';
import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { prepareTerrainAccessPreview } from '../src/simulation/terrainAccess/terrainAccessPreview';
import { whyNotEligible } from '../src/simulation/terrainAccess/traversabilityCost';
import { derivativeSupportText } from '../src/ui/fieldSimulation/terrainAccessLab';
import { buildTerrainAccessPackage } from '../src/export/terrainAccessPackage';
import { textOf } from './helpers/zipReader';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

const COLS = 9;
const ROWS = 7;
const HOLES: readonly (readonly [number, number])[] = [[3, 2], [6, 4]];
const idx = (col: number, row: number): number => row * COLS + col;
const isHole = (col: number, row: number): boolean => HOLES.some(([c, r]) => c === col && r === row);

function planeWithHoles(): DtmGrid {
  const n = COLS * ROWS;
  const z = new Float32Array(n);
  const coverage = new Uint8Array(n);
  const confidence = new Float32Array(n);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const i = idx(col, row);
      if (isHole(col, row)) { z[i] = Number.NaN; continue; }
      z[i] = 0.1 * col + 0.05 * row;
      coverage[i] = 2;
      confidence[i] = 100;
    }
  }
  return {
    z, coverage, confidence, counts: new Uint32Array(n).fill(1), interpDistanceCells: new Float32Array(n),
    cols: COLS, rows: ROWS, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: n, analyzedPointCount: n,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  };
}

/** 1 where a valid cell's 3×3 window leaves the grid or touches a hole. */
function expectedMask(): Uint8Array {
  const m = new Uint8Array(COLS * ROWS);
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      if (isHole(col, row)) continue;
      const ring = row === 0 || col === 0 || row === ROWS - 1 || col === COLS - 1;
      const halo = HOLES.some(([c, r]) => Math.abs(c - col) <= 1 && Math.abs(r - row) <= 1);
      if (ring || halo) m[idx(col, row)] = 1;
    }
  }
  return m;
}

const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'l', filename: 'f', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'test', generatedAt: '2026-10-15T00:00:00Z', processingManifestHead: null,
};

describe('the derivative-support mask', () => {
  const dtm = planeWithHoles();
  const mask = expectedMask();

  it('flags exactly the outer ring and the hole halos', () => {
    const p = prepareTerrainAccessPreview(dtm, scale, { ...PERMISSIVE, evidenceGapPolicy: 'exploratory' }, TERRAIN_ACCESS_DEFAULTS);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(Array.from(p.features.derivativeSynthesised)).toEqual(Array.from(mask));
    // Ring 2·(9+7)−4 = 28 cells; halos add 8 + 8 interior cells (none overlap the ring
    // or each other here).
    expect(mask.reduce((a, b) => a + b, 0)).toBe(44);
  });

  it('interior cells away from holes carry the exact plane gradient', () => {
    const p = prepareTerrainAccessPreview(dtm, scale, { ...PERMISSIVE, evidenceGapPolicy: 'exploratory' }, TERRAIN_ACCESS_DEFAULTS);
    if (!p.ok) throw new Error(p.reason);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1 || dtm.coverage[i] === 0) continue;
      expect(p.features.slope[i]).toBeCloseTo(Math.hypot(0.1, 0.05), 5);
    }
  });
});

describe('conservative: inadequate derivative support blocks', () => {
  const dtm = planeWithHoles();
  const mask = expectedMask();
  const profile = { ...PERMISSIVE, evidenceGapPolicy: 'conservative' as const };

  it('blocks every flagged cell with its own reason and no other', () => {
    const p = prepareTerrainAccessPreview(dtm, scale, profile, TERRAIN_ACCESS_DEFAULTS);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    for (let i = 0; i < mask.length; i++) {
      if (dtm.coverage[i] === 0) { expect(p.eligibility.reason[i]).toBe('no-data'); continue; }
      expect(p.eligibility.reason[i]).toBe(mask[i] === 1 ? 'derivative-support' : null);
    }
    const why = whyNotEligible(p.grid, p.features, p.eligibility, profile, idx(0, 0));
    expect(why.category).toBe('unknown');
    expect(why.reasons[0].reason).toBe('derivative-support');
    expect(why.reasons[0].detail).toMatch(/synthesised neighbour/);
  });

  it('a start cell on the ring is refused; an interior route runs with no flagged cell', () => {
    const blocked = runTerrainAccess(dtm, scale, profile, idx(0, 6), idx(4, 5), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('START_BLOCKED');
    const r = runTerrainAccess(dtm, scale, profile, idx(1, 5), idx(4, 5), TERRAIN_ACCESS_DEFAULTS, identity);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.diagnostics.fractionDerivativeSynthesised).toBe(0);
    expect(r.record.result.derivativeSupportPolicy).toBe('block');
    expect(r.record.result.constraints).toMatchObject({ derivativeSupport: 'evaluated' });
    expect(r.limitations.join(' ')).toMatch(/conservative evidence policy blocked 44 cells/);
  });
});

describe('exploratory: inadequate derivative support is allowed and disclosed', () => {
  const dtm = planeWithHoles();
  const mask = expectedMask();
  const profile = { ...PERMISSIVE, evidenceGapPolicy: 'exploratory' as const };
  const r = runTerrainAccess(dtm, scale, profile, idx(0, 6), idx(8, 0), TERRAIN_ACCESS_DEFAULTS, identity);

  it('routes across flagged cells and reports their exact share', () => {
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const flagged = r.path.filter((i) => mask[i] === 1).length;
    expect(flagged).toBeGreaterThan(0);
    expect(r.diagnostics.derivativeSynthesisedRouteCells).toBe(flagged);
    expect(r.diagnostics.fractionDerivativeSynthesised).toBe(flagged / r.path.length);
    expect(r.record.result.fractionDerivativeSynthesised).toBe(flagged / r.path.length);
    expect(r.record.result.derivativeSynthesisedRouteCells).toBe(flagged);
    expect(r.record.result.derivativeSynthesisedGridCells).toBe(44);
    expect(r.record.result.derivativeSupportPolicy).toBe('disclose');
    const pct = Math.round((100 * flagged) / r.path.length);
    expect(r.limitations.join(' ')).toContain(
      `${flagged} of ${r.path.length} route cells (${pct}%) have a slope and aspect computed with at least one synthesised neighbour`,
    );
  });

  it('the CSV and the run card carry the same figure', () => {
    if (!r.ok) throw new Error(r.reason);
    const zip = buildTerrainAccessPackage(r, { basename: 'd' });
    const csv = textOf(zip, 'd-diagnostics.csv');
    expect(csv).toContain(`fractionDerivativeSynthesised,${r.diagnostics.fractionDerivativeSynthesised}\n`);
    expect(csv).toContain(`derivativeSynthesisedRouteCells,${r.diagnostics.derivativeSynthesisedRouteCells}\n`);
    expect(csv).toContain('evidenceGapPolicy,exploratory\n');
    // The run card's "Slope from a synthesised neighbour" row.
    const pct = Math.round((r.diagnostics.fractionDerivativeSynthesised ?? 0) * 100);
    expect(derivativeSupportText(r.diagnostics, r.record.result.derivativeSupportPolicy))
      .toBe(`${pct}% of route cells, allowed and disclosed (exploratory)`);
    expect(derivativeSupportText(r.diagnostics, 'block')).toBe('cells with a synthesised neighbour blocked (conservative)');
  });

  it('the policy moves the method identity of the run', () => {
    if (!r.ok) throw new Error(r.reason);
    const c = runTerrainAccess(dtm, scale, { ...profile, evidenceGapPolicy: 'conservative' }, idx(1, 5), idx(4, 5),
      TERRAIN_ACCESS_DEFAULTS, identity);
    const e = runTerrainAccess(dtm, scale, profile, idx(1, 5), idx(4, 5), TERRAIN_ACCESS_DEFAULTS, identity);
    if (!c.ok || !e.ok) throw new Error('expected both runs');
    expect(c.record.parameters.evidenceGapPolicy).toBe('conservative');
    expect(e.record.parameters.evidenceGapPolicy).toBe('exploratory');
    expect(c.record.digest).not.toBe(e.record.digest);
  });
});
