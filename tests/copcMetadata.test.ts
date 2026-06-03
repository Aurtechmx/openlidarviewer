import { detectCopc } from '../src/io/copc/copcDetect';
import { parseCopcMetadata } from '../src/io/copc/copcHeader';
import { LoadError } from '../src/io/loadErrors';
import { buildSyntheticCopc } from './fixtures/copc/synthCopc';

// --- detection ---------------------------------------------------------------

test('detectCopc accepts a synthetic COPC file', () => {
  const { buffer } = buildSyntheticCopc();
  expect(detectCopc(buffer)).toEqual({ isCopc: true });
});

test('detectCopc rejects a file without a COPC info VLR (plain LAZ)', () => {
  const { buffer } = buildSyntheticCopc({ corrupt: 'no-copc-vlr' });
  const d = detectCopc(buffer);
  expect(d.isCopc).toBe(false);
  expect(d.reason).toMatch(/plain LAZ/);
});

test('detectCopc rejects a non-LAS file and a too-short file', () => {
  expect(detectCopc(buildSyntheticCopc({ corrupt: 'bad-magic' }).buffer).isCopc).toBe(false);
  expect(detectCopc(buildSyntheticCopc({ corrupt: 'truncated-file' }).buffer).isCopc).toBe(false);
  expect(detectCopc(new ArrayBuffer(16)).isCopc).toBe(false);
});

// --- metadata parsing --------------------------------------------------------

test('parseCopcMetadata reads the LAS 1.4 header facts', () => {
  const fixture = buildSyntheticCopc({
    pointFormat: 7,
    scale: [0.001, 0.001, 0.001],
    offset: [100, 200, 0],
    center: [640, 480, 60],
    halfsize: 700,
    nodes: [{ key: [0, 0, 0, 0], pointCount: 1234 }],
  });
  const { header } = parseCopcMetadata(fixture.buffer);
  expect(header.pointDataRecordFormat).toBe(7);
  expect(header.pointRecordLength).toBe(36);
  expect(header.pointCount).toBe(1234);
  expect(header.scale).toEqual([0.001, 0.001, 0.001]);
  expect(header.offset).toEqual([100, 200, 0]);
  expect(header.hasRgb).toBe(true);
  expect(header.hasGpsTime).toBe(true);
  // bounds: center ± halfsize
  expect(header.min).toEqual([640 - 700, 480 - 700, 60 - 700]);
  expect(header.max).toEqual([640 + 700, 480 + 700, 60 + 700]);
});

test('parseCopcMetadata reads the COPC info VLR', () => {
  const fixture = buildSyntheticCopc({
    center: [320, 320, 25],
    halfsize: 256,
    spacing: 8,
    nodes: [
      { key: [0, 0, 0, 0], pointCount: 500 },
      { key: [1, 0, 0, 0], pointCount: 300 },
    ],
  });
  const { info } = parseCopcMetadata(fixture.buffer);
  expect(info.center).toEqual([320, 320, 25]);
  expect(info.halfsize).toBe(256);
  expect(info.spacing).toBe(8);
  expect(info.rootHierOffset).toBe(fixture.rootHierOffset);
  expect(info.rootHierSize).toBe(fixture.rootHierSize);
});

test('parseCopcMetadata rejects a too-short slice and a non-COPC point format', () => {
  expect(() => parseCopcMetadata(new ArrayBuffer(100))).toThrow(LoadError);
  // PDRF 3 is a valid LAS format but not allowed for COPC.
  expect(() => parseCopcMetadata(buildSyntheticCopc({ pointFormat: 3 }).buffer)).toThrow(
    /point data record format 6, 7, or 8/,
  );
});
