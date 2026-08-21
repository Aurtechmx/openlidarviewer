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

import {
  collectWktNodes,
  parseWkt,
  wktChildNodes,
  wktFirstNumber,
  wktNodeName,
  type WktNode,
} from './wktParser';
import { getCrsEntry } from '../geo/CrsRegistry';

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

  if (wktPayload) {
    const fromWkt = crsFromWkt(wktPayload);
    if (geokeyBytes == null) return fromWkt;
    // LAS 1.4 permits a WKT VLR and a GeoKeyDirectory VLR in the same file,
    // and this app's own 1.4 writer uses that: most WKT — including every WKT
    // `wktForEpsg` derives — describes the horizontal frame only, so the
    // vertical datum and vertical unit travel in the GeoKeys beside it.
    // Taking the WKT and dropping the GeoKeys threw both away, and a NAVD88
    // height in feet then read back as an undeclared unit the terrain tools
    // fall back to metres for — 3.28× wrong, provenance gone. The WKT stays
    // the sole authority on the horizontal frame and on any vertical axis it
    // does declare; only the vertical fields it leaves empty are filled here.
    if (fromWkt.verticalEpsg != null && fromWkt.verticalLinearUnit != null) return fromWkt;
    const fromKeys = crsFromGeoTiff(geokeyBytes, geoAsciiBytes, geoDoubleBytes);
    const merged: CrsInfo = {
      ...fromWkt,
      verticalEpsg: fromWkt.verticalEpsg ?? fromKeys.verticalEpsg,
      verticalDatum: fromWkt.verticalDatum ?? fromKeys.verticalDatum,
      verticalLinearUnit: fromWkt.verticalLinearUnit ?? fromKeys.verticalLinearUnit,
      verticalUnitToMetres: fromWkt.verticalUnitToMetres ?? fromKeys.verticalUnitToMetres,
    };
    return merged;
  }
  if (geokeyBytes) return crsFromGeoTiff(geokeyBytes, geoAsciiBytes, geoDoubleBytes);
  return null;
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
  // Trim wrapper whitespace + null terminators.
  const text = wkt.replace(/\0+$/, '').trim();

  const root = parseWkt(text);
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
  const rawName =
    firstName(horizNodes, isHorizontalCrsKeyword)
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
  const horizCrsNode = horizNodes.find((n) => isHorizontalCrsKeyword(n.keyword));
  const epsg = horizCrsNode ? epsgFromNodeChildren(horizCrsNode) : undefined;

  // Linear units. A projected WKT typically contains TWO UNIT clauses:
  // an angular one inside the nested GEOGCS (e.g. degrees), then the
  // projected linear one at the top level (metres / feet / etc.). We need
  // the LAST one in the horizontal slice for projected CRSs. For geographic
  // CRSs the unit is degrees and the "linear" field falls back to 'unknown'.
  const isGeographic =
    !horizNodes.some((n) => isProjectedKeyword(n.keyword)) &&
    horizNodes.some((n) => isGeographicKeyword(n.keyword));
  let linearUnit: CrsLinearUnit = 'unknown';
  let linearUnitToMetres = 1;
  if (!isGeographic) {
    // Scan ONLY the horizontal slice. A COMPD_CS's vertical block carries
    // its own UNIT (almost always metres); scanning the full text let that
    // vertical metre clause win over the horizontal one — e.g. a state-plane
    // CRS in US survey feet + NAVD88 metres parsed as metres.
    const projectedUnit = lastLinearUnit(horizNodes);
    if (projectedUnit) {
      const scale = projectedUnit.scale;
      if (Number.isFinite(scale) && scale > 0) {
        linearUnitToMetres = scale;
        linearUnit = linearUnitFromNameOrScale(projectedUnit.name.toLowerCase(), scale);
      }
    } else {
      // No UNIT clause is rare on a projected CRS — default to metres.
      // linearUnitToMetres stays at its initial 1 (metre) on this path.
      linearUnit = 'metre';
    }
  }

  // Vertical CRS — present in a COMPD_CS / COMPOUNDCRS or a standalone
  // VERT_CS. The name (e.g. "NAVD88") is the reliable signal; the EPSG is a
  // best-effort reverse lookup for the writer. The vertical block's own UNIT
  // (when present) gives the Z-axis unit, which can differ from the horizontal.
  const vert = verticalNode ? extractVerticalFromNode(verticalNode) : {};

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

/** Extract the vertical-CRS name + best-effort EPSG + unit from a VERT_CS node. */
function extractVerticalFromNode(
  vert: WktNode,
): { epsg?: number; name?: string; unit?: CrsLinearUnit } {
  const name = wktNodeName(vert);
  // A known datum name resolves to the vertical CRS code directly; otherwise
  // fall back to an explicit EPSG authority on the vertical node itself (its own
  // AUTHORITY / ID, NOT a nested VERT_DATUM authority).
  const epsg = (name ? verticalEpsgFromName(name) : undefined) ?? epsgFromNodeChildren(vert);
  // The vertical node's UNIT child names the Z-axis unit (LAS WKT puts at most
  // one UNIT here). Mapped to our enum so elevation can convert by its own unit.
  let unit: CrsLinearUnit | undefined;
  const unitClause = lastLinearUnit(collectWktNodes(vert));
  if (unitClause) {
    const scale = unitClause.scale;
    if (Number.isFinite(scale) && scale > 0) unit = linearUnitFromNameOrScale(unitClause.name.toLowerCase(), scale);
  }
  return { name, epsg, unit };
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

/** The vertical-CRS keywords (WKT1 `VERT_CS`, WKT2 `VERTCRS` / `VERTICALCRS`). */
function isVerticalKeyword(k: string): boolean {
  return k === 'VERT_CS' || k === 'VERTCRS' || k === 'VERTICALCRS';
}

/** The compound-CRS keywords (WKT1 `COMPD_CS`, WKT2 `COMPOUNDCRS`). */
function isCompoundKeyword(k: string): boolean {
  return k === 'COMPD_CS' || k === 'COMPOUNDCRS';
}

/** A horizontal CRS node — the one whose name and authority describe the frame. */
function isHorizontalCrsKeyword(k: string): boolean {
  return isProjectedKeyword(k) || isGeographicKeyword(k);
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
 * The LAST linear `UNIT` clause among `candidates` (document order), returning
 * its name + scale. Only bare `UNIT` nodes count — WKT2's `LENGTHUNIT` /
 * `ANGLEUNIT` are intentionally NOT read here, matching the prior parser's
 * `\bUNIT\[` scan (which a `LENGTHUNIT` substring never satisfied). A node
 * qualifies only when it has a quoted name and a numeric scale, exactly the
 * `UNIT["name",<number>` shape the old regex required.
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
  const isGeographic =
    modelType !== undefined
      ? modelType === 2
      : projected === undefined && geodetic !== undefined;
  const epsg = projected ?? geodetic;
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
  const declaredButUnresolved = linearUnitCode !== undefined && mappedUnit === undefined;
  const linearUnit: CrsLinearUnit =
    mappedUnit ?? (isGeographic || declaredButUnresolved ? 'unknown' : 'metre');
  const linearUnitToMetres = unitScaleForCode(linearUnit);

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
