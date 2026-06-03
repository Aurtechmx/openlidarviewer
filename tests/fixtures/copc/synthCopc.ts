/**
 * synthCopc.ts — synthetic COPC file builder for the test suite.
 *
 * Emits a structurally valid COPC 1.0 `ArrayBuffer`: a LAS 1.4 public header, a
 * COPC `info` VLR at offset 375, placeholder point-data chunks, and a COPC
 * hierarchy EVLR of one or more 32-byte-entry pages.
 *
 * Real LAZ compression is intentionally NOT performed — node chunk bytes are
 * placeholders. Metadata and hierarchy parsing are fully exercised against this
 * fixture; chunk *decoding* is exercised separately through a fake ChunkDecoder
 * and against the real `autzen-classified.copc.laz`.
 *
 * Pure — no DOM, no three.js — runs in Node for the test suite.
 */

/** An octree key — depth, x, y, z. */
export type SynthKey = [number, number, number, number];

/** A node entry in a synthetic hierarchy page. */
export interface SynthNode {
  key: SynthKey;
  /** Points in this node (`> 0` data node, `0` empty node). */
  pointCount: number;
  /** Placeholder compressed chunk size; defaults to 48 bytes. */
  byteSize?: number;
}

/** A synthetic hierarchy page. */
export interface SynthPage {
  /** The octree key this page is rooted at (`[0,0,0,0]` for the root page). */
  pageKey: SynthKey;
  /** Data / empty node entries in this page. */
  nodes: SynthNode[];
  /** Indices (into the `pages` array) of child pages referenced from here. */
  childPages?: number[];
}

/** How to corrupt the output, for malformed-handling tests. */
export type SynthCorruption =
  | 'bad-magic'
  | 'no-copc-vlr'
  | 'truncated-file'
  | 'bad-hierarchy-entry'
  | 'oversized-root-hier';

/** Options for {@link buildSyntheticCopc}. */
export interface SynthCopcOptions {
  pointFormat?: number; // PDRF 6/7/8; default 6
  pointRecordLength?: number; // default by PDRF
  scale?: [number, number, number];
  offset?: [number, number, number];
  center?: [number, number, number];
  halfsize?: number;
  spacing?: number;
  /** Flat node list — wrapped in a single root page. */
  nodes?: SynthNode[];
  /** Explicit multi-page layout; `pages[0]` is the root. Overrides `nodes`. */
  pages?: SynthPage[];
  /** Corruption knob for malformed-handling tests. */
  corrupt?: SynthCorruption;
}

/** The file bytes plus the layout facts a test needs to cross-check a parser. */
export interface SynthCopcResult {
  buffer: ArrayBuffer;
  pointFormat: number;
  pointRecordLength: number;
  pointCount: number;
  rootHierOffset: number;
  rootHierSize: number;
  /** Count of data nodes (`pointCount > 0`) across all pages. */
  dataNodeCount: number;
}

const HEADER_SIZE = 375;
const VLR_HEADER_SIZE = 54;
const EVLR_HEADER_SIZE = 60;
const COPC_INFO_PAYLOAD = 160;
const ENTRY_SIZE = 32;
const CHUNK_PLACEHOLDER_BYTES = 48;

/** Default point record length per PDRF (no extra bytes). */
function defaultRecordLength(pdrf: number): number {
  if (pdrf === 7) return 36;
  if (pdrf === 8) return 38;
  return 30; // PDRF 6
}

interface ResolvedPage {
  page: SynthPage;
  entryCount: number;
  byteSize: number;
  blobOffset: number;
}

/** Build a synthetic COPC file with a known layout. */
export function buildSyntheticCopc(options: SynthCopcOptions = {}): SynthCopcResult {
  const pdrf = options.pointFormat ?? 6;
  const recordLength = options.pointRecordLength ?? defaultRecordLength(pdrf);
  const scale = options.scale ?? [0.01, 0.01, 0.01];
  const offset = options.offset ?? [0, 0, 0];
  const center = options.center ?? [500, 500, 50];
  const halfsize = options.halfsize ?? 512;
  const spacing = options.spacing ?? 10;

  const pages: SynthPage[] = options.pages ?? [
    { pageKey: [0, 0, 0, 0], nodes: options.nodes ?? [{ key: [0, 0, 0, 0], pointCount: 100 }] },
  ];

  // Resolve page sizes and their offsets within the pages blob.
  let blobCursor = 0;
  const resolved: ResolvedPage[] = pages.map((page) => {
    const entryCount = page.nodes.length + (page.childPages?.length ?? 0);
    const byteSize = entryCount * ENTRY_SIZE;
    const r: ResolvedPage = { page, entryCount, byteSize, blobOffset: blobCursor };
    blobCursor += byteSize;
    return r;
  });
  const pagesBlobSize = blobCursor;

  // Lay out one placeholder point-data chunk per data node.
  const pointDataOffset = HEADER_SIZE + VLR_HEADER_SIZE + COPC_INFO_PAYLOAD; // 589
  const chunkFor = new Map<SynthNode, { offset: number; size: number }>();
  let chunkCursor = pointDataOffset;
  let pointCount = 0;
  for (const { page } of resolved) {
    for (const node of page.nodes) {
      if (node.pointCount > 0) {
        const size = node.byteSize ?? CHUNK_PLACEHOLDER_BYTES;
        chunkFor.set(node, { offset: chunkCursor, size });
        chunkCursor += size;
        pointCount += node.pointCount;
      }
    }
  }
  const chunksTotal = chunkCursor - pointDataOffset;

  const evlrHeaderStart = pointDataOffset + chunksTotal;
  const pagesStart = evlrHeaderStart + EVLR_HEADER_SIZE;
  const rootHierOffset = pagesStart + resolved[0].blobOffset;
  const rootHierSize = resolved[0].byteSize;
  const totalSize = pagesStart + pagesBlobSize;

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);

  const writeAscii = (pos: number, text: string, len: number): void => {
    for (let i = 0; i < len; i++) {
      u8[pos + i] = i < text.length ? text.charCodeAt(i) & 0xff : 0;
    }
  };

  // --- LAS 1.4 public header -------------------------------------------------
  writeAscii(0, options.corrupt === 'bad-magic' ? 'XXXX' : 'LASF', 4);
  view.setUint8(24, 1);
  view.setUint8(25, 4);
  writeAscii(26, 'OpenLiDARViewer synth', 32);
  writeAscii(58, 'synthCopc', 32);
  view.setUint16(94, HEADER_SIZE, true);
  view.setUint32(96, pointDataOffset, true);
  view.setUint32(100, 1, true); // one VLR — the COPC info VLR
  view.setUint8(104, pdrf);
  view.setUint16(105, recordLength, true);
  view.setUint32(107, pointCount > 0xffffffff ? 0 : pointCount, true);
  view.setFloat64(131, scale[0], true);
  view.setFloat64(139, scale[1], true);
  view.setFloat64(147, scale[2], true);
  view.setFloat64(155, offset[0], true);
  view.setFloat64(163, offset[1], true);
  view.setFloat64(171, offset[2], true);
  view.setFloat64(179, center[0] + halfsize, true); // max x
  view.setFloat64(187, center[0] - halfsize, true); // min x
  view.setFloat64(195, center[1] + halfsize, true);
  view.setFloat64(203, center[1] - halfsize, true);
  view.setFloat64(211, center[2] + halfsize, true);
  view.setFloat64(219, center[2] - halfsize, true);
  view.setBigUint64(235, BigInt(evlrHeaderStart), true);
  view.setUint32(243, 1, true); // one EVLR — the COPC hierarchy
  view.setBigUint64(247, BigInt(pointCount), true);

  // --- COPC info VLR (header at 375, payload at 429) -------------------------
  writeAscii(377, options.corrupt === 'no-copc-vlr' ? 'LASF_Spec' : 'copc', 16);
  view.setUint16(393, 1, true);
  view.setUint16(395, COPC_INFO_PAYLOAD, true);
  writeAscii(397, 'COPC info', 32);

  let p = HEADER_SIZE + VLR_HEADER_SIZE;
  view.setFloat64(p, center[0], true);
  view.setFloat64(p + 8, center[1], true);
  view.setFloat64(p + 16, center[2], true);
  view.setFloat64(p + 24, halfsize, true);
  view.setFloat64(p + 32, spacing, true);
  view.setBigUint64(p + 40, BigInt(rootHierOffset), true);
  view.setBigUint64(
    p + 48,
    BigInt(options.corrupt === 'oversized-root-hier' ? rootHierSize + 320 : rootHierSize),
    true,
  );
  view.setFloat64(p + 56, 0, true);
  view.setFloat64(p + 64, 0, true);

  // --- COPC hierarchy EVLR ---------------------------------------------------
  p = evlrHeaderStart;
  writeAscii(p + 2, 'copc', 16);
  view.setUint16(p + 18, 1000, true);
  view.setBigUint64(p + 20, BigInt(pagesBlobSize), true);
  writeAscii(p + 28, 'COPC hierarchy', 32);

  // --- Hierarchy page entries ------------------------------------------------
  resolved.forEach((rp, pageIndex) => {
    let entryPos = pagesStart + rp.blobOffset;
    const writeEntry = (
      key: SynthKey,
      entryOffset: number,
      byteSize: number,
      count: number,
    ): void => {
      view.setInt32(entryPos, key[0], true);
      view.setInt32(entryPos + 4, key[1], true);
      view.setInt32(entryPos + 8, key[2], true);
      view.setInt32(entryPos + 12, key[3], true);
      view.setBigInt64(entryPos + 16, BigInt(entryOffset), true);
      view.setInt32(entryPos + 24, byteSize, true);
      view.setInt32(entryPos + 28, count, true);
      entryPos += ENTRY_SIZE;
    };

    for (const node of rp.page.nodes) {
      if (node.pointCount > 0) {
        const chunk = chunkFor.get(node)!;
        // A negative offset on a data entry exercises malformed handling.
        const off =
          options.corrupt === 'bad-hierarchy-entry' && pageIndex === 0 ? -1 : chunk.offset;
        writeEntry(node.key, off, chunk.size, node.pointCount);
      } else {
        writeEntry(node.key, 0, 0, 0); // empty node
      }
    }
    for (const childIndex of rp.page.childPages ?? []) {
      const sub = resolved[childIndex];
      writeEntry(
        sub.page.pageKey,
        pagesStart + sub.blobOffset,
        sub.byteSize,
        -1, // child-page reference
      );
    }
  });

  const dataNodeCount = chunkFor.size;
  const finalBuffer =
    options.corrupt === 'truncated-file' ? buffer.slice(0, 420) : buffer;

  return {
    buffer: finalBuffer,
    pointFormat: pdrf,
    pointRecordLength: recordLength,
    pointCount,
    rootHierOffset,
    rootHierSize,
    dataNodeCount,
  };
}
