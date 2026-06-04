/**
 * demGeoTiff.ts
 *
 * Write a single-band Float32 GeoTIFF for an elevation grid — the gold-standard
 * DEM exchange format. Classic (non-BigTIFF) little-endian TIFF with one
 * uncompressed strip, plus the GeoTIFF tags (ModelPixelScale, ModelTiepoint,
 * GeoKeyDirectory) and a GDAL_NODATA tag. CRS is carried by EPSG code in the
 * GeoKeys, so no WKT lookup is needed.
 *
 * Pure-data: builds and returns the file bytes; no DOM, deterministic.
 *
 * Refs: TIFF 6.0; OGC GeoTIFF 1.1 (ModelTiepoint/ModelPixelScale, GeoKeys).
 */

export interface DemGeoTiffInput {
  /** Row-major cell values; length === cols*rows. */
  readonly values: ArrayLike<number>;
  /** 0 = no data at this cell (written as the NODATA sentinel). */
  readonly coverage: ArrayLike<number>;
  readonly cols: number;
  readonly rows: number;
  /** Square cell size in ground units. */
  readonly cellSize: number;
  /** World X (east) of the lower-left corner of the lower-left cell. */
  readonly xllCorner: number;
  /** World Y (north) of the lower-left corner of the lower-left cell. */
  readonly yllCorner: number;
  /** Sentinel written for empty cells. Default -9999. */
  readonly noData?: number;
  /** Horizontal CRS EPSG code, or null when unknown. */
  readonly epsg?: number | null;
  /** True for a geographic (lat/lon) CRS, false/omitted for projected. */
  readonly isGeographic?: boolean;
  /** Vertical CRS EPSG code, or null. */
  readonly verticalEpsg?: number | null;
}

// TIFF field types.
const T_SHORT = 3;
const T_LONG = 4;
const T_DOUBLE = 12;
const T_ASCII = 2;

interface Tag {
  tag: number;
  type: number;
  count: number;
  /** Inline value (≤4 bytes) OR, for array/double/ascii, the byte offset. */
  value: number;
  /** When set, `value` is filled with the offset and these bytes are emitted. */
  blob?: Uint8Array;
}

function align2(n: number): number {
  return n % 2 === 0 ? n : n + 1;
}

export function writeGeoTiff(input: DemGeoTiffInput): Uint8Array {
  const { cols, rows, cellSize, xllCorner, yllCorner } = input;
  const noData = input.noData ?? -9999;
  const epsg = input.epsg ?? null;
  const verticalEpsg = input.verticalEpsg ?? null;

  // ── GeoKey directory (array of uint16) ───────────────────────────────────
  // Header: [KeyDirectoryVersion=1, KeyRevision=1, MinorRevision=0, NumberOfKeys]
  const keys: number[] = [];
  // GTModelType (1024): 1=Projected, 2=Geographic, 32767=user-defined.
  const modelType = epsg == null ? 32767 : input.isGeographic ? 2 : 1;
  keys.push(1024, 0, 1, modelType);
  // GTRasterType (1025): 1 = RasterPixelIsArea.
  keys.push(1025, 0, 1, 1);
  if (epsg != null) {
    if (input.isGeographic) keys.push(2048, 0, 1, epsg); // GeographicTypeGeoKey
    else keys.push(3072, 0, 1, epsg); // ProjectedCSTypeGeoKey
  }
  if (verticalEpsg != null) keys.push(4096, 0, 1, verticalEpsg); // VerticalCSTypeGeoKey
  const numKeys = keys.length / 4;
  const geoDir = [1, 1, 0, numKeys, ...keys]; // uint16[]

  // ── overflow blobs ───────────────────────────────────────────────────────
  // ModelPixelScale: 3 doubles (sx, sy, sz).
  const pixelScale = new Uint8Array(24);
  {
    const dv = new DataView(pixelScale.buffer);
    dv.setFloat64(0, cellSize, true);
    dv.setFloat64(8, cellSize, true);
    dv.setFloat64(16, 0, true);
  }
  // ModelTiepoint: (I,J,K, X,Y,Z) — raster (0,0) upper-left → world top-left.
  const xUL = xllCorner;
  const yUL = yllCorner + rows * cellSize;
  const tiepoint = new Uint8Array(48);
  {
    const dv = new DataView(tiepoint.buffer);
    dv.setFloat64(0, 0, true); dv.setFloat64(8, 0, true); dv.setFloat64(16, 0, true);
    dv.setFloat64(24, xUL, true); dv.setFloat64(32, yUL, true); dv.setFloat64(40, 0, true);
  }
  // GeoKeyDirectory blob (uint16 LE).
  const geoDirBlob = new Uint8Array(geoDir.length * 2);
  {
    const dv = new DataView(geoDirBlob.buffer);
    for (let i = 0; i < geoDir.length; i++) dv.setUint16(i * 2, geoDir[i], true);
  }
  // GDAL_NODATA ascii (NUL-terminated).
  const noDataAscii = new TextEncoder().encode(`${noData}\0`);

  // ── tag table (must be ascending by tag id) ──────────────────────────────
  const stripByteCount = cols * rows * 4;
  const tags: Tag[] = [
    { tag: 256, type: T_LONG, count: 1, value: cols }, // ImageWidth
    { tag: 257, type: T_LONG, count: 1, value: rows }, // ImageLength
    { tag: 258, type: T_SHORT, count: 1, value: 32 }, // BitsPerSample
    { tag: 259, type: T_SHORT, count: 1, value: 1 }, // Compression = none
    { tag: 262, type: T_SHORT, count: 1, value: 1 }, // Photometric = BlackIsZero
    { tag: 273, type: T_LONG, count: 1, value: 0 }, // StripOffsets (patched)
    { tag: 277, type: T_SHORT, count: 1, value: 1 }, // SamplesPerPixel
    { tag: 278, type: T_LONG, count: 1, value: rows }, // RowsPerStrip
    { tag: 279, type: T_LONG, count: 1, value: stripByteCount }, // StripByteCounts
    { tag: 284, type: T_SHORT, count: 1, value: 1 }, // PlanarConfiguration
    { tag: 339, type: T_SHORT, count: 1, value: 3 }, // SampleFormat = IEEE float
    { tag: 33550, type: T_DOUBLE, count: 3, value: 0, blob: pixelScale }, // ModelPixelScale
    { tag: 33922, type: T_DOUBLE, count: 6, value: 0, blob: tiepoint }, // ModelTiepoint
    { tag: 34735, type: T_SHORT, count: geoDir.length, value: 0, blob: geoDirBlob }, // GeoKeyDirectory
    { tag: 42113, type: T_ASCII, count: noDataAscii.length, value: 0, blob: noDataAscii }, // GDAL_NODATA
  ];

  // ── layout ───────────────────────────────────────────────────────────────
  const ifdStart = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = align2(ifdStart + ifdSize);
  for (const t of tags) {
    if (t.blob) {
      t.value = cursor;
      cursor = align2(cursor + t.blob.length);
    }
  }
  const stripOffset = cursor;
  const totalSize = stripOffset + stripByteCount;

  const out = new Uint8Array(totalSize);
  const dv = new DataView(out.buffer);

  // Header.
  out[0] = 0x49; out[1] = 0x49; // 'II' little-endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, ifdStart, true);

  // Patch StripOffsets now that we know it.
  tags[5].value = stripOffset;

  // IFD.
  dv.setUint16(ifdStart, tags.length, true);
  let p = ifdStart + 2;
  for (const t of tags) {
    dv.setUint16(p, t.tag, true);
    dv.setUint16(p + 2, t.type, true);
    dv.setUint32(p + 4, t.count, true);
    if (t.type === T_SHORT && !t.blob) {
      dv.setUint16(p + 8, t.value, true); // inline short, rest zero
    } else {
      dv.setUint32(p + 8, t.value, true); // LONG inline, or offset for blobs
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // next IFD = none

  // Overflow blobs.
  for (const t of tags) {
    if (t.blob) out.set(t.blob, t.value);
  }

  // Image strip — Float32 LE, row 0 = NORTH (grid row rows-1-r).
  let o = stripOffset;
  for (let r = 0; r < rows; r++) {
    const gridRow = rows - 1 - r;
    const base = gridRow * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const v = input.coverage[i] !== 0 && Number.isFinite(input.values[i]) ? input.values[i] : noData;
      dv.setFloat32(o, v, true);
      o += 4;
    }
  }

  return out;
}
