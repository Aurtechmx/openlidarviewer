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
