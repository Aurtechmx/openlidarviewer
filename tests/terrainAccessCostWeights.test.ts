/**
 * terrainAccessCostWeights.test.ts: declared cost weights are checked before
 * a run or a preview. A negative or non-finite weight could make an edge cost
 * less than its length (or NaN), so the A* heuristic would stop being
 * admissible; such weights are refused with INVALID_WEIGHTS.
 */
import { describe, expect, it } from 'vitest';

import { runTerrainAccess, TERRAIN_ACCESS_DEFAULTS } from '../src/simulation/terrainAccess/terrainAccessRunner';
import { prepareTerrainAccessPreview } from '../src/simulation/terrainAccess/terrainAccessPreview';
import { DEFAULT_COST_WEIGHTS, invalidCostWeights, type CostWeights } from '../src/simulation/terrainAccess/traversabilityCost';
import { PERMISSIVE } from './helpers/terrainAccessFixtures';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';

function flatDtm(cols: number): DtmGrid {
  return {
    z: new Float32Array(cols), coverage: new Uint8Array(cols).fill(2), confidence: new Float32Array(cols).fill(100),
    counts: new Uint32Array(cols).fill(1), interpDistanceCells: new Float32Array(cols),
    cols, rows: 1, cellSizeM: 1, originH1: 0, originH2: 0,
    crs: 'EPSG:32610', horizontalEpsg: 32610, verticalDatum: null, verticalEpsg: null,
    verticalUnitToMetres: 1, coverageMode: 'full', sourcePointCount: cols, analyzedPointCount: cols,
    withheldExcluded: true, meanConfidence: 100, warnings: [],
  } as DtmGrid;
}

const scale = { isGeographic: false, latitudeDeg: null, unitToMetres: 1, resolved: true };
const identity = {
  layerId: 'layer', filename: 'site', sourceDigest: null, analysisInputDigest: 'fixture',
  build: 'test', id: 'run', generatedAt: '2026-10-16T00:00:00Z', processingManifestHead: null,
};

const BAD: readonly [string, Partial<CostWeights>][] = [
  ['a negative weight', { support: -1 }],
  ['NaN', { longitudinal: Number.NaN }],
  ['Infinity', { cross: Number.POSITIVE_INFINITY }],
  ['-Infinity', { step: Number.NEGATIVE_INFINITY }],
  ['a missing term', { ruggedness: undefined as unknown as number }],
];

describe('cost weights are validated before a run', () => {
  it('the defaults and zero weights are accepted', () => {
    expect(invalidCostWeights(DEFAULT_COST_WEIGHTS)).toEqual([]);
    const zero = { longitudinal: 0, cross: 0, ruggedness: 0, step: 0, support: 0 };
    expect(invalidCostWeights(zero)).toEqual([]);
    const r = runTerrainAccess(flatDtm(4), scale, PERMISSIVE, 0, 3, { ...TERRAIN_ACCESS_DEFAULTS, weights: zero }, identity);
    expect(r.ok).toBe(true);
  });

  for (const [name, over] of BAD) {
    it(`a run with ${name} is refused with INVALID_WEIGHTS`, () => {
      const weights = { ...DEFAULT_COST_WEIGHTS, ...over } as CostWeights;
      const r = runTerrainAccess(flatDtm(4), scale, PERMISSIVE, 0, 3, { ...TERRAIN_ACCESS_DEFAULTS, weights }, identity);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.code).toBe('INVALID_WEIGHTS');
      expect(r.reason).toContain(Object.keys(over)[0]);
    });

    it(`a preview with ${name} is refused with INVALID_WEIGHTS`, () => {
      const weights = { ...DEFAULT_COST_WEIGHTS, ...over } as CostWeights;
      const p = prepareTerrainAccessPreview(flatDtm(4), scale, PERMISSIVE, { ...TERRAIN_ACCESS_DEFAULTS, weights });
      expect(p.ok).toBe(false);
      if (!p.ok) expect(p.code).toBe('INVALID_WEIGHTS');
    });
  }
});
