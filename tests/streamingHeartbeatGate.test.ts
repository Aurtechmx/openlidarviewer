/**
 * The streaming heartbeat keeps the scheduler ticking while the render loop
 * sleeps. While frames tick it, the heartbeat stands down; its own ticks share
 * the frame cadence's timestamp, so neither path doubles the other.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { StreamingScheduler } from '../src/render/streaming/StreamingScheduler';
import { StreamingPointCloud } from '../src/render/streaming/StreamingPointCloud';
import { streamingBudgets } from '../src/render/streaming/streamingBudget';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import { instantDecoder } from './fixtures/streaming/legacyBaselineScenario';

async function scheduler(): Promise<StreamingScheduler> {
  const fixture = buildSyntheticCopc({ center: [0, 0, 0], halfsize: 128, nodes: [{ key: [0, 0, 0, 0], pointCount: 100 }] });
  const cloud = await StreamingPointCloud.open(new ArrayBufferRangeSource(fixture.buffer), 'hb.copc.laz');
  return new StreamingScheduler(cloud, instantDecoder, { onNodeReady: () => {}, onNodeEvicted: () => {} }, streamingBudgets('balanced', false));
}

describe('streaming heartbeat gate', () => {
  it('stands down when a frame ticked within the interval and records its own ticks', async () => {
    const s = await scheduler();
    expect(s.tickDue(1_000, 'moving')).toBe(true);
    expect(s.heartbeatDue(1_100, 200)).toBe(false);
    expect(s.heartbeatDue(1_199, 200)).toBe(false);
    expect(s.heartbeatDue(1_200, 200)).toBe(true);
    // The heartbeat's tick counts for the frame cadence (66 ms while moving).
    expect(s.tickDue(1_250, 'moving')).toBe(false);
    expect(s.tickDue(1_266, 'moving')).toBe(true);
  });

  it('ticks every interval when no frame runs', async () => {
    const s = await scheduler();
    let ticks = 0;
    for (let t = 1_000; t <= 3_000; t += 200) if (s.heartbeatDue(t, 200)) ticks++;
    expect(ticks).toBe(11);
  });

  it('is due again after the clock goes backwards or was never set', async () => {
    const s = await scheduler();
    expect(s.heartbeatDue(5_000, 200)).toBe(true);
    expect(s.heartbeatDue(4_000, 200)).toBe(true);
  });

  it('is what the Viewer heartbeat consults before ticking', () => {
    const src = readFileSync('src/render/Viewer.ts', 'utf8');
    expect(src).toMatch(/new VisibleHeartbeat\(\(\) => \{ if \(this\._streaming\?\.scheduler\.heartbeatDue\(this\._nowMs\(\), 200\)\) this\._tickStreaming\(\); \}, 200\)/);
  });
});
