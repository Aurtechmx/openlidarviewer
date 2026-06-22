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
  type GradeNodeSource,
} from '../src/render/streaming/fullCloudGradeAdapter';
import { runFullCloudGrade } from '../src/render/streaming/fullCloudGradeRunner';
import { createStreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNode } from '../src/render/streaming/StreamingNode';
import type { StreamingNodeRecord } from '../src/io/copc/copcTypes';
import type { ChunkDecodeMetadata, ChunkDecoder, DecodedChunk } from '../src/io/copc/copcChunkDecode';

/** A minimal-but-valid node record; only id/depth/pointCount/byteSize matter here. */
function record(id: string, depth: number, pointCount: number, byteSize: number): StreamingNodeRecord {
  return {
    id,
    key: { depth, x: 0, y: 0, z: 0 },
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
 *  marker into a 1-float buffer; decodeMeta is a stub the fake decoder ignores. */
function fakeSource(
  nodes: StreamingNode[],
  markers: Record<string, number>,
  hooks: { onRead?: (id: string, signal?: AbortSignal) => void } = {},
): GradeNodeSource {
  const byId = new Map(nodes.map((n) => [n.record.id, n]));
  // Reverse-lookup a record's id from the marker we'll stash, so readNodeChunk
  // can encode it. (We key the marker by id directly.)
  return {
    octree: {
      nodes: () => nodes,
      store: { get: (id: string) => byId.get(id) },
    },
    readNodeChunk: async (rec: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> => {
      hooks.onRead?.(rec.id, signal);
      return Float32Array.of(markers[rec.id] ?? -1).buffer;
    },
    decodeMeta: (): ChunkDecodeMetadata =>
      ({ renderOrigin: [0, 0, 0] } as unknown as ChunkDecodeMetadata),
  };
}

/** A fake decoder: reads the marker the fake source wrote, emits 1 point (m,m,m). */
function fakeDecoder(seen?: { signals: (AbortSignal | undefined)[] }): ChunkDecoder {
  return {
    decode: async (
      chunk: ArrayBuffer,
      _meta: ChunkDecodeMetadata,
      signal?: AbortSignal,
    ): Promise<DecodedChunk> => {
      seen?.signals.push(signal);
      const m = new Float32Array(chunk)[0];
      return {
        pointCount: 1,
        positions: Float32Array.of(m, m, m),
        intensity: new Uint16Array(1),
        classification: new Uint8Array(1),
        returnNumber: new Uint8Array(1),
        returnCount: new Uint8Array(1),
        gpsTime: new Float64Array(1),
      };
    },
  };
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
    expect(Array.from(pos)).toEqual([42, 42, 42]);
  });

  it('yields an empty buffer for an id absent from the store (no throw)', async () => {
    const src = fakeSource(nodeList(), {});
    const decode = makeDecodeNode(src, fakeDecoder());
    const pos = await decode('9-9-9-9');
    expect(pos.length).toBe(0);
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
    expect(out.grade).toEqual({ points: 3, scale: 1 }); // one marker point per node
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
    const run = await gradeFullCloud({
      source: src,
      decoder: fakeDecoder(),
      grade: (pos) => pos.length / 3,
      options: { maxPoints: 10_000 },
    });
    expect(run.coverage.scope).toBe('exhaustive');
    expect(run.grade).toBe(3); // 3 nodes → 3 marker points
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
    expect(seen.map((p) => p.decodedPoints)).toEqual([1, 2, 3]); // one marker pt per node
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
});
