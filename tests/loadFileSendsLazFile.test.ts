import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFile, __setParseWorkerFactoryForTests } from '../src/io/loadFile';

/**
 * A planned `.laz` crosses to the parse worker as the File; everything else
 * still crosses as transferred bytes. The worker reads a File as it needs,
 * so the main thread no longer reads a compressed file it will not decode.
 */

class FakeParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: Array<{ message: Record<string, unknown>; transfer: Transferable[] | undefined }> = [];
  postMessage(message: unknown, transfer?: Transferable[]): void {
    const req = message as Record<string, unknown>;
    this.posted.push({ message: req, transfer });
    queueMicrotask(() =>
      this.onmessage?.({
        data: {
          type: 'done',
          cloud: { positions: Float32Array.from([0, 0, 0, 1, 1, 1]), origin: [0, 0, 0], sourceFormat: 'laz', name: req.name },
          originalPointCount: 2,
          downsampled: false,
          telemetry: {},
        },
      } as MessageEvent),
    );
  }
  terminate(): void { /* nothing to release */ }
}

afterEach(() => { __setParseWorkerFactoryForTests(undefined); });

describe('loadFile hands the worker a File for a planned .laz', () => {
  it('posts the File and no buffer, transferring nothing', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const b = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
    const file = new File([b], 'm.laz');

    const result = await loadFile(file);
    expect(result.cloud.name).toBe('m.laz');
    expect(worker.posted).toHaveLength(1);
    const { message, transfer } = worker.posted[0];
    expect(message.format).toBe('laz');
    expect(message.plan).toBeDefined();
    expect(message.file).toBe(file);
    expect(message.buffer).toBeUndefined();
    expect(transfer ?? []).toHaveLength(0);
    // The page sizes the progressive preview; the worker never guesses it.
    expect(message.previewBudget).toBeGreaterThan(0);
    // No whole-file read happened, so the row is absent rather than zero.
    expect(result.telemetry?.fileReadMs).toBeUndefined();
  });

  it('still posts transferred bytes for a text cloud', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const file = new File([new TextEncoder().encode('0 0 0\n1 1 1\n')], 'scan.xyz');

    await loadFile(file, {}, { isMobile: true, previewBudget: 250_000 });
    const { message, transfer } = worker.posted[0];
    expect(message.previewBudget).toBe(250_000);
    // The page's device answer rides with every request; a worker cannot ask.
    expect(message.device).toEqual({ touchFirst: true });
    expect(message.file).toBeUndefined();
    expect(message.buffer).toBeInstanceOf(ArrayBuffer);
    expect(transfer).toHaveLength(1);
  });
});
