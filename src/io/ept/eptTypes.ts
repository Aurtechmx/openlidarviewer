/**
 * eptTypes.ts
 *
 * Strongly-typed shape of an Entwine Point Tile (EPT) metadata document
 * — the `ept.json` file that sits at the root of every EPT dataset and
 * is the dataset's source-of-truth manifest.
 *
 * Reference: https://entwine.io/en/latest/entwine-point-tile.html
 *
 * EPT is an open standard for hierarchical point-cloud streaming. Unlike
 * COPC (which packs everything into a single LAS-compatible file with an
 * octree-indexed VLR), EPT is a directory tree:
 *
 *   <root>/ept.json                  ← this file
 *   <root>/ept-hierarchy/0-0-0-0.json + linked sub-pages
 *   <root>/ept-data/0-0-0-0.laz      ← per-node tiles, one file per node
 *   <root>/ept-sources/*             ← optional source-tracking sidecar
 *
 * Pure types — no I/O, no three.js. Imported as a type-only edge so the
 * EPT module stays out of the initial bundle.
 */

/** The encoding of the per-node tile files. `laszip` is by far the most common. */
export type EptDataType = 'laszip' | 'binary' | 'zstandard';

/** How the hierarchy is split across files. */
export type EptHierarchyType = 'json';

/**
 * The minimum subset of EPT schema fields the viewer needs. Each entry
 * describes one PER-POINT attribute the data tiles will carry — like X,
 * Y, Z, Intensity, Red, Green, Blue, Classification. The `name` is the
 * canonical EPT name; `size` is the byte count per element; `type` is the
 * binary encoding.
 */
export interface EptSchemaField {
  readonly name: string;
  readonly size: number;
  readonly type: 'signed' | 'unsigned' | 'float';
  /** Optional scale factor; applied to integer values to recover a real-world float. */
  readonly scale?: number;
  /** Optional offset; added after scaling. */
  readonly offset?: number;
}

/** The XY/Z extents of the source data and the indexed octree cube. */
export interface EptBounds {
  /** Tight data bounds — `[minX, minY, minZ, maxX, maxY, maxZ]`. */
  readonly conforming: readonly [number, number, number, number, number, number];
  /** Cube bounds — the octree root cube; always `(max - min)` cubed. */
  readonly cubic: readonly [number, number, number, number, number, number];
}

/** The full ept.json shape — what `parseEptMetadata` returns on success. */
export interface EptMetadata {
  /** EPT spec version. only supports versions `1.x` only. */
  readonly version: string;
  /** Tile encoding. */
  readonly dataType: EptDataType;
  /** Hierarchy file format. only supports `json` only. */
  readonly hierarchyType: EptHierarchyType;
  /** Total point count across the whole dataset. */
  readonly points: number;
  /** Recommended points-per-tile for the writer (octree spacing analogue). */
  readonly span: number;
  /** Per-attribute schema describing the binary tile layout. */
  readonly schema: readonly EptSchemaField[];
  /** Source bounds + the octree cube. */
  readonly bounds: EptBounds;
  /** OGC WKT string for the source CRS, when the dataset carries one. */
  readonly srs?: string;
  /**
   * Authority-code CRS from `ept.json`'s `srs` object, when present. EPT may
   * declare its CRS by `horizontal` / `vertical` EPSG codes (with `authority`)
   * INSTEAD OF, or in addition to, a `wkt` string — so a dataset that names its
   * vertical datum only by code is still georeferenced and its datum surfaced.
   */
  readonly srsCodes?: EptSrsCodes;
}

/** Authority-code CRS fields parsed from an EPT `srs` object. */
export interface EptSrsCodes {
  /** CRS authority (typically "EPSG"). */
  readonly authority?: string;
  /** Horizontal CRS code (e.g. 32612). */
  readonly horizontalEpsg?: number;
  /** Vertical (height) datum code (e.g. 5703), when declared. */
  readonly verticalEpsg?: number;
}

/** What `detectEpt` returns on success. */
export interface EptDetectionOk {
  readonly isEpt: true;
  readonly metadata: EptMetadata;
}

/** What `detectEpt` returns when the JSON doesn't look like an EPT manifest. */
export interface EptDetectionFail {
  readonly isEpt: false;
  readonly reason: string;
}

export type EptDetection = EptDetectionOk | EptDetectionFail;

// ─────────────────────────────────────────────────────────────────────────────
// Hierarchy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A node address in the EPT octree.
 *
 * EPT addresses nodes by `D-X-Y-Z`: depth, then x/y/z indices at that
 * depth. The root is `0-0-0-0`. A node at depth D has 8 children at depth
 * `D+1` and coords `(2x[+0/+1], 2y[+0/+1], 2z[+0/+1])`.
 */
export interface EptKey {
  readonly d: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A hierarchy entry — what one EPT hierarchy JSON file contains, keyed by
 * the address string `"D-X-Y-Z"`. The value is either:
 *   • a non-negative integer — the point count in that node's tile; OR
 *   • `-1` — "this subtree continues in a separate hierarchy file"
 *     (load `ept-hierarchy/D-X-Y-Z.json` next).
 */
export type EptHierarchyMap = Readonly<Record<string, number>>;

/** Format the EPT address string a hierarchy uses. */
export function eptKeyToString(k: EptKey): string {
  return `${k.d}-${k.x}-${k.y}-${k.z}`;
}

/** Parse an `"D-X-Y-Z"` hierarchy address back to a typed key. */
export function eptStringToKey(s: string): EptKey | null {
  const m = /^(\d+)-(\d+)-(\d+)-(\d+)$/.exec(s);
  if (!m) return null;
  return {
    d: Number(m[1]),
    x: Number(m[2]),
    y: Number(m[3]),
    z: Number(m[4]),
  };
}
