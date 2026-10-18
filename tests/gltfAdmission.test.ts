import { describe, expect, test } from 'vitest';
import { loadGltf, MAX_GLTF_VERTICES } from '../src/io/loadGltf';
import { describeLoadError } from '../src/io/loadErrors';

/** Assemble a GLB from a JSON document and an optional BIN chunk. */
function glb(json: object, bin?: Uint8Array): ArrayBuffer {
  const j = new TextEncoder().encode(JSON.stringify(json));
  const jl = Math.ceil(j.length / 4) * 4;
  const jp = new Uint8Array(jl).fill(0x20);
  jp.set(j);
  const bl = bin ? Math.ceil(bin.length / 4) * 4 : 0;
  const total = 12 + 8 + jl + (bin ? 8 + bl : 0);
  const out = new ArrayBuffer(total);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, total, true);
  v.setUint32(12, jl, true);
  v.setUint32(16, 0x4e4f534a, true);
  new Uint8Array(out, 20, jl).set(jp);
  if (bin) {
    const o = 20 + jl;
    v.setUint32(o, bl, true);
    v.setUint32(o + 4, 0x004e4942, true);
    new Uint8Array(out, o + 8, bin.length).set(bin);
  }
  return out;
}

function doc(accessor: object, more: object = {}): object {
  return {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ componentType: 5126, type: 'VEC3', ...accessor }],
    ...more,
  };
}

const heapBefore = (): number => process.memoryUsage().arrayBuffers;

describe('loadGltf — admission by declared accessor size', () => {
  test('a tiny GLB declaring 300 million zero-filled vertices is refused before any allocation', async () => {
    const before = heapBefore();
    await expect(loadGltf(glb(doc({ count: 300_000_000 })), 'glb')).rejects.toMatchObject({
      name: 'LoadError',
      category: 'memory-constraint',
    });
    // The parser used to reserve ~3.6 GB for this file.
    expect(heapBefore() - before).toBeLessThan(200 * 1024 * 1024);
  });

  test('a sparse accessor with an absurd count is refused', async () => {
    const sparse = { count: 1, indices: { bufferView: 0, componentType: 5125 }, values: { bufferView: 0 } };
    const json = doc(
      { count: 300_000_000, sparse },
      { buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }] },
    );
    const before = heapBefore();
    await expect(loadGltf(glb(json, new Uint8Array(36)), 'glb')).rejects.toMatchObject({ name: 'LoadError' });
    expect(heapBefore() - before).toBeLessThan(200 * 1024 * 1024);
  });

  test('a non-integer or negative accessor count is refused as malformed', async () => {
    for (const count of [-1, 2.5, 1e300, '3']) {
      await expect(loadGltf(glb(doc({ count })), 'glb')).rejects.toMatchObject({
        name: 'LoadError',
        category: 'malformed-file',
      });
    }
  });

  test('many accessors that each pass alone but together exceed the budget are refused', async () => {
    const each = Math.floor(MAX_GLTF_VERTICES / 2); // 4M VEC3 floats = 48 MB each
    const json = doc({ count: each }, {});
    (json as { accessors: object[] }).accessors.push(
      { componentType: 5126, type: 'VEC3', count: each },
      { componentType: 5126, type: 'VEC3', count: each },
    );
    await expect(loadGltf(glb(json), 'glb')).rejects.toMatchObject({ category: 'memory-constraint' });
  });

  test('an honest accessor backed by a bufferView still loads', async () => {
    const bin = new Uint8Array(36);
    new DataView(bin.buffer).setFloat32(0, 1, true);
    const json = doc(
      { count: 3, bufferView: 0 },
      { buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }] },
    );
    const pc = await loadGltf(glb(json, bin), 'glb');
    expect(pc.pointCount).toBe(3);
  });
});

describe('loadGltf — Draco is refused, never fetched', () => {
  const draco = (where: 'used' | 'required'): object =>
    doc(
      { count: 3 },
      where === 'used' ? { extensionsUsed: ['KHR_draco_mesh_compression'] } : { extensionsRequired: ['KHR_draco_mesh_compression'], extensionsUsed: ['KHR_draco_mesh_compression'] },
    );

  test.each(['used', 'required'] as const)('extensions%s with KHR_draco_mesh_compression is a clear LoadError', async (where) => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown) => {
      calls.push(String(input));
      return Promise.reject(new Error('no network in tests'));
    }) as typeof fetch;
    try {
      const err = await loadGltf(glb(draco(where)), 'glb').catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'LoadError', category: 'unsupported-format' });
      expect(describeLoadError(err)).toMatch(/Draco decoder is not bundled/);
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(calls).toEqual([]);
  });
});
