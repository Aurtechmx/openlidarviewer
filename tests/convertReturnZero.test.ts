/**
 * LAS return numbers start at 1. A source that stores 0 in the return number
 * or the number of returns (a phone COPC export does, on every point) is
 * written as 1, because the writer clamps to the valid range. That changes a
 * stored value, so the conversion must say so in its log and in the file's
 * own record instead of changing it silently.
 */
import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';

function cloud(returnNumber: number[], returnCount: number[]): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 1, 1, 1, 2, 2, 2]),
    returnNumber: Uint8Array.from(returnNumber),
    returnCount: Uint8Array.from(returnCount),
    origin: [500000, 4100000, 0],
    sourceFormat: 'las',
    name: 'scan.las',
  });
}

const text = (bytes: Uint8Array): string => new TextDecoder('latin1').decode(bytes);

describe('return number 0 on export', () => {
  for (const format of ['las14', 'las'] as const) {
    it(`${format}: reports the points written as return 1 of 1`, () => {
      const { file, report } = convertCloud(cloud([0, 0, 1], [0, 1, 1]), { format });
      expect(report.ok).toBe(true);
      const line = report.log.find((l) => /return number or number of returns 0/.test(l.message));
      expect(line?.message).toMatch(/^2 points /);
      expect(text(file!.bytes as Uint8Array)).toContain('Conversion event return-zero-raised');
    });
  }

  it('says nothing when every return field is already valid', () => {
    const { report } = convertCloud(cloud([1, 1, 2], [1, 2, 2]), { format: 'las14' });
    expect(report.log.some((l) => /returns 0/.test(l.message))).toBe(false);
  });
});
