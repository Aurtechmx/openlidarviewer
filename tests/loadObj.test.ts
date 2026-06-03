import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadObj } from '../src/io/loadObj';

const fixturePath = fileURLToPath(new URL('./fixtures/tiny.obj', import.meta.url));

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(): ArrayBuffer {
  const file = readFileSync(fixturePath);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('loadObj — tiny.obj fixture (ground truth from FIXTURES.md)', () => {
  test('produces a non-empty point set whose count is a multiple of 3 components', async () => {
    const pc = await loadObj(loadFixture(), 'tiny.obj');
    expect(pc.pointCount).toBeGreaterThan(0);
    expect(pc.positions.length % 3).toBe(0);
  });

  test('first vertex is the origin [0, 0, 0]', async () => {
    const pc = await loadObj(loadFixture());
    expect(pc.positions[0]).toBeCloseTo(0, 5);
    expect(pc.positions[1]).toBeCloseTo(0, 5);
    expect(pc.positions[2]).toBeCloseTo(0, 5);
  });

  test('local bounds match the unit-ish cube [0,0,0]..[2,2,2]', async () => {
    const pc = await loadObj(loadFixture());
    const { min, max } = pc.bounds();
    expect(min[0]).toBeCloseTo(0, 4);
    expect(min[1]).toBeCloseTo(0, 4);
    expect(min[2]).toBeCloseTo(0, 4);
    expect(max[0]).toBeCloseTo(2, 4);
    expect(max[1]).toBeCloseTo(2, 4);
    expect(max[2]).toBeCloseTo(2, 4);
  });

  test('origin is [0, 0, 0] and sourceFormat is obj', async () => {
    const pc = await loadObj(loadFixture());
    expect(pc.origin).toEqual([0, 0, 0]);
    expect(pc.sourceFormat).toBe('obj');
  });

  test('name round-trips when given', async () => {
    const pc = await loadObj(loadFixture(), 'cube.obj');
    expect(pc.name).toBe('cube.obj');
  });
});
