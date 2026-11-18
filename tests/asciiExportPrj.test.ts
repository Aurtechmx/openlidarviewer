/**
 * XYZ / ASC export: a `.prj` beside a reprojected or assigned file.
 */

import { describe, it, expect } from 'vitest';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import { wktForEpsg } from '../src/io/epsgWkt';
import type { CrsInfo } from '../src/io/crs';

const SOURCE_WKT = 'PROJCS["WGS 84 / UTM zone 12N",AUTHORITY["EPSG","32612"]]';

function cloud(): PointCloud {
  const crs: CrsInfo = { kind: 'projected', name: 'WGS 84 / UTM zone 12N', epsg: 32612, wkt: SOURCE_WKT } as unknown as CrsInfo;
  return new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1, 30, 40, 2]),
    origin: [400000, 4000000, 100],
    sourceFormat: 'las',
    name: 'survey.las',
    metadata: { crs },
  });
}

const text = (b: Uint8Array): string => new TextDecoder().decode(b);

describe('ASCII export .prj sidecar', () => {
  for (const format of ['xyz', 'asc'] as const) {
    it(`${format}: reproject writes the target definition`, () => {
      const { file } = convertCloud(cloud(), { format, crsMode: 'reproject', targetEpsg: 26912 });
      expect(file?.prj).toBe(wktForEpsg(26912));
      expect(file?.prj).toBeTruthy();
    });

    it(`${format}: assign writes the target definition`, () => {
      const { file } = convertCloud(cloud(), { format, crsMode: 'assign', targetEpsg: 32613 });
      expect(file?.prj).toBe(wktForEpsg(32613));
      expect(file?.prj).toBeTruthy();
    });

    it(`${format}: keep carries the resolved source WKT`, () => {
      const { file } = convertCloud(cloud(), { format, crsMode: 'keep' });
      expect(file?.prj).toBe(SOURCE_WKT);
    });
  }

  it('assign to a code with no definition writes no .prj and says so', () => {
    const { file, report } = convertCloud(cloud(), { format: 'xyz', crsMode: 'assign', targetEpsg: 2229 });
    expect(file).not.toBeNull();
    expect(file?.prj).toBeUndefined();
    expect(report.log.map((l) => l.message)).toContain(
      'EPSG:2229 recorded in the file header only; no .prj written (no definition available).',
    );
    expect(text(file!.bytes)).toContain('EPSG:2229');
  });

  it('LAS output has no .prj', () => {
    const { file } = convertCloud(cloud(), { format: 'las', crsMode: 'assign', targetEpsg: 32613 });
    expect(file?.prj).toBeUndefined();
  });
});
