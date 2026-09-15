import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLas, loadLazFromFile } from '../src/io/loadLas';
import { parseBuffer, parseFile } from '../src/io/parseBuffer';
import { getLazPerf } from '../src/io/lazDecode';
import { decodeLazChunkLocal, type LazChunkJob } from '../src/io/heavy/decodeLazChunked';
import { primeDevFlags, resetDevFlagsForTest } from '../src/perf/devFlags';
import type { LoadPlan } from '../src/io/loadPlan';
import type { PointCloud } from '../src/model/PointCloud';

/**
 * `loadLazFromFile` reads the header from a prefix and, when the pool
 * engages, each chunk by range; otherwise it reads the file whole in place.
 * Either way the cloud must be what `loadLas` makes of the file's bytes.
 */

function fixtureBytes(): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** A File that counts whole reads, so a test can show the pooled path made none. */
class CountingFile extends File {
  wholeReads = 0;
  override arrayBuffer(): Promise<ArrayBuffer> {
    this.wholeReads++;
    return super.arrayBuffer();
  }
}

class FakeLazWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  postMessage(message: unknown): void {
    const msg = message as { type: string; requestId: number; job: LazChunkJob };
    if (msg.type !== 'decode') return;
    void getLazPerf().then((lazPerf) => {
      const decoded = decodeLazChunkLocal(lazPerf, msg.job);
      this.onmessage?.({ data: { type: 'decoded', requestId: msg.requestId, decoded } } as MessageEvent);
    });
  }
  terminate(): void { /* nothing to release */ }
}

function sameCloud(a: PointCloud, b: PointCloud): void {
  expect(a.positions).toEqual(b.positions);
  expect(a.intensity).toEqual(b.intensity);
  expect(a.classification).toEqual(b.classification);
  expect(a.declaredPointCount).toBe(b.declaredPointCount);
  expect(a.decodedPointCount).toBe(b.decodedPointCount);
  expect(a.loadStride).toBe(b.loadStride);
  expect(JSON.stringify(a.metadata)).toBe(JSON.stringify(b.metadata));
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetDevFlagsForTest();
});

describe('loadLazFromFile', () => {
  it('matches loadLas on the whole-read path, where the pool does not engage', async () => {
    const buf = fixtureBytes();
    const file = new CountingFile([buf], 'm.laz');
    const fromFile = await loadLazFromFile(file, 'm.laz', 1);
    const fromBuffer = await loadLas(buf, 'laz', 'm.laz', 1);
    sameCloud(fromFile, fromBuffer);
    expect(file.wholeReads).toBe(1);
  });

  it('matches loadLas on the pooled path and never reads the file whole', async () => {
    vi.stubGlobal('Worker', FakeLazWorker);
    primeDevFlags('?decodePool=on');
    const buf = fixtureBytes();
    const file = new CountingFile([buf], 'm.laz');
    const previews: PointCloud[] = [];
    const fromFile = await loadLazFromFile(file, 'm.laz', 1, undefined, (c) => previews.push(c));
    const fromBuffer = await loadLas(buf, 'laz', 'm.laz', 1);
    sameCloud(fromFile, fromBuffer);
    expect(file.wholeReads).toBe(0);
    expect(previews).toHaveLength(1);
    expect(previews[0].pointCount).toBeGreaterThan(0);
    expect(previews[0].pointCount).toBeLessThan(fromFile.pointCount);
  });

  it('keeps the stride sample identical to the buffer path', async () => {
    vi.stubGlobal('Worker', FakeLazWorker);
    primeDevFlags('?decodePool=on');
    const buf = fixtureBytes();
    const fromFile = await loadLazFromFile(new File([buf], 'm.laz'), 'm.laz', 7);
    const fromBuffer = await loadLas(buf, 'laz', 'm.laz', 7);
    sameCloud(fromFile, fromBuffer);
  });
});

describe('parseFile', () => {
  it('produces the same load result as parseBuffer for a planned .laz', async () => {
    const buf = fixtureBytes();
    const plan: LoadPlan = {
      mode: 'all', sourceCount: 120_000, stride: 1, targetCount: 120_000, budget: 5_000_000,
      memoryEstimateBytes: 0, memoryGuardTriggered: false,
    };
    const a = await parseFile(new File([buf], 'm.laz'), 'laz', 'm.laz', 5_000_000, plan);
    const b = await parseBuffer(buf, 'laz', 'm.laz', 5_000_000, plan);
    sameCloud(a.cloud, b.cloud);
    expect(a.originalPointCount).toBe(b.originalPointCount);
    expect(a.downsampled).toBe(b.downsampled);
  });
});
