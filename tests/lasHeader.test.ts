import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseLasHeader } from '../src/io/lasHeader';
import { LoadError } from '../src/io/loadErrors';

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

  test('pointFormat is 6 (per FIXTURES.md)', () => {
    expect(header.pointFormat).toBe(6);
  });

  test('the point-record layout is self-consistent with the file size', () => {
    expect(header.offsetToPointData).toBeGreaterThanOrEqual(227);
    expect(header.pointDataRecordLength).toBeGreaterThan(0);
    // The 12 records must fit between the data offset and the 735-byte file.
    expect(header.offsetToPointData + 12 * header.pointDataRecordLength).toBe(735);
  });
});

describe('parseLasHeader — validation', () => {
  test('throws on a buffer without the LASF signature', () => {
    const bogus = new ArrayBuffer(256);
    expect(() => parseLasHeader(bogus)).toThrow();
  });

  test('throws a clear error on a buffer too small to hold a header', () => {
    expect(() => parseLasHeader(new ArrayBuffer(100))).toThrow(/too small/i);
  });
});

describe('parseLasHeader — corrupted numeric header fields', () => {
  // Scale, offset and bounds feed computeOrigin and the per-record decode
  // (`local = (int * scale + offset) - origin`). A single non-finite value
  // would turn every coordinate NaN and the load would "succeed" into an
  // empty scene, so the parser must refuse the file with the typed error the
  // pipeline maps to a clear message.

  test('a NaN min-X bound raises a typed malformed-file error', () => {
    const buf = loadFixture();
    new Uint8Array(buf).fill(0xff, 187, 195); // min-X float64 → NaN
    let caught: unknown;
    try {
      parseLasHeader(buf);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoadError);
    expect((caught as LoadError).category).toBe('malformed-file');
  });

  test('a zero X scale factor is rejected', () => {
    const buf = loadFixture();
    new Uint8Array(buf).fill(0x00, 131, 139); // scale-X float64 → 0
    expect(() => parseLasHeader(buf)).toThrow(LoadError);
  });

  test('a negative X scale factor is rejected as malformed', () => {
    // No LAS writer emits a negative scale — it would mirror the axis.
    const buf = loadFixture();
    new DataView(buf).setFloat64(131, -0.001, true); // scale-X float64 → -0.001
    let caught: unknown;
    try {
      parseLasHeader(buf);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LoadError);
    expect((caught as LoadError).category).toBe('malformed-file');
  });

  test('a NaN X offset is rejected', () => {
    const buf = loadFixture();
    new Uint8Array(buf).fill(0xff, 155, 163); // offset-X float64 → NaN
    expect(() => parseLasHeader(buf)).toThrow(LoadError);
  });
});
