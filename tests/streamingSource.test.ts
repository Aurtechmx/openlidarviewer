/**
 * streamingSource.test.ts — v0.3.2 streaming-source contract tests.
 *
 * Proves the `StreamingSource` interface is satisfiable by something other
 * than the existing COPC implementation, so v0.3.3 can drop in an EPT
 * source without touching the scheduler. The test exercises only the type
 * contract — it builds a hand-rolled stub that fulfils every member, then
 * verifies the scheduler's constructor accepts it.
 */

import { test, expect } from 'vitest';
import type { StreamingSource } from '../src/render/streaming/StreamingSource';
import {
  StreamingPointCloud,
} from '../src/render/streaming/StreamingPointCloud';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import type {
  ChunkDecoder,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

const fakeDecoder: ChunkDecoder = {
  decode: (_chunk, meta): Promise<DecodedChunk> =>
    Promise.resolve({
      pointCount: meta.pointCount,
      positions: new Float32Array(meta.pointCount * 3),
      intensity: new Uint16Array(meta.pointCount),
      classification: new Uint8Array(meta.pointCount),
      returnNumber: new Uint8Array(meta.pointCount),
      returnCount: new Uint8Array(meta.pointCount),
      gpsTime: new Float64Array(meta.pointCount),
    }),
};

test('the COPC implementation conforms to the StreamingSource interface', async () => {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }],
  });
  const cloud: StreamingSource = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'iface.copc.laz',
  );

  // The interface members are all reachable through the StreamingSource type.
  expect(cloud.kind).toBe('copc');
  expect(typeof cloud.name).toBe('string');
  expect(cloud.renderOrigin).toHaveLength(3);
  expect(cloud.sourcePointCount).toBeGreaterThan(0);
  expect(cloud.counts().known).toBeGreaterThan(0);
  expect(typeof cloud.maxDepth()).toBe('number');
  expect(cloud.localBounds()).toHaveLength(6);
  // The new methods that the scheduler depends on for format-agnosticism:
  expect(typeof cloud.readNodeChunk).toBe('function');
  expect(typeof cloud.decodeMeta).toBe('function');
});

test('the scheduler accepts any StreamingSource conforming object — EPT will plug in here', async () => {
  // A hand-rolled stub that satisfies the interface with the bare minimum.
  // It never decodes a real chunk; it proves type-compatibility only.
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }],
  });
  const realCloud = await StreamingPointCloud.open(
    new ArrayBufferRangeSource(fixture.buffer),
    'iface.copc.laz',
  );

  const stub: StreamingSource = {
    kind: 'ept', // pretending to be an EPT source
    name: 'stub.ept',
    renderOrigin: realCloud.renderOrigin,
    octree: realCloud.octree,
    sourcePointCount: realCloud.sourcePointCount,
    get residentPointCount(): number { return realCloud.residentPointCount; },
    counts: () => realCloud.counts(),
    maxDepth: () => realCloud.maxDepth(),
    localBounds: () => realCloud.localBounds(),
    dataBounds: () => realCloud.dataBounds(),
    readNodeChunk: (record, signal) => realCloud.readNodeChunk(record, signal),
    decodeMeta: (record) => realCloud.decodeMeta(record),
    // v0.3.3 — `defaultColorMode`, `availableColorModes`, and `crs` joined
    // the StreamingSource interface. The stub delegates each to the real
    // COPC cloud so the scheduler-integration test still type-checks
    // against the wider contract.
    defaultColorMode: () => realCloud.defaultColorMode(),
    availableColorModes: () => realCloud.availableColorModes(),
    crs: () => realCloud.crs(),
  };

  // The scheduler accepts the stub — no runtime error, no type error.
  const scheduler = new StreamingScheduler(
    stub,
    fakeDecoder,
    { onNodeReady: () => {}, onNodeEvicted: () => {} },
    streamingBudgets('balanced', false),
  );
  expect(scheduler).toBeDefined();
  scheduler.stop();
});
