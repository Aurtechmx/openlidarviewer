/**
 * contourWorldOrigin.test.ts — world-frame registration of contour exports.
 *
 * The terrain pipeline runs in the cloud's recentred LOCAL frame; v0.4.3's
 * vector exports serialised those small local coordinates while stamping the
 * real EPSG code, so a GIS dropped the contours at the CRS origin. These
 * tests pin the fix: a supplied `worldOrigin` shifts coordinates (and
 * elevations, when `z` is given) into the CRS frame, and a MISSING origin
 * suppresses the CRS stamp instead of georeferencing local coordinates.
 */

import { describe, it, expect } from 'vitest';
import {
  serializeContours,
  LOCAL_FRAME_WARNING,
} from '../src/terrain/contour/contourDownload';
import { shiftFeatureModelToWorld } from '../src/terrain/contour/contourFeatureModel';
import type {
  ContourFeature,
  ContourFeatureModel,
} from '../src/terrain/contour/contourFeatureModel';

const ORIGIN = { x: 600000, y: 4000000, z: 120 } as const;

function model(): ContourFeatureModel {
  const features: ContourFeature[] = [
    {
      value: 10,
      isIndex: true,
      grade: 'solid',
      meanConfidence: 90,
      closed: false,
      coordinates: [
        [2, 3],
        [4, 5],
      ],
    },
  ];
  return {
    features,
    crs: 'EPSG:32610',
    verticalDatum: 'EPSG:5703',
    intervalM: 1,
    contourStyle: 'smooth',
    bbox: { minX: 2, minY: 3, maxX: 4, maxY: 5 },
    interpolatedFraction: 0,
    coverageMode: 'full',
    warnings: [],
  };
}

describe('shiftFeatureModelToWorld', () => {
  it('shifts coordinates, bbox and elevation by the origin', () => {
    const shifted = shiftFeatureModelToWorld(model(), ORIGIN);
    expect(shifted.features[0].coordinates[0]).toEqual([600002, 4000003]);
    expect(shifted.features[0].coordinates[1]).toEqual([600004, 4000005]);
    expect(shifted.features[0].value).toBe(130); // 10 + origin.z
    expect(shifted.bbox).toEqual({
      minX: 600002,
      minY: 4000003,
      maxX: 600004,
      maxY: 4000005,
    });
    // CRS is preserved — world coordinates may honestly carry it.
    expect(shifted.crs).toBe('EPSG:32610');
  });

  it('leaves elevations alone when the origin has no z', () => {
    const shifted = shiftFeatureModelToWorld(model(), { x: 100, y: 200 });
    expect(shifted.features[0].value).toBe(10);
    expect(shifted.features[0].coordinates[0]).toEqual([102, 203]);
  });

  it('returns the model unchanged for a zero origin', () => {
    const m = model();
    expect(shiftFeatureModelToWorld(m, { x: 0, y: 0, z: 0 })).toBe(m);
  });
});

describe('serializeContours — world origin threading', () => {
  it('GeoJSON: a nonzero origin shifts coordinates and elevations, CRS kept', () => {
    const f = serializeContours(model(), 'geojson-native', { worldOrigin: ORIGIN });
    const gj = JSON.parse(f.content) as {
      crs?: { properties: { name: string } };
      features: Array<{
        properties: { elevation: number };
        geometry: { coordinates: number[][] };
      }>;
    };
    // Coordinate Z carries the WORLD elevation (10 + origin.z 120 = 130).
    expect(gj.features[0].geometry.coordinates[0]).toEqual([600002, 4000003, 130]);
    expect(gj.features[0].properties.elevation).toBe(130);
    // World coordinates are honestly georeferenced.
    expect(gj.crs?.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
  });

  it('GeoJSON: no origin → local coordinates, NO CRS stamp, local-frame note', () => {
    const f = serializeContours(model(), 'geojson-native');
    const gj = JSON.parse(f.content) as {
      crs?: unknown;
      metadata: { warnings: string[] };
      features: Array<{ geometry: { coordinates: number[][] } }>;
    };
    // Geometry falls back to the local frame (current behaviour); Z is the
    // local elevation (10).
    expect(gj.features[0].geometry.coordinates[0]).toEqual([2, 3, 10]);
    // …but local coordinates must never be stamped with a real EPSG code.
    expect(gj.crs).toBeUndefined();
    expect(gj.metadata.warnings).toContain(LOCAL_FRAME_WARNING);
  });

  it('DXF: vertices and the group-38 elevation are world values', () => {
    const dxf = serializeContours(model(), 'dxf', { worldOrigin: ORIGIN }).content;
    expect(dxf).toMatch(/\n10\n600002\n20\n4000003\n/); // first vertex
    expect(dxf).toMatch(/\n38\n130\n/); // elevation 10 + 120
  });

  it('SVG: label elevations shift with origin.z', () => {
    const svg = serializeContours(model(), 'svg', {
      worldOrigin: ORIGIN,
      labels: [{ x: 3, y: 4, angleRad: 0, value: 10 }],
    }).content;
    // The label states the WORLD elevation (10 + 120 = 130), not the local one.
    expect(svg).toMatch(/>130<\/text>/);
    expect(svg).not.toMatch(/>10<\/text>/);
  });

  it('an explicit zero origin keeps geometry AND the CRS stamp (world == local)', () => {
    const f = serializeContours(model(), 'geojson-native', { worldOrigin: { x: 0, y: 0 } });
    const gj = JSON.parse(f.content) as {
      crs?: { properties: { name: string } };
      features: Array<{ geometry: { coordinates: number[][] } }>;
    };
    expect(gj.features[0].geometry.coordinates[0]).toEqual([2, 3, 10]);
    expect(gj.crs?.properties.name).toBe('urn:ogc:def:crs:EPSG::32610');
  });
});
