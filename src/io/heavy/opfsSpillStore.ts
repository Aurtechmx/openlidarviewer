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
 *
 * WHY THE APPEND IS NOT A WRITABLE STREAM. `createWritable({ keepExistingData:
 * true })` is specified to start its swap file as a COPY of the file it will
 * replace, so appending to a tile costs the tile, not the append. A leaf touched
 * once per flush cycle is therefore rewritten once per flush cycle, and a build
 * that flushes thousands of times pays quadratically in the number of appends
 * for a result that is linear in bytes. Measured in Chromium 142: thirty-two
 * 4 KiB appends onto an empty file take 36 ms, onto a 64 MiB file 4120 ms, the
 * same 128 KiB of payload either way. The primitive that does not do this is
 * `FileSystemSyncAccessHandle` — open once, `write(bytes, { at })` many times,
 * `close()` — which is what {@link opfsSpillStore} uses when it can get one.
 *
 * WHY THE WRITABLE PATH SURVIVES ANYWAY. `createSyncAccessHandle` is exposed
 * only inside a worker (absent on Chromium's main thread, confirmed by probe)
 * and is not implemented everywhere at all. So the store DETECTS the primitive
 * on the handle it was given and falls back to the writable stream when it is
 * missing or refuses to open. The choice is made from the handle, never from a
 * user-agent string, and both paths write the same bytes in the same order.
 */
import type { SpillStore } from './oocIndexer';
import { TILE_MANIFEST_NAME } from './tileStoreBuilder';

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
/**
 * The worker-only random-access handle. Its methods are synchronous in the
 * current specification and returned promises in earlier Chromium, so the
 * results are typed as either and awaited; a real handle satisfies this either
 * way, and awaiting a number is a no-op.
 */
export interface OpfsSyncAccessHandle {
  write(data: Uint8Array, options?: { at?: number }): number | PromiseLike<number>;
  getSize(): number | PromiseLike<number>;
  flush(): void | PromiseLike<void>;
  close(): void | PromiseLike<void>;
}
export interface OpfsFileHandle {
  getFile(): Promise<OpfsFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<OpfsWritable>;
  /** Present only where the platform implements it; see the header. */
  createSyncAccessHandle?(): Promise<OpfsSyncAccessHandle>;
  /**
   * Relocate the file. Implemented for FILES in OPFS but not for directories,
   * which is why {@link OpfsSpillBuild.promote} moves entries rather than the
   * directory holding them. Optional: some engines expose neither.
   */
  move?(destination: OpfsDirHandle, name?: string): Promise<void>;
}
export interface OpfsDirHandle {
  getFileHandle(name: string, options?: { create?: boolean }): Promise<OpfsFileHandle>;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<OpfsDirHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  keys(): AsyncIterableIterator<string>;
}

const TILE_SUFFIX = '.tile';
const ROOT_TILE = 'root';

/**
 * Marks a directory as a build in progress. A store under this suffix is never
 * a store a reader may open: it is whatever the indexer had written when it
 * stopped, and the only two things that legitimately happen to it are promotion
 * and deletion.
 */
export const PARTIAL_SUFFIX = '.partial';

/**
 * How many tile files may hold an open sync access handle at once. A handle is
 * an OS file descriptor and an exclusive lock, and a build touches thousands of
 * nodes, so they cannot all stay open; the least recently appended is closed to
 * make room. The cap only bounds descriptors — a reopened tile keeps appending
 * at its own end, so no bytes are copied when one is evicted and later reopened.
 */
const MAX_OPEN_TILE_HANDLES = 64;

function tileFileName(key: string): string {
  return (key === '' ? ROOT_TILE : key) + TILE_SUFFIX;
}

function keyFromFileName(name: string): string {
  const base = name.slice(0, -TILE_SUFFIX.length);
  return base === ROOT_TILE ? '' : base;
}

/** A store that also owns file handles, so a caller can release them. */
export interface OpfsSpillStore extends SpillStore {
  /**
   * Close every open tile handle, flushing what they hold. Idempotent, and
   * required before another context may open the same files.
   */
  close(): Promise<void>;
  /** True once an append has actually opened a sync access handle. */
  usesSyncAccess(): boolean;
}

/** One tile file held open, with the offset its next append goes to. */
interface OpenTile {
  readonly handle: OpfsSyncAccessHandle;
  size: number;
}

/**
 * A {@link SpillStore} over an OPFS directory.
 *
 * Appends go through a sync access handle held open across flushes when the
 * platform provides one, and through a writable stream when it does not. The
 * two produce identical files; they differ only in what they cost.
 */
export function opfsSpillStore(dir: OpfsDirHandle): OpfsSpillStore {
  // Insertion-ordered, so the first key is the least recently appended.
  const open = new Map<string, OpenTile>();
  // undefined until the first append has asked; false once the platform has
  // been found not to offer the primitive, and it is never asked again.
  let syncUsable: boolean | undefined;

  async function closeTile(name: string): Promise<void> {
    const tile = open.get(name);
    if (tile === undefined) return;
    open.delete(name);
    await tile.handle.close();
  }

  /**
   * The open handle for `name`, opening one if needed, or undefined when this
   * platform has no sync access handles. Capability detection, not sniffing:
   * the method is looked for on the handle and then actually called, because a
   * platform may expose it in a context where it refuses to open.
   */
  async function acquire(name: string): Promise<OpenTile | undefined> {
    if (syncUsable === false) return undefined;
    const existing = open.get(name);
    if (existing !== undefined) {
      // Refresh its place in the eviction order.
      open.delete(name);
      open.set(name, existing);
      return existing;
    }
    const handle = await dir.getFileHandle(name, { create: true });
    if (typeof handle.createSyncAccessHandle !== 'function') {
      syncUsable = false;
      return undefined;
    }
    // Make room BEFORE opening, so the cap counts handles actually held rather
    // than handles held after the newest one has already been added.
    while (open.size >= MAX_OPEN_TILE_HANDLES) {
      const oldest = open.keys().next();
      if (oldest.done === true) break;
      await closeTile(oldest.value);
    }
    let access: OpfsSyncAccessHandle;
    try {
      access = await handle.createSyncAccessHandle();
    } catch (err) {
      // Exposed but unusable in this context. A refusal arrives as a
      // DOMException; a TypeError means the handle is not the shape this
      // module thinks it is, which is a fault in the caller rather than a
      // capability to route around, so it is not swallowed.
      if (err instanceof TypeError) throw err;
      syncUsable = false;
      return undefined;
    }
    syncUsable = true;
    const tile: OpenTile = { handle: access, size: await access.getSize() };
    open.set(name, tile);
    return tile;
  }

  /**
   * The fallback append. Kept verbatim from the writable-stream version this
   * module started as, so a platform without sync access handles gets exactly
   * the behaviour it had before, whole-file copy included.
   */
  async function appendViaWritable(name: string, bytes: Uint8Array): Promise<void> {
    const handle = await dir.getFileHandle(name, { create: true });
    // Append: keep what is there, seek to the end, write. Several flushes for
    // one leaf therefore concatenate into a single contiguous tile.
    const size = (await handle.getFile()).size;
    const writable = await handle.createWritable({ keepExistingData: true });
    await writable.seek(size);
    await writable.write(bytes);
    await writable.close();
  }

  return {
    async append(key, bytes) {
      const name = tileFileName(key);
      const tile = await acquire(name);
      if (tile !== undefined) {
        // One write at the running end. Nothing already in the tile is read,
        // rewritten or copied, so the cost is the length of `bytes`.
        await tile.handle.write(bytes, { at: tile.size });
        tile.size += bytes.length;
        return;
      }
      await appendViaWritable(name, bytes);
    },
    async read(key) {
      const name = tileFileName(key);
      // A sync access handle takes an exclusive lock and its buffered writes
      // need not be visible through getFile(), so the tile is released first.
      await closeTile(name);
      const handle = await dir.getFileHandle(name);
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
    async clear() {
      // The single-pass path spills before it can prove the header, so it needs
      // a pristine store to fall back into: remove every tile. Only the `.tile`
      // files are the store's spill; the manifest and hierarchy are written
      // later by the builder and are left untouched. Close each tile's handle
      // first so the removal is not racing an exclusive lock, then delete the
      // file. `removeEntry` on an absent name races nothing here (the names come
      // from the directory), but a handle closed above may leave the entry, so a
      // NotFoundError is swallowed as a no-op.
      const names: string[] = [];
      for await (const name of dir.keys()) {
        if (name.endsWith(TILE_SUFFIX)) names.push(name);
      }
      for (const name of names) {
        await closeTile(name);
        try {
          await dir.removeEntry(name);
        } catch (err) {
          if ((err as { name?: string } | null)?.name !== 'NotFoundError') throw err;
        }
      }
    },
    async close() {
      for (const name of [...open.keys()]) await closeTile(name);
    },
    usesSyncAccess() {
      return syncUsable === true;
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

// ── the partial store ───────────────────────────────────────────────────────
//
// An index that stops halfway is not a small problem. The tiles it wrote are
// the size of the scan, they are indistinguishable from a finished store by
// their contents, and nothing ever comes back for them, so a user who cancels
// at seventy-three percent loses that disk until they clear site data. So a
// build writes into `<name>.partial` and that directory is either PROMOTED, in
// one pass at the end once the manifest is on disk, or DELETED. There is no
// third outcome, and no state in which a half-written store carries a name a
// reader would open.

/** A build in progress, and the two ways it is allowed to end. */
export interface OpfsSpillBuild {
  /** Where the indexer writes tiles. */
  readonly store: OpfsSpillStore;
  /** The partial directory itself, for the manifest and hierarchy. */
  readonly dir: OpfsDirHandle;
  /** `<name>.partial`, the directory the tiles are actually in. */
  readonly partialName: string;
  /** The name the store takes once it is finished. */
  readonly finalName: string;
  /**
   * Move the finished store to {@link finalName}. Call only after the manifest
   * and hierarchy have been written. Resolves to the promoted directory.
   */
  promote(): Promise<OpfsDirHandle>;
  /**
   * Delete the partial store. Call on cancel, on error and on a quota failure.
   * Safe to call twice, and safe after a promotion, when it does nothing.
   */
  discard(): Promise<void>;
}

/** Swallow the NotFoundError a removal of an absent entry raises. */
async function removeIfPresent(dir: OpfsDirHandle, name: string): Promise<void> {
  try {
    await dir.removeEntry(name, { recursive: true });
  } catch (err) {
    if ((err as { name?: string } | null)?.name === 'NotFoundError') return;
    throw err;
  }
}

/**
 * Start a build under `<name>.partial` inside `root`.
 *
 * Any leftover partial of the same name is removed first, so a session that
 * died without cleaning up does not have its bytes silently adopted by the next
 * build. The final name is left alone until {@link OpfsSpillBuild.promote}.
 */
export async function openOpfsSpillBuild(root: OpfsDirHandle, name: string): Promise<OpfsSpillBuild> {
  const partialName = name + PARTIAL_SUFFIX;
  await removeIfPresent(root, partialName);
  const dir = await root.getDirectoryHandle(partialName, { create: true });
  const store = opfsSpillStore(dir);
  let settled = false;

  return {
    store,
    dir,
    partialName,
    finalName: name,
    async promote() {
      if (settled) throw new Error('opfsSpillStore: this build has already been promoted or discarded');
      // Flush and unlock every tile before anything is relocated.
      await store.close();
      // A store already under this name is a previous build of the same input.
      // The new one replaces it; leaving both would mean two stores for one
      // source with nothing to say which is current.
      await removeIfPresent(root, name);
      const target = await root.getDirectoryHandle(name, { create: true });
      const entries: string[] = [];
      for await (const entry of dir.keys()) entries.push(entry);
      // The manifest goes last, so a promotion interrupted partway cannot
      // leave a directory that reads as a store. `openTileStore` needs the
      // manifest, and until it arrives there is nothing to open.
      entries.sort((a, b) => Number(a === TILE_MANIFEST_NAME) - Number(b === TILE_MANIFEST_NAME));
      try {
        for (const entry of entries) await relocate(dir, target, entry);
      } catch (err) {
        // Half a store under the final name is the one outcome this scheme
        // exists to prevent, so the failed target goes and the partial stays,
        // still discardable by the caller.
        await removeIfPresent(root, name);
        throw err;
      }
      settled = true;
      await removeIfPresent(root, partialName);
      return target;
    },
    async discard() {
      if (settled) return;
      settled = true;
      await store.close();
      await removeIfPresent(root, partialName);
    },
  };
}

/**
 * Move one file from the partial store into the promoted one.
 *
 * OPFS renames FILES but not directories (confirmed by probe: `move` is on
 * `FileSystemFileHandle` and absent from `FileSystemDirectoryHandle`), so
 * promotion is per entry. Chromium has the rename, and a rename moves no bytes.
 *
 * Where the rename is missing the bytes are copied and the source deleted
 * immediately, one file at a time, so what is briefly duplicated is the LARGEST
 * TILE rather than the store. That keeps `storagePreflight.ts` honest: its
 * total is unchanged, and the transient excess is one node's worth of records,
 * far inside the reserve it already holds back. The exception is a cloud so
 * degenerate that every point settles in one node, where the largest tile IS
 * the store; such a cloud has no usable octree either way.
 */
async function relocate(from: OpfsDirHandle, to: OpfsDirHandle, name: string): Promise<void> {
  const source = await from.getFileHandle(name);
  if (typeof source.move === 'function') {
    await source.move(to, name);
    return;
  }
  const bytes = new Uint8Array(await (await source.getFile()).arrayBuffer());
  const handle = await to.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(bytes);
  await writable.close();
  await from.removeEntry(name);
}

/**
 * Run `build` against a fresh partial store and promote it only if it returns.
 *
 * The reason this wrapper exists rather than a note telling callers to clean
 * up: cancellation, a decode fault and a quota failure all arrive here as the
 * same thing — the function did not return — and all three must delete the
 * partial store. A caller that has to remember which of them to catch will one
 * day catch two of the three.
 */
export async function withOpfsSpillBuild<T>(
  root: OpfsDirHandle,
  name: string,
  build: (build: OpfsSpillBuild) => Promise<T>,
): Promise<{ result: T; dir: OpfsDirHandle }> {
  const pending = await openOpfsSpillBuild(root, name);
  let result: T;
  try {
    result = await build(pending);
  } catch (err) {
    // The build's failure is the one worth reporting. A cleanup that also
    // fails must not replace it, or the user is told the disk could not be
    // tidied rather than why their index stopped.
    try {
      await pending.discard();
    } catch {
      // Nothing further to do: the partial store outlives this attempt and the
      // next build under the same name removes it.
    }
    throw err;
  }
  return { result, dir: await pending.promote() };
}
