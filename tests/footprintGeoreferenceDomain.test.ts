/**
 * Building footprints must leave in the coordinate domain the file claims.
 *
 * Extraction runs on the cloud's RECENTRED buffer — the module says so, and it
 * is right to, because the footprint grid and the conductor fit are both
 * translation-invariant. The export then wrote those local coordinates while
 * declaring them to be in the source projected frame. For a UTM scan centred at
 * E 523,000 / N 3,642,000 the file said "easting 12" and a GIS placed the
 * building hundreds of kilometres away, at the projection origin.
 *
 * The bug was invisible to a shape test: the polygon is the right shape either
 * way. Only the DOMAIN of the numbers distinguishes a correct file from a
 * ruinous one, which is what these assert.
 */
import { describe, it, expect } from 'vitest';
import { acceptedFootprintGeoJson } from '../src/ui/featureCandidatesMount';
import { CandidateReviewStore } from '../src/features/candidateReview';
import { makeLocalToLonLat } from '../src/export/lonLatMapper';
import type { BuildingCandidate } from '../src/features/FeatureExtractionService';

/** A 10 x 10 square in LOCAL coordinates, as extraction produces. */
function localSquare(id: string): BuildingCandidate {
  return {
    id,
    ring: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ],
    areaSource: 100,
    areaM2: 100,
    centroid: [5, 5],
  } as unknown as BuildingCandidate;
}

describe('exported footprint coordinates are WGS 84 lon/lat', () => {
  const review = new CandidateReviewStore();
  review.accept('a');

  it('restores the world origin instead of writing local numbers', () => {
    // A real UTM frame, far from the origin — the case that made the defect
    // catastrophic rather than merely wrong.
    const toLonLat = makeLocalToLonLat(
      { kind: 'projected', epsg: 32633, name: 'WGS 84 / UTM zone 33N' } as never,
      [523000, 3642000, 0],
    );
    expect(toLonLat, 'UTM 33N must be convertible').not.toBeNull();
    const gj = acceptedFootprintGeoJson([localSquare('a')], review, 'EPSG:32633', toLonLat)!;
    const ring = (gj.features[0].geometry as { coordinates: number[][][] }).coordinates[0];

    for (const [lon, lat] of ring) {
      expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
      // The decisive assertion: a position outside these bounds is not a
      // longitude/latitude, whatever the file says. Local coordinates (0..10)
      // would pass a naive range check, so latitude alone is not enough —
      // 3,642,000 as a "latitude" is what the old file effectively claimed.
      expect(lon, 'longitude out of domain').toBeGreaterThanOrEqual(-180);
      expect(lon, 'longitude out of domain').toBeLessThanOrEqual(180);
      expect(lat, 'latitude out of domain').toBeGreaterThanOrEqual(-90);
      expect(lat, 'latitude out of domain').toBeLessThanOrEqual(90);
      // And it is NOT the untransformed local square.
      expect(Math.abs(lon) > 1 || Math.abs(lat) > 1).toBe(true);
    }
  });

  it('places the footprint at the scan, not at the projection origin', () => {
    const toLonLat = makeLocalToLonLat(
      { kind: 'projected', epsg: 32633, name: 'WGS 84 / UTM zone 33N' } as never,
      [523000, 3642000, 0],
    )!;
    const gj = acceptedFootprintGeoJson([localSquare('a')], review, 'EPSG:32633', toLonLat)!;
    const [lon, lat] = (gj.features[0].geometry as { coordinates: number[][][] }).coordinates[0][0];
    // UTM 33N easting 523 km / northing 3,642 km is northern Africa, near 15°E
    // and 32.9°N. Writing the local square instead would land at 0°/0°.
    expect(lon).toBeGreaterThan(10);
    expect(lon).toBeLessThan(20);
    expect(lat).toBeGreaterThan(30);
    expect(lat).toBeLessThan(36);
  });

  it('carries no `crs` member, which RFC 7946 removed', () => {
    const toLonLat = makeLocalToLonLat(
      { kind: 'projected', epsg: 32633, name: 'UTM 33N' } as never, [523000, 3642000, 0],
    )!;
    const gj = acceptedFootprintGeoJson([localSquare('a')], review, 'EPSG:32633', toLonLat)!;
    expect(Object.keys(gj.metadata)).not.toContain('crs');
    expect(gj.metadata.note).toMatch(/WGS 84 longitude\/latitude/);
  });
});
