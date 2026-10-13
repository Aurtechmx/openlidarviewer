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
import { readWholeFileAbortable, readProgress, LoadCancelledError } from '../src/io/loadFile';
import type { ProgressUpdate } from '../src/io/loadFile';

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

/** Byte `i` of the patterned file: varies within and across chunks, never all zero. */
const byteAt = (i: number): number => (i * 131 + (i >>> 16) * 7 + 13) & 0xff;

/**
 * A File-like whose slices hold real, position-dependent bytes, so a chunk
 * copied to the wrong offset shows up as a byte mismatch. `hooks` run inside
 * each slice read (before it resolves) and may abort or throw.
 */
function patternFile(size: number, hooks: { onRead?: (start: number, end: number) => void } = {}): File & { reads: number } {
  const file = {
    size,
    reads: 0,
    slice: (start: number, end: number) => ({
      arrayBuffer: async () => {
        file.reads += 1;
        hooks.onRead?.(start, end);
        const out = new Uint8Array(end - start);
        for (let k = 0; k < out.length; k++) out[k] = byteAt(start + k);
        return out.buffer;
      },
    }),
    arrayBuffer: async () => {
      file.reads += 1;
      hooks.onRead?.(0, size);
      const out = new Uint8Array(size);
      for (let k = 0; k < size; k++) out[k] = byteAt(k);
      return out.buffer;
    },
  };
  return file as unknown as File & { reads: number };
}

describe('readWholeFileAbortable progress', () => {
  it('reports the start and the end only on the single-read path', async () => {
    const seen: Array<[number, number]> = [];
    const buf = await readWholeFileAbortable(patternFile(4096), undefined, (r, t) => seen.push([r, t]));
    expect(buf.byteLength).toBe(4096);
    expect(seen).toEqual([[0, 4096], [4096, 4096]]);
  });

  it('reports monotonic progress per chunk and ends exactly at the total, partial last chunk included', async () => {
    const total = CHUNK * 2 + 12_345;
    const seen: Array<[number, number]> = [];
    await readWholeFileAbortable(patternFile(total), undefined, (r, t) => seen.push([r, t]));
    expect(seen).toEqual([[0, total], [CHUNK, total], [CHUNK * 2, total], [total, total]]);
    for (let k = 1; k < seen.length; k++) expect(seen[k][0]).toBeGreaterThan(seen[k - 1][0]);
    expect(seen.filter(([r]) => r === total)).toHaveLength(1);
  });

  it('returns byte-identical output with and without the callback', async () => {
    const total = CHUNK + 777;
    const plain = new Uint8Array(await readWholeFileAbortable(patternFile(total), undefined));
    const withProgress = new Uint8Array(
      await readWholeFileAbortable(patternFile(total), undefined, () => {}),
    );
    expect(Buffer.compare(Buffer.from(plain), Buffer.from(withProgress))).toBe(0);
    // And both hold the source's bytes at the chunk seam and the tail.
    for (const i of [0, CHUNK - 1, CHUNK, CHUNK + 1, total - 1]) expect(withProgress[i]).toBe(byteAt(i));
    const small = new Uint8Array(await readWholeFileAbortable(patternFile(5000), undefined, () => {}));
    expect(Buffer.compare(Buffer.from(small), Buffer.from(new Uint8Array(await readWholeFileAbortable(patternFile(5000), undefined))))).toBe(0);
  });

  it('reads nothing and reports nothing on a pre-aborted signal', async () => {
    const c = new AbortController();
    c.abort();
    const file = patternFile(CHUNK * 2);
    const seen: number[] = [];
    await expect(readWholeFileAbortable(file, c.signal, (r) => seen.push(r))).rejects.toBeInstanceOf(LoadCancelledError);
    expect(file.reads).toBe(0);
    expect(seen).toEqual([]);
  });

  it('never reports completion when aborted mid-read', async () => {
    const total = CHUNK * 3;
    const c = new AbortController();
    const file = patternFile(total, { onRead: (start) => { if (start === CHUNK) c.abort(); } });
    const seen: number[] = [];
    await expect(readWholeFileAbortable(file, c.signal, (r) => seen.push(r))).rejects.toBeInstanceOf(LoadCancelledError);
    expect(seen).toEqual([0, CHUNK]);
    expect(file.reads).toBe(2);
  });

  it('never reports completion when aborted during the final read', async () => {
    const total = CHUNK + 10;
    const c = new AbortController();
    const file = patternFile(total, { onRead: (_s, end) => { if (end === total) c.abort(); } });
    const seen: number[] = [];
    await expect(readWholeFileAbortable(file, c.signal, (r) => seen.push(r))).rejects.toBeInstanceOf(LoadCancelledError);
    expect(seen).toEqual([0, CHUNK]);
    // The single-read path rechecks after its one read too.
    const c2 = new AbortController();
    const smallSeen: number[] = [];
    const small = patternFile(100, { onRead: () => c2.abort() });
    await expect(readWholeFileAbortable(small, c2.signal, (r) => smallSeen.push(r))).rejects.toBeInstanceOf(LoadCancelledError);
    expect(smallSeen).toEqual([0]);
  });

  it('reports a zero-byte file once, with no NaN or Infinity in the stage update', async () => {
    const seen: Array<[number, number]> = [];
    const buf = await readWholeFileAbortable(patternFile(0), undefined, (r, t) => seen.push([r, t]));
    expect(buf.byteLength).toBe(0);
    expect(seen).toEqual([[0, 0]]);
    const updates: ProgressUpdate[] = [];
    readProgress((u) => updates.push(u))(0, 0);
    expect(updates[0].stage).toBe('reading-file');
    expect(updates[0].fraction).toBeUndefined();
    expect(updates[0].detail).not.toMatch(/NaN|Infinity/);
  });

  it('maps bytes to a reading-file fraction within [0, 1]', () => {
    const updates: ProgressUpdate[] = [];
    const report = readProgress((u) => updates.push(u));
    report(0, 1000);
    report(500, 1000);
    report(1000, 1000);
    expect(updates.map((u) => u.fraction)).toEqual([0, 0.5, 1]);
    expect(updates.every((u) => u.stage === 'reading-file')).toBe(true);
    expect(updates[1].detail).toBe('500 B of 1000 B');
  });

  it('never reports completion when a read fails', async () => {
    const total = CHUNK + 10;
    const file = patternFile(total, { onRead: (start) => { if (start === CHUNK) throw new Error('disk gone'); } });
    const seen: number[] = [];
    await expect(readWholeFileAbortable(file, undefined, (r) => seen.push(r))).rejects.toThrow('disk gone');
    expect(seen).toEqual([0, CHUNK]);
    const small = patternFile(10, { onRead: () => { throw new Error('denied'); } });
    const smallSeen: number[] = [];
    await expect(readWholeFileAbortable(small, undefined, (r) => smallSeen.push(r))).rejects.toThrow('denied');
    expect(smallSeen).toEqual([0]);
  });
});
