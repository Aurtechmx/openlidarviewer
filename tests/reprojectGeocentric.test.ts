/**
 * reprojectGeocentric.test.ts — a geocentric (ECEF) CRS is refused, never
 * transformed in 2-D.
 *
 * The reprojector maps X/Y and carries Z through. A geocentric CRS has three
 * coupled metric axes, so a 2-D transform to or from one writes X/Y that are
 * hundreds of metres off and a Z that is the old elevation instead of the
 * geocentric Z (thousands of kilometres). It must refuse, the converter must
 * fail instead of writing, and the export fields must say so before export.
 */
import { describe, it, expect } from 'vitest';
import { reprojectGlobal } from '../src/convert/reproject';
import { geocentricReprojectProblem, isGeocentricEpsg } from '../src/convert/epsg';
import { convertCloud } from '../src/convert/convertCloud';
import { PointCloud } from '../src/model/PointCloud';
import type { GlobalPoints } from '../src/convert/globalPoints';

function one(x: number, y: number, z: number): GlobalPoints {
  return {
    count: 1,
    x: new Float64Array([x]),
    y: new Float64Array([y]),
    z: new Float64Array([z]),
  } as unknown as GlobalPoints;
}

describe('geocentric reprojection', () => {
  it('recognises geocentric codes by their definition', () => {
    expect(isGeocentricEpsg(4978)).toBe(true);
    expect(isGeocentricEpsg(32611)).toBe(false);
    expect(isGeocentricEpsg(4326)).toBe(false);
    expect(isGeocentricEpsg(999999)).toBe(false);
  });

  it('refuses UTM -> EPSG:4978 and leaves the coordinates unchanged', () => {
    const g = one(500000, 4100000, 1500);
    const r = reprojectGlobal(g, 32611, 4978);
    expect(r.transformed).toBe(false);
    expect(r.note).toMatch(/geocentric/i);
    expect(r.points.x[0]).toBe(500000);
    expect(r.points.y[0]).toBe(4100000);
    expect(r.points.z[0]).toBe(1500);
    expect(r.datumCaveat).toBeNull();
  });

  it('refuses EPSG:4978 -> UTM too', () => {
    const r = reprojectGlobal(one(-2314489.68, -4542441.76, 3822392.35), 4978, 32611);
    expect(r.transformed).toBe(false);
    expect(r.note).toMatch(/geocentric/i);
  });

  it('the converter fails rather than writing a reproject to EPSG:4978', () => {
    const cloud = new PointCloud({
      positions: Float32Array.from([0, 0, 0]),
      origin: [500000, 4100000, 1500],
      sourceFormat: 'las',
      name: 'survey.las',
      metadata: {
        crs: { source: 'wkt', name: 'UTM 11N', epsg: 32611, linearUnit: 'metre', linearUnitToMetres: 1, isGeographic: false },
      },
    });
    const { file, report } = convertCloud(cloud, { format: 'xyz', crsMode: 'reproject', targetEpsg: 4978 });
    expect(file).toBeNull();
    expect(report.ok).toBe(false);
    expect(report.log.some((l) => l.level === 'error' && /geocentric/i.test(l.message))).toBe(true);
  });

  it('the EPSG fields name the problem before export', () => {
    expect(geocentricReprojectProblem('', '4978')).toMatch(/geocentric/i);
    expect(geocentricReprojectProblem('EPSG:4978', '32611')).toMatch(/geocentric/i);
    expect(geocentricReprojectProblem('32611', '4326')).toBeNull();
    expect(geocentricReprojectProblem('', '')).toBeNull();
  });
});
