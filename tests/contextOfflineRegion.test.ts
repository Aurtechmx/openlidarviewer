/**
 * contextOfflineRegion.test.ts
 *
 * Pins the pure offline-region model: the slippy-map tile arithmetic and the
 * validation that refuses a region before anything acts on it.
 *
 * The arithmetic is worth pinning because it is the number a user would decide
 * on: an estimate that under-counts turns "this is a small download" into a
 * surprise, and one that silently returns a number for an inside-out box turns
 * nonsense into a plausible-looking budget. The validation is worth pinning
 * because it is the only thing standing between a mistyped bounding box and a
 * continent-sized request — and because it must refuse without throwing, since
 * a crash in a region editor is not a refusal the user can act on.
 *
 * Expected tile counts here are hand-computed from the standard slippy-map
 * formulas, not copied from the implementation: the whole world is 1 tile at
 * z0, 4 at z1, and 4^z at zoom z, so zooms 0..n sum to (4^(n+1) - 1) / 3.
 *
 * Nothing in this file, or in the module it tests, performs a download.
 */

import { describe, it, expect } from 'vitest';
import {
  estimateRegionTileCount,
  validateOfflineRegion,
  OFFLINE_REGION_PROBLEM,
  OFFLINE_REGION_TILE_CEILING,
  WEB_MERCATOR_MAX_LATITUDE_DEG,
  MAX_TILE_ZOOM_LEVEL,
  DEFAULT_PROVIDER_MAX_ZOOM,
  type OfflineRegion,
  type OfflineRegionBbox,
} from '../src/geo/context/offlineRegion';
import { OSM_PROVIDER } from '../src/geo/context/providerInterface';

/** The mercator-limited whole world: the reference shape for the tile maths. */
const WHOLE_WORLD: OfflineRegionBbox = {
  west: -180,
  south: -WEB_MERCATOR_MAX_LATITUDE_DEG,
  east: 180,
  north: WEB_MERCATOR_MAX_LATITUDE_DEG,
};

/** A small, unremarkable, entirely valid region: the baseline every case edits. */
const BASELINE: OfflineRegion = {
  id: 'region-1',
  name: 'Site',
  bbox: { west: -0.2, south: 51.4, east: -0.18, north: 51.42 },
  minZoom: 0,
  maxZoom: 16,
};

/** Build a region from the baseline with the given fields replaced. */
function region(patch: Partial<OfflineRegion>): OfflineRegion {
  return { ...BASELINE, ...patch };
}

/** A world-covering region over one inclusive zoom range. */
function world(minZoom: number, maxZoom: number): OfflineRegion {
  return { id: 'world', name: 'World', bbox: WHOLE_WORLD, minZoom, maxZoom };
}

/** Tiles in zooms 0..n of a full world: (4^(n+1) - 1) / 3. */
function worldPyramid(deepest: number): number {
  return (4 ** (deepest + 1) - 1) / 3;
}

describe('estimateRegionTileCount — known tile counts', () => {
  it('the whole world is exactly 1 tile at zoom 0', () => {
    expect(estimateRegionTileCount(world(0, 0))).toBe(1);
  });

  it('the whole world is exactly 4 tiles at zoom 1', () => {
    expect(estimateRegionTileCount(world(1, 1))).toBe(4);
  });

  it('the whole world is 4^z tiles at every zoom from 0 to 7', () => {
    for (let z = 0; z <= 7; z += 1) {
      expect(estimateRegionTileCount(world(z, z))).toBe(4 ** z);
    }
  });

  it('sums inclusively across a zoom range (z0..z1 = 1 + 4 = 5)', () => {
    expect(estimateRegionTileCount(world(0, 1))).toBe(5);
  });

  it('sums a mid range without the shallow levels (z3..z5 = 64 + 256 + 1024)', () => {
    expect(estimateRegionTileCount(world(3, 5))).toBe(1344);
  });

  it('matches the closed-form pyramid sum for the whole world, zooms 0..7', () => {
    expect(estimateRegionTileCount(world(0, 7))).toBe(21_845);
    expect(estimateRegionTileCount(world(0, 7))).toBe(worldPyramid(7));
  });

  it('matches the closed-form pyramid sum for the whole world, zooms 0..8', () => {
    expect(estimateRegionTileCount(world(0, 8))).toBe(87_381);
    expect(estimateRegionTileCount(world(0, 8))).toBe(worldPyramid(8));
  });

  it('each deeper world zoom costs exactly four times the one above it', () => {
    for (let z = 0; z <= 6; z += 1) {
      expect(estimateRegionTileCount(world(z + 1, z + 1))).toBe(
        4 * estimateRegionTileCount(world(z, z)),
      );
    }
  });

  it('a box inside a single tile costs one tile per zoom level', () => {
    const tiny = region({ bbox: { west: 1, south: 1, east: 2, north: 2 }, minZoom: 0, maxZoom: 3 });
    expect(estimateRegionTileCount(tiny)).toBe(4);
    expect(estimateRegionTileCount({ ...tiny, minZoom: 1, maxZoom: 1 })).toBe(1);
  });

  it('is deterministic — the same region twice gives the same number', () => {
    const r = region({ maxZoom: 12 });
    expect(estimateRegionTileCount(r)).toBe(estimateRegionTileCount(r));
  });
});

describe('estimateRegionTileCount — grid edges', () => {
  it('counts a tile the box only grazes, so it over-counts rather than under', () => {
    // The western half of the world at z1: the east edge lies exactly on the
    // lon 0 tile boundary, so the eastern column is touched and counted too.
    const westHalf = region({
      bbox: { ...WHOLE_WORLD, east: 0 },
      minZoom: 1,
      maxZoom: 1,
    });
    expect(estimateRegionTileCount(westHalf)).toBe(4);
  });

  it('clamps at the antimeridian instead of indexing off the end of the grid', () => {
    const eastEdge = region({
      bbox: { ...WHOLE_WORLD, west: 179 },
      minZoom: 1,
      maxZoom: 1,
    });
    // One column (the last), both rows — not a third column past the edge.
    expect(estimateRegionTileCount(eastEdge)).toBe(2);
  });

  it('accepts the mercator latitude limit exactly and still spans the full grid', () => {
    // At z8 the world is 256 rows; the limit rows are 0 and 255, not off-grid.
    expect(estimateRegionTileCount(world(8, 8))).toBe(65_536);
  });

  it('a north-south sliver at the mercator limit is a single row', () => {
    const sliver = region({
      bbox: {
        west: 0,
        south: WEB_MERCATOR_MAX_LATITUDE_DEG - 0.0001,
        east: 1,
        north: WEB_MERCATOR_MAX_LATITUDE_DEG,
      },
      minZoom: 2,
      maxZoom: 2,
    });
    expect(estimateRegionTileCount(sliver)).toBe(1);
  });
});

describe('estimateRegionTileCount — refuses to compute nonsense', () => {
  it('throws a TypeError naming "region" for a non-finite bbox', () => {
    const bad = region({ bbox: { ...BASELINE.bbox, north: Number.NaN } });
    expect(() => estimateRegionTileCount(bad)).toThrowError(TypeError);
    expect(() => estimateRegionTileCount(bad)).toThrowError(/"region"/);
  });

  it('throws rather than returning a negative or zero count for an inverted bbox', () => {
    expect(() =>
      estimateRegionTileCount(region({ bbox: { west: 10, south: 1, east: 5, north: 2 } })),
    ).toThrowError(TypeError);
    expect(() =>
      estimateRegionTileCount(region({ bbox: { west: 1, south: 10, east: 2, north: 5 } })),
    ).toThrowError(TypeError);
  });

  it('throws for a non-integer zoom — a tile pyramid has no level 1.5', () => {
    expect(() => estimateRegionTileCount(region({ minZoom: 1.5 }))).toThrowError(TypeError);
  });

  it('throws for an inverted zoom range', () => {
    expect(() => estimateRegionTileCount(region({ minZoom: 10, maxZoom: 3 }))).toThrowError(
      TypeError,
    );
  });

  it('throws for a zoom beyond the grid bound, so the summation cannot run away', () => {
    expect(() =>
      estimateRegionTileCount(region({ maxZoom: MAX_TILE_ZOOM_LEVEL + 1 })),
    ).toThrowError(TypeError);
    expect(() => estimateRegionTileCount(region({ minZoom: -1 }))).toThrowError(TypeError);
  });
});

describe('validateOfflineRegion — accepts what it should', () => {
  it('accepts an ordinary small region', () => {
    expect(validateOfflineRegion(BASELINE)).toEqual({ ok: true });
  });

  it('accepts a single-zoom region', () => {
    expect(validateOfflineRegion(region({ minZoom: 14, maxZoom: 14 }))).toEqual({ ok: true });
  });

  it('accepts the mercator latitude limit exactly, north and south', () => {
    const atLimit = region({
      bbox: {
        west: -1,
        south: -WEB_MERCATOR_MAX_LATITUDE_DEG,
        east: 1,
        north: WEB_MERCATOR_MAX_LATITUDE_DEG,
      },
      minZoom: 0,
      maxZoom: 6,
    });
    expect(validateOfflineRegion(atLimit)).toEqual({ ok: true });
  });

  it('accepts longitudes at exactly ±180', () => {
    expect(validateOfflineRegion(world(0, 4))).toEqual({ ok: true });
  });

  it('accepts the whole world down to zoom 7 — under the ceiling by design', () => {
    expect(estimateRegionTileCount(world(0, 7))).toBeLessThanOrEqual(OFFLINE_REGION_TILE_CEILING);
    expect(validateOfflineRegion(world(0, 7))).toEqual({ ok: true });
  });
});

describe('validateOfflineRegion — every refusal', () => {
  it('refuses a longitude beyond ±180', () => {
    const r = validateOfflineRegion(region({ bbox: { ...BASELINE.bbox, east: 180.0001 } }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.lonOutOfRange] });
  });

  it('refuses a latitude beyond the web-mercator limit', () => {
    const north = validateOfflineRegion(
      region({ bbox: { ...BASELINE.bbox, north: WEB_MERCATOR_MAX_LATITUDE_DEG + 0.0001 } }),
    );
    expect(north).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.latOutOfRange] });
    const south = validateOfflineRegion(
      region({
        bbox: { ...BASELINE.bbox, south: -WEB_MERCATOR_MAX_LATITUDE_DEG - 0.0001, north: 80 },
      }),
    );
    expect(south).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.latOutOfRange] });
  });

  it('refuses a latitude at the pole, which the tile grid cannot represent', () => {
    const r = validateOfflineRegion(region({ bbox: { ...BASELINE.bbox, north: 90 } }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.latOutOfRange] });
  });

  it('refuses a non-finite bbox value without throwing', () => {
    for (const bad of [Number.NaN, Infinity, -Infinity]) {
      const r = validateOfflineRegion(region({ bbox: { ...BASELINE.bbox, west: bad } }));
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error('expected a refusal');
      expect(r.problems).toContain(OFFLINE_REGION_PROBLEM.lonOutOfRange);
    }
  });

  it('refuses an inverted longitude span (west east of east)', () => {
    const r = validateOfflineRegion(region({ bbox: { west: 10, south: 1, east: 5, north: 2 } }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.bboxInvertedLon] });
  });

  it('refuses a zero-width box — a line is not a region', () => {
    const r = validateOfflineRegion(region({ bbox: { west: 5, south: 1, east: 5, north: 2 } }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.bboxInvertedLon] });
  });

  it('refuses an inverted latitude span, and a zero-height box', () => {
    const inverted = validateOfflineRegion(
      region({ bbox: { west: 1, south: 10, east: 2, north: 5 } }),
    );
    expect(inverted).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.bboxInvertedLat] });
    const flat = validateOfflineRegion(region({ bbox: { west: 1, south: 5, east: 2, north: 5 } }));
    expect(flat).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.bboxInvertedLat] });
  });

  it('refuses a non-integer zoom', () => {
    const r = validateOfflineRegion(region({ maxZoom: 12.5 }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomNotWhole] });
  });

  it('refuses a negative zoom', () => {
    const r = validateOfflineRegion(region({ minZoom: -1 }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomNotWhole] });
  });

  it('refuses a zoom past the grid bound, and accepts the bound itself', () => {
    const past = validateOfflineRegion(
      region({ minZoom: MAX_TILE_ZOOM_LEVEL + 1, maxZoom: MAX_TILE_ZOOM_LEVEL + 1 }),
    );
    expect(past.ok).toBe(false);
    if (past.ok) throw new Error('expected a refusal');
    expect(past.problems).toContain(OFFLINE_REGION_PROBLEM.zoomNotWhole);
    // The bound itself is a real zoom level: with a provider that served it,
    // the only complaint left is its size, not its existence.
    const atBound = validateOfflineRegion(
      region({ minZoom: MAX_TILE_ZOOM_LEVEL, maxZoom: MAX_TILE_ZOOM_LEVEL }),
      MAX_TILE_ZOOM_LEVEL,
    );
    expect(atBound).toEqual({
      ok: false,
      problems: [OFFLINE_REGION_PROBLEM.tileCountAboveCeiling],
    });
  });

  it('refuses an inverted zoom range', () => {
    const r = validateOfflineRegion(region({ minZoom: 10, maxZoom: 3 }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomInverted] });
  });

  it('refuses a zoom deeper than the provider publishes', () => {
    const r = validateOfflineRegion(region({ maxZoom: DEFAULT_PROVIDER_MAX_ZOOM + 1 }));
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomAboveProviderMax] });
  });

  it('honours an explicitly supplied provider maximum', () => {
    expect(validateOfflineRegion(region({ maxZoom: 12 }), 12)).toEqual({ ok: true });
    const r = validateOfflineRegion(region({ maxZoom: 13 }), 12);
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomAboveProviderMax] });
  });

  it('throws a TypeError naming "providerMaxZoom" when that argument is not finite', () => {
    expect(() => validateOfflineRegion(BASELINE, Number.NaN)).toThrowError(TypeError);
    expect(() => validateOfflineRegion(BASELINE, Number.NaN)).toThrowError(/"providerMaxZoom"/);
  });
});

describe('validateOfflineRegion — the ceiling guard', () => {
  it('refuses a region whose tile count exceeds the ceiling', () => {
    const tooBig = world(0, 8);
    expect(estimateRegionTileCount(tooBig)).toBeGreaterThan(OFFLINE_REGION_TILE_CEILING);
    expect(validateOfflineRegion(tooBig)).toEqual({
      ok: false,
      problems: [OFFLINE_REGION_PROBLEM.tileCountAboveCeiling],
    });
  });

  it('brackets the ceiling exactly where the numbers say: world z0..z7 in, z0..z8 out', () => {
    expect(validateOfflineRegion(world(0, 7))).toEqual({ ok: true });
    expect(validateOfflineRegion(world(0, 8)).ok).toBe(false);
  });

  it('refuses a continent-scale region — the case the ceiling exists for', () => {
    const europe = region({
      bbox: { west: -10, south: 35, east: 50, north: 70 },
      minZoom: 0,
      maxZoom: 10,
    });
    const r = validateOfflineRegion(europe);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.problems).toContain(OFFLINE_REGION_PROBLEM.tileCountAboveCeiling);
  });

  it('does not apply the ceiling to a structurally broken region', () => {
    // An inverted world box at every zoom would "cost" nothing computable; the
    // refusal must name the inversion rather than invent a size for it.
    const broken = region({
      bbox: { west: 180, south: -80, east: -180, north: 80 },
      minZoom: 0,
      maxZoom: 20,
    });
    const r = validateOfflineRegion(broken);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('expected a refusal');
    expect(r.problems).toContain(OFFLINE_REGION_PROBLEM.bboxInvertedLon);
    expect(r.problems).not.toContain(OFFLINE_REGION_PROBLEM.tileCountAboveCeiling);
  });

  it('still reports the size of a sound region that also asks for too deep a zoom', () => {
    // Deeper than the provider serves, but small: exactly one problem.
    const deep = validateOfflineRegion(region({ maxZoom: 20 }));
    expect(deep).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.zoomAboveProviderMax] });
    // Deeper than the provider serves AND enormous: both problems, in order.
    const huge = validateOfflineRegion(world(0, 20));
    expect(huge).toEqual({
      ok: false,
      problems: [
        OFFLINE_REGION_PROBLEM.zoomAboveProviderMax,
        OFFLINE_REGION_PROBLEM.tileCountAboveCeiling,
      ],
    });
  });
});

describe('validateOfflineRegion — problem collection', () => {
  it('collects every problem in a fixed order rather than stopping at the first', () => {
    const r = validateOfflineRegion(
      region({ bbox: { west: 10, south: 10, east: 5, north: 5 }, minZoom: 8, maxZoom: 3 }),
    );
    expect(r).toEqual({
      ok: false,
      problems: [
        OFFLINE_REGION_PROBLEM.bboxInvertedLon,
        OFFLINE_REGION_PROBLEM.bboxInvertedLat,
        OFFLINE_REGION_PROBLEM.zoomInverted,
      ],
    });
  });

  it('does not pile an ordering complaint onto values it already called unusable', () => {
    const r = validateOfflineRegion(
      region({ bbox: { west: Number.NaN, south: 1, east: 5, north: 2 } }),
    );
    expect(r).toEqual({ ok: false, problems: [OFFLINE_REGION_PROBLEM.lonOutOfRange] });
  });

  it('reports range and zoom problems together for a wholly bad region', () => {
    const r = validateOfflineRegion(
      region({
        bbox: { west: Number.NaN, south: 200, east: 400, north: Infinity },
        minZoom: -3,
        maxZoom: 99,
      }),
    );
    expect(r).toEqual({
      ok: false,
      problems: [
        OFFLINE_REGION_PROBLEM.lonOutOfRange,
        OFFLINE_REGION_PROBLEM.latOutOfRange,
        OFFLINE_REGION_PROBLEM.zoomNotWhole,
      ],
    });
  });

  it('never throws for any numeric garbage a region can carry', () => {
    const garbage: readonly number[] = [
      Number.NaN,
      Infinity,
      -Infinity,
      -0,
      1e308,
      -1e308,
      0.1 + 0.2,
    ];
    for (const value of garbage) {
      expect(() =>
        validateOfflineRegion(
          region({
            bbox: { west: value, south: value, east: value, north: value },
            minZoom: value,
            maxZoom: value,
          }),
        ),
      ).not.toThrow();
    }
  });
});

describe('offline region constants', () => {
  it('the tile ceiling is a positive whole number', () => {
    expect(Number.isInteger(OFFLINE_REGION_TILE_CEILING)).toBe(true);
    expect(OFFLINE_REGION_TILE_CEILING).toBeGreaterThan(0);
  });

  it('the mercator latitude constant sits just inside the true limit', () => {
    const exact = (180 / Math.PI) * Math.atan(Math.sinh(Math.PI));
    expect(WEB_MERCATOR_MAX_LATITUDE_DEG).toBeLessThan(exact);
    expect(exact - WEB_MERCATOR_MAX_LATITUDE_DEG).toBeLessThan(0.001);
  });

  it('the default provider maximum is read from the provider descriptor, not retyped', () => {
    expect(DEFAULT_PROVIDER_MAX_ZOOM).toBe(OSM_PROVIDER.maxZoom);
  });

  it('the grid bound is deeper than any provider this build describes', () => {
    expect(MAX_TILE_ZOOM_LEVEL).toBeGreaterThan(OSM_PROVIDER.maxZoom);
  });

  it('the problem strings quote the same limits the constants enforce', () => {
    // Prose that names a number can drift from the number it describes; these
    // two assertions are the only thing keeping the message honest.
    expect(OFFLINE_REGION_PROBLEM.zoomNotWhole).toContain(String(MAX_TILE_ZOOM_LEVEL));
    expect(OFFLINE_REGION_PROBLEM.latOutOfRange).toContain(
      String(WEB_MERCATOR_MAX_LATITUDE_DEG),
    );
  });

  it('every problem string is distinct, non-empty prose', () => {
    const values = Object.values(OFFLINE_REGION_PROBLEM);
    for (const value of values) {
      expect(typeof value).toBe('string');
      expect(value.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(values).size).toBe(values.length);
  });

  it('the problem vocabulary is frozen — it cannot be mutated at runtime', () => {
    expect(Object.isFrozen(OFFLINE_REGION_PROBLEM)).toBe(true);
  });

  it('no problem string promises a download or claims a provider permits one', () => {
    for (const value of Object.values(OFFLINE_REGION_PROBLEM)) {
      expect(value.toLowerCase()).not.toContain('will download');
      expect(value.toLowerCase()).not.toContain('allowed to download');
    }
  });
});
