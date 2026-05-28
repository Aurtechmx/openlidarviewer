/**
 * crs.ts
 *
 * Coordinate Reference System detection from LAS / LAZ / COPC variable-length
 * records (VLRs). Two on-disk encodings are supported, matching the LAS
 * specification:
 *
 *   1. OGC WKT (LAS 1.4 default and best for modern files) — VLR with
 *      User ID `LASF_Projection`, record ID 2112 (Coordinate System WKT)
 *      or 2111 (Math Transform WKT). Payload is null-terminated ASCII.
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
  readonly source: 'wkt' | 'geotiff';
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
  /** Whether the CRS is geographic (lat/lon in degrees) vs projected (metres on a plane). */
  readonly isGeographic: boolean;
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
 * EVLRs (LAS 1.4 extended VLRs) share the layout but with a u64 record
 * length — EVLRs are ignored here since COPC pins the CRS into a regular
 * VLR.
 */
const VLR_HEADER_BYTES = 54;
const VLR_USER_ID_OFFSET = 2;
const VLR_USER_ID_LENGTH = 16;
const VLR_RECORD_ID_OFFSET = 18;
const VLR_RECORD_LENGTH_OFFSET = 20;

/** The user ID every LAS georeference VLR uses. */
const CRS_USER_ID = 'LASF_Projection';
/** OGC WKT record IDs. 2112 is the coordinate-system WKT; 2111 is the math transform. */
const RECORD_ID_OGC_WKT_COORD = 2112;
const RECORD_ID_OGC_WKT_MATH = 2111;
/** GeoTIFF tag VLR record IDs. */
const RECORD_ID_GEOKEY_DIRECTORY = 34735;
const RECORD_ID_GEO_DOUBLE_PARAMS = 34736;
const RECORD_ID_GEO_ASCII_PARAMS = 34737;

/** GeoTIFF GeoKey IDs we care about. */
const GEOKEY_GT_MODEL_TYPE = 1024;       // projected (1) / geographic (2) / geocentric (3)
const GEOKEY_GEODETIC_CRS = 2048;        // EPSG of a geographic CRS
const GEOKEY_GEODETIC_CITATION = 2049;   // ASCII citation
const GEOKEY_GEOGRAPHIC_LINEAR_UNITS = 2052;  // linear units of a geographic CRS
const GEOKEY_PROJECTED_CRS = 3072;       // EPSG of a projected CRS
const GEOKEY_PROJECTED_CITATION = 3073;  // ASCII citation
const GEOKEY_PROJ_LINEAR_UNITS = 3076;   // linear units of a projected CRS

// ─────────────────────────────────────────────────────────────────────────────
// Parser entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Walk the VLR list starting at `vlrStartOffset` and extract CRS info if
 * any LASF_Projection VLR is present. Returns `null` when no recognisable
 * CRS VLR is found, the buffer is short, or the VLR list is malformed.
 *
 * Defensive: every uint read is bounds-checked against the buffer length
 * so a malformed VLR can't crash the loader. Caller code can safely treat
 * `null` as "CRS unknown" and proceed with the load.
 */
export function parseCrsFromVlrs(
  buffer: ArrayBuffer,
  vlrStartOffset: number,
  vlrCount: number,
): CrsInfo | null {
  if (vlrCount === 0) return null;
  if (vlrStartOffset + VLR_HEADER_BYTES > buffer.byteLength) return null;

  const view = new DataView(buffer);

  // First pass: collect the LASF_Projection VLR payloads we recognise, in
  // the order they appear. WKT wins over GeoTIFF when both are present
  // because LAS 1.4 mandates WKT for modern files.
  let wktPayload: string | null = null;
  let geokeyBytes: Uint8Array | null = null;
  let geoAsciiBytes: Uint8Array | null = null;
  let geoDoubleBytes: Uint8Array | null = null;

  let cursor = vlrStartOffset;
  for (let i = 0; i < vlrCount; i++) {
    if (cursor + VLR_HEADER_BYTES > buffer.byteLength) break;
    const userId = readAscii(view, cursor + VLR_USER_ID_OFFSET, VLR_USER_ID_LENGTH);
    const recordId = view.getUint16(cursor + VLR_RECORD_ID_OFFSET, true);
    const payloadLength = view.getUint16(cursor + VLR_RECORD_LENGTH_OFFSET, true);
    const payloadStart = cursor + VLR_HEADER_BYTES;
    if (payloadStart + payloadLength > buffer.byteLength) break;

    if (userId === CRS_USER_ID) {
      if (recordId === RECORD_ID_OGC_WKT_COORD || recordId === RECORD_ID_OGC_WKT_MATH) {
        if (!wktPayload) {
          // The OGC WKT payload is null-terminated ASCII per LAS spec.
          wktPayload = readNullTerminated(buffer, payloadStart, payloadLength);
        }
      } else if (recordId === RECORD_ID_GEOKEY_DIRECTORY) {
        geokeyBytes = new Uint8Array(buffer, payloadStart, payloadLength);
      } else if (recordId === RECORD_ID_GEO_ASCII_PARAMS) {
        geoAsciiBytes = new Uint8Array(buffer, payloadStart, payloadLength);
      } else if (recordId === RECORD_ID_GEO_DOUBLE_PARAMS) {
        geoDoubleBytes = new Uint8Array(buffer, payloadStart, payloadLength);
      }
    }

    cursor = payloadStart + payloadLength;
  }

  if (wktPayload) return crsFromWkt(wktPayload);
  if (geokeyBytes) return crsFromGeoTiff(geokeyBytes, geoAsciiBytes, geoDoubleBytes);
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// WKT path (preferred — LAS 1.4 default)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort WKT parser — extracts the top-level CRS name and any AUTHORITY
 * EPSG code, plus the linear unit from the first UNIT[...] clause. A full
 * WKT parser is intentionally out of scope; the regex-based path covers every
 * common LAS WKT (UTM zones, state plane, web mercator, WGS 84) which is
 * what research users actually ship.
 */
export function crsFromWkt(wkt: string): CrsInfo {
  // Trim wrapper whitespace + null terminators.
  const text = wkt.replace(/\0+$/, '').trim();

  // The CRS name is the first quoted string after the top-level keyword
  // (PROJCS / PROJCRS / GEOGCS / GEOGCRS / COMPOUNDCRS).
  const nameMatch = /^(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS|COMPOUNDCRS)\s*\[\s*"([^"]+)"/i.exec(text);
  const rawName = nameMatch ? nameMatch[1] : 'Unknown CRS';

  // EPSG via the standard AUTHORITY clause. LAS WKT is permissive — we look
  // for both AUTHORITY["EPSG","32612"] (WKT1) and ID["EPSG",32612] (WKT2).
  // The LAST authority in the document is usually the top-level CRS's, so
  // we capture every match and take the first one with a 4–6 digit numeric
  // value (EPSG codes never exceed 99999 in practice).
  const epsg = extractEpsgFromWkt(text);

  // Linear units. A projected WKT typically contains TWO UNIT clauses:
  // an angular one inside the nested GEOGCS (e.g. degrees), then the
  // projected linear one at the top level (metres / feet / etc.). We need
  // the LAST one for projected CRSs because that's the linear unit driving
  // the coordinate values. For geographic CRSs the unit is degrees and
  // the "linear" field is meaningless — we fall back to 'unknown'.
  const isGeographic = /^GEOGCS|^GEOGCRS/i.test(text);
  let linearUnit: CrsLinearUnit = 'unknown';
  let linearUnitToMetres = 1;
  if (!isGeographic) {
    const allUnits = [...text.matchAll(/\bUNIT\s*\[\s*"([^"]+)"\s*,\s*([0-9.eE+-]+)/g)];
    // The projected linear unit is the LAST UNIT match (after the inner
    // GEOGCS's angular UNIT). Walking from the back also handles compound
    // CRSs that embed multiple sub-CRSs.
    const projectedUnit = allUnits[allUnits.length - 1];
    if (projectedUnit) {
      const unitName = projectedUnit[1].toLowerCase();
      const scale = Number(projectedUnit[2]);
      if (Number.isFinite(scale) && scale > 0) {
        linearUnitToMetres = scale;
        linearUnit = linearUnitFromNameOrScale(unitName, scale);
      }
    } else {
      // No UNIT clause is rare on a projected CRS — default to metres.
      linearUnit = 'metre';
      linearUnitToMetres = 1;
    }
  }

  return {
    source: 'wkt',
    wkt: text,
    name: epsg ? `${rawName} (EPSG:${epsg})` : rawName,
    epsg,
    linearUnit,
    linearUnitToMetres,
    isGeographic,
  };
}

/**
 * Pull the first credible EPSG code from a WKT string. Looks for both WKT1
 * (`AUTHORITY["EPSG","32612"]`) and WKT2 (`ID["EPSG",32612]`) syntaxes.
 * Numerically constrained to the EPSG range (1024-32767, plus a generous
 * 32768-99999 for newer codes) so we don't latch onto a random integer.
 */
function extractEpsgFromWkt(text: string): number | undefined {
  // WKT can carry many AUTHORITY/ID clauses (datum, primem, axis...).
  // The TOP-LEVEL CRS's authority is conventionally the LAST one in the
  // PROJCS/GEOGCS body that points to EPSG, so we walk all matches and
  // keep the last one inside the EPSG range.
  const matches = text.matchAll(
    /(?:AUTHORITY|ID)\s*\[\s*"EPSG"\s*,\s*"?(\d+)"?\s*\]/gi,
  );
  let last: number | undefined;
  for (const m of matches) {
    const n = Number(m[1]);
    if (Number.isFinite(n) && n >= 1024 && n <= 99999) last = n;
  }
  return last;
}

/**
 * Map a WKT unit name + scale to our internal `CrsLinearUnit` enum. The
 * scale is the authoritative signal — `0.3048006096...` is US survey foot
 * regardless of the unit's textual name — but the name resolves ambiguity
 * when the scale was emitted with limited precision.
 */
function linearUnitFromNameOrScale(name: string, scale: number): CrsLinearUnit {
  // US survey foot is 1200/3937 m ≈ 0.3048006096012192. Most writers emit
  // it as 0.30480060960121921 or rounded to a few decimals; we accept any
  // value within 1 ppm of the canonical.
  if (Math.abs(scale - 1200 / 3937) < 1e-9) return 'us-survey-foot';
  if (Math.abs(scale - 0.3048) < 1e-9) return 'foot';
  if (Math.abs(scale - 1) < 1e-9) return 'metre';
  if (/us\s*survey|us\s*foot|ussfoot/i.test(name)) return 'us-survey-foot';
  if (/foot|feet|^ft$/i.test(name)) return 'foot';
  if (/metre|meter|^m$/i.test(name)) return 'metre';
  return 'unknown';
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
  let projectedCitationOffset: number | undefined;
  let projectedCitationCount: number | undefined;
  let geodeticCitationOffset: number | undefined;
  let geodeticCitationCount: number | undefined;
  let linearUnitCode: number | undefined;

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
    }
  }

  const isGeographic = modelType === 2;
  const epsg = projectedCrs || geodeticCrs;
  const citation = readGeoTiffCitation(
    geoAsciiBytes,
    projectedCitationOffset ?? geodeticCitationOffset,
    projectedCitationCount ?? geodeticCitationCount,
  );

  const mappedUnit = linearUnitCode !== undefined ? GEOTIFF_LINEAR_UNITS[linearUnitCode] : undefined;
  const linearUnit: CrsLinearUnit = mappedUnit ?? (isGeographic ? 'unknown' : 'metre');
  const linearUnitToMetres = unitScaleForCode(linearUnit);

  const baseName = citation
    || (epsg ? `EPSG:${epsg}` : 'Unknown CRS')
    || 'Unknown CRS';
  const name = epsg && !citation ? `EPSG:${epsg}` : (epsg ? `${baseName} (EPSG:${epsg})` : baseName);

  return {
    source: 'geotiff',
    name,
    epsg,
    linearUnit,
    linearUnitToMetres,
    isGeographic,
  };
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
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function unitScaleForCode(unit: CrsLinearUnit): number {
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

function readNullTerminated(buffer: ArrayBuffer, offset: number, length: number): string {
  const view = new DataView(buffer);
  let s = '';
  for (let i = 0; i < length; i++) {
    const c = view.getUint8(offset + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Display + measurement helpers (used by UI + the scan-report card)
// ─────────────────────────────────────────────────────────────────────────────

/** Compact human label for a unit — for inspector + scan-report rows. */
export function linearUnitLabel(unit: CrsLinearUnit): string {
  switch (unit) {
    case 'metre': return 'metres';
    case 'foot': return 'international ft';
    case 'us-survey-foot': return 'US survey ft';
    case 'unknown': return 'unknown';
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
