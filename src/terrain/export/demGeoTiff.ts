/**
 * demGeoTiff.ts
 *
 * Write a GeoTIFF for a grid — the gold-standard DEM exchange format. The
 * default is one Float32 band (the elevation surface); `band: 'uint8'` writes
 * an unsigned-byte band instead, for a categorical grid such as the per-cell
 * support map, and `bands` writes several co-registered bands in one file.
 * Classic (non-BigTIFF) little-endian TIFF with one uncompressed strip, plus
 * the GeoTIFF tags (ModelPixelScale, ModelTiepoint, GeoKeyDirectory) and a
 * GDAL_NODATA tag. CRS is carried by EPSG code in the GeoKeys, so no WKT lookup
 * is needed.
 *
 * Multi-band layout: PlanarConfiguration 1 (pixel-interleaved, the layout
 * GDAL writes by default), BitsPerSample and SampleFormat carry one value per
 * band, ExtraSamples marks bands 2..N as unspecified data, and band names and
 * units go into the GDAL_METADATA tag (42112) as DESCRIPTION / UNITTYPE items.
 * Every band shares one sample type because GDAL reads a TIFF only when all
 * samples have the same type and width. GDAL_NODATA holds one value for the
 * whole file, so the coverage mask applies to every band. A single-band call
 * writes the same bytes it always has.
 *
 * Pure-data: builds and returns the file bytes; no DOM, deterministic.
 *
 * Refs: TIFF 6.0; OGC GeoTIFF 1.1 (ModelTiepoint/ModelPixelScale, GeoKeys).
 */

import { UNIT_FACTORS } from '../../units/units';

export interface DemGeoTiffInput {
  /** Row-major cell values; length === cols*rows. Required unless `bands` is given. */
  readonly values?: ArrayLike<number>;
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
  /**
   * Several co-registered bands, in band order. When given, `values` and `band`
   * are ignored; `coverage` still selects the cells written as `noData`, in
   * every band. All bands must share one `type`.
   */
  readonly bands?: readonly GeoTiffBand[];
}

/** Sample type of one GeoTIFF band. */
export type GeoTiffSampleType = 'float32' | 'uint8' | 'uint32';

/** One band of a multi-band GeoTIFF. */
export interface GeoTiffBand {
  /** Row-major cell values; length === cols*rows. */
  readonly values: ArrayLike<number>;
  /** Sample type. Default 'float32'. */
  readonly type?: GeoTiffSampleType;
  /** Band name, written as the GDAL_METADATA DESCRIPTION item. */
  readonly description?: string;
  /** Unit label, written as the GDAL_METADATA UNITTYPE item. */
  readonly unit?: string;
}

const SAMPLE_BITS: Record<GeoTiffSampleType, number> = { float32: 32, uint8: 8, uint32: 32 };
/** TIFF SampleFormat: 1 = unsigned integer, 3 = IEEE float. */
const SAMPLE_FORMAT: Record<GeoTiffSampleType, number> = { float32: 3, uint8: 1, uint32: 1 };

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GDAL_METADATA XML for per-band descriptions and units, or null when there are none. */
export function gdalMetadataXml(bands: readonly GeoTiffBand[]): string | null {
  const items: string[] = [];
  bands.forEach((b, i) => {
    if (b.description) {
      items.push(`  <Item name="DESCRIPTION" sample="${i}" role="description">${xmlEscape(b.description)}</Item>`);
    }
    if (b.unit) {
      items.push(`  <Item name="UNITTYPE" sample="${i}" role="unittype">${xmlEscape(b.unit)}</Item>`);
    }
  });
  if (items.length === 0) return null;
  return `<GDALMetadata>\n${items.join('\n')}\n</GDALMetadata>\n`;
}

function uint16Blob(values: readonly number[]): Uint8Array {
  const blob = new Uint8Array(values.length * 2);
  const dv = new DataView(blob.buffer);
  values.forEach((v, i) => dv.setUint16(i * 2, v, true));
  return blob;
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
  if (Math.abs(metresPerUnit - UNIT_FACTORS.M_PER_FT) < 1e-9) return 9002;
  if (Math.abs(metresPerUnit - UNIT_FACTORS.M_PER_US_FT) < 1e-9) return 9003;
  return null;
}

// TIFF field types.
const T_SHORT = 3;
const T_LONG = 4;
const T_DOUBLE = 12;
const T_ASCII = 2;

/**
 * A classic-TIFF field whose whole payload fits in four bytes is stored IN the
 * IFD entry's value field; only a larger payload is stored elsewhere and
 * referenced by offset (TIFF 6.0 §2, "Value Offset").
 *
 * Writing an offset for a short payload is not a harmless choice: the reader
 * takes the four bytes at face value, so the offset itself is read as the data.
 * The live support raster is exactly this case — `noData: 255` on a uint8 band
 * makes the GDAL_NODATA payload `"255\0"`, four bytes on the nose. Emitted as
 * an offset, tifffile failed to parse the tag and reported nodata 0, and 0 is a
 * REAL class in that categorical product (unsupported/void), not its missing
 * value. Pillow read the same offset bytes as text.
 */
const INLINE_LIMIT = 4;

/**
 * Whether a tag's payload goes in the entry, decided by the LENGTH OF THE BYTES
 * ABOUT TO BE WRITTEN rather than by `type × count`.
 *
 * The two agree for every tag this writer emits — checked across both band
 * types — but only one of them bounds the write. `TYPE_BYTES[type] ?? 0` yields
 * zero for a type not in the table, which would call a 48-byte payload inline
 * and let `out.set` run it over the following IFD entries: silent corruption,
 * in a file whose whole point is being readable by someone else. Measuring the
 * blob makes the write in-bounds by construction.
 */
const isInline = (blob: Uint8Array): boolean => blob.length <= INLINE_LIMIT;

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
  let bands: readonly GeoTiffBand[];
  if (input.bands) bands = input.bands;
  else if (input.values) bands = [{ values: input.values, type: input.band ?? 'float32' }];
  else throw new Error('writeGeoTiff: values or bands is required');
  if (bands.length === 0) throw new Error('writeGeoTiff: bands must not be empty');
  const sampleType = bands[0].type ?? 'float32';
  for (const b of bands) {
    if ((b.type ?? 'float32') !== sampleType) {
      throw new Error('writeGeoTiff: every band must share one sample type');
    }
    if (b.values.length !== cellCount) {
      throw new Error(
        `writeGeoTiff: values.length (${b.values.length}) must equal rows*cols (${rows}*${cols}=${cellCount})`,
      );
    }
  }
  if (input.coverage.length !== cellCount) {
    throw new Error(
      `writeGeoTiff: coverage.length (${input.coverage.length}) must equal rows*cols (${rows}*${cols}=${cellCount})`,
    );
  }
  const noData = input.noData ?? -9999;
  const nBands = bands.length;
  const bitsPerSample = SAMPLE_BITS[sampleType];
  const bytesPerSample = bitsPerSample / 8;
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
  const metadataXml = gdalMetadataXml(bands);

  // ── tag table (must be ascending by tag id) ──────────────────────────────
  const stripByteCount = cols * rows * bytesPerSample * nBands;
  // Per-sample SHORT tags: an inline value for one band (the long-standing
  // single-band bytes), one value per band otherwise.
  const perSample = (tag: number, v: number): Tag =>
    nBands === 1
      ? { tag, type: T_SHORT, count: 1, value: v }
      : { tag, type: T_SHORT, count: nBands, value: 0, blob: uint16Blob(new Array<number>(nBands).fill(v)) };
  const tags: Tag[] = [
    { tag: 256, type: T_LONG, count: 1, value: cols }, // ImageWidth
    { tag: 257, type: T_LONG, count: 1, value: rows }, // ImageLength
    perSample(258, bitsPerSample), // BitsPerSample
    { tag: 259, type: T_SHORT, count: 1, value: 1 }, // Compression = none
    { tag: 262, type: T_SHORT, count: 1, value: 1 }, // Photometric = BlackIsZero
    { tag: 273, type: T_LONG, count: 1, value: 0 }, // StripOffsets (patched)
    { tag: 277, type: T_SHORT, count: 1, value: nBands }, // SamplesPerPixel
    { tag: 278, type: T_LONG, count: 1, value: rows }, // RowsPerStrip
    { tag: 279, type: T_LONG, count: 1, value: stripByteCount }, // StripByteCounts
    { tag: 284, type: T_SHORT, count: 1, value: 1 }, // PlanarConfiguration = 1 (pixel-interleaved)
  ];
  if (nBands > 1) {
    // ExtraSamples: bands 2..N are unspecified data (0), not alpha.
    const extra = new Array<number>(nBands - 1).fill(0);
    tags.push(
      extra.length === 1
        ? { tag: 338, type: T_SHORT, count: 1, value: 0 }
        : { tag: 338, type: T_SHORT, count: extra.length, value: 0, blob: uint16Blob(extra) },
    );
  }
  tags.push(
    perSample(339, SAMPLE_FORMAT[sampleType]), // SampleFormat: 1=uint, 3=IEEE float
    { tag: 33550, type: T_DOUBLE, count: 3, value: 0, blob: pixelScale }, // ModelPixelScale
    { tag: 33922, type: T_DOUBLE, count: 6, value: 0, blob: tiepoint }, // ModelTiepoint
    { tag: 34735, type: T_SHORT, count: geoDir.length, value: 0, blob: geoDirBlob }, // GeoKeyDirectory
  );
  if (metadataXml != null) {
    const xml = new TextEncoder().encode(`${metadataXml}\0`);
    tags.push({ tag: 42112, type: T_ASCII, count: xml.length, value: 0, blob: xml }); // GDAL_METADATA
  }
  tags.push({ tag: 42113, type: T_ASCII, count: noDataAscii.length, value: 0, blob: noDataAscii }); // GDAL_NODATA

  // ── layout ───────────────────────────────────────────────────────────────
  const ifdStart = 8;
  const ifdSize = 2 + tags.length * 12 + 4;
  let cursor = align2(ifdStart + ifdSize);
  for (const t of tags) {
    // An inline blob occupies no space out here; its bytes go into the entry.
    if (t.blob && !isInline(t.blob)) {
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
  tags[5].value = stripOffset; // 273 is always the sixth tag

  // IFD.
  dv.setUint16(ifdStart, tags.length, true);
  let p = ifdStart + 2;
  for (const t of tags) {
    dv.setUint16(p, t.tag, true);
    dv.setUint16(p + 2, t.type, true);
    dv.setUint32(p + 4, t.count, true);
    if (t.blob) {
      if (isInline(t.blob)) {
        // The blob is already in file byte order, so its bytes go straight in,
        // left-aligned, with the remainder of the four left zero.
        out.set(t.blob, p + 8);
      } else {
        dv.setUint32(p + 8, t.value, true); // offset to the payload
      }
    } else if (t.type === T_SHORT) {
      dv.setUint16(p + 8, t.value, true); // inline short, rest zero
    } else {
      dv.setUint32(p + 8, t.value, true); // inline LONG
    }
    p += 12;
  }
  dv.setUint32(p, 0, true); // next IFD = none

  // Overflow blobs — the inline ones are already in their IFD entries.
  for (const t of tags) {
    if (t.blob && !isInline(t.blob)) out.set(t.blob, t.value);
  }

  // Image strip — row 0 = NORTH (grid row rows-1-r), bands interleaved per
  // pixel. Float32 LE by default; a uint8 band writes one truncated byte per
  // cell, a uint32 band four.
  let o = stripOffset;
  for (let r = 0; r < rows; r++) {
    const gridRow = rows - 1 - r;
    const base = gridRow * cols;
    for (let c = 0; c < cols; c++) {
      const i = base + c;
      const covered = input.coverage[i] !== 0;
      for (let b = 0; b < nBands; b++) {
        const x = bands[b].values[i];
        const v = covered && Number.isFinite(x) ? x : noData;
        if (sampleType === 'uint8') {
          out[o] = v & 0xff;
          o += 1;
        } else if (sampleType === 'uint32') {
          dv.setUint32(o, v >>> 0, true);
          o += 4;
        } else {
          dv.setFloat32(o, v, true);
          o += 4;
        }
      }
    }
  }

  return out;
}
