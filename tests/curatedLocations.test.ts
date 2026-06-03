/**
 * curatedLocations.test.ts
 *
 * Sanity checks on the curated-locations dataset so a copy-paste typo
 * in a bbox or id can't ship without a failing test.
 */

import { describe, it, expect } from 'vitest';
import {
  CURATED_LOCATIONS,
  getCuratedLocation,
} from '../src/io/catalog/curatedLocations';

describe('curated locations dataset', () => {
  it('ships at least one option', () => {
    expect(CURATED_LOCATIONS.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = CURATED_LOCATIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(CURATED_LOCATIONS)('$id has a non-empty label, sizeLabel, hint, and displayName', (loc) => {
    expect(loc.label.length).toBeGreaterThan(0);
    expect(loc.sizeLabel.length).toBeGreaterThan(0);
    expect(loc.hint.length).toBeGreaterThan(0);
    expect(loc.displayName.length).toBeGreaterThan(0);
  });

  it.each(CURATED_LOCATIONS)('$id sizeLabel matches a recognised pattern', (loc) => {
    // Allowed shapes: "77 MB", "1.8 GB", "22.4B pts" — keep the
    // user-facing format consistent so the dropdown reads uniformly.
    expect(loc.sizeLabel).toMatch(/^[\d.]+\s*(MB|GB|[KMBT]B?\s+pts)$/);
  });

  it.each(CURATED_LOCATIONS)('$id has a well-formed lat/lon bbox', (loc) => {
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    expect(Number.isFinite(minLon)).toBe(true);
    expect(Number.isFinite(minLat)).toBe(true);
    expect(Number.isFinite(maxLon)).toBe(true);
    expect(Number.isFinite(maxLat)).toBe(true);
    expect(minLon).toBeLessThan(maxLon);
    expect(minLat).toBeLessThan(maxLat);
    // US locations only — catch a missing negative sign on a US longitude.
    expect(minLat).toBeGreaterThan(-90);
    expect(maxLat).toBeLessThan(90);
    expect(minLon).toBeGreaterThan(-180);
    expect(maxLon).toBeLessThan(180);
  });

  it.each(CURATED_LOCATIONS)('$id has a non-degenerate bbox (>=100m)', (loc) => {
    const [minLon, minLat, maxLon, maxLat] = loc.bbox;
    // At US mid-latitudes, 0.001 deg lat ~= 111 m, lon similar at 45°.
    expect(maxLon - minLon).toBeGreaterThan(0.001);
    expect(maxLat - minLat).toBeGreaterThan(0.001);
  });
});

describe('getCuratedLocation', () => {
  it('returns the matching entry for a known id', () => {
    const loc = getCuratedLocation(CURATED_LOCATIONS[0].id);
    expect(loc).toBeDefined();
    expect(loc?.id).toBe(CURATED_LOCATIONS[0].id);
  });

  it('returns undefined for an unknown id', () => {
    expect(getCuratedLocation('not-a-real-location')).toBeUndefined();
  });
});
