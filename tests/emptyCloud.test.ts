import { PointCloud } from '../src/model/PointCloud';
import { parseBuffer } from '../src/io/parseBuffer';
import { LoadError, classifyLoadError } from '../src/io/loadErrors';

/**
 * A well-formed LAS 1.2 public header that declares zero point records. This
 * is the gap the parse guard closes: a binary loader produces a valid but
 * empty cloud rather than throwing, so the empty file would otherwise reach
 * the renderer and frame a degenerate (NaN) camera — a black canvas.
 */
function emptyLasBuffer(): ArrayBuffer {
  const HEADER_SIZE = 227;
  const buf = new ArrayBuffer(HEADER_SIZE);
  const view = new DataView(buf);
  // Signature 'LASF'.
  for (let i = 0; i < 4; i++) view.setUint8(i, 'LASF'.charCodeAt(i));
  view.setUint8(25, 2); // version minor → 1.2 (uint32 legacy point count).
  view.setUint32(96, HEADER_SIZE, true); // offset to point data.
  view.setUint8(104, 0); // point format 0.
  view.setUint16(105, 20, true); // point record length (format 0 = 20 bytes).
  view.setUint32(107, 0, true); // legacy point count = 0.
  // Scale = 1 on each axis; offset and bounds left at 0.
  view.setFloat64(131, 1, true);
  view.setFloat64(139, 1, true);
  view.setFloat64(147, 1, true);
  view.setUint16(94, HEADER_SIZE, true); // header size.
  view.setUint32(100, 0, true); // number of VLRs.
  return buf;
}

describe('empty point cloud — bounds() never goes non-finite', () => {
  test('bounds() of a 0-point cloud is a finite degenerate box at the origin', () => {
    const pc = new PointCloud({
      positions: new Float32Array(0),
      origin: [0, 0, 0],
      sourceFormat: 'ply',
      name: 'empty',
    });
    expect(pc.pointCount).toBe(0);
    const { min, max } = pc.bounds();
    for (const v of [...min, ...max]) {
      expect(Number.isFinite(v)).toBe(true);
    }
    expect(min).toEqual([0, 0, 0]);
    expect(max).toEqual([0, 0, 0]);
  });
});

describe('empty point cloud — rejected at the parse choke point', () => {
  test('parseBuffer throws a typed LoadError for a 0-point LAS file', async () => {
    await expect(parseBuffer(emptyLasBuffer(), 'las', 'empty.las')).rejects.toThrow(
      LoadError,
    );
  });

  test('the rejection is categorised malformed-file (so the toast explains it across the worker boundary)', async () => {
    try {
      await parseBuffer(emptyLasBuffer(), 'las', 'empty.las');
      throw new Error('expected parseBuffer to reject the empty cloud');
    } catch (err) {
      expect(err).toBeInstanceOf(LoadError);
      expect((err as LoadError).category).toBe('malformed-file');
      // Workers post only the message string; the main thread re-derives the
      // category from it. Confirm the message still classifies correctly.
      expect(classifyLoadError((err as LoadError).message)).toBe('malformed-file');
    }
  });
});
