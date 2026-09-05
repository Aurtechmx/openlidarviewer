/**
 * The site KML places features by handing a LOCAL x,y to the projection as an
 * easting and a northing. That pairing is the ground plane in a Z-up frame and
 * nowhere else.
 *
 * The scan-footprint export has refused a Y-up source since it shipped, for
 * exactly this reason. The site KML converts through the same mapper and was
 * never gated: a Y-up scan wrote a file in which every measurement and
 * annotation is positioned using its HEIGHT as a northing. A feature 3 m above
 * the ground moves 3 m north, and the output is still a well-formed KML full of
 * plausible coordinates, which is what makes it worth refusing.
 */
import { describe, it, expect } from 'vitest';
import { exportSiteKml, siteKmlStatus, type KmlActionDeps } from '../src/app/kmlActions';
import type { KmlExportInput } from '../src/export/kmlExport';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';
import type { Measurement } from '../src/render/measure/types';
import type { SpatialUpAxis } from '../src/geo/SpatialContext';

const UTM12: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 12N', epsg: 32612,
  linearUnit: 'metre', linearUnitToMetres: 1, source: 'wkt',
  confidence: 'high', userConfirmed: true,
} as unknown as ResolvedCrs;

function harness(upAxis: SpatialUpAxis) {
  const written: string[] = [];
  const errors: string[] = [];
  const deps = {
    hasViewer: () => true,
    geo: () => ({ origin: [500_000, 4_400_000, 0] as [number, number, number], crsName: 'UTM 12N', name: 'site.las' }),
    crsCurrent: () => UTM12,
    upAxis: () => upAxis,
    annotations: () => [],
    measurements: () => [{ id: 'm1', kind: 'distance', points: [[0, 0, 0], [1, 1, 1]] } as unknown as Measurement],
    viewpoints: () => [],
    worldUp: () => [0, 0, 1] as [number, number, number],
    unitToMetres: () => 1,
    scanExtent: () => null,
    scanHullPositions: () => null,
    baseName: (n: string) => n.replace(/\.[^.]+$/, ''),
    downloadText: (filename: string) => { written.push(filename); },
    setError: (m: string) => { errors.push(m); },
    loadKmlExport: async () => ({
      buildKml: (_input: KmlExportInput) => '<kml/>',
      KmlCoordinateError: class extends Error {},
    }),
  } as unknown as KmlActionDeps;
  return { deps, written, errors };
}

describe('site KML — a Y-up source is refused, not silently placed', () => {
  it('is not ready, and says why in terms of the up-axis', () => {
    const s = siteKmlStatus(harness('y').deps);
    expect(s.ready).toBe(false);
    expect(s.reason).toMatch(/Y-up/);
    // The reason must name the actual consequence, not just the axis.
    expect(s.reason).toMatch(/height as a northing/i);
  });

  it('writes NO file when the export is invoked anyway', async () => {
    const h = harness('y');
    await exportSiteKml(h.deps);
    expect(h.written).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatch(/Y-up/);
  });

  it('refuses an undetermined up-axis the same way', async () => {
    const h = harness('unknown');
    expect(siteKmlStatus(h.deps).ready).toBe(false);
    await exportSiteKml(h.deps);
    expect(h.written).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toMatch(/up-axis was not determined/);
  });

  it('a Z-up georeferenced scan still exports, so the gate is not a blanket refusal', async () => {
    const h = harness('z');
    expect(siteKmlStatus(h.deps).ready).toBe(true);
    await exportSiteKml(h.deps);
    expect(h.errors).toEqual([]);
    expect(h.written).toEqual(['site.kml']);
  });
});
