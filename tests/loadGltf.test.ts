import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadGltf } from '../src/io/loadGltf';

const fixturePath = fileURLToPath(new URL('./fixtures/tiny.glb', import.meta.url));

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(): ArrayBuffer {
  const file = readFileSync(fixturePath);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('loadGltf — tiny.glb fixture (ground truth from FIXTURES.md)', () => {
  test('vertex count is 8 (one cube primitive)', async () => {
    const pc = await loadGltf(loadFixture(), 'glb', 'tiny.glb');
    expect(pc.pointCount).toBe(8);
  });

  test('first vertex is the origin [0, 0, 0]', async () => {
    const pc = await loadGltf(loadFixture(), 'glb');
    expect(pc.positions[0]).toBeCloseTo(0, 5);
    expect(pc.positions[1]).toBeCloseTo(0, 5);
    expect(pc.positions[2]).toBeCloseTo(0, 5);
  });

  test('local bounds match the cube [0,0,0]..[2,2,2]', async () => {
    const pc = await loadGltf(loadFixture(), 'glb');
    const { min, max } = pc.bounds();
    expect(min[0]).toBeCloseTo(0, 4);
    expect(min[1]).toBeCloseTo(0, 4);
    expect(min[2]).toBeCloseTo(0, 4);
    expect(max[0]).toBeCloseTo(2, 4);
    expect(max[1]).toBeCloseTo(2, 4);
    expect(max[2]).toBeCloseTo(2, 4);
  });

  test('origin is [0, 0, 0] and sourceFormat round-trips', async () => {
    const pc = await loadGltf(loadFixture(), 'glb');
    expect(pc.origin).toEqual([0, 0, 0]);
    expect(pc.sourceFormat).toBe('glb');
  });

  test('name round-trips when given', async () => {
    const pc = await loadGltf(loadFixture(), 'glb', 'cube.glb');
    expect(pc.name).toBe('cube.glb');
  });
});

/**
 * A minimal single-primitive glTF whose POSITION accessor holds `verts`
 * verbatim, as a JSON asset with the buffer inlined as a data URI.
 */
function gltfWithVerts(verts: number[]): ArrayBuffer {
  const bytes = new Uint8Array(Float32Array.from(verts).buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: verts.length / 3, type: 'VEC3' },
    ],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength }],
    buffers: [
      { byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

describe('loadGltf — sanitation', () => {
  test('an unplaceable vertex is excluded and reported', async () => {
    // glTF carries no georeferencing, but a NaN can still reach the buffer.
    // Before it was routed through the shared policy this was the one loader
    // that let a non-finite vertex through into the cloud.
    const pc = await loadGltf(
      gltfWithVerts([0, 0, 0, NaN, 1, 1, 2, 2, 2]),
      'gltf',
    );
    expect(pc.pointCount).toBe(2);
    for (let i = 0; i < pc.positions.length; i++) {
      expect(Number.isFinite(pc.positions[i])).toBe(true);
    }
    expect((pc.metadata?.loadWarnings ?? []).join(' ')).toMatch(/1\b/);
  });

  test('a clean asset carries no load warning', async () => {
    const pc = await loadGltf(gltfWithVerts([0, 0, 0, 1, 1, 1]), 'gltf');
    expect(pc.pointCount).toBe(2);
    expect(pc.metadata?.loadWarnings).toBeUndefined();
  });
});
