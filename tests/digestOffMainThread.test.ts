import { describe, it, expect, afterEach, vi } from 'vitest';
import { digestOffMainThread } from '../src/app/heavyLasExecutor';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { incrementalSha256Hex } from '../src/io/heavy/incrementalSha256';

/**
 * The whole-file digest runs in a worker. When that worker fails the answer
 * is null: the open proceeds with no reusable store and nothing claims a
 * digest that was not computed. The in-process hasher runs only where no
 * Worker exists at all, so a failure can never move a multi-gigabyte hash
 * onto the page's thread.
 */

const bytes = new Uint8Array(4096).map((_, i) => (i * 31) & 0xff);
const file = new File([bytes], 'heavy.las');
const openRange = () => new ArrayBufferRangeSource(bytes.buffer.slice(0));

afterEach(() => { vi.unstubAllGlobals(); });

describe('digestOffMainThread', () => {
  it('hashes in process only where no Worker exists', async () => {
    expect(typeof Worker).toBe('undefined');
    const made = vi.fn();
    const digest = await digestOffMainThread(file, bytes.byteLength, new AbortController().signal, openRange, made);
    expect(made).not.toHaveBeenCalled();
    expect(digest).toBe(incrementalSha256Hex(bytes));
  });

  it('returns null, never an in-process hash, when the worker fails', async () => {
    vi.stubGlobal('Worker', class {});
    const range = vi.fn(openRange);
    const digest = await digestOffMainThread(file, bytes.byteLength, new AbortController().signal, range, () => ({
      digest: async () => { throw new Error('worker died'); },
    }));
    expect(digest).toBeNull();
    expect(range).not.toHaveBeenCalled();
  });

  it('passes the worker answer through', async () => {
    vi.stubGlobal('Worker', class {});
    const digest = await digestOffMainThread(file, bytes.byteLength, new AbortController().signal, openRange, () => ({
      digest: async () => 'abc',
    }));
    expect(digest).toBe('abc');
  });
});
