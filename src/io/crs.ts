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
  /** Z-unit conversion to metres (1 metre, 0.3048 foot, …). Absent ⇒ unknown. */
  readonly verticalUnitToMetres?: number;
  /**
   * Horizontal geodetic datum name as the WKT declares it — the GEOGCS/GEOGCRS
   * (geographic base) name, e.g. "NAD83", "NAD83(2011)", "WGS 84", "ETRS89".
   * This is the realization-PRESERVING name (NAD83(2011) ≠ NAD83 by ~1–2 m), so
   * it is the authoritative source for the resolved datum and must never be
   * downgraded to a registry generic. Absent when the source carried no WKT.
   */
  readonly horizontalDatum?: string;
}

/** Common vertical-datum EPSG codes → readable names. */
const VERTICAL_DATUM_NAMES: Readonly<Record<number, string>> = {
  5703: 'NAVD88',
  5701: 'ODN (Newlyn)',
  5714: 'MSL height',
  5715: 'MSL depth',
  3855: 'EGM2008 height',
  5773: 'EGM96 height',
  6647: 'CGVD2013',
  5705: 'Baltic 1977',
  5612: 'EGM84 height',
};

/**
 * Label a vertical-datum EPSG code (known name, or `EPSG:<code>`). Returns
 * undefined for the placeholder codes that mean "no real datum" (0 / 32767),
 * so callers don't surface a bogus `EPSG:0` as a datum.
 */
export function verticalDatumLabel(epsg: number): string | undefined {
  if (!(epsg > 0) || epsg === 32767) return undefined;
  return VERTICAL_DATUM_NAMES[epsg] ?? `EPSG:${epsg}`;
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
const GEOKEY_VERTICAL_CRS = 4096;        // EPSG of the vertical (height) CRS
const GEOKEY_VERTICAL_CITATION = 4097;   // ASCII citation for the vertical CRS
const GEOKEY_VERTICAL_UNITS = 4099;      // linear units of the vertical CRS

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

  // For a compound CRS (COMPD_CS / COMPOUNDCRS) the horizontal CRS and its
  // EPSG / unit live BEFORE the vertical block, so we analyse only the
  // horizontal slice for name / EPSG / unit. This stops the vertical CRS's
  // EPSG and metre UNIT from being mistaken for the horizontal ones.
  const vertKeyword = /\b(?:VERT_CS|VERTCRS|VERTICALCRS)\s*\[/i.exec(text);
  const horizText = vertKeyword ? text.slice(0, vertKeyword.index) : text;

  // The CRS name is the first quoted string after a PROJCS / GEOGCS keyword
  // (skipping the outer COMPD_CS name, which describes the whole compound).
  const nameMatch = /(?:PROJCS|PROJCRS|GEOGCS|GEOGCRS)\s*\[\s*"([^"]+)"/i.exec(horizText)
    ?? /^(?:COMPD_CS|COMPOUNDCRS)\s*\[\s*"([^"]+)"/i.exec(text);
  const rawName = nameMatch ? nameMatch[1] : 'Unknown CRS';

  // Horizontal datum = the geographic base CRS's name (the GEOGCS / GEOGCRS /
  // BASEGEOGCRS node). For a projected CRS this is the nested base (e.g.
  // "NAD83"); for a geographic CRS it is the CRS itself. It preserves the datum
  // realization — "NAD83(2011)" stays distinct from "NAD83" (~1–2 m apart) — so
  // it is the precision-preserving source the resolver prefers over the generic
  // registry name.
  const datumMatch = /\b(?:GEOGCS|GEOGCRS|BASEGEOGCRS)\s*\[\s*"([^"]+)"/i.exec(horizText);
  const horizontalDatum = datumMatch ? datumMatch[1] : undefined;

  // EPSG via the standard AUTHORITY clause. LAS WKT is permissive — we look
  // for both AUTHORITY["EPSG","32612"] (WKT1) and ID["EPSG",32612] (WKT2).
  // Restricted to the horizontal slice so a compound's vertical code can't win.
  const epsg = extractEpsgFromWkt(horizText);

  // Linear units. A projected WKT typically contains TWO UNIT clauses:
  // an angular one inside the nested GEOGCS (e.g. degrees), then the
  // projected linear one at the top level (metres / feet / etc.). We need
  // the LAST one in the horizontal slice for projected CRSs. For geographic
  // CRSs the unit is degrees and the "linear" field falls back to 'unknown'.
  const isGeographic = !/\b(?:PROJCS|PROJCRS)/i.test(horizText) && /\b(?:GEOGCS|GEOGCRS)/i.test(horizText);
  let linearUnit: CrsLinearUnit = 'unknown';
  let linearUnitToMetres = 1;
  if (!isGeographic) {
    // Scan ONLY the horizontal slice. A COMPD_CS's vertical block carries
    // its own UNIT (almost always metres); scanning the full text let that
    // vertical metre clause win over the horizontal one — e.g. a state-plane
    // CRS in US survey feet + NAVD88 metres parsed as metres.
    const allUnits = [...horizText.matchAll(/\bUNIT\s*\[\s*"([^"]+)"\s*,\s*([0-9.eE+-]+)/g)];
    // The projected linear unit is the LAST UNIT match in the horizontal
    // slice (after the inner GEOGCS's angular UNIT). For non-compound WKT
    // `horizText === text`, so this path is unchanged there.
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

  // Vertical CRS — present in a COMPD_CS / COMPOUNDCRS or a standalone
  // VERT_CS. The name (e.g. "NAVD88") is the reliable signal; the EPSG is a
  // best-effort reverse lookup for the writer. The vertical block's own UNIT
  // (when present) gives the Z-axis unit, which can differ from the horizontal.
  const vert = extractVerticalFromWkt(text);

  return {
    source: 'wkt',
    wkt: text,
    name: epsg ? `${rawName} (EPSG:${epsg})` : rawName,
    epsg,
    linearUnit,
    linearUnitToMetres,
    isGeographic,
    verticalDatum: vert.name,
    verticalEpsg: vert.epsg,
    verticalLinearUnit: vert.unit,
    verticalUnitToMetres: vert.unit ? unitScaleForCode(vert.unit) : undefined,
    horizontalDatum,
  };
}

/** Extract the vertical-CRS name + best-effort EPSG + unit from a WKT string. */
function extractVerticalFromWkt(
  text: string,
): { epsg?: number; name?: string; unit?: CrsLinearUnit } {
  const m = /\b(?:VERT_CS|VERTCRS|VERTICALCRS)\s*\[/i.exec(text);
  if (!m) return {};
  // Isolate the bracketed vertical block so a compound CRS's other authorities
  // (the horizontal CRS, or the compound itself) can't be read as the vertical
  // EPSG. The '[' is the last char of the match.
  const block = bracketBlock(text, m.index + m[0].length - 1);
  const nameMatch = /\[\s*"([^"]+)"/.exec(block);
  const name = nameMatch ? nameMatch[1] : undefined;
  // A known datum name resolves to the vertical CRS code directly; otherwise
  // fall back to an explicit EPSG authority inside the block (the LAST one is
  // the vertical CRS's own, after any VERT_DATUM authority).
  const epsg = (name ? verticalEpsgFromName(name) : undefined) ?? extractEpsgFromWkt(block);
  // The vertical block's UNIT clause names the Z-axis unit (LAS WKT puts at most
  // one UNIT here). Mapped to our enum so elevation can convert by its own unit.
  let unit: CrsLinearUnit | undefined;
  const unitMatches = [...block.matchAll(/\bUNIT\s*\[\s*"([^"]+)"\s*,\s*([0-9.eE+-]+)/g)];
  const unitMatch = unitMatches[unitMatches.length - 1];
  if (unitMatch) {
    const scale = Number(unitMatch[2]);
    if (Number.isFinite(scale) && scale > 0) unit = linearUnitFromNameOrScale(unitMatch[1].toLowerCase(), scale);
  }
  return { name, epsg, unit };
}

/** Return the bracketed group that opens at/after `from` (matched depth-aware). */
function bracketBlock(text: string, from: number): string {
  let open = text[from] === '[' ? from : text.indexOf('[', from);
  if (open < 0) return text.slice(from);
  let depth = 0;
  for (let j = open; j < text.length; j++) {
    if (text[j] === '[') depth++;
    else if (text[j] === ']' && --depth === 0) return text.slice(open, j + 1);
  }
  return text.slice(open);
}

/** Map a vertical-datum name to its EPSG code (the common geoids/datums). */
function verticalEpsgFromName(name: string): number | undefined {
  const n = name.toLowerCase();
  if (n.includes('navd88') || n.includes('navd 88')) return 5703;
  if (n.includes('egm2008')) return 3855;
  if (n.includes('egm96')) return 5773;
  if (n.includes('egm84')) return 5612;
  if (n.includes('odn') || n.includes('newlyn')) return 5701;
  if (n.includes('cgvd2013')) return 6647;
  if (n.includes('baltic')) return 5705;
  if (n.includes('mean sea level') || /\bmsl\b/.test(n)) return 5714;
  return undefined;
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

  // Vertical unit (VerticalUnitsGeoKey 4099). Only surfaced when the file states
  // a recognised unit; otherwise left undefined so callers fall back to the
  // horizontal linear unit (the GeoTIFF default — vertical units follow the
  // model's linear units). Carrying it lets the terrain tools convert elevation
  // by the Z axis's own unit — e.g. feet height over a metre grid.
  const mappedVerticalUnit = verticalUnitCode !== undefined ? GEOTIFF_LINEAR_UNITS[verticalUnitCode] : undefined;
  const verticalLinearUnit = mappedVerticalUnit;
  const verticalUnitToMetres = mappedVerticalUnit ? unitScaleForCode(mappedVerticalUnit) : undefined;

  return {
    source: 'geotiff',
    name,
    epsg,
    linearUnit,
    linearUnitToMetres,
    isGeographic,
    verticalEpsg,
    verticalDatum,
    verticalLinearUnit,
    verticalUnitToMetres,
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
  /** Linear unit override. Default metre (projected) / unknown (geographic). */
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
  const linearUnit: CrsLinearUnit = params.linearUnit ?? (isGeographic ? 'unknown' : 'metre');
  // verticalDatumLabel returns undefined for the placeholder codes (0 / 32767),
  // so a bogus vertical code never produces a datum or a verticalEpsg.
  const verticalDatum = params.verticalEpsg != null ? verticalDatumLabel(params.verticalEpsg) : undefined;
  const verticalEpsg = verticalDatum ? params.verticalEpsg : undefined;
  return {
    source: 'epsg',
    name: params.name ?? `EPSG:${horizontalEpsg}`,
    epsg: horizontalEpsg,
    linearUnit,
    linearUnitToMetres: unitScaleForCode(linearUnit),
    isGeographic,
    verticalEpsg,
    verticalDatum,
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
