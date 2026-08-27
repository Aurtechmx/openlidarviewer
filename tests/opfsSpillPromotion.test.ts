/**
 * opfsSpillPromotion.test.ts — the `move`-absent promotion copy stays bounded.
 *
 * Promotion moves each tile from the `.partial` store into the final one. Where
 * `FileSystemFileHandle.move` exists (Chromium) the bytes never move and nothing
 * is read. Where it is absent (Safari today) the store copies the bytes itself,
 * and the defect these tests pin is that the copy must not read the whole tile
 * into memory: a degenerate cloud can settle almost the entire dataset in one
 * node, and `arrayBuffer()` on that tile would defeat the out-of-core guarantee
 * at the last step. The fake records every `arrayBuffer()` read size, so a
 * whole-file read is observable and a windowed copy is provably bounded.
 */
import { describe, it, expect } from 'vitest';
import {
  openOpfsSpillBuild,
  PROMOTION_COPY_CHUNK_BYTES,
} from '../src/io/heavy/opfsSpillStore';
import { fakeOpfs } from './support/fakeOpfs';

/** A tile just over one window, so the fallback must copy in more than one piece. */
const TILE_BYTES = PROMOTION_COPY_CHUNK_BYTES + 1024;

function patternTile(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

function bytesUnder(fs: ReturnType<typeof fakeOpfs>, name: string): Uint8Array {
  const entry = [...fs.snapshot()].find(([path]) => path.endsWith(name));
  if (entry === undefined) throw new Error(`no file ending in ${name}`);
  return entry[1];
}

describe('OPFS spill promotion', () => {
  it('copies a multi-chunk tile without ever reading the whole tile, byte-identical, when move() is absent', async () => {
    const fs = fakeOpfs({ syncAccess: true, fileMove: false });
    const build = await openOpfsSpillBuild(fs.root, 'store');
    const tile = patternTile(TILE_BYTES);
    await build.store.append('3', tile);

    // Discard the write-path bookkeeping; we only judge the promotion copy.
    fs.stats.arrayBufferReads.length = 0;

    await build.promote();

    // The heart of the fix: no single read is the whole tile. Every read the
    // fallback made is one window or less.
    expect(fs.stats.arrayBufferReads.length).toBeGreaterThan(1);
    expect(Math.max(...fs.stats.arrayBufferReads)).toBeLessThanOrEqual(PROMOTION_COPY_CHUNK_BYTES);
    expect(fs.stats.arrayBufferReads.some((n) => n === TILE_BYTES)).toBe(false);

    // No move() available, so nothing took the zero-copy path.
    expect(fs.stats.fileMoves).toBe(0);

    // Byte-identity: the promoted tile equals the source tile exactly.
    const promoted = bytesUnder(fs, 'store/3.tile');
    expect(promoted.length).toBe(TILE_BYTES);
    expect(Buffer.from(promoted).equals(Buffer.from(tile))).toBe(true);

    // The source is gone; only one copy survives.
    expect(fs.topLevel()).toEqual(['store']);
  });

  it('takes the zero-copy move() fast path with no read or slice when move() is present', async () => {
    const fs = fakeOpfs({ syncAccess: true, fileMove: true });
    const build = await openOpfsSpillBuild(fs.root, 'store');
    const tile = patternTile(TILE_BYTES);
    await build.store.append('3', tile);

    fs.stats.arrayBufferReads.length = 0;

    await build.promote();

    // Fast path: one move, zero bytes read.
    expect(fs.stats.movedNames).toContain('3.tile');
    expect(fs.stats.arrayBufferReads.length).toBe(0);

    const promoted = bytesUnder(fs, 'store/3.tile');
    expect(Buffer.from(promoted).equals(Buffer.from(tile))).toBe(true);
  });
});
