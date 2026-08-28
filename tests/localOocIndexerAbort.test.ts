/**
 * localOocIndexerAbort.test.ts
 *
 * The out-of-core indexer client attaches its abort listener with `{once:true}`.
 * If the caller's signal is ALREADY aborted when `run()` is called, no 'abort'
 * event ever fires, so a plain listener would let the worker index a multi-
 * gigabyte file for a build nobody is waiting on. `run()` must instead check
 * `signal.aborted` up front and refuse WITHOUT constructing the worker.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { LocalOocIndexerClient } from '../src/io/heavy/worker/localOocIndexerWorkerClient';

afterEach(() => {
  vi.unstubAllGlobals();
});

function fakeFile(): File {
  return new File([new Uint8Array(16)], 'huge.las', { type: 'application/octet-stream' });
}

describe('LocalOocIndexerClient — already-aborted signal', () => {
  it('refuses an already-aborted build without constructing a worker', async () => {
    let constructed = 0;
    class WorkerStub {
      constructor() {
        constructed += 1;
        throw new Error('Worker must not be constructed for an already-aborted build');
      }
    }
    vi.stubGlobal('Worker', WorkerStub);

    const controller = new AbortController();
    controller.abort();

    const client = new LocalOocIndexerClient();
    await expect(
      client.run({ file: fakeFile(), storeName: 'store-x', signal: controller.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(constructed).toBe(0);
  });
});
