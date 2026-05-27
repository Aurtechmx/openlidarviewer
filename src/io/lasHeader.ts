/**
 * Minimal parser for the ASPRS LAS public header block.
 *
 * Only the fields needed for bootstrapping a viewer are read: point count,
 * scale, offset, bounds and the version. Byte offsets follow the ASPRS LAS
 * 1.0–1.4 specification (the public header layout is stable across versions
 * for the fields we touch).
 */

import type { PointAttributes } from './loadPlan';
import { parseCrsFromVlrs } from './crs';
import type { CrsInfo } from './crs';

/** Parsed subset of the LAS public header block. */
export interface LasHeader {
  pointCount: number;
  scale: [number, number, number];
  offset: [number, number, number];
  min: [number, number, number];
  max: [number, number, number];
  versionMinor: number;
  /** Point data record format id (0–10); the LAZ compression bit is masked off. */
  pointFormat: number;
  /** Byte offset from the file start to the first point record. */
  offsetToPointData: number;
  /** Length of one point record, in bytes. */
  pointDataRecordLength: number;
  /** System Identifier field — often the capture hardware. Trimmed; may be ''. */
  systemIdentifier: string;
  /** Generating Software field — the tool that wrote the file. Trimmed; may be ''. */
  generatingSoftware: string;
  /** File creation day-of-year (1–366), or 0 when the header leaves it unset. */
  creationDay: number;
  /** File creation year, or 0 when the header leaves it unset. */
  creationYear: number;
  /**
   * Coordinate Reference System parsed from the LAS variable-length records
   * (LASF_Projection user ID). `null` when:
   *   • the buffer didn't include the VLRs (header-only head-slice path), or
   *   • no LASF_Projection VLR is present (common for raw / unreferenced
   *     drone exports).
   * Research-grade users rely on this for unit detection (metres vs feet)
   * and CRS identification. Surfaced in the Scan Intelligence panel + the
   * scan-report card; the parser is in `src/io/crs.ts`.
   */
  crs: CrsInfo | null;
}

// --- ASPRS LAS public-header byte offsets (little-endian) ------------------
/** File signature, must equal the four ASCII chars 'LASF'. */
const OFFSET_SIGNATURE = 0;
/** Version minor — uint8. */
const OFFSET_VERSION_MINOR = 25;
/** Offset to the first point record — uint32. */
const OFFSET_TO_POINT_DATA = 96;
/** Point data record format id — uint8 (the high bit flags LAZ compression). */
const OFFSET_POINT_FORMAT = 104;
/** Point data record length — uint16. */
const OFFSET_POINT_RECORD_LENGTH = 105;
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
/** Header size in bytes — uint16. VLRs begin at this offset. */
const OFFSET_HEADER_SIZE = 94;
/** Number of variable-length records — uint32. */
const OFFSET_NUM_VLR = 100;
/** Length of the System Identifier and Generating Software char fields. */
const CHAR_FIELD_LENGTH = 32;

const SIGNATURE = 'LASF';
const F64 = 8;
/** Version minor at which the uint64 extended point count appears. */
const LAS_1_4_MINOR = 4;
/** Smallest buffer that can hold every public-header field this parser reads. */
const MIN_PUBLIC_HEADER_BYTES = 227;
/** LAS 1.4 additionally carries the uint64 point count at byte 247. */
const MIN_LAS_1_4_HEADER_BYTES = OFFSET_EXTENDED_POINT_COUNT + 8;

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

  // A buffer too short to hold the header would otherwise throw an opaque
  // "Offset is outside the bounds of the DataView"; fail with a clear message
  // instead. This also protects the v0.2.7 head-slice path, where a whole file
  // smaller than the header can legitimately reach this parser.
  if (buffer.byteLength < MIN_PUBLIC_HEADER_BYTES) {
    throw new Error('Not a valid LAS file: the file is too small to contain a header');
  }

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
    if (buffer.byteLength < MIN_LAS_1_4_HEADER_BYTES) {
      throw new Error('Not a valid LAS 1.4 file: the header is truncated');
    }
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

  // Point-record layout — where the records begin, how long each is, and the
  // record format (the high bit, set by LAZ to flag compression, is masked).
  const pointFormat = view.getUint8(OFFSET_POINT_FORMAT) & 0x3f;
  const offsetToPointData = view.getUint32(OFFSET_TO_POINT_DATA, true);
  const pointDataRecordLength = view.getUint16(OFFSET_POINT_RECORD_LENGTH, true);

  // CRS / linear-unit detection — walk the LASF_Projection VLRs starting at
  // the recorded header size. The buffer may be a head-slice that stopped
  // before the VLRs (header-only fast path); `parseCrsFromVlrs` handles
  // that by returning null, and we proceed with `crs = null`.
  const headerSize = view.getUint16(OFFSET_HEADER_SIZE, true);
  const numVlr = view.getUint32(OFFSET_NUM_VLR, true);
  const crs = (headerSize > 0 && numVlr > 0)
    ? parseCrsFromVlrs(buffer, headerSize, numVlr)
    : null;

  return {
    pointCount,
    scale,
    offset,
    min,
    max,
    crs,
    versionMinor,
    pointFormat,
    offsetToPointData,
    pointDataRecordLength,
    systemIdentifier,
    generatingSoftware,
    creationDay,
    creationYear,
  };
}

/**
 * The per-point attributes a decoded LAS/LAZ cloud carries in this viewer.
 *
 * The loader decodes position, intensity, classification, and — since
 * v0.2.8 — the inspection extras (return number/count, point source ID, GPS
 * time); not RGB or surface normals. The set is fixed regardless of the LAS
 * point format. It sizes the v0.2.7 load-memory estimate
 * (`estimateMemoryBytes`); `hasLasExtras` keeps that estimate honest about the
 * ~12 extra bytes per point the v0.2.8 attributes add.
 */
export const LAS_DECODED_ATTRIBUTES: PointAttributes = {
  hasColor: false,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
  hasLasExtras: true,
};
