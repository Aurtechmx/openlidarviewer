/**
 * Minimal parser for the ASPRS LAS public header block.
 *
 * Only the fields needed for bootstrapping a viewer are read: point count,
 * scale, offset, bounds and the version. Byte offsets follow the ASPRS LAS
 * 1.0–1.4 specification (the public header layout is stable across versions
 * for the fields we touch).
 */

/** Parsed subset of the LAS public header block. */
export interface LasHeader {
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  versionMinor: number;
}

// --- ASPRS LAS public-header byte offsets (little-endian) ------------------
/** File signature, must equal the four ASCII chars 'LASF'. */
const OFFSET_SIGNATURE = 0;
/** Version minor — uint8. */
const OFFSET_VERSION_MINOR = 25;
/** Legacy number of point records — uint32 (LAS < 1.4, also a fallback). */
const OFFSET_LEGACY_POINT_COUNT = 107;
/** Scale factor X/Y/Z — three consecutive float64. */
const OFFSET_SCALE = 131;
/** Offset X/Y/Z — three consecutive float64. */
const OFFSET_OFFSET = 155;
/** Bounds are stored MAX-then-MIN per axis, each a float64. */
const OFFSET_MAX_X = 179;
const OFFSET_MIN_X = 187;
const OFFSET_MAX_Y = 195;
const OFFSET_MIN_Y = 203;
const OFFSET_MAX_Z = 211;
const OFFSET_MIN_Z = 219;
/** LAS 1.4 — extended number of point records — uint64. */
const OFFSET_EXTENDED_POINT_COUNT = 247;

const SIGNATURE = 'LASF';
const F64 = 8;
/** Version minor at which the uint64 extended point count appears. */
const LAS_1_4_MINOR = 4;

/** Parse the public header block of a LAS file. */
export function parseLasHeader(buffer: ArrayBuffer): LasHeader {
  const view = new DataView(buffer);

  // Validate the file signature.
  let signature = '';
  for (let i = 0; i < 4; i++) {
    signature += String.fromCharCode(view.getUint8(OFFSET_SIGNATURE + i));
  }
  if (signature !== SIGNATURE) {
    throw new Error(`Not a LAS file: expected signature "${SIGNATURE}", got "${signature}"`);
  }

  const versionMinor = view.getUint8(OFFSET_VERSION_MINOR);

  // Point count: LAS 1.4 carries a uint64; older versions a uint32.
  let pointCount = view.getUint32(OFFSET_LEGACY_POINT_COUNT, true);
  if (versionMinor >= LAS_1_4_MINOR) {
    pointCount = Number(view.getBigUint64(OFFSET_EXTENDED_POINT_COUNT, true));
  }

  const scale: [number, number, number] = [
    view.getFloat64(OFFSET_SCALE, true),
    view.getFloat64(OFFSET_SCALE + F64, true),
    view.getFloat64(OFFSET_SCALE + 2 * F64, true),
  ];

  const offset: [number, number, number] = [
    view.getFloat64(OFFSET_OFFSET, true),
    view.getFloat64(OFFSET_OFFSET + F64, true),
    view.getFloat64(OFFSET_OFFSET + 2 * F64, true),
  ];

  const min: [number, number, number] = [
    view.getFloat64(OFFSET_MIN_X, true),
    view.getFloat64(OFFSET_MIN_Y, true),
    view.getFloat64(OFFSET_MIN_Z, true),
  ];

  const max: [number, number, number] = [
    view.getFloat64(OFFSET_MAX_X, true),
    view.getFloat64(OFFSET_MAX_Y, true),
    view.getFloat64(OFFSET_MAX_Z, true),
  ];

  return { pointCount, scale, offset, min, max, versionMinor };
}
