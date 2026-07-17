/**
 * parseWorkerPostFailure.test.ts
 *
 * `postMessage` can throw synchronously — a DataCloneError on an unclonable or
 * already-detached buffer, or an invalid-state throw against a worker that has
 * been terminated. Both worker-routed paths in `loadFile.ts` post outside any
 * guard, so the throw escaped the Promise executor and rejected the caller
 * while the abort listener registered just above stayed attached.
 *
 * That leaked listener closes over the SHARED parse worker. When its signal
 * later aborts, it nulls the handlers of and terminates the worker that a
 * DIFFERENT, healthy load is decoding on — that load then never settles and the
 * UI waits forever. These tests pin the teardown: a sync post failure settles
 * the request exactly like any other failure, so a later abort is inert and
 * cannot reach across into someone else's load.
 *
 * Structure, not timing — the one wall-clock use is a hang detector, so a
 * never-settling promise fails the test instead of stalling the runner.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  loadFile,
  decodeFullViaWorker,
  __setParseWorkerFactoryForTests,
} from '../src/io/loadFile';

/**
 * A fake parse worker. Unlike the one in decodeFullWorker.test.ts it never
 * auto-replies: these tests need a decode to sit in flight while another
 * signal aborts, so replies are delivered by hand.
 */
class FakeParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  terminated = false;
  /** When set, the next `postMessage` throws it instead of posting. */
  throwOnNextPost: Error | undefined;

  postMessage(message: unknown, _transfer?: Transferable[]): void {
    if (this.throwOnNextPost) {
      const err = this.throwOnNextPost;
      this.throwOnNextPost = undefined;
      throw err;
    }
    this.posted.push(message);
  }
  terminate(): void {
    this.terminated = true;
  }
  /** Hand a reply to whatever handler is currently attached — if any. */
  deliver(reply: unknown): void {
    this.onmessage?.({ data: reply } as MessageEvent);
  }
}

/** A minimal File stand-in: name, size, a head slice, and the whole body. */
function fakeFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
}

/** A `done` reply the load path turns into a LoadResult. */
function doneReply(name: string): unknown {
  return {
    type: 'done',
    cloud: {
      positions: Float32Array.from([0, 0, 0, 1, 1, 1]),
      origin: [0, 0, 0],
      sourceFormat: 'xyz',
      name,
    },
    originalPointCount: 2,
    downsampled: false,
    telemetry: {},
  };
}

/**
 * Resolve to `'hung'` if `promise` has not settled by the next few turns of the
 * event loop plus a short timer. A hang is the defect under test, so it has to
 * register as an assertion failure rather than a stalled runner.
 */
function settledOrHung<T>(promise: Promise<T>): Promise<T | 'hung'> {
  return Promise.race([
    promise,
    new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 50)),
  ]);
}

/**
 * Wait until `worker` has taken `count` posts. The preflight, the body read and
 * the worker gate are all real awaits, so a fixed microtask drain is not enough
 * to know a load has actually reached the worker.
 */
async function waitForPosts(worker: FakeParseWorker, count: number): Promise<void> {
  for (let i = 0; i < 200 && worker.posted.length < count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(worker.posted).toHaveLength(count);
}

afterEach(() => {
  __setParseWorkerFactoryForTests(undefined);
});

describe('loadFile survives a synchronous postMessage failure', () => {
  it('rejects with the real post error', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);

    await expect(loadFile(fakeFile('scan.xyz', '0 0 0\n1 1 1\n'))).rejects.toThrow(
      /DataCloneError/,
    );
  });

  it('leaves no abort listener behind — a later abort is inert', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrl = new AbortController();

    await expect(
      loadFile(fakeFile('scan.xyz', '0 0 0\n'), {}, { signal: ctrl.signal }),
    ).rejects.toThrow(/DataCloneError/);

    ctrl.abort();
    // The stale listener would have torn the shared worker down here.
    expect(worker.terminated).toBe(false);
  });

  it('does not strand a later load on the shared worker when its signal aborts', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrlA = new AbortController();

    await expect(
      loadFile(fakeFile('a.xyz', '0 0 0\n'), {}, { signal: ctrlA.signal }),
    ).rejects.toThrow(/DataCloneError/);

    // Load B takes the same shared worker and is mid-decode.
    const loadB = loadFile(fakeFile('b.xyz', '0 0 0\n1 1 1\n'));
    await waitForPosts(worker, 1);

    // A's signal aborts long after A is done. A leaked listener from A fires
    // here and kills B's worker and handlers — B would hang forever.
    ctrlA.abort();
    worker.deliver(doneReply('b.xyz'));

    const result = await settledOrHung(loadB);
    expect(result).not.toBe('hung');
    expect(worker.terminated).toBe(false);
    if (result !== 'hung') expect(result.cloud.name).toBe('b.xyz');
  });
});

describe('decodeFullViaWorker survives a synchronous postMessage failure', () => {
  it('rejects with the real post error', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);

    const buffer = new TextEncoder().encode('0 0 0\n').buffer;
    await expect(decodeFullViaWorker(buffer, 'scan.xyz')).rejects.toThrow(/DataCloneError/);
  });

  it('leaves no abort listener behind — a later abort is inert', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrl = new AbortController();

    const buffer = new TextEncoder().encode('0 0 0\n').buffer;
    await expect(decodeFullViaWorker(buffer, 'scan.xyz', ctrl.signal)).rejects.toThrow(
      /DataCloneError/,
    );

    ctrl.abort();
    expect(worker.terminated).toBe(false);
  });

  it('does not strand a later decode on the shared worker when its signal aborts', async () => {
    const worker = new FakeParseWorker();
    worker.throwOnNextPost = new Error('DataCloneError: buffer is detached');
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrlA = new AbortController();

    await expect(
      decodeFullViaWorker(new TextEncoder().encode('0 0 0\n').buffer, 'a.xyz', ctrlA.signal),
    ).rejects.toThrow(/DataCloneError/);

    const decodeB = decodeFullViaWorker(
      new TextEncoder().encode('0 0 0\n1 1 1\n').buffer,
      'b.xyz',
    );
    await waitForPosts(worker, 1);

    ctrlA.abort();
    worker.deliver(doneReply('b.xyz'));

    const cloud = await settledOrHung(decodeB);
    expect(cloud).not.toBe('hung');
    expect(worker.terminated).toBe(false);
    if (cloud !== 'hung') expect(cloud.name).toBe('b.xyz');
  });
});

describe('the guard does not regress the working paths', () => {
  it('completes a normal load', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);

    const promise = loadFile(fakeFile('scan.xyz', '0 0 0\n1 1 1\n'));
    await waitForPosts(worker, 1);
    worker.deliver(doneReply('scan.xyz'));

    const result = await settledOrHung(promise);
    expect(result).not.toBe('hung');
    if (result !== 'hung') {
      expect(result.cloud.name).toBe('scan.xyz');
      expect(result.cloud.pointCount).toBe(2);
    }
    expect(worker.terminated).toBe(false);
  });

  it('still cancels a genuine abort during a decode', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const ctrl = new AbortController();

    const promise = loadFile(fakeFile('scan.xyz', '0 0 0\n'), {}, { signal: ctrl.signal });
    await waitForPosts(worker, 1);
    ctrl.abort();

    await expect(promise).rejects.toThrow(/cancel/i);
    // A real mid-decode cancel still terminates the worker — no orphan decode.
    expect(worker.terminated).toBe(true);
  });
});
