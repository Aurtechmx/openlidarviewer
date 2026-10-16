/**
 * PLY loader.
 *
 * Reads a Polygon File Format point cloud with `@loaders.gl/ply`. PLY clouds
 * can carry global survey coordinates — this app's own exporter writes them —
 * so positions are staged in float64 and recentred through the coordinate
 * bridge before the float32 downcast, like every other text loader.
 *
 * loaders.gl narrows every property to float32 during normalisation
 * (`accessors.POSITION = { value: new Float32Array(...) }` unconditionally,
 * whatever the declared type), which would quantise a UTM northing onto a
 * ~0.25 m grid before recentring could save it. The vertex x/y/z are
 * therefore re-read from the file at full float64 precision whenever the
 * layout makes that safe:
 *   - ASCII body: re-scanned from the decoded text.
 *   - `binary_little_endian` / `binary_big_endian` body whose x, y and z
 *     properties are declared `double`: re-read with a `DataView` at the
 *     computed per-vertex byte stride.
 * A binary body declared `float` never held more precision than the loader
 * kept, so it falls back to the loader's values unchanged, as does any
 * layout that leaves the stride ambiguous: a `list` property inside the
 * vertex element (its width is data-dependent), or another element declared
 * before `vertex`.
 */

import { parse } from '@loaders.gl/core';
import { PLYLoader } from '@loaders.gl/ply';
import { LOCAL_ONLY_LOADER_OPTIONS } from './loaderConfig';
import { PointCloud } from '../model/PointCloud';
import { sanitizeAndRecenter, withLoadWarning } from './sanitizeCloud';
import { LoadError } from './loadErrors';
import { authoredNormals } from './authoredNormals';

const PLY_SCALAR_BYTES: Record<string, number> = {
  char: 1, uchar: 1, int8: 1, uint8: 1,
  short: 2, ushort: 2, int16: 2, uint16: 2,
  int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4,
  double: 8, float64: 8,
};

/** Longest header this loader reads; a real PLY header is a few hundred bytes. */
const PLY_HEADER_PROBE_BYTES = 65536;

/**
 * Find the header in the raw bytes. Returns the header text (decoded one byte
 * per character, so string offsets are byte offsets) and the byte offset where
 * the body starts, just past the `end_header` line and its LF or CRLF. Only a
 * line that reads exactly `end_header` (leading whitespace and a trailing CR
 * allowed) ends the header; the word inside a comment or any other line does
 * not. `null` when the probe holds no such line; a file longer than the probe
 * is refused then, since its header (if any) is too long to check.
 */
function locatePlyHeader(buffer: ArrayBuffer): { text: string; bodyOffset: number } | null {
  const probe = new TextDecoder('latin1').decode(
    new Uint8Array(buffer, 0, Math.min(buffer.byteLength, PLY_HEADER_PROBE_BYTES)),
  );
  let lineStart = 0;
  for (;;) {
    const nl = probe.indexOf('\n', lineStart);
    if (nl < 0) break;
    const line = probe.slice(lineStart, nl).replace(/\r$/, '').trimStart();
    if (line === 'end_header') return { text: probe.slice(0, nl + 1), bodyOffset: nl + 1 };
    lineStart = nl + 1;
  }
  if (buffer.byteLength > PLY_HEADER_PROBE_BYTES && probe.startsWith('ply')) {
    throw new LoadError(
      'malformed-file',
      `malformed PLY: no end_header within the first ${PLY_HEADER_PROBE_BYTES} bytes; the header is too long to read.`,
    );
  }
  return null;
}

const END_HEADER_BYTES = Array.from('end_header', (c) => c.charCodeAt(0));

/**
 * True when the ASCII bytes `end_header` occur anywhere at or after `from`.
 * The PLY parser takes its header up to the last `end_header` in the whole
 * file, so any later occurrence would make it read a different header from
 * the one checked here. ASCII bytes decode to themselves under UTF-8, so a
 * byte search finds exactly what the parser's text search would.
 */
function containsEndHeader(buffer: ArrayBuffer, from: number): boolean {
  const bytes = new Uint8Array(buffer);
  const last = bytes.length - END_HEADER_BYTES.length;
  let i = from;
  while (i <= last) {
    i = bytes.indexOf(END_HEADER_BYTES[0], i);
    if (i < 0 || i > last) return false;
    let k = 1;
    while (k < END_HEADER_BYTES.length && bytes[i + k] === END_HEADER_BYTES[k]) k++;
    if (k === END_HEADER_BYTES.length) return true;
    i++;
  }
  return false;
}

/**
 * The buffer to hand the PLY parser, and the byte offset of its body.
 *
 * loaders.gl measures the header in decoded characters and stops it at the
 * first whitespace after `end_header`, then uses that as the byte offset of a
 * binary body. A CRLF header (one byte short) or a non-ASCII comment (a
 * multi-byte character counted once) shifts every binary read. For a binary
 * body whose header is not already plain ASCII with LF line ends, the header
 * is rewritten that way (CR dropped, each non-ASCII byte replaced with `?`)
 * ahead of the original body bytes, so the parser's count and the byte
 * offset agree. Any other input is returned unchanged.
 */
export function plyParseInput(buffer: ArrayBuffer): { buffer: ArrayBuffer; bodyOffset: number | null } {
  const header = locatePlyHeader(buffer);
  if (!header) return { buffer, bodyOffset: null };
  if (!/^format\s+binary_/m.test(header.text)) return { buffer, bodyOffset: header.bodyOffset };
  // eslint-disable-next-line no-control-regex
  const clean = header.text.replace(/\r\n/g, '\n').replace(/[^\x00-\x7f]/g, '?');
  if (clean === header.text) return { buffer, bodyOffset: header.bodyOffset };
  const body = new Uint8Array(buffer, header.bodyOffset);
  const out = new Uint8Array(clean.length + body.length);
  for (let i = 0; i < clean.length; i++) out[i] = clean.charCodeAt(i);
  out.set(body, clean.length);
  return { buffer: out.buffer, bodyOffset: clean.length };
}

/**
 * Refuse a PLY whose element counts cannot fit in its body, before the parser
 * sizes arrays from them. Each element needs at least its fixed-width bytes
 * (a list at least its length prefix) in a binary body, and at least one
 * character plus a separator per property in an ascii one. That floor is a
 * physical bound, so an honest file always passes it. An element with a
 * nonzero count and no properties has no such floor, so it is refused.
 */
function assertPlyCountsPlausible(buffer: ArrayBuffer): void {
  const header = locatePlyHeader(buffer);
  const fail = (why: string): never => {
    throw new LoadError('malformed-file', `malformed PLY: ${why}`);
  };
  if (!header) {
    // No terminator line: the parser reports a missing header, unless the
    // word appears elsewhere and it would take that as the terminator.
    if (containsEndHeader(buffer, 0)) fail('end_header is not on a line of its own.');
    return;
  }
  if (containsEndHeader(buffer, header.bodyOffset)) {
    fail('the body repeats the end_header marker, so the header boundary is ambiguous.');
  }
  const lines = header.text.split(/\r?\n/);
  const ascii = lines.some((l) => /^format\s+ascii\b/.test(l.trim()));
  let minBytes = 0;
  let current: { name: string; count: number; bytes: number } | null = null;
  const close = (): void => {
    if (!current) return;
    if (current.count > 0 && current.bytes === 0) {
      fail(`element ${current.name} declares ${current.count} records but no properties.`);
    }
    minBytes += current.count * current.bytes;
  };
  for (const raw of lines) {
    const tok = raw.trim().split(/\s+/);
    if (tok[0] === 'element') {
      close();
      const count = Number(tok[2]);
      if (!Number.isSafeInteger(count) || count < 0) fail(`invalid ${tok[1]} count "${tok[2]}".`);
      current = { name: tok[1], count, bytes: 0 };
    } else if (tok[0] === 'property' && current) {
      if (ascii) current.bytes += 2;
      else if (tok[1] === 'list') current.bytes += PLY_SCALAR_BYTES[tok[2]] ?? 1;
      else current.bytes += PLY_SCALAR_BYTES[tok[1]] ?? 1;
    }
  }
  close();
  const body = buffer.byteLength - header.bodyOffset;
  // The last ascii record may end without a trailing newline.
  if (minBytes - (ascii ? 1 : 0) > body) {
    fail(`the header declares at least ${minBytes} bytes of records, but the body holds ${body}.`);
  }
}

/** The slice of the loaders.gl PLY header this loader relies on. */
interface PlyHeaderData {
  format?: string;
  headerLength?: number;
  elements?: Array<{
    name: string;
    count: number;
    properties: Array<{ type: string; name: string }>;
  }>;
}

/**
 * Re-read vertex x/y/z from an ASCII PLY body in float64. Returns `null`
 * when the layout rules out a safe re-read — binary body, vertex element
 * not declared first, a list property making the token stride variable, or
 * a token count that does not cover the declared vertices — in which case
 * the caller falls back to the loader's float32 values.
 */
function readAsciiVertices(
  buffer: ArrayBuffer,
  header: PlyHeaderData | undefined,
  expectedCount: number,
): Float64Array | null {
  if (header?.format !== 'ascii') return null;
  if (typeof header.headerLength !== 'number' || header.headerLength <= 0) return null;
  const vertex = header.elements?.[0];
  if (vertex?.name !== 'vertex' || vertex?.count !== expectedCount) return null;
  const props = vertex.properties;
  if (props.some((p) => p.type === 'list')) return null;
  const xi = props.findIndex((p) => p.name === 'x');
  const yi = props.findIndex((p) => p.name === 'y');
  const zi = props.findIndex((p) => p.name === 'z');
  if (xi < 0 || yi < 0 || zi < 0) return null;

  // `headerLength` is measured on the decoded text (the loader decodes the
  // whole buffer the same way), so slicing there lands exactly on the body.
  const body = new TextDecoder().decode(buffer).slice(header.headerLength);
  const stride = props.length;

  // Walk the body once, pulling each record's fields in place. Splitting it into
  // a token array first would materialise `expectedCount × stride` strings — tens
  // of millions for a large ASCII cloud, all live at the same time — where the
  // scanner only ever holds the three it needs for the current record.
  const out = new Float64Array(expectedCount * 3);
  const n = body.length;
  let pos = 0;
  for (let i = 0; i < expectedCount; i++) {
    for (let f = 0; f < stride; f++) {
      while (pos < n && isAsciiSpace(body.charCodeAt(pos))) pos++;
      const start = pos;
      while (pos < n && !isAsciiSpace(body.charCodeAt(pos))) pos++;
      // Ran out of fields before the header's promised count — same refusal the
      // old length check made, just detected as it happens.
      if (start === pos) return null;
      if (f === xi) out[i * 3] = Number(body.slice(start, pos));
      else if (f === yi) out[i * 3 + 1] = Number(body.slice(start, pos));
      else if (f === zi) out[i * 3 + 2] = Number(body.slice(start, pos));
    }
  }
  return out;
}

/** Space, tab, LF, VT, FF, CR — the whitespace an ASCII PLY body separates on. */
function isAsciiSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}

/** Byte width of a fixed-size PLY scalar property type; `null` for `list` (data-dependent, so the record stride cannot be precomputed) or an unrecognised name. */
function fixedPropertySize(type: string): number | null {
  switch (type) {
    case 'char':
    case 'int8':
    case 'uchar':
    case 'uint8':
      return 1;
    case 'short':
    case 'int16':
    case 'ushort':
    case 'uint16':
      return 2;
    case 'int':
    case 'int32':
    case 'uint':
    case 'uint32':
    case 'float':
    case 'float32':
      return 4;
    case 'double':
    case 'float64':
      return 8;
    default:
      return null;
  }
}

/** True for a PLY property type name that spells `double`. */
function isDoubleType(type: string): boolean {
  return type === 'double' || type === 'float64';
}

/**
 * Re-read vertex x/y/z from a `binary_little_endian` / `binary_big_endian`
 * PLY body when x, y and z are all declared `double`. Returns `null` when
 * the layout rules out a safe re-read: an ASCII body, the vertex element not
 * declared first, a `list` property anywhere in the vertex element (its
 * width is data-dependent, so the per-vertex stride cannot be computed up
 * front), x/y/z not all declared `double`, or a body shorter than the
 * header promises. In every such case the caller falls back to the
 * loader's float32 values.
 */
function readBinaryDoubleVertices(
  buffer: ArrayBuffer,
  header: PlyHeaderData | undefined,
  expectedCount: number,
  bodyOffset: number | null,
): Float64Array | null {
  if (header === undefined) return null;
  const littleEndian = header.format === 'binary_little_endian';
  const bigEndian = header.format === 'binary_big_endian';
  if (!littleEndian && !bigEndian) return null;
  // The byte offset found in the raw bytes, not loaders.gl's character count.
  const headerLength = bodyOffset;
  if (headerLength === null || headerLength <= 0) return null;
  const vertex = header.elements?.[0];
  if (vertex?.name !== 'vertex' || vertex?.count !== expectedCount) return null;
  const props = vertex.properties;
  if (props.some((p) => p.type === 'list')) return null;

  const xi = props.findIndex((p) => p.name === 'x');
  const yi = props.findIndex((p) => p.name === 'y');
  const zi = props.findIndex((p) => p.name === 'z');
  if (xi < 0 || yi < 0 || zi < 0) return null;
  if (!isDoubleType(props[xi].type) || !isDoubleType(props[yi].type) || !isDoubleType(props[zi].type)) {
    return null;
  }

  // Byte offset of each property within one vertex record, from its
  // declared type widths in declaration order.
  const offsets: number[] = new Array(props.length);
  let stride = 0;
  for (let i = 0; i < props.length; i++) {
    const size = fixedPropertySize(props[i].type);
    if (size === null) return null;
    offsets[i] = stride;
    stride += size;
  }
  const xOff = offsets[xi];
  const yOff = offsets[yi];
  const zOff = offsets[zi];

  const bodyBytes = expectedCount * stride;
  if (headerLength + bodyBytes > buffer.byteLength) return null;
  const view = new DataView(buffer, headerLength, bodyBytes);

  const out = new Float64Array(expectedCount * 3);
  for (let i = 0; i < expectedCount; i++) {
    const recordOffset = i * stride;
    out[i * 3] = view.getFloat64(recordOffset + xOff, littleEndian);
    out[i * 3 + 1] = view.getFloat64(recordOffset + yOff, littleEndian);
    out[i * 3 + 2] = view.getFloat64(recordOffset + zOff, littleEndian);
  }
  return out;
}

/** True for a PLY scalar type that is one byte wide (copied as stored). */
function isByteType(type: string): boolean {
  return type === 'uchar' || type === 'uint8' || type === 'char' || type === 'int8';
}

/** True for a PLY floating-point scalar type. */
function isFloatType(type: string): boolean {
  return type === 'float' || type === 'float32' || isDoubleType(type);
}

/**
 * Narrow one stored colour value to an 8-bit display byte from its declared
 * PLY type: an integer channel keeps its top 8 bits (a 16-bit 65535 is 255,
 * 32768 is 128), a float or double channel is read as 0..1 and scaled.
 * Negative and out-of-range values clamp to 0..255.
 */
function colourByte(value: number, type: string): number {
  let v: number;
  if (isFloatType(type)) v = Math.round(value * 255);
  else {
    const bits = (fixedPropertySize(type) ?? 1) * 8;
    v = Math.floor(value / 2 ** (bits - 8));
  }
  if (!(v > 0)) return 0;
  return v > 255 ? 255 : v;
}

/**
 * Read the raw values of chosen vertex properties, in float64, from an ASCII
 * or binary PLY body. Returns `null` when the layout rules out a safe re-read
 * (vertex element not declared first, a `list` property, a short body).
 */
function readVertexColumns(
  rawBuffer: ArrayBuffer,
  parseBuffer: ArrayBuffer,
  header: PlyHeaderData | undefined,
  expectedCount: number,
  bodyOffset: number | null,
  columns: readonly number[],
): Float64Array[] | null {
  if (header === undefined) return null;
  const vertex = header.elements?.[0];
  if (vertex?.name !== 'vertex' || vertex?.count !== expectedCount) return null;
  const props = vertex.properties;
  if (props.some((p) => p.type === 'list')) return null;
  const out = columns.map(() => new Float64Array(expectedCount));

  if (header.format === 'ascii') {
    if (typeof header.headerLength !== 'number' || header.headerLength <= 0) return null;
    const body = new TextDecoder().decode(rawBuffer).slice(header.headerLength);
    const slot = new Int32Array(props.length).fill(-1);
    columns.forEach((c, k) => (slot[c] = k));
    const n = body.length;
    let pos = 0;
    for (let i = 0; i < expectedCount; i++) {
      for (let f = 0; f < props.length; f++) {
        while (pos < n && isAsciiSpace(body.charCodeAt(pos))) pos++;
        const start = pos;
        while (pos < n && !isAsciiSpace(body.charCodeAt(pos))) pos++;
        if (start === pos) return null;
        const k = slot[f];
        if (k >= 0) out[k][i] = Number(body.slice(start, pos));
      }
    }
    return out;
  }

  const littleEndian = header.format === 'binary_little_endian';
  if (!littleEndian && header.format !== 'binary_big_endian') return null;
  if (bodyOffset === null || bodyOffset <= 0) return null;
  const offsets: number[] = new Array(props.length);
  let stride = 0;
  for (let i = 0; i < props.length; i++) {
    const size = fixedPropertySize(props[i].type);
    if (size === null) return null;
    offsets[i] = stride;
    stride += size;
  }
  const bodyBytes = expectedCount * stride;
  if (bodyOffset + bodyBytes > parseBuffer.byteLength) return null;
  const view = new DataView(parseBuffer, bodyOffset, bodyBytes);
  const read = (at: number, type: string): number => {
    switch (type) {
      case 'char':
      case 'int8':
        return view.getInt8(at);
      case 'uchar':
      case 'uint8':
        return view.getUint8(at);
      case 'short':
      case 'int16':
        return view.getInt16(at, littleEndian);
      case 'ushort':
      case 'uint16':
        return view.getUint16(at, littleEndian);
      case 'int':
      case 'int32':
        return view.getInt32(at, littleEndian);
      case 'uint':
      case 'uint32':
        return view.getUint32(at, littleEndian);
      case 'float':
      case 'float32':
        return view.getFloat32(at, littleEndian);
      default:
        return view.getFloat64(at, littleEndian);
    }
  };
  for (let i = 0; i < expectedCount; i++) {
    const record = i * stride;
    columns.forEach((c, k) => {
      out[k][i] = read(record + offsets[c], props[c].type);
    });
  }
  return out;
}

/**
 * The 8-bit colours of a PLY whose red/green/blue are not declared as bytes.
 *
 * loaders.gl casts the colour values into a Uint8Array whatever their declared
 * type, so a 16-bit 65535 wraps to 255 and 32768 to 0, and a float 0.5 becomes
 * 0. The raw values are re-read from the body and narrowed by their declared
 * type instead. Returns `undefined` when the colours are bytes (the loader's
 * values are then exact) or the file declares no red/green/blue.
 */
function wideColours(
  rawBuffer: ArrayBuffer,
  parseBuffer: ArrayBuffer,
  header: PlyHeaderData | undefined,
  pointCount: number,
  bodyOffset: number | null,
): Uint8Array | undefined {
  const props = header?.elements?.find((e) => e.name === 'vertex')?.properties;
  if (!props) return undefined;
  const idx = ['red', 'green', 'blue'].map((nm) => props.findIndex((p) => p.name === nm));
  if (idx.some((i) => i < 0)) return undefined;
  const types = idx.map((i) => props[i].type);
  if (types.every(isByteType)) return undefined;
  const raw = readVertexColumns(rawBuffer, parseBuffer, header, pointCount, bodyOffset, idx);
  if (raw === null) {
    throw new LoadError(
      'unsupported-format',
      `PLY colour declared as ${types.join('/')} cannot be read in this file layout; only uchar colour is supported here.`,
    );
  }
  const out = new Uint8Array(pointCount * 3);
  for (let i = 0; i < pointCount; i++) {
    for (let c = 0; c < 3; c++) out[i * 3 + c] = colourByte(raw[c][i], types[c]);
  }
  return out;
}

/**
 * Load a `.ply` point cloud into a `PointCloud`.
 *
 * @param buffer Raw file bytes.
 * @param name   Display name (defaults to `"cloud.ply"`).
 */
export async function loadPly(buffer: ArrayBuffer, name = 'cloud.ply'): Promise<PointCloud> {
  assertPlyCountsPlausible(buffer);
  const input = plyParseInput(buffer);
  const mesh = await parse(input.buffer, PLYLoader, LOCAL_ONLY_LOADER_OPTIONS);
  const attributes = mesh.attributes;

  const positionAttr = attributes.POSITION;
  if (!positionAttr) {
    throw new Error('PLY file has no POSITION attribute');
  }

  const pointCount = positionAttr.value.length / 3;
  const header = mesh.loaderData as PlyHeaderData | undefined;
  // Stage in float64: the ASCII re-read or the binary-double re-read where
  // possible, otherwise the loader's values widened (their float32
  // precision is all the file kept).
  const global =
    positionAttr.value instanceof Float64Array
      ? positionAttr.value
      : (readAsciiVertices(buffer, header, pointCount) ??
        readBinaryDoubleVertices(input.buffer, header, pointCount, input.bodyOffset) ??
        Float64Array.from(positionAttr.value));

  // COLOR_0 is optional. PLY commonly stores rgb (size 3) or rgba (size 4);
  // keep only the three colour channels regardless. Built before sanitation so
  // the colours are filtered by the same index set as the positions.
  // A colour declared wider than a byte is re-read and narrowed by its type;
  // see `wideColours`.
  let colors = attributes.COLOR_0
    ? wideColours(buffer, input.buffer, header, pointCount, input.bodyOffset)
    : undefined;
  const colorAttr = attributes.COLOR_0;
  if (colorAttr && colors === undefined) {
    const componentsPerVertex = colorAttr.size ?? 3;
    const src = colorAttr.value;
    colors = new Uint8Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      colors[i * 3 + 0] = src[i * componentsPerVertex + 0];
      colors[i * 3 + 1] = src[i * componentsPerVertex + 1];
      colors[i * 3 + 2] = src[i * componentsPerVertex + 2];
    }
  }

  // Drop unplaceable vertices (a binary body can hold a NaN bit pattern; an
  // ASCII one can spell it out), then recentre about a floored-min origin.
  // nx/ny/nz, when the vertex element declares them, arrive as NORMAL.
  const normalAttr = attributes.NORMAL;
  const normals = normalAttr ? authoredNormals(normalAttr.value, pointCount, normalAttr.size ?? 3) : undefined;
  const clean = sanitizeAndRecenter(global, { colors, normals });

  return new PointCloud({
    positions: clean.positions,
    colors: clean.attributes.colors,
    normals: clean.attributes.normals,
    origin: clean.origin,
    sourceFormat: 'ply',
    name,
    metadata: withLoadWarning(undefined, clean.warning),
  });
}
