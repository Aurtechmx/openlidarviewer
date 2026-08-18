/**
 * opfsSpillStore.ts — the browser's durable backing for out-of-core tiles.
 *
 * The indexer writes leaf tiles through a {@link SpillStore}; in the browser
 * that store is an Origin Private File System directory, one file per leaf key
 * (`<key>.tile`, the empty root key written as `root.tile`). Appends concatenate,
 * so a leaf that spills across several flushes ends as one contiguous tile, and
 * the same directory holds the store's `manifest.json` and `hierarchy.txt`.
 *
 * It is written against a NARROW structural view of the OPFS API — only the
 * handful of methods it calls — so a real `FileSystemDirectoryHandle` satisfies
 * it directly in the browser, and a small in-memory fake satisfies it in a Node
 * test. OPFS itself is not available in Node, so the fake is how the append and
 * key-mapping logic is unit-tested; the real handle is exercised in the browser.
 */
import type { SpillStore } from './oocIndexer';

/** The OPFS surface this module uses; a subset the real handles already provide. */
export interface OpfsWritable {
  write(data: Uint8Array): Promise<void>;
  seek(offset: number): Promise<void>;
  close(): Promise<void>;
}
export interface OpfsFile {
  readonly size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}
export interface OpfsFileHandle {
  getFile(): Promise<OpfsFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
}
export interface OpfsDirHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  keys(): AsyncIterableIterator<string>;
}

const TILE_SUFFIX = '.tile';
const ROOT_TILE = 'root';

function tileFileName(key: string): string {
  return (key === '' ? ROOT_TILE : key) + TILE_SUFFIX;
}

function keyFromFileName(name: string): string {
  const base = name.slice(0, -TILE_SUFFIX.length);
  return base === ROOT_TILE ? '' : base;
}

/** A {@link SpillStore} over an OPFS directory. */
export function opfsSpillStore(dir: OpfsDirHandle): SpillStore {
  return {
    async append(key, bytes) {
      const handle = await dir.getFileHandle(tileFileName(key), { create: true });
      // Append: keep what is there, seek to the end, write. Several flushes for
      // one leaf therefore concatenate into a single contiguous tile.
      const size = (await handle.getFile()).size;
      const writable = await handle.createWritable({ keepExistingData: true });
      await writable.seek(size);
      await writable.write(bytes);
      await writable.close();
    },
    async read(key) {
      const handle = await dir.getFileHandle(tileFileName(key));
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    },
    async keys() {
      const out: string[] = [];
      for await (const name of dir.keys()) {
        if (name.endsWith(TILE_SUFFIX)) out.push(keyFromFileName(name));
      }
      return out;
    },
  };
}

/** Write a text artifact (the manifest or hierarchy) into the store directory. */
export async function writeOpfsText(dir: OpfsDirHandle, name: string, text: string): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  // No keepExistingData: a manifest rewrite must replace, not append.
  const writable = await handle.createWritable();
  await writable.write(new TextEncoder().encode(text));
  await writable.close();
}

/** Read a text artifact back from the store directory. */
export async function readOpfsText(dir: OpfsDirHandle, name: string): Promise<string> {
  const handle = await dir.getFileHandle(name);
  return (await handle.getFile()).text();
}
