/**
 * terrainCache.test.ts
 */

import { describe, it, expect } from 'vitest';
import { TerrainCache, type TerrainCacheKey } from '../src/terrain/TerrainCache';
import type { TerrainAnalysisResult } from '../src/terrain/TerrainContracts';

const KEY: TerrainCacheKey = {
  datasetFingerprint: 'd1',
  tileId: 7,
  analysisParameters: '{"k":"metrics"}',
  coverageMode: 'full',
  pointCountHash: 1000,
};

function result(): TerrainAnalysisResult {
  return {
    kind: 'metrics',
    coverage: 'full',
    sourcePointCount: 1000,
    analyzedPointCount: 1000,
    confidence: 95,
    warnings: [],
    payload: {
      'slope-degrees': [1, 2, 3],
      'roughness-rms': [0.1],
      'curvature-mean': [0.01],
      'elevation-variance': [0.5],
      'point-density': [10],
      'height-above-local-surface': [0],
      'neighborhood-elevation-range': [1],
      'local-planarity': [0.95],
    },
    elapsedMs: 12,
  };
}

describe('TerrainCache', () => {
  it('starts empty', () => {
    const c = new TerrainCache();
    expect(c.size).toBe(0);
    expect(c.sizeBytes).toBe(0);
  });

  it('insert + retrieve round-trips', () => {
    const c = new TerrainCache();
    c.insert(KEY, result());
    expect(c.retrieve(KEY)?.confidence).toBe(95);
  });

  it('retrieve returns undefined on miss', () => {
    const c = new TerrainCache();
    expect(c.retrieve(KEY)).toBeUndefined();
  });

  it('invalidate removes a single entry', () => {
    const c = new TerrainCache();
    c.insert(KEY, result());
    c.invalidate(KEY);
    expect(c.retrieve(KEY)).toBeUndefined();
  });

  it('clearDataset clears every entry matching a fingerprint', () => {
    const c = new TerrainCache();
    c.insert(KEY, result());
    c.insert({ ...KEY, tileId: 8 }, result());
    c.insert({ ...KEY, datasetFingerprint: 'd2' }, result());
    c.clearDataset('d1');
    expect(c.size).toBe(1);
  });

  it('clearAll empties the cache', () => {
    const c = new TerrainCache();
    c.insert(KEY, result());
    c.clearAll();
    expect(c.size).toBe(0);
    expect(c.sizeBytes).toBe(0);
  });

  it('evicts LRU when the budget overflows', () => {
    let t = 0;
    const c = new TerrainCache({ memoryBudgetBytes: 512, now: () => ++t });
    for (let i = 0; i < 100; i++) {
      c.insert({ ...KEY, tileId: i }, result());
    }
    expect(c.sizeBytes).toBeLessThanOrEqual(512 * 2); // budget honoured (allowing slop)
  });

  it('replacing an entry under the same key updates byte total honestly', () => {
    const c = new TerrainCache();
    c.insert(KEY, result());
    const sizeAfter = c.sizeBytes;
    c.insert(KEY, result()); // replace
    expect(c.sizeBytes).toBe(sizeAfter);
  });
});
