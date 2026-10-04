/**
 * exportDisplaySample.test.ts
 *
 * A reduced scan exported without the full-resolution re-decode writes its
 * display sample. The written file must say so in its provenance and its name;
 * a full-resolution export stays exactly as it was.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { displaySampleOf, displaySampleLine, displaySampleStatus } from '../src/export/exportSummary';
import type { ExportDigests } from '../src/science/exportDigestRecord';

const DIGESTS: ExportDigests = {
  sourceSha256: 'a'.repeat(64),
  sourceSha256Note: null,
  crsOrigin: { source: 'unknown', name: 'unknown', epsg: 'unknown', verticalDatum: 'unknown', verticalSource: 'unknown' },
} as unknown as ExportDigests;

function sampleCloud(): PointCloud {
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin: [500000, 4000000, 100],
    sourceFormat: 'las',
    name: 'USGS_LPC_tile.laz',
    declaredPointCount: 15_604_926,
  });
}

const latin1 = (b: Uint8Array): string => Buffer.from(b).toString('latin1');

describe('displaySampleOf', () => {
  it('reads the declared source count when it exceeds the held count', () => {
    expect(displaySampleOf({ pointCount: 2_397_417, declaredPointCount: 15_604_926 }))
      .toEqual({ held: 2_397_417, source: 15_604_926 });
  });
  it('prefers a streamed snapshot\'s source count', () => {
    expect(displaySampleOf({ pointCount: 10, declaredPointCount: 10, sourceDeclaredPointCount: 400 }))
      .toEqual({ held: 10, source: 400 });
  });
  it('leaves the source unknown when nothing larger was declared', () => {
    expect(displaySampleOf({ pointCount: 10 }).source).toBeNull();
    expect(displaySampleLine({ held: 10, source: null })).toBe('Display sample: 10 points, fewer than the source holds');
  });
});

describe('convertCloud — display-sample export', () => {
  for (const format of ['las', 'las14'] as const) {
    it(`${format}: the provenance VLR states the sample and the filename carries -sample`, () => {
      const { file } = convertCloud(sampleCloud(), {
        format, digests: DIGESTS, displaySample: { held: 2_397_417, source: 15_604_926 },
      });
      expect(file).not.toBeNull();
      expect(file!.filename).toBe('USGS_LPC_tile-sample.las');
      const text = latin1(file!.bytes);
      expect(text).toContain('OpenLiDARViewer provenance');
      expect(text).toContain('Display sample: 2,397,417 of 15,604,926 source points');
    });

    it(`${format}: a full-resolution export has no sample line and keeps the base name`, () => {
      const { file } = convertCloud(sampleCloud(), { format, digests: DIGESTS });
      expect(file!.filename).toBe('USGS_LPC_tile.las');
      expect(latin1(file!.bytes)).not.toContain('Display sample');
    });
  }

  it('xyz: the sample line rides the comment header too', () => {
    const { file } = convertCloud(sampleCloud(), {
      format: 'xyz', digests: DIGESTS, displaySample: { held: 3, source: 9 },
    });
    expect(file!.filename).toBe('USGS_LPC_tile-sample.xyz');
    expect(new TextDecoder().decode(file!.bytes)).toContain('Display sample: 3 of 9 source points');
  });
});

describe('displaySampleStatus', () => {
  it('names the sample and the full-resolution option', () => {
    expect(displaySampleStatus({ held: 2_397_417, source: 15_604_926 }))
      .toBe(' · display sample of 15,604,926 source points; tick Convert at full resolution to export every point');
  });
});
