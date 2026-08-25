/**
 * tiles3dTilesetCloud.test.ts — reading a whole tileset once, as one cloud.
 *
 * No network: the transport is a scripted URL-to-body map, the same shape
 * `tiles3dTilesetOpen.test.ts` uses, and it records what it was asked for so a
 * refusal can be pinned by what was NEVER fetched.
 *
 * The three things worth breaking are all here. A merged cloud carries no
 * record of which tiles are in it, so a tile silently dropped from the merge is
 * invisible on screen and wrong in every measurement taken afterwards — the
 * count assertions are what catch that. Placement is the second: the fixture
 * below is built so tile-local, single-transformed and double-transformed
 * coordinates are three different numbers, because a fixture where they
 * coincide proves nothing about the composition. The third is that every
 * refusal stays a refusal rather than becoming a partial cloud.
 */

import { describe, expect, test } from 'vitest';
import { loadTilesetCloud } from '../src/io/tiles3d/tilesetCloud';
import type { TilesetTransport } from '../src/io/tiles3d/tilesetTransport';

const ENTRY = 'https://tiles.example.org/scan/a/tileset.json';
const BASE = 'https://tiles.example.org/scan/a/';

const PNTS_MAGIC = 0x73746e70; // 'pnts', little-endian

/**
 * A minimal PNTS tile: 28-byte header, feature-table JSON, feature-table
 * binary. `rgba` is written as CONSTANT_RGBA, which lives in the JSON and so
 * needs no second binary section.
 */
function makePnts(
  points: readonly (readonly [number, number, number])[],
  rtc?: readonly [number, number, number],
  rgba?: readonly [number, number, number, number],
): ArrayBuffer {
  const ft: Record<string, unknown> = {
    POINTS_LENGTH: points.length,
    POSITION: { byteOffset: 0 },
  };
  if (rtc) ft.RTC_CENTER = rtc;
  if (rgba) ft.CONSTANT_RGBA = rgba;
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

/** A transport over an in-memory URL map, recording every request it served. */
function fakeTransport(
  json: Record<string, string>,
  tiles: Record<string, ArrayBuffer> = {},
): TilesetTransport & { readonly requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    fetchTilesetJson: async (url) => {
      requests.push(url);
      const body = json[url];
      if (body === undefined) throw new Error(`3D Tiles tileset fetch failed (404) for ${url}`);
      return body;
    },
    fetchTileBytes: async (url) => {
      requests.push(url);
      const body = tiles[url];
      if (body === undefined) throw new Error(`3D Tiles tile fetch failed (404) for ${url}`);
      return body;
    },
  };
}

function doc(root: Record<string, unknown>): string {
  return JSON.stringify({ asset: { version: '1.1' }, geometricError: 100, root });
}

/** A wide bounding volume, so nothing is selected or dropped on extent. */
const BOX = [0, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000];

/** Column-major: uniform `scale` about the origin, then translate by `t`. */
function scaleThenTranslate(scale: number, t: readonly [number, number, number]): number[] {
  return [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, t[0], t[1], t[2], 1];
}

/** A three-tile fixture: a REPLACE root over two leaves, each with content. */
function twoLeafTileset(): { json: Record<string, string>; tiles: Record<string, ArrayBuffer> } {
  return {
    json: {
      [ENTRY]: doc({
        boundingVolume: { box: BOX },
        geometricError: 100,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: [
          {
            boundingVolume: { box: BOX },
            geometricError: 0,
            content: { uri: '0.pnts' },
          },
          {
            boundingVolume: { box: BOX },
            geometricError: 0,
            content: { uri: '1.pnts' },
          },
        ],
      }),
    },
    tiles: {
      [`${BASE}root.pnts`]: makePnts([[0, 0, 0]]),
      [`${BASE}0.pnts`]: makePnts([
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ]),
      [`${BASE}1.pnts`]: makePnts([
        [0, 1, 0],
        [0, 2, 0],
      ]),
    },
  };
}

describe('loadTilesetCloud — merging a hierarchy', () => {
  test('a multi-tile hierarchy opens with every selected tile in the cloud', async () => {
    const fixture = twoLeafTileset();
    const t = fakeTransport(fixture.json, fixture.tiles);
    const cloud = await loadTilesetCloud(ENTRY, t);

    // The two leaves, and only them: the root REFINES, so its own content is
    // replaced by theirs rather than added to it.
    expect(cloud.pointCount).toBe(5);
    expect(t.requests).toContain(`${BASE}0.pnts`);
    expect(t.requests).toContain(`${BASE}1.pnts`);
    expect(t.requests).not.toContain(`${BASE}root.pnts`);
  });

  test('every point of every selected tile reaches the cloud', async () => {
    const fixture = twoLeafTileset();
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(fixture.json, fixture.tiles));
    const [ox, oy] = cloud.origin;
    // The five distinct x/y pairs the two tiles carry, recovered through the
    // cloud's recentring origin. A tile dropped from the merge takes its whole
    // set of coordinates with it, which no point count alone can distinguish
    // from a smaller tileset.
    const seen = new Set<string>();
    for (let i = 0; i < cloud.pointCount; i++) {
      seen.add(
        `${(cloud.positions[i * 3]! + ox).toFixed(3)},${(cloud.positions[i * 3 + 1]! + oy).toFixed(3)}`,
      );
    }
    expect([...seen].sort()).toEqual(
      ['1.000,0.000', '2.000,0.000', '3.000,0.000', '0.000,1.000', '0.000,2.000'].sort(),
    );
  });

  test('colour survives only when every tile carries it', async () => {
    const fixture = twoLeafTileset();
    fixture.tiles[`${BASE}0.pnts`] = makePnts(
      [
        [1, 0, 0],
        [2, 0, 0],
        [3, 0, 0],
      ],
      undefined,
      [10, 20, 30, 255],
    );
    const mixed = await loadTilesetCloud(ENTRY, fakeTransport(fixture.json, fixture.tiles));
    expect(mixed.colors).toBeUndefined();
    expect(mixed.metadata?.loadWarnings?.join(' ')).toMatch(/uncoloured/);

    fixture.tiles[`${BASE}1.pnts`] = makePnts(
      [
        [0, 1, 0],
        [0, 2, 0],
      ],
      undefined,
      [40, 50, 60, 255],
    );
    const coloured = await loadTilesetCloud(ENTRY, fakeTransport(fixture.json, fixture.tiles));
    expect(coloured.colors?.length).toBe(15);
    expect([...coloured.colors!.slice(0, 3)]).toEqual([10, 20, 30]);
    expect([...coloured.colors!.slice(12, 15)]).toEqual([40, 50, 60]);
  });
});

describe('loadTilesetCloud — placement', () => {
  /**
   * A leaf under a non-identity root transform AND a non-identity transform of
   * its own, with an RTC_CENTER on top.
   *
   * Local (1, 2, 3) + RTC (5, 0, 0) = (6, 2, 3) in the tile's own frame. The
   * child translates by 10, the root scales by 2 and translates by 100, so the
   * composed placement is x -> 2 * (x + 10) + 100:
   *
   *   tile-local, no transform at all   x = 6
   *   child transform only              x = 16
   *   composed (correct)                x = 132
   *   composed twice                    x = 384
   *
   * Four different numbers, so the assertion below distinguishes the right
   * answer from each of the three wrong ones rather than passing on any of them.
   */
  const placementTileset = (): { json: Record<string, string>; tiles: Record<string, ArrayBuffer> } => ({
    json: {
      [ENTRY]: doc({
        boundingVolume: { box: BOX },
        geometricError: 100,
        refine: 'REPLACE',
        transform: scaleThenTranslate(2, [100, 0, 0]),
        children: [
          {
            boundingVolume: { box: BOX },
            geometricError: 0,
            transform: scaleThenTranslate(1, [10, 0, 0]),
            content: { uri: 'deep.pnts' },
          },
        ],
      }),
    },
    tiles: { [`${BASE}deep.pnts`]: makePnts([[1, 2, 3]], [5, 0, 0]) },
  });

  test('a tile lands where the composed root-to-tile transform puts it', async () => {
    const fixture = placementTileset();
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(fixture.json, fixture.tiles));
    expect(cloud.pointCount).toBe(1);
    // A single point is recentred onto its own origin, so the placement is read
    // back from the origin the sanitation chose.
    const x = cloud.positions[0]! + cloud.origin[0];
    const y = cloud.positions[1]! + cloud.origin[1];
    const z = cloud.positions[2]! + cloud.origin[2];
    // 2 * (6 + 10) + 100. Not 6 (untransformed), not 16 (parent transform
    // skipped), not 384 (the composed transform applied twice).
    expect(x).toBeCloseTo(132, 6);
    expect(y).toBeCloseTo(4, 6);
    expect(z).toBeCloseTo(6, 6);
  });
});

describe('loadTilesetCloud — refusals stay refusals', () => {
  test('a selection past the tile ceiling refuses, and fetches no tile', async () => {
    // These bounding volumes contain the camera a full read selects against, so
    // every tile's screen-space error is unbounded and no threshold prunes one.
    // The coarsest level is the finest, and there is nothing to fall back to.
    const fixture = twoLeafTileset();
    const t = fakeTransport(fixture.json, fixture.tiles);
    await expect(loadTilesetCloud(ENTRY, t, { maxSelectedTiles: 1 })).rejects.toThrow(
      /selects 2 tiles even at its coarsest level, past the 1-tile ceiling/,
    );
    // Nothing was mounted AND nothing was even read: a cap that truncated would
    // have fetched its one tile and returned a cloud.
    expect(t.requests.filter((u) => u.endsWith('.pnts'))).toEqual([]);
  });

  test('an external tileset reference refuses rather than silently omitting it', async () => {
    const fixture = twoLeafTileset();
    fixture.json[ENTRY] = doc({
      boundingVolume: { box: BOX },
      geometricError: 100,
      refine: 'REPLACE',
      children: [
        { boundingVolume: { box: BOX }, geometricError: 0, content: { uri: '0.pnts' } },
        { boundingVolume: { box: BOX }, geometricError: 0, content: { uri: 'sub/tileset.json' } },
      ],
    });
    const t = fakeTransport(fixture.json, fixture.tiles);
    await expect(loadTilesetCloud(ENTRY, t)).rejects.toThrow(
      /links 1 external tileset\.json .*sub\/tileset\.json.*does not follow/s,
    );
    // The link is never followed either — reported, not fetched.
    expect(t.requests).not.toContain(`${BASE}sub/tileset.json`);
  });

  test('a merged total past the point ceiling refuses instead of truncating', async () => {
    const fixture = twoLeafTileset();
    const t = fakeTransport(fixture.json, fixture.tiles);
    // The two leaves hold 5 points between them; a ceiling of 4 is crossed by
    // the second one, after the first has already decoded.
    await expect(loadTilesetCloud(ENTRY, t, { maxPoints: 4 })).rejects.toThrow(
      /more than 4 points/,
    );
  });

  test('a tileset naming no point tiles refuses rather than mounting nothing', async () => {
    const t = fakeTransport({
      [ENTRY]: doc({ boundingVolume: { box: BOX }, geometricError: 100, refine: 'REPLACE' }),
    });
    await expect(loadTilesetCloud(ENTRY, t)).rejects.toThrow(/names no \.pnts tiles/);
  });
});

/**
 * A tileset placed away from the origin, so the camera a full read selects
 * against sits outside every bounding volume and each tile's screen-space error
 * is finite. Inside the volume the error is unbounded and no threshold prunes
 * anything, which is a real refusal but not the case these tests are about.
 *
 * Full detail is the four leaves, eight points. One level coarser is the root,
 * one point, at a coordinate no leaf carries: the two levels are numerically
 * different, so a test that claims to distinguish them can.
 */
function detailFixture(): { json: Record<string, string>; tiles: Record<string, ArrayBuffer> } {
  const FAR_BOX = [1_000_000, 0, 0, 1000, 0, 0, 0, 1000, 0, 0, 0, 1000];
  const tiles: Record<string, ArrayBuffer> = {
    [`${BASE}root.pnts`]: makePnts([[1_000_000, 0, 0]]),
  };
  for (let i = 0; i < 4; i++) {
    tiles[`${BASE}${i}.pnts`] = makePnts([
      [1_000_100 + i, 0, 0],
      [1_000_200 + i, 0, 0],
    ]);
  }
  return {
    json: {
      [ENTRY]: doc({
        boundingVolume: { box: FAR_BOX },
        geometricError: 100,
        refine: 'REPLACE',
        content: { uri: 'root.pnts' },
        children: Array.from({ length: 4 }, (_, i) => ({
          boundingVolume: { box: FAR_BOX },
          geometricError: 0,
          content: { uri: `${i}.pnts` },
        })),
      }),
    },
    tiles,
  };
}

describe('loadTilesetCloud — detail level', () => {
  test('a tileset past the tile ceiling opens coarser instead of refusing', async () => {
    const fixture = detailFixture();
    const t = fakeTransport(fixture.json, fixture.tiles);
    const cloud = await loadTilesetCloud(ENTRY, t, { maxSelectedTiles: 2 });

    // The root's own content, not the four leaves: the level chosen is the
    // finest one whose selection fits two tiles.
    expect(cloud.pointCount).toBe(1);
    expect(t.requests).toContain(`${BASE}root.pnts`);
    expect(t.requests).not.toContain(`${BASE}0.pnts`);
  });

  test('a cloud opened coarser says so', async () => {
    const fixture = detailFixture();
    const detail: { atFinestDetail: boolean; selectedTiles: number; finestTiles: number }[] = [];
    const cloud = await loadTilesetCloud(ENTRY, fakeTransport(fixture.json, fixture.tiles), {
      maxSelectedTiles: 2,
      onDetail: (d) => detail.push(d),
    });
    expect(detail).toHaveLength(1);
    expect(detail[0]!.atFinestDetail).toBe(false);
    expect(detail[0]!.selectedTiles).toBe(1);
    expect(detail[0]!.finestTiles).toBe(4);
    // On the cloud itself, because that is where a reader who did not watch the
    // load can still find it.
    const warnings = cloud.metadata?.loadWarnings ?? [];
    expect(warnings.join(' ')).toContain("coarser than this tileset's finest detail");
    expect(warnings.join(' ')).toContain('full detail names 4 tiles');
  });

  test('a tileset that fits opens at full detail and says it is the finest level', async () => {
    const fixture = detailFixture();
    const detail: { atFinestDetail: boolean; selectedTiles: number }[] = [];
    const t = fakeTransport(fixture.json, fixture.tiles);
    const cloud = await loadTilesetCloud(ENTRY, t, { onDetail: (d) => detail.push(d) });

    // Eight points, not the root's one: full detail and one level coarser are
    // different numbers here, which is what makes this assertion mean anything.
    expect(cloud.pointCount).toBe(8);
    expect(t.requests).not.toContain(`${BASE}root.pnts`);
    expect(detail[0]!.atFinestDetail).toBe(true);
    expect(detail[0]!.selectedTiles).toBe(4);
    // Nothing about detail reaches a cloud that is at its source's finest
    // level: the warnings channel carries what went wrong, and nothing did.
    const warnings = (cloud.metadata?.loadWarnings ?? []).join(' ');
    expect(warnings).not.toContain('detail');
  });

  test('a tileset that already fits selects exactly what it selected before', async () => {
    // The pin on "unchanged": the fixture the rest of this file loads at full
    // detail still fetches the same tiles and merges the same points, with no
    // detail warning attached to it.
    const fixture = twoLeafTileset();
    const t = fakeTransport(fixture.json, fixture.tiles);
    const cloud = await loadTilesetCloud(ENTRY, t);
    expect(cloud.pointCount).toBe(5);
    expect(t.requests).toEqual([ENTRY, `${BASE}0.pnts`, `${BASE}1.pnts`]);
    expect(cloud.metadata?.loadWarnings).toBeUndefined();
  });
});
