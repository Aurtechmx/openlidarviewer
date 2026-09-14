/**
 * localOpenHeadRead.test.ts
 *
 * A local LAS/LAZ open used to read the file's prefix three times, from
 * offset 0, sequentially on the main thread: 4 KiB for the COPC sniff, 64 KiB
 * for the heavy peek, 16 KiB for the loader's preflight, with the header
 * parsed and the plan built twice. `openScan` now reads the first 64 KiB once
 * and hands the bytes to both consumers. Each consumer takes exactly the
 * prefix it would have read, so nothing downstream sees a different input.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadFile } from '../src/io/loadFile';
import { openLocalHeavyLas, HEADER_PEEK_BYTES, type HeavyLasBridgeDeps } from '../src/app/openLocalHeavyLas';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';

/** A File stand-in that counts the slices asked of it. */
function countingFile(name: string, bytes: Uint8Array) {
  const slices: Array<[number, number]> = [];
  const file = {
    name,
    size: bytes.byteLength,
    slice: (start = 0, end = bytes.byteLength) => {
      slices.push([start, end]);
      return { arrayBuffer: async (): Promise<ArrayBuffer> => bytes.slice(start, Math.min(end, bytes.byteLength)).buffer as ArrayBuffer };
    },
    arrayBuffer: async () => bytes.buffer.slice(0),
  } as unknown as File;
  return { file, slices };
}

describe('the generic loader takes a pre-read head', () => {
  // An unrecognised format is refused at preflight, before any body read or
  // worker, so the only file access under test is the prefix read itself.
  const junk = new Uint8Array(4096).fill(0x2a);

  it('slices the file once for its prefix when no head is supplied', async () => {
    const { file, slices } = countingFile('scan.unknownformat', junk);
    await expect(loadFile(file, {}, {})).rejects.toThrow(/Unrecognised file format/);
    expect(slices).toHaveLength(1);
    expect(slices[0][0]).toBe(0);
  });

  it('issues no slice of its own when the caller hands it the prefix', async () => {
    const { file, slices } = countingFile('scan.unknownformat', junk);
    const head = junk.buffer.slice(0) as ArrayBuffer;
    await expect(loadFile(file, {}, { head })).rejects.toThrow(/Unrecognised file format/);
    expect(slices).toHaveLength(0);
  });

  it('reads for itself when the supplied head is shorter than it needs', async () => {
    const { file, slices } = countingFile('scan.unknownformat', junk);
    const short = junk.buffer.slice(0, 100) as ArrayBuffer;
    await expect(loadFile(file, {}, { head: short })).rejects.toThrow(/Unrecognised file format/);
    expect(slices).toHaveLength(1);
  });
});

describe('the heavy peek takes the same bytes', () => {
  const laz = readFileSync(resolve(__dirname, 'fixtures', 'multichunk.laz'));
  const buffer = laz.buffer.slice(laz.byteOffset, laz.byteOffset + laz.byteLength) as ArrayBuffer;
  const deps = {
    renderBudget: 1_000_000,
    isPhone: () => false,
    deviceMemoryGB: () => 8,
  } as unknown as HeavyLasBridgeDeps;

  it('issues no range read when the caller supplies at least 64 KiB, and decides the same', async () => {
    const head = buffer.slice(0, Math.min(buffer.byteLength, HEADER_PEEK_BYTES));
    const range = new ArrayBufferRangeSource(buffer, 'multichunk.laz');
    const readRange = vi.spyOn(range, 'readRange');
    const result = await openLocalHeavyLas({ name: 'multichunk.laz' } as File, new AbortController().signal, deps, {
      openRange: () => range,
      head,
    });
    // A small fixture is not heavy either way; what changed is how it found out.
    expect(result.status).toBe('not-heavy');
    expect(readRange).not.toHaveBeenCalled();
  });

  it('reads for itself when no head is supplied', async () => {
    const range = new ArrayBufferRangeSource(buffer, 'multichunk.laz');
    const readRange = vi.spyOn(range, 'readRange');
    const result = await openLocalHeavyLas({ name: 'multichunk.laz' } as File, new AbortController().signal, deps, {
      openRange: () => range,
    });
    expect(result.status).toBe('not-heavy');
    expect(readRange).toHaveBeenCalledTimes(1);
    expect(readRange.mock.calls[0][0]).toBe(0);
  });
});
