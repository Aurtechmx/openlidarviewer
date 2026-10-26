/**
 * fakeParseWorker.ts: a stand-in for the shared parse worker that records
 * every request and answers each with a two-point cloud named after the file.
 * Install it with `__setParseWorkerFactoryForTests` from src/io/loadFile.
 */
export class FakeParseWorker {
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
