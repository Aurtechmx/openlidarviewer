/**
 * pnts.ts — a decoder for the 3D Tiles PNTS (point cloud) tile.
 *
 * A PNTS tile is a 28-byte header, a feature-table JSON + binary, and a
 * batch-table JSON + binary. This reads the header, the feature table's
 * POINTS_LENGTH and optional RTC_CENTER, and the positions: uncompressed
 * float32 POSITION, or uint16 POSITION_QUANTIZED against its quantised volume.
 * It refuses the encodings this subset does not handle — Draco compression,
 * colours, normals, batch ids — with a clear error rather than mis-decoding.
 * Positions are tile-local; a caller adds RTC_CENTER (and the tile transform) to
 * place them. Pure: takes an ArrayBuffer, returns typed arrays.
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

export interface PntsTile {
  readonly version: number;
  readonly pointsLength: number;
  /** Center to add to the tile-local positions, or null. */
  readonly rtcCenter: readonly [number, number, number] | null;
  /** Tile-local xyz, length `pointsLength * 3`. */
  readonly positions: Float32Array;
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

/** Decode a PNTS tile's header, feature table, and positions. */
export function parsePnts(buffer: ArrayBuffer): PntsTile {
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

  const ft = decodeJsonSection(buffer, ftJsonStart, ftJsonLength, 'feature table');
  // The batch table is read for well-formedness only; its properties belong to
  // a caller this decoder does not have yet.
  if (btJsonLength > 0) decodeJsonSection(buffer, btJsonStart, btJsonLength, 'batch table');

  const pointsLength = ft.POINTS_LENGTH;
  if (
    typeof pointsLength !== 'number' ||
    !Number.isInteger(pointsLength) ||
    pointsLength <= 0 ||
    pointsLength > UINT32_MAX
  ) {
    throw new Error('PNTS: POINTS_LENGTH is not a positive uint32.');
  }

  // RTC_CENTER is optional, but a present one cannot be dropped when it is
  // malformed. POSITION holds tile-local coordinates, so a tile that keeps its
  // positions and loses its center renders at the local origin, which for a
  // georeferenced tile is a silent relocation rather than a missing offset.
  const rtcCenter = ft.RTC_CENTER === undefined ? null : vec3(ft.RTC_CENTER, 'RTC_CENTER');

  const components = pointsLength * 3;

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
    return { version, pointsLength, rtcCenter, positions };
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
    return { version, pointsLength, rtcCenter, positions };
  }

  throw new Error('PNTS: feature table has neither POSITION nor POSITION_QUANTIZED.');
}
