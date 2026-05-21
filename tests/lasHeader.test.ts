import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLasHeader } from '../src/io/lasHeader';

const fixturePath = fileURLToPath(new URL('./fixtures/tiny.las', import.meta.url));

function loadFixture(): ArrayBuffer {
  const file = readFileSync(fixturePath);
  // Slice to the exact byte range so the ArrayBuffer has no extra Node padding.
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('parseLasHeader — tiny.las fixture (ground truth from FIXTURES.md)', () => {
  const header = parseLasHeader(loadFixture());

  test('pointCount is 12', () => {
    expect(header.pointCount).toBe(12);
  });

  test('versionMinor is 4 (LAS 1.4)', () => {
    expect(header.versionMinor).toBe(4);
  });

  test('scale is [0.001, 0.001, 0.001]', () => {
    expect(header.scale[0]).toBeCloseTo(0.001, 12);
    expect(header.scale[1]).toBeCloseTo(0.001, 12);
    expect(header.scale[2]).toBeCloseTo(0.001, 12);
  });

  test('offset is [500000, 4100000, 200]', () => {
    expect(header.offset[0]).toBeCloseTo(500000.0, 6);
    expect(header.offset[1]).toBeCloseTo(4100000.0, 6);
    expect(header.offset[2]).toBeCloseTo(200.0, 6);
  });

  test('min bounds match the fixture first/min point', () => {
    expect(header.min[0]).toBeCloseTo(500123.456, 3);
    expect(header.min[1]).toBeCloseTo(4100876.789, 3);
    expect(header.min[2]).toBeCloseTo(210.25, 3);
  });

  test('max bounds match the fixture', () => {
    expect(header.max[0]).toBeCloseTo(500134.5, 3);
    expect(header.max[1]).toBeCloseTo(4100887.5, 3);
    expect(header.max[2]).toBeCloseTo(215.0, 3);
  });
});

describe('parseLasHeader — validation', () => {
  test('throws on a buffer without the LASF signature', () => {
    const bogus = new ArrayBuffer(256);
    expect(() => parseLasHeader(bogus)).toThrow();
  });
});
