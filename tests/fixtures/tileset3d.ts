/**
 * tileset3d.ts — synthetic 3D Tiles datasets, small enough to live in the repo.
 *
 * The COPC end-to-end tests need an 80 MB scan that no clone carries, so they
 * skip on CI and the coverage they claim is not run there. A tileset has no
 * such excuse: a `tileset.json` is a few hundred bytes of JSON and a `.pnts`
 * body is a header plus float32 positions, so a whole streaming dataset fits in
 * a few kilobytes and can be BUILT rather than shipped. Nothing here reads the
 * disk or the network, which is what lets the e2e specs serve these bodies from
 * `page.route` and run everywhere.
 *
 * WHAT EACH SCENE IS FOR. `boxTileset` declares its volumes as `box`, which
 * states nothing about which way is up; `regionTileset` declares a `region`,
 * which fixes the root frame as WGS84 geocentric. The pair is the difference
 * the Scan Report has to state, and it is the only difference between them: the
 * two draw identically, so a test that did not read the report could not tell
 * them apart.
 *
 * Point counts are kept under a thousand on purpose. The viewer's counters
 * abbreviate at 1 000 (`formatCount`), so a small dataset lets a spec assert on
 * an exact integer instead of a rounded "0.9K".
 *
 * Pure: no fetch, no DOM, no Playwright. A spec turns {@link TilesetScene.files}
 * into routes.
 */

import { geodeticToEcef } from '../../src/io/tiles3d/boundingVolume';

/** `pnts`, little-endian — the first four bytes of every point-tile body. */
export const PNTS_MAGIC = 0x73746e70;

export type Point3 = readonly [number, number, number];
export type Rgb = readonly [number, number, number];

/** Optional feature-table content for {@link makePnts}. */
export interface PntsOptions {
  /** `RTC_CENTER`, the tile-local origin the positions are relative to. */
  readonly rtc?: Point3;
  /** One `RGB` triple per point, or omitted for a tile that states no colour. */
  readonly rgb?: readonly Rgb[];
  /**
   * One float32 `NORMAL` triple per point, or omitted for a tile that states
   * none. Stated per TILE, exactly as `RGB` is, which is why a tileset's answer
   * about normals cannot be read off the entry document.
   */
  readonly normals?: readonly Point3[];
}

/**
 * A minimal valid `.pnts` body: the 28-byte header, the feature-table JSON
 * padded to an 8-byte boundary, then the feature-table binary.
 *
 * The same construction the unit suite uses (`tests/pntsDecode.test.ts`,
 * `tests/tiles3dTilesetOpen.test.ts`, `tests/pntsDecodeCeiling.test.ts`), kept
 * here so the browser tests do not add a fourth copy of it.
 */
export function makePnts(points: readonly Point3[], options: PntsOptions = {}): Uint8Array {
  const positionBytes = points.length * 3 * 4;
  const rgbBytes = options.rgb ? points.length * 3 : 0;
  // NORMAL is float32 and must start on a 4-byte boundary inside the binary
  // section. The RGB block is byte-wide and a multiple of three long, so it can
  // leave the cursor off a word; this pads it back on.
  const normalPad = options.normals ? (4 - ((positionBytes + rgbBytes) % 4)) % 4 : 0;
  const normalBytes = options.normals ? points.length * 3 * 4 : 0;
  const featureTable: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (options.rtc) featureTable.RTC_CENTER = options.rtc;
  if (options.rgb) featureTable.RGB = { byteOffset: positionBytes };
  if (options.normals) {
    featureTable.NORMAL = { byteOffset: positionBytes + rgbBytes + normalPad };
  }
  let json = JSON.stringify(featureTable);
  while (json.length % 8 !== 0) json += ' ';
  const jsonBytes = new TextEncoder().encode(json);
  const binaryBytes = positionBytes + rgbBytes + normalPad + normalBytes;
  const total = 28 + jsonBytes.length + binaryBytes;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  view.setUint32(0, PNTS_MAGIC, true);
  view.setUint32(4, 1, true); // version
  view.setUint32(8, total, true); // byteLength
  view.setUint32(12, jsonBytes.length, true); // featureTableJSONByteLength
  view.setUint32(16, binaryBytes, true); // featureTableBinaryByteLength
  view.setUint32(20, 0, true); // batchTableJSONByteLength
  view.setUint32(24, 0, true); // batchTableBinaryByteLength
  new Uint8Array(buffer, 28, jsonBytes.length).set(jsonBytes);
  const binaryStart = 28 + jsonBytes.length;
  let k = 0;
  for (const p of points) for (const c of p) view.setFloat32(binaryStart + k++ * 4, c, true);
  if (options.rgb) {
    const bytes = new Uint8Array(buffer, binaryStart + positionBytes, points.length * 3);
    let j = 0;
    for (const c of options.rgb) for (const v of c) bytes[j++] = v;
  }
  if (options.normals) {
    const at = binaryStart + positionBytes + rgbBytes + normalPad;
    let j = 0;
    for (const n of options.normals) for (const v of n) view.setFloat32(at + j++ * 4, v, true);
  }
  return new Uint8Array(buffer);
}

/**
 * A square grid of points over `[-half, half]` on x and y, with a gentle
 * sinusoidal z so the cloud has volume and the camera framing produces a
 * sensible orbit pose rather than an edge-on plane.
 */
export function gridPoints(side: number, half: number, offset: Point3 = [0, 0, 0]): Point3[] {
  const points: Point3[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const u = side === 1 ? 0.5 : i / (side - 1);
      const v = side === 1 ? 0.5 : j / (side - 1);
      const x = (u * 2 - 1) * half;
      const y = (v * 2 - 1) * half;
      const z = Math.sin(u * Math.PI) * Math.cos(v * Math.PI) * (half * 0.15);
      points.push([x + offset[0], y + offset[1], z + offset[2]]);
    }
  }
  return points;
}

/**
 * One unit normal per point, cycling through the three axes.
 *
 * Real directions rather than a constant: the `normal` colour mode encodes
 * `n` as `(n + 1) / 2`, so a single repeated direction would paint the whole
 * tile one colour and a chip that resolved to something else would look the
 * same.
 */
export function unitNormals(count: number): Point3[] {
  const axes: Point3[] = [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ];
  return Array.from({ length: count }, (_, i) => axes[i % 3]);
}

/** One grey per point, so a tile "carries colour" without carrying meaning. */
export function flatRgb(count: number): Rgb[] {
  return Array.from({ length: count }, (_, i) => {
    const v = 60 + ((i * 7) % 180);
    return [v, v, v] as Rgb;
  });
}

/** One body the page may fetch, with the content type the route serves it as. */
export interface ServedFile {
  readonly contentType: string;
  readonly body: Uint8Array;
}

/** A whole synthetic dataset: the URL a user pastes, and everything under it. */
export interface TilesetScene {
  /** The `tileset.json` URL a user pastes into the open-from-URL field. */
  readonly entryUrl: string;
  /** Absolute URL to body, for every document and tile the page may request. */
  readonly files: ReadonlyMap<string, ServedFile>;
  /** Absolute URLs of the `.pnts` bodies, in document order. */
  readonly tileUrls: readonly string[];
  /** Total points across every tile this scene serves. */
  readonly totalPoints: number;
}

const JSON_TYPE = 'application/json';
const TILE_TYPE = 'application/octet-stream';

function jsonFile(value: unknown): ServedFile {
  return { contentType: JSON_TYPE, body: new TextEncoder().encode(JSON.stringify(value)) };
}

/** The default host. Not loopback and not private, so the SSRF gate passes it. */
export const TILESET_ORIGIN = 'https://tiles.example.com';

/** How a scene colours its tiles. `mixed` is a tileset that disagrees with itself. */
export type SceneColour = 'all' | 'none' | 'mixed';

/** Knobs for {@link boxTileset}. Each default is the valid, happy-path value. */
export interface BoxTilesetOptions {
  /** `asset.version`. A value outside 1.0 / 1.1 is refused by the parser. */
  readonly assetVersion?: string;
  /** Whether the tiles carry `RGB`. */
  readonly colour?: SceneColour;
  /**
   * Whether every tile carries a float32 `NORMAL` accessor. Off by default,
   * because a tileset that states no normals is the common case and the one
   * that must keep offering no Normal chip and no Normal Map.
   */
  readonly normals?: boolean;
  /** Directory the dataset is served from, so two scenes can coexist on one page. */
  readonly path?: string;
  /**
   * Content URI for the child tile, overriding the default `.pnts`. A `.b3dm`
   * is real 3D Tiles content this viewer has no decoder for, which is what a
   * refusal test wants.
   */
  readonly childContentUri?: string;
}

/**
 * A three-tile dataset whose volumes are all `box`, so the document declares no
 * geocentric frame and the report must say which way is up was never
 * established.
 *
 * `refine` is ADD throughout, so the parent and its children are all part of
 * the represented surface and every resident node draws. (A REPLACE tileset is
 * also served; there the scheduler's replace frontier hides a parent once its
 * children cover it. This fixture stays additive to keep its point set stable.)
 */
export function boxTileset(options: BoxTilesetOptions = {}): TilesetScene {
  const path = options.path ?? '/box';
  const base = `${TILESET_ORIGIN}${path}`;
  const colour = options.colour ?? 'all';
  const childUri = options.childContentUri ?? 'child-a.pnts';

  const root = gridPoints(21, 10);
  const childA = gridPoints(13, 4, [-5, -5, 0]);
  const childB = gridPoints(13, 4, [5, 5, 0]);

  const files = new Map<string, ServedFile>();
  files.set(
    `${base}/tileset.json`,
    jsonFile({
      asset: { version: options.assetVersion ?? '1.1' },
      geometricError: 40,
      root: {
        boundingVolume: { box: [0, 0, 0, 12, 0, 0, 0, 12, 0, 0, 0, 4] },
        geometricError: 12,
        refine: 'ADD',
        content: { uri: 'root.pnts' },
        children: [
          {
            boundingVolume: { box: [-5, -5, 0, 5, 0, 0, 0, 5, 0, 0, 0, 3] },
            geometricError: 2,
            content: { uri: childUri },
          },
          {
            boundingVolume: { box: [5, 5, 0, 5, 0, 0, 0, 5, 0, 0, 0, 3] },
            geometricError: 2,
            content: { uri: 'child-b.pnts' },
          },
        ],
      },
    }),
  );

  // `mixed` is the case the colour consensus exists for: the root states RGB
  // and the children state none, so whichever tile decodes first settles the
  // layer's one colour meaning and the other disagrees with it.
  const withNormals = options.normals === true;
  const withColour = (points: readonly Point3[], carries: boolean): Uint8Array =>
    makePnts(points, {
      ...(carries ? { rgb: flatRgb(points.length) } : {}),
      ...(withNormals ? { normals: unitNormals(points.length) } : {}),
    });
  const rootCarries = colour !== 'none';
  const childCarries = colour === 'all';

  const tileUrls: string[] = [];
  const addTile = (name: string, body: Uint8Array): void => {
    const url = `${base}/${name}`;
    files.set(url, { contentType: TILE_TYPE, body });
    tileUrls.push(url);
  };
  addTile('root.pnts', withColour(root, rootCarries));
  if (childUri.endsWith('.pnts')) addTile(childUri, withColour(childA, childCarries));
  addTile('child-b.pnts', withColour(childB, childCarries));

  return {
    entryUrl: `${base}/tileset.json`,
    files,
    tileUrls,
    totalPoints:
      root.length + (childUri.endsWith('.pnts') ? childA.length : 0) + childB.length,
  };
}

/**
 * A dataset whose root volume is a `region`, which is stated in EPSG:4979 and
 * so fixes the root frame as WGS84 geocentric.
 *
 * Its points are therefore ECEF, computed here rather than written by hand: the
 * viewer places the tile through the ENU root transform it derives from the
 * region, and points that were not in that frame would land kilometres away
 * from the bounds the scheduler culls against.
 */
export function regionTileset(path = '/region'): TilesetScene {
  const base = `${TILESET_ORIGIN}${path}`;
  const west = (-105.001 * Math.PI) / 180;
  const east = (-104.999 * Math.PI) / 180;
  const south = (39.999 * Math.PI) / 180;
  const north = (40.001 * Math.PI) / 180;
  const minHeight = 1600;
  const maxHeight = 1660;

  // A grid across the region, each sample lifted to ECEF at the mid height.
  const points: Point3[] = [];
  const side = 21;
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      const lon = west + ((east - west) * i) / (side - 1);
      const lat = south + ((north - south) * j) / (side - 1);
      const h = minHeight + 30 + Math.sin(i * 0.6) * Math.cos(j * 0.6) * 20;
      points.push(geodeticToEcef(lon, lat, h) as Point3);
    }
  }

  const files = new Map<string, ServedFile>();
  files.set(
    `${base}/tileset.json`,
    jsonFile({
      asset: { version: '1.1' },
      geometricError: 60,
      root: {
        boundingVolume: { region: [west, south, east, north, minHeight, maxHeight] },
        geometricError: 10,
        refine: 'ADD',
        content: { uri: 'root.pnts' },
      },
    }),
  );
  const tileUrl = `${base}/root.pnts`;
  files.set(tileUrl, { contentType: TILE_TYPE, body: makePnts(points, { rgb: flatRgb(points.length) }) });

  return { entryUrl: `${base}/tileset.json`, files, tileUrls: [tileUrl], totalPoints: points.length };
}
