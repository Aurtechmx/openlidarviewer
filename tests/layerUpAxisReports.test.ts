/**
 * layerUpAxisReports.test.ts
 *
 * The Scan Report, the PDF scan metadata and the feature-candidate input read a
 * layer's up axis from the per-layer rule (`geo/frame/layerUpFrame.ts`), not
 * from the source format. A PLY under EPSG:32613 stores easting, northing and
 * height in X, Y and Z: its footprint is X by Y and its height the Z span. A
 * local PLY keeps the Y-up reading. A glTF under a CRS has no up axis, and every
 * axis-dependent figure says so instead of printing a guess.
 *
 * Fixture: 10 (X) by 4 (Y) by 20 (Z) in a georeferenced PLY, so the three spans
 * are told apart by their value.
 */

import { describe, it, expect } from 'vitest';
import { scanReport } from '../src/analysis/modules/scanReport';
import { PointCloud } from '../src/model/PointCloud';
import type { SourceFormat } from '../src/io/sniffFormat';
import { spatialContextFrom } from '../src/geo/SpatialContext';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { CrsInfo } from '../src/io/crs';
import { staticScanExtent } from '../src/app/reportExport';
import { buildDatasetSummary } from '../src/report/ReportMetadataSection';
import { buildFeatureExtractionInput } from '../src/app/featureExtractionInput';
import { resolveLayerUpFrame } from '../src/geo/frame/layerUpFrame';
import { cloudUpAxisIndex, peekCloudUpAxisIndex, setCloudUpResolver } from '../src/render/layerUpRegistry';
import { registerOrganizedRange, organizedRangeFor, forgetOrganizedRange } from '../src/model/organizedRangeLink';

const UTM13N: ResolvedCrs = {
  kind: 'projected',
  name: 'WGS 84 / UTM zone 13N',
  epsg: 32613,
  linearUnit: 'metre',
  linearUnitToMetres: 1,
  source: 'las-vlr',
  confidence: 'high',
  userConfirmed: false,
} as ResolvedCrs;

function cloud(format: SourceFormat, classification?: Uint8Array, crs?: CrsInfo): PointCloud {
  // 10 m along X, 4 m along Y, 20 m along Z.
  return new PointCloud({
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 4, 0, 0, 0, 20]),
    ...(classification ? { classification } : {}),
    ...(crs ? { metadata: { crs } } : {}),
    origin: [0, 0, 0],
    sourceFormat: format,
    name: `scan.${format}`,
  });
}

const rowValue = (rows: readonly { label: string; value: string }[], label: string): string | undefined =>
  rows.find((r) => r.label === label)?.value;

describe('Scan Report up axis', () => {
  it('a PLY under EPSG:32613 reports footprint X by Y and height as the Z span', () => {
    const result = scanReport.run(cloud('ply'), undefined, { spatialContext: spatialContextFrom(UTM13N) });
    expect(rowValue(result.rows, 'Width')).toBe('10.0 m');
    expect(rowValue(result.rows, 'Depth')).toBe('4.0 m');
    expect(rowValue(result.rows, 'Height')).toMatch(/^20\.0 /);
    // 4 points over a 10 m by 4 m footprint.
    expect(rowValue(result.rows, 'Density')).toBe('0.1 pts/m² (bounding-box estimate)');
  });

  it('a local PLY keeps the Y-up reading: footprint X by Z, height the Y span', () => {
    const result = scanReport.run(cloud('ply'), undefined, { spatialContext: spatialContextFrom(null) });
    expect(rowValue(result.rows, 'Depth')).toContain('20.0');
    expect(rowValue(result.rows, 'Height')).toContain('4.0');
  });

  it('a glTF under a CRS withholds depth, height, density and spacing with the reason', () => {
    const result = scanReport.run(cloud('gltf'), undefined, { spatialContext: spatialContextFrom(UTM13N) });
    for (const label of ['Depth', 'Height', 'Density', 'Spacing']) {
      expect(rowValue(result.rows, label)).toMatch(/^not available: no up axis; glTF stores Y as the up axis/);
    }
    // X is horizontal for every frame, so the width stands.
    expect(rowValue(result.rows, 'Width')).toBe('10.0 m');
  });
});

describe('PDF scan metadata up axis', () => {
  const b = { min: [0, 0, 0], max: [10, 4, 20] };

  it('a PLY under EPSG:32613 states footprint X by Y, height Z and a Z elevation range', () => {
    const r = staticScanExtent({ sourceFormat: 'ply', sourceOrigin: [0, 0, 100] }, UTM13N, 4, b);
    expect(r.upAxisRefusal).toBeUndefined();
    expect(r.extent).toMatchObject({ width: 10, depth: 4, height: 20 });
    expect(r.elevationRange).toEqual({ min: 100, max: 120 });
  });

  it('a local PLY keeps Y: footprint X by Z, height Y', () => {
    const r = staticScanExtent({ sourceFormat: 'ply', sourceOrigin: [0, 100, 0] }, null, 4, b);
    expect(r.extent.depth).toBeCloseTo(20, 9);
    expect(r.extent.height).toBeCloseTo(4, 9);
    expect(r.elevationRange).toBeDefined();
    expect(r.elevationRange!.min).toBeCloseTo(100, 9);
    expect(r.elevationRange!.max).toBeCloseTo(104, 9);
  });

  it('a glTF under a CRS prints the reason where depth, height and density would be', () => {
    const r = staticScanExtent({ sourceFormat: 'gltf', sourceOrigin: [0, 0, 0] }, UTM13N, 4, b);
    expect(r.upAxisRefusal).toMatch(/^not available: no up axis; glTF stores Y/);
    expect(r.elevationRange).toBeUndefined();
    const rows = buildDatasetSummary({
      fileName: 'a.gltf', format: 'GLTF', sourcePointCount: 4,
      hasRgb: false, hasIntensity: false, hasClassification: false,
      ...r.extent, upAxisRefusal: r.upAxisRefusal,
    } as never);
    expect(rowValue(rows, 'Depth')).toBe('unknown');
    expect(rowValue(rows, 'Height')).toBe('unknown');
    expect(rowValue(rows, 'Density')).toBeUndefined();
    expect(rowValue(rows, 'Up axis')).toMatch(/no up axis; glTF stores Y/);
  });
});

describe('feature extraction input up axis', () => {
  function buildingCloud(format: SourceFormat): PointCloud {
    // Class 6 points over 10 (X) by 4 (Y) by 20 (Z).
    return cloud(format, new Uint8Array([6, 6, 6, 6]));
  }

  it('a PLY under a CRS lays footprints on X by Y and takes Z up', () => {
    const frame = resolveLayerUpFrame({ format: 'ply', crs: UTM13N });
    const input = buildFeatureExtractionInput(buildingCloud('ply'), undefined, frame)!;
    expect(input.up).toEqual([0, 0, 1]);
    expect(input.buildingPoints.map((p) => p.y)).toEqual([0, 0, 4, 0]);
  });

  it('a local PLY keeps Y up and lays footprints on X by Z', () => {
    const input = buildFeatureExtractionInput(buildingCloud('ply'), undefined, resolveLayerUpFrame({ format: 'ply', crs: null }))!;
    expect(input.up).toEqual([0, 1, 0]);
    expect(input.buildingPoints.map((p) => p.y)).toEqual([0, 0, 0, 20]);
  });

  it('without a frame the declared CRS decides, so a georeferenced PLY is still Z-up', () => {
    const c = cloud('ply', new Uint8Array([6, 6, 6, 6]), { source: 'wkt', epsg: 32613, name: 'UTM 13N', linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false } as CrsInfo);
    expect(buildFeatureExtractionInput(c)!.up).toEqual([0, 0, 1]);
  });

  it('a glTF under a CRS has no ground plane, so nothing is extracted', () => {
    const frame = resolveLayerUpFrame({ format: 'gltf', crs: UTM13N });
    expect(buildFeatureExtractionInput(buildingCloud('gltf'), undefined, frame)).toBeNull();
  });
});

describe('acquisition-coverage up axis', () => {
  it('follows the layer\'s resolved axis when it is read, not the format at registration', () => {
    const c = cloud('ply');
    let crsInPlay = false;
    setCloudUpResolver(() => (crsInPlay ? [0, 0, 1] : [0, 1, 0]));
    try {
      registerOrganizedRange(
        'layer-a', 'a', { frames: [{ start: 0, count: 4 }] } as never, undefined,
        () => (peekCloudUpAxisIndex(c) === 2 ? 'z' : 'y'),
      );
      expect(organizedRangeFor('layer-a')?.upAxis).toBe('y');
      crsInPlay = true;
      expect(organizedRangeFor('layer-a')?.upAxis).toBe('z');
      // Reading it for the coverage fit does not count as colouring the cloud.
      expect(cloudUpAxisIndex(c)).toBe(2);
    } finally {
      forgetOrganizedRange('layer-a');
      setCloudUpResolver(null);
    }
  });
});
