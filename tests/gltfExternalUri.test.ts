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

afterEach(() => vi.unstubAllGlobals());

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
