import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadPtx } from '../src/io/loadPtx';

/** Read a fixture as a tightly-sliced ArrayBuffer. */
function loadFixture(name: string): ArrayBuffer {
  const file = readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

/** Encode a PTX text body as an ArrayBuffer. */
function ptx(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer;
}

describe('loadPtx — single block', () => {
  test('decodes the fixture, skipping the empty 0 0 0 grid cell', async () => {
    const pc = await loadPtx(loadFixture('tiny.ptx'), 'tiny.ptx');
    expect(pc.pointCount).toBe(3); // 4 grid cells, one is an empty 0 0 0 sample
    expect(pc.sourceFormat).toBe('ptx');
  });

  test('applies the 4×4 transform to world coordinates', async () => {
    const pc = await loadPtx(loadFixture('tiny.ptx'));
    // Local (1,2,3) under a translate-(10,20,30) transform → world (11,22,33),
    // the floored-min origin, so it recentres to the local origin.
    expect(pc.origin).toEqual([11, 22, 33]);
    expect(pc.positions[0]).toBeCloseTo(0, 4);
    expect(pc.positions[1]).toBeCloseTo(0, 4);
    expect(pc.positions[2]).toBeCloseTo(0, 4);
    // Local (7,8,9) → world (17,28,39) → local (6,6,6).
    expect(pc.positions[6]).toBeCloseTo(6, 4);
    expect(pc.positions[7]).toBeCloseTo(6, 4);
    expect(pc.positions[8]).toBeCloseTo(6, 4);
  });

  test('preserves the scanner origin from the transform', async () => {
    const pc = await loadPtx(loadFixture('tiny.ptx'));
    expect(pc.metadata?.scannerOrigin).toEqual([10, 20, 30]);
  });

  test('rescales a 0–1 intensity column to the full Uint16 range', async () => {
    const pc = await loadPtx(loadFixture('tiny.ptx'));
    expect(pc.intensity).toBeInstanceOf(Uint16Array);
    expect(pc.intensity![0]).toBe(Math.round(0.5 * 65535));
    expect(pc.intensity![2]).toBe(65535);
    expect(pc.colors).toBeUndefined(); // the fixture has no RGB columns
  });
});

describe('loadPtx — multi-block', () => {
  test('registers every block into one world via its own transform', async () => {
    // Two 1×1 blocks; the second is translated +100 in X.
    const text =
      '1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n5 0 0 0.5\n' +
      '1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n100 0 0 1\n5 0 0 0.5\n';
    const pc = await loadPtx(ptx(text));
    expect(pc.pointCount).toBe(2);
    // Block 1 point at world x=5, block 2 point at world x=105 → span 100.
    const xs = [pc.positions[0] + pc.origin[0], pc.positions[3] + pc.origin[0]];
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(100, 3);
  });
});

describe('loadPtx — colour and malformed input', () => {
  test('a 7-column block carries RGB', async () => {
    const text =
      '1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n' +
      '2 3 4 0.5 200 100 50\n';
    const pc = await loadPtx(ptx(text));
    expect(pc.pointCount).toBe(1);
    expect(pc.colors).toBeInstanceOf(Uint8Array);
    expect(Array.from(pc.colors!)).toEqual([200, 100, 50]);
  });

  test('a file with no readable points throws a clear error', async () => {
    await expect(loadPtx(ptx('not a ptx file'))).rejects.toThrow();
  });
});

/** A one-block PTX with the given point lines, joined by `eol`. */
function ptxBlock(points: string[], eol: string): ArrayBuffer {
  const lines = [
    String(points.length), '1',        // cols, rows
    '0 0 0', '1 0 0', '0 1 0', '0 0 1', // scanner pose
    '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1', // identity transform
    ...points,
  ];
  return new TextEncoder().encode(lines.join(eol) + eol).buffer as ArrayBuffer;
}

describe('loadPtx — line indexing', () => {
  test('reads a CRLF file identically to an LF one', async () => {
    const pts = ['1 2 3 0.5', '4 5 6 0.25'];
    const lf = await loadPtx(ptxBlock(pts, '\n'));
    const crlf = await loadPtx(ptxBlock(pts, '\r\n'));
    // A stray CR would poison Number() and drop the points entirely.
    expect(crlf.pointCount).toBe(2);
    expect(crlf.pointCount).toBe(lf.pointCount);
    expect(Array.from(crlf.positions)).toEqual(Array.from(lf.positions));
    expect(crlf.origin).toEqual(lf.origin);
  });

  test('a file with no trailing newline reads its last point', async () => {
    const lines = [
      '1', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1',
      '7 8 9 0.5',
    ];
    const buf = new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
    const pc = await loadPtx(buf);
    expect(pc.pointCount).toBe(1);
  });
});

/** A one-block PTX with an explicit 4×4 matrix (four rows of four tokens). */
function ptxWithMatrix(matrixRows: string[], points: string[]): ArrayBuffer {
  const lines = [
    String(points.length), '1',        // cols, rows
    '0 0 0', '1 0 0', '0 1 0', '0 0 1', // scanner pose
    ...matrixRows,                      // the 4×4 registration transform
    ...points,
  ];
  return new TextEncoder().encode(lines.join('\n') + '\n').buffer as ArrayBuffer;
}

describe('loadPtx — registration honesty', () => {
  const identity = ['1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1'];

  test('a corrupt registration matrix warns that the block fell back to identity', async () => {
    // Row 4 (the translation) carries a non-numeric token, so parseRow4 seeds a
    // NaN and matrixIsFinite rejects the transform. The intended +100 X offset
    // is lost — the point renders in scanner-local space — and the ONLY signal
    // that a registration was dropped is the warning this asserts.
    const pc = await loadPtx(
      ptxWithMatrix(['1 0 0 0', '0 1 0 0', '0 0 1 0', '100 0 x 1'], ['1 2 3 0.5']),
    );
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => /registration|transform/i.test(w))).toBe(true);
    expect(warnings.some((w) => /block/i.test(w))).toBe(true);
  });

  test('a legitimately identity single-block PTX does not warn', async () => {
    // A single-scan PTX correctly registers with the identity matrix; that is
    // normal, not a corrupt transform. This is the critical regression guard.
    const pc = await loadPtx(ptxWithMatrix(identity, ['1 2 3 0.5']));
    expect(pc.metadata?.loadWarnings ?? []).toEqual([]);
  });

  test('in a multi-block PTX only the block with the bad matrix is named', async () => {
    // Block 1 registers cleanly; block 2's matrix is corrupt. The warning must
    // point at block 2, not block 1, so the displacement is attributable.
    const text =
      '1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n0 0 0 1\n5 0 0 0.5\n' +
      '1\n1\n0 0 0\n1 0 0\n0 1 0\n0 0 1\n1 0 0 0\n0 1 0 0\n0 0 1 0\n1 nan 0 1\n5 0 0 0.5\n';
    const pc = await loadPtx(new TextEncoder().encode(text).buffer as ArrayBuffer);
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => /\b2\b/.test(w) && /registration|transform/i.test(w))).toBe(true);
    expect(warnings.some((w) => /block\s*1\b/i.test(w))).toBe(false);
  });
});

describe('loadPtx — truncation honesty', () => {
  test('a block that runs out of lines before its declared cells warns', async () => {
    // Declares a 5×1 grid but only two point lines follow: the inner loop hits
    // end-of-input with the declared cells unconsumed. No trailing newline, so
    // nothing pads the count up.
    const lines = [
      '5', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1',
      '1 2 3 0.5', '4 5 6 0.5',
    ];
    const buf = new TextEncoder().encode(lines.join('\n')).buffer as ArrayBuffer;
    const pc = await loadPtx(buf);
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => /truncat|ran out|ended/i.test(w))).toBe(true);
  });

  test('a complete block does not warn about truncation', async () => {
    // 2×1 grid with both points present — skipping empty/short cells never
    // leaves the count short, so a whole file must stay silent.
    const lines = [
      '2', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1',
      '1 2 3 0.5', '4 5 6 0.5',
    ];
    const buf = new TextEncoder().encode(lines.join('\n') + '\n').buffer as ArrayBuffer;
    const pc = await loadPtx(buf);
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => /truncat|ran out|ended/i.test(w))).toBe(false);
  });

  test('a block whose grid is padded with empty 0 0 0 cells is not truncated', async () => {
    // Declares 3 cells; two are real returns and one is an empty 0 0 0 cell.
    // The empty cell is skipped as a non-return but still consumes a line, so
    // the block is complete — no truncation warning.
    const lines = [
      '3', '1', '0 0 0', '1 0 0', '0 1 0', '0 0 1',
      '1 0 0 0', '0 1 0 0', '0 0 1 0', '0 0 0 1',
      '1 2 3 0.5', '0 0 0 0', '4 5 6 0.5',
    ];
    const buf = new TextEncoder().encode(lines.join('\n') + '\n').buffer as ArrayBuffer;
    const pc = await loadPtx(buf);
    expect(pc.pointCount).toBe(2); // the 0 0 0 non-return is not a point
    const warnings = pc.metadata?.loadWarnings ?? [];
    expect(warnings.some((w) => /truncat|ran out|ended/i.test(w))).toBe(false);
  });
});
