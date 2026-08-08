/**
 * footprintGeoJson.test.ts — footprint → RFC 7946 GeoJSON export.
 */

import { describe, it, expect } from 'vitest';
import { footprintsToGeoJson } from '../src/features/footprintGeoJson';

const square = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 6 }, { x: 0, y: 6 }];

describe('footprintsToGeoJson', () => {
  it('emits a closed Polygon feature per footprint with derived provenance', () => {
    const gj = footprintsToGeoJson([{ ring: square, areaM2: 60, centroidX: 5, centroidY: 3, id: 'b1' }], { crs: 'EPSG:3301' });
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
    const gj = footprintsToGeoJson([{ ring: [{ x: 0, y: 0 }, { x: 1, y: 1 }], areaM2: 0, centroidX: 0, centroidY: 0 }]);
    expect(gj.features).toHaveLength(0);
  });

  it('records a null CRS when none is supplied, and never invents one', () => {
    const gj = footprintsToGeoJson([{ ring: square, areaM2: 60, centroidX: 5, centroidY: 3 }]);
    expect(gj.metadata.crs).toBeNull();
    // Coordinates are the source projected values, not reprojected.
    const ring = (gj.features[0] as { geometry: { coordinates: number[][][] } }).geometry.coordinates[0];
    expect(ring[1]).toEqual([10, 0]);
  });
});
