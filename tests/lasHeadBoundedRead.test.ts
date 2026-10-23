/**
 * lasHeadBoundedRead.test.ts: the ranged LAS and LAZ loaders read the header
 * and its VLRs in bounded ranges, whatever the header claims.
 *
 * The public header names where the point data starts, and everything before
 * that is header records and padding. A corrupt or hostile offset must not size
 * an allocation: the loaders read at most the VLR budget, skip padding after
 * the last VLR, and refuse by name a VLR block that runs past the budget. The
 * file here claims to be 4 GiB and serves only the bytes it was built with, so
 * no test allocates anything large.
 */
import { describe, it, expect, vi } from 'vitest';
import { loadLas, loadLasFromFile, loadLazFromFile } from '../src/io/loadLas';
import { MAX_RANGE_VLR_BLOCK_BYTES } from '../src/io/crs';
import { lasBytes } from './support/heavyLasFakes';

vi.mock('../src/io/heavy/worker/lazChunkWorkerClient', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/io/heavy/worker/lazChunkWorkerClient')>();
  return { ...real, decodeLazPooledFromSource: async () => null };
});

const GIB = 1024 ** 3;
const OFFSET_TO_POINT_DATA = 96;
const OFFSET_NUM_VLR = 100;
/** The largest single read a loader may make: a point window or the VLR budget. */
const POINT_WINDOW_BYTES = 8 << 20;

/** A File that reports `size` but holds only `bytes`, and records every range asked of it. */
function claimedFile(bytes: Uint8Array, size: number, name: string): { file: File; reads: [number, number][] } {
  const reads: [number, number][] = [];
  const file = {
    name,
    size,
    slice(from = 0, to = size): Blob {
      reads.push([from, to]);
      return new Blob([bytes.slice(Math.min(from, bytes.length), Math.min(to, bytes.length))]);
    },
    arrayBuffer: async (): Promise<ArrayBuffer> => { throw new Error('the file must not be read whole'); },
  } as unknown as File;
  return { file, reads };
}

/** A real LAS header whose fields are then rewritten. */
function headerWith(edit: (view: DataView) => void, extraBytes = 0): Uint8Array {
  const base = new Uint8Array(lasBytes(4));
  const out = new Uint8Array(base.length + extraBytes);
  out.set(base);
  edit(new DataView(out.buffer));
  return out;
}

const loaders = [
  ['LAS', (f: File) => loadLasFromFile(f, 'claimed.las')],
  ['LAZ', (f: File) => loadLazFromFile(f, 'claimed.laz')],
] as const;

describe('the header read is bounded', () => {
  for (const [kind, load] of loaders) {
    it(`${kind}: a 3 GiB offset to the points in a 4 GiB file reads no more than the budget`, async () => {
      const bytes = headerWith((v) => v.setUint32(OFFSET_TO_POINT_DATA, 3 * GIB, true));
      const { file, reads } = claimedFile(bytes, 4 * GIB, `claimed.${kind.toLowerCase()}`);
      await load(file).catch(() => undefined);
      expect(reads.length).toBeGreaterThan(0);
      const largest = Math.max(...reads.map(([from, to]) => to - from));
      expect(largest).toBeLessThanOrEqual(Math.max(POINT_WINDOW_BYTES, MAX_RANGE_VLR_BLOCK_BYTES));
      // The read the review reproduced: everything from the peek to the stated offset.
      expect(reads.some(([from, to]) => from === 0 && to === 3 * GIB)).toBe(false);
    });

    it(`${kind}: VLRs that run past the budget are refused by name`, async () => {
      // 100,000 empty VLRs: 5.4 MB of headers ahead of points 3 GiB in.
      const bytes = headerWith((v) => {
        v.setUint32(OFFSET_TO_POINT_DATA, 3 * GIB, true);
        v.setUint32(OFFSET_NUM_VLR, 100_000, true);
      }, MAX_RANGE_VLR_BLOCK_BYTES);
      const { file, reads } = claimedFile(bytes, 4 * GIB, `claimed.${kind.toLowerCase()}`);
      await expect(load(file)).rejects.toThrow(/header records \(VLRs\) that run past 4 MiB/);
      expect(Math.max(...reads.map(([from, to]) => to - from))).toBeLessThanOrEqual(MAX_RANGE_VLR_BLOCK_BYTES);
    });

    it(`${kind}: an offset beyond the end of the file is not read up to`, async () => {
      const bytes = headerWith((v) => v.setUint32(OFFSET_TO_POINT_DATA, 4 * GIB - 1, true));
      const { file, reads } = claimedFile(bytes, 2 * GIB, `claimed.${kind.toLowerCase()}`);
      await load(file).catch(() => undefined);
      expect(Math.max(...reads.map(([from, to]) => to - from))).toBeLessThanOrEqual(Math.max(POINT_WINDOW_BYTES, MAX_RANGE_VLR_BLOCK_BYTES));
    });
  }

  it('a normal LAS still reads the same records as the whole-file decode', async () => {
    const buffer = lasBytes(5_000);
    const whole = await loadLas(buffer, 'las', 'grid.las', 3);
    const ranged = await loadLasFromFile(new File([buffer], 'grid.las'), 'grid.las', 3);
    expect(Array.from(ranged.positions)).toEqual(Array.from(whole.positions));
    expect(ranged.metadata?.crs ?? null).toEqual(whole.metadata?.crs ?? null);
  });
});
