/**
 * opfsShortWrite.test.ts — a short sync write is completed or refused, never a
 * silent gap (finding #12).
 *
 * `FileSystemSyncAccessHandle.write()` MAY store fewer bytes than it was handed
 * and REPORT that count. The spill store used to advance its append cursor by
 * the full length regardless, which left an unwritten hole the reader later
 * decoded as garbage while the size looked right. The append now loops on the
 * returned count and refuses a non-positive result.
 *
 * The repo's `fakeOpfs` always stores the whole buffer, so this test hand-rolls
 * a directory handle whose sync write is deliberately short, which is the only
 * way to exercise the loop.
 */
import { describe, it, expect } from 'vitest';
import { opfsSpillStore } from '../src/io/heavy/opfsSpillStore';
import type {
  OpfsDirHandle,
  OpfsFileHandle,
  OpfsFile,
  OpfsSyncAccessHandle,
} from '../src/io/heavy/opfsSpillStore';

/** A one-file directory whose sync handle writes at most `writeCap` bytes per call. */
function shortWritingDir(writeCap: number | 'zero'): OpfsDirHandle {
  const files = new Map<string, Uint8Array>();

  function fileView(data: Uint8Array): OpfsFile {
    return {
      size: data.length,
      async arrayBuffer() {
        return data.slice().buffer;
      },
      async text() {
        return new TextDecoder().decode(data);
      },
      slice(start, end) {
        return fileView(data.subarray(start, end));
      },
    };
  }

  function fileHandle(name: string): OpfsFileHandle {
    return {
      async getFile() {
        return fileView(files.get(name) ?? new Uint8Array(0));
      },
      async createWritable() {
        throw new Error('not used in this test');
      },
      async createSyncAccessHandle(): Promise<OpfsSyncAccessHandle> {
        return {
          getSize: () => (files.get(name) ?? new Uint8Array(0)).length,
          write(bytes, at) {
            if (writeCap === 'zero') return 0;
            const stored = Math.min(writeCap, bytes.length);
            const start = at?.at ?? 0;
            const current = files.get(name) ?? new Uint8Array(0);
            const grown = new Uint8Array(Math.max(current.length, start + stored));
            grown.set(current);
            grown.set(bytes.subarray(0, stored), start);
            files.set(name, grown);
            return stored;
          },
          flush() {},
          close() {},
        };
      },
    };
  }

  return {
    async getFileHandle(name, opts) {
      if (!files.has(name)) {
        if (opts?.create !== true) throw Object.assign(new Error(name), { name: 'NotFoundError' });
        files.set(name, new Uint8Array(0));
      }
      return fileHandle(name);
    },
    async getDirectoryHandle() {
      throw new Error('not used');
    },
    async removeEntry(name) {
      files.delete(name);
    },
    async *keys() {
      for (const key of [...files.keys()]) yield key;
    },
  };
}

describe('opfsSpillStore short sync write', () => {
  it('completes a short write by looping, leaving no gap', async () => {
    // Cap each write at 2 bytes, so a 5-byte append needs three writes.
    const store = opfsSpillStore(shortWritingDir(2));
    await store.append('7', new Uint8Array([1, 2, 3, 4, 5]));
    await store.append('7', new Uint8Array([6, 7, 8]));
    expect([...(await store.read('7'))]).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('refuses a write that reports zero bytes rather than spinning or gapping', async () => {
    const store = opfsSpillStore(shortWritingDir('zero'));
    await expect(store.append('7', new Uint8Array([1, 2, 3]))).rejects.toThrow(/sync write reported/);
  });
});
