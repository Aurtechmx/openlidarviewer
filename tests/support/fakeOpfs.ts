/**
 * fakeOpfs.ts — an in-memory Origin Private File System that CHARGES.
 *
 * OPFS does not exist in Node, so the spill store's logic is unit-tested
 * against a fake. A fake that only records final contents is not enough here:
 * the defect this fake exists to expose — `createWritable({ keepExistingData:
 * true })` starting its swap file as a copy of the file it replaces — produces
 * exactly the right contents and merely takes time proportional to the tile
 * rather than to the append. So every byte the platform would move is counted,
 * and a test can tell the two write paths apart by cost.
 *
 * The counters were calibrated against real OPFS in headless Chromium: thirty-
 * two 4 KiB appends onto an empty file took 36 ms and onto a 64 MiB file
 * 4120 ms, which is the whole-file copy this fake charges for, and a sync
 * access handle wrote the same payload in flat time.
 *
 * Capabilities are constructor options rather than fixed, because the real
 * surface is not fixed: `createSyncAccessHandle` is exposed inside a worker and
 * not on Chromium's main thread, and `FileSystemFileHandle.move` exists while
 * the directory equivalent does not. Both were confirmed by probe.
 *
 * One place the fake is deliberately STRICTER than the engine measured: a sync
 * access handle here commits its writes on `close()` or `flush()`, so
 * `getFile()` on a file with a handle open reports what was last committed.
 * Chromium was measured committing eagerly, but nothing promises that, and a
 * store that reads a tile without releasing its handle first would be relying
 * on the engine rather than on the API.
 */
import type { OpfsDirHandle, OpfsFileHandle, OpfsSyncAccessHandle } from '../../src/io/heavy/opfsSpillStore';

export interface FakeOpfsStats {
  /** Bytes a swap file copies out of the file it is about to replace. */
  bytesCopied: number;
  /** Bytes handed to a write() call, by either path. */
  bytesWritten: number;
  writableOpens: number;
  syncOpens: number;
  fileMoves: number;
  /** Names passed to `move`, in order, so a promotion's ordering is observable. */
  movedNames: string[];
  /** Most tile files holding an open sync access handle at any one moment. */
  peakOpenSyncHandles: number;
}

export interface FakeOpfsOptions {
  /** Expose `createSyncAccessHandle`. Browsers expose it only inside a worker. */
  readonly syncAccess?: boolean;
  /**
   * Expose `createSyncAccessHandle` but have it fail, so the fallback is
   * reached through the trial rather than through the presence check.
   * `'refused'` is an engine saying not in this context, which is a capability
   * gap and the fallback's cue; `'malformed'` is a handle that is not the shape
   * it claims, which is a fault and must not be quietly routed around.
   */
  readonly syncAccessFails?: 'refused' | 'malformed';
  /** Expose `FileSystemFileHandle.move`. Chromium does; not every engine does. */
  readonly fileMove?: boolean;
  /** Reject writes once the store holds this many bytes, as a quota would. */
  readonly quotaBytes?: number;
}

interface FakeFile {
  kind: 'file';
  /** The committed bytes: what `getFile()` reports. */
  data: Uint8Array;
  locked: boolean;
  /** Bytes an open sync access handle holds beyond `data`, charged to quota. */
  pending: number;
}
interface FakeDir {
  kind: 'dir';
  entries: Map<string, FakeFile | FakeDir>;
}

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

export interface FakeOpfs {
  /** The root directory handle, to hand to the code under test. */
  readonly root: OpfsDirHandle;
  readonly stats: FakeOpfsStats;
  /** Every file in the tree as `path -> bytes`, for a layout assertion. */
  snapshot(): Map<string, Uint8Array>;
  /** Names directly under the root, files and directories alike. */
  topLevel(): string[];
  /** Total bytes the tree holds, for a quota or leak assertion. */
  totalBytes(): number;
}

export function fakeOpfs(options: FakeOpfsOptions = {}): FakeOpfs {
  const rootNode: FakeDir = { kind: 'dir', entries: new Map() };
  const stats: FakeOpfsStats = {
    bytesCopied: 0,
    bytesWritten: 0,
    writableOpens: 0,
    syncOpens: 0,
    fileMoves: 0,
    movedNames: [],
    peakOpenSyncHandles: 0,
  };
  let openSyncHandles = 0;

  function totalBytes(node: FakeDir = rootNode): number {
    let sum = 0;
    for (const entry of node.entries.values()) {
      sum += entry.kind === 'file' ? entry.data.length + entry.pending : totalBytes(entry);
    }
    return sum;
  }

  /** A quota is a property of the ORIGIN, so it counts the whole tree. */
  function chargeQuota(extra: number): void {
    if (options.quotaBytes !== undefined && totalBytes() + extra > options.quotaBytes) {
      throw domError('QuotaExceededError', 'the fake origin is out of space');
    }
  }

  function writeAt(target: Uint8Array, bytes: Uint8Array, at: number): Uint8Array {
    let buf = target;
    if (at + bytes.length > buf.length) {
      const grown = new Uint8Array(Math.max(at + bytes.length, buf.length));
      grown.set(buf);
      buf = grown;
    }
    buf.set(bytes, at);
    return buf;
  }

  function makeFileHandle(parent: FakeDir, name: string): OpfsFileHandle {
    const file = (): FakeFile => {
      const entry = parent.entries.get(name);
      if (entry === undefined || entry.kind !== 'file') throw domError('NotFoundError', name);
      return entry;
    };

    const handle: OpfsFileHandle = {
      async getFile() {
        const data = file().data;
        return {
          size: data.length,
          async arrayBuffer() {
            return data.slice().buffer;
          },
          async text() {
            return new TextDecoder().decode(data);
          },
        };
      },
      async createWritable(opts) {
        const f = file();
        if (f.locked) throw domError('NoModificationAllowedError', name);
        stats.writableOpens++;
        let buf: Uint8Array;
        if (opts?.keepExistingData) {
          // THE DEFECT, modelled. The spec starts the swap file as a copy of
          // the existing file, so an append pays for the whole tile.
          chargeQuota(f.data.length);
          buf = f.data.slice();
          stats.bytesCopied += buf.length;
        } else {
          buf = new Uint8Array(0);
        }
        let pos = 0;
        return {
          async seek(offset) {
            pos = offset;
          },
          async write(bytes) {
            chargeQuota(bytes.length);
            stats.bytesWritten += bytes.length;
            buf = writeAt(buf, bytes, pos);
            pos += bytes.length;
          },
          async close() {
            file().data = buf;
          },
        };
      },
    };

    if (options.syncAccess || options.syncAccessFails !== undefined) {
      handle.createSyncAccessHandle = async (): Promise<OpfsSyncAccessHandle> => {
        if (options.syncAccessFails === 'refused') {
          // What the main thread does in a browser that ships the method there.
          throw domError('InvalidStateError', 'sync access handles are worker-only');
        }
        if (options.syncAccessFails === 'malformed') {
          throw new TypeError('createSyncAccessHandle is not a function');
        }
        const f = file();
        if (f.locked) throw domError('NoModificationAllowedError', name);
        f.locked = true;
        stats.syncOpens++;
        openSyncHandles++;
        if (openSyncHandles > stats.peakOpenSyncHandles) stats.peakOpenSyncHandles = openSyncHandles;
        let closed = false;
        let buf: Uint8Array = f.data.slice();
        const commit = (): void => {
          f.data = buf;
          f.pending = 0;
        };
        return {
          getSize: () => buf.length,
          write(bytes, at) {
            if (closed) throw domError('InvalidStateError', 'closed');
            chargeQuota(bytes.length);
            stats.bytesWritten += bytes.length;
            const before = buf.length;
            buf = writeAt(buf, bytes, at?.at ?? 0);
            f.pending += buf.length - before;
            return bytes.length;
          },
          flush: commit,
          close() {
            if (closed) return;
            closed = true;
            commit();
            f.locked = false;
            openSyncHandles--;
          },
        };
      };
    }

    if (options.fileMove) {
      handle.move = async (destination, newName) => {
        const f = file();
        if (f.locked) throw domError('NoModificationAllowedError', name);
        const target = dirNodeOf(destination);
        stats.fileMoves++;
        stats.movedNames.push(name);
        parent.entries.delete(name);
        target.entries.set(newName ?? name, f);
      };
    }
    return handle;
  }

  // Directory handles are wrappers, so a move needs the node behind the handle
  // it was given rather than the one it was made from.
  const nodeOfHandle = new WeakMap<OpfsDirHandle, FakeDir>();
  function dirNodeOf(handle: OpfsDirHandle): FakeDir {
    const node = nodeOfHandle.get(handle);
    if (node === undefined) throw domError('NotFoundError', 'unknown directory handle');
    return node;
  }

  function makeDirHandle(node: FakeDir): OpfsDirHandle {
    const handle: OpfsDirHandle = {
      async getFileHandle(name, opts) {
        const entry = node.entries.get(name);
        if (entry === undefined) {
          if (opts?.create !== true) throw domError('NotFoundError', name);
          node.entries.set(name, { kind: 'file', data: new Uint8Array(0), locked: false, pending: 0 });
        } else if (entry.kind !== 'file') {
          throw domError('TypeMismatchError', name);
        }
        return makeFileHandle(node, name);
      },
      async getDirectoryHandle(name, opts) {
        const entry = node.entries.get(name);
        if (entry === undefined) {
          if (opts?.create !== true) throw domError('NotFoundError', name);
          const created: FakeDir = { kind: 'dir', entries: new Map() };
          node.entries.set(name, created);
          return makeDirHandle(created);
        }
        if (entry.kind !== 'dir') throw domError('TypeMismatchError', name);
        return makeDirHandle(entry);
      },
      async removeEntry(name, opts) {
        const entry = node.entries.get(name);
        if (entry === undefined) throw domError('NotFoundError', name);
        if (entry.kind === 'dir' && entry.entries.size > 0 && opts?.recursive !== true) {
          throw domError('InvalidModificationError', name);
        }
        node.entries.delete(name);
      },
      async *keys() {
        for (const key of [...node.entries.keys()]) yield key;
      },
    };
    nodeOfHandle.set(handle, node);
    return handle;
  }

  const root = makeDirHandle(rootNode);

  function snapshotInto(node: FakeDir, prefix: string, into: Map<string, Uint8Array>): void {
    for (const [name, entry] of node.entries) {
      if (entry.kind === 'file') into.set(prefix + name, entry.data.slice());
      else snapshotInto(entry, `${prefix}${name}/`, into);
    }
  }

  return {
    root,
    stats,
    snapshot() {
      const out = new Map<string, Uint8Array>();
      snapshotInto(rootNode, '', out);
      return out;
    },
    topLevel() {
      return [...rootNode.entries.keys()];
    },
    totalBytes: () => totalBytes(),
  };
}

/**
 * A single directory handle with the shape the store expects, for the cases
 * that only need one directory rather than a root plus a partial inside it.
 */
export function fakeOpfsDir(options: FakeOpfsOptions = {}): OpfsDirHandle {
  return fakeOpfs(options).root;
}
