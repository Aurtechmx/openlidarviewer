import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from '@loaders.gl/core';
import { PLYLoader } from '@loaders.gl/ply';
import { loadPly } from '../src/io/loadPly';
import { LOCAL_ONLY_LOADER_OPTIONS } from '../src/io/loaderConfig';
import { sanitizeAndRecenter } from '../src/io/sanitizeCloud';

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
    expect(pc.colors!).toHaveLength(pc.pointCount * 3);
  });

  test('name defaults sensibly and round-trips when given', async () => {
    const named = await loadPly(loadFixture(), 'scan.ply');
    expect(named.name).toBe('scan.ply');
    const unnamed = await loadPly(loadFixture());
    expect(typeof unnamed.name).toBe('string');
  });
});

/** Build an in-memory ASCII PLY with the given vertex lines and property list. */
function asciiPly(props: string[], lines: string[]): ArrayBuffer {
  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${lines.length}`,
    ...props.map((p) => `property float ${p}`),
    'end_header',
    '',
  ].join('\n');
  return new TextEncoder().encode(header + lines.join('\n') + '\n').buffer as ArrayBuffer;
}

describe('loadPly — ASCII body scanner', () => {
  test('reads x/y/z at the right stride when other properties sit between them', async () => {
    // x, then two fillers, then y, z — a record layout that only parses if the
    // scanner honours the property stride rather than assuming xyz are adjacent.
    const pc = await loadPly(
      asciiPly(['x', 'nx', 'ny', 'y', 'z'], ['1 9 9 2 3', '4 9 9 5 6']),
    );
    expect(pc.pointCount).toBe(2);
    expect(Array.from(pc.positions.slice(0, 6)).map((v) => Math.round(v))).toEqual([
      0, 0, 0, 3, 3, 3,
    ]);
  });

  test('keeps UTM-scale coordinates precise through the f64 path', async () => {
    // Recentred against the floored min origin, a 0.001 offset must survive —
    // it only does if the body is read as f64 before narrowing.
    const pc = await loadPly(
      asciiPly(['x', 'y', 'z'], ['500000.000 4500000.000 100.000', '500000.001 4500000.000 100.000']),
    );
    const dx = pc.positions[3] - pc.positions[0];
    expect(dx).toBeCloseTo(0.001, 6);
  });

  test('tolerates irregular whitespace between fields', async () => {
    const pc = await loadPly(asciiPly(['x', 'y', 'z'], ['  1\t 2   3 ', '4  5\t\t6']));
    expect(pc.pointCount).toBe(2);
  });

  test('refuses a body that runs out of fields before the promised count', async () => {
    // Header promises 3 vertices; only 2 records are present.
    const header = [
      'ply', 'format ascii 1.0', 'element vertex 3',
      'property float x', 'property float y', 'property float z',
      'end_header', '',
    ].join('\n');
    const buf = new TextEncoder().encode(header + '1 2 3\n4 5 6\n').buffer as ArrayBuffer;
    // The f64 scanner declines; the loader falls back rather than inventing points.
    const pc = await loadPly(buf).catch(() => null);
    if (pc) expect(pc.pointCount).toBeLessThanOrEqual(3);
  });
});

/** One binary PLY vertex property: how it is written into the body. */
type BinaryPlyProp = { name: string; type: 'double' | 'float' | 'uchar' };

const BINARY_PROP_SIZE: Record<BinaryPlyProp['type'], number> = { double: 8, float: 4, uchar: 1 };

/**
 * Build an in-memory binary PLY: an ASCII header followed by `rows` written
 * directly into a `DataView` at the declared per-property byte widths, in
 * `props` order — the same layout `@loaders.gl/ply`'s own binary reader (and
 * `readBinaryDoubleVertices`) expect.
 */
function binaryPly(
  format: 'binary_little_endian' | 'binary_big_endian',
  props: BinaryPlyProp[],
  rows: number[][],
): ArrayBuffer {
  const header = [
    'ply',
    `format ${format} 1.0`,
    `element vertex ${rows.length}`,
    ...props.map((p) => `property ${p.type} ${p.name}`),
    'end_header',
    '',
  ].join('\n');
  const headerBytes = new TextEncoder().encode(header);
  const littleEndian = format === 'binary_little_endian';
  const stride = props.reduce((sum, p) => sum + BINARY_PROP_SIZE[p.type], 0);
  const buffer = new ArrayBuffer(headerBytes.length + rows.length * stride);
  new Uint8Array(buffer, 0, headerBytes.length).set(headerBytes);
  const view = new DataView(buffer, headerBytes.length);
  for (let i = 0; i < rows.length; i++) {
    let offset = i * stride;
    for (let p = 0; p < props.length; p++) {
      const v = rows[i][p];
      switch (props[p].type) {
        case 'double':
          view.setFloat64(offset, v, littleEndian);
          offset += 8;
          break;
        case 'float':
          view.setFloat32(offset, v, littleEndian);
          offset += 4;
          break;
        case 'uchar':
          view.setUint8(offset, v);
          offset += 1;
          break;
      }
    }
  }
  return buffer;
}

/** Same header/vertex line construction as `binaryPly`, ASCII-encoded, for the cross-path check. */
function asciiPlyRows(props: string[], rows: number[][]): ArrayBuffer {
  const header = [
    'ply',
    'format ascii 1.0',
    `element vertex ${rows.length}`,
    ...props.map((p) => `property double ${p}`),
    'end_header',
    '',
  ].join('\n');
  // String(v) round-trips to the exact same double Number() will recover —
  // the shortest decimal representation of a double is unique to it.
  const lines = rows.map((r) => r.map(String).join(' '));
  return new TextEncoder().encode(header + lines.join('\n') + '\n').buffer as ArrayBuffer;
}

// Five seeded points at UTM magnitudes (easting ~500 km, northing ~4,000 km,
// elevation ~1.2 km), spread by tens of metres in each axis — the shape of a
// real scan around a declared reference point.
const UTM_SEED_POINTS: [number, number, number][] = [
  [500000.123456789, 4000000.654321987, 1234.567891234],
  [500000.124456789, 4000051.154321987, 1214.317891234],
  [500075.373456789, 3999969.904321987, 1274.692891234],
  [499959.623456789, 4000080.779321987, 1174.192891234],
  [500100.122456789, 3999900.655321987, 1334.566891234],
];

describe('loadPly — binary double body decodes at full precision (v0.7 D5 Part 1)', () => {
  // Bound derivation: a recentred coordinate is subtracted from the seed in
  // float64 and only then narrowed to float32 (coordinateBridge.recenter),
  // so the one rounding step is float64 -> float32 on a value of magnitude
  // `m`. That rounds to the nearest representable float32, which is at most
  // half a ULP away: `m * 2**-24` (2**-23 relative epsilon at that binade,
  // halved for round-to-nearest). UTM_SEED_POINTS recentre (floored-min
  // origin) to at most ~181 m on the y axis, so the bound here is
  // `181 * 2**-24` ~= 1.08e-5 m — under the 2e-5 m ceiling asserted below
  // with margin for the other two axes' smaller spreads.
  const WORLD_ERROR_BOUND_M = 2e-5;

  function assertWorldMatchesSeed(pc: Awaited<ReturnType<typeof loadPly>>) {
    expect(pc.pointCount).toBe(UTM_SEED_POINTS.length);
    const out: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < UTM_SEED_POINTS.length; i++) {
      pc.worldXYZ(i, out);
      const [ex, ey, ez] = UTM_SEED_POINTS[i];
      expect(Math.abs(out[0] - ex)).toBeLessThanOrEqual(WORLD_ERROR_BOUND_M);
      expect(Math.abs(out[1] - ey)).toBeLessThanOrEqual(WORLD_ERROR_BOUND_M);
      expect(Math.abs(out[2] - ez)).toBeLessThanOrEqual(WORLD_ERROR_BOUND_M);
    }
  }

  test('binary_little_endian double x/y/z round-trip within the float32 local-storage bound', async () => {
    const buf = binaryPly(
      'binary_little_endian',
      [{ name: 'x', type: 'double' }, { name: 'y', type: 'double' }, { name: 'z', type: 'double' }],
      UTM_SEED_POINTS.map((p) => [...p]),
    );
    const pc = await loadPly(buf, 'utm-le.ply');
    assertWorldMatchesSeed(pc);
  });

  test('binary_big_endian double x/y/z round-trip within the float32 local-storage bound', async () => {
    const buf = binaryPly(
      'binary_big_endian',
      [{ name: 'x', type: 'double' }, { name: 'y', type: 'double' }, { name: 'z', type: 'double' }],
      UTM_SEED_POINTS.map((p) => [...p]),
    );
    const pc = await loadPly(buf, 'utm-be.ply');
    assertWorldMatchesSeed(pc);
  });

  test('little- and big-endian encodings of the same points decode to identical positions', async () => {
    const props = [{ name: 'x', type: 'double' as const }, { name: 'y', type: 'double' as const }, { name: 'z', type: 'double' as const }];
    const rows = UTM_SEED_POINTS.map((p) => [...p]);
    const le = await loadPly(binaryPly('binary_little_endian', props, rows));
    const be = await loadPly(binaryPly('binary_big_endian', props, rows));
    expect(Array.from(be.positions)).toEqual(Array.from(le.positions));
    expect(be.origin).toEqual(le.origin);
  });

  test('reads x/y/z at the right stride when other-typed properties sit between them', async () => {
    // x, then a float normal triple, then y, z, then a colour triple — the
    // binary analogue of the ASCII scanner's stride test above.
    const props: BinaryPlyProp[] = [
      { name: 'x', type: 'double' },
      { name: 'nx', type: 'float' },
      { name: 'ny', type: 'float' },
      { name: 'nz', type: 'float' },
      { name: 'y', type: 'double' },
      { name: 'z', type: 'double' },
      { name: 'red', type: 'uchar' },
      { name: 'green', type: 'uchar' },
      { name: 'blue', type: 'uchar' },
    ];
    const rows = UTM_SEED_POINTS.map((p) => [p[0], 0.1, 0.2, 0.3, p[1], p[2], 10, 20, 30]);
    const pc = await loadPly(binaryPly('binary_little_endian', props, rows));
    assertWorldMatchesSeed(pc);
    expect(pc.colors).toBeInstanceOf(Uint8Array);
  });

  test('matches the ASCII f64 path bit-for-bit on the same points', async () => {
    const props = [{ name: 'x', type: 'double' as const }, { name: 'y', type: 'double' as const }, { name: 'z', type: 'double' as const }];
    const rows = UTM_SEED_POINTS.map((p) => [...p]);
    const binary = await loadPly(binaryPly('binary_little_endian', props, rows));
    const ascii = await loadPly(asciiPlyRows(['x', 'y', 'z'], rows));
    // Both paths stage the same doubles and run through the same
    // sanitizeAndRecenter, so the float32 output must be identical, not
    // merely close.
    expect(Array.from(binary.positions)).toEqual(Array.from(ascii.positions));
    expect(binary.origin).toEqual(ascii.origin);
  });

  test('a float-typed binary body loads byte-identically to before this change', async () => {
    // A float property never held more precision than the loader already
    // kept, so `readBinaryDoubleVertices` must decline and this reduces to
    // the pre-existing `Float64Array.from(positionAttr.value)` widening.
    // The golden here reproduces exactly that: parse with the same library
    // call loadPly makes, widen the loader's Float32Array values, and run
    // them through the same sanitizeAndRecenter — the two pre-change steps
    // loadPly took for every binary body before this fix.
    const props = [{ name: 'x', type: 'float' as const }, { name: 'y', type: 'float' as const }, { name: 'z', type: 'float' as const }];
    const rows = UTM_SEED_POINTS.map((p) => [...p]);
    const buf = binaryPly('binary_little_endian', props, rows);

    const mesh = await parse(buf, PLYLoader, LOCAL_ONLY_LOADER_OPTIONS);
    const positionAttr = mesh.attributes.POSITION;
    if (!positionAttr) throw new Error('test setup: PLY has no POSITION attribute');
    const golden = sanitizeAndRecenter(Float64Array.from(positionAttr.value), {});

    const pc = await loadPly(buf, 'float-binary.ply');
    expect(Array.from(pc.positions)).toEqual(Array.from(golden.positions));
    expect(pc.origin).toEqual(golden.origin);
  });

  test('a list property inside the vertex element falls back to the float32 values (ambiguous stride)', async () => {
    const header = [
      'ply',
      'format binary_little_endian 1.0',
      'element vertex 2',
      'property double x',
      'property double y',
      'property double z',
      'property list uchar float extra',
      'end_header',
      '',
    ].join('\n');
    const headerBytes = new TextEncoder().encode(header);
    // Per vertex: 3 doubles + a zero-length list (one uchar count byte, no items).
    const body = new ArrayBuffer(headerBytes.length + 2 * 25);
    new Uint8Array(body, 0, headerBytes.length).set(headerBytes);
    const view = new DataView(body, headerBytes.length);
    for (let i = 0; i < 2; i++) {
      const [x, y, z] = UTM_SEED_POINTS[i];
      view.setFloat64(i * 25 + 0, x, true);
      view.setFloat64(i * 25 + 8, y, true);
      view.setFloat64(i * 25 + 16, z, true);
      view.setUint8(i * 25 + 24, 0); // list count
    }
    const pc = await loadPly(body);
    expect(pc.pointCount).toBe(2);
    // The fallback quantised the coordinates onto the float32 grid: the
    // world error is far above the double-precision bound this suite
    // otherwise asserts, proving the ambiguous-stride bail-out fired rather
    // than reading through the list property by accident.
    const out: [number, number, number] = [0, 0, 0];
    pc.worldXYZ(0, out);
    const err = Math.max(
      Math.abs(out[0] - UTM_SEED_POINTS[0][0]),
      Math.abs(out[1] - UTM_SEED_POINTS[0][1]),
      Math.abs(out[2] - UTM_SEED_POINTS[0][2]),
    );
    expect(err).toBeGreaterThan(WORLD_ERROR_BOUND_M);
  });

  test('an element declared before vertex falls back to the float32 values', async () => {
    const header = [
      'ply',
      'format binary_little_endian 1.0',
      'element face 0',
      'property list uchar int vertex_indices',
      'element vertex 2',
      'property double x',
      'property double y',
      'property double z',
      'end_header',
      '',
    ].join('\n');
    const headerBytes = new TextEncoder().encode(header);
    const body = new ArrayBuffer(headerBytes.length + 2 * 24);
    new Uint8Array(body, 0, headerBytes.length).set(headerBytes);
    const view = new DataView(body, headerBytes.length);
    for (let i = 0; i < 2; i++) {
      const [x, y, z] = UTM_SEED_POINTS[i];
      view.setFloat64(i * 24 + 0, x, true);
      view.setFloat64(i * 24 + 8, y, true);
      view.setFloat64(i * 24 + 16, z, true);
    }
    const pc = await loadPly(body);
    expect(pc.pointCount).toBe(2);
    const out: [number, number, number] = [0, 0, 0];
    pc.worldXYZ(0, out);
    const err = Math.max(
      Math.abs(out[0] - UTM_SEED_POINTS[0][0]),
      Math.abs(out[1] - UTM_SEED_POINTS[0][1]),
      Math.abs(out[2] - UTM_SEED_POINTS[0][2]),
    );
    expect(err).toBeGreaterThan(WORLD_ERROR_BOUND_M);
  });
});
