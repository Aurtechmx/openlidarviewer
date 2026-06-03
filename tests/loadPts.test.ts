import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPts } from '../src/io/loadPts';

/** Read a fixture as a tightly-sliced ArrayBuffer. */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

/** Encode a PTS text body as an ArrayBuffer. */
function pts(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('loadPts — 7-column fixture (x y z intensity r g b)', () => {
  test('decodes the count-prefixed fixture', async () => {
    const pc = await loadPts(loadFixture('tiny.pts'), 'tiny.pts');
    expect(pc.pointCount).toBe(3); // the leading "3" is a count line, not a point
    expect(pc.sourceFormat).toBe('pts');
  });

  test('recentres positions and reads RGB before intensity', async () => {
    const pc = await loadPts(loadFixture('tiny.pts'));
    expect(pc.origin).toEqual([1, 2, 3]);
    expect(pc.positions[6]).toBeCloseTo(6, 4); // (7,8,9) → local (6,6,6)
    expect(pc.colors).toBeInstanceOf(Uint8Array);
    expect(Array.from(pc.colors!.slice(0, 3))).toEqual([255, 128, 0]);
    // Intensity 100/150/200 — already a wide range, kept as raw values.
    expect(Array.from(pc.intensity!)).toEqual([100, 150, 200]);
  });
});

describe('loadPts — column variants', () => {
  test('3-column files (x y z) carry neither intensity nor colour', async () => {
    const pc = await loadPts(pts('0 0 0\n1 1 1\n2 2 2\n'));
    expect(pc.pointCount).toBe(3);
    expect(pc.intensity).toBeUndefined();
    expect(pc.colors).toBeUndefined();
  });

  test('4-column files carry intensity; a 0–1 range is rescaled', async () => {
    const pc = await loadPts(pts('2\n0 0 0 0.5\n1 1 1 1.0\n'));
    expect(pc.pointCount).toBe(2);
    expect(pc.intensity![0]).toBe(Math.round(0.5 * 65535));
    expect(pc.colors).toBeUndefined();
  });

  test('6-column files carry colour but no intensity', async () => {
    const pc = await loadPts(pts('1 1 1 10 20 30\n2 2 2 40 50 60\n'));
    expect(pc.pointCount).toBe(2);
    expect(pc.intensity).toBeUndefined();
    expect(Array.from(pc.colors!.slice(0, 3))).toEqual([10, 20, 30]);
  });
});

describe('loadPts — robustness', () => {
  test('malformed lines are skipped, not fatal', async () => {
    const pc = await loadPts(pts('0 0 0\ngarbage line here\n5 5 5\n'));
    expect(pc.pointCount).toBe(2);
  });

  test('a file with no readable points throws a clear error', async () => {
    await expect(loadPts(pts('# just a comment\n'))).rejects.toThrow();
  });
});
