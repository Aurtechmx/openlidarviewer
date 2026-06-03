import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPly } from '../src/io/loadPly';

const fixturePath = fileURLToPath(new URL('./fixtures/tiny.ply', import.meta.url));

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(): ArrayBuffer {
  const file = readFileSync(fixturePath);
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('loadPly — tiny.ply fixture (ground truth from FIXTURES.md)', () => {
  test('point count is 10', async () => {
    const pc = await loadPly(loadFixture(), 'tiny.ply');
    expect(pc.pointCount).toBe(10);
  });

  test('first point is the origin [0, 0, 0]', async () => {
    const pc = await loadPly(loadFixture());
    expect(pc.positions[0]).toBeCloseTo(0, 5);
    expect(pc.positions[1]).toBeCloseTo(0, 5);
    expect(pc.positions[2]).toBeCloseTo(0, 5);
  });

  test('local bounds match the fixture min/max', async () => {
    const pc = await loadPly(loadFixture());
    const { min, max } = pc.bounds();
    expect(min[0]).toBeCloseTo(0, 4);
    expect(min[1]).toBeCloseTo(0, 4);
    expect(min[2]).toBeCloseTo(0, 4);
    expect(max[0]).toBeCloseTo(9, 4);
    expect(max[1]).toBeCloseTo(4.5, 4);
    expect(max[2]).toBeCloseTo(2.25, 4);
  });

  test('origin is [0, 0, 0] and sourceFormat is ply', async () => {
    const pc = await loadPly(loadFixture());
    expect(pc.origin).toEqual([0, 0, 0]);
    expect(pc.sourceFormat).toBe('ply');
  });

  test('per-vertex RGB colors are carried as a Uint8Array', async () => {
    const pc = await loadPly(loadFixture());
    expect(pc.colors).toBeInstanceOf(Uint8Array);
    // Three bytes (rgb) per point.
    expect(pc.colors!.length).toBe(pc.pointCount * 3);
  });

  test('name defaults sensibly and round-trips when given', async () => {
    const named = await loadPly(loadFixture(), 'scan.ply');
    expect(named.name).toBe('scan.ply');
    const unnamed = await loadPly(loadFixture());
    expect(typeof unnamed.name).toBe('string');
  });
});
