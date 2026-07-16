/**
 * streamingErrorBackoff.test.ts
 *
 * A permanently-failing chunk must not retry forever. Before the fix, an
 * 'error' node was re-enqueued on every rescore with no cap or backoff — an
 * infinite fetch/decode storm — and because it kept cycling back through
 * `queued`/`loading`, the queued "busy" signal never quiesced, so the idle
 * render throttle never let the loop rest.
 *
 * A fake decoder rejects one node's chunk every time; the test drives many
 * ticks (advancing the clock well past any backoff each time) and asserts the
 * decode ATTEMPTS for that node are bounded by the retry cap, not proportional
 * to the tick count — and that the scheduler's queued/busy signal for it is
 * clear afterwards.
 */

import { describe, expect, test } from 'vitest';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import type {
  ChunkDecoder,
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../src/io/copc/copcChunkDecode';

const WIDE = [
  1 / 256, 0, 0, 0,
  0, 1 / 256, 0, 0,
  0, 0, 1 / 256, 0,
  0, 0, 0, 1,
];

/** The point count of the node whose chunk we make permanently fail. */
const FAILING_POINTS = 600;

/** A decoder that always rejects the failing node, and counts its attempts. */
function makeFlakyDecoder(): { decoder: ChunkDecoder; attempts: () => number } {
  let attempts = 0;
  const decoder: ChunkDecoder = {
    decode(_chunk: ArrayBuffer, meta: ChunkDecodeMetadata): Promise<DecodedChunk> {
      if (meta.pointCount === FAILING_POINTS) {
        attempts++;
        return Promise.reject(new Error('decode boom'));
      }
      return Promise.resolve({
        pointCount: meta.pointCount,
        positions: new Float32Array(meta.pointCount * 3),
        intensity: new Uint16Array(meta.pointCount),
        classification: new Uint8Array(meta.pointCount),
        returnNumber: new Uint8Array(meta.pointCount),
        returnCount: new Uint8Array(meta.pointCount),
        gpsTime: new Float64Array(meta.pointCount),
      });
    },
  };
  return { decoder, attempts: () => attempts };
}

async function drain(scheduler: StreamingScheduler): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const s = scheduler.stats();
    if (s.queued === 0 && s.loading === 0) return;
    await new Promise((r) => setTimeout(r, 0));
  }
}

async function openCloud(): Promise<StreamingPointCloud> {
  const fixture = buildSyntheticCopc({
    center: [0, 0, 0],
    halfsize: 128,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 1000 },
      { key: [1, 0, 0, 0], pointCount: 800 },
      { key: [1, 1, 0, 0], pointCount: FAILING_POINTS },
      { key: [2, 0, 0, 0], pointCount: 400 },
      { key: [2, 1, 0, 0], pointCount: 300 },
    ],
  });
  return StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'err.copc.laz');
}

describe('error-node retry storm', () => {
  test('a permanently-failing node is retried a bounded number of times, then the busy signal clears', async () => {
    let clock = 0;
    const cloud = await openCloud();
    const { decoder, attempts } = makeFlakyDecoder();
    const scheduler = new StreamingScheduler(
      cloud,
      decoder,
      { onNodeReady: () => {}, onNodeEvicted: () => {} },
      streamingBudgets('balanced', false),
      { now: () => clock },
    );

    const TICKS = 40;
    for (let i = 0; i < TICKS; i++) {
      // Advance the clock far past any exponential backoff deadline each tick,
      // so retries are gated purely by the cap, not by the backoff window.
      clock += 60_000;
      scheduler.update({ viewProjection: WIDE, cameraPosition: [0, 0, 0] });
      await drain(scheduler);
    }

    // Bounded — attempts must track the retry cap, not the tick count. Before
    // the fix this equalled ~TICKS (one storm attempt per rescore).
    expect(attempts()).toBeLessThan(TICKS);
    expect(attempts()).toBeLessThanOrEqual(6);

    // The four healthy nodes are resident; the failed node is not.
    expect(cloud.counts().resident).toBe(4);
    expect(cloud.counts().error).toBe(1);

    // Busy signal is clear — the failed node no longer cycles through
    // queued/loading, so the idle-render throttle can quiesce.
    const stats = scheduler.stats();
    expect(stats.queued).toBe(0);
    expect(stats.loading).toBe(0);
  });
});
