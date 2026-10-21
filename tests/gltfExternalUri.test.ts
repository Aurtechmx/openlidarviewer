import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadGltf } from '../src/io/loadGltf';

/** A minimal one-triangle .gltf whose only buffer lives at `uri`. */
function gltfWithBufferUri(uri: string): ArrayBuffer {
  const doc = {
    asset: { version: '2.0' },
    buffers: [{ uri, byteLength: 36 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [{ mesh: 0 }],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

/** The same triangle with its buffer embedded as a data: URI. */
function embeddedTriangle(): ArrayBuffer {
  const f = new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  const b64 = Buffer.from(new Uint8Array(f.buffer)).toString('base64');
  return gltfWithBufferUri(`data:application/octet-stream;base64,${b64}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a local glTF never makes the browser fetch a URI it names', () => {
  it('refuses an absolute https buffer URI without requesting it', async () => {
    const fetchSpy = vi.fn(async () => new Response(new ArrayBuffer(36)));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(loadGltf(gltfWithBufferUri('https://tracker.example/t.bin'), 'gltf')).rejects.toThrow(/external/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a protocol-relative and an http URI too', async () => {
    const fetchSpy = vi.fn(async () => new Response(new ArrayBuffer(36)));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(loadGltf(gltfWithBufferUri('//tracker.example/t.bin'), 'gltf')).rejects.toThrow(/external/i);
    await expect(loadGltf(gltfWithBufferUri('http://tracker.example/t.bin'), 'gltf')).rejects.toThrow(/external/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('still opens a self-contained glTF with a data: buffer', async () => {
    const cloud = await loadGltf(embeddedTriangle(), 'gltf');
    expect(cloud.pointCount).toBe(3);
  });
});

describe('the glTF JSON is decoded and parsed once before loaders.gl sees the file', () => {
  it('an opened file is parsed twice in all: once by our checks, once by loaders.gl', async () => {
    const buffer = embeddedTriangle();
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    const parse = vi.spyOn(JSON, 'parse');
    const cloud = await loadGltf(buffer, 'gltf');
    expect(cloud.pointCount).toBe(3);
    // The external-URI and admission checks used to parse the text separately,
    // which made three parses of one document.
    expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(2);
  });

  it('a refusal still happens before any loaders.gl work, from the same single parse', async () => {
    const parse = vi.spyOn(JSON, 'parse');
    const buffer = gltfWithBufferUri('https://tracker.example/t.bin');
    const text = new TextDecoder().decode(new Uint8Array(buffer));
    await expect(loadGltf(buffer, 'gltf')).rejects.toThrow(/external/i);
    expect(parse.mock.calls.filter(([arg]) => arg === text)).toHaveLength(1);
  });
});

describe('glTF 1.0 and unreadable GLB headers cannot reach the network', () => {
  /** A glTF 1.0 document: buffers keyed by id, not listed. */
  function gltfV1WithBufferUri(uri: string): ArrayBuffer {
    const doc = { asset: { version: '1.0' }, buffers: { b: { uri, byteLength: 1 } } };
    return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
  }

  /** A GLB whose first chunk is not JSON (the GLB 1.0 layout). */
  function glbV1(): ArrayBuffer {
    const json = new TextEncoder().encode(JSON.stringify({ buffers: { b: { uri: 'https://tracker.example/t.bin' } } }));
    const out = new ArrayBuffer(20 + json.length);
    const v = new DataView(out);
    v.setUint32(0, 0x46546c67, true); // 'glTF'
    v.setUint32(4, 1, true);
    v.setUint32(8, out.byteLength, true);
    v.setUint32(12, json.length, true);
    v.setUint32(16, 0, true); // contentFormat 0, not 'JSON'
    new Uint8Array(out, 20).set(json);
    return out;
  }

  it('finds a URI in a glTF 1.0 buffer map', async () => {
    const { externalGltfUris } = await import('../src/io/loadGltf');
    expect(externalGltfUris({ buffers: { b: { uri: 'https://tracker.example/t.bin' } } })).toEqual(['https://tracker.example/t.bin']);
  });

  it('refuses a glTF 1.0 file without requesting its buffer', async () => {
    const fetchSpy = vi.fn(async () => new Response(new ArrayBuffer(1)));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(loadGltf(gltfV1WithBufferUri('https://tracker.example/t.bin'), 'gltf')).rejects.toThrow(/version 2\.0/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a GLB whose JSON chunk cannot be read, even under a .gltf name', async () => {
    const fetchSpy = vi.fn(async () => new Response(new ArrayBuffer(1)));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(loadGltf(glbV1(), 'glb')).rejects.toThrow(/JSON chunk/);
    await expect(loadGltf(glbV1(), 'gltf')).rejects.toThrow(/JSON chunk/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
