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
import { assertNoDataClear, chooseNoData, NoDataCollisionError } from './demNoData';

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
  /**
   * Sentinel written for empty cells. Omitted: -9999, or for float32 bands a
   * value below every written height when one equals -9999 as a float32
   * ({@link chooseNoData}). A given value that a written sample equals is
   * refused with {@link NoDataCollisionError}, in every band.
   */
  readonly noData?: number;
  /** Horizontal CRS EPSG code, or null when unknown. */
  readonly epsg?: number | null;
  /** True for a geographic (lat/lon) CRS, false/omitted for projected. */
  readonly isGeographic?: boolean;
  /**
   * Vertical CRS (or vertical datum) EPSG code, or null. Written as
   * VerticalGeoKey (4096) only in the form whose axis unit is
   * `verticalUnitCode`; see {@link resolveVerticalGeoKeys}. A code that names a
   * different unit throws {@link GeoTiffVerticalCrsConflictError}.
   */
  readonly verticalEpsg?: number | null;
  /**
   * GeoTIFF unit code (9001/9002/9003) of the heights. Written as
   * VerticalUnitsGeoKey (4099) beside 4096; when no vertical CRS is written it
   * goes in GDAL_METADATA as the band unit instead, on bands that name none.
   * Never derived from the horizontal unit.
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

/** GeoTIFF linear unit codes a vertical axis can carry here. */
type VerticalUnitCode = 9001 | 9002 | 9003;

/** GDAL's (PROJ's) name for each vertical unit code, used as the UNITTYPE text. */
const VERTICAL_UNIT_NAME: Record<VerticalUnitCode, string> = {
  9001: 'metre',
  9002: 'foot',
  9003: 'US survey foot',
};

const isVerticalUnitCode = (u: number | null | undefined): u is VerticalUnitCode =>
  u === 9001 || u === 9002 || u === 9003;

/** One EPSG vertical CRS the writer may put in VerticalGeoKey (4096). */
export interface VerticalCrsEntry {
  /** EPSG name, as the registry gives it. */
  readonly name: string;
  /** The unit of the CRS's own axis, as a GeoTIFF unit code. */
  readonly unitCode: VerticalUnitCode;
  /** Codes in one family share a datum and an axis direction and differ only in unit. */
  readonly family: string;
  /** Axis direction: 'up' for a height, 'down' for a depth. */
  readonly direction: 'up' | 'down';
  /**
   * True when the code names its unit: "(ft)", "(ftUS)" or "(m)". Such a code
   * states the unit outright, so a different declared unit contradicts it. A
   * code without one (5703, 5714) has long been written with 4099 giving the
   * height unit, the GeoTIFF 1.0 practice of treating it as the datum, so a
   * different unit there selects the family member in that unit.
   */
  readonly unitInName: boolean;
}

/**
 * Vertical CRS codes the writer knows the unit of, checked against the EPSG
 * registry (pyproj 3.7.2 on PROJ 9.8.1; `tests/demGeoTiffGdal.test.ts` repeats
 * the check with `projinfo`). A code outside this table is never written,
 * because its axis unit cannot be compared with the heights.
 */
export const VERTICAL_CRS_UNITS: Readonly<Record<number, VerticalCrsEntry>> = {
  5703: { name: 'NAVD88 height', unitCode: 9001, family: 'navd88-height', direction: 'up', unitInName: false },
  8228: { name: 'NAVD88 height (ft)', unitCode: 9002, family: 'navd88-height', direction: 'up', unitInName: true },
  6360: { name: 'NAVD88 height (ftUS)', unitCode: 9003, family: 'navd88-height', direction: 'up', unitInName: true },
  6357: { name: 'NAVD88 depth', unitCode: 9001, family: 'navd88-depth', direction: 'down', unitInName: false },
  6358: { name: 'NAVD88 depth (ftUS)', unitCode: 9003, family: 'navd88-depth', direction: 'down', unitInName: true },
  7968: { name: 'NGVD29 height (m)', unitCode: 9001, family: 'ngvd29-height', direction: 'up', unitInName: true },
  5702: { name: 'NGVD29 height (ftUS)', unitCode: 9003, family: 'ngvd29-height', direction: 'up', unitInName: true },
  6359: { name: 'NGVD29 depth (ftUS)', unitCode: 9003, family: 'ngvd29-depth', direction: 'down', unitInName: true },
  5714: { name: 'MSL height', unitCode: 9001, family: 'msl-height', direction: 'up', unitInName: false },
  8050: { name: 'MSL height (ft)', unitCode: 9002, family: 'msl-height', direction: 'up', unitInName: true },
  8052: { name: 'MSL height (ftUS)', unitCode: 9003, family: 'msl-height', direction: 'up', unitInName: true },
  5715: { name: 'MSL depth', unitCode: 9001, family: 'msl-depth', direction: 'down', unitInName: false },
  8051: { name: 'MSL depth (ft)', unitCode: 9002, family: 'msl-depth', direction: 'down', unitInName: true },
  8053: { name: 'MSL depth (ftUS)', unitCode: 9003, family: 'msl-depth', direction: 'down', unitInName: true },
  5701: { name: 'ODN height', unitCode: 9001, family: 'odn-height', direction: 'up', unitInName: false },
  3855: { name: 'EGM2008 height', unitCode: 9001, family: 'egm2008-height', direction: 'up', unitInName: false },
  5773: { name: 'EGM96 height', unitCode: 9001, family: 'egm96-height', direction: 'up', unitInName: false },
  5798: { name: 'EGM84 height', unitCode: 9001, family: 'egm84-height', direction: 'up', unitInName: false },
  5705: { name: 'Baltic 1977 height', unitCode: 9001, family: 'baltic1977-height', direction: 'up', unitInName: false },
  5612: { name: 'Baltic 1977 depth', unitCode: 9001, family: 'baltic1977-depth', direction: 'down', unitInName: false },
  6647: { name: 'CGVD2013(CGG2013) height', unitCode: 9001, family: 'cgvd2013-height', direction: 'up', unitInName: false },
  5713: { name: 'CGVD28 height', unitCode: 9001, family: 'cgvd28-height', direction: 'up', unitInName: false },
  5711: { name: 'AHD height', unitCode: 9001, family: 'ahd-height', direction: 'up', unitInName: false },
  5709: { name: 'NAP height', unitCode: 9001, family: 'nap-height', direction: 'up', unitInName: false },
  7837: { name: 'DHHN2016 height', unitCode: 9001, family: 'dhhn2016-height', direction: 'up', unitInName: false },
  5621: { name: 'EVRF2007 height', unitCode: 9001, family: 'evrf2007-height', direction: 'up', unitInName: false },
  9389: { name: 'EVRF2019 height', unitCode: 9001, family: 'evrf2019-height', direction: 'up', unitInName: false },
  6695: { name: 'JGD2011 (vertical) height', unitCode: 9001, family: 'jgd2011-height', direction: 'up', unitInName: false },
  7839: { name: 'NZVD2016 height', unitCode: 9001, family: 'nzvd2016-height', direction: 'up', unitInName: false },
  5728: { name: 'LN02 height', unitCode: 9001, family: 'ln02-height', direction: 'up', unitInName: false },
  5729: { name: 'LHN95 height', unitCode: 9001, family: 'lhn95-height', direction: 'up', unitInName: false },
};

/**
 * EPSG vertical datum codes (GeoTIFF 1.0 wrote these in 4096) and the height
 * family each one selects. Checked with pyproj: 5103 North American Vertical
 * Datum 1988, 5102 National Geodetic Vertical Datum 1929, 5100 Mean Sea Level.
 */
const VERTICAL_DATUM_FAMILY: Readonly<Record<number, string>> = {
  5103: 'navd88-height',
  5102: 'ngvd29-height',
  5100: 'msl-height',
};

/** What the writer does with a vertical CRS code and a height unit. */
export type VerticalGeoKeyResolution =
  /** No vertical CRS was given. */
  | { readonly status: 'none' }
  /** 4096 = `epsg` and 4099 = `unitCode` are written; `epsg` may differ from the code given. */
  | { readonly status: 'written'; readonly requestedEpsg: number; readonly epsg: number; readonly unitCode: VerticalUnitCode }
  /** No vertical CRS is written; the height unit, when known, goes in UNITTYPE. */
  | {
      readonly status: 'omitted';
      readonly requestedEpsg: number;
      readonly unitCode: VerticalUnitCode | null;
      readonly reason: 'unknown-unit' | 'unverified-code' | 'no-code-in-unit' | 'depth-axis';
    }
  /** The code's own unit and the declared unit disagree; the writer refuses this. */
  | { readonly status: 'conflict'; readonly requestedEpsg: number; readonly unitCode: VerticalUnitCode; readonly codeUnitCode: VerticalUnitCode };

/**
 * Decide the VerticalGeoKey for a vertical CRS or datum code and the unit the
 * heights are in. GDAL takes the unit from the code and ignores 4099, so the
 * code written must be one whose axis is in the heights' unit:
 *
 * - a code in that unit is written as given;
 * - a code without a unit in its name (5703) or a datum code (5103) selects
 *   the family member in that unit (5703 in US survey feet is 6360);
 * - a code that names a different unit (6360 with metres) is a conflict;
 * - a code with no family member in that unit, a code outside the checked
 *   table, or an unknown unit leaves the vertical CRS off;
 * - a depth CRS (axis down) is left off: every raster written with a vertical
 *   CRS holds heights, and a depth CRS would read them with the sign reversed.
 */
export function resolveVerticalGeoKeys(
  verticalEpsg: number | null | undefined,
  verticalUnitCode: number | null | undefined,
  opts: {
    /**
     * Accept a depth CRS. A GeoTIFF elevation raster holds heights and leaves
     * one off; a LAS file passes the source's own depth CRS through.
     */
    readonly allowDepth?: boolean;
  } = {},
): VerticalGeoKeyResolution {
  if (verticalEpsg == null) return { status: 'none' };
  if (!isVerticalUnitCode(verticalUnitCode)) {
    return { status: 'omitted', requestedEpsg: verticalEpsg, unitCode: null, reason: 'unknown-unit' };
  }
  const entry = VERTICAL_CRS_UNITS[verticalEpsg] as VerticalCrsEntry | undefined;
  const family = entry?.family ?? VERTICAL_DATUM_FAMILY[verticalEpsg];
  if (family == null) {
    return { status: 'omitted', requestedEpsg: verticalEpsg, unitCode: verticalUnitCode, reason: 'unverified-code' };
  }
  if (entry?.direction === 'down' && opts.allowDepth !== true) {
    return { status: 'omitted', requestedEpsg: verticalEpsg, unitCode: verticalUnitCode, reason: 'depth-axis' };
  }
  if (entry && entry.unitCode === verticalUnitCode) {
    return { status: 'written', requestedEpsg: verticalEpsg, epsg: verticalEpsg, unitCode: verticalUnitCode };
  }
  if (entry && entry.unitInName) {
    return { status: 'conflict', requestedEpsg: verticalEpsg, unitCode: verticalUnitCode, codeUnitCode: entry.unitCode };
  }
  for (const [code, e] of Object.entries(VERTICAL_CRS_UNITS)) {
    if (e.family === family && e.unitCode === verticalUnitCode) {
      return { status: 'written', requestedEpsg: verticalEpsg, epsg: Number(code), unitCode: verticalUnitCode };
    }
  }
  return { status: 'omitted', requestedEpsg: verticalEpsg, unitCode: verticalUnitCode, reason: 'no-code-in-unit' };
}

/** GDAL's name for a GeoTIFF vertical unit code, or null for an unknown code. */
export function verticalUnitName(code: number | null | undefined): string | null {
  return isVerticalUnitCode(code) ? VERTICAL_UNIT_NAME[code] : null;
}

/**
 * Thrown by {@link writeGeoTiff} when the vertical CRS code names one unit and
 * the heights are declared in another. Writing either would give a file that
 * states a wrong unit for its heights.
 */
export class GeoTiffVerticalCrsConflictError extends Error {
  readonly verticalEpsg: number;
  readonly verticalUnitCode: number;
  readonly codeUnitCode: number;
  constructor(verticalEpsg: number, verticalUnitCode: VerticalUnitCode, codeUnitCode: VerticalUnitCode) {
    super(
      `writeGeoTiff: vertical CRS EPSG:${verticalEpsg} is defined in ${VERTICAL_UNIT_NAME[codeUnitCode]}, ` +
        `but the heights are declared in ${VERTICAL_UNIT_NAME[verticalUnitCode]}`,
    );
    this.name = 'GeoTiffVerticalCrsConflictError';
    this.verticalEpsg = verticalEpsg;
    this.verticalUnitCode = verticalUnitCode;
    this.codeUnitCode = codeUnitCode;
  }
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
  // GDAL_NODATA holds one value for every band, and a reader compares each
  // written sample with it, so no covered sample in any band may equal it.
  const covered = bands.map((b) => ({ values: b.values, coverage: input.coverage }));
  let noData: number;
  if (sampleType === 'float32') {
    const opts = { serialisations: ['float32'] as const };
    noData = input.noData ?? chooseNoData(covered, opts);
    if (input.noData != null) assertNoDataClear(covered, noData, opts);
  } else {
    noData = input.noData ?? -9999;
    const asWritten = (v: number): number => (sampleType === 'uint8' ? v & 0xff : v >>> 0);
    for (const g of covered) {
      for (let i = 0; i < g.values.length; i++) {
        const v = g.values[i];
        if (g.coverage[i] !== 0 && Number.isFinite(v) && asWritten(v) === asWritten(noData)) {
          throw new NoDataCollisionError(noData, v);
        }
      }
    }
  }
  const nBands = bands.length;
  const bitsPerSample = SAMPLE_BITS[sampleType];
  const bytesPerSample = bitsPerSample / 8;
  const epsg = input.epsg ?? null;
  const vertical = resolveVerticalGeoKeys(input.verticalEpsg, input.verticalUnitCode);
  if (vertical.status === 'conflict') {
    throw new GeoTiffVerticalCrsConflictError(vertical.requestedEpsg, vertical.unitCode, vertical.codeUnitCode);
  }
  // With no vertical CRS written, a known height unit still reaches the reader
  // as the band unit, on bands that do not name one already.
  if (vertical.status !== 'written') {
    const unit = verticalUnitName(input.verticalUnitCode);
    if (unit != null && bands.some((b) => !b.unit)) bands = bands.map((b) => (b.unit ? b : { ...b, unit }));
  }

  // ── GeoKey directory (array of uint16) ───────────────────────────────────
  // Header: [KeyDirectoryVersion=1, KeyRevision=1, MinorRevision, NumberOfKeys].
  // MinorRevision is 1 (GeoTIFF 1.1) when VerticalGeoKey is written: OGC
  // 19-008r4 requirement 2.9 asks for it, and GDAL drops the vertical part of a
  // 1.0 file on a default read. Every other file keeps 0 and its bytes.
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
  if (vertical.status === 'written') {
    keys.push(
      4096, 0, 1, vertical.epsg, // VerticalGeoKey, in the heights' unit
      4099, 0, 1, vertical.unitCode, // VerticalUnitsGeoKey, the same unit
    );
  }
  const numKeys = keys.length / 4;
  const minorRevision = vertical.status === 'written' ? 1 : 0;
  const geoDir = [1, 1, minorRevision, numKeys, ...keys]; // uint16[]

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

/**
 * {@link writeGeoTiff}, except that a vertical CRS whose own unit contradicts
 * the heights is dropped instead of thrown: the raster is written with no
 * vertical CRS and the height unit as the band unit. For callers that ship the
 * raster either way and report the conflict elsewhere, as the DEM package does
 * in its README from {@link resolveVerticalGeoKeys}.
 */
export function writeGeoTiffDroppingVerticalConflict(input: DemGeoTiffInput): Uint8Array {
  try {
    return writeGeoTiff(input);
  } catch (e) {
    if (e instanceof GeoTiffVerticalCrsConflictError) return writeGeoTiff({ ...input, verticalEpsg: null });
    throw e;
  }
}
