/**
 * tileStore.ts — the persistent shape of an out-of-core index.
 *
 * The indexer produces leaves and their tiles; a store makes that durable and
 * navigable. It is three things: a `manifest` (the global facts — bounds, the
 * octree root and depth, the record schema, the point and leaf counts), a
 * plaintext `hierarchy` (one line per leaf, `key count`), and the per-leaf tile
 * blobs the indexer already wrote by key. The split matters: a reader parses the
 * manifest and the hierarchy to know the whole tree, which leaves exist and how
 * many points each holds, WITHOUT reading a single tile, and pulls a tile only
 * when its points are actually wanted.
 *
 * Both text artifacts are parsed, not cast: a stored file can be edited or
 * truncated, so {@link parseTileManifest} and {@link parseHierarchy} fail closed
 * on anything that does not describe a consistent store. Pure — no I/O; the
 * caller reads and writes the blobs through a store of its choice.
 */
import { octreeGridOf, type Cube, type OctreeGrid } from './octreeGrid';
import { readTileRecord, tileRecordBytes, type TilePoint, type TileSchema } from './tileRecord';
import type { OocIndex } from './oocIndexer';

/** Bumped when the manifest or hierarchy format changes meaning. */
export const TILE_STORE_SCHEMA_VERSION = 2;

export interface TileManifest {
  readonly schemaVersion: number;
  readonly pointCount: number;
  readonly recordBytes: number;
  readonly schema: TileSchema;
  /**
   * The world coordinate every stored position is relative to — the recentring
   * origin the LAS reader used. Tile positions are float32, so the store cannot
   * hold world coordinates directly; without this the reader would present
   * source-local numbers as world ones, which for a projected CRS is an error of
   * whole map units. A consumer adds it back to recover world coordinates.
   */
  readonly origin: [number, number, number];
  readonly bounds: { readonly min: [number, number, number]; readonly max: [number, number, number] };
  /** The octree root cube; with `depth` it rebuilds the exact grid the build used. */
  readonly root: Cube;
  readonly depth: number;
  readonly leafCount: number;
}

export interface TileStoreLeaf {
  readonly key: string;
  readonly pointCount: number;
}

/** The empty root key has no printable token, so it is written as `-`. */
const ROOT_TOKEN = '-';

/**
 * Build the manifest and hierarchy text for an index whose tiles use `schema`.
 * `origin` is the recentring origin the point source used, carried into the
 * manifest so world coordinates can be recovered from the stored float32.
 */
export function buildTileStore(
  index: OocIndex,
  schema: TileSchema,
  origin: readonly [number, number, number],
): { manifest: TileManifest; manifestJson: string; hierarchy: string } {
  if (tileRecordBytes(schema) !== index.recordBytes) {
    throw new Error(
      `tileStore: schema is ${tileRecordBytes(schema)} bytes but the index records are ${index.recordBytes}`,
    );
  }
  const manifest: TileManifest = {
    schemaVersion: TILE_STORE_SCHEMA_VERSION,
    pointCount: index.pointCount,
    recordBytes: index.recordBytes,
    schema: { hasGps: schema.hasGps, hasRgb: schema.hasRgb },
    origin: [origin[0], origin[1], origin[2]],
    bounds: {
      min: [index.bounds.min[0], index.bounds.min[1], index.bounds.min[2]],
      max: [index.bounds.max[0], index.bounds.max[1], index.bounds.max[2]],
    },
    root: { min: [index.grid.root.min[0], index.grid.root.min[1], index.grid.root.min[2]], size: index.grid.root.size },
    depth: index.grid.depth,
    leafCount: index.leaves.length,
  };
  const hierarchy =
    index.leaves.map((l) => `${l.key === '' ? ROOT_TOKEN : l.key} ${l.pointCount}`).join('\n') + '\n';
  return { manifest, manifestJson: JSON.stringify(manifest, null, 2) + '\n', hierarchy };
}

function fail(message: string): never {
  throw new Error(`tileStore: ${message}`);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function finite(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${what} must be a finite number, got ${JSON.stringify(value)}`);
  return value;
}

function nonNegativeInt(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) fail(`${what} must be a non-negative integer, got ${JSON.stringify(value)}`);
  return value;
}

function triple(value: unknown, what: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) fail(`${what} must be a 3-number array`);
  return [finite(value[0], `${what}[0]`), finite(value[1], `${what}[1]`), finite(value[2], `${what}[2]`)];
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') fail(`${what} must be a boolean`);
  return value;
}

export function parseTileManifest(input: unknown): TileManifest {
  const m = asRecord(input, 'manifest');
  if (m.schemaVersion !== TILE_STORE_SCHEMA_VERSION) {
    fail(`schema version ${JSON.stringify(m.schemaVersion)} is not ${TILE_STORE_SCHEMA_VERSION}`);
  }
  const schemaRec = asRecord(m.schema, 'schema');
  const schema: TileSchema = { hasGps: bool(schemaRec.hasGps, 'schema.hasGps'), hasRgb: bool(schemaRec.hasRgb, 'schema.hasRgb') };
  const recordBytes = nonNegativeInt(m.recordBytes, 'recordBytes');
  if (recordBytes !== tileRecordBytes(schema)) {
    fail(`recordBytes ${recordBytes} does not match the ${tileRecordBytes(schema)} the schema implies`);
  }
  const boundsRec = asRecord(m.bounds, 'bounds');
  const rootRec = asRecord(m.root, 'root');
  return {
    schemaVersion: TILE_STORE_SCHEMA_VERSION,
    pointCount: nonNegativeInt(m.pointCount, 'pointCount'),
    recordBytes,
    schema,
    origin: triple(m.origin, 'origin'),
    bounds: { min: triple(boundsRec.min, 'bounds.min'), max: triple(boundsRec.max, 'bounds.max') },
    root: { min: triple(rootRec.min, 'root.min'), size: finite(rootRec.size, 'root.size') },
    depth: nonNegativeInt(m.depth, 'depth'),
    leafCount: nonNegativeInt(m.leafCount, 'leafCount'),
  };
}

/** Parse the hierarchy text into leaves, without touching any tile. */
export function parseHierarchy(text: string): TileStoreLeaf[] {
  const leaves: TileStoreLeaf[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const sep = line.lastIndexOf(' ');
    if (sep < 0) fail(`hierarchy line ${i + 1} is not "key count": ${JSON.stringify(line)}`);
    const token = line.slice(0, sep);
    const count = Number(line.slice(sep + 1));
    if (!Number.isInteger(count) || count < 0) fail(`hierarchy line ${i + 1} has a bad count: ${JSON.stringify(line)}`);
    const key = token === ROOT_TOKEN ? '' : token;
    if (key !== '' && !/^[0-7]+$/.test(key)) fail(`hierarchy line ${i + 1} has a bad key: ${JSON.stringify(token)}`);
    leaves.push({ key, pointCount: count });
  }
  return leaves;
}

/**
 * Reads a stored index. Built from the parsed manifest and hierarchy alone, it
 * knows the whole tree and every leaf's count without a tile read; tiles are
 * decoded only when {@link decodeTile} is called with their bytes.
 */
export class TileStoreReader {
  readonly manifest: TileManifest;
  readonly grid: OctreeGrid;
  private readonly countByKey: Map<string, number>;

  constructor(manifest: TileManifest, leaves: readonly TileStoreLeaf[]) {
    this.manifest = manifest;
    this.grid = octreeGridOf(manifest.root, manifest.depth);
    this.countByKey = new Map(leaves.map((l) => [l.key, l.pointCount]));
  }

  get schema(): TileSchema {
    return this.manifest.schema;
  }
  get recordBytes(): number {
    return this.manifest.recordBytes;
  }

  /** Every leaf key and count, no tile read. */
  leaves(): TileStoreLeaf[] {
    return [...this.countByKey].map(([key, pointCount]) => ({ key, pointCount }));
  }

  cubeFor(key: string): Cube {
    return this.grid.cubeFor(key);
  }

  pointCountOf(key: string): number {
    return this.countByKey.get(key) ?? 0;
  }

  /** Decode a leaf tile's bytes into points. */
  decodeTile(bytes: Uint8Array): TilePoint[] {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = Math.floor(bytes.byteLength / this.manifest.recordBytes);
    const out: TilePoint[] = [];
    for (let i = 0; i < n; i++) {
      out.push(readTileRecord(view, i * this.manifest.recordBytes, this.manifest.schema));
    }
    return out;
  }
}
