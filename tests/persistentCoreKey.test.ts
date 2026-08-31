/**
 * persistentCoreKey.test.ts — the correctness contract a persistent (across-
 * reopen) terrain core cache must satisfy, proven in Node with no storage.
 *
 * Properties:
 *   1. Determinism — same positions + params + generation → same key.
 *   2. Param invalidation — any core param change → a different key (reuses the
 *      exact `paramsKey` the in-memory cache already proves, so coverage can't
 *      drift; spot-checked here across the CRS/units/ground/class axes).
 *   3. Content invalidation, crypto-strength — an edit the in-memory FNV SAMPLE
 *      hash misses (an unsampled interior triple) still changes the persistent
 *      key, because it keys on a full SHA-256. This is the cross-session safety
 *      the sample hash cannot give.
 *   4. Method-version invalidation — a bump to any folded core method's version
 *      changes the generation and therefore the key (a persisted core computed
 *      by old code must miss). Modelled via the injectable version lookup.
 *   5. Registry integrity — every folded method id actually exists, so a rename
 *      breaks loudly instead of silently dropping a method from the key.
 *   6. Integrity digest — a payload verifies against its own digest; a single
 *      flipped byte fails.
 *
 * Pure data: no DOM, no I/O, no OPFS.
 */

import { describe, it, expect } from 'vitest';

import { coreFingerprint } from '../src/terrain/contour/terrainCoreCache';
import type { TerrainCoreParams } from '../src/terrain/contour/analyseContours';
import {
  persistentCoreKey,
  coreMethodGeneration,
  cryptoContentFingerprint,
  integrityDigest,
  verifyIntegrity,
  TERRAIN_CORE_METHOD_IDS,
  PERSISTENT_CORE_KEY_VERSION,
} from '../src/terrain/contour/persistentCoreKey';
import { method } from '../src/science/methodRegistry';

/** Deterministic Float32Array of XYZ triples (length 3N). */
function makeCloud(n: number, seed = 1): Float32Array {
  const f = new Float32Array(n * 3);
  let s = seed >>> 0;
  for (let i = 0; i < f.length; i++) {
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

describe('coreMethodGeneration', () => {
  it('every folded method id exists in the registry', () => {
    for (const id of TERRAIN_CORE_METHOD_IDS) {
      expect(method(id), `missing registry method: ${id}`).not.toBeNull();
    }
  });

  it('is stable and ordered, and carries the key-scheme version', () => {
    const gen = coreMethodGeneration();
    expect(gen).toBe(coreMethodGeneration());
    expect(gen.startsWith(`k${PERSISTENT_CORE_KEY_VERSION};`)).toBe(true);
    // Tags are id-sorted: the joined body is already in ascending id order.
    const body = gen.slice(gen.indexOf(';') + 1);
    const ids = body.split(',').map((t) => t.slice(0, t.lastIndexOf('@')));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  });

  it('changes when any folded method version bumps', () => {
    const base = coreMethodGeneration();
    const target = TERRAIN_CORE_METHOD_IDS[0];
    const bumped = coreMethodGeneration((id) =>
      id === target ? method(id)!.version + 1 : method(id)!.version,
    );
    expect(bumped).not.toBe(base);
  });
});

describe('persistentCoreKey', () => {
  it('is deterministic for the same positions + params + generation', async () => {
    const pos = makeCloud(500);
    const a = await persistentCoreKey(pos, BASE_PARAMS);
    const b = await persistentCoreKey(pos, BASE_PARAMS);
    expect(a).toBe(b);
  });

  it('misses on any core param change', async () => {
    const pos = makeCloud(500);
    const base = await persistentCoreKey(pos, BASE_PARAMS);
    const variants: TerrainCoreParams[] = [
      { ...BASE_PARAMS, cellSizeM: 1 },
      { ...BASE_PARAMS, crs: 'EPSG:32611' },
      { ...BASE_PARAMS, verticalDatum: 'EPSG:5701' },
      { ...BASE_PARAMS, isGeographic: true },
      { ...BASE_PARAMS, verticalUnitToMetres: 0.3048 },
      { ...BASE_PARAMS, verticalAxis: 'y' },
      { ...BASE_PARAMS, holdoutSeed: 7 },
      { ...BASE_PARAMS, excludeClasses: [7] },
      { ...BASE_PARAMS, ground: { slope: 0.2 } },
      { ...BASE_PARAMS, samplePointScale: 4 },
      { ...BASE_PARAMS, aggregation: 'mean' },
      { ...BASE_PARAMS, latitudeDeg: 37 },
    ];
    for (const v of variants) {
      expect(await persistentCoreKey(pos, v), JSON.stringify(v)).not.toBe(base);
    }
  });

  it('misses on the SAME generation only when an input actually changed', async () => {
    const pos = makeCloud(500);
    const gen = coreMethodGeneration();
    const a = await persistentCoreKey(pos, BASE_PARAMS, gen);
    const b = await persistentCoreKey(pos, BASE_PARAMS, gen);
    expect(a).toBe(b);
  });

  it('misses when the method generation changes, inputs held', async () => {
    const pos = makeCloud(500);
    const genA = coreMethodGeneration();
    const genB = coreMethodGeneration((id) =>
      id === TERRAIN_CORE_METHOD_IDS[0]
        ? method(id)!.version + 1
        : method(id)!.version,
    );
    const a = await persistentCoreKey(pos, BASE_PARAMS, genA);
    const b = await persistentCoreKey(pos, BASE_PARAMS, genB);
    expect(a).not.toBe(b);
  });

  it('catches an edit the in-memory FNV sample hash misses', async () => {
    // 500 triples → the sample stride skips most interior triples. Editing an
    // unsampled interior triple leaves the in-memory sample fingerprint
    // unchanged (a would-be false HIT across sessions) but changes the full
    // SHA-256, so the persistent key correctly misses.
    const a = makeCloud(500);
    const b = a.slice();
    b[3] += 1; // triple index 1 (x): outside the first/last/stride samples
    // Precondition: the in-memory sample hash collides on this edit.
    expect(coreFingerprint(b, BASE_PARAMS)).toBe(coreFingerprint(a, BASE_PARAMS));
    // The persistent key does not.
    expect(await persistentCoreKey(b, BASE_PARAMS)).not.toBe(
      await persistentCoreKey(a, BASE_PARAMS),
    );
  });

  it('cryptoContentFingerprint folds the triple count', async () => {
    // Same bytes, different declared length can't happen for a real array, but
    // two clouds of different length must never share a content fingerprint.
    const short = makeCloud(10);
    const long = makeCloud(11);
    expect(await cryptoContentFingerprint(short)).not.toBe(
      await cryptoContentFingerprint(long),
    );
  });
});

describe('integrity digest', () => {
  it('verifies a payload against its own digest', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = await integrityDigest(bytes);
    expect(await verifyIntegrity(bytes, digest)).toBe(true);
  });

  it('rejects a single flipped byte', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const digest = await integrityDigest(bytes);
    const tampered = bytes.slice();
    tampered[2] ^= 0x01;
    expect(await verifyIntegrity(tampered, digest)).toBe(false);
  });
});
