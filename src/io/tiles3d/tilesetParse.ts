/**
 * tilesetParse.ts
 *
 * Pure parser for the OGC 3D Tiles `tileset.json` document. No I/O, no
 * three.js, no DOM — unit-testable in Node. The streaming adapter that
 * fetches the file and walks the resulting tree lives in a sibling
 * module; this file just turns a JSON string into a typed `Tileset`
 * value or throws a clear, user-facing `Error`.
 *
 * Spec coverage (1.0):
 *
 *   - Asset block: required `version`, optional `tilesetVersion`
 *   - geometricError: required at the root (the LOD reference)
 *   - root tile: required, walks recursively
 *   - Per-tile: `boundingVolume` (region / box / sphere), `geometricError`,
 *     optional `refine` ('ADD' | 'REPLACE'), optional `transform`,
 *     optional `content` (with `uri` or legacy `url`), optional
 *     `children`.
 *
 * Extensions (e.g. `3DTILES_implicit_tiling`) are deliberately left
 * unparsed for this round; the streaming adapter will surface a
 * `notImplemented` notice when it encounters one. The pure-data shape
 * here is the contract the rest of the platform reads through.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

/** How a tile combines with its children at higher LOD. */
export type TileRefine = 'ADD' | 'REPLACE';

/**
 * Geographic region in radians + metres. Six numbers:
 *
 *   [west, south, east, north, minimumHeight, maximumHeight]
 *
 * West / south / east / north are longitudes and latitudes in radians;
 * heights are metres above the ellipsoid.
 */
export interface BoundingRegion {
  readonly kind: 'region';
  readonly west: number;
  readonly south: number;
  readonly east: number;
  readonly north: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/**
 * Oriented bounding box, 12 numbers per the spec:
 *
 *   [cx, cy, cz, hxx, hxy, hxz, hyx, hyy, hyz, hzx, hzy, hzz]
 *
 * The first three are the centre; the remaining nine define the three
 * half-axes as row vectors.
 */
export interface BoundingBox {
  readonly kind: 'box';
  readonly center: readonly [number, number, number];
  readonly halfAxisX: readonly [number, number, number];
  readonly halfAxisY: readonly [number, number, number];
  readonly halfAxisZ: readonly [number, number, number];
}

/** Bounding sphere: 4 numbers — `[cx, cy, cz, radius]`. */
export interface BoundingSphere {
  readonly kind: 'sphere';
  readonly center: readonly [number, number, number];
  readonly radius: number;
}

export type BoundingVolume = BoundingRegion | BoundingBox | BoundingSphere;

/** A tile's content reference — a URI to a tile asset (.pnts, .b3dm, ...). */
export interface TileContent {
  /** Resolved relative to the parent tileset.json — caller does the URL join. */
  readonly uri: string;
  /** Optional content-specific bounding volume (used by the scheduler to refine culling). */
  readonly boundingVolume?: BoundingVolume;
}

/**
 * A single tile in the tileset hierarchy. The recursive `children` walk
 * is built by `parseTileset`; the streaming scheduler walks the same
 * shape at runtime.
 */
export interface Tile {
  /**
   * Geometric error in pixels at the screen-space projection where the
   * tile should be replaced by its higher-LOD children. Required.
   */
  readonly geometricError: number;
  /** The tile's spatial extent. Required for every interior + leaf tile. */
  readonly boundingVolume: BoundingVolume;
  /**
   * 'REPLACE' (default) → children replace the tile when refined.
   * 'ADD' → children are drawn alongside the tile.
   */
  readonly refine: TileRefine;
  /**
   * Optional 4×4 column-major transform. Composes with the parent's
   * transform when walking the tree. `null` when omitted.
   */
  readonly transform: readonly number[] | null;
  /** Optional content reference. Interior tiles often carry one for coarse fallback. */
  readonly content: TileContent | null;
  /** Child tiles, or empty when this is a leaf. */
  readonly children: readonly Tile[];
}

/** The root document. */
export interface Tileset {
  readonly assetVersion: string;
  readonly tilesetVersion: string | null;
  /** The implicit-LOD scale for the whole tree. Required. */
  readonly geometricError: number;
  /** The root tile. */
  readonly root: Tile;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a tileset.json document. Throws a clear `Error` on anything
 * structurally wrong; the streaming adapter forwards the message into
 * the user-facing toast.
 */
export function parseTileset(text: string): Tileset {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('tileset.json is not valid JSON.');
  }
  if (!isRecord(raw)) {
    throw new Error('tileset.json is empty or not an object.');
  }
  const asset = raw.asset;
  if (!isRecord(asset)) {
    throw new Error('tileset.json is missing the required `asset` block.');
  }
  if (typeof asset.version !== 'string' || asset.version.length === 0) {
    throw new Error('tileset.json `asset.version` is missing or not a string.');
  }
  if (!isFiniteNumber(raw.geometricError)) {
    throw new Error('tileset.json `geometricError` is missing or not a finite number.');
  }
  if (!isRecord(raw.root)) {
    throw new Error('tileset.json `root` is missing or not an object.');
  }
  const root = parseTile(raw.root, 'root');
  return {
    assetVersion: asset.version,
    tilesetVersion:
      typeof asset.tilesetVersion === 'string' && asset.tilesetVersion.length > 0
        ? asset.tilesetVersion
        : null,
    geometricError: raw.geometricError,
    root,
  };
}

function parseTile(node: unknown, path: string): Tile {
  if (!isRecord(node)) {
    throw new Error(`Tile ${path}: expected an object.`);
  }
  if (!isFiniteNumber(node.geometricError)) {
    throw new Error(`Tile ${path}: missing or non-finite \`geometricError\`.`);
  }
  if (!isRecord(node.boundingVolume)) {
    throw new Error(`Tile ${path}: missing \`boundingVolume\`.`);
  }
  const boundingVolume = parseBoundingVolume(node.boundingVolume, `${path}.boundingVolume`);
  const refine = parseRefine(node.refine, path);
  const transform = parseTransform(node.transform, path);
  const content = parseContent(node.content, `${path}.content`);
  const childrenRaw = node.children;
  const children: Tile[] = [];
  if (Array.isArray(childrenRaw)) {
    for (let i = 0; i < childrenRaw.length; i++) {
      children.push(parseTile(childrenRaw[i], `${path}.children[${i}]`));
    }
  } else if (childrenRaw != null) {
    throw new Error(`Tile ${path}: \`children\` must be an array if present.`);
  }
  return {
    geometricError: node.geometricError,
    boundingVolume,
    refine,
    transform,
    content,
    children,
  };
}

function parseBoundingVolume(node: Record<string, unknown>, path: string): BoundingVolume {
  if (isNumberArray(node.region, 6)) {
    const [west, south, east, north, minH, maxH] = node.region;
    return {
      kind: 'region',
      west,
      south,
      east,
      north,
      minHeight: minH,
      maxHeight: maxH,
    };
  }
  if (isNumberArray(node.box, 12)) {
    const b = node.box;
    return {
      kind: 'box',
      center: [b[0], b[1], b[2]],
      halfAxisX: [b[3], b[4], b[5]],
      halfAxisY: [b[6], b[7], b[8]],
      halfAxisZ: [b[9], b[10], b[11]],
    };
  }
  if (isNumberArray(node.sphere, 4)) {
    const s = node.sphere;
    return {
      kind: 'sphere',
      center: [s[0], s[1], s[2]],
      radius: s[3],
    };
  }
  throw new Error(
    `${path}: expected one of region (6 numbers), box (12 numbers), or sphere (4 numbers).`,
  );
}

function parseRefine(v: unknown, path: string): TileRefine {
  if (v === undefined) return 'REPLACE'; // spec default
  if (v === 'ADD' || v === 'REPLACE') return v;
  throw new Error(`Tile ${path}: \`refine\` must be 'ADD' or 'REPLACE' if present.`);
}

function parseTransform(v: unknown, path: string): number[] | null {
  if (v === undefined || v === null) return null;
  if (!isNumberArray(v, 16)) {
    throw new Error(`Tile ${path}: \`transform\` must be a 16-element number array if present.`);
  }
  return [...v];
}

function parseContent(v: unknown, path: string): TileContent | null {
  if (v === undefined || v === null) return null;
  if (!isRecord(v)) {
    throw new Error(`${path}: must be an object if present.`);
  }
  // Spec changed `url` → `uri` in 1.0; we accept both, preferring uri.
  const uri = typeof v.uri === 'string' ? v.uri : typeof v.url === 'string' ? v.url : null;
  if (uri == null || uri.length === 0) {
    throw new Error(`${path}: missing \`uri\` (or legacy \`url\`).`);
  }
  let boundingVolume: BoundingVolume | undefined;
  if (isRecord(v.boundingVolume)) {
    boundingVolume = parseBoundingVolume(v.boundingVolume, `${path}.boundingVolume`);
  }
  return boundingVolume ? { uri, boundingVolume } : { uri };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tree helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Walk every tile in the tileset, root-first (pre-order). */
export function walkTiles(root: Tile, visit: (tile: Tile, depth: number) => void): void {
  function recur(tile: Tile, depth: number): void {
    visit(tile, depth);
    for (const child of tile.children) recur(child, depth + 1);
  }
  recur(root, 0);
}

/** Count every tile in the tileset (root + descendants). */
export function countTiles(root: Tile): number {
  let n = 0;
  walkTiles(root, () => {
    n++;
  });
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNumberArray(v: unknown, expectedLength: number): v is number[] {
  return (
    Array.isArray(v) &&
    v.length === expectedLength &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}
