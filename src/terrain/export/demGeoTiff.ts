/**
 * demGeoTiff.ts
 *
 * Write a single-band GeoTIFF for a grid — the gold-standard DEM exchange
 * format. The default band is Float32 (the elevation surface); an optional
 * `band: 'uint8'` writes an unsigned-byte band instead, for a categorical grid
 * such as the per-cell support map. Classic (non-BigTIFF) little-endian TIFF
 * with one uncompressed strip, plus the GeoTIFF tags (ModelPixelScale,
 * ModelTiepoint, GeoKeyDirectory) and a GDAL_NODATA tag. CRS is carried by EPSG
 * code in the GeoKeys, so no WKT lookup is needed.
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
  /**
   * GeoTIFF vertical unit code (9001/9002/9003) for VerticalUnitsGeoKey 4099.
   * Written only when known — GeoTIFF 1.1 defines 4096 and 4099 as separate
   * keys, and omitting 4099 left a compound-CRS raster's heights ambiguous
   * between metres and feet. Never derived from the horizontal unit.
   */
  readonly verticalUnitCode?: number | null;
  /**
   * Sample band type. 'float32' (default) writes the IEEE-float surface — the
   * DEM's long-standing format, byte-for-byte unchanged. 'uint8' writes a
   * single-band unsigned-byte grid (BitsPerSample 8, SampleFormat 1) for a
   * categorical raster such as the per-cell support map; `values` are truncated
   * to bytes and `noData` should be a byte value outside the class set.
   */
  readonly band?: 'float32' | 'uint8';
}

/**
 * GeoTIFF VerticalUnitsGeoKey (4099) code for a metres-per-vertical-unit factor.
 * Matched by value (1e-9 tolerance separates the two foot definitions); an
 * unrecognised or absent factor yields null, so the writer omits the key rather
 * than asserting a wrong unit.
 *
 * Shared so every product that writes the same DTM raster derives the code the
 * same way: the contour deliverable used to stamp 4096 without 4099, leaving a
 * foot-height raster ambiguous while the DEM package's copy of it was not.
 */
export function verticalUnitGeoKeyCode(metresPerUnit: number | null | undefined): number | null {
  if (metresPerUnit == null || !Number.isFinite(metresPerUnit)) return null;
  if (Math.abs(metresPerUnit - 1) < 1e-9) return 9001;
  if (Math.abs(metresPerUnit - 0.3048) < 1e-9) return 9002;
  if (Math.abs(metresPerUnit - 1200 / 3937) < 1e-9) return 9003;
  return null;
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
  // Guard for a coordinate-bearing writer: the strip loop reads values[i] /
  // coverage[i] for every one of rows*cols cells, so an array SHORTER than the
  // grid reads `undefined` past its end → Number.isFinite(undefined) is false →
  // the cell is silently written as NODATA. A truncated input would then emit a
  // plausible-looking DEM riddled with holes instead of failing. Refuse it.
  // (Both current callers pass dtm.z-derived cols*rows arrays, so this is a
  // guard against a future caller, not a live bug.)
  const cellCount = rows * cols;
  if (input.values.length !== cellCount) {
    throw new Error(
      `writeGeoTiff: values.length (${input.values.length}) must equal rows*cols (${rows}*${cols}=${cellCount})`,
    );
  }
  if (input.coverage.length !== cellCount) {
    throw new Error(
      `writeGeoTiff: coverage.length (${input.coverage.length}) must equal rows*cols (${rows}*${cols}=${cellCount})`,
    );
  }
  const noData = input.noData ?? -9999;
  const band = input.band ?? 'float32';
  const bytesPerSample = band === 'uint8' ? 1 : 4;
  const epsg = input.epsg ?? null;
  const verticalEpsg = input.verticalEpsg ?? null;

  // ── GeoKey directory (array of uint16) ───────────────────────────────────
  // Header: [KeyDirectoryVersion=1, KeyRevision=1, MinorRevision=0, NumberOfKeys]
  const keys: number[] = [];
  // GTModelType (1024): 1=Projected, 2=Geographic, 32767=user-defined.
  let modelType: number;
  if (epsg == null) modelType = 32767;
  else if (input.isGeographic) modelType = 2;
  else modelType = 1;
  keys.push(
    1024, 0, 1, modelType,
    // GTRasterType (1025): 1 = RasterPixelIsArea.
    1025, 0, 1, 1,
  );
  if (epsg != null) {
    if (input.isGeographic) keys.push(2048, 0, 1, epsg); // GeographicTypeGeoKey
    else keys.push(3072, 0, 1, epsg); // ProjectedCSTypeGeoKey
  }
  if (verticalEpsg != null) keys.push(4096, 0, 1, verticalEpsg); // VerticalCSTypeGeoKey
  const verticalUnitCode = input.verticalUnitCode ?? null;
  if (verticalEpsg != null && verticalUnitCode != null && verticalUnitCode > 0) {
    keys.push(4099, 0, 1, verticalUnitCode); // VerticalUnitsGeoKey — see options doc
  }
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
  const stripByteCount = cols * rows * bytesPerSample;
  const tags: Tag[] = [
    { tag: 256, type: T_LONG, count: 1, value: cols }, // ImageWidth
    { tag: 257, type: T_LONG, count: 1, value: rows }, // ImageLength
    { tag: 258, type: T_SHORT, count: 1, value: band === 'uint8' ? 8 : 32 }, // BitsPerSample
    { tag: 259, type: T_SHORT, count: 1, value: 1 }, // Compression = none
    { tag: 262, type: T_SHORT, count: 1, value: 1 }, // Photometric = BlackIsZero
    { tag: 273, type: T_LONG, count: 1, value: 0 }, // StripOffsets (patched)
    { tag: 277, type: T_SHORT, count: 1, value: 1 }, // SamplesPerPixel
    { tag: 278, type: T_LONG, count: 1, value: rows }, // RowsPerStrip
    { tag: 279, type: T_LONG, count: 1, value: stripByteCount }, // StripByteCounts
    { tag: 284, type: T_SHORT, count: 1, value: 1 }, // PlanarConfiguration
    { tag: 339, type: T_SHORT, count: 1, value: band === 'uint8' ? 1 : 3 }, // SampleFormat: 1=uint, 3=IEEE float
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

  // Image strip — row 0 = NORTH (grid row rows-1-r). Float32 LE by default; a
  // uint8 band writes one truncated byte per cell.
  let o = stripOffset;
  for (let r = 0; r < rows; r++) {
    const gridRow = rows - 1 - r;
    const base = gridRow * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const v = input.coverage[i] !== 0 && Number.isFinite(input.values[i]) ? input.values[i] : noData;
      if (band === 'uint8') {
        out[o] = v & 0xff;
        o += 1;
      } else {
        dv.setFloat32(o, v, true);
        o += 4;
      }
    }
  }

  return out;
}
