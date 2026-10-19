/**
 * lazDecodeErrorShape.test.ts
 *
 * laz-perf aborts on a corrupt stream by throwing a raw string or number. Only
 * those (and a WebAssembly trap) are rewrapped as a malformed-file LoadError,
 * with the raw value kept as the cause. An Error from anywhere else, such as a
 * TypeError from a bug in the decode path, reaches the caller unchanged instead
 * of being reported as a corrupt file. The copy of the file in WASM memory is
 * freed whichever way the decode ends, including when the reader cannot be
 * created.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const wasm = vi.hoisted(() => ({
  freed: [] as number[],
  mallocs: 0,
  ctor: null as null | (() => void),
  open: null as null | (() => void),
}));

vi.mock('laz-perf', () => ({
  createLazPerf: async () => ({
    HEAPU8: new Uint8Array(8192),
    _malloc: () => {
      wasm.mallocs++;
      return 100 * wasm.mallocs;
    },
    _free: (p: number) => { wasm.freed.push(p); },
    LASZip: class {
      constructor() { wasm.ctor?.(); }
      open(): void { wasm.open?.(); }
      getPointLength(): number { return 20; }
      getPoint(): void { /* no-op */ }
      delete(): void { /* no-op */ }
    },
  }),
}));

import { decodeLaz } from '../src/io/lazDecode';
import { LoadError } from '../src/io/loadErrors';
import type { LasHeader } from '../src/io/lasHeader';

const header = {
  pointCount: 1,
  pointDataRecordLength: 20,
  pointDataFormat: 0,
  scale: [0.01, 0.01, 0.01],
  offset: [0, 0, 0],
  min: [0, 0, 0],
  max: [1, 1, 1],
} as unknown as LasHeader;

const run = (): Promise<unknown> => decodeLaz(new ArrayBuffer(1024), header, [0, 0, 0], 1);

beforeEach(() => {
  wasm.freed.length = 0;
  wasm.mallocs = 0;
  wasm.ctor = null;
  wasm.open = null;
});

describe('decodeLaz error shape', () => {
  it.each([
    ['a string', () => { throw '1234 - Exception catching is disabled'; }],
    ['a number', () => { throw 5251352; }],
  ])('rewraps a raw Emscripten %s as a malformed-file error and keeps it as the cause', async (_l, thrower) => {
    wasm.open = thrower as () => void;
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as LoadError).message).not.toMatch(/Exception catching|\d{4}/);
    expect(['string', 'number']).toContain(typeof (err as LoadError).cause);
  });

  it('rewraps an Emscripten abort() Error as a malformed-file error and keeps it as the cause', async () => {
    const abort = new Error('Aborted(native code called abort())');
    wasm.open = () => { throw abort; };
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoadError);
    expect((err as LoadError).category).toBe('malformed-file');
    expect((err as LoadError).cause).toBe(abort);
  });

  it('lets a programming error through unchanged', async () => {
    const bug = new TypeError('x is not a function');
    wasm.open = () => { throw bug; };
    await expect(run()).rejects.toBe(bug);
  });

  it('frees the file copy when the reader cannot be created', async () => {
    const boom = new Error('LASZip failed to construct');
    wasm.ctor = () => { throw boom; };
    await expect(run()).rejects.toBe(boom);
    expect(wasm.mallocs).toBe(1);
    expect(wasm.freed).toEqual([100]);
  });

  it('frees the file copy when the decode throws', async () => {
    // The first write into WASM memory throws, as a trapped decode would.
    const spy = vi.spyOn(Uint8Array.prototype, 'set').mockImplementationOnce(() => { throw 'abort'; });
    await expect(run()).rejects.toBeInstanceOf(LoadError);
    spy.mockRestore();
    expect(wasm.freed).toContain(100);
  });
});
