import { sanitizeAndRecenter, sanitizeLocalCloud } from '../src/io/sanitizeCloud';
import type { CloudAttributes } from '../src/io/sanitizeCloud';
import { LoadError } from '../src/io/loadErrors';
import { loadPly } from '../src/io/loadPly';
import { loadPcd } from '../src/io/loadPcd';
import { loadLas } from '../src/io/loadLas';

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

/** Build an ASCII PCD with `x y z` columns from raw (possibly non-finite) tokens. */
function asciiPcd(rows: string[]): ArrayBuffer {
  const text =
    `# .PCD v0.7\nVERSION 0.7\nFIELDS x y z\nSIZE 4 4 4\nTYPE F F F\n` +
    `COUNT 1 1 1\nWIDTH ${rows.length}\nHEIGHT 1\n` +
    `VIEWPOINT 0 0 0 1 0 0 0\nPOINTS ${rows.length}\nDATA ascii\n` +
    rows.join('\n') +
    '\n';
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

/**
 * Build a LAS 1.2 point-format-0 file. `scale` is deliberately a parameter:
 * a header may declare a finite but astronomically large scale factor, which
 * turns `int * scale + offset` into ±Infinity for a large coordinate — the one
 * way a LAS record reaches the cloud non-finite.
 */
function makeLas(
  records: Array<{ x: number; y: number; z: number; intensity: number; classification: number }>,
  scale: [number, number, number] = [0.01, 0.01, 0.01],
): ArrayBuffer {
  const HEADER_SIZE = 227;
  const RECORD_LENGTH = 20;
  const buf = new ArrayBuffer(HEADER_SIZE + records.length * RECORD_LENGTH);
  const view = new DataView(buf);
  for (let i = 0; i < 4; i++) view.setUint8(i, 'LASF'.charCodeAt(i));
  view.setUint8(25, 2); // version minor → 1.2
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, HEADER_SIZE, true);
  view.setUint32(100, 0, true);
  view.setUint8(104, 0); // point format 0
  view.setUint16(105, RECORD_LENGTH, true);
  view.setUint32(107, records.length, true);
  view.setFloat64(131, scale[0], true);
  view.setFloat64(139, scale[1], true);
  view.setFloat64(147, scale[2], true);
  // Offsets stay 0; bounds are declared as a finite unit box (the header guard
  // only requires them finite, and the origin is floored from min).
  view.setFloat64(179, 1, true); // max x
  view.setFloat64(187, 0, true); // min x
  view.setFloat64(195, 1, true); // max y
  view.setFloat64(203, 0, true); // min y
  view.setFloat64(211, 1, true); // max z
  view.setFloat64(219, 0, true); // min z
  records.forEach((r, i) => {
    const base = HEADER_SIZE + i * RECORD_LENGTH;
    view.setInt32(base, r.x, true);
    view.setInt32(base + 4, r.y, true);
    view.setInt32(base + 8, r.z, true);
    view.setUint16(base + 12, r.intensity, true);
    view.setUint8(base + 15, r.classification);
  });
  return buf;
}

describe('sanitizeAndRecenter — attribute lockstep', () => {
  test('a NaN point in the middle takes its own colour, class and intensity with it', () => {
    // Four points; the second is unplaceable. Every attribute value is distinct
    // per point, so a surviving point wearing a neighbour's attribute is visible.
    const coords = new Float64Array([
      10, 10, 10,
      Number.NaN, 11, 11,
      12, 12, 12,
      13, 13, 13,
    ]);
    const result = sanitizeAndRecenter(coords, {
      colors: new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4]),
      classification: new Uint8Array([11, 22, 33, 44]),
      intensity: new Uint16Array([100, 200, 300, 400]),
    });

    expect(result.excludedCount).toBe(1);
    expect(result.positions.length).toBe(9);
    // Origin is the floored min of the SURVIVORS.
    expect(result.origin).toEqual([10, 10, 10]);
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 2, 2, 2, 3, 3, 3]);
    // Each survivor keeps the attributes it arrived with — point 2's are gone,
    // and points 3 and 4 did NOT inherit them.
    expect(Array.from(result.attributes.colors!)).toEqual([1, 1, 1, 3, 3, 3, 4, 4, 4]);
    expect(Array.from(result.attributes.classification!)).toEqual([11, 33, 44]);
    expect(Array.from(result.attributes.intensity!)).toEqual([100, 300, 400]);
  });

  test('attributes the cloud never carried stay absent', () => {
    const carried: CloudAttributes = { classification: new Uint8Array([7, 8]) };
    const result = sanitizeAndRecenter(new Float64Array([0, 0, 0, Number.NaN, 1, 1]), carried);
    expect(result.attributes.classification).toBeDefined();
    expect(result.attributes.colors).toBeUndefined();
    expect(result.attributes.intensity).toBeUndefined();
    expect(result.attributes.gpsTime).toBeUndefined();
  });

  test('every parallel attribute the model knows is filtered in lockstep', () => {
    const result = sanitizeAndRecenter(new Float64Array([0, 0, 0, 1, Number.NaN, 1, 2, 2, 2]), {
      colors: new Uint8Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
      normals: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]),
      intensity: new Uint16Array([1, 2, 3]),
      classification: new Uint8Array([1, 2, 3]),
      returnNumber: new Uint8Array([1, 2, 3]),
      returnCount: new Uint8Array([1, 2, 3]),
      pointSourceId: new Uint16Array([1, 2, 3]),
      gpsTime: new Float64Array([1, 2, 3]),
    });
    expect(Array.from(result.attributes.colors!)).toEqual([1, 1, 1, 3, 3, 3]);
    expect(Array.from(result.attributes.normals!)).toEqual([1, 0, 0, 0, 0, 1]);
    expect(Array.from(result.attributes.intensity!)).toEqual([1, 3]);
    expect(Array.from(result.attributes.classification!)).toEqual([1, 3]);
    expect(Array.from(result.attributes.returnNumber!)).toEqual([1, 3]);
    expect(Array.from(result.attributes.returnCount!)).toEqual([1, 3]);
    expect(Array.from(result.attributes.pointSourceId!)).toEqual([1, 3]);
    expect(Array.from(result.attributes.gpsTime!)).toEqual([1, 3]);
  });
});

describe('sanitizeAndRecenter — which coordinates are excluded', () => {
  test.each([
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('%s in any axis excludes the point', (_label, bad) => {
    for (let axis = 0; axis < 3; axis++) {
      const coords = new Float64Array([0, 0, 0, 5, 5, 5]);
      coords[3 + axis] = bad;
      const result = sanitizeAndRecenter(coords, {});
      expect(result.excludedCount).toBe(1);
      expect(result.positions.length).toBe(3);
      expect(Array.from(result.positions)).toEqual([0, 0, 0]);
    }
  });

  test('a -Infinity coordinate does not poison the origin', () => {
    // floor(-Infinity) is -Infinity: an origin taken before the filter would
    // subtract -Infinity from every surviving point and turn the cloud to NaN.
    const result = sanitizeAndRecenter(
      new Float64Array([100.5, 200.5, 300.5, Number.NEGATIVE_INFINITY, 200.5, 300.5]),
      {},
    );
    expect(result.origin).toEqual([100, 200, 300]);
    expect(Array.from(result.positions).every((v) => Number.isFinite(v))).toBe(true);
  });

  test('a clean cloud is untouched, allocates no copies and warns about nothing', () => {
    const coords = new Float64Array([10.25, 20.5, 30.75, 11.25, 21.5, 31.75]);
    const colors = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const result = sanitizeAndRecenter(coords, { colors });
    expect(result.excludedCount).toBe(0);
    expect(result.warning).toBeUndefined();
    expect(result.origin).toEqual([10, 20, 30]);
    expect(Array.from(result.positions)).toEqual([0.25, 0.5, 0.75, 1.25, 1.5, 1.75]);
    // The attribute array is passed through, not rebuilt.
    expect(result.attributes.colors).toBe(colors);
  });
});

describe('sanitizeAndRecenter — reporting and refusal', () => {
  test('the warning names the count, the total and the reason', () => {
    const result = sanitizeAndRecenter(
      new Float64Array([0, 0, 0, Number.NaN, 1, 1, Number.POSITIVE_INFINITY, 2, 2, 3, 3, 3]),
      {},
    );
    expect(result.excludedCount).toBe(2);
    expect(result.warning).toContain('2 of 4');
    expect(result.warning).toMatch(/non-finite/i);
  });

  test('a cloud with no valid point left fails rather than loading empty', () => {
    expect(() =>
      sanitizeAndRecenter(new Float64Array([Number.NaN, 0, 0, 0, Number.POSITIVE_INFINITY, 0]), {}),
    ).toThrow(LoadError);
  });

  test('the refusal is categorised malformed-file', () => {
    try {
      sanitizeAndRecenter(new Float64Array([Number.NaN, Number.NaN, Number.NaN]), {});
      throw new Error('expected sanitizeAndRecenter to reject the cloud');
    } catch (err) {
      expect(err).toBeInstanceOf(LoadError);
      expect((err as LoadError).category).toBe('malformed-file');
    }
  });

  test('coordinates that are not whole xyz records are refused', () => {
    expect(() => sanitizeAndRecenter(new Float64Array([1, 2, 3, 4]), {})).toThrow(LoadError);
  });

  test('an empty cloud is passed through for the parse guard to reject', () => {
    // Nothing was excluded, so there is nothing to warn about; `parseBuffer`
    // already refuses a zero-point cloud with its own message.
    const result = sanitizeAndRecenter(new Float64Array(0), {});
    expect(result.positions.length).toBe(0);
    expect(result.warning).toBeUndefined();
  });
});

describe('sanitizeLocalCloud — the same policy for already-local positions', () => {
  test('filters positions and attributes in lockstep without touching an origin', () => {
    const result = sanitizeLocalCloud(
      new Float32Array([0, 0, 0, Number.NaN, 1, 1, 2, 2, 2]),
      { classification: new Uint8Array([1, 2, 3]) },
    );
    expect(result.excludedCount).toBe(1);
    expect(Array.from(result.positions)).toEqual([0, 0, 0, 2, 2, 2]);
    expect(Array.from(result.attributes.classification!)).toEqual([1, 3]);
    expect(result.warning).toContain('1 of 3');
  });

  test('a clean cloud passes straight through', () => {
    const positions = new Float32Array([0, 0, 0, 1, 1, 1]);
    const result = sanitizeLocalCloud(positions, {});
    expect(result.positions).toBe(positions);
    expect(result.excludedCount).toBe(0);
    expect(result.warning).toBeUndefined();
  });
});

describe('loadPly — non-finite vertices', () => {
  test('an unplaceable vertex is dropped and its colour goes with it', async () => {
    const pc = await loadPly(
      asciiPly(
        ['x', 'y', 'z', 'red', 'green', 'blue'],
        ['10 10 10 1 1 1', 'nan 11 11 2 2 2', '12 12 12 3 3 3'],
      ),
    );
    expect(pc.pointCount).toBe(2);
    expect(Array.from(pc.colors!)).toEqual([1, 1, 1, 3, 3, 3]);
    expect(pc.metadata?.loadWarnings?.[0]).toContain('1 of 3');
  });

  test('a -Infinity vertex does not poison the origin', async () => {
    const pc = await loadPly(
      asciiPly(['x', 'y', 'z'], ['100 200 300', '-Infinity 200 300', '101 201 301']),
    );
    expect(pc.origin).toEqual([100, 200, 300]);
    expect(pc.pointCount).toBe(2);
  });

  test('a clean PLY carries no load warning', async () => {
    const pc = await loadPly(asciiPly(['x', 'y', 'z'], ['1 2 3', '4 5 6']));
    expect(pc.pointCount).toBe(2);
    expect(pc.metadata?.loadWarnings).toBeUndefined();
  });

  test('a PLY whose every vertex is unplaceable fails', async () => {
    await expect(loadPly(asciiPly(['x', 'y', 'z'], ['nan 1 1', '1 nan 1']))).rejects.toThrow(
      LoadError,
    );
  });
});

describe('loadPcd — non-finite points share the one policy', () => {
  test('an unplaceable row is dropped and reported', async () => {
    const pc = await loadPcd(asciiPcd(['1 2 3', 'nan 3 4', '4 5 6']));
    expect(pc.pointCount).toBe(2);
    expect(pc.origin).toEqual([1, 2, 3]);
    expect(pc.metadata?.loadWarnings?.[0]).toContain('1 of 3');
  });

  test('a clean PCD carries no load warning', async () => {
    const pc = await loadPcd(asciiPcd(['1 2 3', '4 5 6']));
    expect(pc.pointCount).toBe(2);
    expect(pc.metadata?.loadWarnings).toBeUndefined();
  });
});

describe('loadLas — a header-scale overflow cannot ship a non-finite point', () => {
  const overflowScale: [number, number, number] = [1e300, 1e300, 1e300];

  test('the overflowing record is excluded and its attributes go with it', async () => {
    // scale 1e300 is finite, so the header guard accepts it, but a large X
    // coordinate then multiplies out past the float64 range to ±Infinity.
    const buffer = makeLas(
      [
        { x: 0, y: 0, z: 0, intensity: 111, classification: 2 },
        { x: 2_000_000_000, y: 0, z: 0, intensity: 222, classification: 5 },
        { x: 0, y: 0, z: 0, intensity: 333, classification: 9 },
      ],
      overflowScale,
    );
    const pc = await loadLas(buffer, 'las', 'overflow.las');
    expect(pc.pointCount).toBe(2);
    expect(Array.from(pc.intensity!)).toEqual([111, 333]);
    expect(Array.from(pc.classification!)).toEqual([2, 9]);
    expect(pc.metadata?.loadWarnings?.[0]).toContain('1 of 3');
  });

  test('a clean LAS carries no load warning', async () => {
    const buffer = makeLas([
      { x: 100, y: 200, z: 300, intensity: 1, classification: 2 },
      { x: 400, y: 500, z: 600, intensity: 3, classification: 4 },
    ]);
    const pc = await loadLas(buffer, 'las', 'clean.las');
    expect(pc.pointCount).toBe(2);
    expect(pc.metadata?.loadWarnings).toBeUndefined();
  });
});
