import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadLas } from '../src/io/loadLas';

/** Read a fixture as a tightly-sliced ArrayBuffer (no pooled Node padding). */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

// Ground truth from FIXTURES.md.
const KNOWN_FIRST_GLOBAL: [number, number, number] = [500123.456, 4100876.789, 210.25];
const KNOWN_MIN: [number, number, number] = [500123.456, 4100876.789, 210.25];
const KNOWN_MAX: [number, number, number] = [500134.5, 4100887.5, 215.0];

describe('loadLas — tiny.las fixture (uncompressed)', () => {
  test('point count is 12', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las', 'tiny.las');
    expect(pc.pointCount).toBe(12);
  });

  test('declaredPointCount is set from the header', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.declaredPointCount).toBe(12);
  });

  test('origin is the floored min bounds', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.origin).toEqual([500123, 4100876, 210]);
  });

  test('sourceFormat is las', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.sourceFormat).toBe('las');
  });

  test('first recentered point + origin reconstructs the global coord to <= 1e-3 m', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    for (let axis = 0; axis < 3; axis++) {
      const reconstructed = pc.positions[axis] + pc.origin[axis];
      expect(Math.abs(reconstructed - KNOWN_FIRST_GLOBAL[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('all points reconstruct within the declared global bounds (<= 1e-3 m)', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    const { min, max } = pc.bounds();
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(min[axis] + pc.origin[axis] - KNOWN_MIN[axis])).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(max[axis] + pc.origin[axis] - KNOWN_MAX[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('intensity and classification are decoded', async () => {
    const pc = await loadLas(loadFixture('tiny.las'), 'las');
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity!.length).toBe(12);
    expect(pc.classification).toBeInstanceOf(Uint8Array);
    expect(pc.classification!.length).toBe(12);
  });
});

describe('loadLas — tiny.laz fixture (compressed)', () => {
  test('point count is 12', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz', 'tiny.laz');
    expect(pc.pointCount).toBe(12);
  });

  test('sourceFormat is laz', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    expect(pc.sourceFormat).toBe('laz');
  });

  test('first recentered point + origin reconstructs the global coord to <= 1e-3 m', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    for (let axis = 0; axis < 3; axis++) {
      const reconstructed = pc.positions[axis] + pc.origin[axis];
      expect(Math.abs(reconstructed - KNOWN_FIRST_GLOBAL[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('all points reconstruct within the declared global bounds (<= 1e-3 m)', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    const { min, max } = pc.bounds();
    for (let axis = 0; axis < 3; axis++) {
      expect(Math.abs(min[axis] + pc.origin[axis] - KNOWN_MIN[axis])).toBeLessThanOrEqual(1e-3);
      expect(Math.abs(max[axis] + pc.origin[axis] - KNOWN_MAX[axis])).toBeLessThanOrEqual(1e-3);
    }
  });

  test('intensity and classification are decoded', async () => {
    const pc = await loadLas(loadFixture('tiny.laz'), 'laz');
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity!.length).toBe(12);
    expect(pc.classification).toBeInstanceOf(Uint8Array);
    expect(pc.classification!.length).toBe(12);
  });
});
