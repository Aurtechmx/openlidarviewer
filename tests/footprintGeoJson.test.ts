/**
 * footprintGeoJson.test.ts — footprint → RFC 7946 GeoJSON export.
 */

import { describe, it, expect } from 'vitest';
import { footprintsToGeoJson } from '../src/features/footprintGeoJson';

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }];

describe('footprintsToGeoJson', () => {
  it('emits a closed Polygon feature per footprint with derived provenance', () => {
    const gj = footprintsToGeoJson([{ ring: square, areaSource: 60, areaM2: 60, centroidX: 5, centroidY: 3, id: 'b1' }], { crs: 'EPSG:3301' });
    expect(gj.type).toBe('FeatureCollection');
    expect(gj.metadata.crs).toBe('EPSG:3301');
    expect(gj.features).toHaveLength(1);
    const f = gj.features[0] as { id: string; geometry: { type: string; coordinates: number[][][] }; properties: Record<string, unknown> };
    expect(f.id).toBe('b1');
    expect(f.geometry.type).toBe('Polygon');
    // Ring closed per RFC 7946: first === last.
    const ring = f.geometry.coordinates[0];
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring).toHaveLength(5); // 4 corners + closing vertex
    // Honesty in properties.
    expect(f.properties.source).toBe('derived');
    expect(f.properties.featureType).toBe('building-footprint-candidate');
    expect(f.properties.areaM2).toBe(60);
  });

  it('skips a degenerate ring (<3 vertices)', () => {
    const gj = footprintsToGeoJson([{ ring: [{ x: 0, y: 0 }, { x: 1, y: 1 }], areaSource: 0, areaM2: 0, centroidX: 0, centroidY: 0 }]);
    expect(gj.features).toHaveLength(0);
  });

  it('records a null CRS when none is supplied, and never invents one', () => {
    const gj = footprintsToGeoJson([{ ring: square, areaSource: 60, areaM2: 60, centroidX: 5, centroidY: 3 }]);
    expect(gj.metadata.crs).toBeNull();
    // Coordinates are the source projected values, not reprojected.
    const ring = (gj.features[0] as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0];
    expect(ring[1]).toEqual([10, 0]);
  });
});

describe('the metric property is never a source-unit magnitude', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 3 },
  ];

  it('omits areaM2 when the linear unit is not known', () => {
    const fc = footprintsToGeoJson([
      { ring, areaSource: 9, areaM2: null, centroidX: 1.5, centroidY: 1.5 },
    ]);
    const props = fc.features[0].properties as Record<string, unknown>;
    expect(props.areaSource).toBe(9);
    expect(
      'areaM2' in props,
      'a reader cannot tell a foot magnitude from a metric one, so an unknown ' +
        'unit must leave the metric property out rather than fill it in',
    ).toBe(false);
  });

  it('writes areaM2 only from the converted value, not the source one', () => {
    // 9 ft² is 0.836 m². A writer that fell back to the source number would
    // emit 9 here.
    const fc = footprintsToGeoJson([
      { ring, areaSource: 9, areaM2: 0.836, centroidX: 1.5, centroidY: 1.5 },
    ]);
    const props = fc.features[0].properties as Record<string, unknown>;
    expect(props.areaM2).toBe(0.836);
    expect(props.areaSource).toBe(9);
  });
});
