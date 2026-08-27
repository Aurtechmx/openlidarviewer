/**
 * subtree.ts — the `.subtree` binary of 3D Tiles 1.1 implicit tiling.
 *
 * A subtree file is how an implicit tileset states which tiles actually exist.
 * The hierarchy itself is a rule (a subdivision scheme and a root volume), so
 * the only thing a document cannot derive is presence: which of the 4^n or 8^n
 * addressable tiles in a fixed-depth block are real, which of them carry
 * content, and which of them continue into a further subtree. Those three
 * answers are the whole payload.
 *
 * THE CONTAINER. Twenty-four bytes of header — `subt`, a version, then two
 * 64-bit chunk lengths — followed by a JSON chunk and a binary chunk. The JSON
 * chunk names `buffers` and `bufferViews` in the glTF manner, and each of the
 * three availability fields either states a CONSTANT (every tile available, or
 * none) or points at a bufferView holding one bit per tile, LSB-first.
 *
 * A buffer with no `uri` is the file's own binary chunk. A buffer WITH a `uri`
 * lives in a separate file, which is why this module resolves nothing and
 * fetches nothing: {@link subtreeExternalBuffers} reports what a caller must
 * fetch, and {@link resolveSubtreeAvailability} takes the results back. Keeping
 * the fetch outside is what lets the caller put every external buffer through
 * the same URL guards a tile content URI goes through.
 *
 * WHY THE SIZE CHECKS ARE EQUALITIES. The number of bits an availability
 * bitstream must hold is fixed by the subdivision scheme and `subtreeLevels`,
 * both of which the caller supplies from the tile's `implicitTiling`. A
 * bitstream of any other size was written against a different shape, and read
 * against this one it answers every question about the wrong tile: an available
 * tile reported missing, a missing tile reported real. So a disagreement is
 * refused by name rather than tolerated at whichever end happens to fit.
 *
 * Pure: no fetch, no DOM.
 */

import type { Availability, SubdivisionScheme } from './implicitCoordinates';

/** `subt` read as a little-endian uint32 — the first four bytes of the file. */
export const SUBTREE_MAGIC = 0x74627573;
/** The only container version 3D Tiles 1.1 defines. */
export const SUBTREE_VERSION = 1;
/** magic(4) + version(4) + jsonByteLength(8) + binaryByteLength(8). */
export const SUBTREE_HEADER_BYTES = 24;

/**
 * Ceilings, and why each one is here.
 *
 * A subtree document is remote input that describes a tree, so every number in
 * it sizes work. `subtreeLevels` is an exponent: at OCTREE it multiplies the
 * addressable tile count by eight per level, so a two-digit value in a
 * two-hundred-byte document describes more tiles than there are atoms worth
 * allocating. Bounding the exponent first keeps the pow below from reaching
 * Infinity; bounding the resulting tile count second is the limit that actually
 * decides what a reader will allocate. The external-buffer count is bounded
 * because three availability fields need at most three buffers, and a document
 * naming hundreds is naming fetches, not data.
 *
 * All three refuse. None truncates: a subtree read at a shape other than its
 * own answers availability questions about the wrong tiles.
 */
export const MAX_SUBTREE_LEVELS = 24;
export const MAX_TILES_PER_SUBTREE = 1_048_576;
export const MAX_SUBTREE_EXTERNAL_BUFFERS = 8;

/** The shape a subtree is read AT, taken from the tile's `implicitTiling`. */
export interface SubtreeShape {
  readonly scheme: SubdivisionScheme;
  /** Levels one subtree covers, counting its own root as one. */
  readonly subtreeLevels: number;
}

/** An external availability buffer the caller must fetch and hand back. */
export interface SubtreeBufferRequest {
  /** Index into the document's `buffers`, which is the key to return it under. */
  readonly index: number;
  /** The buffer's `uri`, exactly as written. Unresolved and unvalidated here. */
  readonly uri: string;
  /** The document's declared length, for the caller's own byte ceiling. */
  readonly byteLength: number;
}

/** The container, split and structurally checked, before any buffer is read. */
export interface SubtreeDocument {
  /** The parsed JSON chunk. */
  readonly json: SubtreeJson;
  /** The binary chunk, which is the buffer any `buffers` entry without a uri names. */
  readonly binary: Uint8Array;
}

/** The three answers a subtree carries, ready for `isAvailable`. */
export interface SubtreeAvailability {
  /** One bit per tile in the subtree's own levels. */
  readonly tile: Availability;
  /** One bit per tile, or null when the document states no content at all. */
  readonly content: Availability | null;
  /** One bit per child-subtree root, at the level below the subtree's deepest. */
  readonly childSubtree: Availability;
  /** Bits `tile` and `content` cover. */
  readonly tileCount: number;
  /** Bits `childSubtree` covers. */
  readonly childSubtreeCount: number;
}

/** The JSON chunk, as far as this reader interprets it. */
export interface SubtreeJson {
  readonly buffers?: readonly { readonly uri?: string; readonly byteLength?: number }[];
  readonly bufferViews?: readonly {
    readonly buffer?: number;
    readonly byteOffset?: number;
    readonly byteLength?: number;
  }[];
  readonly tileAvailability?: unknown;
  readonly contentAvailability?: unknown;
  readonly childSubtreeAvailability?: unknown;
}

/** Children per tile, restated here so this module needs no import for it. */
function branching(scheme: SubdivisionScheme): number {
  return scheme === 'QUADTREE' ? 4 : 8;
}

/**
 * Tiles one subtree addresses: the full n-ary tree of `subtreeLevels` levels,
 * `(n^levels - 1) / (n - 1)`.
 */
export function subtreeTileCount(shape: SubtreeShape): number {
  assertShape(shape);
  const n = branching(shape.scheme);
  return (n ** shape.subtreeLevels - 1) / (n - 1);
}

/**
 * Child-subtree roots one subtree addresses: the whole level immediately below
 * its deepest, `n^levels`.
 */
export function subtreeChildCount(shape: SubtreeShape): number {
  assertShape(shape);
  return branching(shape.scheme) ** shape.subtreeLevels;
}

function assertShape(shape: SubtreeShape): void {
  const { scheme, subtreeLevels } = shape;
  if (scheme !== 'QUADTREE' && scheme !== 'OCTREE') {
    throw new Error(`3D Tiles subtree: unknown subdivision scheme "${String(scheme)}".`);
  }
  if (!Number.isInteger(subtreeLevels) || subtreeLevels < 1) {
    throw new Error('3D Tiles subtree: subtreeLevels must be an integer of at least 1.');
  }
  if (subtreeLevels > MAX_SUBTREE_LEVELS) {
    throw new Error(
      `3D Tiles subtree: subtreeLevels ${subtreeLevels} is above the ceiling of ` +
        `${MAX_SUBTREE_LEVELS}; refusing to read it.`,
    );
  }
  const n = branching(scheme);
  const tiles = (n ** subtreeLevels - 1) / (n - 1);
  if (tiles > MAX_TILES_PER_SUBTREE) {
    throw new Error(
      `3D Tiles subtree: ${scheme} subtreeLevels ${subtreeLevels} describes ${tiles} tiles, ` +
        `above the ceiling of ${MAX_TILES_PER_SUBTREE}; refusing to read it.`,
    );
  }
}

/** Bytes a bitstream of `bits` bits occupies, LSB-first and byte-aligned. */
function bitstreamBytes(bits: number): number {
  return Math.ceil(bits / 8);
}

/** The four header bytes, printable, so a refusal can say what it actually saw. */
function magicText(bytes: Uint8Array): string {
  return Array.from(bytes.subarray(0, Math.min(4, bytes.length)))
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.'))
    .join('');
}

/**
 * Split a `.subtree` body into its JSON and binary chunks.
 *
 * Every length in the header is remote input, so each is checked against the
 * body that actually arrived before a byte of it is indexed. The two chunk
 * lengths are 64-bit, which JavaScript cannot index with, so they are read as
 * BigInt and refused above the exact-integer range rather than rounded into a
 * plausible-looking offset.
 */
export function readSubtreeDocument(input: ArrayBuffer | Uint8Array): SubtreeDocument {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < SUBTREE_HEADER_BYTES) {
    throw new Error(
      `3D Tiles subtree: the body is ${bytes.byteLength} bytes, shorter than the ` +
        `${SUBTREE_HEADER_BYTES}-byte header.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== SUBTREE_MAGIC) {
    throw new Error(
      `3D Tiles subtree: the body does not start with the "subt" magic (found "${magicText(bytes)}").`,
    );
  }
  const version = view.getUint32(4, true);
  if (version !== SUBTREE_VERSION) {
    throw new Error(
      `3D Tiles subtree: version ${version} is not the version ${SUBTREE_VERSION} this reader understands.`,
    );
  }
  const jsonLength = view.getBigUint64(8, true);
  const binaryLength = view.getBigUint64(16, true);
  const limit = BigInt(Number.MAX_SAFE_INTEGER);
  if (jsonLength > limit || binaryLength > limit) {
    throw new Error('3D Tiles subtree: a declared chunk length is not an exact integer.');
  }
  const jsonBytes = Number(jsonLength);
  const binaryBytes = Number(binaryLength);
  if (jsonBytes === 0) {
    throw new Error('3D Tiles subtree: the JSON chunk is empty.');
  }
  const declared = SUBTREE_HEADER_BYTES + jsonBytes + binaryBytes;
  if (declared > bytes.byteLength) {
    throw new Error(
      `3D Tiles subtree: the header declares ${declared} bytes but the body is ` +
        `${bytes.byteLength}; it is truncated.`,
    );
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    bytes.subarray(SUBTREE_HEADER_BYTES, SUBTREE_HEADER_BYTES + jsonBytes),
  );
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(
      `3D Tiles subtree: the JSON chunk is not valid JSON (${err instanceof Error ? err.message : String(err)}).`,
    );
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('3D Tiles subtree: the JSON chunk is not an object.');
  }
  const binary = bytes.subarray(
    SUBTREE_HEADER_BYTES + jsonBytes,
    SUBTREE_HEADER_BYTES + jsonBytes + binaryBytes,
  );
  return { json: json as SubtreeJson, binary };
}

/**
 * The external buffers this document needs, in `buffers` order.
 *
 * Reported rather than fetched. The caller owns the URL decision, and the URL
 * decision for a 3D Tiles document is not "resolve it": it is the same
 * same-origin, no-credentials, no-directory-escape gate every tile content URI
 * passes through.
 */
export function subtreeExternalBuffers(doc: SubtreeDocument): readonly SubtreeBufferRequest[] {
  const buffers = doc.json.buffers;
  if (buffers === undefined) return [];
  if (!Array.isArray(buffers)) {
    throw new Error('3D Tiles subtree: `buffers` is not an array.');
  }
  const out: SubtreeBufferRequest[] = [];
  buffers.forEach((buffer, index) => {
    if (buffer === null || typeof buffer !== 'object') {
      throw new Error(`3D Tiles subtree: buffers[${index}] is not an object.`);
    }
    const byteLength = buffer.byteLength;
    if (!Number.isInteger(byteLength) || (byteLength as number) < 0) {
      throw new Error(`3D Tiles subtree: buffers[${index}] has no non-negative integer byteLength.`);
    }
    const uri = buffer.uri;
    if (uri === undefined) return;
    if (typeof uri !== 'string' || uri.length === 0) {
      throw new Error(`3D Tiles subtree: buffers[${index}].uri is not a non-empty string.`);
    }
    out.push({ index, uri, byteLength: byteLength as number });
  });
  if (out.length > MAX_SUBTREE_EXTERNAL_BUFFERS) {
    throw new Error(
      `3D Tiles subtree: ${out.length} external buffers is above the ceiling of ` +
        `${MAX_SUBTREE_EXTERNAL_BUFFERS}; refusing to read it.`,
    );
  }
  return out;
}

/** One availability field, before its bitstream (if any) is located. */
type RawAvailability =
  | { readonly kind: 'constant'; readonly value: 0 | 1 }
  | { readonly kind: 'bitstream'; readonly bufferView: number };

/**
 * Read one availability object.
 *
 * 3D Tiles 1.1 spells the bufferView reference `bitstream`. The earlier
 * `3DTILES_implicit_tiling` extension spelled the same field `bufferView`, and
 * the two are not interchangeable to a reader that only knows one of them: a
 * document using the extension spelling would fall through to "declares
 * neither" and be reported as malformed rather than as a format this reader
 * does not implement. So it is named in its own refusal.
 */
function readAvailability(raw: unknown, field: string): RawAvailability {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`3D Tiles subtree: ${field} is not an object.`);
  }
  const obj = raw as { constant?: unknown; bitstream?: unknown; bufferView?: unknown };
  if (obj.bufferView !== undefined && obj.bitstream === undefined) {
    throw new Error(
      `3D Tiles subtree: ${field} uses the 3DTILES_implicit_tiling extension's \`bufferView\` ` +
        'key rather than 1.1\'s `bitstream`; this reader implements 1.1 only.',
    );
  }
  const hasConstant = obj.constant !== undefined;
  const hasBitstream = obj.bitstream !== undefined;
  if (hasConstant && hasBitstream) {
    throw new Error(`3D Tiles subtree: ${field} declares both constant and bitstream.`);
  }
  if (hasConstant) {
    if (obj.constant !== 0 && obj.constant !== 1) {
      throw new Error(`3D Tiles subtree: ${field}.constant is not 0 or 1.`);
    }
    return { kind: 'constant', value: obj.constant };
  }
  if (hasBitstream) {
    if (!Number.isInteger(obj.bitstream) || (obj.bitstream as number) < 0) {
      throw new Error(`3D Tiles subtree: ${field}.bitstream is not a bufferView index.`);
    }
    return { kind: 'bitstream', bufferView: obj.bitstream as number };
  }
  throw new Error(`3D Tiles subtree: ${field} declares neither constant nor bitstream.`);
}

/**
 * Locate the bytes of one bufferView, from the internal chunk or from a buffer
 * the caller fetched, and check that its size is the size this shape needs.
 */
function bitstreamFor(
  doc: SubtreeDocument,
  external: ReadonlyMap<number, Uint8Array>,
  index: number,
  bits: number,
  field: string,
): Uint8Array {
  const views = doc.json.bufferViews;
  if (!Array.isArray(views)) {
    throw new Error(`3D Tiles subtree: ${field} names a bufferView but the document declares none.`);
  }
  const view = views[index];
  if (view === undefined || view === null || typeof view !== 'object') {
    throw new Error(`3D Tiles subtree: ${field} names bufferView ${index}, which does not exist.`);
  }
  const bufferIndex = view.buffer;
  const byteOffset = view.byteOffset ?? 0;
  const byteLength = view.byteLength;
  if (!Number.isInteger(bufferIndex) || (bufferIndex as number) < 0) {
    throw new Error(`3D Tiles subtree: bufferViews[${index}].buffer is not a buffer index.`);
  }
  if (!Number.isInteger(byteOffset) || byteOffset < 0) {
    throw new Error(`3D Tiles subtree: bufferViews[${index}].byteOffset is not a non-negative integer.`);
  }
  if (!Number.isInteger(byteLength) || (byteLength as number) < 0) {
    throw new Error(`3D Tiles subtree: bufferViews[${index}].byteLength is not a non-negative integer.`);
  }
  const need = bitstreamBytes(bits);
  if (byteLength !== need) {
    throw new Error(
      `3D Tiles subtree: ${field} is ${byteLength as number} bytes but the ${bits} tiles it must ` +
        `describe need ${need}; the bitstream disagrees with the subtree's own shape.`,
    );
  }
  const buffers = doc.json.buffers;
  const buffer = Array.isArray(buffers) ? buffers[bufferIndex as number] : undefined;
  if (buffer === undefined) {
    throw new Error(
      `3D Tiles subtree: bufferViews[${index}] names buffer ${bufferIndex as number}, which does not exist.`,
    );
  }
  const source =
    buffer.uri === undefined ? doc.binary : external.get(bufferIndex as number);
  if (source === undefined) {
    throw new Error(
      `3D Tiles subtree: buffer ${bufferIndex as number} is external and was not supplied.`,
    );
  }
  const declared = buffer.byteLength;
  if (Number.isInteger(declared) && (declared as number) > source.byteLength) {
    throw new Error(
      `3D Tiles subtree: buffer ${bufferIndex as number} declares ${declared as number} bytes but ` +
        `${source.byteLength} were available; it is truncated.`,
    );
  }
  if (byteOffset + (byteLength as number) > source.byteLength) {
    throw new Error(
      `3D Tiles subtree: bufferViews[${index}] runs past the end of buffer ${bufferIndex as number}.`,
    );
  }
  return source.subarray(byteOffset, byteOffset + (byteLength as number));
}

/**
 * Turn a read document into the three availability answers, at one shape.
 *
 * `contentAvailability` is 1.1's array form, one entry per content on the tile.
 * This reader serves a single content per tile (`tileset.ts` refuses the
 * `contents` array for the same reason), so an array of more than one entry is
 * refused by name rather than read down to its first element, which would draw
 * part of a tile and report the tileset complete.
 */
export function resolveSubtreeAvailability(
  doc: SubtreeDocument,
  shape: SubtreeShape,
  external: ReadonlyMap<number, Uint8Array> = new Map(),
): SubtreeAvailability {
  const tileCount = subtreeTileCount(shape);
  const childSubtreeCount = subtreeChildCount(shape);

  const build = (raw: RawAvailability, bits: number, field: string): Availability =>
    raw.kind === 'constant'
      ? { constant: raw.value, length: bits }
      : { bitstream: bitstreamFor(doc, external, raw.bufferView, bits, field), length: bits };

  if (doc.json.tileAvailability === undefined) {
    throw new Error('3D Tiles subtree: the document declares no tileAvailability.');
  }
  if (doc.json.childSubtreeAvailability === undefined) {
    throw new Error('3D Tiles subtree: the document declares no childSubtreeAvailability.');
  }
  const tile = build(
    readAvailability(doc.json.tileAvailability, 'tileAvailability'),
    tileCount,
    'tileAvailability',
  );
  const childSubtree = build(
    readAvailability(doc.json.childSubtreeAvailability, 'childSubtreeAvailability'),
    childSubtreeCount,
    'childSubtreeAvailability',
  );

  let content: Availability | null = null;
  const rawContent = doc.json.contentAvailability;
  if (rawContent !== undefined) {
    if (Array.isArray(rawContent)) {
      if (rawContent.length > 1) {
        throw new Error(
          `3D Tiles subtree: contentAvailability declares ${rawContent.length} contents per tile, ` +
            'the 1.1 multi-content form, which this reader does not serve.',
        );
      }
      if (rawContent.length === 1) {
        content = build(
          readAvailability(rawContent[0], 'contentAvailability[0]'),
          tileCount,
          'contentAvailability[0]',
        );
      }
    } else {
      content = build(
        readAvailability(rawContent, 'contentAvailability'),
        tileCount,
        'contentAvailability',
      );
    }
  }

  return { tile, content, childSubtree, tileCount, childSubtreeCount };
}
