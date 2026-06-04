/**
 * writeLas.ts — minimal, correct binary LAS 1.2 writer.
 *
 * Writes a Public Header Block, an optional GeoKeyDirectory VLR that records
 * the EPSG code, and point records in the smallest point format that carries
 * the cloud's attributes:
 *
 *   format 0  x y z intensity return/class source-id
 *   format 1  + GPS time
 *   format 2  + RGB
 *   format 3  + GPS time + RGB
 *
 * Coordinates are quantised as `int32 = round((global - offset) / scale)`.
 * The offset is the per-axis floor of the data minimum and the scale is mm
 * for projected data (0.001) or ~1e-7° for geographic, so the integer grid
 * stays well inside int32 range while preserving the source precision.
 *
 * Pure data — no DOM. Returns the LAS file as bytes.
 */

import type { GlobalPoints } from './globalPoints';
import { globalBounds } from './globalPoints';

const HEADER_SIZE = 227; // LAS 1.2 public header block
const VLR_HEADER_SIZE = 54;
const RECORD_LEN: Record<number, number> = { 0: 20, 1: 28, 2: 26, 3: 34 };

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

function writeFixedString(bytes: Uint8Array, offset: number, len: number, text: string): void {
  for (let i = 0; i < len; i++) {
    bytes[offset + i] = i < text.length ? text.charCodeAt(i) & 0x7f : 0;
  }
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
  // GeoKey values are uint16, so only EPSG codes that fit can be tagged this
  // way — a larger code (e.g. some ESRI codes) would corrupt to a wrong CRS,
  // so we omit the VLR rather than write a lie. The caller surfaces a warning.
  const hasCrs = opts.epsg != null && Number.isFinite(opts.epsg) && opts.epsg > 0 && opts.epsg <= 65535;

  // Build the GeoKey entries, keyId-ascending, all SHORT (tiffTag 0, count 1).
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
  const geoKeyDataBytes = geoKeys.length > 0 ? 8 + geoKeys.length * 8 : 0;
  const vlrBytes = geoKeyDataBytes > 0 ? VLR_HEADER_SIZE + geoKeyDataBytes : 0;
  const pointDataOffset = HEADER_SIZE + vlrBytes;
  const total = pointDataOffset + n * recLen;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // Quantisation: offset = floor(min). Scale defaults to mm for projected,
  // ~1e-7° for geographic. We then widen the scale per axis if the extent
  // would otherwise push the int32 grid past its range — this guarantees no
  // coordinate overflow regardless of CRS guess or dataset size (LAS stores
  // X/Y/Z as signed int32, max ≈ 2.147e9; we keep a safety margin at 2.0e9).
  const { min, max } = globalBounds(g);
  const want = opts.scale ?? (geo ? [1e-7, 1e-7, 0.001] : [0.001, 0.001, 0.001]);
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
  view.setUint32(100, hasCrs ? 1 : 0, true); // number of VLRs
  view.setUint8(104, fmt); // point data record format
  view.setUint16(105, recLen, true); // point data record length
  view.setUint32(107, n >>> 0, true); // legacy number of point records

  // legacy number of points by return (5 × uint32) — tally by return number.
  const byReturn = new Uint32Array(5);
  if (g.returnNumber) {
    for (let i = 0; i < n; i++) {
      const r = g.returnNumber[i];
      if (r >= 1 && r <= 5) byReturn[r - 1]++;
      else byReturn[0]++;
    }
  } else {
    byReturn[0] = n;
  }
  for (let r = 0; r < 5; r++) view.setUint32(111 + r * 4, byReturn[r], true);

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

  // ── GeoKeyDirectory VLR (CRS) ──────────────────────────────────────────
  if (geoKeys.length > 0) {
    let p = HEADER_SIZE;
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
