/** The worker client against the real kernel: chunks, abort, failure, teardown. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { SurfaceNormals, estimateCellSize } from '../src/render/sunShading/surfaceNormals';
import { CHUNK_POINTS, computeSunNormals, NoSurfaceError } from '../src/render/sunShading/sunNormalsWorkerClient';
import type { SunNormalsRequest } from '../src/render/sunShading/sunNormalsWorker';

const FRAME = { upAxis: 2, verticalScale: 1 } as const;
type Msg = SunNormalsRequest & { id: number };

const made: FakeWorker[] = [];
let behave: (w: FakeWorker, m: Msg) => void;
class FakeWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  job: SurfaceNormals | null = null;
  readonly sent: Msg[] = [];
  constructor() { made.push(this); }
  postMessage(m: Msg): void { this.sent.push(m); queueMicrotask(() => { if (!this.terminated) behave(this, m); }); }
  terminate(): void { this.terminated = true; }
}

const real = (w: FakeWorker, m: Msg): void => {
  let codes: ArrayBuffer | undefined;
  if (m.kind === 'begin') w.job = new SurfaceNormals(m.params);
  else if (m.kind === 'add') w.job!.add(new Float32Array(m.xyz));
  else if (m.kind === 'fit') w.job!.fit();
  else codes = w.job!.encode(new Float32Array(m.xyz)).buffer as ArrayBuffer;
  w.onmessage?.({ data: { id: m.id, ok: true, codes } });
};

function slope(n: number): Float32Array {
  const p = new Float32Array(n * 3);
  const side = Math.ceil(Math.sqrt(n));
  for (let i = 0; i < n; i++) p.set([i % side, Math.floor(i / side), (i % side) * 0.3], i * 3);
  return p;
}

vi.stubGlobal('Worker', FakeWorker);
afterEach(() => { made.length = 0; });

describe('computeSunNormals', () => {
  it('answers every point across chunks, reads the caller buffer only, and ends its worker', async () => {
    behave = real;
    const p = slope(CHUNK_POINTS + 500);
    const copy = p.slice(0, 300);
    const shares: number[] = [];
    const codes = await computeSunNormals(p, FRAME, new AbortController().signal, (s) => shares.push(s));
    expect(codes).toHaveLength(CHUNK_POINTS + 500);
    expect(new Set(codes.slice(-500)).size).toBeLessThan(40);
    expect(Array.from(p.slice(0, 300))).toEqual(Array.from(copy));
    expect(made[0].sent.map((m) => m.kind)).toEqual(['begin', 'add', 'add', 'fit', 'encode', 'encode']);
    expect(made[0].terminated).toBe(true);
    expect(shares.at(-1)).toBe(1);
    expect(estimateCellSize(p, p.length / 3, FRAME)).not.toBeNull();
  });

  it('an abort rejects at once and ends the worker', async () => {
    behave = (w, m) => { if (m.kind !== 'fit') real(w, m); }; // hangs in the fit
    const abort = new AbortController();
    const run = computeSunNormals(slope(400), FRAME, abort.signal);
    await new Promise((r) => setTimeout(r, 5));
    abort.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(made[0].terminated).toBe(true);
  });

  it('a worker error and an error reply both reject and end the worker', async () => {
    behave = (w) => w.onerror?.();
    await expect(computeSunNormals(slope(400), FRAME, new AbortController().signal)).rejects.toThrow(/failed/);
    behave = (w, m) => w.onmessage?.({ data: { id: m.id, ok: false, error: 'out of memory' } });
    await expect(computeSunNormals(slope(400), FRAME, new AbortController().signal)).rejects.toThrow('out of memory');
    expect(made.every((w) => w.terminated)).toBe(true);
  });

  it('refuses a cloud with no extent without starting a worker', async () => {
    await expect(computeSunNormals(new Float32Array(30), FRAME, new AbortController().signal)).rejects.toBeInstanceOf(NoSurfaceError);
    expect(made).toHaveLength(0);
  });
});
