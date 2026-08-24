/**
 * spatialFrame.test.ts
 *
 * The source-to-render conversion, in both forms OLV needs.
 *
 * The translated frame must be arithmetically identical to the `p ± origin` its
 * consumers perform today, not merely close: a frame that rounded differently
 * would move every measured coordinate in the app by a rounding step for no
 * reason a reader could see. The ENU frame must place east, north and up where
 * the ellipsoid puts them, must round-trip a geocentric coordinate back to
 * itself, and must keep millimetre spacing that a Float32 cast at the wrong
 * point in the chain destroys.
 */

import { describe, it, expect } from 'vitest';
import {
  createTranslatedFrame,
  createLocalEnuFrame,
  ecefToGeodeticAngles,
  WGS84_A,
  WGS84_INV_F,
  type Vec3,
} from '../src/geo/frame/spatialFrame';

const D2R = Math.PI / 180;

/** Geodetic to ECEF, the independent direction, so a round trip is not circular. */
function geodeticToEcef(latDeg: number, lonDeg: number, height: number): Vec3 {
  const f = 1 / WGS84_INV_F;
  const e2 = f * (2 - f);
  const lat = latDeg * D2R, lon = lonDeg * D2R;
  const s = Math.sin(lat), c = Math.cos(lat);
  const n = WGS84_A / Math.sqrt(1 - e2 * s * s);
  return [
    (n + height) * c * Math.cos(lon),
    (n + height) * c * Math.sin(lon),
    (n * (1 - e2) + height) * s,
  ];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

describe('translated-cartesian frame', () => {
  const ORIGIN: Vec3 = [512345, 4207891, 137];

  it('produces exactly what adding and subtracting the origin produces', () => {
    const frame = createTranslatedFrame(ORIGIN);
    for (const p of [
      [512345.001, 4207891.002, 137.003],
      [0, 0, 0],
      [-1e6, 7.5e6, -412.25],
      [512345 + 1e-7, 4207891 - 1e-7, 137],
    ] as Vec3[]) {
      expect(frame.sourceToRenderPoint(p)).toEqual([
        p[0] - ORIGIN[0], p[1] - ORIGIN[1], p[2] - ORIGIN[2],
      ]);
      expect(frame.renderToSourcePoint(p)).toEqual([
        p[0] + ORIGIN[0], p[1] + ORIGIN[1], p[2] + ORIGIN[2],
      ]);
    }
  });

  it('round-trips a source coordinate to the same double', () => {
    const frame = createTranslatedFrame(ORIGIN);
    const p: Vec3 = [512345.123456789, 4207891.987654321, 137.5];
    expect(frame.renderToSourcePoint(frame.sourceToRenderPoint(p))).toEqual([...p]);
  });

  it('leaves a vector alone, so a normal picks up no translation', () => {
    const frame = createTranslatedFrame(ORIGIN);
    expect(frame.sourceVectorToRender([0, 0, 1])).toEqual([0, 0, 1]);
    expect(frame.renderVectorToSource([3, -4, 12])).toEqual([3, -4, 12]);
  });

  it('reports Z-up by default and the axis it was given otherwise', () => {
    expect(createTranslatedFrame(ORIGIN).renderWorldUp()).toEqual([0, 0, 1]);
    expect(createTranslatedFrame(ORIGIN, [0, 1, 0]).renderWorldUp()).toEqual([0, 1, 0]);
    expect(createTranslatedFrame(ORIGIN, [0, 0, 5]).renderWorldUp()).toEqual([0, 0, 1]);
  });

  it('falls back to Z-up rather than emitting NaN for a degenerate axis', () => {
    expect(createTranslatedFrame(ORIGIN, [0, 0, 0]).renderWorldUp()).toEqual([0, 0, 1]);
    expect(createTranslatedFrame(ORIGIN, [NaN, 0, 1]).renderWorldUp()).toEqual([0, 0, 1]);
  });

  it('says it is translation only, so a direct adder may keep adding', () => {
    expect(createTranslatedFrame(ORIGIN).isTranslationOnly).toBe(true);
  });
});

describe('ecefToGeodeticAngles', () => {
  const CASES: readonly (readonly [number, number, number])[] = [
    [0, 0, 0],
    [0, 180, 0],
    [45.5, -122.6, 60],
    [-33.87, 151.21, 25],
    [78.22, 15.65, 400],
    [89.999, 0, 0],
    [-89.999, 90, 0],
    [51.4778, -0.0015, 45.2],
  ];

  it('recovers the latitude and longitude a position was built from', () => {
    for (const [lat, lon, h] of CASES) {
      const got = ecefToGeodeticAngles(geodeticToEcef(lat, lon, h));
      expect(got.lat / D2R).toBeCloseTo(lat, 9);
      // Longitude at ±180 wraps; compare through the unit circle.
      expect(Math.cos(got.lon)).toBeCloseTo(Math.cos(lon * D2R), 12);
      expect(Math.sin(got.lon)).toBeCloseTo(Math.sin(lon * D2R), 12);
    }
  });

  it('resolves the pole without dividing by zero', () => {
    const north = ecefToGeodeticAngles([0, 0, 6356752.314245]);
    expect(north.lat / D2R).toBeCloseTo(90, 9);
    expect(Number.isFinite(north.lon)).toBe(true);
  });
});

describe('local ENU frame', () => {
  it('puts the anchor at render zero', () => {
    const anchor = geodeticToEcef(45.5, -122.6, 60);
    const frame = createLocalEnuFrame(anchor);
    const r = frame.sourceToRenderPoint(anchor);
    expect(Math.hypot(r[0], r[1], r[2])).toBeLessThan(1e-9);
  });

  it('reports render up as local +Z', () => {
    expect(createLocalEnuFrame(geodeticToEcef(45.5, -122.6, 60)).renderWorldUp())
      .toEqual([0, 0, 1]);
  });

  it('maps a metre of geodetic height onto render +Z alone', () => {
    for (const [lat, lon] of [[0, 0], [45.5, -122.6], [-33.87, 151.21], [78.22, 15.65]]) {
      const frame = createLocalEnuFrame(geodeticToEcef(lat, lon, 0));
      const up = frame.sourceToRenderPoint(geodeticToEcef(lat, lon, 1));
      expect(up[0]).toBeCloseTo(0, 6);
      expect(up[1]).toBeCloseTo(0, 6);
      expect(up[2]).toBeCloseTo(1, 6);
    }
  });

  it('sends north toward render +Y and east toward render +X', () => {
    const lat = 45.5, lon = -122.6;
    const frame = createLocalEnuFrame(geodeticToEcef(lat, lon, 0));
    // A hundred metres of latitude is about 0.0009 degrees; the exact figure
    // does not matter, only which render axis it lands on.
    const north = frame.sourceToRenderPoint(geodeticToEcef(lat + 0.0009, lon, 0));
    expect(north[1]).toBeGreaterThan(90);
    expect(Math.abs(north[0])).toBeLessThan(1);

    const east = frame.sourceToRenderPoint(geodeticToEcef(lat, lon + 0.0009, 0));
    expect(east[0]).toBeGreaterThan(60);
    expect(Math.abs(east[1])).toBeLessThan(1);
  });

  it('keeps an orthonormal basis, so distances and angles survive', () => {
    const frame = createLocalEnuFrame(geodeticToEcef(-33.87, 151.21, 25));
    const e = frame.renderVectorToSource([1, 0, 0]);
    const n = frame.renderVectorToSource([0, 1, 0]);
    const u = frame.renderVectorToSource([0, 0, 1]);
    for (const v of [e, n, u]) expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect(dot(e, n)).toBeCloseTo(0, 12);
    expect(dot(e, u)).toBeCloseTo(0, 12);
    expect(dot(n, u)).toBeCloseTo(0, 12);
  });

  it('preserves the distance between two source points', () => {
    const frame = createLocalEnuFrame(geodeticToEcef(45.5, -122.6, 60));
    const a = geodeticToEcef(45.5001, -122.6002, 61);
    const b = geodeticToEcef(45.5004, -122.5997, 78);
    const sourceD = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
    const ra = frame.sourceToRenderPoint(a), rb = frame.sourceToRenderPoint(b);
    const renderD = Math.hypot(ra[0] - rb[0], ra[1] - rb[1], ra[2] - rb[2]);
    expect(renderD).toBeCloseTo(sourceD, 9);
  });

  it('round-trips a geocentric coordinate back to within a nanometre', () => {
    const frame = createLocalEnuFrame(geodeticToEcef(45.5, -122.6, 60));
    for (const [dLat, dLon, dH] of [[0, 0, 0], [0.01, -0.01, 120], [-0.004, 0.02, -30]]) {
      const p = geodeticToEcef(45.5 + dLat, -122.6 + dLon, 60 + dH);
      const back = frame.renderToSourcePoint(frame.sourceToRenderPoint(p));
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i] - p[i])).toBeLessThan(1e-9);
    }
  });

  it('carries a vector without the anchor, so a normal stays a direction', () => {
    const frame = createLocalEnuFrame(geodeticToEcef(45.5, -122.6, 60));
    const v = frame.sourceVectorToRender([1, 0, 0]);
    expect(Math.hypot(...v)).toBeCloseTo(1, 12);
    expect(frame.renderVectorToSource(v)[0]).toBeCloseTo(1, 12);
  });

  it('says it is not translation only, so a direct adder must not add', () => {
    const anchor = geodeticToEcef(45.5, -122.6, 60);
    const frame = createLocalEnuFrame(anchor);
    expect(frame.isTranslationOnly).toBe(false);
    // What the naive addition costs: the rotation is skipped, so the error is
    // the arc between the two frames over the offset from the anchor. A point
    // 1.5 km away lands roughly 950 m from where it belongs, and the gap grows
    // with the offset rather than staying a fixed bias.
    const p = geodeticToEcef(45.51, -122.61, 70);
    const render = frame.sourceToRenderPoint(p);
    const naive = [
      render[0] + anchor[0], render[1] + anchor[1], render[2] + anchor[2],
    ];
    const offset = Math.hypot(
      p[0] - anchor[0], p[1] - anchor[1], p[2] - anchor[2],
    );
    expect(offset).toBeGreaterThan(1000);
    expect(Math.hypot(naive[0] - p[0], naive[1] - p[1], naive[2] - p[2]))
      .toBeGreaterThan(500);
  });
});

describe('where Float32 may enter', () => {
  const anchor = geodeticToEcef(45.5, -122.6, 60);

  it('keeps millimetre spacing when the cast follows the recentring', () => {
    const frame = createLocalEnuFrame(anchor);
    const a = frame.sourceToRenderPoint(anchor);
    const b = frame.sourceToRenderPoint([anchor[0], anchor[1], anchor[2] + 0.001]);
    const f = new Float32Array([...a, ...b]);
    const dz = Math.hypot(f[3] - f[0], f[4] - f[1], f[5] - f[2]);
    expect(dz).toBeCloseTo(0.001, 6);
  });

  it('loses that spacing entirely when the cast precedes it', () => {
    // The same millimetre, narrowed while the coordinate is still geocentric.
    const f = new Float32Array([
      anchor[0], anchor[1], anchor[2],
      anchor[0], anchor[1], anchor[2] + 0.001,
    ]);
    expect(Math.hypot(f[3] - f[0], f[4] - f[1], f[5] - f[2])).toBe(0);
  });
});
