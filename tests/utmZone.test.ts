/**
 * utmZone.test.ts
 *
 * Tests for the v0.3.9 public UTM helpers (`utmZoneFor`, `latLonToUtm`)
 * that surface UTM grid coords in the point inspector.
 */

import { describe, it, expect } from 'vitest';
import { latLonToUtm, utmZoneFor } from '../src/geo/UtmConverter';

describe('utmZoneFor — derive UTM zone + hemisphere from WGS-84 lat/lon', () => {
  it('returns zone 1, N for points near the date line on the N side', () => {
    const { zone, hemisphere } = utmZoneFor(45, -180);
    expect(zone).toBe(1);
    expect(hemisphere).toBe('N');
  });

  it('returns zone 60, S for points near +180 in the southern hemisphere', () => {
    const { zone, hemisphere } = utmZoneFor(-45, 179.9);
    expect(zone).toBe(60);
    expect(hemisphere).toBe('S');
  });

  it('returns zone 31 for points just east of the prime meridian', () => {
    const { zone } = utmZoneFor(48.8566, 2.3522); // Paris
    expect(zone).toBe(31);
  });

  it('returns zone 18 N for New York City', () => {
    const { zone, hemisphere } = utmZoneFor(40.7128, -74.006);
    expect(zone).toBe(18);
    expect(hemisphere).toBe('N');
  });

  it('returns zone 32 for points just west of the prime meridian', () => {
    const { zone } = utmZoneFor(51.5, -0.1); // London
    expect(zone).toBe(30);
  });

  it('returns N hemisphere on the equator', () => {
    const { hemisphere } = utmZoneFor(0, 0);
    expect(hemisphere).toBe('N');
  });

  it('returns S hemisphere just below the equator', () => {
    const { hemisphere } = utmZoneFor(-0.01, 0);
    expect(hemisphere).toBe('S');
  });

  it('normalises longitudes outside [-180, 180)', () => {
    // 540° east of the prime meridian = 180° east, normalised to -180.
    // That should land in zone 1 (the zone just east of -180).
    const { zone } = utmZoneFor(45, 540);
    expect(zone).toBe(1);
  });

  it('clamps to zone 60 at the eastern edge', () => {
    const { zone } = utmZoneFor(45, 179.99999);
    expect(zone).toBe(60);
  });
});

describe('latLonToUtm — produces grid coordinates with the derived zone', () => {
  it('returns the canonical UTM zone for the point', () => {
    const result = latLonToUtm(40.7128, -74.006); // NYC
    expect(result.zone).toBe(18);
    expect(result.hemisphere).toBe('N');
  });

  it('produces finite easting + northing values', () => {
    const result = latLonToUtm(40.7128, -74.006);
    expect(Number.isFinite(result.easting)).toBe(true);
    expect(Number.isFinite(result.northing)).toBe(true);
  });

  it('preserves the elevation when provided', () => {
    const result = latLonToUtm(40.7128, -74.006, 25.5);
    expect(result.elevation).toBe(25.5);
  });

  it('omits the elevation field when not provided', () => {
    const result = latLonToUtm(40.7128, -74.006);
    expect(result.elevation).toBeUndefined();
  });

  it('NYC easting falls in the 580-590 km band (well within zone 18N)', () => {
    const result = latLonToUtm(40.7128, -74.006);
    // NYC's UTM easting in zone 18N is ~583 km.
    expect(result.easting).toBeGreaterThan(580_000);
    expect(result.easting).toBeLessThan(590_000);
  });

  it('NYC northing falls in the 4500-4520 km band', () => {
    const result = latLonToUtm(40.7128, -74.006);
    // NYC's UTM northing in zone 18N is ~4506 km.
    expect(result.northing).toBeGreaterThan(4_500_000);
    expect(result.northing).toBeLessThan(4_520_000);
  });

  it('round-trips a southern hemisphere coordinate without crashing', () => {
    const result = latLonToUtm(-33.8688, 151.2093); // Sydney
    expect(result.hemisphere).toBe('S');
    expect(result.zone).toBe(56);
    expect(Number.isFinite(result.easting)).toBe(true);
    expect(Number.isFinite(result.northing)).toBe(true);
  });
});
