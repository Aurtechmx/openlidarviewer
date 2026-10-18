/**
 * lasVerticalIdentity.ts — the vertical CRS and vertical unit a converted LAS
 * declares, and the check that the written bytes say it.
 *
 * No conversion mode moves Z, so the output must declare the vertical unit the
 * source heights are in: the source's declared vertical unit (token or proven
 * factor), never the horizontal unit put in its place. A vertical unit that
 * cannot be read, or a valid one LAS cannot name (a centimetre, a yard),
 * refuses the write: writing no vertical unit would let a reader take the
 * heights in the horizontal unit. A vertical CRS code whose unit contradicts
 * the declared unit, or a token that contradicts its factor, refuses the write
 * too, because either label would misstate every height.
 *
 * After writing, the bytes are re-read through the same parser the app opens
 * files with, and the write is refused unless the vertical scale a reader
 * applies and the Z range match the source. That parser merges the WKT with
 * the vertical GeoKeys beside it, which readers such as PDAL do not do, so a
 * LAS 1.4 file is checked a second time from its WKT record alone.
 */

import type { CrsInfo, CrsLinearUnit } from '../io/crs';
import { crsFromWkt, metresPerLinearUnit } from '../io/crs';
import { parseLasHeader } from '../io/lasHeader';
import { resolveVerticalGeoKeys, verticalUnitName } from '../terrain/export/demGeoTiff';

/** GeoTIFF unit code for a named linear unit; null for 'unknown'. */
const UNIT_CODE: Record<CrsLinearUnit, number | null> = {
  metre: 9001,
  foot: 9002,
  'us-survey-foot': 9003,
  unknown: null,
};

/** The named unit a factor is exactly, or undefined for any other factor. */
function namedLinearUnitOf(factor: number): Exclude<CrsLinearUnit, 'unknown'> | undefined {
  for (const u of ['metre', 'foot', 'us-survey-foot'] as const) {
    if (Math.abs(metresPerLinearUnit(u) - factor) < 1e-12) return u;
  }
  return undefined;
}

/** The GDAL name of a vertical unit code, for messages. */
function unitName(code: number | null): string {
  return verticalUnitName(code) ?? 'an unknown unit';
}

/** The unit facts of the source frame the plan reads (a spatial context supplies them). */
export interface SourceUnitFacts {
  readonly linearUnit: CrsLinearUnit;
  readonly linearUnitToMetres: number;
  readonly linearUnitKnown: boolean;
  readonly verticalEpsg?: number;
  readonly verticalUnitToMetres?: number;
  readonly verticalLinearUnit?: CrsLinearUnit;
  readonly verticalScaleKnown: boolean;
}

/** The vertical keys a LAS conversion writes, or the reason it must not. */
export type LasVerticalPlan =
  | {
      readonly ok: true;
      /** VerticalCSType to request; the writer may substitute the same-datum code in the unit. */
      readonly verticalEpsg: number | null;
      /** VerticalUnits code; null writes no vertical unit claim. */
      readonly unitCode: number | null;
      /** Metres per Z unit a reader of the output must apply, when the source establishes one. */
      readonly expectedToMetres: number | undefined;
      /** True when the source's vertical unit could not be read. */
      readonly unknown: boolean;
      /** A warning for the conversion log, or null. */
      readonly warning: string | null;
    }
  | { readonly ok: false; readonly message: string };

/**
 * Decide the vertical keys for a LAS written from a source described by `src`.
 * `mode` matters only for an undeclared vertical unit: Keep leaves it
 * undeclared (the output reads exactly as the source did), while Assign and
 * Reproject state the unit the source heights were read in, because the
 * output's horizontal unit may differ from the source's.
 */
export function planLasVertical(
  src: SourceUnitFacts,
  hasSourceCrs: boolean,
  mode: 'keep' | 'assign' | 'reproject',
): LasVerticalPlan {
  if (!hasSourceCrs) {
    return { ok: true, verticalEpsg: null, unitCode: null, expectedToMetres: undefined, unknown: false, warning: null };
  }
  const factor = src.verticalUnitToMetres;
  const token = src.verticalLinearUnit;
  const vEpsg = src.verticalEpsg ?? null;

  if (factor === undefined && token === undefined) {
    // No vertical unit declared: heights are read in the horizontal unit.
    const implied = src.linearUnitKnown ? src.linearUnitToMetres : undefined;
    const unitCode = mode === 'keep' || implied === undefined ? null : UNIT_CODE[src.linearUnit];
    return { ok: true, verticalEpsg: vEpsg, unitCode, expectedToMetres: implied, unknown: false, warning: null };
  }

  // A declared vertical unit that cannot be read has no unit to write, and
  // writing none would let every reader take the heights in the horizontal
  // unit (metres, on a metre grid): the invalid scale would leave as a valid one.
  if ((factor !== undefined && !src.verticalScaleKnown) || (factor === undefined && token === 'unknown')) {
    return {
      ok: false,
      message:
        'Vertical unit not readable: the source declares a vertical unit that is not a readable length, so the heights have no unit to declare. ' +
        'Nothing was written, because a file without one would be read in the horizontal unit. Correct the source vertical unit and export again.',
    };
  }
  // A valid factor that is not metre, foot or US survey foot (a centimetre, a
  // yard) has no LAS vertical unit code, and no named unit may stand in for it.
  const named = token !== undefined && token !== 'unknown' ? token : factor !== undefined ? namedLinearUnitOf(factor) : undefined;
  if (named === undefined) {
    return {
      ok: false,
      message:
        `Vertical unit not representable: the source heights are in a unit of ${factor} m, which a LAS vertical unit (metre, foot or US survey foot) cannot state. ` +
        'Nothing was written, because any of those units would misstate every height. Export to a format that keeps source units, or convert the heights first.',
    };
  }
  const tokenFactor = metresPerLinearUnit(named);
  if (factor !== undefined && Math.abs(factor - tokenFactor) > 1e-12) {
    return {
      ok: false,
      message:
        `Vertical unit conflict: the source CRS names the vertical unit ${token} but gives ${factor} m per unit. ` +
        'Nothing was written, because either value would misstate every height. Correct the vertical unit and export again.',
    };
  }
  const unitCode = UNIT_CODE[named];
  const expected = factor ?? tokenFactor;
  let warning: string | null = null;
  if (vEpsg != null) {
    const res = resolveVerticalGeoKeys(vEpsg, unitCode, { allowDepth: true });
    if (res.status === 'conflict') {
      return {
        ok: false,
        message:
          `Vertical CRS conflict: EPSG:${vEpsg} is defined in ${unitName(res.codeUnitCode)}, but the heights are declared in ${unitName(unitCode)}. ` +
          'Nothing was written, because either label would misstate every height. Correct the vertical CRS or the vertical unit and export again.',
      };
    }
    if (res.status === 'omitted' && res.reason === 'no-code-in-unit') {
      warning = `EPSG:${vEpsg} has no variant in ${unitName(unitCode)}, so the vertical unit is written without a vertical CRS.`;
    }
  }
  return { ok: true, verticalEpsg: vEpsg, unitCode, expectedToMetres: expected, unknown: false, warning };
}

/**
 * Re-read the written LAS and return why it must not be delivered, or null.
 * Checks that the Z range is the source's and that the vertical scale a reader
 * applies to it is the one the plan established.
 */
export function verifyLasVertical(
  bytes: Uint8Array,
  plan: Extract<LasVerticalPlan, { ok: true }>,
  zMin: number,
  zMax: number,
  /** Metres per Z unit a reader applies to a CRS (declared, else the horizontal unit when known). */
  zToMetres: (crs: CrsInfo) => number | undefined,
): string | null {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const h = parseLasHeader(buffer);
  const tolerance = h.scale[2];
  if (Math.abs(h.min[2] - zMin) > tolerance || Math.abs(h.max[2] - zMax) > tolerance) {
    return `Vertical check failed: the written Z range ${h.min[2]}..${h.max[2]} differs from the source ${zMin}..${zMax}. Nothing was written.`;
  }
  if (h.crs == null) return null;
  if (plan.unknown) {
    return h.crs.verticalUnitToMetres !== undefined
      ? 'Vertical check failed: the written CRS declares a vertical unit the source does not establish. Nothing was written.'
      : null;
  }
  if (plan.expectedToMetres === undefined) return null;
  const got = zToMetres(h.crs);
  if (got === undefined || Math.abs(got - plan.expectedToMetres) > 1e-12) {
    return (
      `Vertical check failed: the written file states ${got === undefined ? 'no usable vertical unit' : `${got} m per height unit`}, ` +
      `but the source heights are ${plan.expectedToMetres} m per unit. Nothing was written, because the elevations would be misread.`
    );
  }
  return null;
}

/** The OGC WKT record (LASF_Projection 2112) of a LAS 1.4 file, from its VLRs or EVLRs, or null. */
function wktRecord(bytes: Uint8Array): string | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, len: number): string => {
    let out = '';
    for (let i = 0; i < len; i++) {
      const c = bytes[at + i];
      if (c === 0) break;
      out += String.fromCharCode(c);
    }
    return out;
  };
  let p = v.getUint16(94, true);
  for (let i = 0; i < v.getUint32(100, true) && p + 54 <= bytes.byteLength; i++) {
    const len = v.getUint16(p + 20, true);
    if (ascii(p + 2, 16) === 'LASF_Projection' && v.getUint16(p + 18, true) === 2112) return ascii(p + 54, len);
    p += 54 + len;
  }
  let e = Number(v.getBigUint64(235, true));
  for (let i = 0; i < v.getUint32(243, true) && e > 0 && e + 60 <= bytes.byteLength; i++) {
    const len = Number(v.getBigUint64(e + 20, true));
    if (ascii(e + 2, 16) === 'LASF_Projection' && v.getUint16(e + 18, true) === 2112) return ascii(e + 60, len);
    e += 60 + len;
  }
  return null;
}

/**
 * Check a LAS 1.4 file's heights as a reader that takes the CRS from the WKT
 * record alone would read them (PDAL and GDAL ignore the GeoKeys once global
 * encoding bit 4 is set). Returns why the file must not be delivered, or null.
 */
export function verifyLasWktVertical(
  bytes: Uint8Array,
  plan: Extract<LasVerticalPlan, { ok: true }>,
  zToMetres: (crs: CrsInfo) => number | undefined,
): string | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (v.getUint8(25) < 4 || (v.getUint16(6, true) & 0x10) === 0) return null;
  const wkt = wktRecord(bytes);
  if (wkt == null) return 'Vertical check failed: the header declares a WKT coordinate system but the file holds none. Nothing was written.';
  const crs = crsFromWkt(wkt);
  if (plan.unknown) {
    return crs.verticalUnitToMetres !== undefined
      ? 'Vertical check failed: the written WKT declares a vertical unit the source does not establish. Nothing was written.'
      : null;
  }
  if (plan.expectedToMetres === undefined) return null;
  // Under a geographic CRS with no vertical CRS, a WKT reader takes heights as metres.
  const got = zToMetres(crs) ?? (crs.isGeographic && crs.verticalEpsg == null ? 1 : undefined);
  if (got === undefined || Math.abs(got - plan.expectedToMetres) > 1e-12) {
    return (
      `Vertical check failed: read from its WKT alone, the written file states ${got === undefined ? 'no usable vertical unit' : `${got} m per height unit`}, ` +
      `but the source heights are ${plan.expectedToMetres} m per unit. Nothing was written, because the elevations would be misread.`
    );
  }
  return null;
}
