import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPcd } from '../src/io/loadPcd';

/** Read a fixture as a tightly-sliced ArrayBuffer. */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

/** Build a minimal binary PCD with `x y z` float32 fields. */
function makeBinaryPcd(points: [number, number, number][]): ArrayBuffer {
  const header =
    `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\n` +
    `COUNT 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\n` +
    `VIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA binary\n`;
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(headerBytes.length + points.length * 12);
  new Uint8Array(buf).set(headerBytes, 0);
  const view = new DataView(buf);
  points.forEach((p, i) => {
    const base = headerBytes.length + i * 12;
    view.setFloat32(base, p[0], true);
    view.setFloat32(base + 4, p[1], true);
    view.setFloat32(base + 8, p[2], true);
  });
  return buf;
}

describe('loadPcd — ASCII', () => {
  test('decodes the 4-point ASCII fixture', async () => {
    const pc = await loadPcd(loadFixture('tiny.pcd'), 'tiny.pcd');
    expect(pc.pointCount).toBe(4);
    expect(pc.sourceFormat).toBe('pcd');
  });

  test('positions are recentred about the floored-min origin', async () => {
    const pc = await loadPcd(loadFixture('tiny.pcd'));
    expect(pc.origin).toEqual([1, 2, 3]); // floored min of (1,2,3)
    // First point (1,2,3) recentres to the local origin.
    expect(pc.positions[0]).toBeCloseTo(0, 5);
    expect(pc.positions[1]).toBeCloseTo(0, 5);
    expect(pc.positions[2]).toBeCloseTo(0, 5);
    // Last point (10,11,12) → local (9,9,9).
    expect(pc.positions[9]).toBeCloseTo(9, 5);
  });

  test('a 0–1 intensity field is rescaled to the full Uint16 range', async () => {
    const pc = await loadPcd(loadFixture('tiny.pcd'));
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity!.length).toBe(4);
    expect(pc.intensity![0]).toBe(Math.round(0.25 * 65535));
    expect(pc.intensity![3]).toBe(65535);
    // The fixture carries no rgb or normals.
    expect(pc.colors).toBeUndefined();
    expect(pc.normals).toBeUndefined();
  });
});

describe('loadPcd — binary', () => {
  test('decodes a minimal binary PCD', async () => {
    const pc = await loadPcd(makeBinaryPcd([
      [0, 0, 0],
      [2, 4, 6],
      [8, 10, 12],
    ]));
    expect(pc.pointCount).toBe(3);
    expect(pc.origin).toEqual([0, 0, 0]);
    expect(pc.positions[6]).toBeCloseTo(8, 5);
  });
});

describe('loadPcd — malformed input', () => {
  test('a non-PCD buffer throws a clear, caught error', async () => {
    const junk = new TextEncoder().encode('not a pcd file at all').buffer;
    await expect(loadPcd(junk)).rejects.toThrow();
  });
});
