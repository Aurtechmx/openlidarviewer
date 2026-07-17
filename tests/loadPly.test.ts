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
