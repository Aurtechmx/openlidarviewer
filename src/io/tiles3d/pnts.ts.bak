/**
 * pnts.ts — a decoder for the 3D Tiles PNTS (point cloud) tile.
 *
 * A PNTS tile is a 28-byte header, a feature-table JSON + binary, and a
 * batch-table JSON + binary. This reads the header, the feature table's
 * POINTS_LENGTH and optional RTC_CENTER, the positions (uncompressed float32
 * POSITION, or uint16 POSITION_QUANTIZED against its quantised volume), the
 * colours (RGBA, RGB, RGB565, CONSTANT_RGBA), the normals (float32 NORMAL or
 * oct-encoded NORMAL_OCT16P), and the per-point BATCH_ID at each of its three
 * legal component widths, range-checked against BATCH_LENGTH. Positions are
 * tile-local; a caller adds RTC_CENTER (and the tile transform) to place them.
 * Pure: takes an ArrayBuffer, returns typed arrays.
 *
 * What it does not do, stated so the guard and the claim stay the same size.
 * Draco-compressed content — the 3DTILES_draco_point_compression extension, in
 * either JSON section — is refused before a single binary byte is read: the
 * feature-table binary of such a tile is a compressed stream, and reading it as
 * uncompressed arrays returns coordinates rather than an error. Batch-table
 * properties are carried through verbatim, as the JSON object and a copy of the
 * binary section, and are not interpreted: their typed accessors and the
 * hierarchy extension belong to a caller that knows which properties it wants.
 * Nothing here manufactures LAS channels. No PNTS semantic supplies intensity,
 * classification or return number, so the result carries none of them; a caller
 * that wants such a channel maps it from a batch-table property it names.
 *
 * Colour leaves here as sRGB-encoded bytes, three channels per point, which is
 * what `PointCloud.colors` holds and what every other loader in this viewer
 * produces; the one sRGB-to-linear conversion lives at the render upload seam
 * (src/render/colorEncode.ts) and is not this decoder's to apply. PNTS colour
 * channels are already 8-bit, so none of the 16-bit narrowing the LAS path does
 * applies here.
 *
 * The tile's own declared byteLength is the parse boundary, never the buffer's.
 * A tile arrives inside whatever the transport handed over, so a section that
 * is allowed to run to the end of the buffer reads bytes that belong to another
 * tile, or to no tile at all.
 */

const HEADER_BYTES = 28;
const MAGIC = 0x73746e70; // 'pnts' little-endian
/** The only PNTS version this decoder claims to read. */
const SUPPORTED_VERSION = 1;
const UINT32_MAX = 0xffffffff;
/** The divisor the point-cloud format specifies for a quantised component. */
const QUANTIZED_FULL_SCALE = 65535;
/** The widest value one colour channel can carry once decoded. */
const UINT8_MAX = 255;
/** Widest value of the 5-bit red and blue fields of an RGB565 word. */
const RGB565_5BIT_MAX = 31;
/** Widest value of the 6-bit green field of an RGB565 word. */
const RGB565_6BIT_MAX = 63;
/** The widest value one oct16p component can carry before it is decoded. */
const OCT16P_MAX = 255;
/**
 * The component widths a BATCH_ID array may use, and the bytes each one costs.
 * A Map rather than an object literal, so a componentType of `toString` or
 * `constructor` is an unknown width rather than an inherited property.
 */
const BATCH_ID_COMPONENT_BYTES = new Map<string, number>([
  ['UNSIGNED_BYTE', 1],
  ['UNSIGNED_SHORT', 2],
  ['UNSIGNED_INT', 4],
]);
/** The width a BATCH_ID accessor carries when it names no componentType. */
const DEFAULT_BATCH_ID_COMPONENT_TYPE = 'UNSIGNED_SHORT';
/** The tile extension that replaces the feature-table binary with a codec stream. */
const DRACO_EXTENSION = '3DTILES_draco_point_compression';

export interface PntsTile {
  readonly version: number;
  readonly pointsLength: number;
  /** Center to add to the tile-local positions, or null. */
  readonly rtcCenter: readonly [number, number, number] | null;
  /** Tile-local xyz, length `pointsLength * 3`. */
  readonly positions: Float32Array;
  /**
   * Interleaved sRGB rgb bytes, length `pointsLength * 3`, or null when the
   * tile carries no colour at all.
   */
  readonly colors: Uint8Array | null;
  /**
   * Interleaved unit xyz normals, length `pointsLength * 3`, or null when the
   * tile carries no normals.
   */
  readonly normals: Float32Array | null;
  /**
   * One batch id per point, length `pointsLength`, or null when the tile
   * carries no BATCH_ID. Widened to uint32 whichever of the three component
   * widths the tile stored, which is lossless in all three and spares a caller
   * from branching on a width the file has already been checked against.
   */
  readonly batchIds: Uint32Array | null;
  /** The tile's batch table, or null when it carries no batch-table JSON. */
  readonly batchTable: PntsBatchTable | null;
}

/**
 * A batch table as the tile wrote it. Retained rather than decoded: the ids in
 * `PntsTile.batchIds` index its properties, so discarding it would leave those
 * ids pointing at nothing and make this decoder's support for batch ids a
 * support for the numbers alone.
 */
export interface PntsBatchTable {
  /** The batch-table JSON object, uninterpreted. */
  readonly json: Readonly<Record<string, unknown>>;
  /**
   * A copy of the batch-table binary section, empty when the tile has none.
   * Copied rather than viewed: a view would hold the whole tile buffer alive
   * for as long as any caller kept the properties.
   */
  readonly binary: Uint8Array;
}

type JsonObject = Record<string, unknown>;

/** Decode one JSON section: UTF-8 text holding a single object. */
function decodeJsonSection(
  buffer: ArrayBuffer,
  start: number,
  length: number,
  label: string,
): JsonObject {
  let text: string;
  try {
    // `fatal` so an ill-formed byte sequence is refused rather than replaced
    // with U+FFFD, which would turn a corrupt tile into a JSON syntax error
    // that names the wrong problem.
    text = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(buffer, start, length));
  } catch {
    throw new Error(`PNTS: ${label} JSON is not valid UTF-8.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`PNTS: ${label} JSON does not parse.`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`PNTS: ${label} JSON is not an object.`);
  }
  return parsed as JsonObject;
}

/**
 * Read a feature-table accessor's byteOffset. A byteOffset is an index into the
 * feature-table binary, so it is a non-negative whole number. Fractional or
 * negative values reach DataView construction and fail there, far from the tile
 * that carried them.
 */
function accessorByteOffset(descriptor: unknown, name: string): number {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
    throw new Error(`PNTS: ${name} is not a feature-table accessor object.`);
  }
  const byteOffset = (descriptor as { byteOffset?: unknown }).byteOffset;
  if (typeof byteOffset !== 'number' || !Number.isSafeInteger(byteOffset) || byteOffset < 0) {
    throw new Error(`PNTS: ${name}.byteOffset is not a non-negative whole number.`);
  }
  return byteOffset;
}

/** Read a 3-component vector of real numbers from the feature-table JSON. */
function vec3(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) {
    throw new Error(`PNTS: ${name} must have 3 components.`);
  }
  // JSON writes NaN and Infinity as null, so a component is checked for being a
  // number as well as for being finite.
  if (!value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error(`PNTS: ${name} has a component that is not a finite number.`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * Resolve an array's absolute start in the buffer, having checked it lies
 * wholly inside the feature-table binary section.
 */
function arrayStart(
  name: string,
  byteOffset: number,
  components: number,
  bytesPerComponent: number,
  binStart: number,
  binLength: number,
): number {
  const need = components * bytesPerComponent;
  const start = binStart + byteOffset;
  const end = start + need;
  // Guard the arithmetic before it is compared. POINTS_LENGTH is a uint32 and
  // byteOffset only a safe integer, so `end` is the term that can leave the
  // exactly-representable range, and a range check on an approximation decides
  // nothing.
  if (!Number.isSafeInteger(need) || !Number.isSafeInteger(end)) {
    throw new Error(`PNTS: ${name} spans a byte range too large to address exactly.`);
  }
  if (end > binStart + binLength) {
    throw new Error(`PNTS: ${name} extends past the feature-table binary section.`);
  }
  return start;
}

/**
 * Rescale one packed colour field to the full 0-255 range. A field of `max`
 * carries a fraction of full brightness, so the widest value it can hold has to
 * arrive as 255. Shifting the field up to the top of the byte instead leaves
 * the low bits clear and caps the channel at 248 (5-bit) or 252 (6-bit), so a
 * tile that wrote white gets back an off-white it never stored, and the error
 * grows with brightness rather than staying at the quantisation step.
 */
function expandColorField(value: number, max: number): number {
  return Math.round((value * UINT8_MAX) / max);
}

/** Write one rgb triple into an interleaved colour buffer. */
function setRgb(colors: Uint8Array, point: number, r: number, g: number, b: number): void {
  const at = point * 3;
  colors[at] = r;
  colors[at + 1] = g;
  colors[at + 2] = b;
}

/**
 * Read CONSTANT_RGBA, which lives in the feature-table JSON rather than the
 * binary: four bytes that colour every point of the tile the same.
 */
function constantRgba(value: unknown): [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) {
    throw new Error('PNTS: CONSTANT_RGBA must have 4 components.');
  }
  // JSON writes NaN and Infinity as null, so a component is checked for being a
  // number as well as for being a byte.
  const isByte = (n: unknown) =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= UINT8_MAX;
  if (!value.every(isByte)) {
    throw new Error('PNTS: CONSTANT_RGBA has a component that is not a whole number in 0-255.');
  }
  return [value[0] as number, value[1] as number, value[2] as number, value[3] as number];
}

/**
 * Decode whichever colour encoding the tile carries, as sRGB rgb bytes.
 *
 * The format ranks the encodings — RGBA, then RGB, then RGB565, then
 * CONSTANT_RGBA — and a tile may legally carry more than one. The ranking is
 * resolved before anything is read, so a tile with both RGBA and RGB565 is
 * coloured from RGBA whatever the RGB565 array holds. A defect in the chosen
 * encoding is refused: falling through to the next-ranked one would answer a
 * corrupt tile with colours that are not the ones it asked for.
 *
 * The alpha byte of RGBA and CONSTANT_RGBA is validated and then dropped. The
 * viewer's colour buffer is three channels wide, so there is nowhere to carry
 * it; a caller that needs opacity needs a wider buffer first.
 */
function decodeColors(
  ft: JsonObject,
  view: DataView,
  pointsLength: number,
  binStart: number,
  binLength: number,
): Uint8Array | null {
  if (ft.RGBA !== undefined) {
    const byteOffset = accessorByteOffset(ft.RGBA, 'RGBA');
    const start = arrayStart('RGBA', byteOffset, pointsLength * 4, 1, binStart, binLength);
    const colors = new Uint8Array(pointsLength * 3);
    for (let i = 0; i < pointsLength; i++) {
      const at = start + i * 4;
      setRgb(colors, i, view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2));
    }
    return colors;
  }

  if (ft.RGB !== undefined) {
    const byteOffset = accessorByteOffset(ft.RGB, 'RGB');
    const start = arrayStart('RGB', byteOffset, pointsLength * 3, 1, binStart, binLength);
    const colors = new Uint8Array(pointsLength * 3);
    for (let i = 0; i < pointsLength; i++) {
      const at = start + i * 3;
      setRgb(colors, i, view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2));
    }
    return colors;
  }

  if (ft.RGB565 !== undefined) {
    const byteOffset = accessorByteOffset(ft.RGB565, 'RGB565');
    const start = arrayStart('RGB565', byteOffset, pointsLength, 2, binStart, binLength);
    const colors = new Uint8Array(pointsLength * 3);
    for (let i = 0; i < pointsLength; i++) {
      // Read through the DataView rather than a Uint16Array view: byteOffset
      // need not be 2-aligned within the buffer, and the word is little-endian
      // whatever the host is. Red occupies the top 5 bits, green the middle 6,
      // blue the bottom 5.
      const packed = view.getUint16(start + i * 2, true);
      setRgb(
        colors,
        i,
        expandColorField((packed >> 11) & 0x1f, RGB565_5BIT_MAX),
        expandColorField((packed >> 5) & 0x3f, RGB565_6BIT_MAX),
        expandColorField(packed & 0x1f, RGB565_5BIT_MAX),
      );
    }
    return colors;
  }

  if (ft.CONSTANT_RGBA !== undefined) {
    const [r, g, b] = constantRgba(ft.CONSTANT_RGBA);
    const colors = new Uint8Array(pointsLength * 3);
    for (let i = 0; i < pointsLength; i++) setRgb(colors, i, r, g, b);
    return colors;
  }

  return null;
}

/** The sign of a component, counting zero as positive, as oct encoding does. */
function signNotZero(value: number): number {
  return value < 0 ? -1 : 1;
}

/**
 * Decode one oct16p pair into a unit normal.
 *
 * Oct encoding projects the unit sphere onto the octahedron |x| + |y| + |z| = 1
 * and stores the two coordinates of that projection, folding the lower
 * hemisphere outwards into the corners of the square. Decoding undoes the fold
 * and then normalises: the point recovered on the octahedron is a direction but
 * not a unit vector, and the two bytes rarely name a point that was on the
 * sphere to begin with, so an unnormalised result is a normal whose length
 * varies with direction by up to a factor of the square root of 3.
 */
function octDecodeInto(u: number, v: number, out: Float32Array, at: number): void {
  const px = (u / OCT16P_MAX) * 2 - 1;
  const py = (v / OCT16P_MAX) * 2 - 1;
  const z = 1 - Math.abs(px) - Math.abs(py);
  // The fold reads both original magnitudes, so neither is overwritten first.
  const x = z < 0 ? (1 - Math.abs(py)) * signNotZero(px) : px;
  const y = z < 0 ? (1 - Math.abs(px)) * signNotZero(py) : py;
  // On the octahedron |x| + |y| + |z| = 1, so no decoded triple is the zero
  // vector and the division below always has a positive divisor.
  const length = Math.sqrt(x * x + y * y + z * z);
  out[at] = x / length;
  out[at + 1] = y / length;
  out[at + 2] = z / length;
}

/**
 * Decode whichever normal encoding the tile carries.
 *
 * NORMAL outranks NORMAL_OCT16P: the float32 array is the tile's own directions
 * at full precision, and the oct-encoded one is a lossy alternative to it, so a
 * tile carrying both is decoded from the exact array. A float32 NORMAL is
 * copied as written rather than re-normalised — the file's own lengths are the
 * data, and this decoder does not silently rewrite them.
 */
function decodeNormals(
  ft: JsonObject,
  view: DataView,
  pointsLength: number,
  binStart: number,
  binLength: number,
): Float32Array | null {
  if (ft.NORMAL !== undefined) {
    const byteOffset = accessorByteOffset(ft.NORMAL, 'NORMAL');
    const components = pointsLength * 3;
    const start = arrayStart('NORMAL', byteOffset, components, 4, binStart, binLength);
    // Copied rather than viewed, for the alignment reason POSITION is copied.
    const normals = new Float32Array(components);
    for (let i = 0; i < components; i++) normals[i] = view.getFloat32(start + i * 4, true);
    return normals;
  }

  if (ft.NORMAL_OCT16P !== undefined) {
    const byteOffset = accessorByteOffset(ft.NORMAL_OCT16P, 'NORMAL_OCT16P');
    const start = arrayStart('NORMAL_OCT16P', byteOffset, pointsLength * 2, 1, binStart, binLength);
    const normals = new Float32Array(pointsLength * 3);
    for (let i = 0; i < pointsLength; i++) {
      const at = start + i * 2;
      octDecodeInto(view.getUint8(at), view.getUint8(at + 1), normals, i * 3);
    }
    return normals;
  }

  return null;
}

/**
 * Refuse a JSON section that declares Draco point compression.
 *
 * The extension moves POSITION, colour, normals and BATCH_ID into a compressed
 * buffer, leaving the feature-table accessors describing the codec stream
 * rather than the arrays. Every range check in this module would still pass on
 * such a tile, so without this the decoder answers a compressed buffer with
 * plausible float32 garbage and no complaint. The check reads only the JSON,
 * and runs before any binary byte is touched.
 */
function refuseDraco(section: JsonObject): void {
  const extensions = section.extensions;
  if (typeof extensions !== 'object' || extensions === null || Array.isArray(extensions)) return;
  if ((extensions as JsonObject)[DRACO_EXTENSION] !== undefined) {
    throw new Error('PNTS Draco point compression is not supported in this build');
  }
}

/**
 * Decode BATCH_ID, one id per point, against the batch count BATCH_LENGTH.
 *
 * The three legal component widths are read at their own widths, and the
 * default when the accessor names none is UNSIGNED_SHORT — reading a
 * short-width array as bytes would halve the stride and give every point an id
 * belonging to another point, silently and within range.
 *
 * An id at or above BATCH_LENGTH names a batch the table does not have. That is
 * refused rather than clamped: clamping folds two batches into one and reports
 * properties of the wrong feature, which is a worse answer than no answer.
 */
function decodeBatchIds(
  ft: JsonObject,
  view: DataView,
  pointsLength: number,
  binStart: number,
  binLength: number,
): Uint32Array | null {
  if (ft.BATCH_ID === undefined) return null;
  const byteOffset = accessorByteOffset(ft.BATCH_ID, 'BATCH_ID');
  const declared = (ft.BATCH_ID as { componentType?: unknown }).componentType;
  const componentType = declared === undefined ? DEFAULT_BATCH_ID_COMPONENT_TYPE : declared;
  const bytesPerComponent =
    typeof componentType === 'string' ? BATCH_ID_COMPONENT_BYTES.get(componentType) : undefined;
  if (bytesPerComponent === undefined) {
    throw new Error(
      'PNTS: BATCH_ID.componentType must be UNSIGNED_BYTE, UNSIGNED_SHORT, or UNSIGNED_INT.',
    );
  }

  // Checked before the array is read: an id can only be range-checked against a
  // batch count, and a tile with ids and no count has no count to check them
  // against.
  const batchLength = ft.BATCH_LENGTH;
  if (
    typeof batchLength !== 'number' ||
    !Number.isInteger(batchLength) ||
    batchLength <= 0 ||
    batchLength > UINT32_MAX
  ) {
    throw new Error('PNTS: BATCH_ID requires a BATCH_LENGTH that is a positive uint32.');
  }

  const start = arrayStart('BATCH_ID', byteOffset, pointsLength, bytesPerComponent, binStart, binLength);
  const batchIds = new Uint32Array(pointsLength);
  for (let i = 0; i < pointsLength; i++) {
    const at = start + i * bytesPerComponent;
    let id: number;
    if (bytesPerComponent === 1) id = view.getUint8(at);
    else if (bytesPerComponent === 2) id = view.getUint16(at, true);
    else id = view.getUint32(at, true);
    if (id >= batchLength) {
      throw new Error(
        `PNTS: BATCH_ID ${id} at point ${i} is not below BATCH_LENGTH ${batchLength}.`,
      );
    }
    batchIds[i] = id;
  }
  return batchIds;
}

/**
 * The most points this viewer will decode from one PNTS tile.
 *
 * Matches the ceiling the superseded merged read applied to a whole tileset
 * (`MAX_TILESET_POINTS`), which the streaming replacement did not carry over.
 * At the channels {@link PntsTile} expands into, eight million points is about
 * 200 MB of typed arrays before the renderer sees any of it.
 */
export const MAX_PNTS_TILE_POINTS = 8_000_000;

/** Options for {@link parsePnts}. */
export interface ParsePntsOptions {
  /**
   * Ceiling on `POINTS_LENGTH`. Defaults to {@link MAX_PNTS_TILE_POINTS}. A
   * caller on a constrained device can lower it; raising it past what the
   * device can hold moves the failure from a named refusal to an allocation
   * crash.
   */
  readonly maxPoints?: number;
}

/** Decode a PNTS tile's header, feature table, positions, and per-point attributes. */
export function parsePnts(buffer: ArrayBuffer, options: ParsePntsOptions = {}): PntsTile {
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('PNTS: buffer shorter than the 28-byte header.');
  }
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('PNTS: bad magic — not a pnts tile.');
  }
  const version = view.getUint32(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`PNTS: version ${version} is not supported, only ${SUPPORTED_VERSION}.`);
  }
  const byteLength = view.getUint32(8, true);
  if (byteLength < HEADER_BYTES) {
    throw new Error('PNTS: declared byteLength is shorter than the header.');
  }
  if (byteLength > buffer.byteLength) {
    throw new Error('PNTS: declared byteLength exceeds the buffer.');
  }

  const ftJsonLength = view.getUint32(12, true);
  const ftBinLength = view.getUint32(16, true);
  const btJsonLength = view.getUint32(20, true);
  const btBinLength = view.getUint32(24, true);
  // Four uint32 lengths plus the header sum to at most about 1.7e10, exact in a
  // double, so this total cannot be rounded into agreement.
  const sectioned = HEADER_BYTES + ftJsonLength + ftBinLength + btJsonLength + btBinLength;
  if (sectioned > byteLength) {
    throw new Error('PNTS: section lengths overrun the declared byteLength.');
  }
  if (sectioned < byteLength) {
    throw new Error('PNTS: declared byteLength leaves bytes past the last section.');
  }
  // The sections now sum exactly to a declared length that fits the buffer, so
  // every section start and end is in range by construction, and any byte past
  // the declared length belongs to whatever followed this tile.
  const ftJsonStart = HEADER_BYTES;
  const ftBinStart = ftJsonStart + ftJsonLength;
  const btJsonStart = ftBinStart + ftBinLength;

  const btBinStart = btJsonStart + btJsonLength;

  const ft = decodeJsonSection(buffer, ftJsonStart, ftJsonLength, 'feature table');
  // Kept, not just checked: BATCH_ID indexes these properties, so the ids and
  // the table they index have to leave this function together.
  const batchTable =
    btJsonLength > 0
      ? {
          json: decodeJsonSection(buffer, btJsonStart, btJsonLength, 'batch table'),
          binary: new Uint8Array(buffer, btBinStart, btBinLength).slice(),
        }
      : null;

  // Before POINTS_LENGTH, before any accessor, before any binary read: on a
  // Draco tile none of what follows is describing the bytes it thinks it is.
  refuseDraco(ft);
  if (batchTable !== null) refuseDraco(batchTable.json);

  const pointsLength = ft.POINTS_LENGTH;
  if (
    typeof pointsLength !== 'number' ||
    !Number.isInteger(pointsLength) ||
    pointsLength <= 0 ||
    pointsLength > UINT32_MAX
  ) {
    throw new Error('PNTS: POINTS_LENGTH is not a positive uint32.');
  }

  // The magnitude ceiling, before the first allocation. The checks above bound
  // where an accessor may READ; this one bounds what the decode will HOLD, and
  // they are not the same limit. A tile body is capped at 128 MiB, but
  // POSITION_QUANTIZED costs six bytes a point, so that cap admits roughly 22.4
  // million of them, and each becomes a Float32 position plus the intensity,
  // classification, return and GPS channels the generic chunk contract carries.
  // The scheduler cannot pre-empt it either: every tile is admitted as
  // ASSUMED_TILE_POINTS, so a 22-million-point tile is dispatched as though it
  // were 500,000 and the real figure is only known once the arrays exist.
  // Refusing names the tile; truncating would render a silently partial one.
  const maxPoints = options.maxPoints ?? MAX_PNTS_TILE_POINTS;
  if (pointsLength > maxPoints) {
    throw new Error(
      `PNTS: POINTS_LENGTH ${pointsLength} exceeds the ${maxPoints} point ceiling this ` +
        `viewer decodes in one tile.`,
    );
  }

  // RTC_CENTER is optional, but a present one cannot be dropped when it is
  // malformed. POSITION holds tile-local coordinates, so a tile that keeps its
  // positions and loses its center renders at the local origin, which for a
  // georeferenced tile is a silent relocation rather than a missing offset.
  const rtcCenter = ft.RTC_CENTER === undefined ? null : vec3(ft.RTC_CENTER, 'RTC_CENTER');

  const components = pointsLength * 3;

  // Colour, normals and batch ids are resolved before the positions branch, so
  // a tile whose colour or batch-id array overruns its section is refused
  // whichever position encoding it happens to carry.
  const colors = decodeColors(ft, view, pointsLength, ftBinStart, ftBinLength);
  const normals = decodeNormals(ft, view, pointsLength, ftBinStart, ftBinLength);
  const batchIds = decodeBatchIds(ft, view, pointsLength, ftBinStart, ftBinLength);

  // A tile carrying both encodings is decoded from POSITION: the format gives
  // the uncompressed array precedence over the quantised one.
  if (ft.POSITION !== undefined) {
    const byteOffset = accessorByteOffset(ft.POSITION, 'POSITION');
    const start = arrayStart('POSITION', byteOffset, components, 4, ftBinStart, ftBinLength);
    // Copy rather than view: POSITION.byteOffset need not be 4-aligned within
    // the buffer, and a Float32Array view requires alignment. Allocating after
    // the range check keeps a tile that declares four billion points from
    // reserving the memory before it is refused.
    const positions = new Float32Array(components);
    for (let i = 0; i < components; i++) positions[i] = view.getFloat32(start + i * 4, true);
    return { version, pointsLength, rtcCenter, positions, colors, normals, batchIds, batchTable };
  }

  if (ft.POSITION_QUANTIZED !== undefined) {
    const byteOffset = accessorByteOffset(ft.POSITION_QUANTIZED, 'POSITION_QUANTIZED');
    // The volume is what makes the uint16 codes mean anything. Without it the
    // codes are not coordinates at all, so neither member is defaultable.
    if (ft.QUANTIZED_VOLUME_OFFSET === undefined) {
      throw new Error('PNTS: POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET.');
    }
    if (ft.QUANTIZED_VOLUME_SCALE === undefined) {
      throw new Error('PNTS: POSITION_QUANTIZED requires QUANTIZED_VOLUME_SCALE.');
    }
    const volumeOffset = vec3(ft.QUANTIZED_VOLUME_OFFSET, 'QUANTIZED_VOLUME_OFFSET');
    const volumeScale = vec3(ft.QUANTIZED_VOLUME_SCALE, 'QUANTIZED_VOLUME_SCALE');
    const start = arrayStart(
      'POSITION_QUANTIZED',
      byteOffset,
      components,
      2,
      ftBinStart,
      ftBinLength,
    );
    const positions = new Float32Array(components);
    for (let i = 0; i < components; i++) {
      const axis = i % 3;
      const code = view.getUint16(start + i * 2, true);
      // Float64 the whole way, narrowed once on the store. A quantised volume
      // can sit far from the origin, so rounding the scaled code before the
      // offset is added rounds twice and loses a step the format still carries.
      positions[i] = (code * volumeScale[axis]) / QUANTIZED_FULL_SCALE + volumeOffset[axis];
    }
    return { version, pointsLength, rtcCenter, positions, colors, normals, batchIds, batchTable };
  }

  throw new Error('PNTS: feature table has neither POSITION nor POSITION_QUANTIZED.');
}
