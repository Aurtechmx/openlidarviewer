/**
 * pnts.ts — a decoder for the 3D Tiles PNTS (point cloud) tile.
 *
 * A PNTS tile is a 28-byte header, a feature-table JSON + binary, and a
 * batch-table JSON + binary. This reads the header, the feature table's
 * POINTS_LENGTH and optional RTC_CENTER, and the uncompressed float32 POSITION
 * array. It refuses the encodings this subset does not handle — quantised
 * positions, Draco compression — with a clear error rather than mis-decoding.
 * Positions are tile-local; a caller adds RTC_CENTER (and the tile transform) to
 * place them. Pure: takes an ArrayBuffer, returns typed arrays.
 */

const HEADER_BYTES = 28;
const MAGIC = 0x73746e70; // 'pnts' little-endian
/** The only PNTS version this decoder claims to read. */
const SUPPORTED_VERSION = 1;

export interface PntsTile {
  readonly version: number;
  readonly pointsLength: number;
  /** Center to add to the tile-local positions, or null. */
  readonly rtcCenter: readonly [number, number, number] | null;
  /** Tile-local xyz, length `pointsLength * 3`. */
  readonly positions: Float32Array;
}

interface FeatureTableJson {
  POINTS_LENGTH?: number;
  RTC_CENTER?: number[];
  POSITION?: { byteOffset?: number };
  POSITION_QUANTIZED?: unknown;
}

/** Decode a PNTS tile's header, feature table, and uncompressed positions. */
export function parsePnts(buffer: ArrayBuffer): PntsTile {
  const view = new DataView(buffer);
  if (buffer.byteLength < HEADER_BYTES) {
    throw new Error('PNTS: buffer shorter than the 28-byte header.');
  }
  if (view.getUint32(0, true) !== MAGIC) {
    throw new Error('PNTS: bad magic — not a pnts tile.');
  }
  const version = view.getUint32(4, true);
  if (version !== SUPPORTED_VERSION) {
    throw new Error(`PNTS: version ${version} is not supported, only ${SUPPORTED_VERSION}.`);
  }
  const byteLength = view.getUint32(8, true);
  if (byteLength > buffer.byteLength) {
    throw new Error('PNTS: declared byteLength exceeds the buffer.');
  }
  if (byteLength < HEADER_BYTES) {
    throw new Error('PNTS: declared byteLength is shorter than the header.');
  }
  // The DECLARED tile length is the parse boundary, not the buffer. A tile
  // concatenated with trailing bytes would otherwise let a feature table or a
  // POSITION range run past its own tile and read whatever followed it.
  const limit = byteLength;
  const ftJsonLen = view.getUint32(12, true);
  const ftBinLen = view.getUint32(16, true);

  const ftJsonStart = HEADER_BYTES;
  const ftBinStart = ftJsonStart + ftJsonLen;
  if (ftBinStart + ftBinLen > limit) {
    throw new Error('PNTS: feature table extends past the declared tile length.');
  }

  const ftJsonText = new TextDecoder().decode(new Uint8Array(buffer, ftJsonStart, ftJsonLen));
  const ft = JSON.parse(ftJsonText) as FeatureTableJson;

  const pointsLength = ft.POINTS_LENGTH;
  if (typeof pointsLength !== 'number' || !Number.isInteger(pointsLength) || pointsLength < 0) {
    throw new Error('PNTS: feature table has no valid POINTS_LENGTH.');
  }
  if (ft.POSITION_QUANTIZED !== undefined) {
    throw new Error('PNTS: POSITION_QUANTIZED is not supported yet — only float32 POSITION.');
  }
  if (!ft.POSITION || typeof ft.POSITION.byteOffset !== 'number') {
    throw new Error('PNTS: feature table has no float32 POSITION.');
  }
  // A byteOffset is an index into the feature-table binary, so it is a
  // non-negative whole number. Fractional or negative values reach DataView
  // construction and fail there, far from the tile that carried them.
  if (!Number.isSafeInteger(ft.POSITION.byteOffset) || ft.POSITION.byteOffset < 0) {
    throw new Error('PNTS: POSITION.byteOffset is not a non-negative whole number.');
  }

  const rtc = ft.RTC_CENTER;
  const rtcCenter: [number, number, number] | null =
    Array.isArray(rtc) && rtc.length === 3 && rtc.every((n) => typeof n === 'number' && Number.isFinite(n))
      ? [rtc[0], rtc[1], rtc[2]]
      : null;

  const posOffset = ftBinStart + ft.POSITION.byteOffset;
  const need = pointsLength * 3 * 4;
  // Guard the product itself: a POINTS_LENGTH near the safe-integer ceiling
  // makes `need` lose precision, and the range check below would then compare
  // an approximation.
  if (!Number.isSafeInteger(need)) {
    throw new Error(`PNTS: POINTS_LENGTH ${pointsLength} is too large to address.`);
  }
  if (posOffset + need > limit) {
    throw new Error('PNTS: POSITION array extends past the declared tile length.');
  }
  // Copy (POSITION.byteOffset need not be 4-aligned within the buffer, and a
  // Float32Array view requires alignment).
  const positions = new Float32Array(pointsLength * 3);
  const src = new DataView(buffer, posOffset, need);
  for (let i = 0; i < positions.length; i++) positions[i] = src.getFloat32(i * 4, true);

  return { version, pointsLength, rtcCenter, positions };
}
