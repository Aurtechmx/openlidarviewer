/**
 * CopcSource.ts
 *
 * The COPC streaming orchestrator. Given a {@link RangeSource}, it opens a COPC
 * file with **partial reads only** — a head slice for detection and metadata,
 * then the root hierarchy page — and exposes the operations the streaming
 * engine needs: descend to a child hierarchy page, and read a node's compressed
 * chunk. It never reads the whole file.
 *
 * Browser-safe and Node-safe: it holds only a `RangeSource` and pure parsers,
 * so it is unit-tested with an `ArrayBufferRangeSource` over a synthetic COPC.
 */

import type { RangeSource, RangeSourceKind } from '../range/RangeSource';
import { LoadError } from '../loadErrors';
import { detectCopc } from './copcDetect';
import { parseCopcMetadata } from './copcHeader';
import { readLasCrsLocation, resolveLasCrs } from '../crs';
import { parseHierarchyPage } from './copcHierarchy';
import type { HierarchyPage } from './copcHierarchy';
import type {
  CopcMetadata,
  OctreeCube,
  StreamingNodeRecord,
  ChildPageRef,
} from './copcTypes';

/**
 * Bytes read from the file head for detection + metadata.
 *
 *   • Minimum needed: 589 bytes (LAS header 375 + COPC info VLR 54 + 160).
 *   • bumped 4 KB → 16 KB so the same read also captures the
 *     LASF_Projection CRS VLR(s) that immediately follow the COPC info
 *     VLR. CRS detection (`parseCrsFromVlrs`) needs that whole VLR list;
 *     without the bump CRS would silently fail to detect on most files.
 *     Cost: ~12 KB extra over HTTP — negligible vs the latency saved on a
 *     would-be second range request.
 */
const HEAD_BYTES = 16384;

/** An opened COPC file, ready to stream. */
export class CopcSource {
  private readonly _range: RangeSource;
  private readonly _metadata: CopcMetadata;
  private readonly _cube: OctreeCube;
  private readonly _rootPage: HierarchyPage;
  /** Total file size, for refusing hierarchy ranges that point past EOF. */
  private readonly _size: number;

  private constructor(
    range: RangeSource,
    metadata: CopcMetadata,
    cube: OctreeCube,
    rootPage: HierarchyPage,
    size: number,
  ) {
    this._range = range;
    this._metadata = metadata;
    this._cube = cube;
    this._rootPage = rootPage;
    this._size = size;
  }

  /**
   * Open a COPC file over a range source: read the head slice, verify it is
   * COPC, parse the metadata, and load the root hierarchy page. Throws
   * `LoadError` for a non-COPC or malformed file.
   */
  static async open(range: RangeSource, signal?: AbortSignal): Promise<CopcSource> {
    const size = await range.size();
    const head = await range.readRange(0, Math.min(HEAD_BYTES, size), signal);

    const detection = detectCopc(head);
    if (!detection.isCopc) {
      throw new LoadError(
        'unsupported-format',
        `This file is not a COPC file (${detection.reason ?? 'unrecognised'}).`,
      );
    }

    const metadata = parseCopcMetadata(head);
    const cube: OctreeCube = {
      center: metadata.info.center,
      halfsize: metadata.info.halfsize,
    };

    // A range source clamps a read that runs past EOF to the bytes present, so
    // a truncated file would otherwise be parsed silently short and fail far
    // downstream. Refuse it here, where the failure can be named.
    if (metadata.info.rootHierOffset + metadata.info.rootHierSize > size) {
      throw new LoadError(
        'malformed-file',
        `COPC root hierarchy (offset ${metadata.info.rootHierOffset}, ` +
          `${metadata.info.rootHierSize} bytes) runs past the end of the file ` +
          `(${size} bytes) — the file appears truncated.`,
      );
    }

    // A LAS 1.4 writer may put the CRS in an EVLR after the point data; read
    // those records by bounded range reads and let a VLR keep precedence. The
    // walk is skipped when a VLR WKT already decides the CRS, and when the one
    // EVLR is the COPC hierarchy itself. That is decided from the EVLR's own
    // header (user id "copc", record 1000), read beside the root page, since
    // an offset test alone takes a lone WKT EVLR for the hierarchy.
    const location = readLasCrsLocation(head);
    const evlrCount = location?.evlrCount ?? 0;
    const needsCrs = location != null && evlrCount > 0 && !metadata.header.crs?.wkt;
    const { rootHierOffset: rootAt, rootHierSize: rootLen } = metadata.info;
    const evlrAt = needsCrs && evlrCount === 1 ? location.evlrOffset : undefined;
    let rootBuffer: ArrayBuffer;
    let onlyHierarchy = false;
    if (evlrAt != null && rootAt - evlrAt >= 60 && rootAt - evlrAt <= 4096) {
      // The usual layout: the root page follows the EVLR header, so one read covers both.
      const span = await range.readRange(evlrAt, rootAt + rootLen - evlrAt, signal);
      onlyHierarchy = isCopcHierarchyEvlr(span);
      rootBuffer = span.slice(rootAt - evlrAt);
    } else {
      [rootBuffer, onlyHierarchy] = await Promise.all([
        range.readRange(rootAt, rootLen, signal),
        evlrAt != null ? range.readRange(evlrAt, 60, signal).then(isCopcHierarchyEvlr, () => false) : false,
      ]);
    }
    if (needsCrs && !onlyHierarchy) {
      metadata.header.crs = await resolveLasCrs(
        head,
        location.headerSize,
        location.vlrCount,
        location,
        (offset, length) => range.readRange(offset, length, signal),
        size,
      );
    }
    const rootPage = parseHierarchyPage(rootBuffer, cube, metadata.info.spacing);

    return new CopcSource(range, metadata, cube, rootPage, size);
  }

  /** The parsed COPC metadata — LAS header facts and the `info` VLR. */
  get metadata(): CopcMetadata {
    return this._metadata;
  }

  /** The octree cube, for node-bounds math. */
  get cube(): OctreeCube {
    return this._cube;
  }

  /** The parsed root hierarchy page. */
  get rootPage(): HierarchyPage {
    return this._rootPage;
  }

  /** A stable id for the opened source. */
  get id(): string {
    return this._range.id();
  }

  /** Which kind of range source backs this COPC file. */
  get sourceKind(): RangeSourceKind {
    return this._range.kind();
  }

  /** Load and parse a child hierarchy page referenced from a parent page. */
  async loadChildPage(ref: ChildPageRef, signal?: AbortSignal): Promise<HierarchyPage> {
    if (ref.pageOffset + ref.pageSize > this._size) {
      throw new LoadError(
        'malformed-file',
        `COPC child hierarchy page (offset ${ref.pageOffset}, ${ref.pageSize} bytes) ` +
          `points past the end of the file (${this._size} bytes) — the file appears truncated.`,
      );
    }
    const buffer = await this._range.readRange(ref.pageOffset, ref.pageSize, signal);
    return parseHierarchyPage(buffer, this._cube, this._metadata.info.spacing);
  }

  /** Read a node's compressed LAZ chunk bytes — a single partial read. */
  async readNodeChunk(node: StreamingNodeRecord, signal?: AbortSignal): Promise<ArrayBuffer> {
    // A hierarchy entry can be well-formed in isolation yet point outside the
    // file; the range source would clamp the read and hand the decoder a short
    // (or empty) buffer. Refuse the truncated node range with its name instead.
    if (node.byteOffset + node.byteSize > this._size) {
      throw new LoadError(
        'malformed-file',
        `COPC hierarchy entry for node ${node.id} (offset ${node.byteOffset}, ` +
          `${node.byteSize} bytes) points past the end of the file (${this._size} bytes) — ` +
          `the file appears truncated.`,
      );
    }
    return this._range.readRange(node.byteOffset, node.byteSize, signal);
  }

  /** Release the underlying range source. */
  async close(): Promise<void> {
    await this._range.close?.();
  }
}

/** True when a 60-byte EVLR header names the COPC hierarchy (user id "copc", record 1000). */
function isCopcHierarchyEvlr(h: ArrayBuffer): boolean {
  if (h.byteLength < 20) return false;
  const v = new DataView(h);
  let id = '';
  for (let i = 2; i < 18 && v.getUint8(i) !== 0; i++) id += String.fromCharCode(v.getUint8(i));
  return id === 'copc' && v.getUint16(18, true) === 1000;
}
