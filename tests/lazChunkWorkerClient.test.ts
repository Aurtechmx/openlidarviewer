/**
 * tests/lazChunkWorkerClient.test.ts
 *
 * The local-LAZ chunk-decode client, end to end without a real Worker. A fake
 * worker runs the ACTUAL worker decode (`decodeLazChunkLocal` on a real laz-perf
 * instance) and replies on a microtask, so this exercises the whole path the
 * browser runs — client → pool dispatch/queue → worker decode → reassembly —
 * and pins two things:
 *
 *   1. the pooled path assembles byte-for-byte what the legacy whole-file
 *      `decodeLaz` produces (positions, GPS time, colour), across several
 *      workers rather than one; and
 *   2. `decodeLazPooled` engages NO worker at all when pooling is not opted in,
 *      so the default `.laz` open is exactly the historical main-thread decode.
 *
 * The pool's own protocol (dispatch, queueing, failure isolation, cancellation)
 * is covered against a fake worker in decodeWorkerPool.test.ts and
 * copcWorkerClient.test.ts; this file is about the LAZ assembly on top of it.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLasHeader } from '../src/io/lasHeader';
import { computeOrigin } from '../src/io/coordinateBridge';
import { decodeLaz, getLazPerf } from '../src/io/lazDecode';
import { decodeLazChunkLocal, decodeLazParallel, type LazChunkJob } from '../src/io/heavy/decodeLazChunked';
import {
  LazChunkWorkerClient,
  decodeLazPooled,
} from '../src/io/heavy/worker/lazChunkWorkerClient';

type LazPerfModule = Awaited<ReturnType<typeof getLazPerf>>;
let lazPerf: LazPerfModule;

beforeAll(async () => {
  lazPerf = await getLazPerf();
});

function loadFixture(name: string): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, 'fixtures', name));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/**
 * A fake Worker that decodes each chunk exactly as the real worker does and
 * replies on a microtask (so dispatch looks asynchronous, like a real worker).
 * Every construction is recorded so a test can prove the pool fanned out.
 */
class FakeLazWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  terminated = false;

  constructor() {
    instances.push(this);
  }
  postMessage(message: unknown): void {
    const msg = message as { type: string; requestId: number; job: LazChunkJob };
    if (msg.type !== 'decode') return;
    const decoded = decodeLazChunkLocal(lazPerf, msg.job);
    queueMicrotask(() =>
      this.onmessage?.({ data: { type: 'decoded', requestId: msg.requestId, decoded } } as MessageEvent),
    );
  }
  terminate(): void {
    this.terminated = true;
  }
}

let instances: FakeLazWorker[] = [];

afterEach(() => {
  instances = [];
  vi.unstubAllGlobals();
});

describe('LazChunkWorkerClient assembly', () => {
  it('decodes across a worker pool byte-for-byte identically to decodeLaz', async () => {
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);
    const seq = await decodeLaz(buf, header, origin, 1);

    const client = new LazChunkWorkerClient({ poolSize: 3, workerFactory: () => new FakeLazWorker() });
    const parallel = await decodeLazParallel(buf, header, origin, client.decode);
    client.dispose();

    expect(parallel).not.toBeNull();
    expect(parallel!.positions).toEqual(seq.positions);
    if (seq.gpsTime) expect(parallel!.gpsTime).toEqual(seq.gpsTime);
    if (seq.colors) expect(parallel!.colors).toEqual(seq.colors);

    // The fixture spans several chunks, so a real pool must have built more than
    // one worker — otherwise "parallel" would be sequential-on-a-worker.
    expect(instances.length).toBeGreaterThan(1);
    expect(instances.every((w) => w.terminated)).toBe(true);
  });
});

describe('decodeLazPooled opt-in gate', () => {
  it('returns null and builds NO worker when pooling is not opted in', async () => {
    // Node has no `?decodePool` URL flag, so readDevFlags reports the shipping
    // default (pooling off). The loader must then get null and fall back to the
    // main-thread decodeLaz, having spun up nothing.
    vi.stubGlobal('Worker', FakeLazWorker);
    const buf = loadFixture('multichunk.laz');
    const header = parseLasHeader(buf);
    const origin = computeOrigin([500000, 4100000, 190]);

    const out = await decodeLazPooled(buf, header, origin);
    expect(out).toBeNull();
    expect(instances).toHaveLength(0);
  });
});
