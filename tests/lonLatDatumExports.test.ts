/**
 * The longitude/latitude exports state the datum they actually used.
 *
 * A NAD83 source is placed without a NAD83 to WGS 84 transformation, so the
 * KML description and the GeoJSON metadata must say the positions are
 * approximate rather than calling them WGS 84. A NAD27 source is refused, and
 * the export UI shows the refusal.
 */

import { describe, it, expect } from 'vitest';
import { makeLocalToLonLat } from '../src/export/lonLatMapper';
import { buildFootprintKml, buildKml, type KmlExportInput } from '../src/export/kmlExport';
import { serializeContours } from '../src/terrain/contour/contourDownload';
import type { ContourFeatureModel } from '../src/terrain/contour/contourFeatureModel';
import { footprintsToGeoJson } from '../src/features/footprintGeoJson';
import { resolveExportDigests } from '../src/export/exportDigests';
import {
  siteKmlStatus,
  scanFootprintStatus,
  exportSiteKml,
  type KmlActionDeps,
} from '../src/app/kmlActions';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Measurement } from '../src/render/measure/types';
import { PointCloud } from '../src/model/PointCloud';
import { convertCloud } from '../src/convert/convertCloud';
import type { CrsInfo } from '../src/io/crs';

const crs = (epsg: number, name: string): ResolvedCrs => ({
  kind: 'projected',
  name,
  epsg,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: true,
});
const NAD83_12 = crs(26912, 'NAD83 / UTM zone 12N');
const WGS84_12 = crs(32612, 'WGS 84 / UTM zone 12N');
const NAD27_12 = crs(26712, 'NAD27 / UTM zone 12N');
const ORIGIN: [number, number, number] = [500_000, 4_428_236, 0];
const UNQUALIFIED_FRAME = /^WGS 84 longitude\/latitude \(RFC 7946\)/;

function contourModel(epsg: number): ContourFeatureModel {
  return {
    features: [
      {
        value: 1500,
        isIndex: true,
        grade: 'solid',
        meanConfidence: 90,
        closed: false,
        coordinates: [
          [500_000, 4_428_236],
          [500_050, 4_428_286],
        ],
      },
    ],
    crs: `EPSG:${epsg}`,
    verticalDatum: null,
    intervalM: 1,
    contourStyle: 'smooth',
    bbox: { minX: 500_000, minY: 4_428_236, maxX: 500_050, maxY: 4_428_286 },
    interpolatedFraction: 0,
    coverageMode: 'full',
    warnings: [],
  } as unknown as ContourFeatureModel;
}

/** The world-frame mapper the contour export receives (origin already restored). */
function worldMapper(resolved: ResolvedCrs) {
  return makeLocalToLonLat(resolved, [0, 0, 0]) ?? makeLocalToLonLat(resolved, ORIGIN);
}

describe('RFC 7946 contour GeoJSON', () => {
  it('NAD83 source: coordinateFrame is not the unqualified WGS 84 sentence, and the caveat ships', () => {
    const toLonLat = makeLocalToLonLat(NAD83_12, ORIGIN)!;
    const world = Object.assign(
      (p: readonly [number, number, number]) => toLonLat([p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2]]),
      { datumCaveat: toLonLat.datumCaveat },
    );
    const gj = JSON.parse(
      serializeContours(contourModel(26912), 'geojson', { toLonLat: world, worldOrigin: { x: 0, y: 0, z: 0 } }).content,
    );
    expect(gj.metadata.coordinateFrame).not.toMatch(UNQUALIFIED_FRAME);
    expect(gj.metadata.coordinateFrame).toMatch(/WITHOUT a datum transformation/);
    expect(gj.metadata.coordinateFrame).toMatch(/approximate/);
    expect(gj.metadata.datumCaveat).toMatch(/NAD83/);
  });

  it('WGS 84 source: the frame sentence is unchanged and no caveat is added', () => {
    const toLonLat = makeLocalToLonLat(WGS84_12, ORIGIN)!;
    const world = (p: readonly [number, number, number]) =>
      toLonLat([p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2]]);
    const gj = JSON.parse(
      serializeContours(contourModel(32612), 'geojson', { toLonLat: world, worldOrigin: { x: 0, y: 0, z: 0 } }).content,
    );
    expect(gj.metadata.coordinateFrame).toMatch(UNQUALIFIED_FRAME);
    expect(gj.metadata.datumCaveat).toBeUndefined();
  });

  it('NAD27 source has no mapper, so the RFC 7946 file is refused', () => {
    expect(worldMapper(NAD27_12)).toBeNull();
    expect(() =>
      serializeContours(contourModel(26712), 'geojson', { worldOrigin: { x: 0, y: 0, z: 0 } }),
    ).toThrow(/WGS 84/);
  });
});

describe('building-footprint GeoJSON', () => {
  const ring = [{ x: -111, y: 40 }, { x: -110.999, y: 40 }, { x: -110.999, y: 40.001 }];
  it('states the approximation for a NAD83 source', () => {
    const caveat = makeLocalToLonLat(NAD83_12, ORIGIN)!.datumCaveat!;
    const gj = footprintsToGeoJson(
      [{ ring, areaSource: 1, areaM2: null, centroidX: -111, centroidY: 40 }],
      { datumCaveat: caveat },
    );
    expect(gj.metadata.note).not.toMatch(/WGS 84 longitude\/latitude per RFC 7946/);
    expect(gj.metadata.datumCaveat).toMatch(/NAD83/);
  });
  it('keeps the WGS 84 note for a WGS 84 source', () => {
    const gj = footprintsToGeoJson([{ ring, areaSource: 1, areaM2: null, centroidX: -111, centroidY: 40 }]);
    expect(gj.metadata.note).toMatch(/WGS 84 longitude\/latitude per RFC 7946/);
    expect(gj.metadata.datumCaveat).toBeUndefined();
  });
});

describe('KML text', () => {
  const measurement = {
    id: 'm1',
    kind: 'polyline',
    name: 'Path',
    points: [[0, 0, 0], [10, 10, 0]],
  } as unknown as Measurement;
  const kmlInput = (resolved: ResolvedCrs): KmlExportInput => ({
    annotations: [],
    measurements: [measurement],
    viewpoints: [],
    crsName: resolved.name,
    unitLabel: 'm',
    up: [0, 0, 1],
    unitToMetres: 1,
    toLonLat: makeLocalToLonLat(resolved, ORIGIN)!,
    notSurveyGradeNote: 'Estimates only.',
  });

  it('site KML for a NAD83 source carries the caveat in the document description', () => {
    const kml = buildKml(kmlInput(NAD83_12));
    expect(kml).toMatch(/Approximate positions \(about 1 to 2 m\)/);
    expect(kml).toMatch(/NAD83/);
  });

  it('site KML for a WGS 84 source carries no datum caveat', () => {
    expect(buildKml(kmlInput(WGS84_12))).not.toMatch(/Approximate positions/);
  });

  it('scan-area KML for a NAD83 source does not claim a WGS84 reprojection', () => {
    const kml = buildFootprintKml({
      name: 'scan',
      ring: [[-111, 40], [-110.99, 40], [-110.99, 40.01], [-111, 40]],
      crsName: NAD83_12.name,
      extentBasis: 'the file header',
      notSurveyGradeNote: 'Estimates only.',
      datumCaveat: makeLocalToLonLat(NAD83_12, ORIGIN)!.datumCaveat,
    } as unknown as Parameters<typeof buildFootprintKml>[0]);
    expect(kml).not.toMatch(/reprojected to WGS84/);
    expect(kml).toMatch(/Approximate positions/);
  });
});

describe('export UI refusal for NAD27', () => {
  function harness(resolved: ResolvedCrs) {
    const errors: string[] = [];
    const written: string[] = [];
    const deps = {
      hasViewer: () => true,
      geo: () => ({ origin: ORIGIN, crsName: resolved.name, name: 'site.las' }),
      crsCurrent: () => resolved,
      upAxis: () => 'z',
      annotations: () => [],
      measurements: () => [{ id: 'm1', kind: 'distance', points: [[0, 0, 0], [1, 1, 1]] }],
      viewpoints: () => [],
      worldUp: () => [0, 0, 1],
      unitToMetres: () => 1,
      scanExtent: () => ({ extent: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, basis: 'the file header', upAxis: 'z' }),
      scanHullPositions: () => null,
      baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
      downloadText: (f: string) => { written.push(f); },
      setError: (m: string) => { errors.push(m); },
      loadKmlExport: async () => ({
        buildKml: () => '<kml/>',
        buildFootprintKml: () => '<kml/>',
        KmlCoordinateError: class extends Error {},
        resolveExportDigests,
      }),
    } as unknown as KmlActionDeps;
    return { deps, errors, written };
  }

  const MESSAGE =
    'This scan is on NAD27. Longitude and latitude export needs a datum transformation that OLV '
    + 'does not apply yet, and Reproject in OLV applies no NAD27 shift. Reproject the scan to '
    + 'WGS 84 with PROJ, GDAL or PDAL using the NADCON or NTv2 grids, then open the result.';

  it('the site KML button is disabled with the datum message', () => {
    const s = siteKmlStatus(harness(NAD27_12).deps);
    expect(s.ready).toBe(false);
    expect(s.reason).toBe(MESSAGE);
  });

  it('the scan-area KML button is disabled with the datum message', () => {
    const s = scanFootprintStatus(harness(NAD27_12).deps);
    expect(s.ready).toBe(false);
    expect(s.reason).toBe(MESSAGE);
  });

  it('invoking the site export anyway writes nothing and shows the message', async () => {
    const h = harness(NAD27_12);
    await exportSiteKml(h.deps);
    expect(h.written).toEqual([]);
    expect(h.errors).toEqual([`KML export stopped. ${MESSAGE}`]);
  });

  it('a NAD83 scan stays exportable', () => {
    expect(siteKmlStatus(harness(NAD83_12).deps).ready).toBe(true);
  });
});

/**
 * Null-shift datums (ETRS89, GDA94, GDA2020, NZGD2000, RGF93) are exported
 * as if they were WGS 84. Each moves against WGS 84 with the plate, so every
 * file states the approximation instead of calling itself WGS 84.
 */
describe('null-shift projected grids carry the family note in every file', () => {
  const cases: Array<[number, [number, number], RegExp]> = [
    [25832, [500_000, 5_540_000], /ETRS89/],
    [28355, [320_000, 5_900_000], /GDA94/],
    [7855, [320_000, 5_900_000], /GDA2020/],
    [2193, [1_750_000, 5_430_000], /NZGD2000/],
    [2154, [652_000, 6_862_000], /RGF93/],
  ];
  for (const [epsg, [e, n], family] of cases) {
    const resolved = crs(epsg, `EPSG:${epsg}`);
    const origin: [number, number, number] = [e, n, 0];

    it(`EPSG:${epsg}: site KML, scan-area KML, contour and footprint GeoJSON`, () => {
      const map = makeLocalToLonLat(resolved, origin)!;
      expect(map.datumCaveat).toMatch(family);

      const site = buildKml({
        annotations: [],
        measurements: [{ id: 'm', kind: 'polyline', name: 'P', points: [[0, 0, 0], [5, 5, 0]] } as unknown as Measurement],
        viewpoints: [],
        crsName: resolved.name,
        unitLabel: 'm',
        up: [0, 0, 1],
        unitToMetres: 1,
        toLonLat: map,
        notSurveyGradeNote: 'Estimates only.',
      });
      expect(site).toMatch(family);
      expect(site).toMatch(/Approximate positions/);

      const ring = footprintLonLatRingFor(map);
      const area = buildFootprintKml({
        name: 'scan', ring, crsName: resolved.name, extentBasis: 'the file header',
        notSurveyGradeNote: 'Estimates only.', datumCaveat: map.datumCaveat,
      } as unknown as Parameters<typeof buildFootprintKml>[0]);
      expect(area).not.toMatch(/reprojected to WGS84/);
      expect(area).toMatch(family);

      const world = Object.assign(
        (p: readonly [number, number, number]) => map([p[0] - e, p[1] - n, p[2]]),
        { datumCaveat: map.datumCaveat },
      );
      const model = { ...contourModel(epsg), features: [{
        value: 1, isIndex: true, grade: 'solid', meanConfidence: 90, closed: false,
        coordinates: [[e, n], [e + 50, n + 50]],
      }] } as unknown as ContourFeatureModel;
      const gj = JSON.parse(serializeContours(model, 'geojson', { toLonLat: world, worldOrigin: { x: 0, y: 0, z: 0 } }).content);
      expect(gj.metadata.coordinateFrame).not.toMatch(UNQUALIFIED_FRAME);
      expect(gj.metadata.datumCaveat).toMatch(family);

      const fp = footprintsToGeoJson(
        [{ ring: [{ x: 1, y: 1 }, { x: 1.001, y: 1 }, { x: 1.001, y: 1.001 }], areaSource: 1, areaM2: null, centroidX: 1, centroidY: 1 }],
        { datumCaveat: map.datumCaveat },
      );
      expect(fp.metadata.note).not.toMatch(/WGS 84 longitude\/latitude per RFC 7946/);
      expect(fp.metadata.datumCaveat).toMatch(family);
    });
  }
});

function footprintLonLatRingFor(map: (p: readonly [number, number, number]) => [number, number, number]) {
  const pts: Array<[number, number]> = [[0, 0], [10, 0], [10, 10], [0, 0]];
  return pts.map(([x, y]) => {
    const [lon, lat] = map([x, y, 0]);
    return [lon, lat] as const;
  });
}

/**
 * OLV's Reproject has no NAD27 grids, so it must not turn a NAD27 scan into a
 * WGS 84-labelled one that the export then passes as exact.
 */
describe('Reproject refuses a NAD27 datum leg', () => {
  const cloud = (epsg: number) => new PointCloud({
    positions: Float32Array.from([0, 0, 0, 10, 20, 1]),
    origin: [500000, 4428236, 0],
    sourceFormat: 'las',
    name: 'nad27.las',
    metadata: { crs: { source: 'wkt', name: `EPSG:${epsg}`, epsg, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as CrsInfo },
  });

  it('26712 to 32612 is refused, so no file stamped EPSG:32612 exists to export', () => {
    const { file, report } = convertCloud(cloud(26712), { format: 'las', crsMode: 'reproject', targetEpsg: 32612 });
    expect(report.ok).toBe(false);
    expect(file).toBeFalsy();
    expect(JSON.stringify(report)).toMatch(/NAD27/);
    expect(JSON.stringify(report)).toMatch(/PROJ, GDAL or PDAL/);
  });

  it('NAD27 UTM to NAD27 geographic (no datum leg) still converts', () => {
    const { report } = convertCloud(cloud(26712), { format: 'las', crsMode: 'reproject', targetEpsg: 4267 });
    expect(report.ok).toBe(true);
  });
});
