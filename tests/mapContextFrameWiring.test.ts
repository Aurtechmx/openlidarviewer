/**
 * The two lon/lat converters the map context hands out, and the frame each one
 * ACCEPTS.
 *
 * `footprintGeoreferenceDomain.test.ts` proved the MAPPER is correct. It could
 * not prove the WIRING was, because it called `makeLocalToLonLat` directly while
 * production handed feature extraction a wrapper built for contours:
 *
 *     world = (p) => local([p - origin])      // correct for contours
 *     local(q) = project(q + origin)
 *     world(localPoint) = project(localPoint - origin + origin) = project(local)
 *
 * The origin cancelled, so every building footprint was reprojected from its
 * raw render-local coordinate — the projection origin, not the site. The file
 * was valid GeoJSON with plausible coordinates, which is why nothing caught it.
 *
 * This reconstructs the exact composition `main.ts:getMapContext` performs and
 * checks each converter against the frame its caller actually supplies.
 */
import { describe, it, expect } from 'vitest';
import { makeLocalToLonLat } from '../src/export/lonLatMapper';
import type { ResolvedCrs } from '../src/geo/CoordinateTypes';

const UTM33: ResolvedCrs = {
  kind: 'projected', name: 'WGS 84 / UTM zone 33N', epsg: 32633,
  linearUnit: 'metre', linearUnitToMetres: 1, source: 'wkt',
  confidence: 'high', userConfirmed: true,
} as unknown as ResolvedCrs;

/** A site far from the projection origin — where the defect is catastrophic. */
const ORIGIN: readonly [number, number, number] = [523000, 3642000, 0];

/** The exact pair `getMapContext` builds. */
function mapContextConverters(crs: ResolvedCrs, origin: readonly [number, number, number]) {
  const local = makeLocalToLonLat(crs, [origin[0], origin[1], origin[2]]);
  if (!local) return null;
  const world = (p: readonly [number, number, number]): [number, number, number] =>
    local([p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]);
  return { local, world };
}

describe('map-context converters are frame-specific', () => {
  const c = mapContextConverters(UTM33, ORIGIN)!;

  it('the pair is buildable for a UTM site', () => {
    expect(c).not.toBeNull();
  });

  it('the LOCAL converter places a render-local point at the site', () => {
    // What feature extraction supplies: coordinates about zero.
    const [lon, lat] = c.local([10, 10, 0]);
    expect(lon).toBeGreaterThan(10); expect(lon).toBeLessThan(20);
    expect(lat).toBeGreaterThan(30); expect(lat).toBeLessThan(36);
  });

  it('the WORLD converter places an origin-restored point at the same site', () => {
    // What contour serialization supplies: already shifted to world.
    const [lon, lat] = c.world([ORIGIN[0] + 10, ORIGIN[1] + 10, 0]);
    const [lonL, latL] = c.local([10, 10, 0]);
    expect(lon).toBeCloseTo(lonL, 12);
    expect(lat).toBeCloseTo(latL, 12);
  });

  it('THE REGRESSION, on a UTM site: the world converter rejects local input', () => {
    // UTM has a grid-range guard, so here the defect surfaced as a throw from
    // inside a click handler rather than a wrong file. Still a broken export,
    // and still the wrong converter.
    expect(() => c.world([10, 10, 0])).toThrow(/outside the UTM grid range/);
  });

  it('the two converters are NOT interchangeable, so the names must stay distinct', () => {
    // Each rejects the other's input on this UTM site: the local converter
    // double-adds the origin, the world converter cancels it away. One name
    // serving both callers was a defect waiting to happen.
    const worldPoint: readonly [number, number, number] = [ORIGIN[0] + 10, ORIGIN[1] + 10, 0];
    expect(() => c.local(worldPoint)).toThrow(/outside the UTM grid range/);
    expect(() => c.world([10, 10, 0])).toThrow(/outside the UTM grid range/);
  });
});

describe('THE REGRESSION is silent on a geographic frame', () => {
  // The geographic branch is a plain origin shift with no range guard, so the
  // cancelled origin produced a well-formed lon/lat pair that is simply wrong.
  // Nothing threw, nothing warned, and the file validates.
  const GEO: ResolvedCrs = {
    kind: 'geographic', name: 'WGS 84', epsg: 4326, linearUnit: 'degree',
    linearUnitToMetres: 1, source: 'wkt', confidence: 'high', userConfirmed: true,
  } as unknown as ResolvedCrs;
  // A site in Norway, expressed as a degree-frame origin.
  const GEO_ORIGIN: readonly [number, number, number] = [10.75, 59.91, 0];
  const g = mapContextConverters(GEO, GEO_ORIGIN)!;

  it('the local converter puts the feature at the site', () => {
    const [lon, lat] = g.local([0.001, 0.001, 0]);
    expect(lon).toBeCloseTo(10.751, 6);
    expect(lat).toBeCloseTo(59.911, 6);
  });

  it('the world converter silently returns the raw local offset as a position', () => {
    const [lon, lat] = g.world([0.001, 0.001, 0]);
    // Off the coast of Africa, ~6,600 km from the site — and a perfectly valid
    // coordinate that no downstream check can reject.
    expect(lon).toBeCloseTo(0.001, 9);
    expect(lat).toBeCloseTo(0.001, 9);
    expect(Number.isFinite(lon) && Number.isFinite(lat)).toBe(true);
  });
});
