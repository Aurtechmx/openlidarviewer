/**
 * tileset.ts — a `tileset.json` parser for the 3D Tiles point-cloud subset.
 *
 * This parses an explicit `tileset.json` tree into typed tiles (bounding volume,
 * geometric error, refine, transform, content URI), inheriting `refine` down the
 * tree as the spec requires. It is the document half of the static one-shot open
 * in `tilesetCloud.ts`, which reads a whole tileset once and merges it into a
 * single cloud. It is not a streaming reader, and nothing here refines against a
 * camera over time.
 *
 * The subset is bounded on purpose, and what falls outside it is refused with a
 * clear error rather than mis-read: implicit tiling, and any `asset.version`
 * outside {@link SUPPORTED_ASSET_VERSIONS}.
 *
 * Two compatibility limits of this subset are known and not yet addressed. The
 * selection downstream identifies content by the URI extension, while 1.1 does
 * not require a content URI to carry one: content may be identified by its magic
 * header, or be JSON. And a tile here carries a single `content`, while 1.1
 * allows `contents[]` with several contents on one tile. Both are documented in
 * docs/supported-formats.md as limits of what opens.
 *
 * Pure: no fetch, no DOM.
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

/**
 * Structural ceilings for a parsed tileset.
 *
 * A `tileset.json` declares its own shape, so every number that sizes work here
 * comes from remote input. Depth bounds the recursion below (and with it the
 * call stack); the tile count bounds the total allocation of a document whose
 * bytes are already capped but whose node count is not proportional to them —
 * a few hundred kilobytes of minified JSON can name a very large tree. Both are
 * refusals, not truncations: a tileset that exceeds either is not partially
 * mounted, because a silently pruned hierarchy renders as a plausible scene
 * with geometry missing.
 */
export const DEFAULT_TILESET_MAX_DEPTH = 24;
export const DEFAULT_TILESET_MAX_TILES = 200_000;

/** Overrides for the structural ceilings {@link parseTileset} enforces. */
export interface TilesetParseLimits {
  /** Deepest tile below the root. Default {@link DEFAULT_TILESET_MAX_DEPTH}. */
  readonly maxDepth?: number;
  /** Total tiles in the tree. Default {@link DEFAULT_TILESET_MAX_TILES}. */
  readonly maxTiles?: number;
}

/** The mutable budget threaded through one parse. */
interface ParseBudget {
  readonly maxDepth: number;
  readonly maxTiles: number;
  tiles: number;
}

/**
 * The `asset.version` values this reader claims to understand.
 *
 * `asset.version` names the schema the rest of the document is written in, and
 * with it the base set of tile formats a reader is expected to handle. This
 * reader implements a bounded subset of 1.0 and 1.1, so a document declaring
 * anything else is refused rather than read as though the fields below meant
 * what they mean in those two versions. A future 3.0 that renames or reuses a
 * field would otherwise parse into a tree that looks valid and is wrong.
 */
export const SUPPORTED_ASSET_VERSIONS = ['1.0', '1.1'] as const;

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

function parseTile(raw: RawTile, inheritedRefine: Refine, depth: number, budget: ParseBudget): Tile {
  if (depth > budget.maxDepth) {
    throw new Error(
      `3D Tiles: tile hierarchy is deeper than ${budget.maxDepth} levels; refusing to parse it.`,
    );
  }
  if (++budget.tiles > budget.maxTiles) {
    throw new Error(
      `3D Tiles: tileset declares more than ${budget.maxTiles} tiles; refusing to parse it.`,
    );
  }
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
  const children = (raw.children ?? []).map((c) => parseTile(c, refine, depth + 1, budget));
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
export function parseTileset(input: string | object, limits: TilesetParseLimits = {}): Tileset {
  const doc = (typeof input === 'string' ? JSON.parse(input) : input) as {
    asset?: { version?: string };
    geometricError?: number;
    root?: RawTile;
  };
  const assetVersion = doc.asset?.version;
  if (typeof assetVersion !== 'string') {
    throw new Error('3D Tiles: tileset.json has no asset.version.');
  }
  if (!(SUPPORTED_ASSET_VERSIONS as readonly string[]).includes(assetVersion)) {
    throw new Error(
      `3D Tiles: tileset.json declares asset.version "${assetVersion}", which is not ` +
        `${SUPPORTED_ASSET_VERSIONS.join(' or ')}.`,
    );
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
  const budget: ParseBudget = {
    maxDepth: limits.maxDepth ?? DEFAULT_TILESET_MAX_DEPTH,
    maxTiles: limits.maxTiles ?? DEFAULT_TILESET_MAX_TILES,
    tiles: 0,
  };
  return {
    assetVersion,
    geometricError: doc.geometricError,
    root: parseTile(doc.root, rootRefine, 0, budget),
  };
}
