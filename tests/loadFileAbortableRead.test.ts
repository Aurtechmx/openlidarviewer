/**
 * loadFileAbortableRead.test.ts
 *
 * A cancel during a multi-gigabyte static-file read must stop promptly.
 * `File.arrayBuffer()` is not wired to an abort signal, so `loadFile` now reads
 * the whole file in slices and checks the signal between chunks — the cancel
 * window is one chunk, not the entire file. These pin that behaviour on the
 * extracted reader without allocating gigabytes (the fake slices return tiny
 * buffers; only the destination is sized to the file).
 */

import { describe, it, expect } from 'vitest';
import { readWholeFileAbortable, LoadCancelledError } from '../src/io/loadFile';

const CHUNK = 64 * 1024 * 1024;

/** A File-like whose slice() returns tiny buffers (no real data), so a "large"
 *  file costs only the destination allocation the reader itself makes. */
function fakeFile(size: number, onSlice?: () => void): File {
  return {
    size,
    slice: (_start: number, _end: number) => ({
      arrayBuffer: async () => {
        onSlice?.();
        return new ArrayBuffer(8);
      },
    }),
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as File;
}

describe('readWholeFileAbortable', () => {
  it('throws immediately on a pre-aborted signal, before reading a single slice', async () => {
    const c = new AbortController();
    c.abort();
    let sliced = false;
    await expect(
      readWholeFileAbortable(fakeFile(CHUNK * 2, () => (sliced = true)), c.signal),
    ).rejects.toBeInstanceOf(LoadCancelledError);
    expect(sliced).toBe(false); // never started the read
  });

  it('stops within one chunk when aborted mid-read', async () => {
    const total = CHUNK + 1; // two chunks
    const c = new AbortController();
    let sliceCalls = 0;
    const file = fakeFile(total, () => {
      sliceCalls += 1;
      if (sliceCalls === 1) c.abort(); // cancel after the first chunk lands
    });
    await expect(readWholeFileAbortable(file, c.signal)).rejects.toBeInstanceOf(LoadCancelledError);
    expect(sliceCalls).toBe(1); // did not go on to read the second chunk
  });

  it('reads the whole small file via the single-read path when not aborted', async () => {
    const buf = await readWholeFileAbortable(fakeFile(1024), undefined);
    expect(buf.byteLength).toBe(1024);
  });
});
