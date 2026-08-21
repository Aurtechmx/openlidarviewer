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
  refine?: unknown;
  transform?: number[];
  content?: { uri?: string; url?: string };
  children?: RawTile[];
  implicitTiling?: unknown;
}

/** Component counts the spec fixes for each bounding-volume form. */
const BOUNDING_VOLUME_LENGTH = { box: 12, region: 6, sphere: 4 } as const;

function boundingVolume(raw: Record<string, unknown> | undefined): BoundingVolume {
  if (!raw) throw new Error('3D Tiles: a tile has no boundingVolume.');
  // The spec allows one form per tile. Two of them state two different volumes
  // for the same tile, and with no rule for reconciling them the answer would
  // be whichever form the code below happened to read first.
  const kinds = Object.keys(BOUNDING_VOLUME_LENGTH) as (keyof typeof BOUNDING_VOLUME_LENGTH)[];
  const declared = kinds.filter((kind) => raw[kind] !== undefined);
  if (declared.length > 1) {
    throw new Error(
      `3D Tiles: boundingVolume declares ${declared.join(' and ')}; it must declare exactly one of box, region, or sphere.`,
    );
  }
  // Each form has a fixed length and every component must be a real number.
  // `parseTileset` also accepts an already-parsed object, and an object can
  // carry NaN where JSON text cannot, so finiteness is checked rather than
  // assumed from the source.
  const num = (v: unknown, kind: keyof typeof BOUNDING_VOLUME_LENGTH): number[] | undefined => {
    if (v === undefined) return undefined;
    const want = BOUNDING_VOLUME_LENGTH[kind];
    if (!Array.isArray(v) || v.length !== want) {
      throw new Error(`3D Tiles: boundingVolume.${kind} must have ${want} components.`);
    }
    if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      throw new Error(`3D Tiles: boundingVolume.${kind} has a non-finite component.`);
    }
    return v as number[];
  };
  const box = num(raw.box, 'box');
  const region = num(raw.region, 'region');
  const sphere = num(raw.sphere, 'sphere');
  if (!box && !region && !sphere) {
    throw new Error('3D Tiles: boundingVolume must be one of box, region, or sphere.');
  }
  if (sphere && sphere[3] < 0) {
    throw new Error('3D Tiles: boundingVolume.sphere has a negative radius.');
  }
  return { ...(box && { box }), ...(region && { region }), ...(sphere && { sphere }) };
}

/** A 3D Tiles transform is a column-major 4x4 of real numbers, or absent. */
function tileTransform(v: unknown): readonly number[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length !== 16) {
    throw new Error('3D Tiles: a tile transform must have 16 components.');
  }
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('3D Tiles: a tile transform has a non-finite component.');
  }
  return v as number[];
}

/**
 * The refine a tile declares, or null when it declares none.
 *
 * `refine` is optional on a child tile, which takes its parent's value. A value
 * that is present but names no strategy the spec defines is a different case:
 * it is refused here instead of falling through to the inherited value. The
 * string check keeps a non-string value from reaching `.toUpperCase()`, where
 * it would raise a TypeError instead of a parse error.
 */
function explicitRefine(v: unknown): Refine | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') {
    throw new Error(`3D Tiles: a tile refine is not a string (${typeof v}).`);
  }
  const upper = v.toUpperCase();
  if (upper !== 'ADD' && upper !== 'REPLACE') {
    throw new Error(`3D Tiles: a tile declares refine "${v}", which is not ADD or REPLACE.`);
  }
  return upper;
}

function parseTile(raw: RawTile, inheritedRefine: Refine): Tile {
  if (raw.implicitTiling !== undefined) {
    throw new Error('3D Tiles: implicit tiling is not supported yet — only an explicit tile hierarchy.');
  }
  if (typeof raw.geometricError !== 'number' || !Number.isFinite(raw.geometricError)) {
    throw new Error('3D Tiles: a tile has no finite geometricError.');
  }
  // Geometric error is a distance, so a negative one describes nothing.
  if (raw.geometricError < 0) {
    throw new Error(`3D Tiles: a tile has a negative geometricError (${raw.geometricError}).`);
  }
  const refine: Refine = explicitRefine(raw.refine) ?? inheritedRefine;
  // TypeScript types content.uri as a string, but the runtime accepts whatever
  // the document held. A non-string here would flow out as a URI and be fetched.
  const rawUri = raw.content?.uri ?? raw.content?.url;
  if (rawUri !== undefined && (typeof rawUri !== 'string' || rawUri.length === 0)) {
    throw new Error('3D Tiles: a tile content URI is not a non-empty string.');
  }
  const contentUri = rawUri ?? null;
  if (raw.children !== undefined && !Array.isArray(raw.children)) {
    throw new Error('3D Tiles: a tile children field is not an array.');
  }
  const children = (raw.children ?? []).map((c) => parseTile(c, refine));
  return {
    boundingVolume: boundingVolume(raw.boundingVolume),
    geometricError: raw.geometricError,
    refine,
    transform: tileTransform(raw.transform),
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
  if (doc.geometricError < 0) {
    throw new Error(`3D Tiles: tileset.json has a negative geometricError (${doc.geometricError}).`);
  }
  if (!doc.root) throw new Error('3D Tiles: tileset.json has no root tile.');
  // The root must declare its own refine; children inherit it when they omit one.
  const rootRefine = explicitRefine(doc.root.refine);
  if (!rootRefine) {
    throw new Error('3D Tiles: the root tile must declare refine ADD or REPLACE.');
  }
  return {
    assetVersion,
    geometricError: doc.geometricError,
    root: parseTile(doc.root, rootRefine),
  };
}
