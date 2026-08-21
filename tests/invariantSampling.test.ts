/**
 * Metamorphic (invariance) suite for the two decimation paths.
 *
 * Both targets are SELECTION-based samplers, established by reading them
 * before any assertion was written:
 *
 *   src/io/strideSample.ts          `stratifiedSampleIndices` returns record
 *                                   INDICES. It never reads or produces a
 *                                   coordinate, so "no invented coordinates"
 *                                   is asserted at index level: every returned
 *                                   value is an integer record index that
 *                                   exists in [0, count).
 *
 *   src/render/terrainStreamSample.ts  `sampleStridedTerrain` copies whole
 *                                   points at stride positions and adds the
 *                                   layer placement, a per-buffer constant
 *                                   translation. There is no voxel binning and
 *                                   no centroid averaging, so the exact
 *                                   membership relation applies: every output
 *                                   triple equals an input triple (identity
 *                                   placement) or an input triple translated
 *                                   by that buffer's constant offset.
 *
 * The membership relation is asserted through `inventedTriples`, and the same
 * function is driven against deliberately corrupted output to show it rejects
 * a coordinate the input never held.
 */

import { describe, expect, test } from 'vitest';
import {
  makePrng,
  pickInBucket,
  stratifiedSampleIndices,
  STRIDE_SAMPLE_SEED,
} from '../src/io/strideSample';
import {
  sampleStridedTerrain,
  type KeyedTerrainStreamBuffer,
  type TerrainStreamBuffer,
} from '../src/render/terrainStreamSample';
import type { LayerSpatialTransform } from '../src/geo/ProjectSpatialFrame';

// ---------------------------------------------------------------------------
// Fixture generation. Independent of the PRNG inside strideSample.ts so the
// test data cannot co-vary with the code under test. Fixed seed, no
// Math.random.
// ---------------------------------------------------------------------------

const FIXTURE_SEED = 0x5eed1234;

/** xorshift32. Fixed seed in, same sequence out, every run and platform. */
function fixturePrng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/**
 * `n` points with float32-exact coordinates, offset by `tag` so points from
 * different buffers never collide. Values pass through Math.fround, so writing
 * them into a Float32Array is lossless and membership can be compared exactly.
 */
function makeCloud(n: number, tag: number, rand: () => number): Float32Array {
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = Math.fround(tag * 1000 + i + rand());
    pos[i * 3 + 1] = Math.fround(tag * 2000 + i * 3 + rand());
    pos[i * 3 + 2] = Math.fround(tag * 4000 - i * 0.5 + rand());
  }
  return pos;
}

/** Deterministic shuffle driven by the fixture PRNG. */
function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const tripleKey = (x: number, y: number, z: number): string => `${x}|${y}|${z}`;

/** The set of coordinate triples a buffer holds, after its placement offset. */
function placedTriples(
  buffers: ReadonlyArray<TerrainStreamBuffer>,
  into = new Set<string>(),
): Set<string> {
  for (const { pos, placement } of buffers) {
    const d = placement?.sourceToProject ?? [0, 0, 0];
    for (let i = 0; i < pos.length; i += 3) {
      // Math.fround mirrors the float32 rounding the write into the output
      // Float32Array performs, so the comparison stays exact.
      into.add(
        tripleKey(
          Math.fround(pos[i] + d[0]),
          Math.fround(pos[i + 1] + d[1]),
          Math.fround(pos[i + 2] + d[2]),
        ),
      );
    }
  }
  return into;
}

/**
 * RELATION 1. Every output triple must be a member of `allowed`. Returns the
 * offending triples, so a failure names the invented coordinate. Used both to
 * assert the relation and, in the negative control, to show it can reject.
 */
function inventedTriples(out: Float32Array, allowed: ReadonlySet<string>): string[] {
  const bad: string[] = [];
  for (let i = 0; i < out.length; i += 3) {
    const k = tripleKey(out[i], out[i + 1], out[i + 2]);
    if (!allowed.has(k)) bad.push(k);
  }
  return bad;
}

/** Record indices that are not integers inside [0, count). */
function inventedIndices(indices: readonly number[], count: number): number[] {
  return indices.filter((i) => !Number.isInteger(i) || i < 0 || i >= count);
}

/** The next representable float32 above a positive value. */
function nextFloat32Up(v: number): number {
  const f = new Float32Array(1);
  const u = new Uint32Array(f.buffer);
  f[0] = v;
  u[0] += 1;
  return f[0];
}

const IDENTITY_PLACEMENT: LayerSpatialTransform = {
  sourceOrigin: [0, 0, 0],
  sourceToProject: [0, 0, 0],
  projectToSource: [0, 0, 0],
};

const SHIFTED_PLACEMENT: LayerSpatialTransform = {
  sourceOrigin: [1.5, -2.25, 0.125],
  sourceToProject: [1.5, -2.25, 0.125],
  projectToSource: [-1.5, 2.25, -0.125],
};

/**
 * The standard multi-buffer scene: 7 static points across two clouds, 9
 * streaming points across three keyed nodes, 16 total.
 */
function scene(): {
  staticBuffers: TerrainStreamBuffer[];
  streamingBuffers: KeyedTerrainStreamBuffer[];
  total: number;
} {
  const rand = fixturePrng(FIXTURE_SEED);
  const staticBuffers: TerrainStreamBuffer[] = [
    { pos: makeCloud(4, 1, rand) },
    { pos: makeCloud(3, 2, rand) },
  ];
  const streamingBuffers: KeyedTerrainStreamBuffer[] = [
    { key: '1-0-0-0', pos: makeCloud(3, 3, rand) },
    { key: '1-0-0-1', pos: makeCloud(2, 4, rand) },
    { key: '2-1-1-1', pos: makeCloud(4, 5, rand) },
  ];
  return { staticBuffers, streamingBuffers, total: 16 };
}

// ===========================================================================
// RELATION 1: no invented coordinates
// ===========================================================================

describe('relation 1: no invented coordinates', () => {
  test('stratifiedSampleIndices returns only record indices that exist', () => {
    for (const count of [1, 2, 7, 10, 64, 1000]) {
      for (const step of [1, 2, 3, 7, 64, 5000]) {
        const indices = stratifiedSampleIndices(count, step);
        // Non-vacuity: an empty result would satisfy the relation trivially.
        expect(indices.length).toBeGreaterThan(0);
        expect(inventedIndices(indices, count)).toEqual([]);
      }
    }
  });

  test('sampleStridedTerrain output triples all exist in the input (identity placement)', () => {
    const { staticBuffers, streamingBuffers, total } = scene();
    const allowed = placedTriples([...staticBuffers, ...streamingBuffers]);
    for (const maxPoints of [1, 2, 3, 5, 8, 16, 64]) {
      const result = sampleStridedTerrain(
        staticBuffers,
        streamingBuffers,
        total,
        maxPoints,
        false,
      );
      expect(result).not.toBeNull();
      expect(result!.positions.length).toBeGreaterThan(0);
      expect(inventedTriples(result!.positions, allowed)).toEqual([]);
    }
    // The allowed set is a strict subset of the coordinate space, not a
    // catch-all: it holds exactly the 16 input triples.
    expect(allowed.size).toBe(16);
  });

  test('a placed buffer emits input triples translated by that buffer offset, exactly', () => {
    // The placement fold is a per-buffer constant translation, so exact
    // membership still applies against the translated input set. No averaging
    // happens anywhere in this path, so the weaker hull relation is not needed.
    const { staticBuffers, streamingBuffers, total } = scene();
    const placedStatic = staticBuffers.map((b, i) => ({
      ...b,
      placement: i === 0 ? SHIFTED_PLACEMENT : IDENTITY_PLACEMENT,
    }));
    const placedStreaming = streamingBuffers.map((b) => ({
      ...b,
      placement: SHIFTED_PLACEMENT,
    }));
    const allowed = placedTriples([...placedStatic, ...placedStreaming]);
    const result = sampleStridedTerrain(placedStatic, placedStreaming, total, 5, false);
    expect(result).not.toBeNull();
    expect(result!.positions.length / 3).toBe(4);
    expect(inventedTriples(result!.positions, allowed)).toEqual([]);
    // The shift is real, so the unshifted triples must NOT be accepted.
    const unshifted = placedTriples([...staticBuffers, ...streamingBuffers]);
    expect(inventedTriples(result!.positions, unshifted).length).toBeGreaterThan(0);
  });

  test('every output point also lies inside the axis-aligned bounds of the input', () => {
    // The weaker containment relation, asserted alongside exact membership.
    // A voxel-centroid sampler could only satisfy this one; a selection
    // sampler satisfies both.
    const { staticBuffers, streamingBuffers, total } = scene();
    const all = [...staticBuffers, ...streamingBuffers];
    const lo = [Infinity, Infinity, Infinity];
    const hi = [-Infinity, -Infinity, -Infinity];
    for (const { pos } of all) {
      for (let i = 0; i < pos.length; i += 3) {
        for (let a = 0; a < 3; a++) {
          lo[a] = Math.min(lo[a], pos[i + a]);
          hi[a] = Math.max(hi[a], pos[i + a]);
        }
      }
    }
    const result = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 4, false);
    const p = result!.positions;
    for (let i = 0; i < p.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        expect(p[i + a]).toBeGreaterThanOrEqual(lo[a]);
        expect(p[i + a]).toBeLessThanOrEqual(hi[a]);
      }
    }
  });

  test('the output never aliases an input buffer', () => {
    // Viewer.ts mutates the returned positions in place (yUpToCanonicalZUp),
    // so a shared buffer would rewrite the source cloud.
    const { staticBuffers, streamingBuffers, total } = scene();
    const before = Float32Array.from(staticBuffers[0].pos);
    const result = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 16, false);
    expect(result!.positions.buffer).not.toBe(staticBuffers[0].pos.buffer);
    result!.positions.fill(-999);
    expect(Array.from(staticBuffers[0].pos)).toEqual(Array.from(before));
  });
});

// ===========================================================================
// RELATION 2: determinism
// ===========================================================================

describe('relation 2: determinism', () => {
  test('stratifiedSampleIndices repeats its full index sequence', () => {
    for (const [count, step] of [
      [10, 3],
      [1000, 7],
      [64, 64],
      [5, 6],
    ] as Array<[number, number]>) {
      const a = stratifiedSampleIndices(count, step);
      const b = stratifiedSampleIndices(count, step);
      const c = stratifiedSampleIndices(count, step);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
    }
  });

  test('the decoder loop reproduces the reference index set point for point', () => {
    // loadLas.ts:86-89 and lazDecode.ts:137-153 both drive makePrng +
    // pickInBucket per bucket in ascending order rather than materialising
    // stratifiedSampleIndices. The two must agree or a decoded cloud differs
    // from the reference definition.
    for (const [count, step] of [
      [10, 3],
      [997, 13],
      [64, 8],
    ] as Array<[number, number]>) {
      const s = Math.max(1, Math.floor(step));
      const total = Math.ceil(count / s);
      const rand = makePrng(STRIDE_SAMPLE_SEED);
      const onTheFly: number[] = [];
      for (let b = 0; b < total; b++) onTheFly.push(pickInBucket(b, s, count, rand));
      expect(onTheFly).toEqual(stratifiedSampleIndices(count, step));
    }
  });

  test('sampleStridedTerrain repeats its full output sequence', () => {
    const { staticBuffers, streamingBuffers, total } = scene();
    const cls = () => Uint8Array.from({ length: 4 }, (_, i) => (i % 3) + 1);
    const withCls = staticBuffers.map((b) => ({ ...b, cls: cls() }));
    const a = sampleStridedTerrain(withCls, streamingBuffers, total, 5, true)!;
    const b = sampleStridedTerrain(withCls, streamingBuffers, total, 5, true)!;
    expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
    expect(Array.from(b.classification!)).toEqual(Array.from(a.classification!));
    expect(b.sampled).toBe(a.sampled);
  });

  test('streaming arrival order does not change the output', () => {
    // The reason the module exists: the resident Map is in network order.
    const { staticBuffers, streamingBuffers, total } = scene();
    const rand = fixturePrng(0x1357);
    const base = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 5, false)!;
    for (let attempt = 0; attempt < 8; attempt++) {
      const permuted = shuffled(streamingBuffers, rand);
      const got = sampleStridedTerrain(staticBuffers, permuted, total, 5, false)!;
      expect(Array.from(got.positions)).toEqual(Array.from(base.positions));
    }
  });
});

// ===========================================================================
// RELATION 3: subset and count contract
// ===========================================================================

describe('relation 3: count contract, boundary cases pinned', () => {
  test('stride count is ceil(count / max(1, floor(step)))', () => {
    for (const count of [1, 2, 7, 10, 64, 999]) {
      for (const step of [1, 2, 3, 7, 64]) {
        expect(stratifiedSampleIndices(count, step)).toHaveLength(Math.ceil(count / step));
      }
    }
  });

  test('empty and single-point inputs', () => {
    expect(stratifiedSampleIndices(0, 4)).toEqual([]);
    expect(stratifiedSampleIndices(0, 1)).toEqual([]);
    // A negative count is treated as empty rather than throwing.
    expect(stratifiedSampleIndices(-5, 4)).toEqual([]);
    expect(stratifiedSampleIndices(1, 1)).toEqual([0]);
    expect(stratifiedSampleIndices(1, 4)).toEqual([0]);
    expect(stratifiedSampleIndices(1, 10000)).toEqual([0]);
  });

  test('a step larger than the point count keeps exactly one record', () => {
    // One bucket, and the jitter spans the records it holds, so the single
    // kept record can be any of them rather than settling on count - 1.
    for (const count of [1, 2, 5, 10, 50]) {
      const r = stratifiedSampleIndices(count, count * 10);
      expect(r).toHaveLength(1);
      expect(inventedIndices(r, count)).toEqual([]);
    }
    // Across seeds the one record ranges over the whole file, which a draw
    // clamped to the end would not do.
    const seen = new Set<number>();
    for (let seed = 1; seed <= 200; seed++) seen.add(stratifiedSampleIndices(10, 100, seed)[0]);
    expect(seen.size).toBeGreaterThan(5);
    expect(Math.min(...seen)).toBeLessThan(5);
  });

  test('step 0, a negative step and a fractional step all floor into a valid step', () => {
    const identity = [...Array(10).keys()];
    expect(stratifiedSampleIndices(10, 0)).toEqual(identity);
    expect(stratifiedSampleIndices(10, -3)).toEqual(identity);
    expect(stratifiedSampleIndices(10, 0.5)).toEqual(identity);
    // 2.7 floors to 2, not rounds to 3.
    expect(stratifiedSampleIndices(10, 2.7)).toEqual(stratifiedSampleIndices(10, 2));
    expect(stratifiedSampleIndices(3, 2.7)).toEqual([0, 2]);
  });

  test('index b lands inside bucket b, and the sequence is strictly increasing', () => {
    // Strict monotonicity is load-bearing: lazDecode.ts:147 makes ONE forward
    // pass over the records and advances the bucket only on `i === chosen`, so
    // a non-increasing pick would leave an output slot never written.
    for (const [count, step] of [
      [10, 3],
      [997, 13],
      [64, 8],
      [11, 3],
      [1, 5],
    ] as Array<[number, number]>) {
      const s = Math.max(1, Math.floor(step));
      const indices = stratifiedSampleIndices(count, step);
      for (let b = 0; b < indices.length; b++) {
        expect(indices[b]).toBeGreaterThanOrEqual(b * s);
        expect(indices[b]).toBeLessThanOrEqual(Math.min(count - 1, b * s + s - 1));
        if (b > 0) expect(indices[b]).toBeGreaterThan(indices[b - 1]);
      }
      expect(new Set(indices).size).toBe(indices.length);
    }
  });

  test('a partial final bucket draws uniformly over the records it holds', () => {
    // count=11 step=3 leaves a final bucket of 2 records, so each carries 1/2.
    // Drawing the offset across `step` instead would clamp both overshoots onto
    // record 10 and give it (3 - 2 + 1) / 3 = 2/3; measured at 0.6664 before
    // the draw was narrowed to the bucket size, and 0.5000 after.
    const count = 11;
    const step = 3;
    const seedRand = fixturePrng(0x2468);
    let last = 0;
    const trials = 20000;
    for (let t = 0; t < trials; t++) {
      const seed = Math.floor(seedRand() * 0xffffffff) >>> 0;
      const indices = stratifiedSampleIndices(count, step, seed);
      if (indices[indices.length - 1] === count - 1) last++;
    }
    // Three standard errors at n=20000 is about 0.011, so this band separates
    // the uniform rate from the 2/3 a clamped draw produces.
    expect(last / trials).toBeGreaterThan(0.485);
    expect(last / trials).toBeLessThan(0.515);
  });

  test('every record in a full bucket is equally likely', () => {
    // The bias above was confined to the short bucket. This pins the full ones.
    const counts = new Map<number, number>();
    const trials = 30000;
    const seedRand = fixturePrng(0x1357);
    for (let t = 0; t < trials; t++) {
      const seed = Math.floor(seedRand() * 0xffffffff) >>> 0;
      const first = stratifiedSampleIndices(12, 4, seed)[0];
      counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    expect([...counts.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3]);
    for (const n of counts.values()) expect(n / trials).toBeGreaterThan(0.235);
    for (const n of counts.values()) expect(n / trials).toBeLessThan(0.265);
  });

  test('terrain sample count is ceil(total / max(1, ceil(total / maxPoints)))', () => {
    const { staticBuffers, streamingBuffers, total } = scene();
    for (const maxPoints of [1, 2, 3, 4, 5, 8, 16, 64]) {
      const stride = Math.max(1, Math.ceil(total / maxPoints));
      const cap = Math.ceil(total / stride);
      const r = sampleStridedTerrain(staticBuffers, streamingBuffers, total, maxPoints, false)!;
      expect(r.positions.length / 3).toBe(cap);
      expect(r.sampled).toBe(stride > 1);
    }
  });

  test('terrain sample refuses an unusable total or budget', () => {
    const { staticBuffers, streamingBuffers } = scene();
    for (const total of [0, -1, NaN, Infinity]) {
      expect(sampleStridedTerrain(staticBuffers, streamingBuffers, total, 8, false)).toBeNull();
    }
    for (const maxPoints of [0, -1, 0.5, NaN, Infinity]) {
      expect(sampleStridedTerrain(staticBuffers, streamingBuffers, 16, maxPoints, false)).toBeNull();
    }
    // A positive total with no buffers, and a zero-length buffer, both yield
    // no finite point and return null rather than an empty sample.
    expect(sampleStridedTerrain([], [], 5, 8, false)).toBeNull();
    expect(sampleStridedTerrain([{ pos: new Float32Array(0) }], [], 5, 8, false)).toBeNull();
  });

  test('a single point survives whole', () => {
    const rand = fixturePrng(FIXTURE_SEED);
    const pos = makeCloud(1, 9, rand);
    const r = sampleStridedTerrain([{ pos }], [], 1, 300000, false)!;
    expect(Array.from(r.positions)).toEqual(Array.from(pos));
    expect(r.sampled).toBe(false);
  });

  test('a totalPoints that disagrees with the buffers truncates or thins', () => {
    // totalPoints is the caller's declared count. Under-reporting stops the
    // walk at cap and silently drops the tail; over-reporting coarsens the
    // stride and returns fewer points than the budget allows.
    const rand = fixturePrng(FIXTURE_SEED);
    const pos = makeCloud(10, 7, rand);
    const under = sampleStridedTerrain([{ pos }], [], 5, 10, false)!;
    expect(under.positions.length / 3).toBe(5);
    expect(Array.from(under.positions)).toEqual(Array.from(pos.subarray(0, 15)));
    expect(under.sampled).toBe(false);

    const over = sampleStridedTerrain([{ pos: makeCloud(5, 8, rand) }], [], 20, 10, false)!;
    expect(over.positions.length / 3).toBe(3);
    expect(over.sampled).toBe(true);
  });

  test('non-finite points are dropped without backfilling and without shifting the stride', () => {
    const rand = fixturePrng(FIXTURE_SEED);
    const pos = makeCloud(6, 6, rand);
    pos[3 * 3] = NaN;
    const r = sampleStridedTerrain([{ pos }], [], 6, 6, false)!;
    expect(r.positions.length / 3).toBe(5);
    const kept = [0, 1, 2, 4, 5].flatMap((i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]]);
    expect(Array.from(r.positions)).toEqual(kept);
  });
});

// ===========================================================================
// RELATION 4: idempotence and composition
// ===========================================================================

describe('relation 4: idempotence and composition', () => {
  test('step 1 is the identity selection', () => {
    for (const count of [1, 2, 10, 500]) {
      expect(stratifiedSampleIndices(count, 1)).toEqual([...Array(count).keys()]);
    }
  });

  test('re-sampling an already-sampled index list with step 1 returns it unchanged', () => {
    const once = stratifiedSampleIndices(60, 4);
    const again = stratifiedSampleIndices(once.length, 1).map((i) => once[i]);
    expect(again).toEqual(once);
  });

  test('terrain: a budget at or above the total returns the input coordinates unchanged', () => {
    const { staticBuffers, streamingBuffers, total } = scene();
    const expected = [...staticBuffers, ...streamingBuffers].flatMap(({ pos }) =>
      Array.from(pos),
    );
    for (const maxPoints of [16, 17, 300000]) {
      const r = sampleStridedTerrain(staticBuffers, streamingBuffers, total, maxPoints, false)!;
      expect(Array.from(r.positions)).toEqual(expected);
      expect(r.sampled).toBe(false);
    }
    // Feeding the stride-1 result back through is a fixed point.
    const once = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 16, false)!;
    const twice = sampleStridedTerrain([{ pos: once.positions }], [], total, 16, false)!;
    expect(Array.from(twice.positions)).toEqual(Array.from(once.positions));
  });

  test('terrain strides compose exactly when the budgets divide', () => {
    // Plain arithmetic decimation, so stride 2 then stride 2 selects the same
    // points as stride 4 in one pass.
    const { staticBuffers, streamingBuffers, total } = scene();
    const half = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 8, false)!;
    const composed = sampleStridedTerrain(
      [{ pos: half.positions }],
      [],
      half.positions.length / 3,
      4,
      false,
    )!;
    const direct = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 4, false)!;
    expect(Array.from(composed.positions)).toEqual(Array.from(direct.positions));
  });

  test('stride composition is NOT identical to one coarser stride, but stays stratified', () => {
    // Pinned actual behaviour. The jitter draws a fresh PRNG sequence per
    // call, so composing step 2 with step 3 selects different records than
    // step 6 in one pass. What survives composition is the stratification:
    // exactly one record per 6-record bucket.
    const first = stratifiedSampleIndices(60, 2);
    const composed = stratifiedSampleIndices(first.length, 3).map((i) => first[i]);
    const direct = stratifiedSampleIndices(60, 6);
    expect(composed).toHaveLength(direct.length);
    expect(composed).not.toEqual(direct);
    for (let b = 0; b < composed.length; b++) {
      expect(Math.floor(composed[b] / 6)).toBe(b);
      expect(Math.floor(direct[b] / 6)).toBe(b);
    }
  });

  test('appending records does not change which earlier records are kept', () => {
    // Every bucket fully contained in the shorter input picks the same record,
    // because the PRNG is consumed in bucket order and the clamp only reaches
    // the final bucket.
    const step = 10;
    const shortIdx = stratifiedSampleIndices(100, step);
    const longIdx = stratifiedSampleIndices(230, step);
    const fullBuckets = Math.floor(100 / step);
    expect(longIdx.slice(0, fullBuckets)).toEqual(shortIdx.slice(0, fullBuckets));
  });

  test('a different seed selects a different set', () => {
    const a = stratifiedSampleIndices(20, 4);
    const b = stratifiedSampleIndices(20, 4, 1);
    expect(a).toHaveLength(b.length);
    expect(a).not.toEqual(b);
  });
});

// ===========================================================================
// RELATION 5: negative control
// ===========================================================================

describe('relation 5: negative control', () => {
  test('inventedTriples rejects a coordinate outside the input', () => {
    const { staticBuffers, streamingBuffers, total } = scene();
    const allowed = placedTriples([...staticBuffers, ...streamingBuffers]);
    const real = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 5, false)!;
    expect(inventedTriples(real.positions, allowed)).toEqual([]);

    // Same output with one point moved far outside the cloud.
    const forged = Float32Array.from(real.positions);
    forged[3] = 12345.5;
    forged[4] = -6789.25;
    forged[5] = 0.5;
    const bad = inventedTriples(forged, allowed);
    expect(bad).toEqual(['12345.5|-6789.25|0.5']);
  });

  test('inventedTriples rejects a one-ULP perturbation of a real coordinate', () => {
    // A centroid-averaging sampler would land here rather than on the exact
    // input value, so the relation is sensitive enough to tell the two kinds
    // of sampler apart.
    const { staticBuffers, streamingBuffers, total } = scene();
    const allowed = placedTriples([...staticBuffers, ...streamingBuffers]);
    const real = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 5, false)!;
    const forged = Float32Array.from(real.positions);
    expect(forged[0]).toBeGreaterThan(0);
    const nudged = nextFloat32Up(forged[0]);
    expect(nudged).not.toBe(forged[0]);
    forged[0] = nudged;
    expect(inventedTriples(forged, allowed)).toHaveLength(1);
  });

  test('an averaged output is rejected, confirming the relation detects synthesis', () => {
    // Build what a voxel-centroid sampler would emit from the same input and
    // confirm the exact-membership relation refuses it.
    const { staticBuffers, streamingBuffers, total } = scene();
    const allowed = placedTriples([...staticBuffers, ...streamingBuffers]);
    const pos = staticBuffers[0].pos;
    const centroid = new Float32Array(3);
    const n = pos.length / 3;
    for (let i = 0; i < n; i++) {
      centroid[0] += pos[i * 3] / n;
      centroid[1] += pos[i * 3 + 1] / n;
      centroid[2] += pos[i * 3 + 2] / n;
    }
    expect(inventedTriples(centroid, allowed)).toHaveLength(1);
    // The centroid still satisfies the weaker bounding-box relation, which is
    // why the exact form is the one asserted for these samplers.
    const real = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 5, false)!;
    expect(inventedTriples(real.positions, allowed)).toEqual([]);
  });

  test('inventedIndices rejects an out-of-range record index', () => {
    const indices = stratifiedSampleIndices(10, 3);
    expect(inventedIndices(indices, 10)).toEqual([]);
    expect(inventedIndices([...indices, 10], 10)).toEqual([10]);
    expect(inventedIndices([...indices, -1], 10)).toEqual([-1]);
    expect(inventedIndices([...indices, 4.5], 10)).toEqual([4.5]);
  });

  test('the determinism comparison rejects a single changed element', () => {
    const a = stratifiedSampleIndices(60, 4);
    const mutated = [...a];
    mutated[3] = mutated[3] + 1;
    expect(mutated).not.toEqual(a);
    const { staticBuffers, streamingBuffers, total } = scene();
    const base = sampleStridedTerrain(staticBuffers, streamingBuffers, total, 5, false)!;
    const drifted = Float32Array.from(base.positions);
    drifted[7] = drifted[7] + 1;
    expect(Array.from(drifted)).not.toEqual(Array.from(base.positions));
  });
});
