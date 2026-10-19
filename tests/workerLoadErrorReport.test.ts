/**
 * workerLoadErrorReport.test.ts
 *
 * A LoadError that carries a report wrote its message for the user (a glTF with
 * Draco compression says the decoder is not bundled). The parse worker used to
 * send only the category across the thread boundary, so the page rebuilt the
 * error without its report and showed the category's generic line, "This file
 * type isn't supported yet.", in place of the reason. The report now travels
 * with the category in both directions.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { loadFile, decodeFullViaWorker, __setParseWorkerFactoryForTests } from '../src/io/loadFile';
import { LoadError, describeLoadError } from '../src/io/loadErrors';

const REASON = 'This glTF uses Draco mesh compression (KHR_draco_mesh_compression). The Draco decoder is not bundled with this viewer.';

class FakeParseWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void { this.posted.push(message); }
  terminate(): void { /* no-op */ }
  deliver(reply: unknown): void { this.onmessage?.({ data: reply } as MessageEvent); }
}

const bytes = new TextEncoder().encode('0 0 0\n1 1 1\n');
const file = {
  name: 'scan.xyz', size: bytes.byteLength,
  slice: () => ({ arrayBuffer: async () => bytes.buffer.slice(0) }),
  arrayBuffer: async () => bytes.buffer.slice(0),
} as unknown as File;

async function waitForPost(worker: FakeParseWorker): Promise<void> {
  for (let i = 0; i < 200 && worker.posted.length < 1; i++) await new Promise((r) => setTimeout(r, 1));
  expect(worker.posted).toHaveLength(1);
}

afterEach(() => __setParseWorkerFactoryForTests(undefined));

describe('the page rebuilds a worker LoadError with its report', () => {
  const reply = { type: 'error', error: REASON, category: 'unsupported-format', report: REASON };

  it('loadFile: the user-facing message is the reason, not the category line', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const settled = loadFile(file).catch((e: unknown) => e);
    await waitForPost(worker);
    worker.deliver(reply);
    const err = await settled;
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).report).toBe(REASON);
    expect(describeLoadError(err)).toBe(REASON);
  });

  it('decodeFullViaWorker: the same', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const settled = decodeFullViaWorker(bytes.buffer.slice(0) as ArrayBuffer, 'scan.xyz').catch((e: unknown) => e);
    await waitForPost(worker);
    worker.deliver(reply);
    const err = await settled;
    expect(describeLoadError(err)).toBe(REASON);
  });

  it('an error with a category and no report still shows the category line', async () => {
    const worker = new FakeParseWorker();
    __setParseWorkerFactoryForTests(() => worker as unknown as Worker);
    const settled = loadFile(file).catch((e: unknown) => e);
    await waitForPost(worker);
    worker.deliver({ type: 'error', error: 'detail', category: 'malformed-file' });
    expect(describeLoadError(await settled)).toBe("This file could not be read — it may be malformed or incomplete.");
  });
});

describe('the worker sends the report with the category', () => {
  it('a Draco GLB posts an error reply that carries both', async () => {
    const posted: unknown[] = [];
    const scope = { postMessage: (m: unknown) => posted.push(m), onmessage: null as ((e: MessageEvent) => void) | null };
    vi.stubGlobal('self', scope);
    vi.resetModules();
    await import('../src/io/parseWorker');
    const doc = { asset: { version: '2.0' }, extensionsUsed: ['KHR_draco_mesh_compression'] };
    const json = new TextEncoder().encode(JSON.stringify(doc).padEnd(Math.ceil(JSON.stringify(doc).length / 4) * 4, ' '));
    const glb = new Uint8Array(20 + json.length);
    const v = new DataView(glb.buffer);
    v.setUint32(0, 0x46546c67, true); v.setUint32(4, 2, true); v.setUint32(8, glb.length, true);
    v.setUint32(12, json.length, true); v.setUint32(16, 0x4e4f534a, true);
    glb.set(json, 20);
    scope.onmessage!({ data: { buffer: glb.buffer, format: 'glb', name: 'draco.glb' } } as MessageEvent);
    const isFinal = (m: unknown): boolean => ['error', 'done'].includes((m as { type: string }).type);
    for (let i = 0; i < 500 && !posted.some(isFinal); i++) await new Promise((r) => setTimeout(r, 2));
    vi.unstubAllGlobals();
    const last = posted.find(isFinal) as { type: string; category?: string; report?: string; error: string };
    expect(last.type).toBe('error');
    expect(last.category).toBe('unsupported-format');
    expect(last.report).toContain('Draco mesh compression');
    expect(last.error).toBe(last.report);
  });
});
