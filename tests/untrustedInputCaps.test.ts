import { describe, expect, it } from 'vitest';
import { parseHierarchyPage, MAX_COPC_HIERARCHY_PAGE_BYTES } from '../src/io/copc/copcHierarchy';
import { isValidKey } from '../src/io/copc/voxelKey';
import { parseCopcMetadata } from '../src/io/copc/copcHeader';
import { CopcSource } from '../src/io/copc/CopcSource';
import { ArrayBufferRangeSource } from '../src/io/range/ArrayBufferRangeSource';
import { StreamingOctree } from '../src/render/streaming/StreamingOctree';
import { parsePrefs } from '../src/prefs';
import {
  createLocalStore,
  MAX_ENTRIES,
  MAX_ENTRY_BYTES,
  type RecoveryEntry,
} from '../src/app/recovery/recoveryJournal';
import { isParseReply, isParseRequest } from '../src/io/parseMessages';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';
import type { OctreeCube } from '../src/io/copc/copcTypes';

const CUBE: OctreeCube = { center: [0, 0, 0], halfsize: 128 };

function hierarchyEntry(depth: number, x: number, byteSize: number, pointCount: number): ArrayBuffer {
  const buf = new ArrayBuffer(32);
  const v = new DataView(buf);
  v.setInt32(0, depth, true);
  v.setInt32(4, x, true);
  v.setBigUint64(16, 4096n, true);
  v.setInt32(24, byteSize, true);
  v.setInt32(28, pointCount, true);
  return buf;
}

describe('COPC hierarchy caps', () => {
  it('drops a child page reference larger than the page cap', () => {
    const page = parseHierarchyPage(hierarchyEntry(1, 0, MAX_COPC_HIERARCHY_PAGE_BYTES + 32, -1), CUBE, 1);
    expect(page.childPages).toEqual([]);
    expect(page.errors).toHaveLength(1);
  });

  it('keeps a child page reference at the cap', () => {
    const page = parseHierarchyPage(hierarchyEntry(1, 0, MAX_COPC_HIERARCHY_PAGE_BYTES, -1), CUBE, 1);
    expect(page.childPages).toHaveLength(1);
  });

  it('refuses a root hierarchy page larger than the page cap', () => {
    const fixture = buildSyntheticCopc();
    const head = fixture.buffer.slice(0, 4096);
    const view = new DataView(head);
    // Locate the root size by its current value next to the root offset.
    const meta = parseCopcMetadata(head);
    let at = -1;
    for (let i = 0; i + 16 <= head.byteLength; i++) {
      if (
        view.getBigUint64(i, true) === BigInt(meta.info.rootHierOffset) &&
        view.getBigUint64(i + 8, true) === BigInt(meta.info.rootHierSize)
      ) { at = i + 8; break; }
    }
    expect(at).toBeGreaterThan(0);
    view.setBigUint64(at, BigInt(MAX_COPC_HIERARCHY_PAGE_BYTES + 32), true);
    expect(() => parseCopcMetadata(head)).toThrow(/hierarchy/i);
  });

  it('rejects voxel keys deeper than 32 levels or outside their level', () => {
    expect(isValidKey({ depth: 32, x: 0, y: 0, z: 0 })).toBe(true);
    expect(isValidKey({ depth: 33, x: 0, y: 0, z: 0 })).toBe(false);
    expect(isValidKey({ depth: 2, x: 4, y: 0, z: 0 })).toBe(false);
    expect(isValidKey({ depth: 2, x: 3, y: 3, z: 3 })).toBe(true);
  });

  it('stops the hierarchy walk at the node cap', async () => {
    const fixture = buildSyntheticCopc({
      pages: [
        { pageKey: [0, 0, 0, 0], nodes: [{ key: [0, 0, 0, 0], pointCount: 2000 }], childPages: [1] },
        { pageKey: [1, 0, 0, 0], nodes: [{ key: [1, 0, 0, 0], pointCount: 800 }] },
      ],
    });
    const source = await CopcSource.open(new ArrayBufferRangeSource(fixture.buffer));
    const octree = new StreamingOctree(source, 1);
    await octree.loadFullHierarchy();
    expect(octree.store.size).toBe(1);
    expect(octree.errors.some((e) => /nodes/.test(e))).toBe(true);
    expect(octree.isComplete).toBe(false);
    expect(octree.capNotice).toMatch(/part of the scene is missing/);
  });

  it('carries no notice when the walk finishes under the cap', async () => {
    const source = await CopcSource.open(new ArrayBufferRangeSource(buildSyntheticCopc().buffer));
    const octree = new StreamingOctree(source);
    await octree.loadFullHierarchy();
    expect(octree.capNotice).toBeUndefined();
  });
});

describe('prefs inspectorSections', () => {
  it('ignores __proto__, constructor and prototype keys', () => {
    const out = parsePrefs('{"inspectorSections":{"__proto__":true,"constructor":false,"prototype":true,"crs":true}}');
    const sections = out.inspectorSections!;
    expect(Object.keys(sections)).toEqual(['crs']);
    expect(Object.prototype.hasOwnProperty.call(sections, 'constructor')).toBe(false);
    expect(Object.getPrototypeOf(sections)).toBe(Object.prototype);
  });
});

class MemStorage {
  map = new Map<string, string>();
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
}

function entry(key: string, savedAt: number, json = '{}'): RecoveryEntry {
  const summary = { fileName: 'a.ply', sourcePoints: 1, width: 1, depth: 1, height: 1 };
  return { v: 1, key, savedAt, fileName: key, summary, measurements: 0, annotations: 0, views: 0, json };
}

describe('recovery restore caps', () => {
  it('drops a stored entry whose session is over the entry cap', async () => {
    const s = new MemStorage();
    s.setItem('olv:recovery:journal', JSON.stringify([entry('big', 2, 'x'.repeat(MAX_ENTRY_BYTES + 1)), entry('ok', 1)]));
    expect((await createLocalStore(s).list()).map((e) => e.key)).toEqual(['ok']);
  });

  it('returns at most the entry cap, newest first', async () => {
    const s = new MemStorage();
    s.setItem('olv:recovery:journal', JSON.stringify(Array.from({ length: MAX_ENTRIES + 3 }, (_, i) => entry(`k${i}`, i))));
    const list = await createLocalStore(s).list();
    expect(list).toHaveLength(MAX_ENTRIES);
    expect(list[0]!.key).toBe(`k${MAX_ENTRIES + 2}`);
  });
});

describe('parse worker message shapes', () => {
  it('accepts a request with bytes or a file, a format and a name', () => {
    expect(isParseRequest({ buffer: new ArrayBuffer(4), format: 'las', name: 'a.las' })).toBe(true);
    expect(isParseRequest({ file: new Blob([]), format: 'e57', name: 'a.e57' })).toBe(true);
  });

  it('rejects a request with no bytes, a non-string format or a bad budget', () => {
    expect(isParseRequest(null)).toBe(false);
    expect(isParseRequest({ format: 'las', name: 'a.las' })).toBe(false);
    expect(isParseRequest({ buffer: new ArrayBuffer(4), format: 1, name: 'a' })).toBe(false);
    expect(isParseRequest({ buffer: new ArrayBuffer(4), format: 'las', name: 'a', budget: -1 })).toBe(false);
    expect(isParseRequest({ buffer: new ArrayBuffer(4), format: 'las', name: 'a', previewBudget: Number.NaN })).toBe(false);
  });

  it('accepts each reply type in its shape', () => {
    expect(isParseReply({ type: 'progress', stage: 'decoding' })).toBe(true);
    expect(isParseReply({ type: 'previewChunk', positions: new Float32Array(3) })).toBe(true);
    expect(isParseReply({ type: 'error', error: 'x' })).toBe(true);
    expect(isParseReply({ type: 'done', cloud: { positions: new Float32Array(6) } })).toBe(true);
  });

  it('rejects an unknown type or a reply missing its positions', () => {
    expect(isParseReply({ type: 'other' })).toBe(false);
    expect(isParseReply({ type: 'previewChunk', positions: [0, 0, 0] })).toBe(false);
    expect(isParseReply({ type: 'previewChunk', positions: new Float32Array(4) })).toBe(false);
    expect(isParseReply({ type: 'done', cloud: {} })).toBe(false);
    expect(isParseReply({ type: 'error' })).toBe(false);
  });
});
