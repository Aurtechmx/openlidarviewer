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

describe('loadGltf — accessor data is physically backed', () => {
  // Header + two interleaved VEC3 values. The last value has no trailing padding.
  const bin = new Uint8Array(new Float32Array([97, 98, 1, 2, 3, 99, 4, 5, 6]).buffer);
  const strided = (length: number, count = 2, offset = 4) => doc(
    { count, bufferView: 0, byteOffset: offset },
    { buffers: [{ byteLength: bin.length }], bufferViews: [{ buffer: 0, byteOffset: 4, byteLength: length, byteStride: 16 }] },
  );

  test('nonzero offsets and a final unpadded element round-trip exactly', async () => {
    const pc = await loadGltf(glb(strided(32), bin), 'glb');
    expect([...pc.positions]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test.each([
    ['one-byte view overrun', strided(31)],
    ['accessor beyond the view', strided(32, 2, 8)],
    ['unbacked third interleaved element', strided(32, 3, 0)],
    ['unbacked declared buffer', doc({ count: 1, bufferView: 0 }, {
      buffers: [{ byteLength: 48 }], bufferViews: [{ buffer: 0, byteLength: 48 }],
    })],
    ['missing view', doc({ count: 1, bufferView: 14 })],
    ['unbacked extra buffer', doc({ count: 1 }, { buffers: [{ byteLength: 36 }, { byteLength: 1_000_000_000 }] })],
  ])('refuses %s', async (_case, json) => {
    await expect(loadGltf(glb(json as object, bin), 'glb')).rejects.toMatchObject({ category: 'malformed-file' });
  });

  test('a truncated embedded URI cannot pass by inflating its declared length', async () => {
    const json = doc({ bufferView: 0, count: 2 }, {
      buffers: [{ byteLength: 32, uri: 'data:application/octet-stream;base64,AAAAAA==' }],
      bufferViews: [{ buffer: 0, byteLength: 32, byteStride: 16 }],
    });
    await expect(loadGltf(glb(json), 'glb')).rejects.toMatchObject({ category: 'malformed-file' });
  });

  test('GLB BIN padding may exceed the declared buffer length', async () => {
    const json = doc({ count: 2, bufferView: 0 }, {
      buffers: [{ byteLength: 25 }], bufferViews: [{ buffer: 0, byteLength: 24 }],
    });
    const pc = await loadGltf(glb(json, new Uint8Array(25)), 'glb');
    expect(pc.pointCount).toBe(2);
  });

  test('a zero-initialized base, sparse or dense, remains legal', async () => {
    const pc = await loadGltf(glb(doc({ count: 2 })), 'glb');
    expect([...pc.positions]).toEqual([0, 0, 0, 0, 0, 0]);
    const bytes = new Uint8Array(24);
    bytes[1] = 1;
    new Float32Array(bytes.buffer, 12).set([4, 5, 6]);
    const sparse = { count: 1, indices: { bufferView: 0, byteOffset: 1, componentType: 5121 },
      values: { bufferView: 1, byteOffset: 4 } };
    const extras = { buffers: [{ byteLength: 24 }], bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 2 }, { buffer: 0, byteOffset: 8, byteLength: 16 },
    ] };
    const read = (record: typeof sparse) => loadGltf(glb(doc({ count: 2, sparse: record }, extras), bytes), 'glb');
    expect([...(await read(sparse)).positions]).toEqual([0, 0, 0, 4, 5, 6]);
    for (const malformed of [
      { ...sparse, count: 3 },
      { ...sparse, indices: { ...sparse.indices, byteOffset: 2 } },
      { ...sparse, values: { ...sparse.values, byteOffset: 8 } },
    ]) await expect(read(malformed)).rejects.toMatchObject({ category: 'malformed-file' });
  });
});

describe('loadGltf — readable files keep opening', () => {
  const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const shifted = new Uint8Array(37);
  shifted.set(tri, 1);

  test('an accessor off its component alignment reads the same values', async () => {
    const json = doc({ count: 3, bufferView: 0, byteOffset: 1 }, {
      buffers: [{ byteLength: 37 }], bufferViews: [{ buffer: 0, byteLength: 37 }],
    });
    expect([...(await loadGltf(glb(json, shifted), 'glb')).positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  test('a null optional field reads as absent, and an empty buffer costs nothing', async () => {
    const json = doc({ count: 3, bufferView: 0, byteOffset: null, sparse: null }, {
      buffers: [{ byteLength: 36 }, { byteLength: 0 }],
      bufferViews: [{ buffer: 0, byteLength: 36, byteOffset: null, byteStride: null }],
    });
    expect((await loadGltf(glb(json, tri), 'glb')).pointCount).toBe(3);
  });
});

describe('loadGltf — meshopt the viewer cannot decode', () => {
  test.each(['EXT_meshopt_compression', 'KHR_meshopt_compression'])('refuses a required %s, naming it', async (name) => {
    const json = doc({ count: 1, bufferView: 0 }, {
      extensionsUsed: [name], extensionsRequired: [name],
      buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }],
    });
    await expect(loadGltf(glb(json, new Uint8Array(12)), 'glb')).rejects.toMatchObject({ category: 'unsupported-format', message: expect.stringMatching(/meshopt/) });
  });

  test('a fallback buffer with no data is refused rather than read as zeros', async () => {
    const json = doc({ count: 3, bufferView: 0 }, {
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: 36 }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [{ buffer: 1, byteLength: 36 }],
    });
    await expect(loadGltf(glb(json, new Uint8Array(36)), 'glb')).rejects.toMatchObject({ category: 'malformed-file' });
  });
});

describe('loadGltf — bounded copies of backed accessors', () => {
  // Two interleaved VEC3 attributes in one 48-byte buffer. Materializing
  // POSITION and NORMAL once each consumes exactly its physical allowance.
  const bytes = new Uint8Array(new Float32Array([1, 2, 3, 0, 0, 1, 4, 5, 6, 0, 0, 1]).buffer);
  function interleaved(duplicateCount: number, maxVertices: number) {
    const position = { componentType: 5126, type: 'VEC3', count: 2, bufferView: 0 };
    return loadGltf(glb(doc({}, {
      meshes: [{ primitives: [{ mode: 0, attributes: { POSITION: 0, NORMAL: 1 } }] }],
      buffers: [{ byteLength: bytes.length }],
      bufferViews: [{ buffer: 0, byteLength: bytes.length, byteStride: 24 }],
      accessors: [position, { ...position, byteOffset: 12 }, ...Array.from({ length: duplicateCount }, () => position)],
    }), bytes), 'glb', 'interleaved.glb', { maxVertices });
  }
  test('shares ordinary buffer storage and admits a duplicate at the exact allowance', async () => {
    const pc = await interleaved(1, 2);
    expect([...pc.positions]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pc.normals && [...pc.normals]).toEqual([0, 0, 1, 0, 0, 1]);
  });
  test('refuses excess copies, including unused accessors, before the parser allocates them', async () => {
    await expect(interleaved(2, 2)).rejects.toMatchObject({ category: 'memory-constraint' });
    expect((await interleaved(2, 4)).pointCount).toBe(2);
  });
});
