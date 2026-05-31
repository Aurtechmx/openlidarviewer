/**
 * pntsDecode.ts
 *
 * Pure decoder for the OGC 3D Tiles **PNTS** (Point Cloud) tile format.
 * No I/O, no three.js, no DOM — unit-testable in Node.
 *
 * PNTS layout (28-byte header + Feature Table JSON + Feature Table Binary
 * + optional Batch Table JSON + optional Batch Table Binary):
 *
 *   bytes 0..3   magic       "pnts"
 *   bytes 4..7   version     uint32 LE   (1)
 *   bytes 8..11  byteLength  uint32 LE   total file length
 *   bytes 12..15 featureTableJsonByteLength
 *   bytes 16..19 featureTableBinaryByteLength
 *   bytes 20..23 batchTableJsonByteLength
 *   bytes 24..27 batchTableBinaryByteLength
 *
 * Feature Table JSON declares the point count and the layout of each
 * attribute (POSITION / POSITION_QUANTIZED, RGB / RGBA / RGB565,
 * NORMAL / NORMAL_OCT16P). Each attribute references a byte offset into
 * the binary block. The decoder supports the common subset used by
 * almost every 3D Tiles point cloud in the wild:
 *
 *   - POSITION (3 × float32)
 *   - POSITION_QUANTIZED (3 × uint16, + QUANTIZED_VOLUME_OFFSET / SCALE)
 *   - RGB (3 × uint8)
 *   - RGBA (4 × uint8)
 *   - NORMAL (3 × float32)
 *
 * Less-common encodings (RGB565, NORMAL_OCT16P, batched attributes via
 * the Batch Table) are surfaced as a clear "not implemented yet" error
 * so the streaming adapter can fall back; v0.3.7 ships the 90% subset
 * cleanly and leaves room to grow.
 */

/** Decoded point payload — flat interleaved typed arrays. */
export interface DecodedPnts {
  /** Number of points. */
  readonly pointCount: number;
  /** Interleaved x/y/z float32 in the tile's local frame. */
  readonly positions: Float32Array;
  /** Interleaved RGB (3 bytes / point) when the tile carries colour, else null. */
  readonly colors: Uint8Array | null;
  /** Interleaved nx/ny/nz float32 when the tile carries normals, else null. */
  readonly normals: Float32Array | null;
  /**
   * The 3-D tile-relative-to-tile-set transform component the PNTS spec
   * encodes in `RTC_CENTER`. Callers add this to positions when placing
   * the tile in the parent's frame; the decoder leaves positions in
   * tile-local for clarity. `null` when the tile doesn't ship an RTC.
   */
  readonly rtcCenter: readonly [number, number, number] | null;
}

const MAGIC = 0x73746e70; // 'pnts' little-endian

/**
 * Decode a PNTS tile from its raw bytes. Throws a clear `Error` on any
 * structural problem; the streaming worker forwards it into a per-tile
 * "decoding failed" status message.
 */
export function decodePnts(buf: ArrayBuffer): DecodedPnts {
  if (buf.byteLength < 28) {
    throw new Error(`PNTS: header is ${buf.byteLength} bytes; need at least 28.`);
  }
  const dv = new DataView(buf);
  const magic = dv.getUint32(0, true);
  if (magic !== MAGIC) {
    throw new Error(`PNTS: bad magic 0x${magic.toString(16).padStart(8, '0')}; expected 'pnts'.`);
  }
  const version = dv.getUint32(4, true);
  if (version !== 1) {
    throw new Error(`PNTS: unsupported version ${version}; this decoder reads version 1.`);
  }
  const byteLength = dv.getUint32(8, true);
  if (byteLength !== buf.byteLength) {
    throw new Error(`PNTS: declared byteLength ${byteLength} ≠ actual ${buf.byteLength}.`);
  }
  const ftJsonLen = dv.getUint32(12, true);
  const ftBinLen = dv.getUint32(16, true);
  // Batch table sections exist but PNTS v1 doesn't need them for the
  // common subset; we record the offsets only for future use.

  const ftJsonOffset = 28;
  const ftBinOffset = ftJsonOffset + ftJsonLen;

  if (ftJsonOffset + ftJsonLen > buf.byteLength) {
    throw new Error(`PNTS: Feature Table JSON overruns the file.`);
  }
  if (ftBinOffset + ftBinLen > buf.byteLength) {
    throw new Error(`PNTS: Feature Table Binary overruns the file.`);
  }

  const jsonBytes = new Uint8Array(buf, ftJsonOffset, ftJsonLen);
  const decoder = new TextDecoder();
  const jsonText = decoder.decode(jsonBytes).trim();
  let ft: unknown;
  try {
    ft = JSON.parse(jsonText);
  } catch {
    throw new Error('PNTS: Feature Table JSON is not valid JSON.');
  }
  if (typeof ft !== 'object' || ft === null) {
    throw new Error('PNTS: Feature Table JSON must be an object.');
  }
  const ftRec = ft as Record<string, unknown>;

  const pointCount = readGlobal(ftRec, 'POINTS_LENGTH', true);
  if (pointCount == null || pointCount < 0) {
    throw new Error('PNTS: missing required POINTS_LENGTH.');
  }

  // Positions — required. Either POSITION (3 × float32) or POSITION_QUANTIZED.
  const positions = readPositions(ftRec, buf, ftBinOffset, pointCount);
  const colors = readColors(ftRec, buf, ftBinOffset, pointCount);
  const normals = readNormals(ftRec, buf, ftBinOffset, pointCount);
  const rtcCenter = readRtcCenter(ftRec);

  return { pointCount, positions, colors, normals, rtcCenter };
}

// ── attribute readers ───────────────────────────────────────────────────────

function readPositions(
  ft: Record<string, unknown>,
  buf: ArrayBuffer,
  ftBinOffset: number,
  pointCount: number,
): Float32Array {
  if (ft.POSITION != null) {
    const byteOffset = readByteOffset(ft.POSITION, 'POSITION');
    if (ftBinOffset + byteOffset + pointCount * 12 > buf.byteLength) {
      throw new Error('PNTS: POSITION overruns the Feature Table Binary.');
    }
    return new Float32Array(buf, ftBinOffset + byteOffset, pointCount * 3).slice();
  }
  if (ft.POSITION_QUANTIZED != null) {
    const byteOffset = readByteOffset(ft.POSITION_QUANTIZED, 'POSITION_QUANTIZED');
    const offset = readGlobalVec3(ft, 'QUANTIZED_VOLUME_OFFSET');
    const scale = readGlobalVec3(ft, 'QUANTIZED_VOLUME_SCALE');
    if (!offset || !scale) {
      throw new Error(
        'PNTS: POSITION_QUANTIZED requires QUANTIZED_VOLUME_OFFSET + QUANTIZED_VOLUME_SCALE.',
      );
    }
    if (ftBinOffset + byteOffset + pointCount * 6 > buf.byteLength) {
      throw new Error('PNTS: POSITION_QUANTIZED overruns the Feature Table Binary.');
    }
    const src = new Uint16Array(buf, ftBinOffset + byteOffset, pointCount * 3);
    const out = new Float32Array(pointCount * 3);
    const sx = scale[0] / 65535;
    const sy = scale[1] / 65535;
    const sz = scale[2] / 65535;
    for (let i = 0; i < pointCount; i++) {
      out[i * 3] = offset[0] + src[i * 3] * sx;
      out[i * 3 + 1] = offset[1] + src[i * 3 + 1] * sy;
      out[i * 3 + 2] = offset[2] + src[i * 3 + 2] * sz;
    }
    return out;
  }
  throw new Error('PNTS: missing both POSITION and POSITION_QUANTIZED; one is required.');
}

function readColors(
  ft: Record<string, unknown>,
  buf: ArrayBuffer,
  ftBinOffset: number,
  pointCount: number,
): Uint8Array | null {
  if (ft.RGB != null) {
    const byteOffset = readByteOffset(ft.RGB, 'RGB');
    if (ftBinOffset + byteOffset + pointCount * 3 > buf.byteLength) {
      throw new Error('PNTS: RGB overruns the Feature Table Binary.');
    }
    return new Uint8Array(buf, ftBinOffset + byteOffset, pointCount * 3).slice();
  }
  if (ft.RGBA != null) {
    const byteOffset = readByteOffset(ft.RGBA, 'RGBA');
    if (ftBinOffset + byteOffset + pointCount * 4 > buf.byteLength) {
      throw new Error('PNTS: RGBA overruns the Feature Table Binary.');
    }
    // Drop the alpha channel to match the rest of the platform's
    // interleaved RGB shape.
    const src = new Uint8Array(buf, ftBinOffset + byteOffset, pointCount * 4);
    const out = new Uint8Array(pointCount * 3);
    for (let i = 0; i < pointCount; i++) {
      out[i * 3] = src[i * 4];
      out[i * 3 + 1] = src[i * 4 + 1];
      out[i * 3 + 2] = src[i * 4 + 2];
    }
    return out;
  }
  if (ft.RGB565 != null) {
    throw new Error('PNTS: RGB565 colour encoding is not implemented in this decoder yet.');
  }
  return null;
}

function readNormals(
  ft: Record<string, unknown>,
  buf: ArrayBuffer,
  ftBinOffset: number,
  pointCount: number,
): Float32Array | null {
  if (ft.NORMAL != null) {
    const byteOffset = readByteOffset(ft.NORMAL, 'NORMAL');
    if (ftBinOffset + byteOffset + pointCount * 12 > buf.byteLength) {
      throw new Error('PNTS: NORMAL overruns the Feature Table Binary.');
    }
    return new Float32Array(buf, ftBinOffset + byteOffset, pointCount * 3).slice();
  }
  if (ft.NORMAL_OCT16P != null) {
    throw new Error('PNTS: NORMAL_OCT16P encoding is not implemented in this decoder yet.');
  }
  return null;
}

function readRtcCenter(ft: Record<string, unknown>): [number, number, number] | null {
  return readGlobalVec3(ft, 'RTC_CENTER');
}

// ── small json helpers ─────────────────────────────────────────────────────

function readByteOffset(v: unknown, attr: string): number {
  if (typeof v !== 'object' || v === null) {
    throw new Error(`PNTS: ${attr} must be an object with byteOffset.`);
  }
  const off = (v as Record<string, unknown>).byteOffset;
  if (typeof off !== 'number' || !Number.isFinite(off) || off < 0) {
    throw new Error(`PNTS: ${attr}.byteOffset must be a non-negative number.`);
  }
  return off;
}

function readGlobal(ft: Record<string, unknown>, key: string, required: boolean): number | null {
  const v = ft[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (required) return null;
  return null;
}

function readGlobalVec3(
  ft: Record<string, unknown>,
  key: string,
): [number, number, number] | null {
  const v = ft[key];
  if (
    Array.isArray(v) &&
    v.length === 3 &&
    typeof v[0] === 'number' &&
    typeof v[1] === 'number' &&
    typeof v[2] === 'number' &&
    Number.isFinite(v[0]) &&
    Number.isFinite(v[1]) &&
    Number.isFinite(v[2])
  ) {
    return [v[0], v[1], v[2]];
  }
  return null;
}
