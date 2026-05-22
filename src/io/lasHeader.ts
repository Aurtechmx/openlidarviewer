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
  /** System Identifier field — often the capture hardware. Trimmed; may be ''. */
  systemIdentifier: string;
  /** Generating Software field — the tool that wrote the file. Trimmed; may be ''. */
  generatingSoftware: string;
  /** File creation day-of-year (1–366), or 0 when the header leaves it unset. */
  creationDay: number;
  /** File creation year, or 0 when the header leaves it unset. */
  creationYear: number;
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
/** System Identifier — 32-byte ASCII field. */
const OFFSET_SYSTEM_IDENTIFIER = 26;
/** Generating Software — 32-byte ASCII field. */
const OFFSET_GENERATING_SOFTWARE = 58;
/** File creation day-of-year — uint16. */
const OFFSET_CREATION_DAY = 90;
/** File creation year — uint16. */
const OFFSET_CREATION_YEAR = 92;
/** Length of the System Identifier and Generating Software char fields. */
const CHAR_FIELD_LENGTH = 32;

const SIGNATURE = 'LASF';
const F64 = 8;
/** Version minor at which the uint64 extended point count appears. */
const LAS_1_4_MINOR = 4;

/**
 * Read a fixed-length ASCII field, stopping at the first NUL and trimming
 * surrounding whitespace. LAS pads these fields with NUL bytes or spaces.
 */
function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

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

  // Provenance fields — present in the header for every LAS version.
  const systemIdentifier = readAscii(view, OFFSET_SYSTEM_IDENTIFIER, CHAR_FIELD_LENGTH);
  const generatingSoftware = readAscii(view, OFFSET_GENERATING_SOFTWARE, CHAR_FIELD_LENGTH);
  const creationDay = view.getUint16(OFFSET_CREATION_DAY, true);
  const creationYear = view.getUint16(OFFSET_CREATION_YEAR, true);

  return {
    pointCount,
    scale,
    offset,
    min,
    max,
    versionMinor,
    systemIdentifier,
    generatingSoftware,
    creationDay,
    creationYear,
  };
}
