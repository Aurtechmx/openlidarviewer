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

/** Build a minimal binary PCD whose `x y z` fields are 8-byte floats. */
function makeDoubleBinaryPcd(points: [number, number, number][]): ArrayBuffer {
  const header =
    `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 8 8 8\nTYPE F F F\n` +
    `COUNT 1 1 1\nWIDTH ${points.length}\nHEIGHT 1\n` +
    `VIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${points.length}\nDATA binary\n`;
  const headerBytes = new TextEncoder().encode(header);
  const buf = new ArrayBuffer(headerBytes.length + points.length * 24);
  new Uint8Array(buf).set(headerBytes, 0);
  const view = new DataView(buf);
  points.forEach((p, i) => {
    const base = headerBytes.length + i * 24;
    view.setFloat64(base, p[0], true);
    view.setFloat64(base + 8, p[1], true);
    view.setFloat64(base + 16, p[2], true);
  });
  return buf;
}

describe('loadPcd — UTM-scale coordinates keep sub-millimetre precision', () => {
  // A bare f32 snaps 500000.123 to a ~3 cm grid and 4000000.123 to ~25 cm —
  // the origin subtraction must happen in f64, BEFORE the f32 narrowing, for
  // the coordinate-bridge contract to mean anything.
  const utmPoints: [number, number, number][] = [
    [500000.123, 4000000.123, 210.25],
    [500010.623, 4000010.623, 215.75],
  ];

  test('ascii body: origin + local position reconstructs within 1 mm', async () => {
    const pcd =
      `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 8 8 8\nTYPE F F F\n` +
      `COUNT 1 1 1\nWIDTH 2\nHEIGHT 1\nVIEWPOINT 0 0 0 1 0 0 0\nPOINTS 2\nDATA ascii\n` +
      utmPoints.map((p) => p.join(' ')).join('\n') + '\n';
    const pc = await loadPcd(new TextEncoder().encode(pcd).buffer, 'utm.pcd');
    expect(pc.pointCount).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(pc.positions[i * 3] + pc.origin[0] - utmPoints[i][0])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 1] + pc.origin[1] - utmPoints[i][1])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 2] + pc.origin[2] - utmPoints[i][2])).toBeLessThan(0.001);
    }
  });

  test('binary body with 8-byte float fields: reconstructs within 1 mm', async () => {
    const pc = await loadPcd(makeDoubleBinaryPcd(utmPoints), 'utm-f64.pcd');
    expect(pc.pointCount).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(pc.positions[i * 3] + pc.origin[0] - utmPoints[i][0])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 1] + pc.origin[1] - utmPoints[i][1])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 2] + pc.origin[2] - utmPoints[i][2])).toBeLessThan(0.001);
    }
  });

  // x/y/z are not required to lead the record, and a multi-count field can sit
  // before them — the f64 column extractor must locate x/y/z by name and sum
  // the COUNT-widths ahead of each. A leading 3-wide `normal` + trailing `rgb`
  // put x/y/z at token columns 3/4/5, out of field order (z before x/y is not
  // used here but the index math is identical).
  test('ascii body with a reordered, multi-count field layout stays sub-mm', async () => {
    const pcd =
      `# .PCD v0.7\nVERSION 0.7\nFIELDS normal x y z rgb\nSIZE 4 8 8 8 4\n` +
      `TYPE F F F F U\nCOUNT 3 1 1 1 1\nWIDTH 2\nHEIGHT 1\n` +
      `VIEWPOINT 0 0 0 1 0 0 0\nPOINTS 2\nDATA ascii\n` +
      utmPoints
        .map((p) => `0 0 1 ${p[0]} ${p[1]} ${p[2]} 4278190080`)
        .join('\n') + '\n';
    const pc = await loadPcd(new TextEncoder().encode(pcd).buffer, 'reordered.pcd');
    expect(pc.pointCount).toBe(2);
    for (let i = 0; i < 2; i++) {
      expect(Math.abs(pc.positions[i * 3] + pc.origin[0] - utmPoints[i][0])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 1] + pc.origin[1] - utmPoints[i][1])).toBeLessThan(0.001);
      expect(Math.abs(pc.positions[i * 3 + 2] + pc.origin[2] - utmPoints[i][2])).toBeLessThan(0.001);
    }
  });
});

describe('loadPcd — malformed input', () => {
  test('a non-PCD buffer throws a clear, caught error', async () => {
    const junk = new TextEncoder().encode('not a pcd file at all').buffer;
    await expect(loadPcd(junk)).rejects.toThrow();
  });
});
