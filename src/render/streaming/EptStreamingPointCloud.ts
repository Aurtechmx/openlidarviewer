/**
 * EptStreamingPointCloud.ts
 *
 * The EPT analogue of `StreamingPointCloud`. Implements the format-
 * agnostic {@link StreamingSource} interface (`kind: 'ept'`) so the
 * scheduler, renderer, picking path, and Viewer can stream EPT datasets
 * exactly like COPC ones — no code path in those modules needs to know
 * which format it's working with.
 *
 * Construction is async via `open(...)`:
 *   1. The caller fetches `ept.json`, parses + validates it.
 *   2. Calls `EptStreamingPointCloud.open(meta, baseUrl, name, ...)`.
 *   3. The constructor:
 *      • picks a render origin from the EPT cube centre (Float64-stable)
 *      • builds an EptOctree and loads its full hierarchy (cheap — only
 *        the per-node index, not the point data; same cost profile as
 *        the COPC loader)
 *      • returns a ready-to-stream cloud.
 *
 * Tile-data fetches happen on demand through `readNodeChunk`, which the
 * scheduler calls for every wanted node. The HTTP layer is injected as
 * a `TileFetcher` callback so the class stays unit-testable in Node
 * without a live network stack.
 *
 * Supports both `dataType: binary` and `dataType: laszip` end-to-end. The
 * `laszip` branch reuses the cached laz-perf WASM module shared with the
 * COPC path; each EPT laszip tile is a complete LAZ file with its own LAS
 * header (not a raw COPC chunk), and `EptChunkDecoder` dispatches on the
 * source's `dataType` to the right decoder.
 *
 * Pure of three.js; async only through the injected fetchers.
 */

import type {
  Box6,
  StreamingNodeRecord,
} from '../../io/copc/copcTypes';
import type {
  ChunkDecodeMetadata,
  DecodedChunk,
} from '../../io/copc/copcChunkDecode';
import type { NodeCounts } from './StreamingNodeStore';
import type {
  StreamingSource,
  StreamingSourceKind,
} from './StreamingSource';
import type { EptDataType, EptKey, EptMetadata } from '../../io/ept/eptTypes';
import { eptStringToKey } from '../../io/ept/eptTypes';
import { eptHierarchyUrl, eptTileUrl } from '../../io/ept/eptUrls';
import { decodeEptBinaryTile } from '../../io/ept/eptBinaryDecode';
import { EptOctree } from './EptOctree';
import type { CrsInfo } from '../../io/crs';
import { resolveEptCrs } from './eptCrs';

/** The injected HTTP layer — fetch a URL and return its bytes / text. */
export interface EptTransport {
  fetchText: (url: string, signal?: AbortSignal) => Promise<string>;
  fetchBytes: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
}

/**
 * Pick a stable render origin from the EPT cube centre. The COPC version
 * floors the cube centre; we do the same so the precision contract is
 * identical between formats.
 */
function pickRenderOriginFromCube(cube: Box6): [number, number, number] {
  const cx = (cube[0] + cube[3]) / 2;
  const cy = (cube[1] + cube[4]) / 2;
  const cz = (cube[2] + cube[5]) / 2;
  return [Math.floor(cx), Math.floor(cy), Math.floor(cz)];
}

export class EptStreamingPointCloud implements StreamingSource {
  readonly kind: StreamingSourceKind = 'ept';
  readonly name: string;
  readonly renderOrigin: [number, number, number];
  readonly octree: EptOctree;
  readonly metadata: EptMetadata;
  /** Dataset base URL — every tile + hierarchy URL builds from this. */
  readonly baseUrl: string;
  /**
   * Auth query string (e.g. `?token=…`) carried from the manifest URL and
   * re-attached to every derived hierarchy + tile request, so a signed EPT
   * dataset (Azure SAS / CDN token / prefix-scoped credential) keeps its
   * credential past the manifest fetch. `''` for an unsigned dataset.
   */
  private readonly _search: string;
  private readonly _transport: EptTransport;
  /** Dataset-level RGB bit-depth, captured from the first decoded RGB tile;
   *  see {@link noteDecodedRgbDepth}. Undefined until the first colour tile
   *  lands. */
  private _rgbEightBit: boolean | undefined;

  private constructor(
    metadata: EptMetadata,
    baseUrl: string,
    name: string,
    renderOrigin: [number, number, number],
    octree: EptOctree,
    transport: EptTransport,
    search: string,
  ) {
    this.metadata = metadata;
    this.baseUrl = baseUrl;
    this.name = name;
    this.renderOrigin = renderOrigin;
    this.octree = octree;
    this._transport = transport;
    this._search = search;
  }

  /**
   * Open an EPT cloud against an already-parsed manifest + a base URL.
   * Loads the full hierarchy (index only, never point data) before
   * returning so the scheduler can start streaming immediately.
   */
  static async open(
    metadata: EptMetadata,
    baseUrl: string,
    name: string,
    transport: EptTransport,
    signal?: AbortSignal,
    search = '',
  ): Promise<EptStreamingPointCloud> {
    const renderOrigin = pickRenderOriginFromCube(metadata.bounds.cubic as Box6);
    const fetcher = (key: EptKey, s?: AbortSignal): Promise<string> =>
      transport.fetchText(eptHierarchyUrl(baseUrl, key, search), s);
    const octree = new EptOctree(metadata, renderOrigin, fetcher);
    await octree.loadFullHierarchy(signal);
    return new EptStreamingPointCloud(
      metadata, baseUrl, name, renderOrigin, octree, transport, search,
    );
  }

  // ── StreamingSource surface ─────────────────────────────────────────────

  get sourcePointCount(): number {
    return this.metadata.points;
  }

  get residentPointCount(): number {
    return this.octree.store.residentPointCount;
  }

  counts(): NodeCounts {
    return this.octree.store.counts();
  }

  maxDepth(): number {
    let depth = 0;
    for (const node of this.octree.nodes()) {
      if (node.record.key.depth > depth) depth = node.record.key.depth;
    }
    return depth;
  }

  /**
   * format-aware default colour mode. RGB if the schema carries
   * Red / Green / Blue attributes; elevation otherwise. Mirrors the
   * COPC implementation's contract.
   */
  defaultColorMode(): 'rgb' | 'intensity' | 'elevation' | 'classification' | 'normal' {
    return this._hasRgb() ? 'rgb' : 'elevation';
  }

  /**
   * colour modes the EPT cloud can drive. Inspects the schema:
   * RGB requires Red/Green/Blue, Intensity needs Intensity, Classification
   * needs Classification. Elevation is always available (always have X/Y/Z).
   */
  availableColorModes(): readonly ('rgb' | 'intensity' | 'elevation' | 'classification' | 'normal')[] {
    const out: ('rgb' | 'intensity' | 'elevation' | 'classification' | 'normal')[] = [];
    if (this._hasRgb()) out.push('rgb');
    if (this._schemaHas('Intensity')) out.push('intensity');
    out.push('elevation');
    if (this._schemaHas('Classification')) out.push('classification');
    return out;
  }

  /**
   * the CRS extracted from `ept.json`'s `srs` object. Prefers the WKT (richest),
   * then falls back to the authority codes (`horizontal` / `vertical`). When the
   * WKT carries no vertical datum but the codes name one, the vertical datum is
   * merged in — so a streamed dataset surfaces its height datum exactly like an
   * uploaded file. Parsed lazily and cached. Returns `null` for EPTs without a
   * recoverable SRS (raw drone exports often skip it).
   */
  crs(): CrsInfo | null {
    if (this._crsCached !== undefined) return this._crsCached;
    this._crsCached = resolveEptCrs(this.metadata);
    return this._crsCached;
  }

  private _crsCached: CrsInfo | null | undefined = undefined;

  private _hasRgb(): boolean {
    return (
      this._schemaHas('Red') &&
      this._schemaHas('Green') &&
      this._schemaHas('Blue')
    );
  }

  private _schemaHas(name: string): boolean {
    return this.metadata.schema.some((f) => f.name === name);
  }

  /** Local-space cube bounds for camera framing. */
  localBounds(): Box6 {
    const c = this.metadata.bounds.cubic;
    const [rx, ry, rz] = this.renderOrigin;
    return [
      c[0] - rx, c[1] - ry, c[2] - rz,
      c[3] - rx, c[4] - ry, c[5] - rz,
    ];
  }

  /** The tight data AABB (EPT `bounds.conforming`), origin-shifted into local space. */
  dataBounds(): Box6 {
    const c = this.metadata.bounds.conforming;
    const [rx, ry, rz] = this.renderOrigin;
    return [
      c[0] - rx, c[1] - ry, c[2] - rz,
      c[3] - rx, c[4] - ry, c[5] - rz,
    ];
  }

  /**
   * Fetch the tile bytes for one node. The node record's `id` IS the
   * EPT address string `"D-X-Y-Z"`, so we can rebuild the key + URL.
   */
  readNodeChunk(
    record: StreamingNodeRecord,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    const key = eptStringToKey(record.id);
    if (!key) {
      return Promise.reject(
        new Error(`EPT readNodeChunk: bad node id "${record.id}"`),
      );
    }
    const url = eptTileUrl(this.baseUrl, key, this.metadata.dataType, this._search);
    return this._transport.fetchBytes(url, signal);
  }

  /**
   * Build decode metadata for one node. The scheduler hands this to the
   * worker along with the tile bytes; the worker uses it to dispatch on
   * `dataType` and reconstruct positions in render space.
   *
   * For `binary` dataType the scheduler can also call {@link decodeBinary}
   * directly on the main thread (the synthetic fixture path); for
   * `laszip` the per-tile laz-perf decoder is used.
   */
  decodeMeta(record: StreamingNodeRecord): ChunkDecodeMetadata {
    return {
      // EPT doesn't carry the LAS PDRF concept — tiles are pure schema
      // arrays. The decoder uses dataType + schema instead. We set a
      // sentinel PDRF that the worker recognises as "use the EPT path".
      pointDataRecordFormat: -1,
      pointRecordLength: 0,
      pointCount: record.pointCount,
      scale: [1, 1, 1],
      offset: [0, 0, 0],
      renderOrigin: this.renderOrigin,
      // Dataset-level RGB bit-depth, captured from the first decoded RGB
      // tile (noteDecodedRgbDepth) so every later tile narrows colour
      // identically — the same seam the COPC source uses.
      rgbEightBit: this._rgbEightBit,
    };
  }

  /**
   * Capture the RGB bit-depth from the first decoded RGB tile. Once set it is
   * sticky, so a later all-dark tile (whose own max would read as 8-bit)
   * can't flip the cloud's colour depth mid-stream. Same contract as the
   * COPC {@link StreamingSource.noteDecodedRgbDepth} implementation — the
   * scheduler already calls this after every decode.
   */
  noteDecodedRgbDepth(eightBit: boolean | undefined): void {
    if (this._rgbEightBit === undefined && eightBit !== undefined) {
      this._rgbEightBit = eightBit;
    }
  }

  // ── EPT-specific helpers ────────────────────────────────────────────────

  /**
   * Synchronously decode an EPT binary tile against this cloud's schema +
   * render origin. Exposed so the scheduler / tests can decode without
   * the laz-perf worker round-trip on the binary path. `rgbEightBit` is the
   * dataset-level colour bit-depth decision from {@link decodeMeta} —
   * callers routing through `EptChunkDecoder` pass `meta.rgbEightBit`.
   */
  decodeBinary(
    buffer: ArrayBuffer,
    pointCount: number,
    rgbEightBit?: boolean,
  ): DecodedChunk {
    return decodeEptBinaryTile(
      buffer,
      pointCount,
      this.metadata.schema,
      this.renderOrigin,
      rgbEightBit,
    );
  }

  /** The dataset's dataType — `binary` / `laszip` / `zstandard`. */
  get dataType(): EptDataType {
    return this.metadata.dataType;
  }
}
