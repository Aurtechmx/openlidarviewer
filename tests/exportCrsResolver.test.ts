/**
 * exportCrsResolver.test.ts — the resolved-CRS rule the ortho georeference reads
 * (release blocker #2 / pass-5 C10).
 *
 * The seam decides, per static cloud, what CRS the `.prj` may claim. The active
 * scan uses the CRS authority's resolved override; other clouds resolve their own
 * declared CRS; and a local / unknown resolution georeferences nothing. These pin
 * that a rejected override can never resurrect the file's declared CRS.
 */
import { describe, it, expect } from 'vitest';
import { makeExportCrsResolver } from '../src/app/exportCrsResolver';
import type { PointCloud } from '../src/model/PointCloud';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const cloud = (name: string): PointCloud => ({ name }) as unknown as PointCloud;

const projected = (epsg: number, wkt: string): ResolvedCrs => ({
  kind: 'projected', name: `EPSG:${epsg}`, epsg, wkt,
  linearUnit: 'metre', linearUnitToMetres: 1, source: 'wkt', confidence: 'high', userConfirmed: true,
} as unknown as ResolvedCrs);

const local = (): ResolvedCrs => ({
  kind: 'local', name: 'Local coordinates (no CRS)',
  linearUnit: 'unknown', linearUnitToMetres: 1, source: 'none', confidence: 'low', userConfirmed: true,
} as unknown as ResolvedCrs);

describe('makeExportCrsResolver (C10)', () => {
  const active = cloud('active');
  const other = cloud('other');

  it('uses the active scan resolved override, not its declared CRS', () => {
    const resolve = makeExportCrsResolver({
      current: () => projected(32612, 'RESOLVED-12N'),
      resolveForCloud: () => projected(9999, 'SHOULD-NOT-BE-USED'),
      activeCloud: () => active,
    });
    expect(resolve(active)).toEqual({ wkt: 'RESOLVED-12N', key: 'epsg:32612' });
  });

  it('resolves a non-active cloud via its own declared CRS', () => {
    const resolve = makeExportCrsResolver({
      current: () => projected(32612, 'ACTIVE-WKT'),
      resolveForCloud: () => projected(32611, 'OTHER-11N'),
      activeCloud: () => active,
    });
    expect(resolve(other)).toEqual({ wkt: 'OTHER-11N', key: 'epsg:32611' });
  });

  it('a local override georeferences nothing — null wkt AND null key (C10)', () => {
    const resolve = makeExportCrsResolver({
      current: () => local(),
      resolveForCloud: () => local(),
      activeCloud: () => active,
    });
    expect(resolve(active)).toEqual({ wkt: null, key: null });
  });

  it('a null resolved CRS (no scan) georeferences nothing', () => {
    const resolve = makeExportCrsResolver({
      current: () => null,
      resolveForCloud: () => local(),
      activeCloud: () => null,
    });
    expect(resolve(active)).toEqual({ wkt: null, key: null });
  });
});
