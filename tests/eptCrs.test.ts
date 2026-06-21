/**
 * eptCrs.test.ts — resolving an EPT source's CRS from its `srs` (WKT and/or
 * authority codes). Pins that a streamed dataset surfaces its horizontal CRS
 * AND vertical datum whether they arrive as WKT, as codes, or as both.
 */

import { test, expect } from 'vitest';
import { resolveEptCrs } from '../src/render/streaming/eptCrs';

const UTM12N_WKT = 'PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984"],UNIT["metre",1]],AUTHORITY["EPSG","32612"]]';

test('resolveEptCrs — WKT alone resolves the horizontal CRS', () => {
  const c = resolveEptCrs({ srs: UTM12N_WKT });
  expect(c).not.toBeNull();
  expect(c!.epsg).toBe(32612);
  expect(c!.source).toBe('wkt');
});

test('resolveEptCrs — authority codes (no WKT) georeference horizontal + vertical', () => {
  const c = resolveEptCrs({ srsCodes: { authority: 'EPSG', horizontalEpsg: 32612, verticalEpsg: 5703 } });
  expect(c).not.toBeNull();
  expect(c!.epsg).toBe(32612);
  expect(c!.isGeographic).toBe(false);
  expect(c!.verticalEpsg).toBe(5703);
  expect(c!.verticalDatum).toBe('NAVD88');
  expect(c!.source).toBe('epsg');
});

test('resolveEptCrs — a geographic horizontal code is reported as geographic', () => {
  const c = resolveEptCrs({ srsCodes: { authority: 'EPSG', horizontalEpsg: 4326 } });
  expect(c!.isGeographic).toBe(true);
});

test('resolveEptCrs — a horizontal-only WKT gains the vertical datum from the codes', () => {
  const c = resolveEptCrs({ srs: UTM12N_WKT, srsCodes: { verticalEpsg: 5703 } });
  expect(c!.epsg).toBe(32612); // WKT richness preserved
  expect(c!.source).toBe('wkt');
  expect(c!.verticalDatum).toBe('NAVD88'); // datum attached from the codes
});

test('resolveEptCrs — returns null when the manifest carries no SRS at all', () => {
  expect(resolveEptCrs({})).toBeNull();
  expect(resolveEptCrs({ srs: '   ' })).toBeNull();
});
