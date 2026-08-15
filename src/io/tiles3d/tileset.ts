/**
 * tileset.ts — a `tileset.json` parser for the 3D Tiles point-cloud subset.
 *
 * OLV already streams COPC and EPT through one format-agnostic `StreamingSource`
 * + scheduler, so opening 3D Tiles is a matter of turning a tileset into the same
 * node shape. This is the first half: parse an explicit `tileset.json` tree into
 * typed tiles (bounding volume, geometric error, refine, transform, content URI),
 * inheriting `refine` down the tree as the spec requires. It deliberately refuses
 * what this subset does not cover — implicit tiling — with a clear error rather
 * than mis-reading it. Pure: no fetch, no DOM.
 */

export type Refine = 'ADD' | 'REPLACE';

export interface BoundingVolume {
  /** OBB: center(3), x-halfaxis(3), y-halfaxis(3), z-halfaxis(3). */
  readonly box?: readonly number[];
  /** [west, south, east, north, minH, maxH] in radians/metres. */
  readonly region?: readonly number[];
  /** [centerX, centerY, centerZ, radius]. */
  readonly sphere?: readonly number[];
}

export interface Tile {
  readonly boundingVolume: BoundingVolume;
  readonly geometricError: number;
  readonly refine: Refine;
  /** Column-major 4x4, when present. */
  readonly transform: readonly number[] | null;
  /** Content URI (a `.pnts` tile or a nested external `tileset.json`), or null. */
  readonly contentUri: string | null;
  readonly children: readonly Tile[];
}

export interface Tileset {
  readonly assetVersion: string;
  readonly geometricError: number;
  readonly root: Tile;
}

interface RawTile {
  boundingVolume?: Record<string, unknown>;
  geometricError?: number;
  refine?: string;
  transform?: number[];
  content?: { uri?: string; url?: string };
  children?: RawTile[];
  implicitTiling?: unknown;
}

function boundingVolume(raw: Record<string, unknown> | undefined): BoundingVolume {
  if (!raw) throw new Error('3D Tiles: a tile has no boundingVolume.');
  const num = (v: unknown): number[] | undefined =>
    Array.isArray(v) && v.every((n) => typeof n === 'number') ? (v as number[]) : undefined;
  const box = num(raw.box);
  const region = num(raw.region);
  const sphere = num(raw.sphere);
  if (!box && !region && !sphere) {
    throw new Error('3D Tiles: boundingVolume must be one of box, region, or sphere.');
  }
  return { ...(box && { box }), ...(region && { region }), ...(sphere && { sphere }) };
}

function parseTile(raw: RawTile, inheritedRefine: Refine): Tile {
  if (raw.implicitTiling !== undefined) {
    throw new Error('3D Tiles: implicit tiling is not supported yet — only an explicit tile hierarchy.');
  }
  if (typeof raw.geometricError !== 'number' || !Number.isFinite(raw.geometricError)) {
    throw new Error('3D Tiles: a tile has no finite geometricError.');
  }
  const refineRaw = (raw.refine ?? '').toUpperCase();
  const refine: Refine = refineRaw === 'ADD' || refineRaw === 'REPLACE' ? refineRaw : inheritedRefine;
  const contentUri = raw.content?.uri ?? raw.content?.url ?? null;
  const children = (raw.children ?? []).map((c) => parseTile(c, refine));
  return {
    boundingVolume: boundingVolume(raw.boundingVolume),
    geometricError: raw.geometricError,
    refine,
    transform: Array.isArray(raw.transform) ? raw.transform : null,
    contentUri,
    children,
  };
}

/** Parse a `tileset.json` (string or already-parsed object) into a typed tree. */
export function parseTileset(input: string | object): Tileset {
  const doc = (typeof input === 'string' ? JSON.parse(input) : input) as {
    asset?: { version?: string };
    geometricError?: number;
    root?: RawTile;
  };
  const assetVersion = doc.asset?.version;
  if (typeof assetVersion !== 'string') {
    throw new Error('3D Tiles: tileset.json has no asset.version.');
  }
  if (typeof doc.geometricError !== 'number' || !Number.isFinite(doc.geometricError)) {
    throw new Error('3D Tiles: tileset.json has no finite geometricError.');
  }
  if (!doc.root) throw new Error('3D Tiles: tileset.json has no root tile.');
  // The root must declare its own refine; children inherit it when they omit one.
  const rootRefine = (doc.root.refine ?? '').toUpperCase();
  if (rootRefine !== 'ADD' && rootRefine !== 'REPLACE') {
    throw new Error('3D Tiles: the root tile must declare refine ADD or REPLACE.');
  }
  return {
    assetVersion,
    geometricError: doc.geometricError,
    root: parseTile(doc.root, rootRefine as Refine),
  };
}
