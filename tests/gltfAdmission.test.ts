import { describe, expect, test } from 'vitest';
import { loadGltf, MAX_GLTF_VERTICES } from '../src/io/loadGltf';
import { describeLoadError } from '../src/io/loadErrors';

/**
 * Lay out GLB chunks exactly as given: the header length is `declared` when
 * set (the parser stops there); each chunk is [length, type, bytes], with the
 * length field as given and the bytes padded to four.
 */
function rawGlb(chunks: { type: number; bytes: Uint8Array }[], declared?: number): ArrayBuffer {
  const sizes = chunks.map((c) => 8 + Math.ceil(c.bytes.length / 4) * 4);
  const total = 12 + sizes.reduce((a, b) => a + b, 0);
  const out = new ArrayBuffer(total);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, declared ?? total, true);
  let o = 12;
  chunks.forEach((c, i) => {
    v.setUint32(o, c.bytes.length, true);
    v.setUint32(o + 4, c.type, true);
    new Uint8Array(out, o + 8, c.bytes.length).set(c.bytes);
    o += sizes[i]!;
  });
  return out;
}

const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const jsonBytes = (json: object): Uint8Array => new TextEncoder().encode(JSON.stringify(json));
/** JSON padded with spaces to a four-byte length, as exporters write it. */
const paddedJson = (json: object): Uint8Array => {
  const j = jsonBytes(json);
  const out = new Uint8Array(Math.ceil(j.length / 4) * 4).fill(0x20);
  out.set(j);
  return out;
};

/** Assemble a GLB from a JSON document and an optional BIN chunk, with padded lengths as exporters write them. */
function glb(json: object, bin?: Uint8Array): ArrayBuffer {
  return rawGlb([{ type: JSON_CHUNK, bytes: paddedJson(json) }, ...(bin ? [{ type: BIN_CHUNK, bytes: bin }] : [])]);
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

describe('loadGltf — the admission check walks the chunks the parser reads', () => {
  const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const backed = doc({ count: 3, bufferView: 0 }, {
    buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36 }],
  });

  test('a binary chunk past the header length is not a backing: the file is refused, not read as zeros', async () => {
    const j = paddedJson(backed);
    const headerEndsBeforeBin = 12 + 8 + j.length;
    const file = rawGlb([{ type: JSON_CHUNK, bytes: j }, { type: BIN_CHUNK, bytes: tri }], headerEndsBeforeBin);
    await expect(loadGltf(file, 'glb')).rejects.toMatchObject({ name: 'LoadError', category: 'malformed-file' });
  });

  test('a second JSON chunk is refused rather than checked on one document and parsed on another', async () => {
    const zeroFilled = doc({ count: 3 });
    const file = rawGlb([
      { type: JSON_CHUNK, bytes: paddedJson(backed) },
      { type: BIN_CHUNK, bytes: tri },
      { type: JSON_CHUNK, bytes: paddedJson(zeroFilled) },
    ]);
    await expect(loadGltf(file, 'glb')).rejects.toMatchObject({ name: 'LoadError', category: 'malformed-file' });
  });

  test('an unpadded JSON length and an unknown chunk before the binary one still open', async () => {
    // The length field says 37; the chunk occupies 40 bytes. The parser pads
    // the length when it steps to the next chunk, so the file reads correctly.
    const j = jsonBytes(backed);
    expect(j.length % 4, 'the fixture must need padding').not.toBe(0);
    const unpadded = rawGlb([{ type: JSON_CHUNK, bytes: j }, { type: BIN_CHUNK, bytes: tri }]);
    expect([...(await loadGltf(unpadded, 'glb')).positions]).toEqual([...new Float32Array(tri.buffer)]);
    const unknownFirst = rawGlb([
      { type: JSON_CHUNK, bytes: paddedJson(backed) },
      { type: 0x58595a00, bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      { type: BIN_CHUNK, bytes: tri },
    ]);
    expect([...(await loadGltf(unknownFirst, 'glb')).positions]).toEqual([...new Float32Array(tri.buffer)]);
  });

  test('a trailing unknown chunk that overruns the file is skipped, as the parser skips it', async () => {
    const j = paddedJson(backed);
    const file = rawGlb([{ type: JSON_CHUNK, bytes: j }, { type: BIN_CHUNK, bytes: tri }, { type: 0x58595a00, bytes: new Uint8Array(4) }]);
    new DataView(file).setUint32(file.byteLength - 8, 1 << 20, true); // the unknown chunk claims a megabyte
    expect((await loadGltf(file, 'glb')).pointCount).toBe(3);
  });

  test('a header length that leaves no room for a chunk header is refused as malformed, not as a bare error', async () => {
    const file = rawGlb([{ type: JSON_CHUNK, bytes: paddedJson(backed) }, { type: BIN_CHUNK, bytes: tri }], 20);
    await expect(loadGltf(file, 'glb')).rejects.toMatchObject({ name: 'LoadError', category: 'malformed-file' });
  });

  test('a .glb that is neither a GLB nor JSON text is refused by its first bytes', async () => {
    const junk = new Uint8Array(1 << 20);
    for (let i = 0; i < junk.length; i++) junk[i] = (i * 7919) & 0xff;
    await expect(loadGltf(junk.buffer, 'glb')).rejects.toMatchObject({ category: 'malformed-file', message: expect.stringMatching(/JSON chunk/) });
  });

  test('a JSON glTF saved under a .glb name is read as text', async () => {
    const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const uri = 'data:application/octet-stream;base64,' + Buffer.from(tri).toString('base64');
    const text = new TextEncoder().encode(JSON.stringify(doc({ count: 3, bufferView: 0 }, {
      buffers: [{ byteLength: 36, uri }], bufferViews: [{ buffer: 0, byteLength: 36 }],
    })));
    const copy = new ArrayBuffer(text.length);
    new Uint8Array(copy).set(text);
    expect([...(await loadGltf(copy, 'glb')).positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  test('a GLB whose header claims more bytes than the file holds is refused as malformed', async () => {
    const file = rawGlb([{ type: JSON_CHUNK, bytes: paddedJson(backed) }, { type: BIN_CHUNK, bytes: tri }], 1 << 20);
    await expect(loadGltf(file, 'glb')).rejects.toMatchObject({ name: 'LoadError', category: 'malformed-file' });
  });
});

describe('loadGltf — byte strides the parser reads correctly keep opening', () => {
  test('a byteStride of 0 reads as no interleaving', async () => {
    const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const json = doc({ count: 3, bufferView: 0 }, {
      buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36, byteStride: 0 }],
    });
    expect([...(await loadGltf(glb(json, tri), 'glb')).positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  test('a stride that is not a multiple of four reads each element where it is', async () => {
    // Three 12-byte VEC3s at 14-byte intervals: 2 padding bytes after each.
    const bytes = new Uint8Array(14 * 2 + 12);
    const pts = [[0, 0, 0], [1, 0, 0], [0, 1, 0]];
    pts.forEach((p, i) => bytes.set(new Uint8Array(new Float32Array(p).buffer), i * 14));
    const json = doc({ count: 3, bufferView: 0 }, {
      buffers: [{ byteLength: bytes.length }], bufferViews: [{ buffer: 0, byteLength: bytes.length, byteStride: 14 }],
    });
    expect([...(await loadGltf(glb(json, bytes), 'glb')).positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  test('a stride shorter than the element is still refused', async () => {
    const json = doc({ count: 3, bufferView: 0 }, {
      buffers: [{ byteLength: 36 }], bufferViews: [{ buffer: 0, byteLength: 36, byteStride: 8 }],
    });
    await expect(loadGltf(glb(json, new Uint8Array(36)), 'glb')).rejects.toMatchObject({ category: 'malformed-file' });
  });
});

describe('loadGltf — a meshopt fallback buffer is named as meshopt', () => {
  test('a fallback buffer flagged by the extension gets the meshopt message, not a corruption one', async () => {
    const json = doc({ count: 3, bufferView: 0 }, {
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: 36 }, { byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [{ buffer: 1, byteLength: 36 }],
    });
    await expect(loadGltf(glb(json, new Uint8Array(36)), 'glb')).rejects.toMatchObject({
      category: 'unsupported-format', message: expect.stringMatching(/meshopt/),
    });
  });

  test('a fallback buffer that carries its data is the uncompressed copy, and opens', async () => {
    // With the extension only in extensionsUsed, the fallback buffer holds the plain bytes.
    const tri = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
    const json = doc({ count: 3, bufferView: 0 }, {
      extensionsUsed: ['EXT_meshopt_compression'],
      buffers: [{ byteLength: 36, extensions: { EXT_meshopt_compression: { fallback: true } } }],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
    });
    expect([...(await loadGltf(glb(json, tri), 'glb')).positions]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});
