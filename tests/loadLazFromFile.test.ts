import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadLas, loadLazFromFile, previewFrame, type LazLoadStats, type PreviewChunk } from '../src/io/loadLas';
import { parseBuffer, parseFile } from '../src/io/parseBuffer';
import { getLazPerf } from '../src/io/lazDecode';
import { decodeLazChunkLocal, type LazChunkJob } from '../src/io/heavy/decodeLazChunked';
import { primeDevFlags, parseDevFlags, resetDevFlagsForTest } from '../src/perf/devFlags';
import { DECODE_POOL_MOBILE_CAP } from '../src/io/workerPool/decodePoolSize';
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
    const chunks: PreviewChunk[] = [];
    let stats: LazLoadStats | undefined;
    const previewBudget = 1_000;
    const fromFile = await loadLazFromFile(
      file, 'm.laz', 1, undefined, (c) => { chunks.push(c); }, (s) => { stats = s; }, undefined, previewBudget,
    );
    const fromBuffer = await loadLas(buf, 'laz', 'm.laz', 1);
    sameCloud(fromFile, fromBuffer);
    expect(file.wholeReads).toBe(0);
    // Every chunk was handed on, with the decode's expected total and the frame.
    expect(chunks.length).toBeGreaterThan(1);
    // Only the preview budget crossed, not the cloud: the decoder thinned each
    // chunk against one whole-file stride before handing it over.
    const previewPoints = chunks.reduce((n, c) => n + c.positions.length / 3, 0);
    expect(previewPoints).toBeGreaterThan(0);
    expect(previewPoints).toBeLessThanOrEqual(previewBudget);
    expect(previewPoints).toBeLessThan(fromFile.pointCount);
    // Each chunk says where its records sit in the decode's output.
    expect(chunks.map((c) => c.outIndex).sort((a, b) => a - b)).toEqual([...new Set(chunks.map((c) => c.outIndex))].sort((a, b) => a - b));
    expect(chunks.every((c) => c.expectedPoints === fromFile.pointCount)).toBe(true);
    // The header's declared extent frames the preview, in the local frame.
    const frame = chunks[0].frame as { min: number[]; max: number[] };
    const b = fromFile.bounds();
    for (let a = 0; a < 3; a++) {
      expect(frame.min[a]).toBeLessThanOrEqual(b.min[a] + 1e-3);
      expect(frame.max[a]).toBeGreaterThanOrEqual(b.max[a] - 1e-3);
    }
    // The load said what it read and which decoder ran.
    expect(stats?.decodePath).toBe('pooled');
    expect(stats?.poolWorkers).toBeGreaterThan(0);
    expect(stats?.rangeRequests).toBeGreaterThan(2);
    expect(stats?.compressedBytesRead).toBeGreaterThan(0);
    expect(stats!.compressedBytesRead + stats!.metadataBytes).toBeLessThanOrEqual(buf.byteLength + 64 * 1024);
    // The row says which file and which plan produced it.
    expect(stats?.fileName).toBe('m.laz');
    expect(stats?.fileBytes).toBe(buf.byteLength);
    expect(stats?.declaredPointCount).toBe(fromFile.declaredPointCount);
    expect(stats?.pointFormat).toBeGreaterThanOrEqual(0);
    expect(stats?.lazChunkCount).toBeGreaterThan(1);
    expect(stats?.decodeStride).toBe(1);
    expect(stats?.previewBudget).toBe(previewBudget);
    // Bytes counted up to the first drawable sample, no more than the whole read.
    expect(stats?.compressedBytesBeforePreview).toBeGreaterThanOrEqual(0);
    expect(stats!.compressedBytesBeforePreview!).toBeLessThanOrEqual(stats!.compressedBytesRead);
    // The union of the requested spans cannot exceed the file (plus the
    // head-peek slack), and the re-read is the part asked for twice.
    expect(stats!.uniqueBytesRead).toBeLessThanOrEqual(buf.byteLength + 64 * 1024);
    expect(stats!.rereadBytes).toBeGreaterThanOrEqual(0);
    expect(stats!.rereadBytes).toBe(stats!.requestedBytes - stats!.uniqueBytesRead);
    // `readLazChunkTable` re-reads offset 0 after the prefix read off the File.
    // That is a real cost of the current reading order, and it is reported.
    expect(stats!.rereadBytes).toBeGreaterThan(0);
  });

  it('reports the whole-file path and its one read when the pool does not engage', async () => {
    const buf = fixtureBytes();
    let stats: LazLoadStats | undefined;
    await loadLazFromFile(new File([buf], 'm.laz'), 'm.laz', 1, undefined, undefined, (s) => { stats = s; });
    expect(stats?.decodePath).toBe('whole-file');
    expect(stats?.compressedBytesRead).toBe(buf.byteLength);
    // Identity is recorded on this path too; no chunk plan was ever made.
    expect(stats?.fileName).toBe('m.laz');
    expect(stats?.fileBytes).toBe(buf.byteLength);
    expect(stats?.decodeStride).toBe(1);
    expect(stats?.previewBudget).toBeUndefined();
    expect(stats?.lazChunkCount).toBeUndefined();
    // The prefix read is covered again by the whole-file read.
    expect(stats!.uniqueBytesRead).toBe(buf.byteLength);
    expect(stats!.rereadBytes).toBeGreaterThan(0);
  });

  it('carries the stride and the declared count the file was read at', async () => {
    const buf = fixtureBytes();
    let stats: LazLoadStats | undefined;
    const cloud = await loadLazFromFile(new File([buf], 'ladder.laz'), 'm.laz', 7, undefined, undefined, (s) => { stats = s; });
    expect(stats?.fileName).toBe('ladder.laz');
    expect(stats?.decodeStride).toBe(7);
    expect(stats?.declaredPointCount).toBe(cloud.declaredPointCount);
    expect(stats!.pointFormat).toBeGreaterThanOrEqual(0);
    expect(stats!.pointFormat).toBeLessThanOrEqual(10);
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

describe('previewFrame', () => {
  const header = (min: [number, number, number], max: [number, number, number]) =>
    ({ min, max } as unknown as Parameters<typeof previewFrame>[0]);
  it('shifts declared bounds into the local frame', () => {
    expect(previewFrame(header([10, 20, 30], [14, 26, 33]), [10, 20, 30])).toEqual({ min: [0, 0, 0], max: [4, 6, 3] });
  });
  it('refuses non-finite, inverted, and more-than-one-flat-axis bounds', () => {
    expect(previewFrame(header([Number.NaN, 0, 0], [1, 1, 1]), [0, 0, 0])).toBeUndefined();
    expect(previewFrame(header([5, 0, 0], [1, 1, 1]), [0, 0, 0])).toBeUndefined();
    expect(previewFrame(header([0, 0, 0], [0, 0, 1]), [0, 0, 0])).toBeUndefined();
    expect(previewFrame(header([0, 0, 0], [1, 1, 0]), [0, 0, 0])).toEqual({ min: [0, 0, 0], max: [1, 1, 0] });
  });
});

describe('loadLazFromFile takes the pool decision from an explicit policy', () => {
  it('engages the pool from the policy alone, with nothing primed in this scope', async () => {
    vi.stubGlobal('Worker', FakeLazWorker);
    resetDevFlagsForTest();
    const buf = fixtureBytes();
    let stats: LazLoadStats | undefined;
    const policy = { flags: parseDevFlags('?decodePool=on'), isMobile: false };
    const cloud = await loadLazFromFile(new File([buf], 'm.laz'), 'm.laz', 1, undefined, () => {}, (s) => { stats = s; }, policy);
    expect(cloud.pointCount).toBe(120_000);
    expect(stats?.decodePath).toBe('pooled');
  });

  it('a mobile policy caps the pool the way the page would', async () => {
    vi.stubGlobal('Worker', FakeLazWorker);
    resetDevFlagsForTest();
    const buf = fixtureBytes();
    let stats: LazLoadStats | undefined;
    const policy = { flags: parseDevFlags('?decodePool=on'), isMobile: true };
    await loadLazFromFile(new File([buf], 'm.laz'), 'm.laz', 1, undefined, undefined, (s) => { stats = s; }, policy);
    expect(stats?.decodePath).toBe('pooled');
    expect(stats?.poolWorkers).toBeLessThanOrEqual(DECODE_POOL_MOBILE_CAP);
  });
});
