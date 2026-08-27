/**
 * opfsSpillCost.test.ts — what an append to the OPFS spill store COSTS, and
 * what a build that never finishes leaves behind.
 *
 * `opfsSpillStore.test.ts` proves the store ends up holding the right bytes.
 * That is not enough on its own: a store that copies the whole tile on every
 * flush also ends up holding the right bytes, and that is precisely the defect
 * these cases exist to catch. So they measure device traffic and directory
 * contents rather than tile contents, against `tests/support/fakeOpfs.ts`,
 * which charges for the copy `createWritable({ keepExistingData: true })` is
 * specified to make and that Chromium was measured making.
 */
import { describe, it, expect } from 'vitest';
import { fakeOpfs, type FakeOpfsOptions, type FakeOpfsStats } from './support/fakeOpfs';
import {
  openOpfsSpillBuild,
  opfsSpillStore,
  PARTIAL_SUFFIX,
  readOpfsText,
  withOpfsSpillBuild,
  writeOpfsText,
} from '../src/io/heavy/opfsSpillStore';

/** Append `total` bytes to one tile in `appends` pieces; report what it cost. */
async function costOfAppending(
  appends: number,
  total: number,
  options: FakeOpfsOptions,
): Promise<FakeOpfsStats> {
  const fake = fakeOpfs(options);
  const store = opfsSpillStore(fake.root);
  const bytes = new Uint8Array(total / appends).fill(7);
  for (let i = 0; i < appends; i++) await store.append('012', bytes);
  await store.close();
  expect((await store.read('012')).length).toBe(total); // the bytes still land
  return fake.stats;
}

const TOTAL = 1 << 20;

describe('OPFS spill store append cost', () => {
  it('charges for the bytes appended, not for the tile they land in', async () => {
    const few = await costOfAppending(8, TOTAL, { syncAccess: true });
    const many = await costOfAppending(256, TOTAL, { syncAccess: true });

    // The same tile, built from 32x as many flushes, must cost the same.
    expect(few.bytesCopied + few.bytesWritten).toBe(TOTAL);
    expect(many.bytesCopied + many.bytesWritten).toBe(TOTAL);
    // And the file is opened once, not once per flush.
    expect(many.syncOpens).toBe(1);
    expect(many.writableOpens).toBe(0);
  });

  it('measures the writable fallback paying the copy the sync path avoids', async () => {
    // Not a regression guard: the fallback is what the platform gives when
    // there is no sync access handle, and its cost is what it is. The case is
    // here so the two paths are known to be DISTINGUISHABLE BY COST, without
    // which the case above could pass on either implementation.
    const many = await costOfAppending(256, TOTAL, {});
    // n appends of TOTAL/n bytes copy 0 + 1 + ... + (n-1) chunks first.
    expect(many.bytesCopied).toBe((TOTAL * 255) / 2);
    expect(many.bytesWritten).toBe(TOTAL);
    expect(many.writableOpens).toBe(256);

    const few = await costOfAppending(8, TOTAL, {});
    expect(many.bytesCopied / few.bytesCopied).toBeCloseTo(255 / 7, 5);
  });

  it('falls back when the handle offers a sync access handle but refuses to open one', async () => {
    // Capability detection has to survive the platform that advertises the
    // method in a context where it cannot be used; a presence check alone
    // would throw here rather than fall back.
    const stats = await costOfAppending(16, TOTAL, { syncAccessFails: 'refused' });
    expect(stats.syncOpens).toBe(0);
    expect(stats.writableOpens).toBe(16);
    expect(stats.bytesWritten).toBe(TOTAL);
  });

  it('reports which of the two write paths it actually got', async () => {
    const withSync = opfsSpillStore(fakeOpfs({ syncAccess: true }).root);
    expect(withSync.usesSyncAccess()).toBe(false); // nothing has been opened yet
    await withSync.append('0', new Uint8Array([1]));
    expect(withSync.usesSyncAccess()).toBe(true);
    await withSync.close();

    const withoutSync = opfsSpillStore(fakeOpfs({}).root);
    await withoutSync.append('0', new Uint8Array([1]));
    expect(withoutSync.usesSyncAccess()).toBe(false);
    await withoutSync.close();
  });

  it('does not read a malformed handle as a missing capability', async () => {
    // A DOMException from createSyncAccessHandle means not in this context, and
    // the store routes around it. A TypeError means the handle is not what it
    // claims, and routing around that would turn a fault into a slow build that
    // looks fine.
    const fake = fakeOpfs({ syncAccessFails: 'malformed' });
    const store = opfsSpillStore(fake.root);
    await expect(store.append('0', new Uint8Array([1]))).rejects.toThrow(TypeError);
    expect(fake.stats.writableOpens).toBe(0);
  });

  it('holds a bounded number of files open however many tiles are touched', async () => {
    const fake = fakeOpfs({ syncAccess: true });
    const store = opfsSpillStore(fake.root);
    const keys = Array.from({ length: 400 }, (_, i) => `k${i}`);
    // Two passes, so every tile is appended to after having been evicted.
    for (let pass = 0; pass < 2; pass++) {
      for (const key of keys) await store.append(key, new Uint8Array([pass]));
    }
    await store.close();

    expect(fake.stats.peakOpenSyncHandles).toBeLessThanOrEqual(64);
    expect(fake.stats.bytesCopied).toBe(0); // reopening never rereads the tile
    expect([...(await store.read('k7'))]).toEqual([0, 1]);
    expect((await store.keys()).length).toBe(400);
  });
});

describe('OPFS spill store write paths agree', () => {
  /** Build the same store twice over the same appends, on the two paths. */
  async function storeBuiltWith(options: FakeOpfsOptions): Promise<Map<string, Uint8Array>> {
    const fake = fakeOpfs(options);
    const store = opfsSpillStore(fake.root);
    // Interleaved keys and uneven chunks, so ordering and offsets both matter.
    for (let round = 0; round < 12; round++) {
      for (const key of ['', '0', '07', '073', '7']) {
        const n = 1 + ((round * 7 + key.length) % 23);
        await store.append(key, new Uint8Array(n).fill((round + key.length) & 0xff));
      }
    }
    await store.close();
    await writeOpfsText(fake.root, 'manifest.json', '{"round":"trip"}');
    expect(await readOpfsText(fake.root, 'manifest.json')).toBe('{"round":"trip"}');
    return fake.snapshot();
  }

  it('writes byte-identical stores through the sync handle and the writable stream', async () => {
    const viaSync = await storeBuiltWith({ syncAccess: true });
    const viaWritable = await storeBuiltWith({});

    expect([...viaSync.keys()].sort()).toEqual([...viaWritable.keys()].sort());
    expect([...viaSync.keys()].sort()).toEqual([
      '0.tile',
      '07.tile',
      '073.tile',
      '7.tile',
      'manifest.json',
      'root.tile',
    ]);
    for (const [name, bytes] of viaSync) {
      expect(`${name}:${[...bytes].join(',')}`).toBe(`${name}:${[...viaWritable.get(name)!].join(',')}`);
    }
  });
});

describe('OPFS spill store cancellation', () => {
  const NAME = 'cloud-abc123';

  async function appendSome(build: { store: { append(k: string, b: Uint8Array): Promise<void> } }): Promise<void> {
    for (const key of ['0', '1', '2']) await build.store.append(key, new Uint8Array(1024).fill(1));
  }

  it('keeps a build under a partial name until it is promoted', async () => {
    const fake = fakeOpfs({ syncAccess: true, fileMove: true });
    const build = await openOpfsSpillBuild(fake.root, NAME);
    expect(build.partialName).toBe(NAME + PARTIAL_SUFFIX);
    // The manifest is written BEFORE the last tile, so directory order alone
    // would relocate it in the middle and the ordering has to be deliberate.
    await build.store.append('0', new Uint8Array(1024).fill(1));
    await build.store.append('1', new Uint8Array(1024).fill(1));
    await writeOpfsText(build.dir, 'manifest.json', '{}');
    await build.store.append('2', new Uint8Array(1024).fill(1));

    // Nothing under the final name while the build is unfinished.
    expect(fake.topLevel()).toEqual([NAME + PARTIAL_SUFFIX]);

    await build.promote();
    expect(fake.topLevel()).toEqual([NAME]);
    expect([...fake.snapshot().keys()].sort()).toEqual([
      `${NAME}/0.tile`,
      `${NAME}/1.tile`,
      `${NAME}/2.tile`,
      `${NAME}/manifest.json`,
    ]);
    // A promotion that can rename files moves them; it does not rewrite them.
    expect(fake.stats.fileMoves).toBe(4);
    // And the manifest arrives last, so an interrupted promotion never leaves
    // a directory that `openTileStore` would accept.
    expect(fake.stats.movedNames.at(-1)).toBe('manifest.json');
  });

  it('leaves nothing behind when a build is cancelled', async () => {
    const fake = fakeOpfs({ syncAccess: true, fileMove: true });
    const controller = new AbortController();
    await expect(
      withOpfsSpillBuild(fake.root, NAME, async (build) => {
        await appendSome(build);
        controller.abort();
        controller.signal.throwIfAborted();
      }),
    ).rejects.toThrow();

    expect(fake.topLevel()).toEqual([]);
    expect(fake.totalBytes()).toBe(0);
  });

  it('leaves nothing behind when a build faults or runs out of space', async () => {
    for (const failure of ['fault', 'quota'] as const) {
      // 8 KiB of room: enough for the first tiles, not for the whole build.
      const fake = fakeOpfs({ syncAccess: true, fileMove: true, quotaBytes: failure === 'quota' ? 8192 : undefined });
      await expect(
        withOpfsSpillBuild(fake.root, NAME, async (build) => {
          for (let i = 0; i < 64; i++) await build.store.append(`k${i}`, new Uint8Array(1024).fill(2));
          if (failure === 'fault') throw new Error('the decoder gave up');
        }),
      ).rejects.toThrow();

      expect(fake.topLevel()).toEqual([]);
      expect(fake.totalBytes()).toBe(0);
    }
  });

  it('clears an abandoned partial store before starting the next build', async () => {
    const fake = fakeOpfs({ syncAccess: true, fileMove: true });
    // A previous session died without cleaning up.
    const orphan = await fake.root.getDirectoryHandle(NAME + PARTIAL_SUFFIX, { create: true });
    await writeOpfsText(orphan, 'stale.tile', 'bytes from a build that never finished');
    expect(fake.totalBytes()).toBeGreaterThan(0);

    const build = await openOpfsSpillBuild(fake.root, NAME);
    expect(fake.totalBytes()).toBe(0);
    await appendSome(build);
    await build.promote();
    expect([...fake.snapshot().keys()].sort()).toEqual([`${NAME}/0.tile`, `${NAME}/1.tile`, `${NAME}/2.tile`]);
  });

  it('leaves no half-promoted store when the promotion itself fails', async () => {
    // Room for the store but not for a relocation that has to copy: the first
    // file fails, and the final name must not survive the attempt.
    const fake = fakeOpfs({ syncAccess: true, fileMove: false, quotaBytes: 3 * 4096 + 1000 });
    const build = await openOpfsSpillBuild(fake.root, NAME);
    for (const key of ['0', '1', '2']) await build.store.append(key, new Uint8Array(4096).fill(3));

    await expect(build.promote()).rejects.toThrow();
    expect(fake.topLevel()).toEqual([NAME + PARTIAL_SUFFIX]);

    await build.discard();
    expect(fake.topLevel()).toEqual([]);
    expect(fake.totalBytes()).toBe(0);
  });

  it('reads a tile back after releasing the handle that was appending to it', async () => {
    // A sync access handle need not publish its writes before it is closed, so
    // a read that did not release first could see a short tile.
    const fake = fakeOpfs({ syncAccess: true });
    const store = opfsSpillStore(fake.root);
    for (let i = 0; i < 5; i++) await store.append('0', new Uint8Array([i]));
    expect([...(await store.read('0'))]).toEqual([0, 1, 2, 3, 4]);
    // And appending afterwards resumes at the end rather than at zero.
    await store.append('0', new Uint8Array([9]));
    expect([...(await store.read('0'))]).toEqual([0, 1, 2, 3, 4, 9]);
    await store.close();
  });

  it('promotes without a file rename by relocating one file at a time', async () => {
    // The engine that has no FileSystemFileHandle.move must still promote, and
    // must not need a second copy of the whole store to do it.
    const fake = fakeOpfs({ syncAccess: true, fileMove: false });
    const { dir } = await withOpfsSpillBuild(fake.root, NAME, async (build) => {
      for (const key of ['0', '1', '2']) await build.store.append(key, new Uint8Array(4096).fill(3));
      await writeOpfsText(build.dir, 'manifest.json', '{"promoted":true}');
    });

    expect(fake.stats.fileMoves).toBe(0);
    expect(fake.topLevel()).toEqual([NAME]);
    expect(await readOpfsText(dir, 'manifest.json')).toBe('{"promoted":true}');
    for (const key of ['0', '1', '2']) {
      const bytes = fake.snapshot().get(`${NAME}/${key}.tile`)!;
      expect(bytes.length).toBe(4096);
      expect(bytes.every((b) => b === 3)).toBe(true);
    }
    // Peak occupancy never held two copies of the store: 3 tiles + a manifest.
    expect(fake.totalBytes()).toBe(3 * 4096 + '{"promoted":true}'.length);
  });
});
