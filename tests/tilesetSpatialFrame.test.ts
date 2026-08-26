/**
 * tilesetSpatialFrame.test.ts — a tileset's points land in a frame that knows
 * which way is up, or say they do not.
 *
 * The failure this file exists to catch leaves no visual trace. A tileset
 * authored in WGS84 geocentric coordinates, recentred and never rotated, fits
 * the camera and draws as a plausible scene; only the numbers read off it are
 * wrong, because +Z there is the polar axis and not local up.
 *
 * So the fixture is placed at Monterrey, 25.6866°N 100.3161°W, where the two
 * axes are 64.3° apart. A fixture on the equator at longitude zero has them
 * coincide, and every assertion below would pass against a reader that only
 * subtracts an origin.
 */

import { describe, expect, test } from 'vitest';
import { loadTilesetCloud } from '../src/io/tiles3d/tilesetCloud';
import {
  declaredTilesetFrame,
  finiteExtentCentre,
  resolveTilesetFrame,
} from '../src/io/tiles3d/tilesetFrame';
import { parseTileset } from '../src/io/tiles3d/tileset';
import { geodeticToEcef } from '../src/io/tiles3d/boundingVolume';
import { createLocalEnuFrame, createTranslatedFrame } from '../src/geo/frame/spatialFrame';
import { describeCloudFrame, frameHasVerticalMeaning } from '../src/geo/frame/frameProvenance';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const ENTRY = 'https://tiles.example.org/scan/a/tileset.json';
const BASE = 'https://tiles.example.org/scan/a/';
const PNTS_MAGIC = 0x73746e70; // 'pnts', little-endian

const DEG = Math.PI / 180;
/** Monterrey. Chosen because ECEF +Z and local up are far apart here. */
const LAT = 25.6866 * DEG;
const LON = -100.3161 * DEG;
const HEIGHT = 540;

const ANCHOR = geodeticToEcef(LON, LAT, HEIGHT);

/** The ellipsoid normal at the fixture, in ECEF. This is what "up" means there. */
const UP_ECEF: [number, number, number] = [
  Math.cos(LAT) * Math.cos(LON),
  Math.cos(LAT) * Math.sin(LON),
  Math.sin(LAT),
];
/** East at the fixture, in ECEF. */
const EAST_ECEF: [number, number, number] = [-Math.sin(LON), Math.cos(LON), 0];

function angleDeg(a: readonly number[], b: readonly number[]): number {
  const dot = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  const la = Math.hypot(a[0]!, a[1]!, a[2]!);
  const lb = Math.hypot(b[0]!, b[1]!, b[2]!);
  return (Math.acos(Math.min(1, Math.max(-1, dot / (la * lb)))) * 180) / Math.PI;
}

/** A minimal PNTS tile: 28-byte header, feature-table JSON, feature-table binary. */
function makePnts(
  points: readonly (readonly [number, number, number])[],
  rtc?: readonly [number, number, number],
): ArrayBuffer {
  const ft: Record<string, unknown> = { POINTS_LENGTH: points.length, POSITION: { byteOffset: 0 } };
  if (rtc) ft.RTC_CENTER = rtc;
  let json = JSON.stringify(ft);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binBytes = points.length * 3 * 4;
  const total = 28 + jsonBytes.length + binBytes;
  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonBytes.length, true);
  view.setUint32(16, binBytes, true);
  view.setUint32(20, 0, true);
  view.setUint32(24, 0, true);
  new Uint8Array(buf, 28, jsonBytes.length).set(jsonBytes);
  const binStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binStart + k++ * 4, c, true);
  return buf;
}

function fakeTransport(
  json: Record<string, string>,
  tiles: Record<string, ArrayBuffer>,
): TilesetTransport {
  return {
    fetchTilesetJson: async (url) => {
      const body = json[url];
      if (body === undefined) throw new Error(`no tileset at ${url}`);
      return body;
    },
    fetchTileBytes: async (url) => {
      const body = tiles[url];
      if (body === undefined) throw new Error(`no tile at ${url}`);
      return body;
    },
  };
}

/** A patch of the ellipsoid around the fixture, in EPSG:4979 radians and metres. */
const REGION = [LON - 0.001, LAT - 0.001, LON + 0.001, LAT + 0.001, 0, 2000];
/** A Cartesian volume wide enough to hold the tile, declaring nothing about the frame. */
const BOX = [ANCHOR[0], ANCHOR[1], ANCHOR[2], 1000, 0, 0, 0, 1000, 0, 0, 0, 1000];

/**
 * Three points on the ground at the fixture: the anchor, one 100 m along the
 * local ellipsoid normal, one 50 m east.
 *
 * They are carried as an `RTC_CENTER` at the anchor plus small local offsets,
 * which is how a real tileset states them and what keeps the float32 position
 * block precise. The result reaching the merge is the anchor plus the offset,
 * in the tileset's root frame.
 */
const OFFSETS: [number, number, number][] = [
  [0, 0, 0],
  [UP_ECEF[0] * 100, UP_ECEF[1] * 100, UP_ECEF[2] * 100],
  [EAST_ECEF[0] * 50, EAST_ECEF[1] * 50, EAST_ECEF[2] * 50],
];

function fixture(volume: Record<string, unknown>): {
  json: Record<string, string>;
  tiles: Record<string, ArrayBuffer>;
} {
  return {
    json: {
      [ENTRY]: JSON.stringify({
        asset: { version: '1.1' },
        geometricError: 100,
        root: {
          boundingVolume: volume,
          geometricError: 0,
          refine: 'REPLACE',
          content: { uri: 'a.pnts' },
        },
      }),
    },
    tiles: { [`${BASE}a.pnts`]: makePnts(OFFSETS, ANCHOR) },
  };
}

/** Point `i` of a loaded cloud, back in the cloud's own render coordinates. */
function renderPoint(
  cloud: { positions: Float32Array; origin: [number, number, number] },
  i: number,
): [number, number, number] {
  const [ox, oy, oz] = cloud.origin;
  return [
    cloud.positions[i * 3]! + ox,
    cloud.positions[i * 3 + 1]! + oy,
    cloud.positions[i * 3 + 2]! + oz,
  ];
}

describe('the fixture separates the two axes', () => {
  test('ECEF +Z and local up are 64.3° apart at the fixture', () => {
    // Analytically the co-latitude: the ellipsoid normal makes an angle of
    // 90° − φ with the polar axis. An assertion at a fixture where this were
    // near zero would hold against a reader that never rotated anything.
    expect(angleDeg([0, 0, 1], UP_ECEF)).toBeCloseTo(90 - 25.6866, 9);
    expect(angleDeg([0, 0, 1], UP_ECEF)).toBeGreaterThan(60);
  });
});

describe('a declared geocentric tileset is drawn in a local ENU frame', () => {
  test('the cloud up axis is local up, not ECEF +Z', async () => {
    const f = fixture({ region: REGION });
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(f.json, f.tiles));
    expect(cloud.pointCount).toBe(3);

    const base = renderPoint(cloud, 0);
    const vertical = renderPoint(cloud, 1);
    const eastward = renderPoint(cloud, 2);
    const up: [number, number, number] = [
      vertical[0] - base[0],
      vertical[1] - base[1],
      vertical[2] - base[2],
    ];
    const east: [number, number, number] = [
      eastward[0] - base[0],
      eastward[1] - base[1],
      eastward[2] - base[2],
    ];

    // The 100 m along the ellipsoid normal is 100 m of render Z and nothing
    // else. Without the rotation this vector is the ECEF normal itself, which
    // at this latitude puts most of its length in X and Y.
    expect(angleDeg(up, [0, 0, 1])).toBeLessThan(0.01);
    expect(up[2]).toBeCloseTo(100, 1);
    expect(Math.hypot(up[0], up[1])).toBeLessThan(0.05);

    // And the 50 m east is horizontal, which is the same statement read the
    // other way round: a frame that got up right and the horizontal plane
    // wrong is not a frame.
    expect(east[0]).toBeCloseTo(50, 1);
    expect(Math.abs(east[2])).toBeLessThan(0.05);

    expect(cloud.metadata?.frame?.basis).toBe('local-enu');
    expect(cloud.metadata?.frame?.verticalReference).toBe('ellipsoidal');
    expect(cloud.metadata?.frame?.linearUnit).toBe('metre');
    expect(cloud.metadata?.frame?.declaredBy).toMatch(/region bounding volume/);
    expect(frameHasVerticalMeaning(cloud.metadata!.frame!)).toBe(true);
  });

  test('a region on a child declares the frame the whole tree shares', () => {
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 100,
      root: {
        boundingVolume: { box: BOX },
        geometricError: 10,
        refine: 'REPLACE',
        children: [{ boundingVolume: { region: REGION }, geometricError: 0 }],
      },
    });
    expect(declaredTilesetFrame(tileset).geocentric).toBe(true);
  });
});

describe('the frame is reversible', () => {
  test('an ECEF coordinate survives the round trip to a millimetre', () => {
    const frame = createLocalEnuFrame(ANCHOR);
    // Points across a kilometre of the fixture, which is the scale a one-shot
    // tileset read covers, plus the anchor itself.
    const samples: [number, number, number][] = [
      [ANCHOR[0], ANCHOR[1], ANCHOR[2]],
      [ANCHOR[0] + 1000, ANCHOR[1] - 250, ANCHOR[2] + 700],
      [ANCHOR[0] - 3210.5, ANCHOR[1] + 44.25, ANCHOR[2] - 918.75],
    ];
    for (const p of samples) {
      const back = frame.renderToSourcePoint(frame.sourceToRenderPoint(p));
      // 1e-6 m. The residual is Float64 rounding on a coordinate of 6.4e6 m,
      // where one ulp is about 1e-9 m, so the tolerance is six orders of
      // magnitude above the noise and still far below anything a survey cares
      // about.
      for (let i = 0; i < 3; i++) expect(Math.abs(back[i]! - p[i]!)).toBeLessThan(1e-6);
    }
  });

  test('the recorded anchor rebuilds the frame the cloud was drawn in', async () => {
    const f = fixture({ region: REGION });
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(f.json, f.tiles));
    const anchor = cloud.metadata?.frame?.anchor;
    expect(anchor).toBeDefined();
    // The provenance is only reversible if the anchor it kept is the one the
    // rotation used. Rebuilding the frame from it and undoing the render
    // coordinate has to land back on the tile's own ECEF position.
    const rebuilt = createLocalEnuFrame(anchor!);
    const recovered = rebuilt.renderToSourcePoint(renderPoint(cloud, 0));
    for (let i = 0; i < 3; i++) expect(Math.abs(recovered[i]! - ANCHOR[i]!)).toBeLessThan(0.01);
  });
});

describe('an undeclared frame stays unknown', () => {
  test('a tileset with no region claims no vertical reference', async () => {
    const f = fixture({ box: BOX });
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(f.json, f.tiles));
    const frame = cloud.metadata?.frame;
    expect(frame?.basis).toBe('unknown');
    expect(frame?.verticalReference).toBe('unknown');
    expect(frame?.declaredBy).toBeNull();
    expect(frame?.anchor).toBeUndefined();
    expect(frameHasVerticalMeaning(frame!)).toBe(false);
    expect(describeCloudFrame(frame!)).toBe('Frame not established, no vertical reference, metres');
    // The unit is a separate fact and the tileset states it. An unresolved
    // frame does not un-state it.
    expect(frame?.linearUnit).toBe('metre');
    expect(cloud.metadata?.loadWarnings?.join(' ')).toMatch(/which way is up is not established/);
  });

  test('a large coordinate is not a declaration', () => {
    // The fixture's coordinates are 6.4 million metres from the origin and
    // sit inside a Cartesian box. A reader that decided from magnitude would
    // call this geocentric and invent an ellipsoidal height for a cloud that
    // may be a projected grid with a large false easting.
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 100,
      root: { boundingVolume: { box: BOX }, geometricError: 0, refine: 'REPLACE' },
    });
    expect(declaredTilesetFrame(tileset)).toEqual({ geocentric: false, declaredBy: null });
    expect(resolveTilesetFrame(tileset, ANCHOR).frame).toBeNull();
    expect(resolveTilesetFrame(tileset, ANCHOR).provenance.basis).toBe('unknown');
  });

  test('a declared frame with no usable anchor stays unknown rather than guessing one', () => {
    const tileset = parseTileset({
      asset: { version: '1.1' },
      geometricError: 100,
      root: { boundingVolume: { region: REGION }, geometricError: 0, refine: 'REPLACE' },
    });
    // The geocentre has no ellipsoid normal, so there is no tangent frame to
    // build and no rotation that would be less arbitrary than another.
    expect(resolveTilesetFrame(tileset, [0, 0, 0]).provenance.basis).toBe('unknown');
    expect(resolveTilesetFrame(tileset, null).provenance.basis).toBe('unknown');
    expect(finiteExtentCentre(new Float64Array([NaN, NaN, NaN]))).toBeNull();
  });
});

describe('recentring alone never sets an up axis', () => {
  test('an unrotated cloud is a pure translation of the source coordinates', async () => {
    const f = fixture({ box: BOX });
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(f.json, f.tiles));
    // Every render coordinate is the ECEF coordinate minus the origin, exactly.
    // Nothing turned; that is the whole point of recording the frame as unknown.
    for (let i = 0; i < 3; i++) {
      const p = renderPoint(cloud, i);
      for (let k = 0; k < 3; k++) {
        expect(Math.abs(p[k]! - (ANCHOR[k]! + OFFSETS[i]![k]!))).toBeLessThan(0.05);
      }
    }
  });

  test('a translated frame reports the source axis, which here is 64.3° off up', () => {
    const translated = createTranslatedFrame(ANCHOR);
    expect(translated.isTranslationOnly).toBe(true);
    // Its up is the source's own +Z. Calling that vertical at this fixture is
    // the defect: it is more than sixty degrees away from the ellipsoid normal.
    expect(angleDeg(translated.renderWorldUp(), UP_ECEF)).toBeCloseTo(90 - 25.6866, 6);
    expect(angleDeg(createLocalEnuFrame(ANCHOR).renderWorldUp(), [0, 0, 1])).toBeCloseTo(0, 9);
  });
});
