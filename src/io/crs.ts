/**
 * crs.ts
 *
 * Coordinate Reference System detection from LAS / LAZ / COPC variable-length
 * records (VLRs). Two on-disk encodings are supported, matching the LAS
 * specification:
 *
 *   1. OGC WKT (LAS 1.4 default and best for modern files) — VLR with
 *      User ID `LASF_Projection`, record ID 2112 (Coordinate System WKT).
 *      Payload is null-terminated ASCII. Record ID 2111 (Math Transform WKT)
 *      is a distinct, optional supplemental transform, NOT a coordinate
 *      system, and is never used as one here.
 *
 *   2. GeoTIFF tags (LAS 1.0–1.3, also LAS 1.4 when the global-encoding
 *      WKT bit is clear) — three VLRs:
 *        • 34735 GeoKeyDirectoryTag — uint16 array of geokey entries
 *        • 34736 GeoDoubleParamsTag — float64 array (referenced by keys)
 *        • 34737 GeoAsciiParamsTag  — ASCII chars (referenced by keys)
 *
 * Pure parser — no DOM, no three.js, no network. Operates on an ArrayBuffer
 * slice of the LAS file starting at the public header. Returns `null` when
 * no recognisable CRS VLR is present (a common case for older field exports
 * and raw drone captures).
 *
 * Research-grade scope (lazy chunk): extract a HUMAN-READABLE name, an EPSG
 * code when one can be regex-matched from the WKT, and the LINEAR UNIT
 * (metre / international foot / US survey foot) so measurements honour the
 * source datum. Reprojection between CRSs is explicitly out of scope —
 * users that need WGS84 conversion can use a downstream tool (proj4, GDAL).
 */

import {
  collectWktNodes,
  parseWkt,
  wktChildNodes,
  wktFirstNumber,
  wktNodeName,
  type WktNode,
} from './wktParser';
import { getCrsEntry } from '../geo/CrsRegistry';
import { knownVerticalCrs, resolveVerticalEpsg, sameDatumVariantInUnit } from '../geo/height';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** The linear unit a CRS measures coordinates in. */
export type CrsLinearUnit = 'metre' | 'foot' | 'us-survey-foot' | 'unknown';

/** GeoTIFF ProjLinearUnitsGeoKey codes — the standard linear-unit catalogue. */
const GEOTIFF_LINEAR_UNITS: Readonly<Record<number, CrsLinearUnit>> = {
  9001: 'metre',
  9002: 'foot',
  9003: 'us-survey-foot',
};

/** What we extract from the VLRs. All fields optional — a header may carry one and not others. */
export interface CrsInfo {
  /** Where the metadata came from — diagnostic, surfaced in the Scan Report. */
  readonly source: 'wkt' | 'geotiff' | 'epsg';
  /** Raw WKT string (when source is `wkt`) — kept so the UI can show it on request. */
  readonly wkt?: string;
  /** Best-effort human label, e.g. "WGS 84 / UTM zone 12N" or "EPSG:32612". */
  readonly name: string;
  /** EPSG code if one was regex-matched from the WKT or read directly from a GeoTIFF key. */
  readonly epsg?: number;
  /** Linear unit of the X / Y axes. Drives measurement-tool unit conversion. */
  readonly linearUnit: CrsLinearUnit;
  /** Linear-unit conversion to metres. 1 for metres, 0.3048 for international foot, etc. */
  readonly linearUnitToMetres: number;
  /**
   * Set when the horizontal unit is a valid length that is not metre, foot or
   * US survey foot (a centimetre, kilometre or yard grid): `linearUnit` is then
   * 'unknown' and `linearUnitToMetres` is the factor the source declares, which
   * converts every horizontal figure. Absent for a named unit, and for an
   * unknown one whose `linearUnitToMetres` is only the inert placeholder 1.
   */
  readonly linearUnitByFactor?: true;
  /** Set when the horizontal unit's name disagrees with its factor, or is not one of the named units. */
  readonly linearUnitNote?: string;
  /** Whether the CRS is geographic (lat/lon in degrees) vs projected (metres on a plane). */
  readonly isGeographic: boolean;
  /**
   * Vertical (height) datum EPSG code when the file declares one — e.g. 5703
   * (NAVD88), 5701 (ODN), 3855 (EGM2008). Absent when the source carries only
   * a horizontal CRS, which is the common case for raw captures.
   */
  readonly verticalEpsg?: number;
  /**
   * Human label for the vertical datum (a known name, or `EPSG:<code>`).
   * `undefined` means the elevation datum is unknown — the terrain tools
   * surface that honestly rather than assuming one.
   */
  readonly verticalDatum?: string;
  /**
   * Linear unit of the Z (height) axis when the source declares one separately
   * — e.g. NAVD88 height in US survey feet over a state-plane grid in feet, or a
   * metre vertical CRS over a foot horizontal grid. Absent when the file gives
   * no vertical unit; callers then fall back to the horizontal `linearUnit`
   * (the GeoTIFF default: vertical units follow the model's linear units).
   */
  readonly verticalLinearUnit?: CrsLinearUnit;
  /**
   * Z-unit conversion to metres as the source declares it (1 metre, 0.3048
   * foot, 0.01 centimetre, 0.9144 yard, …). The factor, not the token, is the
   * physical scale: a valid length unit that is not one of the three named
   * units keeps its own factor with the token 'unknown'. Absent: no vertical
   * unit was declared. Present but not finite and positive: one was declared
   * and cannot be read, and no height is converted.
   */
  readonly verticalUnitToMetres?: number;
  /**
   * Set when the source declares a vertical unit that is not a length unit we
   * can read. The vertical unit is then 'unknown' and its factor non-finite,
   * so no height is converted.
   */
  readonly verticalUnitConflict?: string;
  /**
   * Set when a declared vertical unit overrides the unit the vertical EPSG
   * code defines (5703, metres, declared in US survey feet). The declared
   * unit is used.
   */
  readonly verticalUnitNote?: string;
  /**
   * Set to `'evlr'` when the record that decided the CRS was a LAS 1.4
   * extended VLR rather than a VLR in the header block. Absent for a VLR.
   */
  readonly record?: 'evlr';
  /**
   * Horizontal geodetic datum name as the WKT declares it — the GEOGCS/GEOGCRS
   * (geographic base) name, e.g. "NAD83", "NAD83(2011)", "WGS 84", "ETRS89".
   * This is the realization-PRESERVING name (NAD83(2011) ≠ NAD83 by ~1–2 m), so
   * it is the authoritative source for the resolved datum and must never be
   * downgraded to a registry generic. Absent when the source carried no WKT.
   */
  readonly horizontalDatum?: string;
  /**
   * Set when the WKT root, or a compound CRS's horizontal component, is a local
   * or engineering CRS (WKT1 `LOCAL_CS`, WKT2 `ENGCRS` / `ENGINEERINGCRS`). `name` then carries that CRS's own name. Two
   * local frames with different names are different frames; two with the same
   * name are not thereby proven to be the same one.
   */
  readonly localFrame?: true;
  /**
   * Set when no horizontal or local CRS could be identified in the WKT (empty,
   * malformed, or a compound / vertical CRS without a horizontal component).
   * The CRS then resolves as unknown, never as a projected frame.
   */
  readonly horizontalUnresolved?: true;
  /**
   * Set when the CRS is not from the file but asserted by a catalogue source's
   * product specification (`src/io/catalog/catalogueCrs.ts`); names the
   * assertion, e.g. "swisstopo LV95".
   */
  readonly catalogue?: string;
  /**
   * Set when the CRS is geocentric (Earth-centred Cartesian X/Y/Z): a WKT1
   * GEOCCS, a WKT2 geodetic CRS with a Cartesian coordinate system, GeoTIFF
   * model type 3, or a known geocentric EPSG code. Its Z is not elevation and
   * its X/Y are not a ground plane, so no metric, terrain or elevation
   * workflow may read it as one.
   */
  readonly geocentric?: boolean;
  /**
   * Set when the vertical CRS's axis points DOWN (a depth axis, e.g. NAVD88
   * depth, MSL depth), whether a known depth code or a WKT AXIS[..., DOWN].
   * Elevation workflows assume positive-up heights and refuse it.
   */
  readonly verticalAxisDown?: boolean;
}

/**
 * Geocentric (Earth-centred Cartesian) CRS codes. Not exhaustive: a code
 * outside this set is still recognised from its WKT or GeoTIFF model type.
 */
const GEOCENTRIC_EPSG: ReadonlySet<number> = new Set([
  4978, // WGS 84
  4328, // WGS 84 (geocentric, deprecated)
  4936, // ETRS89
  4919, // ITRF2000
  4896, // ITRF2005
  5332, // ITRF2008
  7789, // ITRF2014
  9988, // ITRF2020
]);

/** Whether `epsg` is a known geocentric CRS code. */
export function isGeocentricEpsg(epsg: number | undefined): boolean {
  return epsg !== undefined && GEOCENTRIC_EPSG.has(epsg);
}

/**
 * Label a vertical-datum EPSG code (known name, or `EPSG:<code>`). Returns
 * undefined for the placeholder codes that mean "no real datum" (0 / 32767),
 * so callers don't surface a bogus `EPSG:0` as a datum.
 */
export function verticalDatumLabel(epsg: number): string | undefined {
  if (!(epsg > 0) || epsg === 32767) return undefined;
  return knownVerticalCrs(epsg)?.label ?? `EPSG:${epsg}`;
}

/**
 * VLR header layout — fixed 54-byte preamble before each VLR payload. Used
 * by the parser to walk the VLR list.
 *
 *   u16 reserved
 *   u8[16] user id
 *   u16 record id
 *   u16 record length after header
 *   u8[32] description
 *
 * EVLRs (LAS 1.4 extended VLRs) share the layout but carry a u64 record
 * length, so their header is 60 bytes. They sit after the point data and are
 * read by `readEvlrProjectionRecords` with bounded range reads.
 */
const VLR_HEADER_BYTES = 54;
const VLR_USER_ID_OFFSET = 2;
const VLR_USER_ID_LENGTH = 16;
const VLR_RECORD_ID_OFFSET = 18;
const VLR_RECORD_LENGTH_OFFSET = 20;

/** The user ID every LAS georeference VLR uses. */
const CRS_USER_ID = 'LASF_Projection';
/**
 * OGC WKT record ID for the coordinate-system WKT — the ONLY authoritative CRS.
 * Record ID 2111 (Math Transform WKT) is a distinct, optional supplemental
 * transform per the LAS spec and is deliberately NOT read here: it is not a
 * coordinate system and must never stand in for one.
 */
const RECORD_ID_OGC_WKT_COORD = 2112;
/** GeoTIFF tag VLR record IDs. */
const RECORD_ID_GEOKEY_DIRECTORY = 34735;
const RECORD_ID_GEO_DOUBLE_PARAMS = 34736;
const RECORD_ID_GEO_ASCII_PARAMS = 34737;

/** GeoTIFF GeoKey IDs we care about. */
const GEOKEY_GT_MODEL_TYPE = 1024;       // projected (1) / geographic (2) / geocentric (3)
const GEOKEY_GT_CITATION = 1026;         // ASCII citation naming the CRS the file is in
const GEOKEY_GEODETIC_CRS = 2048;        // EPSG of a geographic CRS
const GEOKEY_GEODETIC_CITATION = 2049;   // ASCII citation
const GEOKEY_GEOGRAPHIC_LINEAR_UNITS = 2052;  // linear units of a geographic CRS
const GEOKEY_PROJECTED_CRS = 3072;       // EPSG of a projected CRS
const GEOKEY_PROJECTED_CITATION = 3073;  // ASCII citation
const GEOKEY_PROJ_LINEAR_UNITS = 3076;   // linear units of a projected CRS
const GEOKEY_VERTICAL_CRS = 4096;        // EPSG of the vertical (height) CRS
const GEOKEY_VERTICAL_CITATION = 4097;   // ASCII citation for the vertical CRS
const GEOKEY_VERTICAL_UNITS = 4099;      // linear units of the vertical CRS

// ─────────────────────────────────────────────────────────────────────────────
// Parser entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The LASF_Projection payloads a file carries, collected from its VLRs and
 * (LAS 1.4) its EVLRs. The first record of each kind wins: the VLRs are
 * collected first, so a VLR outranks an EVLR of the same record id.
 */
export interface ProjectionRecords {
  wkt: string | null;
  geokeys: Uint8Array | null;
  geoAscii: Uint8Array | null;
  geoDouble: Uint8Array | null;
  /** True when the held WKT record came from an EVLR. */
  wktFromEvlr?: boolean;
  /** True when the held GeoKeyDirectory record came from an EVLR. */
  geokeysFromEvlr?: boolean;
}

export function emptyProjectionRecords(): ProjectionRecords {
  return { wkt: null, geokeys: null, geoAscii: null, geoDouble: null };
}

/** Store one LASF_Projection payload unless a record of that id is already held. */
function addProjectionRecord(
  records: ProjectionRecords,
  recordId: number,
  payload: Uint8Array,
  fromEvlr = false,
): void {
  if (recordId === RECORD_ID_OGC_WKT_COORD) {
    // 2112 is the ONLY authoritative CRS WKT. 2111 (math transform) is a
    // supplemental parameter set, not a coordinate system, and must never
    // be substituted in when 2112 is absent: that would silently label
    // the file with a transform, not a CRS.
    if (records.wkt == null) {
      const text = readNullTerminatedBytes(payload);
      if (text.trim().length > 0) {
        records.wkt = text;
        if (fromEvlr) records.wktFromEvlr = true;
      }
    }
  } else if (recordId === RECORD_ID_GEOKEY_DIRECTORY) {
    if (records.geokeys == null) {
      records.geokeys = payload;
      if (fromEvlr) records.geokeysFromEvlr = true;
    }
  } else if (recordId === RECORD_ID_GEO_ASCII_PARAMS) {
    records.geoAscii ??= payload;
  } else if (recordId === RECORD_ID_GEO_DOUBLE_PARAMS) {
    records.geoDouble ??= payload;
  }
}

/**
 * Collect the LASF_Projection payloads from the VLR list starting at
 * `vlrStartOffset`. Every read is bounds-checked against the buffer, so a
 * short head slice or a malformed list stops the walk instead of throwing.
 */
export function collectVlrProjectionRecords(
  buffer: ArrayBuffer,
  vlrStartOffset: number,
  vlrCount: number,
  records: ProjectionRecords = emptyProjectionRecords(),
): ProjectionRecords {
  if (vlrCount === 0 || vlrStartOffset + VLR_HEADER_BYTES > buffer.byteLength) return records;
  const view = new DataView(buffer);
  let cursor = vlrStartOffset;
  for (let i = 0; i < vlrCount; i++) {
    if (cursor + VLR_HEADER_BYTES > buffer.byteLength) break;
    const userId = readAscii(view, cursor + VLR_USER_ID_OFFSET, VLR_USER_ID_LENGTH);
    const recordId = view.getUint16(cursor + VLR_RECORD_ID_OFFSET, true);
    const payloadLength = view.getUint16(cursor + VLR_RECORD_LENGTH_OFFSET, true);
    const payloadStart = cursor + VLR_HEADER_BYTES;
    if (payloadStart + payloadLength > buffer.byteLength) break;
    if (userId === CRS_USER_ID) {
      addProjectionRecord(records, recordId, new Uint8Array(buffer, payloadStart, payloadLength));
    }
    cursor = payloadStart + payloadLength;
  }
  return records;
}

/**
 * Turn collected LASF_Projection payloads into a CRS, or null when none of
 * them describes one.
 */
export function crsFromProjectionRecords(records: ProjectionRecords): CrsInfo | null {
  const crs = crsFromHeldRecords(records);
  if (!crs) return null;
  const fromEvlr = records.wkt ? records.wktFromEvlr : records.geokeysFromEvlr;
  return fromEvlr ? { ...crs, record: 'evlr' } : crs;
}

function crsFromHeldRecords(records: ProjectionRecords): CrsInfo | null {
  const { wkt: wktPayload, geokeys: geokeyBytes, geoAscii: geoAsciiBytes, geoDouble: geoDoubleBytes } = records;
  if (wktPayload) {
    const fromWkt = crsFromWkt(wktPayload);
    if (geokeyBytes == null) return fromWkt;
    // LAS 1.4 permits a WKT VLR and a GeoKeyDirectory VLR in the same file,
    // and this app's own 1.4 writer uses that: most WKT, including every WKT
    // `wktForEpsg` derives, describes the horizontal frame only, so the
    // vertical datum and vertical unit travel in the GeoKeys beside it.
    // Taking the WKT and dropping the GeoKeys threw both away, and a NAVD88
    // height in feet then read back as an undeclared unit the terrain tools
    // fall back to metres for: 3.28x wrong, provenance gone. The WKT stays
    // the sole authority on the horizontal frame and on any vertical axis it
    // does declare; only the vertical fields it leaves empty are filled here.
    if (fromWkt.verticalEpsg != null && fromWkt.verticalLinearUnit != null) return fromWkt;
    const fromKeys = crsFromGeoTiff(geokeyBytes, geoAsciiBytes, geoDoubleBytes);
    const verticalEpsg = fromWkt.verticalEpsg ?? fromKeys.verticalEpsg;
    // A unit taken from the keys is checked against the vertical code that
    // will be reported, which may be the WKT's rather than the keys' own.
    const v: VerticalUnitResolution = fromWkt.verticalLinearUnit != null
      ? { unit: fromWkt.verticalLinearUnit, toMetres: fromWkt.verticalUnitToMetres, conflict: fromWkt.verticalUnitConflict, note: fromWkt.verticalUnitNote }
      : fromKeys.verticalUnitConflict || fromWkt.verticalEpsg == null
        ? { unit: fromKeys.verticalLinearUnit, toMetres: fromKeys.verticalUnitToMetres, conflict: fromKeys.verticalUnitConflict, note: fromKeys.verticalUnitNote }
        : resolveVerticalUnit(declaredVerticalUnitOf(fromKeys), verticalEpsg);
    const merged: CrsInfo = {
      ...fromWkt,
      verticalEpsg,
      verticalDatum: v.datumLabel ?? fromWkt.verticalDatum ?? fromKeys.verticalDatum,
      ...verticalUnitFields(v),
    };
    return merged;
  }
  if (geokeyBytes) return crsFromGeoTiff(geokeyBytes, geoAsciiBytes, geoDoubleBytes);
  return null;
}

/**
 * Walk the VLR list starting at `vlrStartOffset` and extract CRS info if
 * any LASF_Projection VLR is present. Returns `null` when no recognisable
 * CRS VLR is found, the buffer is short, or the VLR list is malformed.
 *
 * Defensive: every uint read is bounds-checked against the buffer length
 * so a malformed VLR can't crash the loader. Caller code can safely treat
 * `null` as "CRS unknown" and proceed with the load.
 *
 * WKT wins over GeoTIFF when both are present because LAS 1.4 mandates WKT
 * for modern files. EVLRs are not visible here; see `resolveLasCrs`.
 */
export function parseCrsFromVlrs(
  buffer: ArrayBuffer,
  vlrStartOffset: number,
  vlrCount: number,
): CrsInfo | null {
  if (vlrCount === 0) return null;
  return crsFromProjectionRecords(collectVlrProjectionRecords(buffer, vlrStartOffset, vlrCount));
}

// ─────────────────────────────────────────────────────────────────────────────
// LAS 1.4 extended VLRs
// ─────────────────────────────────────────────────────────────────────────────

/** EVLR header: u16 reserved, u8[16] user id, u16 record id, u64 length, u8[32] description. */
export const EVLR_HEADER_BYTES = 60;
const EVLR_RECORD_LENGTH_OFFSET = 20;
/**
 * Most EVLRs a CRS walk visits. Real files carry one to a handful; the cap
 * keeps a corrupt count from turning into thousands of reads.
 */
export const MAX_EVLRS_WALKED = 64;
/**
 * Largest LASF_Projection EVLR payload read. A CRS WKT is a few KiB at most;
 * anything larger is refused rather than read. Other EVLRs (waveforms,
 * indexes) are skipped by their header alone and never read.
 */
export const MAX_PROJECTION_EVLR_BYTES = 1 << 20;

/** Read `length` bytes at absolute file `offset`. May return fewer at EOF. */
export type ByteRangeReader = (offset: number, length: number) => Promise<ArrayBuffer>;

/**
 * Collect LASF_Projection payloads from the EVLRs of a LAS 1.4 file.
 *
 * Reads each 60-byte EVLR header, then the payload only for a
 * LASF_Projection record no larger than {@link MAX_PROJECTION_EVLR_BYTES}.
 * The walk stops at the file end, at {@link MAX_EVLRS_WALKED} records, or at
 * the first header that does not fit, so a truncated or corrupt EVLR block
 * yields what was read before it rather than an error.
 */
export async function readEvlrProjectionRecords(
  read: ByteRangeReader,
  fileSize: number,
  firstEvlrOffset: number,
  evlrCount: number,
  records: ProjectionRecords = emptyProjectionRecords(),
): Promise<ProjectionRecords> {
  if (!(evlrCount > 0) || !(firstEvlrOffset > 0) || !Number.isSafeInteger(firstEvlrOffset)) return records;
  let cursor = firstEvlrOffset;
  const count = Math.min(evlrCount, MAX_EVLRS_WALKED);
  for (let i = 0; i < count; i++) {
    if (cursor + EVLR_HEADER_BYTES > fileSize) break;
    const head = await read(cursor, EVLR_HEADER_BYTES);
    if (head.byteLength < EVLR_HEADER_BYTES) break;
    const view = new DataView(head);
    const userId = readAscii(view, VLR_USER_ID_OFFSET, VLR_USER_ID_LENGTH);
    const recordId = view.getUint16(VLR_RECORD_ID_OFFSET, true);
    const length64 = view.getBigUint64(EVLR_RECORD_LENGTH_OFFSET, true);
    const payloadStart = cursor + EVLR_HEADER_BYTES;
    if (length64 > BigInt(fileSize - payloadStart)) break;
    const length = Number(length64);
    if (userId === CRS_USER_ID && length > 0 && length <= MAX_PROJECTION_EVLR_BYTES) {
      const payload = await read(payloadStart, length);
      if (payload.byteLength < length) break;
      addProjectionRecord(records, recordId, new Uint8Array(payload, 0, length), true);
    }
    cursor = payloadStart + length;
  }
  return records;
}

/** LAS 1.4 header fields the EVLR walk needs. */
export interface LasEvlrLocation {
  readonly versionMinor: number;
  readonly evlrOffset?: number;
  readonly evlrCount?: number;
}

/**
 * Resolve a LAS/LAZ file's CRS from both its VLRs and, for LAS 1.4, its EVLRs.
 *
 * LAS 1.4 lets a writer put the coordinate-system record in either block, and
 * many current deliveries put the WKT in an EVLR after the point data. The
 * records are merged with the VLRs first, so for each record id a VLR outranks
 * an EVLR; the specification expects a single CRS record, so the two agreeing
 * is the normal case and the order only settles a malformed file. WKT then
 * outranks GeoKeys as for VLRs alone, whichever block each came from.
 *
 * `head` holds the file from byte 0 through at least the VLR block. EVLR bytes
 * are fetched through `read`, never by loading the whole file. A failed EVLR
 * read leaves the VLR result in place.
 */
export async function resolveLasCrs(
  head: ArrayBuffer,
  headerSize: number,
  vlrCount: number,
  location: LasEvlrLocation,
  read: ByteRangeReader,
  fileSize: number,
): Promise<CrsInfo | null> {
  const records = collectVlrProjectionRecords(head, headerSize, vlrCount);
  if (location.versionMinor >= 4 && (location.evlrCount ?? 0) > 0 && (location.evlrOffset ?? 0) > 0) {
    try {
      await readEvlrProjectionRecords(read, fileSize, location.evlrOffset!, location.evlrCount!, records);
    } catch {
      // An unreadable EVLR block leaves the CRS to the VLRs.
    }
  }
  return crsFromProjectionRecords(records);
}

/** Where a LAS public header places the CRS-bearing records. */
export interface LasCrsLocation extends LasEvlrLocation {
  readonly headerSize: number;
  readonly vlrCount: number;
  readonly offsetToPointData: number;
}

/** Bytes of the LAS 1.4 public header, which holds the EVLR offset and count. */
const LAS_14_PUBLIC_HEADER_BYTES = 375;
/**
 * Largest header-plus-VLR block read when resolving a CRS over a range source.
 * The VLR block of a real file is a few KiB; the cap bounds a corrupt offset.
 */
export const MAX_RANGE_VLR_BLOCK_BYTES = 4 << 20;

/**
 * Read the header fields a CRS walk needs from the start of a LAS/LAZ/COPC
 * file. Returns null when the bytes are too short or do not start with `LASF`.
 */
export function readLasCrsLocation(head: ArrayBuffer): LasCrsLocation | null {
  if (head.byteLength < 104) return null;
  const view = new DataView(head);
  if (readAscii(view, 0, 4) !== 'LASF') return null;
  const versionMinor = view.getUint8(25);
  let evlrOffset = 0;
  let evlrCount = 0;
  if (versionMinor >= 4 && head.byteLength >= 247) {
    const raw = view.getBigUint64(235, true);
    if (raw <= BigInt(Number.MAX_SAFE_INTEGER)) evlrOffset = Number(raw);
    evlrCount = view.getUint32(243, true);
  }
  return {
    versionMinor,
    headerSize: view.getUint16(94, true),
    offsetToPointData: view.getUint32(96, true),
    vlrCount: view.getUint32(100, true),
    evlrOffset,
    evlrCount,
  };
}

/**
 * Resolve a LAS/LAZ file's CRS through range reads alone: the public header,
 * the VLR block up to the point data (capped at
 * {@link MAX_RANGE_VLR_BLOCK_BYTES}), and for LAS 1.4 the EVLR walk of
 * {@link resolveLasCrs}. The point data is never read. A failed read or a
 * header that is not LAS resolves to null.
 */
export async function resolveLasCrsFromRange(
  read: ByteRangeReader,
  fileSize: number,
): Promise<CrsInfo | null> {
  try {
    const pub = await read(0, Math.min(fileSize, LAS_14_PUBLIC_HEADER_BYTES));
    const location = readLasCrsLocation(pub);
    if (!location) return null;
    const blockBytes = Math.min(fileSize, location.offsetToPointData, MAX_RANGE_VLR_BLOCK_BYTES);
    const head = blockBytes <= pub.byteLength ? pub : await read(0, blockBytes);
    return await resolveLasCrs(head, location.headerSize, location.vlrCount, location, read, fileSize);
  } catch {
    return null;
  }
}

/** A {@link ByteRangeReader} over bytes already in memory. */
export function bufferRangeReader(buffer: ArrayBuffer): ByteRangeReader {
  return (offset, length) =>
    Promise.resolve(buffer.slice(offset, Math.min(buffer.byteLength, offset + length)));
}

// ─────────────────────────────────────────────────────────────────────────────
// WKT path (preferred — LAS 1.4 default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WKT → {@link CrsInfo}. Tokenises the WKT into a `KEYWORD["name", child, …]`
 * AST (see {@link parseWkt}) and reads every field by STRUCTURE: the CRS name,
 * horizontal EPSG (`AUTHORITY["EPSG",…]` / `ID["EPSG",…]` on the CRS node
 * itself), linear unit + factor, geodetic datum, geographic-vs-projected kind,
 * and the compound-CRS horizontal slice. Structure is what lets the code tell a
 * CRS's own authority from one nested in a `UNIT` or `DATUM`, and keep a
 * compound's vertical clauses out of the horizontal read — the two failure
 * modes a flat regex cannot avoid.
 *
 * Resolution SEMANTICS are unchanged from the prior regex implementation: a
 * projected CRS with no UNIT clause defaults to metre (the WKT default), an
 * unrecognised linear-unit name resolves to `unknown` (fail-closed), and only
 * the horizontal slice of a compound CRS decides name / EPSG / unit.
 */
export function crsFromWkt(wkt: string): CrsInfo {
  // Trim wrapper whitespace + null terminators. A scan from the end, not
  // /\0+$/, which retries from every NUL of a run that is not at the end.
  let end = wkt.length;
  while (end > 0 && wkt.charCodeAt(end - 1) === 0) end -= 1;
  const text = wkt.slice(0, end).trim();

  // A BOUNDCRS (WKT2) is analysed as its SOURCECRS, the CRS the coordinates
  // are in. Its TARGETCRS and transformation carry their own units (the
  // target ellipsoid's metre), which must never be read as the data's unit.
  const parsed = parseWkt(text);
  const root = parsed ? sourceOfBoundCrs(parsed) : null;
  const nodes = root ? collectWktNodes(root) : [];

  // For a compound CRS (COMPD_CS / COMPOUNDCRS) the horizontal CRS and its
  // EPSG / unit live BEFORE the vertical block, so we analyse only the
  // horizontal slice for name / EPSG / unit. This stops the vertical CRS's
  // EPSG and metre UNIT from being mistaken for the horizontal ones. The slice
  // is every node that opens before the first vertical node — the structural
  // equivalent of the old "text before the first VERT_CS keyword".
  const verticalNode = nodes.find((n) => isVerticalKeyword(n.keyword));
  const vertStart = verticalNode ? verticalNode.start : Infinity;
  const horizNodes = nodes.filter((n) => n.start < vertStart);

  // The CRS name is the first NAMED horizontal CRS node (PROJCS / GEOGCS /
  // …); for a projected CRS that is the PROJCS, whose name wins over the nested
  // base GEOGCS. A compound with no inner named CRS falls back to its own
  // COMPD_CS name, which describes the whole compound.
  // The horizontal component, identified by structure: the root itself, or a
  // compound's first direct child that is a horizontal or local CRS. Never the
  // compound's own label and never a nested authority, so an engineering frame
  // inside COMPOUNDCRS keeps its own name and its local status.
  const compoundRoot = root != null && isCompoundKeyword(root.keyword);
  const horizComponent = root == null ? undefined
    : compoundRoot ? wktChildNodes(root).find((n) => isHorizontalCrsKeyword(n.keyword) || isLocalCrsKeyword(n.keyword))
    : root;
  const localNode = horizComponent && isLocalCrsKeyword(horizComponent.keyword) ? horizComponent : undefined;
  const localRoot = localNode !== undefined;
  const rawName =
    (localNode ? wktNodeName(localNode) : undefined)
    ?? firstName(horizNodes, isHorizontalCrsKeyword)
    ?? (root && isCompoundKeyword(root.keyword) ? wktNodeName(root) : undefined)
    ?? 'Unknown CRS';

  // Horizontal datum = the geographic base CRS's name (the GEOGCS / GEOGCRS /
  // BASEGEOGCRS node). For a projected CRS this is the nested base (e.g.
  // "NAD83"); for a geographic CRS it is the CRS itself. It preserves the datum
  // realization — "NAD83(2011)" stays distinct from "NAD83" (~1–2 m apart) — so
  // it is the precision-preserving source the resolver prefers over the generic
  // registry name.
  const horizontalDatum = firstName(horizNodes, isGeodeticBaseKeyword);

  // EPSG via the standard AUTHORITY / ID clause on the CRS node itself. LAS WKT
  // is permissive — AUTHORITY["EPSG","32612"] (WKT1) and ID["EPSG",32612]
  // (WKT2) are both read. Anchored on the horizontal CRS node so a nested
  // unit/datum authority, or a compound's vertical code, cannot win.
  const horizCrsNode = localNode ? undefined : horizNodes.find((n) => isHorizontalCrsKeyword(n.keyword));
  const epsg = horizCrsNode ? epsgFromNodeChildren(horizCrsNode) : undefined;

  // Linear units. A projected WKT typically contains TWO UNIT clauses:
  // an angular one inside the nested GEOGCS (e.g. degrees), then the
  // projected linear one at the top level (metres / feet / etc.). We need
  // the LAST one in the horizontal slice for projected CRSs. For geographic
  // CRSs the unit is degrees and the "linear" field falls back to 'unknown'.
  const projectedPresent = horizNodes.some((n) => isProjectedKeyword(n.keyword));
  // A geodetic root is geocentric (Cartesian X/Y/Z from the Earth's centre) or,
  // with an ellipsoidal CS, geographic. Read as projected, a geocentric CRS
  // passed every metric gate with a metre unit and its Z read as elevation.
  const geodeticNode = projectedPresent ? undefined : horizNodes.find((n) => isGeodeticKeyword(n.keyword));
  const geocentric = (geodeticNode !== undefined && isGeocentricNode(geodeticNode)) || isGeocentricEpsg(epsg);
  const isGeographic =
    !projectedPresent && !geocentric &&
    horizNodes.some((n) => isGeographicKeyword(n.keyword) || (isGeodeticKeyword(n.keyword) && csTypeOf(n) === 'ellipsoidal'));
  let linearUnit: CrsLinearUnit = 'unknown';
  let linearUnitToMetres = 1;
  let linearUnitByFactor = false;
  let linearUnitNote: string | undefined;
  if (!isGeographic) {
    // Scan ONLY the horizontal slice. A COMPD_CS's vertical block carries
    // its own UNIT (almost always metres); scanning the full text let that
    // vertical metre clause win over the horizontal one — e.g. a state-plane
    // CRS in US survey feet + NAVD88 metres parsed as metres.
    const projectedUnit = lastLinearUnit(horizNodes);
    if (projectedUnit) {
      const scale = projectedUnit.scale;
      if (Number.isFinite(scale) && scale > 0) {
        // The factor is the unit, as for a vertical unit: a name never
        // overrides it ("centimetre" is 0.01 m per unit, not a metre).
        const h = horizontalUnitOf(projectedUnit.name, scale);
        linearUnit = h.unit;
        linearUnitToMetres = h.toMetres;
        linearUnitByFactor = h.unit === 'unknown';
        linearUnitNote = h.note;
      }
    } else {
      // No UNIT clause is rare on a projected CRS. Take the unit its EPSG
      // code defines, or 'unknown' — never an assumed metre.
      linearUnit = impliedProjectedLinearUnit(epsg);
      linearUnitToMetres = metresPerLinearUnit(linearUnit);
    }
  }

  // Vertical CRS — present in a COMPD_CS / COMPOUNDCRS or a standalone
  // VERT_CS. The name (e.g. "NAVD88") is the reliable signal; the EPSG is a
  // best-effort reverse lookup for the writer. The vertical block's own UNIT
  // (when present) gives the Z-axis unit, which can differ from the horizontal.
  const vert = verticalNode ? extractVerticalFromNode(verticalNode) : {};
  const vUnit: VerticalUnitResolution = verticalNode ? resolveVerticalUnit(vert.unit, vert.epsg) : {};

  return {
    source: 'wkt',
    wkt: text,
    name: epsg ? `${rawName} (EPSG:${epsg})` : rawName,
    epsg,
    linearUnit,
    linearUnitToMetres,
    ...(linearUnitByFactor ? { linearUnitByFactor: true as const } : {}),
    ...(linearUnitNote ? { linearUnitNote } : {}),
    isGeographic,
    verticalEpsg: vert.epsg,
    verticalDatum: vUnit.datumLabel ?? vert.name,
    ...verticalUnitFields(vUnit),
    horizontalDatum,
    ...(geocentric ? { geocentric: true } : {}),
    ...(localRoot && !projectedPresent && !isGeographic && !geocentric ? { localFrame: true as const } : {}),
    // No horizontal or local CRS could be identified (empty, malformed, or a
    // compound or vertical CRS with no horizontal component).
    ...(!localRoot && !horizCrsNode ? { horizontalUnresolved: true as const } : {}),
    ...(verticalNode && verticalAxisIsDown(verticalNode) ? { verticalAxisDown: true } : {}),
  };
}

/**
 * The tree with every BOUNDCRS replaced by the CRS inside its SOURCECRS, so
 * nothing from a TARGETCRS or a transformation reaches the analysis. A BOUNDCRS
 * with no source CRS is kept with no children, so it resolves to nothing rather
 * than to its target.
 */
function sourceOfBoundCrs(node: WktNode): WktNode {
  if (node.keyword === 'BOUNDCRS') {
    const source = wktChildNodes(node).find((n) => n.keyword === 'SOURCECRS');
    const inner = source ? wktChildNodes(source)[0] : undefined;
    return inner ? sourceOfBoundCrs(inner) : { keyword: node.keyword, start: node.start, children: [] };
  }
  let changed = false;
  const children = node.children.map((c) => {
    if (c.type !== 'node') return c;
    const next = sourceOfBoundCrs(c.node);
    if (next !== c.node) changed = true;
    return next === c.node ? c : { ...c, node: next };
  });
  return changed ? { ...node, children } : node;
}

/** Extract the vertical-CRS name + best-effort EPSG + declared unit from a VERT_CS node. */
function extractVerticalFromNode(
  vert: WktNode,
): { epsg?: number; name?: string; unit?: DeclaredVerticalUnit } {
  const name = wktNodeName(vert);
  // A known datum name resolves to the vertical CRS code directly; otherwise
  // fall back to an explicit EPSG authority on the vertical node itself (its own
  // AUTHORITY / ID, NOT a nested VERT_DATUM authority).
  const epsg = (name ? verticalEpsgFromName(name) : undefined) ?? epsgFromNodeChildren(vert);
  return { name, epsg, unit: verticalUnitClause(vert) };
}

/** Unit keywords a vertical CRS can carry. Only UNIT and LENGTHUNIT can be a length. */
const VERTICAL_UNIT_KEYWORDS: ReadonlySet<string> = new Set(['UNIT', 'LENGTHUNIT', 'ANGLEUNIT', 'SCALEUNIT', 'TIMEUNIT', 'PARAMETRICUNIT']);

/** Unit names that are not lengths, whatever their factor (a WKT1 UNIT clause has no type). */
const NON_LENGTH_UNIT_NAME = /degree|radian|\bgrad|\bgon\b|arc|second|minute|unity|parts per|ppm|percent/i;

/**
 * The vertical unit a vertical CRS node declares, as written: its name and its
 * metres-per-unit factor, read from the last unit clause in the node. Absent
 * when the node declares no unit. A clause that is not a length (an angular,
 * scale or time unit) or that carries no usable factor is returned with a
 * non-finite factor, so it reads as declared but invalid, never as absent.
 */
function verticalUnitClause(vert: WktNode): DeclaredVerticalUnit | undefined {
  let found: DeclaredVerticalUnit | undefined;
  for (const n of collectWktNodes(vert)) {
    if (!VERTICAL_UNIT_KEYWORDS.has(n.keyword)) continue;
    const name = wktNodeName(n);
    const scale = wktFirstNumber(n);
    const length = (n.keyword === 'UNIT' || n.keyword === 'LENGTHUNIT') && !NON_LENGTH_UNIT_NAME.test(name ?? '');
    found = { ...(name !== undefined ? { name } : {}), toMetres: length && scale !== undefined ? scale : Number.NaN };
  }
  return found;
}

/** Map a vertical-datum name to its EPSG code (the common geoids/datums). */
function verticalEpsgFromName(name: string): number | undefined {
  // The shared vertical CRS table first, so "NAVD88 depth" is 6357, not 5703.
  const known = resolveVerticalEpsg({ verticalDatum: name });
  if (known !== undefined && knownVerticalCrs(known)) return known;
  const n = name.toLowerCase();
  // The loose matches below name height datums. A depth axis they do not know
  // is left to the node's own AUTHORITY.
  if (n.includes('depth')) return undefined;
  if (n.includes('navd88') || n.includes('navd 88')) return 5703;
  if (n.includes('egm2008')) return 3855;
  if (n.includes('egm96')) return 5773;
  if (n.includes('egm84')) return 5798;
  if (n.includes('odn') || n.includes('newlyn')) return 5701;
  if (n.includes('cgvd2013')) return 6647;
  if (n.includes('baltic')) return 5705;
  if (n.includes('mean sea level') || /\bmsl\b/.test(n)) return 5714;
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// AST field derivation — keyword predicates + node readers
// ─────────────────────────────────────────────────────────────────────────────

/** The projected-CRS keywords (WKT1 `PROJCS`, WKT2 `PROJCRS`). */
function isProjectedKeyword(k: string): boolean {
  return k === 'PROJCS' || k === 'PROJCRS';
}

/** The geographic-CRS keywords (WKT1 `GEOGCS`, WKT2 `GEOGCRS`). */
function isGeographicKeyword(k: string): boolean {
  return k === 'GEOGCS' || k === 'GEOGCRS';
}

/**
 * The vertical-CRS keywords (WKT1 `VERT_CS`, WKT2 `VERTCRS` / `VERTICALCRS`,
 * and the ESRI-style WKT1 `VERTCS`). Missing one lets its UNIT be read as the
 * horizontal unit, since the horizontal slice ends where the vertical CRS starts.
 */
function isVerticalKeyword(k: string): boolean {
  return k === 'VERT_CS' || k === 'VERTCS' || k === 'VERTCRS' || k === 'VERTICALCRS';
}

/** The compound-CRS keywords (WKT1 `COMPD_CS`, WKT2 `COMPOUNDCRS`). */
function isCompoundKeyword(k: string): boolean {
  return k === 'COMPD_CS' || k === 'COMPOUNDCRS';
}

/** A local / engineering CRS root (WKT1 `LOCAL_CS`, WKT2 `ENGCRS` / `ENGINEERINGCRS`). */
function isLocalCrsKeyword(k: string): boolean {
  return k === 'LOCAL_CS' || k === 'ENGCRS' || k === 'ENGINEERINGCRS';
}

/** A horizontal CRS node — the one whose name and authority describe the frame. */
function isHorizontalCrsKeyword(k: string): boolean {
  return isProjectedKeyword(k) || isGeographicKeyword(k) || isGeodeticKeyword(k);
}

/**
 * The geodetic-CRS keywords whose coordinate system decides their shape: WKT1
 * `GEOCCS` (always geocentric) and WKT2 `GEODCRS` / `GEODETICCRS` (geocentric
 * with a Cartesian CS, geographic with an ellipsoidal one).
 */
function isGeodeticKeyword(k: string): boolean {
  return k === 'GEOCCS' || k === 'GEODCRS' || k === 'GEODETICCRS';
}

/** The `CS[<type>, n]` type of a WKT2 CRS node's own coordinate system, lowercased. */
function csTypeOf(node: WktNode): string | undefined {
  for (const c of node.children) {
    if (c.type !== 'node' || c.node.keyword !== 'CS') continue;
    const t = c.node.children[0];
    if (t?.type === 'keyword' || t?.type === 'string') return t.value.toLowerCase();
  }
  return undefined;
}

/** Whether a geodetic node is geocentric (GEOCCS, or a Cartesian GEODCRS). */
function isGeocentricNode(node: WktNode): boolean {
  if (node.keyword === 'GEOCCS') return true;
  return isGeodeticKeyword(node.keyword) && csTypeOf(node) === 'cartesian';
}

/** Whether a vertical CRS node declares a DOWN axis (a depth axis). */
function verticalAxisIsDown(vert: WktNode): boolean {
  return collectWktNodes(vert).some(
    (n) => n.keyword === 'AXIS' && n.children.some((c) => c.type === 'keyword' && c.value.toLowerCase() === 'down'),
  );
}

/**
 * The geodetic BASE node whose name is the horizontal datum. For a projected
 * CRS this is the nested `GEOGCS` / `BASEGEOGCRS`; for a geographic CRS it is
 * the CRS node itself.
 */
function isGeodeticBaseKeyword(k: string): boolean {
  return isGeographicKeyword(k) || k === 'BASEGEOGCRS';
}

/** The first node (document order) matching `pred` that carries a quoted name. */
function firstName(candidates: readonly WktNode[], pred: (k: string) => boolean): string | undefined {
  for (const n of candidates) {
    if (!pred(n.keyword)) continue;
    const name = wktNodeName(n);
    if (name !== undefined) return name;
  }
  return undefined;
}

/**
 * The EPSG code declared by a CRS node's OWN `AUTHORITY` / `ID` child — never a
 * nested unit/datum/spheroid authority (those are grandchildren, not direct
 * children). Both WKT1 `AUTHORITY["EPSG","32612"]` and WKT2 `ID["EPSG",32612]`
 * are read. Constrained to the EPSG range (1024-99999) so a stray number can't
 * pose as a code; the LAST qualifying child wins, matching well-formed WKT that
 * places the CRS's own authority last.
 */
function epsgFromNodeChildren(node: WktNode): number | undefined {
  let found: number | undefined;
  for (const child of wktChildNodes(node)) {
    if (child.keyword !== 'AUTHORITY' && child.keyword !== 'ID') continue;
    if (wktNodeName(child)?.toUpperCase() !== 'EPSG') continue;
    // The code is the clause's numeric argument. WKT1 quotes it ("32612"),
    // WKT2 does not (32612); the AST carries the former as a string child and
    // the latter as a number child, so read whichever is present.
    const code = firstNumericArg(child);
    if (code !== undefined && Number.isFinite(code) && code >= 1024 && code <= 99999) found = code;
  }
  return found;
}

/** The first numeric argument of a node — a number child, or a numeric string. */
function firstNumericArg(node: WktNode): number | undefined {
  for (const child of node.children) {
    if (child.type === 'number') return child.value;
    // Skip the leading name string ("EPSG"); a later numeric string is the code.
    if (child.type === 'string' && /^\d+$/.test(child.value.trim())) return Number(child.value);
  }
  return undefined;
}

/**
 * The LAST linear unit clause among `candidates` (document order), returning
 * its name + scale. WKT1 `UNIT` and WKT2 `LENGTHUNIT` are read; `ANGLEUNIT` is
 * not. A node qualifies only when it has a quoted name and a numeric scale.
 * The caller passes the horizontal slice of a tree whose BOUNDCRS wrappers were
 * already reduced to their source CRS, so a target CRS's unit is never seen.
 */
function lastLinearUnit(candidates: readonly WktNode[]): { name: string; scale: number } | undefined {
  let result: { name: string; scale: number } | undefined;
  for (const n of candidates) {
    // WKT1 spells the unit `UNIT[...]`; WKT2 (ISO 19162, emitted by modern
    // GDAL/PDAL) spells the linear unit `LENGTHUNIT[...]`. Accept both — reading
    // only `UNIT` silently dropped a declared foot unit and defaulted to metre,
    // reporting every distance 3.28x too small on a WKT2 foot-CRS file.
    if (n.keyword !== 'UNIT' && n.keyword !== 'LENGTHUNIT') continue;
    const name = wktNodeName(n);
    if (name === undefined) continue;
    const scale = wktFirstNumber(n);
    if (scale === undefined) continue;
    result = { name, scale };
  }
  return result;
}

/**
 * The horizontal unit of a WKT unit clause with a valid factor. The factor is
 * the unit: it is named metre, foot or US survey foot only when it is that
 * unit within 1e-9 m (writers emit the US survey foot at limited precision),
 * and then carries the exact factor. Any other factor keeps its declared value
 * with the token 'unknown', and is a valid unit (`linearUnitByFactor`). A name
 * is never matched as a substring ("centimetre" is not a metre), and a name
 * that spells a different named unit than its factor is noted, not obeyed.
 */
function horizontalUnitOf(name: string, scale: number): { unit: CrsLinearUnit; toMetres: number; note?: string } {
  const named = namedUnitForFactor(scale);
  const spelled = namedUnitForName(name);
  const note = spelled !== undefined && spelled !== named
    ? `Declared horizontal unit name "${name}" disagrees with its factor (${scale} m per unit); the factor is used`
    : named === undefined ? `Declared horizontal unit "${name}" is ${scale} m per unit` : undefined;
  return named
    ? { unit: named, toMetres: metresPerLinearUnit(named), ...(note ? { note } : {}) }
    : { unit: 'unknown', toMetres: scale, ...(note ? { note } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// GeoTIFF path (LAS 1.0–1.3 fallback)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GeoTIFF GeoKey directory layout — header (4 u16s) then n*4 u16 entries:
 *   header[0] = key revision (always 1)
 *   header[1] = key revision minor
 *   header[2] = minor revision
 *   header[3] = number of keys (n)
 *   entry: { keyId, tiffTag, count, valueOrOffset }
 * When tiffTag == 0, valueOrOffset IS the value (a SHORT).
 * When tiffTag == 34736 (GeoDoubleParams), valueOrOffset is an offset into
 *   the GeoDoubleParams float64 array, with `count` doubles.
 * When tiffTag == 34737 (GeoAsciiParams), valueOrOffset is an offset into
 *   the GeoAsciiParams ASCII array, with `count` chars.
 */
export function crsFromGeoTiff(
  geokeyBytes: Uint8Array,
  geoAsciiBytes: Uint8Array | null,
  _geoDoubleBytes: Uint8Array | null,
): CrsInfo {
  const view = new DataView(
    geokeyBytes.buffer,
    geokeyBytes.byteOffset,
    geokeyBytes.byteLength,
  );

  // Each u16 entry is 2 bytes. Need at least 4 u16s (8 bytes) for the header.
  if (geokeyBytes.byteLength < 8) {
    return {
      source: 'geotiff',
      name: 'Unknown CRS (truncated GeoTIFF VLR)',
      linearUnit: 'unknown',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
  }

  const numKeys = view.getUint16(6, true);
  const expectedBytes = 8 + numKeys * 8;
  if (geokeyBytes.byteLength < expectedBytes) {
    return {
      source: 'geotiff',
      name: 'Unknown CRS (truncated GeoTIFF keys)',
      linearUnit: 'unknown',
      linearUnitToMetres: 1,
      isGeographic: false,
    };
  }

  let modelType: number | undefined;
  let projectedCrs: number | undefined;
  let geodeticCrs: number | undefined;
  let gtCitationOffset: number | undefined;
  let gtCitationCount: number | undefined;
  let projectedCitationOffset: number | undefined;
  let projectedCitationCount: number | undefined;
  let geodeticCitationOffset: number | undefined;
  let geodeticCitationCount: number | undefined;
  let linearUnitCode: number | undefined;
  let verticalCrs: number | undefined;
  let verticalUnitCode: number | undefined;
  let verticalCitationOffset: number | undefined;
  let verticalCitationCount: number | undefined;

  for (let i = 0; i < numKeys; i++) {
    const o = 8 + i * 8;
    const keyId = view.getUint16(o, true);
    const tiffTag = view.getUint16(o + 2, true);
    const count = view.getUint16(o + 4, true);
    const value = view.getUint16(o + 6, true);

    switch (keyId) {
      case GEOKEY_GT_MODEL_TYPE:           modelType = value; break;
      case GEOKEY_PROJECTED_CRS:           projectedCrs = value; break;
      case GEOKEY_GEODETIC_CRS:            geodeticCrs = value; break;
      case GEOKEY_GT_CITATION:
        if (tiffTag === RECORD_ID_GEO_ASCII_PARAMS) {
          gtCitationOffset = value;
          gtCitationCount = count;
        }
        break;
      case GEOKEY_PROJECTED_CITATION:
        if (tiffTag === RECORD_ID_GEO_ASCII_PARAMS) {
          projectedCitationOffset = value;
          projectedCitationCount = count;
        }
        break;
      case GEOKEY_GEODETIC_CITATION:
        if (tiffTag === RECORD_ID_GEO_ASCII_PARAMS) {
          geodeticCitationOffset = value;
          geodeticCitationCount = count;
        }
        break;
      case GEOKEY_PROJ_LINEAR_UNITS:
      case GEOKEY_GEOGRAPHIC_LINEAR_UNITS:
        linearUnitCode = value;
        break;
      case GEOKEY_VERTICAL_CRS:
        verticalCrs = value;
        break;
      case GEOKEY_VERTICAL_UNITS:
        verticalUnitCode = value;
        break;
      case GEOKEY_VERTICAL_CITATION:
        if (tiffTag === RECORD_ID_GEO_ASCII_PARAMS) {
          verticalCitationOffset = value;
          verticalCitationCount = count;
        }
        break;
    }
  }

  // GeoTIFF codes 0 and 32767 are placeholders meaning "none" and
  // "user-defined": in both cases the file declared NO code, so surfacing one
  // invents an identity. `verticalDatumLabel` already rejects the same pair on
  // the vertical axis; the horizontal axis never got the check, and printed
  // `EPSG:32767` as though it were a real CRS.
  const realCode = (v: number | undefined): number | undefined =>
    v !== undefined && v > 0 && v !== 32767 ? v : undefined;
  const projected = realCode(projectedCrs);
  const geodetic = realCode(geodeticCrs);

  /*
   * GTModelTypeGeoKey (1024) is OPTIONAL — a GeographicTypeGeoKey on its own is
   * a legal georeference, and plenty of writers emit exactly that. Treating its
   * absence as "not geographic" made a lat/lon file resolve as PROJECTED with a
   * metre factor, which is not a labelling problem: the measurement guard reads
   * that kind, so distances computed over degrees were displayed in metres and
   * saved (0.001 deg of latitude is ~111 m).
   *
   * The kind is recoverable without key 1024, because the key that CARRIES the
   * code already states it: 3072 is ProjectedCSTypeGeoKey, 2048 is
   * GeographicTypeGeoKey. A projected CRS commonly names its base geographic
   * CRS in 2048 as well, so the projected key wins when both are present.
   */
  const epsg = projected ?? geodetic;
  // Model type 3 is geocentric; so is a geocentric code with no model type.
  const geocentric = modelType === 3 || (modelType === undefined && projected === undefined && isGeocentricEpsg(geodetic));
  const isGeographic =
    !geocentric && (modelType !== undefined
      ? modelType === 2
      : projected === undefined && geodetic !== undefined);
  const projectedCitation = readGeoTiffCitation(
    geoAsciiBytes,
    projectedCitationOffset,
    projectedCitationCount,
  );
  // GTCitationGeoKey (1026) is the citation for the CRS the file is in. libLAS
  // 1.2 writes a name there and leaves 3073 unset, so it is the only citation a
  // file like utm15.las carries. readGeoTiffCitation stops at the `|` GeoTIFF
  // terminator and returns undefined for an empty or whitespace-only run, so a
  // blank 1026 falls through to the names below.
  const gtCitation = readGeoTiffCitation(
    geoAsciiBytes,
    gtCitationOffset,
    gtCitationCount,
  );
  const citation = projectedCitation ?? readGeoTiffCitation(
    geoAsciiBytes,
    geodeticCitationOffset,
    geodeticCitationCount,
  );

  const mappedUnit = linearUnitCode !== undefined ? GEOTIFF_LINEAR_UNITS[linearUnitCode] : undefined;
  // Declaring nothing and declaring something we cannot resolve are different
  // facts and must not resolve alike. With no ProjLinearUnitsGeoKey the
  // GeoTIFF default applies and a projected CRS is metres. With a key present
  // whose code is outside our table — 9095 British foot, say — the file has
  // stated a unit we cannot honour, and answering 'metre' presented every
  // length from it as metres and was wrong by the unit's own factor. 'unknown'
  // is what the downstream `linearUnit !== 'unknown'` gates read to refuse.
  //
  // With no key at all, the unit is the one the EPSG code defines, not an
  // assumed metre: EPSG:2264 is in US survey feet. impliedProjectedLinearUnit
  // answers from the curated registry and a whitelist of metre families, and
  // 'unknown' for any other code.
  const declaredButUnresolved = linearUnitCode !== undefined && mappedUnit === undefined;
  let linearUnit: CrsLinearUnit;
  if (mappedUnit !== undefined) linearUnit = mappedUnit;
  else if (isGeographic || declaredButUnresolved) linearUnit = 'unknown';
  else linearUnit = impliedProjectedLinearUnit(epsg);
  const linearUnitToMetres = metresPerLinearUnit(linearUnit);

  // A citation only names THIS CRS when it is the projected one. GeoTIFF
  // citations are free text, and a projected file that carries only a
  // GeogCitation ("WGS 84") was taking it as the CRS's own name, so a UTM zone
  // 29N survey displayed as "WGS 84 (EPSG:32629)", which a reader is entitled
  // to read as EPSG:4326 and degrees. A geographic CRS is still free to use its
  // geographic citation, because there it does describe the CRS.
  //
  // Projected name precedence, highest first:
  //   1. ProjectedCSCitationGeoKey (3073), which by definition names this
  //      projected CRS;
  //   2. the curated registry label for the EPSG code, which carries the datum;
  //   3. wellKnownCrsName, the systematic WGS 84 UTM naming that covers every
  //      zone the registry does not list;
  //   4. GTCitationGeoKey (1026);
  //   5. the bare `EPSG:<code>`.
  //
  // 1026 ranks below both code-derived names because GTCitationGeoKey
  // guarantees only free text describing the CRS the file is in, not that the
  // text names the projected CRS: a 32615 file whose 1026 reads "NAD83" would
  // otherwise print a geographic datum name over a metre grid.
  //
  // A WKT VLR outranks all five: `parseCrsFromVlrs` takes the WKT name and
  // reads the GeoKeys only for vertical fields.
  const codeDerivedName =
    (isGeographic ? undefined : curatedProjectedName(epsg)) ?? wellKnownCrsName(epsg);
  const baseName = isGeographic
    ? (citation ?? codeDerivedName)
    : (projectedCitation ?? codeDerivedName ?? gtCitation);
  let name: string;
  if (baseName === undefined) {
    name = epsg ? `EPSG:${epsg}` : 'Unknown CRS';
  } else if (epsg) {
    name = `${baseName} (EPSG:${epsg})`;
  } else {
    name = baseName;
  }

  // Vertical datum: a real EPSG (verticalDatumLabel rejects the 0 / 32767
  // placeholders), else fall back to the citation text when present.
  let verticalEpsg: number | undefined;
  let verticalDatum = verticalCrs != null ? verticalDatumLabel(verticalCrs) : undefined;
  if (verticalDatum) {
    verticalEpsg = verticalCrs;
  } else {
    const vCite = readGeoTiffCitation(geoAsciiBytes, verticalCitationOffset, verticalCitationCount);
    if (vCite) verticalDatum = vCite;
  }

  // Vertical unit (VerticalUnitsGeoKey 4099). A recognised 4099 is used; with
  // no 4099 the unit the vertical EPSG code defines applies (6360 is NAVD88
  // in US survey feet). With neither it stays undefined so callers fall back
  // to the horizontal linear unit (the GeoTIFF default). A 4099 that
  // contradicts the code's own unit resolves to unknown and is reported.
  let declaredVerticalUnit: CrsLinearUnit | undefined;
  if (verticalUnitCode !== undefined) declaredVerticalUnit = GEOTIFF_LINEAR_UNITS[verticalUnitCode] ?? 'unknown';
  const vUnit = resolveVerticalUnit(declaredVerticalUnit, verticalEpsg);
  if (vUnit.datumLabel && verticalEpsg !== undefined) verticalDatum = vUnit.datumLabel;

  return {
    source: 'geotiff',
    name,
    epsg,
    linearUnit,
    linearUnitToMetres,
    isGeographic,
    verticalEpsg,
    verticalDatum,
    ...verticalUnitFields(vUnit),
    ...(geocentric ? { geocentric: true } : {}),
  };
}

/** Parameters for {@link crsFromEpsg}. */
export interface EpsgCrsParams {
  /** Vertical (height) datum EPSG, when the source declares one separately. */
  readonly verticalEpsg?: number;
  /** Whether the horizontal CRS is geographic (degrees). Default false. */
  readonly isGeographic?: boolean;
  /** Display name override. Default `EPSG:<code>`. */
  readonly name?: string;
  /**
   * Linear unit override. Default: the unit the projected code defines (see
   * {@link impliedProjectedLinearUnit}), 'unknown' when it is not one we know,
   * and 'unknown' for a geographic CRS.
   */
  readonly linearUnit?: CrsLinearUnit;
}

/**
 * Build a {@link CrsInfo} from EPSG codes alone — for sources that georeference
 * by authority code rather than by WKT or GeoTIFF tags (e.g. an EPT `ept.json`
 * `srs` with `horizontal` / `vertical` codes and no `wkt`). The vertical datum
 * is carried through identically to the GeoTIFF path (real code → known name or
 * `EPSG:<code>`; 0 / 32767 rejected), so a streamed dataset that declares its
 * datum by code surfaces it exactly like an uploaded file would.
 */
export function crsFromEpsg(horizontalEpsg: number, params: EpsgCrsParams = {}): CrsInfo {
  const isGeographic = params.isGeographic ?? false;
  const linearUnit: CrsLinearUnit =
    params.linearUnit ?? (isGeographic ? 'unknown' : impliedProjectedLinearUnit(horizontalEpsg));
  // verticalDatumLabel returns undefined for the placeholder codes (0 / 32767),
  // so a bogus vertical code never produces a datum or a verticalEpsg.
  const verticalDatum = params.verticalEpsg != null ? verticalDatumLabel(params.verticalEpsg) : undefined;
  const verticalEpsg = verticalDatum ? params.verticalEpsg : undefined;
  // The vertical code carries its own unit (6360 is NAVD88 in US survey feet).
  const vUnit = resolveVerticalUnit(undefined, verticalEpsg);
  return {
    source: 'epsg',
    name: params.name ?? `EPSG:${horizontalEpsg}`,
    epsg: horizontalEpsg,
    linearUnit,
    linearUnitToMetres: metresPerLinearUnit(linearUnit),
    isGeographic,
    verticalEpsg,
    verticalDatum,
    verticalLinearUnit: vUnit.unit,
    verticalUnitToMetres: vUnit.toMetres,
    ...(isGeocentricEpsg(horizontalEpsg) ? { geocentric: true } : {}),
  };
}

/**
 * The curated registry's label for a PROJECTED EPSG code, or undefined when the
 * code is unregistered or registered as geographic. `getCrsEntry` is the same
 * catalogue the CRS-override picker offers by name and `resolveHorizontalDatum`
 * reads for a GeoTIFF-keyed file's datum, so one code resolves to one name
 * across those seams. Its labels carry the datum ("NAD83 / UTM zone 15N"); a
 * zone name without one is ambiguous, because UTM zone 15N exists on NAD83,
 * WGS 84 and NAD27 alike.
 */
function curatedProjectedName(epsg: number | undefined): string | undefined {
  if (epsg === undefined) return undefined;
  const entry = getCrsEntry(epsg);
  return entry?.kind === 'projected' ? entry.label : undefined;
}

/**
 * The name a well-known EPSG code fully determines, or undefined.
 *
 * The WGS 84 UTM ranges are systematic (326zz is zone zz north, 327zz is zone
 * zz south), so the code names the CRS exactly, with no catalog and no
 * guesswork. This covers all 120 zones, including the ones the curated registry
 * does not list. Worth stating outright because the alternative was a writer's
 * free-text citation, which is how a projected scan came to be labelled with
 * its base geographic CRS.
 */
function wellKnownCrsName(epsg: number | undefined): string | undefined {
  if (epsg === undefined) return undefined;
  const zone = epsg % 100;
  if (zone < 1 || zone > 60) return undefined;
  const band = Math.floor(epsg / 100);
  if (band === 326) return `WGS 84 / UTM zone ${zone}N`;
  if (band === 327) return `WGS 84 / UTM zone ${zone}S`;
  return undefined;
}

function readGeoTiffCitation(
  asciiBytes: Uint8Array | null,
  offset: number | undefined,
  count: number | undefined,
): string | undefined {
  if (!asciiBytes || offset === undefined || count === undefined) return undefined;
  if (offset + count > asciiBytes.byteLength) return undefined;
  let s = '';
  for (let i = 0; i < count; i++) {
    const c = asciiBytes[offset + i];
    if (c === 0 || c === 0x7c) break; // GeoTIFF uses | as a citation separator
    s += String.fromCharCode(c);
  }
  return s.trim() || undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Units implied by an EPSG code
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Projected EPSG ranges whose axes are metres by the EPSG definition. Every
 * range was checked against the EPSG dataset (proj.db): each code in it
 * exists and its first axis unit is EPSG 9001, metre. A range must never span
 * a code in feet, since that code would then be read 3.28x wrong in silence.
 * Anything outside these and outside the curated registry has no unit we can
 * vouch for.
 */
const METRE_PROJECTED_RANGES: readonly (readonly [number, number])[] = [
  [32601, 32660], // WGS 84 / UTM zones 1N-60N
  [32701, 32760], // WGS 84 / UTM zones 1S-60S
  [26901, 26923], // NAD83 / UTM zones 1N-23N
  [26701, 26722], // NAD27 / UTM zones 1N-22N
  [6330, 6348], // NAD83(2011) / UTM zones 1N-19N
  [2955, 2962], // NAD83(CSRS) / UTM zones 11N-21N
  [3154, 3160], // NAD83(CSRS) / UTM zones 7N-16N
  [25828, 25838], // ETRS89 / UTM zones 28N-38N
  [3034, 3035], // ETRS89-extended / LCC Europe, LAEA Europe
  [28348, 28358], // GDA94 / MGA zones 48-58
  [7846, 7859], // GDA2020 / MGA zones 46-59
  [3006, 3018], // SWEREF99 TM and the SWEREF99 local zones
  [31466, 31469], // DHDN / 3-degree Gauss-Kruger zones 2-5
  [31254, 31259], // MGI / Austria GK West .. M34
  [31284, 31287], // MGI / Austria M28, M31, M34, Lambert
  [3857, 3857], // WGS 84 / Pseudo-Mercator
  [27700, 27700], // OSGB36 / British National Grid
  [28992, 28992], // Amersfoort / RD New
  [2154, 2154], // RGF93 v1 / Lambert-93
  [2193, 2193], // NZGD2000 / NZTM 2000
];

/**
 * The linear unit a projected EPSG code defines when the source states no unit
 * of its own: the curated registry's unit for a registered code (metre unless
 * the entry says otherwise), metre for the whitelisted metre families, and
 * 'unknown' for everything else. A code like 2264 (NAD83 / North Carolina ftUS)
 * is in US survey feet; assuming metres there was wrong by 3.28x, so an
 * unrecognised code is never presumed metric.
 */
export function impliedProjectedLinearUnit(epsg: number | undefined): CrsLinearUnit {
  if (epsg === undefined) return 'unknown';
  const entry = getCrsEntry(epsg);
  if (entry && entry.kind !== 'geographic') return entry.linearUnit ?? 'metre';
  return METRE_PROJECTED_RANGES.some(([lo, hi]) => epsg >= lo && epsg <= hi) ? 'metre' : 'unknown';
}

/** Map a metres-per-unit factor back to the unit token, or undefined if it is not one we name. */
function unitForMetresPerUnit(m: number): CrsLinearUnit | undefined {
  for (const u of ['metre', 'foot', 'us-survey-foot'] as const) {
    if (Math.abs(metresPerLinearUnit(u) - m) < 1e-12) return u;
  }
  return undefined;
}

/**
 * The named unit a declared factor IS, within the precision writers emit the
 * three named units at (1e-9 m, which still separates the two feet by 600x).
 * Undefined for any other factor: a centimetre, a yard or a kilometre is a
 * valid length unit, but not one of the three the app names.
 */
function namedUnitForFactor(m: number): CrsLinearUnit | undefined {
  for (const u of ['metre', 'foot', 'us-survey-foot'] as const) {
    if (Math.abs(metresPerLinearUnit(u) - m) < 1e-9) return u;
  }
  return undefined;
}

/**
 * The named unit a unit NAME spells, matched as a whole name so "centimetre"
 * or "kilometre" never reads as a metre. Used only to notice a name that
 * disagrees with its factor; the factor decides the unit.
 */
function namedUnitForName(name: string | undefined): CrsLinearUnit | undefined {
  const n = (name ?? '').trim().toLowerCase().replaceAll('_', ' ');
  if (/^(us survey foot|us survey feet|foot us|ftus|us foot|us feet|survey foot)$/.test(n)) return 'us-survey-foot';
  if (/^(foot|feet|ft|international foot|international feet)$/.test(n)) return 'foot';
  if (/^(metre|meter|metres|meters|m)$/.test(n)) return 'metre';
  return undefined;
}

/**
 * A vertical unit as the source declares it: the name it gives (when any) and
 * its metres-per-unit factor exactly as written. A factor that is not finite
 * and positive marks a unit that was declared but cannot be read as a length.
 */
export interface DeclaredVerticalUnit {
  readonly name?: string;
  readonly toMetres: number;
}

/** Outcome of {@link resolveVerticalUnit}. */
export interface VerticalUnitResolution {
  readonly unit?: CrsLinearUnit;
  readonly toMetres?: number;
  /** Set when a declared unit could not be read as a length unit. */
  readonly conflict?: string;
  /** Set when a declared unit overrides the unit the vertical code defines, or its name disagrees with its factor. */
  readonly note?: string;
  /** Label of the same-datum code in the declared unit (6360 for 5703 in ftUS), when one is known. */
  readonly datumLabel?: string;
}

/**
 * Resolve the vertical unit from an explicitly declared unit (when any) and
 * the vertical EPSG code. A declared length unit is the unit, as GDAL and
 * libgeotiff read VerticalUnitsGeoKey: 5703 (NAVD88) with 4099 = 9003 is
 * NAVD88 height in US survey feet (EPSG:6360), the common encoding of it.
 * When it differs from the code's own unit, `note` records the override and
 * `datumLabel` names the same-datum variant in that unit if one is known.
 * With no declared unit, the code's own unit applies.
 *
 * A declaration is a unit token (a GeoKey code already mapped) or a name and
 * factor read from WKT. The FACTOR is the physical scale, as PROJ reads it:
 * a centimetre is 0.01 m per unit and a yard 0.9144, whatever the token. The
 * token is 'metre', 'foot' or 'us-survey-foot' only when the factor is that
 * unit; any other valid factor keeps its own value with the token 'unknown'.
 * A name that spells a different named unit than the factor ("metre" at
 * 0.3048) does not change the number: the factor is used and `note` says so.
 * A declaration that is not a length unit, or whose factor is missing, zero,
 * negative or non-finite, resolves to 'unknown' with a non-finite factor and
 * a `conflict`, which every vertical-scale gate reads as invalid. It is never
 * replaced by the code's unit or the horizontal unit: the source stated a
 * vertical unit, and stated it wrongly.
 */
export function resolveVerticalUnit(
  declared: CrsLinearUnit | DeclaredVerticalUnit | undefined,
  verticalEpsg: number | undefined,
): VerticalUnitResolution {
  const known = knownVerticalCrs(verticalEpsg);
  const implied = known ? unitForMetresPerUnit(known.metresPerUnit) : undefined;
  if (declared === undefined) {
    return implied ? { unit: implied, toMetres: known!.metresPerUnit } : {};
  }
  const d: DeclaredVerticalUnit = typeof declared === 'string'
    ? (declared === 'unknown' ? { toMetres: Number.NaN } : { toMetres: metresPerLinearUnit(declared) })
    : declared;
  if (!(Number.isFinite(d.toMetres) && d.toMetres > 0)) {
    const what = d.name ? `Declared vertical unit "${d.name}"` : 'Declared vertical unit';
    return {
      unit: 'unknown',
      toMetres: Number.NaN,
      conflict: `${what} is not a length unit that can be read`,
    };
  }
  const named = namedUnitForFactor(d.toMetres);
  const unit: CrsLinearUnit = named ?? 'unknown';
  const toMetres = named ? metresPerLinearUnit(named) : d.toMetres;
  const spelled = namedUnitForName(d.name);
  const notes: string[] = [];
  if (spelled !== undefined && spelled !== named) {
    notes.push(`Declared vertical unit name "${d.name}" disagrees with its factor (${d.toMetres} m per unit); the factor is used`);
  } else if (named === undefined) {
    notes.push(`Declared vertical unit${d.name ? ` "${d.name}"` : ''} is ${d.toMetres} m per unit`);
  }
  if (implied === undefined || implied === unit) return { unit, toMetres, ...(notes.length ? { note: notes.join('. ') } : {}) };
  const variant = sameDatumVariantInUnit(verticalEpsg, toMetres);
  notes.push(`Declared vertical unit (${named ?? `${toMetres} m per unit`}) overrides the unit of EPSG:${verticalEpsg} (${implied})`);
  return {
    unit,
    toMetres,
    note: notes.join('. '),
    ...(variant !== undefined ? { datumLabel: knownVerticalCrs(variant)!.label } : {}),
  };
}

/** The declared vertical unit a CrsInfo carries, for re-resolving against another vertical code. */
export function declaredVerticalUnitOf(crs: Pick<CrsInfo, 'verticalLinearUnit' | 'verticalUnitToMetres'>): DeclaredVerticalUnit | undefined {
  if (crs.verticalUnitToMetres !== undefined) return { toMetres: crs.verticalUnitToMetres };
  return crs.verticalLinearUnit === undefined ? undefined : crs.verticalLinearUnit === 'unknown' ? { toMetres: Number.NaN } : { toMetres: metresPerLinearUnit(crs.verticalLinearUnit) };
}

/** The CrsInfo vertical fields a {@link VerticalUnitResolution} sets. */
export function verticalUnitFields(v: VerticalUnitResolution): Pick<CrsInfo, 'verticalLinearUnit' | 'verticalUnitToMetres' | 'verticalUnitConflict' | 'verticalUnitNote'> {
  return {
    verticalLinearUnit: v.unit,
    verticalUnitToMetres: v.toMetres,
    ...(v.conflict ? { verticalUnitConflict: v.conflict } : {}),
    ...(v.note ? { verticalUnitNote: v.note } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Metres per one unit of a named CRS linear unit. The single mapping every
 * panel and deliverable uses (via `CrsInfo.linearUnitToMetres`), so a sheet
 * drawn in US survey feet converts with 1200/3937, never the international
 * 0.3048. An unknown unit maps to the inert 1 (see {@link toMetres}).
 */
export function metresPerLinearUnit(unit: CrsLinearUnit): number {
  switch (unit) {
    case 'metre': return 1;
    case 'foot': return 0.3048;
    case 'us-survey-foot': return 1200 / 3937;
    case 'unknown': return 1;
  }
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s.trim();
}

function readNullTerminatedBytes(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display + measurement helpers (used by UI + the scan-report card)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compact human label for a unit — for inspector + scan-report rows. Pass the
 * CRS's factor too, so a valid unit that is not one of the named three (a
 * centimetre or kilometre grid) reads by its size rather than as unknown.
 */
export function linearUnitLabel(unit: CrsLinearUnit, byFactor?: { readonly linearUnitByFactor?: boolean; readonly linearUnitToMetres?: number }): string {
  switch (unit) {
    case 'metre': return 'metres';
    case 'foot': return 'international ft';
    case 'us-survey-foot': return 'US survey ft';
    case 'unknown': {
      const f = byFactor?.linearUnitToMetres;
      return byFactor?.linearUnitByFactor === true && f !== undefined && Number.isFinite(f) && f > 0 ? `units of ${f} m` : 'unknown';
    }
  }
}

/**
 * Convert a measurement value from the source CRS's linear units to METRES.
 * Used by the measurement tool so a distance displayed as "15.25 m" is true
 * 15.25 metres regardless of whether the source is metres, intl ft or US ft.
 *
 * When the source unit is `unknown` we pass the value through unchanged — the
 * UI should annotate the value with "(unknown units)" in that case.
 */
export function toMetres(value: number, crs: CrsInfo | null): number {
  if (!crs) return value;
  return value * crs.linearUnitToMetres;
}
