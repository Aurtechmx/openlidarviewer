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

/**
 * A JSON glTF with an explicit multi-scene layout. `sceneIndex` is written as
 * the top-level `scene`, which is what names the DEFAULT scene; `sceneNodes`
 * gives each scene its own root node index, and `nodes` places each of those at
 * a distinct translation so the loaded geometry says unambiguously which scene
 * (or scenes) was walked.
 */
function gltfWithScenes(opts: {
  sceneIndex?: number;
  sceneNodes: number[][];
  translations: number[][];
}): ArrayBuffer {
  const verts = [0, 0, 0];
  const bytes = new Uint8Array(Float32Array.from(verts).buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const doc: Record<string, unknown> = {
    asset: { version: '2.0' },
    scenes: opts.sceneNodes.map((nodes) => ({ nodes })),
    nodes: opts.translations.map((t) => ({ mesh: 0, translation: t })),
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength }],
    buffers: [
      { byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` },
    ],
  };
  if (opts.sceneIndex !== undefined) doc.scene = opts.sceneIndex;
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

/**
 * A JSON glTF with a caller-supplied `nodes` array, rooted at node 0. Lets a
 * test write a node graph the glTF spec forbids (a `children` cycle) and still
 * go through the real parse — loaders.gl resolves `children` indices into node
 * objects without checking for loops, so the cycle survives into the graph the
 * loader walks.
 */
function gltfWithNodeGraph(nodes: Array<Record<string, unknown>>): ArrayBuffer {
  const bytes = new Uint8Array(Float32Array.from([0, 0, 0]).buffer);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  const doc = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 0 }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bytes.byteLength }],
    buffers: [
      { byteLength: bytes.byteLength, uri: `data:application/octet-stream;base64,${btoa(bin)}` },
    ],
  };
  return new TextEncoder().encode(JSON.stringify(doc)).buffer as ArrayBuffer;
}

/**
 * glTF's top-level `scene` names the ONE scene to display; the others are
 * alternates (an LOD variant, a rejected pose, a packaging scene). The loader
 * merged the roots of every scene, which silently multiplied the point count
 * and, when the alternates sat at different transforms, scattered copies of the
 * model through the cloud with nothing in the UI to explain them.
 */
describe('loadGltf — default scene selection', () => {
  test('a multi-scene asset loads only the scene `scene` names', async () => {
    const pc = await loadGltf(
      gltfWithScenes({
        sceneIndex: 1,
        sceneNodes: [[0], [1], [2]],
        translations: [[10, 0, 0], [20, 0, 0], [30, 0, 0]],
      }),
      'gltf',
    );
    expect(pc.pointCount).toBe(1);
    expect(pc.positions[0]).toBeCloseTo(20, 4);
  });

  test('scene 0 wins when the default is the first one', async () => {
    const pc = await loadGltf(
      gltfWithScenes({
        sceneIndex: 0,
        sceneNodes: [[0], [1]],
        translations: [[10, 0, 0], [20, 0, 0]],
      }),
      'gltf',
    );
    expect(pc.pointCount).toBe(1);
    expect(pc.positions[0]).toBeCloseTo(10, 4);
  });

  test('scenes but no `scene` property falls back to scene 0, not to all scenes', async () => {
    // The spec permits omitting `scene` and leaves the choice to the viewer.
    const pc = await loadGltf(
      gltfWithScenes({
        sceneNodes: [[0], [1]],
        translations: [[10, 0, 0], [20, 0, 0]],
      }),
      'gltf',
    );
    expect(pc.pointCount).toBe(1);
    expect(pc.positions[0]).toBeCloseTo(10, 4);
  });

  test('a multi-root default scene still loads all of ITS roots', async () => {
    // Selecting one scene must not be mistaken for selecting one node.
    const pc = await loadGltf(
      gltfWithScenes({
        sceneIndex: 0,
        sceneNodes: [[0, 1], [2]],
        translations: [[10, 0, 0], [20, 0, 0], [30, 0, 0]],
      }),
      'gltf',
    );
    expect(pc.pointCount).toBe(2);
    const xs = [pc.positions[0], pc.positions[3]].sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(10, 4);
    expect(xs[1]).toBeCloseTo(20, 4);
  });

  test('a single-scene asset is unaffected', async () => {
    const pc = await loadGltf(gltfWithVerts([0, 0, 0, 1, 1, 1]), 'gltf');
    expect(pc.pointCount).toBe(2);
  });
});

/**
 * The glTF spec forbids loops in the node hierarchy, so no real exporter emits
 * one — but a malformed or hostile file could, and unbounded recursion over it
 * surfaced as `RangeError: Maximum call stack size exceeded`, which reads as a
 * viewer crash rather than a bad asset. The walk is depth-capped so the failure
 * names the actual problem.
 */
describe('loadGltf — cyclic node graph', () => {
  test('a node cycle throws a named error, not a stack overflow', async () => {
    // loaders.gl resolves `children` indices into node OBJECTS, so this JSON
    // becomes a genuine object cycle in the graph `collectNode` walks — the
    // real path, not a hand-built stand-in.
    await expect(
      loadGltf(gltfWithNodeGraph([{ children: [1] }, { children: [0] }]), 'gltf'),
    ).rejects.toThrow(/cyclic or malformed/i);
  });

  test('the cycle failure names the asset, never "Maximum call stack size exceeded"', async () => {
    let thrown: unknown;
    try {
      await loadGltf(gltfWithNodeGraph([{ children: [1] }, { children: [0] }]), 'gltf');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).not.toBe('RangeError');
    expect((thrown as Error).message).not.toMatch(/call stack/i);
    expect((thrown as Error).message).toMatch(/glTF node hierarchy/i);
  });

  test('a self-referencing node is caught too', async () => {
    await expect(
      loadGltf(gltfWithNodeGraph([{ children: [0] }]), 'gltf'),
    ).rejects.toThrow(/cyclic or malformed/i);
  });

  test('a deep but legal chain still loads (the cap is not a false alarm)', async () => {
    // 64 levels deep, mesh at the leaf — extraordinary for a real rig and
    // comfortably under the cap, so the guard must not reject it.
    const depth = 64;
    const nodes: Array<Record<string, unknown>> = [];
    for (let i = 0; i < depth; i++) nodes.push({ children: [i + 1] });
    nodes.push({ mesh: 0, translation: [7, 0, 0] });
    const pc = await loadGltf(gltfWithNodeGraph(nodes), 'gltf');
    expect(pc.pointCount).toBe(1);
    expect(pc.positions[0]).toBeCloseTo(7, 4);
  });
});
