/**
 * Minimal parser for the ASPRS LAS public header block.
 *
 * Only the fields needed for bootstrapping a viewer are read: point count,
 * scale, offset, bounds and the version. Byte offsets follow the ASPRS LAS
 * 1.0–1.4 specification (the public header layout is stable across versions
 * for the fields we touch).
 */

import type { PointAttributes } from './loadPlan';
import { LoadError } from './loadErrors';
import { parseCrsFromVlrs } from './crs';
import type { CrsInfo } from './crs';

/**
 * Read a little-endian uint64 as a Number, refusing values JavaScript cannot
 * hold exactly. Above 2^53−1 a `Number` silently loses low bits, so a point
 * count, byte offset or hierarchy size read that large would be quietly wrong —
 * a corruption no downstream check could recover. Guard BEFORE the conversion
 * and reject the file with a typed error instead.
 */
export function readSafeUint64(view: DataView, offset: number, what: string): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new LoadError('malformed-file', `${what} ${value} exceeds the safe integer range.`);
  }
  return Number(value);
}

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
  // instead. This also protects the head-slice path, where a whole file
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
    pointCount = readSafeUint64(view, OFFSET_EXTENDED_POINT_COUNT, 'LAS point count');
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

  // Every coordinate the viewer produces flows from these fields —
  // `local = (int * scale + offset) - origin`, with the origin floored from
  // `min`. A single non-finite value (or a non-positive scale — no LAS
  // writer emits one) from a truncated or corrupt header would quietly turn
  // the whole cloud into NaNs: the load "succeeds" into an empty scene, and
  // the NaN origin leaks into measurements and exports. Refuse the file here
  // instead, with the typed error the load pipeline maps to a clear message.
  if (scale.some((v) => !Number.isFinite(v) || v <= 0)) {
    throw new LoadError('malformed-file', 'LAS header scale factor is invalid.');
  }
  if (offset.some((v) => !Number.isFinite(v))) {
    throw new LoadError('malformed-file', 'LAS header offset is invalid.');
  }
  if (min.some((v) => !Number.isFinite(v)) || max.some((v) => !Number.isFinite(v))) {
    throw new LoadError('malformed-file', 'LAS header bounds are invalid.');
  }

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
 * The loader decodes position, intensity, classification, the inspection
 * extras (return number/count, point source ID, GPS time), and RGB where the
 * point format carries it. It sizes the load-memory estimate
 * (`estimateMemoryBytes`); `hasLasExtras` keeps that estimate honest about the
 * ~12 extra bytes per point the attributes add.
 *
 * Kept for callers that have no header to read. Anything holding a parsed
 * header should use `lasDecodedAttributes(pointFormat)` instead: this constant
 * declares no colour, and a colour-bearing file decodes one anyway, so the
 * estimate comes in low exactly where memory is tightest.
 */
export const LAS_DECODED_ATTRIBUTES: PointAttributes = {
  hasColor: false,
  hasIntensity: true,
  hasClassification: true,
  hasNormals: false,
  hasLasExtras: true,
};

/**
 * LAS point formats that carry RGB, per the ASPRS specification.
 *
 * 2, 3 and 5 are the LAS 1.2/1.3 colour formats; 7, 8 and 10 are their 1.4
 * counterparts. 8 and 10 also carry NIR, which the loader does not decode.
 */
const RGB_POINT_FORMATS: ReadonlySet<number> = new Set([2, 3, 5, 7, 8, 10]);

/** Whether a LAS point format carries RGB. */
export function pointFormatHasRgb(pointFormat: number): boolean {
  return RGB_POINT_FORMATS.has(pointFormat);
}

/**
 * What the loader will actually decode from this point format.
 *
 * The memory estimate drives admission, so declaring no colour for a file that
 * decodes colour understates the peak: three bytes per point in the cloud that
 * ships, and six more per point while the raw 16-bit channels are still
 * staged. On a large colour-bearing scan the planner admits a point budget the
 * device cannot hold, which is the outcome the estimate exists to prevent.
 */
export function lasDecodedAttributes(pointFormat: number): PointAttributes {
  return { ...LAS_DECODED_ATTRIBUTES, hasColor: pointFormatHasRgb(pointFormat) };
}
