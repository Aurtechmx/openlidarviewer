/**
 * parseWorkerDevFlags.test.ts
 *
 * The whole-file LAZ decode runs inside the parse worker, and that is where
 * `decodeLazPooled` reads the development flags. A worker has no `window`, so
 * a flag typed into the page's URL (`?decodePool=on`, `?decodePool=off`,
 * `?decodeWorkers=N`) was invisible there and the documented switches never
 * reached the decode. Both worker-routed paths in `loadFile.ts` now send the
 * page's query with the request, and the worker primes its flags from it.
 * These tests pin the message carrying the query.
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  loadFile,
  decodeFullViaWorker,
  __setParseWorkerFactoryForTests,
} from '../src/io/loadFile';

/** A fake parse worker that records every request and answers each with a done reply. */
class FakeParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Record<string, unknown>[] = [];
  postMessage(message: unknown, _transfer?: Transferable[]): void {
    const req = message as Record<string, unknown>;
    this.posted.push(req);
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          type: 'done',
          cloud: {
            positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
            origin: [0, 0, 0],
            sourceFormat: 'xyz',
            name: req.name,
          },
          originalPointCount: 2,
          downsampled: false,
          telemetry: {},
        },
      } as MessageEvent),
    );
  }
  terminate(): void {
    /* no-op */
  }
}

function fakeFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

const g = globalThis as unknown as { window?: unknown };

describe('parse worker requests carry the page query for the worker-side dev flags', () => {
  let worker: FakeParseWorker;
  beforeEach(() => {
    worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
  });
  afterEach(() => {
    __setParseWorkerFactoryForTests(undefined);
    delete g.window;
  });

  it('loadFile sends location.search with the request', async () => {
    g.window = { location: { search: '?decodePool=off' } };
    await loadFile(fakeFile('scan.xyz', '0 0 0\n1 1 1\n'));
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].search).toBe('?decodePool=off');
  });

  it('decodeFullViaWorker sends location.search with the request', async () => {
    g.window = { location: { search: '?decodeWorkers=3' } };
    const buffer = new TextEncoder().encode('0 0 0\n1 1 1\n').buffer;
    await decodeFullViaWorker(buffer, 'scan.xyz');
    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0].search).toBe('?decodeWorkers=3');
  });

  it('sends an empty query where there is no page', async () => {
    await loadFile(fakeFile('scan.xyz', '0 0 0\n'));
    expect(worker.posted[0].search).toBe('');
  });
});
