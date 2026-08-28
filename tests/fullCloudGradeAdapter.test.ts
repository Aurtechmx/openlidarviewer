/**
 * fullCloudGradeAdapter.test.ts
 *
 * The live wiring between a streaming source and the {@link runFullCloudGrade}
 * seam. The decode worker + real COPC range reads are browser-bound (an e2e
 * exercises them against a live endpoint), so here we pin the deterministic
 * adapter logic with light fakes:
 *   - octree → SampleNode[] projection maps the four planner fields,
 *   - the decode fn routes id → store record → chunk → decoder → positions,
 *   - a missing id degrades to empty (not a throw),
 *   - the abort signal is threaded to both the range read and the decode,
 *   - the adapter composes with the real runner to produce an honest grade.
 */

import { describe, it, expect } from 'vitest';
import {
  sampleNodesFromSource,
  makeDecodeNode,
  gradeFullCloud,
  type FullCloudGradeOutcome,
  type GradeNodeSource,
} from '../src/render/streaming/fullCloudGradeAdapter';
import {
  runFullCloudGrade,
  FullCloudGradeShortDecodeError,
} from '../src/render/streaming/fullCloudGradeRunner';
import { MAX_SAMPLE_POINTS } from '../src/render/streaming/fullCloudGrade';
import { createStreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import type { ChunkDecodeMetadata, ChunkDecoder, DecodedChunk } from '../src/io/copc/copcChunkDecode';

/** A minimal-but-valid node record; only id/depth/pointCount/byteSize matter here. */
function record(id: string, depth: number, pointCount: number, byteSize: number): StreamingNodeRecord {
  return {
    id,
    key: { depth, x: 0, y: 0, z: 0 },
    depth,
    bounds: [0, 0, 0, 1, 1, 1],
    pointCount,
    byteOffset: 0,
    byteSize,
    spacing: 1,
  };
}

function nodeList(): StreamingNode[] {
  return [
    createStreamingNode(record('0-0-0-0', 0, 100, 1000)),
    createStreamingNode(record('1-0-0-0', 1, 200, 2000)),
    createStreamingNode(record('1-1-0-0', 1, 300, 3000)),
  ];
}

/** A fake source: nodes() + store.get over a Map; readNodeChunk encodes the id's
 *  marker AND the record's exact point count into a 2-float buffer so the fake
 *  decoder can emit exactly that many points (COPC/EPT counts are exact, and the
 *  runner now enforces decoded === declared); decodeMeta is a stub the decoder
 *  ignores. */
function fakeSource(
  nodes: StreamingNode[],
  markers: Record<string, number>,
  hooks: { onRead?: (id: string, signal?: AbortSignal) => void } = {},
  // Completeness of the source octree. Defaults to a WHOLE hierarchy so the
  // existing exhaustive/sampled tests are unaffected; the truncation test sets
  // it false to prove the grade never claims exact over a short hierarchy.
  completeness: { isComplete?: boolean; errors?: readonly string[] } = {},
  // What the SOURCE states as its point total. Defaults to the sum of the node
  // records, which is what a COPC/EPT header states and what those formats'
  // per-node counts add up to. `null` is the 3D Tiles case: the format states
  // no total and the per-node counts are decode-admission estimates.
  sourcePointCount: number | null = nodes.reduce((s, n) => s + n.record.pointCount, 0),
): GradeNodeSource {
  const byId = new Map(nodes.map((n) => [n.record.id, n]));
  // Reverse-lookup a record's id from the marker we'll stash, so readNodeChunk
  // can encode it. (We key the marker by id directly.)
  return {
    sourcePointCount,
    octree: {
      nodes: () => nodes,
      store: { get: (id: string) => byId.get(id) },
      isComplete: completeness.isComplete ?? true,
      errors: completeness.errors ?? [],
    },
    readNodeChunk: async (rec: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> => {
      hooks.onRead?.(rec.id, signal);
      return Float32Array.of(markers[rec.id] ?? -1, rec.pointCount).buffer;
    },
    decodeMeta: (): ChunkDecodeMetadata =>
      ({ renderOrigin: [0, 0, 0] } as unknown as ChunkDecodeMetadata),
  };
}

/** A fake decoder: reads [marker, count] the fake source wrote, emits exactly
 *  `count` points all set to the marker — so decoded === declared, the honest
 *  case the runner requires. */
function fakeDecoder(seen?: { signals: (AbortSignal | undefined)[] }): ChunkDecoder {
  return {
    decode: async (
      chunk: ArrayBuffer,
      _meta: ChunkDecodeMetadata,
      signal?: AbortSignal,
    ): Promise<DecodedChunk> => {
      seen?.signals.push(signal);
      const header = new Float32Array(chunk);
      const m = header[0];
      const count = header[1];
      const positions = new Float32Array(count * 3);
      positions.fill(m);
      return {
        pointCount: count,
        positions,
        intensity: new Uint16Array(count),
        classification: new Uint8Array(count),
        returnNumber: new Uint8Array(count),
        returnCount: new Uint8Array(count),
        gpsTime: new Float64Array(count),
      };
    },
  };
}

// Compile-time contract: a real streaming source (COPC's StreamingPointCloud,
// EPT's, the tileset's) satisfies GradeNodeSource without a cast. The gate the
// adapter applies reads `sourcePointCount` straight off it, so narrowing that
// member out of the source interface has to break here rather than at runtime.
const _sourceSatisfiesAdapter: (s: StreamingSource) => GradeNodeSource = (s) => s;
void _sourceSatisfiesAdapter;

/** Unwrap a graded outcome, failing the test if the grade was refused. */
async function graded<G>(outcome: Promise<FullCloudGradeOutcome<G>>) {
  const settled = await outcome;
  expect(settled.kind).toBe('graded');
  if (settled.kind !== 'graded') throw new Error('expected a graded outcome');
  return settled.run;
}

describe('sampleNodesFromSource — octree → SampleNode[]', () => {
  it('projects id, depth, pointCount, byteSize from each record', () => {
    const out = sampleNodesFromSource(fakeSource(nodeList(), {}));
    expect(out).toEqual([
      { id: '0-0-0-0', depth: 0, pointCount: 100, byteSize: 1000 },
      { id: '1-0-0-0', depth: 1, pointCount: 200, byteSize: 2000 },
      { id: '1-1-0-0', depth: 1, pointCount: 300, byteSize: 3000 },
    ]);
  });

  it('returns an empty list for an empty octree', () => {
    expect(sampleNodesFromSource(fakeSource([], {}))).toEqual([]);
  });
});

describe('makeDecodeNode — id → decoded positions', () => {
  it('routes a node id through read + decode to its positions', async () => {
    const src = fakeSource(nodeList(), { '1-0-0-0': 42 });
    const decode = makeDecodeNode(src, fakeDecoder());
    const pos = await decode('1-0-0-0');
    // Node '1-0-0-0' declares 200 points → 600 floats, all the marker value.
    expect(pos).toHaveLength(200 * 3);
    expect(Array.from(pos).every((v) => v === 42)).toBe(true);
  });

  it('yields an empty buffer for an id absent from the store (no throw)', async () => {
    const src = fakeSource(nodeList(), {});
    const decode = makeDecodeNode(src, fakeDecoder());
    const pos = await decode('9-9-9-9');
    expect(pos).toHaveLength(0);
  });

  it('throws if a decoder returns a non-triple-length positions array', async () => {
    const src = fakeSource(nodeList(), { '0-0-0-0': 7 });
    // A broken decoder: 2 floats, not a multiple of 3 — would skew the runner's
    // point accounting if it slipped through.
    const brokenDecoder: ChunkDecoder = {
      decode: async (): Promise<DecodedChunk> => ({
        pointCount: 0,
        positions: new Float32Array([1, 2]),
        intensity: new Uint16Array(0),
        classification: new Uint8Array(0),
        returnNumber: new Uint8Array(0),
        returnCount: new Uint8Array(0),
        gpsTime: new Float64Array(0),
      }),
    };
    const decode = makeDecodeNode(src, brokenDecoder);
    await expect(decode('0-0-0-0')).rejects.toThrow(/multiple of 3/);
  });

  it('threads the abort signal to both the range read and the decode', async () => {
    const controller = new AbortController();
    const reads: { signal?: AbortSignal }[] = [];
    const seen = { signals: [] as (AbortSignal | undefined)[] };
    const src = fakeSource(nodeList(), { '0-0-0-0': 7 }, {
      onRead: (_id, signal) => reads.push({ signal }),
    });
    const decode = makeDecodeNode(src, fakeDecoder(seen));
    await decode('0-0-0-0', controller.signal);
    expect(reads[0].signal).toBe(controller.signal);
    expect(seen.signals[0]).toBe(controller.signal);
  });
});

describe('adapter ∘ runner — end-to-end with fakes', () => {
  it('grades the whole cloud exhaustively when the budget covers it', async () => {
    const nodes = nodeList();
    const src = fakeSource(nodes, { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    const out = await runFullCloudGrade({
      nodes: sampleNodesFromSource(src),
      decodeNode: makeDecodeNode(src, fakeDecoder()),
      grade: (pos, scale) => ({ points: pos.length / 3, scale }),
      options: { maxPoints: 10_000 },
    });
    expect(out.coverage.scope).toBe('exhaustive');
    expect(out.coverage.coveragePercent).toBe(100);
    expect(out.grade).toEqual({ points: 600, scale: 1 }); // 100 + 200 + 300 points
  });

  it('grades a representative sample and back-scales when over budget', async () => {
    const nodes = nodeList(); // 100 + 200 + 300 = 600 total points
    const src = fakeSource(nodes, { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    const out = await runFullCloudGrade({
      nodes: sampleNodesFromSource(src),
      decodeNode: makeDecodeNode(src, fakeDecoder()),
      grade: (_pos, scale) => scale,
      options: { maxPoints: 100 }, // only the depth-0 root (100 pts) fits
    });
    expect(out.coverage.scope).toBe('sampled');
    expect(out.coverage.samplePointScale).toBeCloseTo(6, 5); // 600 / 100
    expect(out.coverage.note).toMatch(/representative octree sample/i);
  });
});

describe('gradeFullCloud — one-call composition + progress', () => {
  it('enumerates, decodes, and grades the source in one call', async () => {
    const src = fakeSource(nodeList(), { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    const run = await graded(gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000 },
    }));
    expect(run.coverage.scope).toBe('exhaustive');
    expect(run.grade).toBe(600); // 100 + 200 + 300 points
    expect(run.coverage.label).toMatch(/exact/);
  });

  it('reports monotonic progress, ending at the decoded node + point totals', async () => {
    const src = fakeSource(nodeList(), { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    const seen: { decodedNodes: number; totalNodes: number; decodedPoints: number }[] = [];
    await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: () => null,
      options: { maxPoints: 10_000 },
      onProgress: (p) => seen.push(p),
    });
    expect(seen.map((p) => p.decodedNodes)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.totalNodes === 3)).toBe(true);
    // Plan order is root (depth 0), then depth-1 nodes by count desc: 300 then
    // 200. Cumulative decoded points: 100, +300, +200.
    expect(seen.map((p) => p.decodedPoints)).toEqual([100, 400, 600]);
  });

  it('cancels cleanly when the signal is already aborted', async () => {
    const src = fakeSource(nodeList(), { '0-0-0-0': 1 });
    const controller = new AbortController();
    controller.abort();
    await expect(
      gradeFullCloud({
        source: src,
        decoder: fakeDecoder(),
        grade: () => null,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('never labels an INCOMPLETE octree exact — even when every LOADED node fits the budget', async () => {
    // The defect end-to-end: a hierarchy that dropped a subtree (a swallowed
    // page-fetch failure here) still returns its loaded nodes, so the sampling
    // plan is exhaustive OVER THOSE and the old path printed "all N points
    // (exact)". `octree.nodes()` — not `fullyLoaded` — is what the grade reads,
    // so completeness must ride in separately and downgrade the claim.
    const src = fakeSource(nodeList(), { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 }, {}, {
      isComplete: false,
      errors: ['failed to load hierarchy page at 4096: network down'],
    });
    const run = await graded(gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000 }, // budget covers every loaded node
    }));
    expect(run.coverage.scope).toBe('sampled');
    expect(run.coverage.label).not.toMatch(/exact/);
    expect(run.coverage.label).toMatch(/partial/i);
    // The reason and the (previously write-only) error count reach the user.
    expect(run.coverage.note).toMatch(/did not fully load/i);
    expect(run.coverage.note).toMatch(/1 load error/);
  });
});

describe('gradeFullCloud — oversized first node is refused (BUG 7)', () => {
  it('returns an unavailable outcome (no decode) when the plan exceeds the ceiling', async () => {
    // One node above the point ceiling becomes the whole plan (the planner always
    // takes at least one). The grade must refuse before decoding rather than size
    // a multi-gigabyte positions buffer.
    const huge = [createStreamingNode(record('0-0-0-0', 0, MAX_SAMPLE_POINTS + 1, 10))];
    const reads: string[] = [];
    const src = fakeSource(huge, { '0-0-0-0': 1 }, { onRead: (id) => reads.push(id) });
    const outcome = await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    expect(outcome.headline).toMatch(/safe decode budget/i);
    expect(outcome.note).toMatch(/safe ceiling/i);
    expect(reads).toEqual([]); // nothing was read/decoded
  });

  it('still grades a normally-sized cloud (the ceiling does not block real work)', async () => {
    const src = fakeSource(nodeList(), { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    const outcome = await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000 },
    });
    expect(outcome.kind).toBe('graded');
  });
});

describe('gradeFullCloud — a decoded count that disagrees with the header (BUG 8)', () => {
  it('fails the grade rather than report coverage over a sample it never decoded', async () => {
    // A decoder that always emits a single point, regardless of the header count.
    // Node headers declare 100/200/300, so every node is a short decode.
    const shortDecoder: ChunkDecoder = {
      decode: async (): Promise<DecodedChunk> => ({
        pointCount: 1,
        positions: Float32Array.of(1, 1, 1),
        intensity: new Uint16Array(1),
        classification: new Uint8Array(1),
        returnNumber: new Uint8Array(1),
        returnCount: new Uint8Array(1),
        gpsTime: new Float64Array(1),
      }),
    };
    const src = fakeSource(nodeList(), { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 });
    await expect(
      gradeFullCloud({
        source: src,
        decoder: shortDecoder,
        grade: (pos) => pos.length / 3,
        options: { maxPoints: 10_000 },
      }),
    ).rejects.toBeInstanceOf(FullCloudGradeShortDecodeError);
  });
});

describe('gradeFullCloud — a source that states no point total', () => {
  /**
   * Three tiles, each carrying the SAME flat per-node count. That is exactly
   * what a 3D Tiles index looks like: `tileset.json` states content URIs and no
   * point counts anywhere, so every node record is stamped with one assumed
   * figure that governs decode admission. Summing those is (tiles x assumed),
   * a number with no relationship to the points in the file, and the streaming
   * source says so by returning `null` from `sourcePointCount` rather than
   * adding them up.
   */
  const ASSUMED = 500_000;
  function estimatedNodes(): StreamingNode[] {
    return [
      createStreamingNode(record('0-0-0-0', 0, ASSUMED, 1000)),
      createStreamingNode(record('1-0-0-0', 1, ASSUMED, 1000)),
      createStreamingNode(record('1-1-0-0', 1, ASSUMED, 1000)),
    ];
  }
  const markers = { '0-0-0-0': 1, '1-0-0-0': 2, '1-1-0-0': 3 };

  it('refuses instead of printing a total summed from per-node estimates', async () => {
    const src = fakeSource(estimatedNodes(), markers, {}, {}, null);
    const outcome = await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000_000 },
    });
    expect(outcome.kind).toBe('unavailable');
    if (outcome.kind !== 'unavailable') return;
    // Nothing it hands the panel carries a point figure: not the 1.5M sum, not
    // a coverage percent over it, not the assumed per-tile count.
    const shown = `${outcome.headline} ${outcome.note}`;
    expect(shown).not.toMatch(/\d/);
    expect(outcome.headline).toMatch(/point total/i);
    expect(outcome.note).toMatch(/estimate/i);
  });

  it('does not decode anything for a grade it cannot report', async () => {
    const reads: string[] = [];
    const src = fakeSource(estimatedNodes(), markers, { onRead: (id) => reads.push(id) }, {}, null);
    await gradeFullCloud({ source: src, decoder: fakeDecoder(), grade: () => null });
    expect(reads).toEqual([]);
  });

  it('still grades a source that DOES state a total (not a blanket removal)', async () => {
    // Same octree, same per-node counts. The one difference is that the source
    // states the total, which is what makes those counts measurements.
    const src = fakeSource(estimatedNodes(), markers, {}, {}, 3 * ASSUMED);
    const outcome = await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000_000 },
    });
    expect(outcome.kind).toBe('graded');
    if (outcome.kind !== 'graded') return;
    expect(outcome.run.coverage.scope).toBe('exhaustive');
    expect(outcome.run.coverage.label).toBe('all 1.5M points (exact)');
    expect(outcome.run.grade).toBe(3 * ASSUMED); // every declared point decoded
  });

  it('grades a source that states a total of ZERO (null is not zero)', async () => {
    // An empty source is a real answer, not a missing one, so it grades and
    // says "no points" rather than being refused with the unstated-total note.
    const src = fakeSource([], {}, {}, {}, 0);
    const outcome = await gradeFullCloud({ source: src, decoder: fakeDecoder(), grade: () => null });
    expect(outcome.kind).toBe('graded');
    if (outcome.kind !== 'graded') return;
    expect(outcome.run.coverage.label).toBe('no points available to grade');
  });
});
