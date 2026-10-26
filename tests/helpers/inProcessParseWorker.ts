/**
 * inProcessParseWorker.ts
 *
 * Runs the real parse worker (`src/io/parseWorker.ts`) inside the test process
 * and hands `loadFile` a Worker-shaped object that talks to it. `loadFile`
 * then takes its normal path end to end: preflight on the page side, the
 * worker's own message handling, the loader, and the reply. Tests that need
 * the worker to survive a refused file open a good file on the same worker
 * afterwards.
 *
 * Messages are delivered on a macrotask in both directions, as a real worker
 * would deliver them. Replies from a worker the page has terminated are
 * dropped, the way a terminated worker's replies never arrive.
 */

import { vi } from 'vitest';
import { __setParseWorkerFactoryForTests } from '../../src/io/loadFile';

interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage: (message: unknown, transfer?: Transferable[]) => void;
}

/** A Worker stand-in whose other end is the parse worker module. */
export class InProcessParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminated = false;
  /** Every request the page posted, in order. */
  readonly posted: unknown[] = [];

  private readonly scope: WorkerScope;

  constructor(scope: WorkerScope) {
    this.scope = scope;
  }

  postMessage(message: unknown): void {
    if (this.terminated) throw new Error('posted to a terminated worker');
    this.posted.push(message);
    setTimeout(() => this.scope.onmessage?.({ data: message } as MessageEvent), 0);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Called by the worker scope: deliver one reply to the page. */
  deliver(message: unknown): void {
    if (this.terminated) return;
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: message } as MessageEvent);
    }, 0);
  }
}

/** The installed bridge: every worker the factory has built, newest last. */
export interface InProcessParseWorkerHandle {
  readonly workers: InProcessParseWorker[];
  restore(): void;
}

/**
 * Load the parse worker module against a stand-in `self` and route the
 * `loadFile` worker factory to it. Call `restore()` in `afterAll`.
 */
export async function installInProcessParseWorker(): Promise<InProcessParseWorkerHandle> {
  const workers: InProcessParseWorker[] = [];
  const scope: WorkerScope = {
    onmessage: null,
    postMessage: (message) => workers[workers.length - 1]?.deliver(message),
  };
  vi.stubGlobal('self', scope);
  await import('../../src/io/parseWorker');
  vi.unstubAllGlobals();
  __setParseWorkerFactoryForTests(() => {
    const worker = new InProcessParseWorker(scope);
    workers.push(worker);
    return worker as unknown as Worker;
  });
  return {
    workers,
    restore: () => __setParseWorkerFactoryForTests(undefined),
  };
}
