import { describe, expect, test } from 'vitest';
import { validateCrsForMeasurement } from '../src/geo/CrsValidation';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import { CrsService } from '../src/geo/CrsService';
import { prepareEpochFrames, epochUnitMismatchLines } from '../src/app/epochFramePrep';
import { compareDtms } from '../src/terrain/change/compareDtms';
import type { DtmGrid } from '../src/terrain/ground/cellConfidence';
import { crsFromEpsg, crsFromWkt } from '../src/io/crs';
import { DEPTH_AXIS_REFUSAL, elevationWorkflowRefusal, spatialContextFrom } from '../src/geo/SpatialContext';
import { deriveCoreParams } from '../src/app/terrainAnalysisRunner';

// Fail-closed frames: a depth-positive-down vertical reference, a geocentric
// CRS and a Web Mercator grid each reach a refusal instead of a metric figure.

const WKT2_4978 = "GEODCRS[\"WGS 84\",ENSEMBLE[\"World Geodetic System 1984 ensemble\",MEMBER[\"World Geodetic System 1984 (Transit)\"],MEMBER[\"World Geodetic System 1984 (G730)\"],MEMBER[\"World Geodetic System 1984 (G873)\"],MEMBER[\"World Geodetic System 1984 (G1150)\"],MEMBER[\"World Geodetic System 1984 (G1674)\"],MEMBER[\"World Geodetic System 1984 (G1762)\"],MEMBER[\"World Geodetic System 1984 (G2139)\"],MEMBER[\"World Geodetic System 1984 (G2296)\"],ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]],ENSEMBLEACCURACY[2.0]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[Cartesian,3],AXIS[\"(X)\",geocentricX,ORDER[1],LENGTHUNIT[\"metre\",1]],AXIS[\"(Y)\",geocentricY,ORDER[2],LENGTHUNIT[\"metre\",1]],AXIS[\"(Z)\",geocentricZ,ORDER[3],LENGTHUNIT[\"metre\",1]],USAGE[SCOPE[\"Geodesy. Navigation and positioning using GPS satellite system.\"],AREA[\"World.\"],BBOX[-90,-180,90,180]],ID[\"EPSG\",4978]]";
const WKT1_4978 = "GEOCCS[\"WGS 84\",DATUM[\"WGS_1984\",SPHEROID[\"WGS 84\",6378137,298.257223563,AUTHORITY[\"EPSG\",\"7030\"]],AUTHORITY[\"EPSG\",\"6326\"]],PRIMEM[\"Greenwich\",0,AUTHORITY[\"EPSG\",\"8901\"]],UNIT[\"metre\",1,AUTHORITY[\"EPSG\",\"9001\"]],AXIS[\"Geocentric X\",OTHER],AXIS[\"Geocentric Y\",OTHER],AXIS[\"Geocentric Z\",NORTH],AUTHORITY[\"EPSG\",\"4978\"]]";
const WKT2_2015_4326 = "GEODCRS[\"WGS 84\",DATUM[\"World Geodetic System 1984\",ELLIPSOID[\"WGS 84\",6378137,298.257223563,LENGTHUNIT[\"metre\",1]]],PRIMEM[\"Greenwich\",0,ANGLEUNIT[\"degree\",0.0174532925199433]],CS[ellipsoidal,2],AXIS[\"geodetic latitude (Lat)\",north,ORDER[1],ANGLEUNIT[\"degree\",0.0174532925199433]],AXIS[\"geodetic longitude (Lon)\",east,ORDER[2],ANGLEUNIT[\"degree\",0.0174532925199433]],SCOPE[\"Horizontal component of 3D system.\"],AREA[\"World.\"],BBOX[-90,-180,90,180],ID[\"EPSG\",4326]]";

const utm: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 13N', epsg: 32613, linearUnit: 'metre', linearUnitToMetres: 1,
  verticalUnitToMetres: 1, source: 'las-vlr', confidence: 'high', userConfirmed: false,
};

describe('depth-positive-down vertical reference', () => {
  const svc = () => new CrsService({ get: () => undefined, set: () => {}, clear: () => {} });
  const crsWith = (verticalEpsg: number, verticalDatum: string) => ({
    source: 'wkt' as const, name: 'WGS 84 / UTM zone 12N', epsg: 32612, linearUnit: 'metre' as const,
    linearUnitToMetres: 1, isGeographic: false, verticalDatum, verticalEpsg, verticalUnitToMetres: 1,
  });
  const epoch = (name: string, z: number, crs: ReturnType<typeof crsWith>) =>
    ({ name, sourceFormat: 'las' as const, positions: new Float32Array([0, 0, z, 1, 1, z]), metadata: { crs } });
  const grid = (z: number, datum: string) => ({
    cols: 1, rows: 1, cellSizeM: 1, originH1: 500000, originH2: 4000000, crs: 'WGS 84 / UTM zone 12N',
    verticalDatum: datum, z: new Float32Array([z]), coverage: new Uint8Array([2]), confidence: new Float32Array([100]),
  }) as DtmGrid;

  test('a depth decrease (a physical rise) is refused, never reported as loss', () => {
    const depth = crsWith(6357, 'NAVD88 depth');
    const prepared = prepareEpochFrames(svc(), epoch('a.las', 10, depth), epoch('b.las', 9, depth));
    const cmp = compareDtms(grid(10, 'NAVD88 depth'), grid(9, 'NAVD88 depth'), { ...prepared.frames, verticalUnitToMetres: 1 });
    expect(prepared.comparable && cmp.result.stats.lost === 1).toBe(false);
    expect(prepared.comparable).toBe(false);
    expect(prepared.reason).toBe('frame');
    expect(prepared.frameRefusal).toBe(DEPTH_AXIS_REFUSAL);
    expect(epochUnitMismatchLines('a → b', 'frame', prepared.frameRefusal ?? undefined)[1]).toContain(DEPTH_AXIS_REFUSAL);
  });

  test('height-up and depth-down representations of one surface: identical result or refusal', () => {
    const up = crsWith(5703, 'NAVD88');
    const heights = prepareEpochFrames(svc(), epoch('a.las', -10, up), epoch('b.las', -9, up));
    expect(heights.comparable).toBe(true);
    const depths = prepareEpochFrames(svc(), epoch('a.las', 10, crsWith(6357, 'NAVD88 depth')), epoch('b.las', 9, crsWith(6357, 'NAVD88 depth')));
    expect(depths.comparable).toBe(false);
  });

  test('one depth epoch is enough to refuse', () => {
    const p = prepareEpochFrames(svc(), epoch('a.las', 10, crsWith(5703, 'NAVD88')), epoch('b.las', 9, crsWith(5715, 'MSL depth')));
    expect(p.reason).toBe('frame');
  });

  test.each([6357, 6358, 5715, 8051, 8053])('EPSG:%i is refused by the shared elevation gate', (code) => {
    expect(elevationWorkflowRefusal(spatialContextFrom(crsFromEpsg(32612, { verticalEpsg: code })))).toBe(DEPTH_AXIS_REFUSAL);
  });

  test('a WKT vertical axis declared DOWN is refused even with an unknown datum name', () => {
    const wkt = 'COMPD_CS["x",PROJCS["WGS 84 / UTM zone 12N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["metre",1],AUTHORITY["EPSG","32612"]],VERT_CS["Harbour chart datum",VERT_DATUM["Harbour",2005],UNIT["metre",1],AXIS["Depth",DOWN]]]';
    const info = crsFromWkt(wkt);
    expect(info.verticalAxisDown).toBe(true);
    expect(elevationWorkflowRefusal(spatialContextFrom(info))).toBe(DEPTH_AXIS_REFUSAL);
  });

  test('terrain analysis core derivation refuses a depth frame', () => {
    const ctx = spatialContextFrom(crsFromEpsg(32612, { verticalEpsg: 6357 }));
    expect(() => deriveCoreParams(new Float32Array([0, 0, 1, 1, 1, 1]), undefined, { context: () => ctx } as never)).toThrow(DEPTH_AXIS_REFUSAL);
  });

  test('a height-up frame passes the shared gate', () => {
    expect(elevationWorkflowRefusal(spatialContextFrom(crsFromEpsg(32612, { verticalEpsg: 5703 })))).toBeNull();
  });
});

describe('geocentric CRS', () => {
  test.each([['WKT2:2019', WKT2_4978], ['WKT1 GEOCCS', WKT1_4978]])('official %s EPSG:4978 is not admitted as projected', (_label, wkt) => {
    const parsed = crsFromWkt(wkt);
    const ctx = spatialContextFrom(parsed);
    expect(ctx.metricClaimsPermitted).toBe(false);
    expect(ctx.kind).toBe('geocentric');
    expect(parsed.name).toContain('WGS 84');
    expect(parsed.epsg).toBe(4978);
    expect(ctx.metricValidity).toBe('unsupported-frame');
    expect(elevationWorkflowRefusal(ctx)).toMatch(/Geocentric CRS/);
  });

  test('a geocentric EPSG code alone is geocentric', () => {
    expect(spatialContextFrom(crsFromEpsg(4936)).kind).toBe('geocentric');
  });

  test('a WKT2 geodetic CRS with an ellipsoidal CS stays geographic', () => {
    const info = crsFromWkt(WKT2_2015_4326);
    expect(info.isGeographic).toBe(true);
    expect(info.geocentric).toBeUndefined();
  });

  test('a projected CRS is unaffected', () => {
    expect(validateCrsForMeasurement(utm).validity).toBe('safe-metric');
  });
});

describe('Web Mercator', () => {
  test.each([3857, 900913, 3785, 102100, 102113])('EPSG:%i does not receive a safe-metric verdict', (epsg) => {
    const verdict = validateCrsForMeasurement({ ...utm, epsg, name: 'WGS 84 / Pseudo-Mercator' });
    expect(verdict.validity).toBe('grid-only');
    expect(verdict.canDisplayMetric).toBe(false);
    expect(verdict.severity).toBe('block');
  });

  test('a WKT naming Pseudo-Mercator with no code is recognised', () => {
    const verdict = validateCrsForMeasurement({ ...utm, epsg: undefined, name: 'Popular Visualisation CRS / Mercator' });
    expect(verdict.validity).toBe('grid-only');
  });

  test('horizontal metrics are refused, heights are kept', () => {
    const ctx = spatialContextFrom({ ...utm, epsg: 3857, name: 'WGS 84 / Pseudo-Mercator' });
    expect(ctx.metricClaimsPermitted).toBe(false);
    expect(ctx.horizontalMetricRefused).toBe(true);
    expect(ctx.verticalScaleKnown).toBe(true);
    expect(elevationWorkflowRefusal(ctx)).toMatch(/Web Mercator/);
  });
});
