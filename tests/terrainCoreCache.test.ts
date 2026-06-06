/**
 * terrainCoreCache.test.ts — proves the fingerprint-keyed core cache reuses
 * the heavy terrain computation across interval changes and repeated runs,
 * and recomputes whenever the cloud or the core parameters change.
 *
 * Properties:
 *   1. Hit — same positions + same core params → `computeTerrainCore` is
 *      called ONCE across repeated cache calls AND across different interval
 *      requests (the interval is NOT part of the core key).
 *   2. Miss — a changed core param (cellSize / ground / crs / datum / units /
 *      axis / classification / excludeClasses / holdoutSeed) recomputes.
 *   3. Miss — a changed cloud (different sampled content, same length, or a
 *      different length) recomputes; no false hit.
 *   4. LRU — the cache holds a bounded number of entries and evicts the
 *      least-recently-used one; a re-request of an evicted key recomputes.
 *   5. clear() — drops every entry so the next call recomputes.
 *
 * The cache is pure / deterministic and stubs `compute` with a counting fake
 * so the tests assert call counts without running the (slow) real pipeline.
 *
 * Pure data: no DOM, no I/O.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  coreFingerprint,
  getOrComputeCore,
  clearTerrainCoreCache,
  TERRAIN_CORE_CACHE_SIZE,
} from '../src/terrain/contour/terrainCoreCache';
import type {
  TerrainCore,
  TerrainCoreParams,
} from '../src/terrain/contour/analyseContours';

/** A cheap fake core — the cache treats it opaquely, so a tagged stub is fine. */
function fakeCore(tag: string): TerrainCore {
  return { __tag: tag } as unknown as TerrainCore;
}

/** Build a deterministic Float32Array of XYZ triples (length 3N). */
function makeCloud(n: number, seed = 1): Float32Array {
  const f = new Float32Array(n * 3);
  let s = seed >>> 0;
  for (let i = 0; i < f.length; i++) {
    // Cheap LCG so the content is non-trivial and seed-dependent.
    s = (s * 1664525 + 1013904223) >>> 0;
    f[i] = (s / 0xffffffff) * 100;
  }
  return f;
}

const BASE_PARAMS: TerrainCoreParams = {
  cellSizeM: 2,
  crs: 'EPSG:32610',
  verticalDatum: 'EPSG:5703',
};

describe('coreFingerprint', () => {
  it('is stable for the same positions + params', () => {
    const pos = makeCloud(500);
    expect(coreFingerprint(pos, BASE_PARAMS)).toBe(
      coreFingerprint(pos, BASE_PARAMS),
    );
  });

  it('differs when any core param differs', () => {
    const pos = makeCloud(500);
    const base = coreFingerprint(pos, BASE_PARAMS);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, cellSizeM: 1 })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, crs: 'EPSG:2193' })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, verticalDatum: null })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, isGeographic: true })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, verticalUnitToMetres: 0.3048 })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, verticalAxis: 'y' })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, holdoutSeed: 7 })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, ground: { slope: 0.4 } })).not.toBe(base);
    expect(coreFingerprint(pos, { ...BASE_PARAMS, excludeClasses: [7] })).not.toBe(base);
  });

  it('reflects classification presence and length', () => {
    const pos = makeCloud(300);
    const noClass = coreFingerprint(pos, BASE_PARAMS);
    const withClass = coreFingerprint(pos, {
      ...BASE_PARAMS,
      classification: new Uint8Array(100),
    });
    const longerClass = coreFingerprint(pos, {
      ...BASE_PARAMS,
      classification: new Uint8Array(200),
    });
    expect(withClass).not.toBe(noClass);
    expect(longerClass).not.toBe(withClass);
  });

  it('differs when the cloud length differs', () => {
    expect(coreFingerprint(makeCloud(500), BASE_PARAMS)).not.toBe(
      coreFingerprint(makeCloud(600), BASE_PARAMS),
    );
  });

  it('differs when the cloud content differs at the same length', () => {
    expect(coreFingerprint(makeCloud(500, 1), BASE_PARAMS)).not.toBe(
      coreFingerprint(makeCloud(500, 2), BASE_PARAMS),
    );
  });
});

describe('getOrComputeCore', () => {
  beforeEach(() => clearTerrainCoreCache());

  it('computes once, then serves from cache for repeated identical calls', () => {
    const pos = makeCloud(800);
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore('a');
    };
    const a = getOrComputeCore(pos, BASE_PARAMS, compute);
    const b = getOrComputeCore(pos, BASE_PARAMS, compute);
    const c = getOrComputeCore(pos, BASE_PARAMS, compute);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('computes the core ONCE across different interval requests', () => {
    // The interval is NOT a core param, so the same (positions, coreParams)
    // serve the same cached core no matter how many intervals the UI picks.
    const pos = makeCloud(800);
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore('core');
    };
    // Simulate: first Analyse, then three interval picks — all reuse the core.
    const first = getOrComputeCore(pos, BASE_PARAMS, compute);
    for (const _interval of [1, 2, 5]) {
      const reused = getOrComputeCore(pos, BASE_PARAMS, compute);
      expect(reused).toBe(first);
    }
    expect(calls).toBe(1);
  });

  it('recomputes when a core param changes', () => {
    const pos = makeCloud(800);
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore(`c${calls}`);
    };
    getOrComputeCore(pos, BASE_PARAMS, compute);
    getOrComputeCore(pos, { ...BASE_PARAMS, cellSizeM: 1 }, compute);
    getOrComputeCore(pos, { ...BASE_PARAMS, ground: { slope: 0.5 } }, compute);
    getOrComputeCore(pos, { ...BASE_PARAMS, crs: 'EPSG:2193' }, compute);
    getOrComputeCore(pos, { ...BASE_PARAMS, classification: new Uint8Array(10) }, compute);
    expect(calls).toBe(5);
  });

  it('recomputes for a different cloud (no false cache hit)', () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore(`c${calls}`);
    };
    const cloudA = makeCloud(800, 1);
    const cloudB = makeCloud(800, 2); // same length, different content
    const cloudC = makeCloud(900, 1); // different length
    getOrComputeCore(cloudA, BASE_PARAMS, compute);
    getOrComputeCore(cloudA, BASE_PARAMS, compute); // hit
    getOrComputeCore(cloudB, BASE_PARAMS, compute); // miss — content changed
    getOrComputeCore(cloudC, BASE_PARAMS, compute); // miss — length changed
    expect(calls).toBe(3);
  });

  it('evicts the least-recently-used entry beyond the cache size', () => {
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore(`c${calls}`);
    };
    // Fill the cache with N distinct clouds (one over capacity would evict).
    const clouds = Array.from({ length: TERRAIN_CORE_CACHE_SIZE + 1 }, (_, i) =>
      makeCloud(400, i + 1),
    );
    // Insert exactly the capacity, all unique.
    for (let i = 0; i < TERRAIN_CORE_CACHE_SIZE; i++) {
      getOrComputeCore(clouds[i], BASE_PARAMS, compute);
    }
    expect(calls).toBe(TERRAIN_CORE_CACHE_SIZE);
    // Re-touch all of them: still cached, no new computes.
    for (let i = 0; i < TERRAIN_CORE_CACHE_SIZE; i++) {
      getOrComputeCore(clouds[i], BASE_PARAMS, compute);
    }
    expect(calls).toBe(TERRAIN_CORE_CACHE_SIZE);
    // Insert one more → evicts the LRU (clouds[0], untouched longest).
    getOrComputeCore(clouds[TERRAIN_CORE_CACHE_SIZE], BASE_PARAMS, compute);
    expect(calls).toBe(TERRAIN_CORE_CACHE_SIZE + 1);
    // clouds[0] was evicted → recompute; the others (1..) are still hits.
    getOrComputeCore(clouds[0], BASE_PARAMS, compute);
    expect(calls).toBe(TERRAIN_CORE_CACHE_SIZE + 2);
  });

  it('refreshes recency on a hit so the LRU victim is genuinely oldest', () => {
    // Cache size 2: insert A, B; touch A (now MRU); insert C → evicts B not A.
    if (TERRAIN_CORE_CACHE_SIZE < 2) return;
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore(`c${calls}`);
    };
    const A = makeCloud(400, 11);
    const B = makeCloud(400, 12);
    const C = makeCloud(400, 13);
    getOrComputeCore(A, BASE_PARAMS, compute); // calls 1
    getOrComputeCore(B, BASE_PARAMS, compute); // calls 2
    getOrComputeCore(A, BASE_PARAMS, compute); // hit — A is now MRU
    expect(calls).toBe(2);
    // Insert enough fresh entries to evict exactly one (B should go first).
    for (let i = 0; i < TERRAIN_CORE_CACHE_SIZE - 1; i++) {
      getOrComputeCore(makeCloud(400, 100 + i), BASE_PARAMS, compute);
    }
    const callsAfterFill = calls;
    getOrComputeCore(A, BASE_PARAMS, compute); // A must still be a hit
    expect(calls).toBe(callsAfterFill);
    getOrComputeCore(B, BASE_PARAMS, compute); // B was evicted → recompute
    expect(calls).toBe(callsAfterFill + 1);
    void C;
  });

  it('clear() drops every entry so the next call recomputes', () => {
    const pos = makeCloud(800);
    let calls = 0;
    const compute = () => {
      calls++;
      return fakeCore('x');
    };
    getOrComputeCore(pos, BASE_PARAMS, compute);
    getOrComputeCore(pos, BASE_PARAMS, compute);
    expect(calls).toBe(1);
    clearTerrainCoreCache();
    getOrComputeCore(pos, BASE_PARAMS, compute);
    expect(calls).toBe(2);
  });

  it('defaults compute to the real computeTerrainCore (smoke)', () => {
    // No compute argument → uses the bound default; just assert it returns a
    // core-shaped object with a dtm and is cached on the second call.
    const pos = makeCloud(600);
    const r1 = getOrComputeCore(pos, BASE_PARAMS);
    const r2 = getOrComputeCore(pos, BASE_PARAMS);
    expect(r1).toBe(r2);
    expect(r1.dtm).toBeDefined();
  });
});
