/**
 * terrainCoreStore.ts
 *
 * The persistent (across reopen) TerrainCore cache on OPFS. An entry is keyed
 * by {@link persistentCoreKey}: the SHA-256 of the analysed positions and of
 * the classification, the exact core parameters and the method generation. Its
 * payload is a {@link encodeTerrainCore} byte image with a SHA-256 integrity
 * digest recorded beside it. A restore verifies the key, the digest and the
 * payload format before it decodes; any mismatch is a miss and the core is
 * recomputed. Writes happen after the computed core has been handed out, in
 * the background, and only for cores whose compute crossed
 * {@link TERRAIN_CORE_PERSIST_MIN_MS}. The store is bounded by
 * {@link TERRAIN_CORE_STORE_BUDGET_BYTES}; the least recently used entries
 * leave first. Nothing here reaches the OOC tile stores or the source file.
 * The index is one JSON file beside the payloads; a torn index reads as empty
 * and is rebuilt by the next write.
 */
import type { OpfsDirHandle } from '../../io/heavy/opfsSpillStore';
import { readOpfsText, writeOpfsText } from '../../io/heavy/opfsSpillStore';
import type { TerrainCore, TerrainCoreParams } from './analyseContours';
import { persistentCoreKeyParts, integrityDigest, verifyIntegrity, type PersistentKeyParts } from './persistentCoreKey';
import { decodeTerrainCore, encodeTerrainCore, TERRAIN_CORE_PAYLOAD_VERSION } from './terrainCorePayload';
import { setTerrainCorePersistence } from './terrainCoreCache';

export const TERRAIN_CORE_STORE_DIR = 'olv-terrain-core';
export const TERRAIN_CORE_INDEX_FILE = 'index.json';
export const TERRAIN_CORE_INDEX_VERSION = 1;
/** Cores cheaper than this to compute are kept in memory only. */
export const TERRAIN_CORE_PERSIST_MIN_MS = 1000;
/** Upper bound on the bytes the store keeps, all entries together. */
export const TERRAIN_CORE_STORE_BUDGET_BYTES = 512 * 1024 * 1024;

export type TerrainCoreMissReason =
  | 'unavailable'
  | 'not-found'
  | 'source-mismatch'
  | 'parameter-mismatch'
  | 'generation-mismatch'
  | 'format-mismatch'
  | 'integrity-failure'
  | 'read-failure';

export type TerrainCoreLookup = { readonly core: TerrainCore } | { readonly miss: TerrainCoreMissReason };

interface IndexEntry {
  readonly key: string;
  readonly content: string;
  readonly params: string;
  readonly generation: string;
  readonly file: string;
  readonly bytes: number;
  readonly digest: string;
  readonly format: number;
  readonly savedAt: number;
  lastUsed: number;
}
interface Index { version: number; next: number; entries: IndexEntry[] }

export interface TerrainCorePersistence {
  lookup(positions: Float32Array, params: TerrainCoreParams): Promise<TerrainCoreLookup>;
  /** Encode, digest and write the core; resolves false when nothing was written. */
  persist(positions: Float32Array, params: TerrainCoreParams, core: TerrainCore, computeMs: number): Promise<boolean>;
}

export interface TerrainCoreStoreOptions {
  readonly budgetBytes?: number;
  readonly persistMinMs?: number;
  readonly now?: () => number;
  /** Bytes the platform reports free, or null when it cannot say; a write needs room. */
  readonly freeBytes?: () => Promise<number | null>;
  /** The method generation to key under; defaults to the live registry. Tests pin it. */
  readonly generation?: string;
}

/** The OPFS root, or null where the platform has none. */
export async function opfsRoot(): Promise<OpfsDirHandle | null> {
  const storage = (globalThis as { navigator?: { storage?: { getDirectory?: () => Promise<OpfsDirHandle> } } }).navigator?.storage;
  if (!storage || typeof storage.getDirectory !== 'function') return null;
  try {
    return await storage.getDirectory();
  } catch {
    return null;
  }
}

const emptyIndex = (): Index => ({ version: TERRAIN_CORE_INDEX_VERSION, next: 1, entries: [] });

/**
 * Build a persistence over a root directory. `null` when the root is absent
 * keeps every lookup a miss and every persist a no-op.
 */
export function createTerrainCoreStore(root: OpfsDirHandle | null, options: TerrainCoreStoreOptions = {}): TerrainCorePersistence {
  const budget = options.budgetBytes ?? TERRAIN_CORE_STORE_BUDGET_BYTES;
  const minMs = options.persistMinMs ?? TERRAIN_CORE_PERSIST_MIN_MS;
  const now = options.now ?? (() => Date.now());
  const freeBytes = options.freeBytes ?? (async () => null);
  const parts = (positions: Float32Array, params: TerrainCoreParams) =>
    persistentCoreKeyParts(positions, params, options.generation);
  // One write at a time; the index is a single file and two writers would tear it.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(job: () => Promise<T>): Promise<T> => {
    const run = chain.then(job, job);
    chain = run.catch(() => undefined);
    return run;
  };

  async function dir(create: boolean): Promise<OpfsDirHandle | null> {
    if (!root) return null;
    try {
      return await root.getDirectoryHandle(TERRAIN_CORE_STORE_DIR, { create });
    } catch {
      return null;
    }
  }

  async function readIndex(d: OpfsDirHandle): Promise<Index> {
    try {
      const parsed = JSON.parse(await readOpfsText(d, TERRAIN_CORE_INDEX_FILE)) as Index;
      if (parsed.version !== TERRAIN_CORE_INDEX_VERSION || !Array.isArray(parsed.entries)) return emptyIndex();
      return parsed;
    } catch {
      return emptyIndex();
    }
  }

  async function writeIndex(d: OpfsDirHandle, index: Index): Promise<void> {
    await writeOpfsText(d, TERRAIN_CORE_INDEX_FILE, JSON.stringify(index));
  }

  async function remove(d: OpfsDirHandle, name: string): Promise<void> {
    try {
      await d.removeEntry(name);
    } catch {
      /* already gone */
    }
  }

  function classifyMiss(index: Index, parts: PersistentKeyParts): TerrainCoreMissReason {
    const sameContent = index.entries.filter((e) => e.content === parts.content);
    if (sameContent.length === 0) return index.entries.length === 0 ? 'not-found' : 'source-mismatch';
    if (sameContent.some((e) => e.params === parts.params)) return 'generation-mismatch';
    return 'parameter-mismatch';
  }

  return {
    async lookup(positions, params) {
      if (!root) return { miss: 'unavailable' };
      const d = await dir(false);
      if (!d) return { miss: 'not-found' };
      const p = await parts(positions, params);
      const index = await readIndex(d);
      const entry = index.entries.find((e) => e.key === p.key);
      if (!entry) return { miss: classifyMiss(index, p) };
      if (entry.format !== TERRAIN_CORE_PAYLOAD_VERSION) return { miss: 'format-mismatch' };
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await (await (await d.getFileHandle(entry.file)).getFile()).arrayBuffer());
      } catch {
        return { miss: 'read-failure' };
      }
      if (bytes.byteLength !== entry.bytes || !(await verifyIntegrity(bytes, entry.digest))) {
        // A torn or altered payload is never repaired; it is dropped.
        void serial(async () => {
          const fresh = await readIndex(d);
          fresh.entries = fresh.entries.filter((e) => e.key !== entry.key);
          await writeIndex(d, fresh);
          await remove(d, entry.file);
        }).catch(() => undefined);
        return { miss: 'integrity-failure' };
      }
      const decoded = decodeTerrainCore(bytes);
      if ('failure' in decoded) return { miss: decoded.failure === 'format-mismatch' ? 'format-mismatch' : 'integrity-failure' };
      entry.lastUsed = now();
      void serial(async () => {
        const fresh = await readIndex(d);
        const hit = fresh.entries.find((e) => e.key === entry.key);
        if (hit) { hit.lastUsed = entry.lastUsed; await writeIndex(d, fresh); }
      }).catch(() => undefined);
      return { core: decoded.core };
    },

    async persist(positions, params, core, computeMs) {
      if (computeMs < minMs) return false;
      const d = await dir(true);
      if (!d) return false;
      const payload = encodeTerrainCore(core);
      if (!payload || payload.byteLength > budget) return false;
      const p = await parts(positions, params);
      const digest = await integrityDigest(payload);
      return serial(async () => {
        const index = await readIndex(d);
        if (index.entries.some((e) => e.key === p.key)) return false;
        // Make room: oldest use first, never below what this payload needs.
        let used = index.entries.reduce((n, e) => n + e.bytes, 0);
        const byUse = [...index.entries].sort((a, b) => a.lastUsed - b.lastUsed);
        while (used + payload.byteLength > budget && byUse.length > 0) {
          const victim = byUse.shift()!;
          index.entries = index.entries.filter((e) => e.key !== victim.key);
          await remove(d, victim.file);
          used -= victim.bytes;
        }
        const free = await freeBytes();
        if (free !== null && free < payload.byteLength) return false;
        const file = `core-${index.next}.bin`;
        index.next += 1;
        try {
          const handle = await d.getFileHandle(file, { create: true });
          const w = await handle.createWritable();
          await w.write(payload);
          await w.close();
        } catch {
          await remove(d, file);
          return false;
        }
        const t = now();
        index.entries.push({
          key: p.key, content: p.content, params: p.params, generation: p.generation,
          file, bytes: payload.byteLength, digest, format: TERRAIN_CORE_PAYLOAD_VERSION, savedAt: t, lastUsed: t,
        });
        await writeIndex(d, index);
        return true;
      });
    },
  };
}

/** The production persistence: the OPFS root when the platform has one. */
export async function openTerrainCoreStore(): Promise<TerrainCorePersistence> {
  const root = await opfsRoot();
  const freeBytes = async (): Promise<number | null> => {
    const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } }).navigator?.storage;
    if (!storage || typeof storage.estimate !== 'function') return null;
    try {
      const est = await storage.estimate();
      return typeof est.quota === 'number' && typeof est.usage === 'number' ? est.quota - est.usage : null;
    } catch {
      return null;
    }
  };
  return createTerrainCoreStore(root, { freeBytes });
}

/**
 * Arm the in-memory cache with the production tier. Called once per session
 * from the terrain runner; on a platform without OPFS the tier misses and the
 * cache stays memory-only.
 */
export async function armTerrainCorePersistence(): Promise<void> {
  setTerrainCorePersistence(await openTerrainCoreStore());
}
