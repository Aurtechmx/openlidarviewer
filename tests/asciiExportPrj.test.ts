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

  describe('keep mode with a resolver', () => {
    const WKT_B = wktForEpsg(32613) as string;
    const resolved = (extra: Record<string, unknown>): CrsInfo =>
      ({ kind: 'projected', name: 'resolved', ...extra }) as unknown as CrsInfo;

    it('keep mode writes no .prj when the resolver says no CRS, even if the file declares one', () => {
      const { file } = convertCloud(cloud(), { format: 'xyz', crsMode: 'keep', resolvedSourceCrs: null });
      expect(file).not.toBeNull();
      expect(file?.prj).toBeUndefined();
    });

    it('keep mode writes the override WKT, not the declared one', () => {
      const { file } = convertCloud(cloud(), {
        format: 'xyz', crsMode: 'keep', resolvedSourceCrs: resolved({ epsg: 32613, wkt: WKT_B }),
      });
      expect(file?.prj).toBe(WKT_B);
      expect(file?.prj).not.toBe(SOURCE_WKT);
    });

    it('keep mode writes no .prj when the resolved CRS has no WKT', () => {
      const { file } = convertCloud(cloud(), {
        format: 'xyz', crsMode: 'keep', resolvedSourceCrs: resolved({ epsg: 32613 }),
      });
      expect(file?.prj).toBeUndefined();
    });
  });

  it('LAS output has no .prj', () => {
    const { file } = convertCloud(cloud(), { format: 'las', crsMode: 'assign', targetEpsg: 32613 });
    expect(file?.prj).toBeUndefined();
  });
});
