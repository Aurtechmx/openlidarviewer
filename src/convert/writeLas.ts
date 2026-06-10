/**
 * writeLas.ts — minimal, correct binary LAS writers (1.2 and 1.4).
 *
 * `writeLas` writes LAS 1.2 with a Public Header Block, an optional
 * GeoKeyDirectory VLR that records the EPSG code, and point records in the
 * smallest legacy point format that carries the cloud's attributes:
 *
 *   format 0  x y z intensity return/class source-id
 *   format 1  + GPS time
 *   format 2  + RGB
 *   format 3  + GPS time + RGB
 *
 * `writeLas14` writes LAS 1.4 with the extended point record formats —
 * format 6 (no colour) or 7 (RGB). The extended records carry the FULL
 * 8-bit classification, where the legacy formats clamp it to 5 bits; this
 * is also the record family COPC requires, so the 1.4 writer is the
 * foundation for future COPC output.
 *
 * Both writers quantise coordinates as
 * `int32 = round((global - offset) / scale)`. The offset is the per-axis
 * floor of the data minimum and the scale is mm for projected data (0.001)
 * or ~1e-7° for geographic, so the integer grid stays well inside int32
 * range while preserving the source precision.
 *
 * Pure data — no DOM. Returns the LAS file as bytes.
 */

import type { GlobalPoints } from './globalPoints';
import { globalBounds } from './globalPoints';

const HEADER_SIZE = 227; // LAS 1.2 public header block
const HEADER_SIZE_14 = 375; // LAS 1.4 public header block (R15)
const VLR_HEADER_SIZE = 54;
const RECORD_LEN: Record<number, number> = { 0: 20, 1: 28, 2: 26, 3: 34 };
const RECORD_LEN_14: Record<number, number> = { 6: 30, 7: 36 };
/** Global-encoding bit 4 — declares the CRS VLR is OGC WKT (LAS 1.4 §2.2). */
const GLOBAL_ENCODING_WKT = 0x10;

export interface WriteLasOptions {
  /** EPSG to record in a GeoKeyDirectory VLR. Omitted → no CRS VLR. */
  readonly epsg?: number | null;
  /** Whether the EPSG is a geographic (lat/lon) CRS — picks model type + scale. */
  readonly isGeographic?: boolean;
  /**
   * GeoTIFF linear-unit code for a projected CRS (9001 metre, 9002 foot,
   * 9003 US survey foot). Written as ProjLinearUnitsGeoKey so a reader knows
   * the unit even when the EPSG alone is ambiguous. Ignored for geographic.
   */
  readonly linearUnitCode?: number | null;
  /** Vertical (height) datum EPSG (e.g. 5703 NAVD88) → VerticalCSTypeGeoKey. */
  readonly verticalEpsg?: number | null;
  /** Quantisation scale per axis. Defaults: projected 0.001, geographic 1e-7. */
  readonly scale?: [number, number, number];
}

/** LAS 1.4 options: everything LAS 1.2 takes, plus the OGC WKT CRS payload. */
export interface WriteLas14Options extends WriteLasOptions {
  /**
   * OGC WKT describing the CRS. LAS 1.4 requires the CRS as WKT for point
   * formats 6+ (global-encoding bit 4); when this is present it is written
   * as a LASF_Projection/2112 VLR and the bit is set. When only an EPSG code
   * is known we fall back to the same GeoKey VLR the 1.2 writer emits (bit 4
   * clear) — honest about the encoding actually in the file, rather than
   * fabricating a parameterless WKT downstream tools could not use.
   */
  readonly wkt?: string | null;
}

function writeFixedString(bytes: Uint8Array, offset: number, len: number, text: string): void {
  for (let i = 0; i < len; i++) {
    bytes[offset + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0;
  }
}

// ── helpers shared by the 1.2 and 1.4 writers ───────────────────────────────

/**
 * Quantisation: offset = floor(min). Scale defaults to mm for projected,
 * ~1e-7° for geographic. The scale is then widened per axis if the extent
 * would otherwise push the int32 grid past its range — this guarantees no
 * coordinate overflow regardless of CRS guess or dataset size (LAS stores
 * X/Y/Z as signed int32, max ≈ 2.147e9; we keep a safety margin at 2.0e9).
 */
function deriveQuantisation(
  g: GlobalPoints,
  geo: boolean,
  wantScale?: [number, number, number],
): {
  min: [number, number, number];
  max: [number, number, number];
  scale: [number, number, number];
  offset: [number, number, number];
} {
  const { min, max } = globalBounds(g);
  const want = wantScale ?? (geo ? [1e-7, 1e-7, 0.001] : [0.001, 0.001, 0.001]);
  const scale: [number, number, number] = [0, 1, 2].map((a) => {
    const range = max[a] - min[a];
    const needed = range > 0 ? range / 2.0e9 : 0;
    return Math.max(want[a], needed);
  }) as [number, number, number];
  const offset: [number, number, number] = [
    Math.floor(min[0]),
    Math.floor(min[1]),
    Math.floor(min[2]),
  ];
  return { min, max, scale, offset };
}

/**
 * Build the GeoKey entries for a GeoKeyDirectory VLR, keyId-ascending, all
 * SHORT (tiffTag 0, count 1). Returns [] when no CRS can be tagged this way:
 * GeoKey values are uint16, so only EPSG codes that fit can be recorded — a
 * larger code (e.g. some ESRI codes) would corrupt to a wrong CRS, so we omit
 * the VLR rather than write a lie. The caller surfaces a warning.
 */
function buildGeoKeys(opts: WriteLasOptions, geo: boolean): Array<[number, number]> {
  const hasCrs = opts.epsg != null && Number.isFinite(opts.epsg) && opts.epsg > 0 && opts.epsg <= 65535;
  const geoKeys: Array<[number, number]> = [];
  if (hasCrs) {
    geoKeys.push([1024, geo ? 2 : 1]); // GTModelType: geographic / projected
    geoKeys.push([geo ? 2048 : 3072, opts.epsg as number]); // Geographic/ProjectedCSType
    if (!geo && opts.linearUnitCode != null && opts.linearUnitCode > 0) {
      geoKeys.push([3076, opts.linearUnitCode]); // ProjLinearUnits (metre/foot/US ft)
    }
    if (opts.verticalEpsg != null && opts.verticalEpsg > 0 && opts.verticalEpsg <= 65535) {
      // Vertical height datum + its unit (match a projected foot horizontal,
      // else metres — elevation is metres for geographic horizontals).
      const vUnit = !geo && (opts.linearUnitCode === 9002 || opts.linearUnitCode === 9003)
        ? opts.linearUnitCode
        : 9001;
      geoKeys.push([4096, opts.verticalEpsg]); // VerticalCSType
      geoKeys.push([4099, vUnit]); // VerticalUnits
    }
  }
  return geoKeys;
}

/** Write a GeoKeyDirectory VLR (header + payload) starting at byte `p`. */
function writeGeoKeyVlr(
  view: DataView,
  bytes: Uint8Array,
  p: number,
  geoKeys: ReadonlyArray<[number, number]>,
): void {
  const geoKeyDataBytes = 8 + geoKeys.length * 8;
  view.setUint16(p, 0, true); // reserved
  writeFixedString(bytes, p + 2, 16, 'LASF_Projection');
  view.setUint16(p + 18, 34735, true); // record id: GeoKeyDirectoryTag
  view.setUint16(p + 20, geoKeyDataBytes, true); // record length after header
  writeFixedString(bytes, p + 22, 32, 'GeoKeyDirectoryTag');
  p += VLR_HEADER_SIZE;
  // GeoKey header: dirVersion=1, revision=1, minorRevision=0, numKeys.
  view.setUint16(p, 1, true);
  view.setUint16(p + 2, 1, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, geoKeys.length, true);
  // Each key entry: keyId, tiffTagLocation=0 (SHORT), count=1, value.
  for (let k = 0; k < geoKeys.length; k++) {
    const eo = p + 8 + k * 8;
    view.setUint16(eo, geoKeys[k][0], true);
    view.setUint16(eo + 2, 0, true);
    view.setUint16(eo + 4, 1, true);
    view.setUint16(eo + 6, geoKeys[k][1] & 0xffff, true);
  }
}

/**
 * Write scale, offset, and max/min bounds — bytes 131–226, identical layout
 * in every LAS version (bounds are stored MAX-then-MIN per axis).
 */
function writeScaleOffsetBounds(
  view: DataView,
  scale: [number, number, number],
  offset: [number, number, number],
  min: [number, number, number],
  max: [number, number, number],
): void {
  view.setFloat64(131, scale[0], true);
  view.setFloat64(139, scale[1], true);
  view.setFloat64(147, scale[2], true);
  view.setFloat64(155, offset[0], true);
  view.setFloat64(163, offset[1], true);
  view.setFloat64(171, offset[2], true);
  view.setFloat64(179, max[0], true);
  view.setFloat64(187, min[0], true);
  view.setFloat64(195, max[1], true);
  view.setFloat64(203, min[1], true);
  view.setFloat64(211, max[2], true);
  view.setFloat64(219, min[2], true);
}

/**
 * Tally points per return number into `slots` buckets. Returns are 1-based;
 * a missing attribute or an out-of-range value lands in slot 0 (return 1),
 * mirroring how the record writer clamps the per-point return field.
 */
function tallyByReturn(g: GlobalPoints, slots: number): Uint32Array {
  const byReturn = new Uint32Array(slots);
  if (g.returnNumber) {
    for (let i = 0; i < g.count; i++) {
      const r = g.returnNumber[i];
      if (r >= 1 && r <= slots) byReturn[r - 1]++;
      else byReturn[0]++;
    }
  } else {
    byReturn[0] = g.count;
  }
  return byReturn;
}

/** Choose the point format from the attributes present. */
export function pickPointFormat(g: GlobalPoints): 0 | 1 | 2 | 3 {
  const color = g.colors != null;
  const gps = g.gpsTime != null;
  if (color && gps) return 3;
  if (color) return 2;
  if (gps) return 1;
  return 0;
}

/** Serialise `g` to a LAS 1.2 file. */
export function writeLas(g: GlobalPoints, opts: WriteLasOptions = {}): Uint8Array {
  const fmt = pickPointFormat(g);
  const recLen = RECORD_LEN[fmt];
  const n = g.count;

  const geo = opts.isGeographic === true;
  const geoKeys = buildGeoKeys(opts, geo);
  const geoKeyDataBytes = geoKeys.length > 0 ? 8 + geoKeys.length * 8 : 0;
  const vlrBytes = geoKeyDataBytes > 0 ? VLR_HEADER_SIZE + geoKeyDataBytes : 0;
  const pointDataOffset = HEADER_SIZE + vlrBytes;
  const total = pointDataOffset + n * recLen;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const { min, max, scale, offset } = deriveQuantisation(g, geo, opts.scale);

  // ── Public Header Block ────────────────────────────────────────────────
  writeFixedString(bytes, 0, 4, 'LASF');
  view.setUint16(4, 0, true); // file source id
  view.setUint16(6, 0, true); // global encoding (GPS week time)
  // 8..23 Project ID GUID — left zero.
  view.setUint8(24, 1); // version major
  view.setUint8(25, 2); // version minor (LAS 1.2)
  writeFixedString(bytes, 26, 32, 'OpenLiDARViewer');
  writeFixedString(bytes, 58, 32, 'OpenLiDARViewer converter');
  view.setUint16(90, 0, true); // file creation day of year (deterministic)
  view.setUint16(92, 0, true); // file creation year
  view.setUint16(94, HEADER_SIZE, true); // header size
  view.setUint32(96, pointDataOffset, true); // offset to point data
  view.setUint32(100, geoKeys.length > 0 ? 1 : 0, true); // number of VLRs
  view.setUint8(104, fmt); // point data record format
  view.setUint16(105, recLen, true); // point data record length
  view.setUint32(107, n >>> 0, true); // legacy number of point records

  // legacy number of points by return (5 × uint32) — tally by return number.
  const byReturn = tallyByReturn(g, 5);
  for (let r = 0; r < 5; r++) view.setUint32(111 + r * 4, byReturn[r], true);

  writeScaleOffsetBounds(view, scale, offset, min, max);

  // ── GeoKeyDirectory VLR (CRS) ──────────────────────────────────────────
  if (geoKeys.length > 0) {
    writeGeoKeyVlr(view, bytes, HEADER_SIZE, geoKeys);
  }

  // ── Point records ──────────────────────────────────────────────────────
  const sx = scale[0];
  const sy = scale[1];
  const sz = scale[2];
  for (let i = 0; i < n; i++) {
    const rp = pointDataOffset + i * recLen;
    view.setInt32(rp, Math.round((g.x[i] - offset[0]) / sx), true);
    view.setInt32(rp + 4, Math.round((g.y[i] - offset[1]) / sy), true);
    view.setInt32(rp + 8, Math.round((g.z[i] - offset[2]) / sz), true);
    view.setUint16(rp + 12, g.intensity ? g.intensity[i] : 0, true);
    // return bits: return number (1–7) | number of returns (1–7)
    const rn = g.returnNumber ? Math.min(7, Math.max(1, g.returnNumber[i])) : 1;
    const rc = g.returnCount ? Math.min(7, Math.max(1, g.returnCount[i])) : 1;
    view.setUint8(rp + 14, (rn & 0x07) | ((rc & 0x07) << 3));
    view.setUint8(rp + 15, g.classification ? g.classification[i] & 0x1f : 0);
    view.setInt8(rp + 16, 0); // scan angle rank
    view.setUint8(rp + 17, 0); // user data
    view.setUint16(rp + 18, g.pointSourceId ? g.pointSourceId[i] : 0, true);
    if (fmt === 1 || fmt === 3) {
      view.setFloat64(rp + 20, g.gpsTime ? g.gpsTime[i] : 0, true);
    }
    if (fmt === 2 || fmt === 3) {
      const co = fmt === 2 ? rp + 20 : rp + 28;
      const c = g.colors as Uint8Array;
      view.setUint16(co, c[i * 3] * 257, true);
      view.setUint16(co + 2, c[i * 3 + 1] * 257, true);
      view.setUint16(co + 4, c[i * 3 + 2] * 257, true);
    }
  }

  return bytes;
}

/**
 * Choose the LAS 1.4 extended point format. GPS time is built into the
 * extended record, so colour is the only branch: 7 with RGB, 6 without.
 */
export function pickPointFormat14(g: GlobalPoints): 6 | 7 {
  return g.colors != null ? 7 : 6;
}

/** Serialise `g` to a LAS 1.4 file (point format 6 or 7). */
export function writeLas14(g: GlobalPoints, opts: WriteLas14Options = {}): Uint8Array {
  const fmt = pickPointFormat14(g);
  const recLen = RECORD_LEN_14[fmt];
  const n = g.count;
  const geo = opts.isGeographic === true;

  // CRS: the OGC WKT VLR when real WKT exists (the LAS 1.4 way — payload is
  // null-terminated ASCII, hence the +1), else the same GeoKey VLR the 1.2
  // writer emits. A WKT too long for the uint16 VLR length field cannot be
  // recorded at all (none of our sources come close; guarded anyway).
  const wkt = opts.wkt != null && opts.wkt.trim().length > 0 && opts.wkt.length + 1 <= 0xffff
    ? opts.wkt
    : null;
  const geoKeys = wkt == null ? buildGeoKeys(opts, geo) : [];
  const geoKeyDataBytes = geoKeys.length > 0 ? 8 + geoKeys.length * 8 : 0;
  const wktDataBytes = wkt != null ? wkt.length + 1 : 0;
  const vlrCount = (wkt != null ? 1 : 0) + (geoKeys.length > 0 ? 1 : 0);
  const vlrBytes =
    (wkt != null ? VLR_HEADER_SIZE + wktDataBytes : 0) +
    (geoKeys.length > 0 ? VLR_HEADER_SIZE + geoKeyDataBytes : 0);
  const pointDataOffset = HEADER_SIZE_14 + vlrBytes;
  const total = pointDataOffset + n * recLen;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  const { min, max, scale, offset } = deriveQuantisation(g, geo, opts.scale);

  // ── Public Header Block (375 bytes) ────────────────────────────────────
  writeFixedString(bytes, 0, 4, 'LASF');
  view.setUint16(4, 0, true); // file source id
  // Global encoding: bit 4 declares the CRS VLR is OGC WKT — required by the
  // spec for point formats 6+, but only settable when we actually have WKT.
  view.setUint16(6, wkt != null ? GLOBAL_ENCODING_WKT : 0, true);
  // 8..23 Project ID GUID — left zero.
  view.setUint8(24, 1); // version major
  view.setUint8(25, 4); // version minor (LAS 1.4)
  writeFixedString(bytes, 26, 32, 'OpenLiDARViewer');
  writeFixedString(bytes, 58, 32, 'OpenLiDARViewer converter');
  view.setUint16(90, 0, true); // file creation day of year (deterministic)
  view.setUint16(92, 0, true); // file creation year
  view.setUint16(94, HEADER_SIZE_14, true); // header size
  view.setUint32(96, pointDataOffset, true); // offset to point data
  view.setUint32(100, vlrCount, true); // number of VLRs
  view.setUint8(104, fmt); // point data record format
  view.setUint16(105, recLen, true); // point data record length
  // Legacy point count + legacy by-return (bytes 107–135): the spec REQUIRES
  // zero for point formats 6+ — readers must use the uint64 extended fields.
  // (Already zero from the ArrayBuffer init; written out for the audit trail.)
  view.setUint32(107, 0, true);
  for (let r = 0; r < 5; r++) view.setUint32(111 + r * 4, 0, true);

  writeScaleOffsetBounds(view, scale, offset, min, max);

  // 227 start-of-waveform (f64), 235 first-EVLR offset (u64), 243 EVLR count
  // (u32) — all zero (no waveforms, no EVLRs). Then the extended counts.
  view.setBigUint64(247, BigInt(n), true); // extended number of point records
  const byReturn = tallyByReturn(g, 15); // 15 × uint64 extended by-return
  for (let r = 0; r < 15; r++) view.setBigUint64(255 + r * 8, BigInt(byReturn[r]), true);

  // ── VLR: OGC WKT (preferred) or GeoKeyDirectory fallback ───────────────
  if (wkt != null) {
    const p = HEADER_SIZE_14;
    view.setUint16(p, 0, true); // reserved
    writeFixedString(bytes, p + 2, 16, 'LASF_Projection');
    view.setUint16(p + 18, 2112, true); // record id: OGC Coordinate System WKT
    view.setUint16(p + 20, wktDataBytes, true); // record length after header
    writeFixedString(bytes, p + 22, 32, 'OGC Coordinate System WKT');
    // Payload — WKT is ASCII by construction; the trailing NUL terminator is
    // the buffer's zero-init.
    for (let i = 0; i < wkt.length; i++) {
      bytes[p + VLR_HEADER_SIZE + i] = wkt.charCodeAt(i) & 0x7f;
    }
  } else if (geoKeys.length > 0) {
    writeGeoKeyVlr(view, bytes, HEADER_SIZE_14, geoKeys);
  }

  // ── Point records (extended layout, 30/36 bytes) ───────────────────────
  const sx = scale[0];
  const sy = scale[1];
  const sz = scale[2];
  for (let i = 0; i < n; i++) {
    const rp = pointDataOffset + i * recLen;
    view.setInt32(rp, Math.round((g.x[i] - offset[0]) / sx), true);
    view.setInt32(rp + 4, Math.round((g.y[i] - offset[1]) / sy), true);
    view.setInt32(rp + 8, Math.round((g.z[i] - offset[2]) / sz), true);
    view.setUint16(rp + 12, g.intensity ? g.intensity[i] : 0, true);
    // return bits: return number (1–15, bits 0–3) | number of returns (bits 4–7)
    const rn = g.returnNumber ? Math.min(15, Math.max(1, g.returnNumber[i])) : 1;
    const rc = g.returnCount ? Math.min(15, Math.max(1, g.returnCount[i])) : 1;
    view.setUint8(rp + 14, (rn & 0x0f) | ((rc & 0x0f) << 4));
    // class flags (0–3) | scanner channel (4–5) | scan direction (6) |
    // edge of flight line (7) — the model carries none of these.
    view.setUint8(rp + 15, 0);
    // FULL 8-bit classification — the extended record's whole reason to
    // exist here: LAS 1.2's 5-bit field clamps class 64/200 to garbage.
    view.setUint8(rp + 16, g.classification ? g.classification[i] : 0);
    view.setUint8(rp + 17, 0); // user data — not in the model
    // Scan angle is an int16 in 0.006° units in the extended record; the
    // model carries no scan angle (no loader decodes it), so write 0.
    view.setInt16(rp + 18, 0, true);
    view.setUint16(rp + 20, g.pointSourceId ? g.pointSourceId[i] : 0, true);
    view.setFloat64(rp + 22, g.gpsTime ? g.gpsTime[i] : 0, true);
    if (fmt === 7) {
      // 8→16 bit via ×257 (= v<<8 | v) so the reader's high-byte narrowing
      // recovers the original 8-bit value exactly.
      const c = g.colors as Uint8Array;
      view.setUint16(rp + 30, c[i * 3] * 257, true);
      view.setUint16(rp + 32, c[i * 3 + 1] * 257, true);
      view.setUint16(rp + 34, c[i * 3 + 2] * 257, true);
    }
  }

  return bytes;
}
