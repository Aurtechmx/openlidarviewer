/**
 * roundtripFidelity.ts — shared machinery for the LAS round-trip fidelity suite.
 *
 * Two readers sit on either side of the question "does the data survive?":
 *
 *  - `readLasBySpec` decodes a LAS file using only the ASPRS byte offsets, in
 *    float64. It shares no code with `src/io`, so agreement between it and the
 *    application reader is evidence rather than a tautology.
 *  - `loadLas` (the application reader) is exercised directly by the suite.
 *
 * Tolerances live here, derived from the declared scale factor, and are
 * imported by the test before any measurement is taken.
 */

import type { GlobalPoints } from '../../src/convert/globalPoints';

/** Float32 unit round-off: an ulp/2 bound is |v|·2^-24; 2^-23 is the safe side. */
export const F32_REL = 2 ** -23;

/**
 * Slack for the float64 arithmetic in `int·scale + offset` and in the writer's
 * `(v - offset)/scale`. With 7-digit eastings the double round-off is ~1e-9 m;
 * 1e-6 m is three orders above that and three below the tightest tolerance the
 * suite asserts (0.5 mm), so it can absorb the arithmetic without absorbing a
 * quantisation defect.
 */
export const DOUBLE_SLACK_M = 1e-6;

/**
 * Spec-level round-trip bound for one axis: half the declared scale, plus
 * double-arithmetic slack. `Math.round` is the writer's quantiser, so a value
 * landing exactly on a half-step boundary displaces by exactly scale/2 — the
 * bound is inclusive.
 */
export function quantBound(scale: number): number {
  return scale / 2 + DOUBLE_SLACK_M;
}

/**
 * Application-level bound for one axis. The application reader returns
 * positions as Float32 residuals about a floored-min origin, so the error is
 * the quantisation bound plus the float32 round-off of a residual whose
 * magnitude is at most the cloud's extent on that axis.
 */
export function appBound(scale: number, extent: number): number {
  return quantBound(scale) + F32_REL * Math.max(1, Math.abs(extent));
}

// ── spec-level LAS decoder (ASPRS byte offsets only) ────────────────────────

export interface SpecVlr {
  readonly userId: string;
  readonly recordId: number;
  readonly bytes: Uint8Array;
}

export interface SpecLas {
  readonly versionMajor: number;
  readonly versionMinor: number;
  readonly globalEncoding: number;
  readonly systemIdentifier: string;
  readonly generatingSoftware: string;
  readonly generatingSoftwareRaw: Uint8Array;
  readonly headerSize: number;
  readonly offsetToPointData: number;
  readonly vlrCount: number;
  readonly pointFormat: number;
  readonly recordLength: number;
  readonly legacyPointCount: number;
  readonly legacyByReturn: number[];
  readonly extendedPointCount: number | null;
  readonly extendedByReturn: number[] | null;
  /** Point count the file's own version rules say a reader must use. */
  readonly pointCount: number;
  readonly scale: [number, number, number];
  readonly offset: [number, number, number];
  readonly min: [number, number, number];
  readonly max: [number, number, number];
  readonly vlrs: SpecVlr[];
  /** Records the file can actually hold, from its byte length. */
  readonly recordsAvailable: number;
  readonly points: SpecPoints;
}

export interface SpecPoints {
  readonly count: number;
  readonly xi: Int32Array;
  readonly yi: Int32Array;
  readonly zi: Int32Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly intensity: Uint16Array;
  readonly returnNumber: Uint8Array;
  readonly returnCount: Uint8Array;
  readonly classification: Uint8Array;
  readonly classFlags: Uint8Array;
  readonly scanAngle: Float64Array;
  readonly userData: Uint8Array;
  readonly pointSourceId: Uint16Array;
  readonly gpsTime: Float64Array | null;
  readonly rgb16: Uint16Array | null;
}

function ascii(view: DataView, at: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) {
    const c = view.getUint8(at + i);
    if (c === 0) break;
    s += String.fromCharCode(c);
  }
  return s;
}

/** Spec byte offsets of the RGB triple, by point data record format. */
const SPEC_RGB_OFFSET: Readonly<Record<number, number>> = {
  2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30,
};
/** Spec byte offsets of the GPS time field, by point data record format. */
const SPEC_GPS_OFFSET: Readonly<Record<number, number>> = {
  1: 20, 3: 20, 4: 20, 5: 20, 6: 22, 7: 22, 8: 22, 9: 22, 10: 22,
};

/**
 * Decode a LAS file from its bytes using the ASPRS 1.2/1.4 public-header and
 * point-record layouts. Coordinates are reconstructed in float64.
 */
export function readLasBySpec(bytes: Uint8Array): SpecLas {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const signature = ascii(view, 0, 4);
  if (signature !== 'LASF') throw new Error(`not a LAS file: signature "${signature}"`);

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const offsetToPointData = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const pointFormat = view.getUint8(104) & 0x3f;
  const recordLength = view.getUint16(105, true);
  const legacyPointCount = view.getUint32(107, true);
  const legacyByReturn: number[] = [];
  for (let r = 0; r < 5; r++) legacyByReturn.push(view.getUint32(111 + r * 4, true));

  const scale: [number, number, number] = [
    view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true),
  ];
  const offset: [number, number, number] = [
    view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true),
  ];
  const max: [number, number, number] = [
    view.getFloat64(179, true), view.getFloat64(195, true), view.getFloat64(211, true),
  ];
  const min: [number, number, number] = [
    view.getFloat64(187, true), view.getFloat64(203, true), view.getFloat64(219, true),
  ];

  let extendedPointCount: number | null = null;
  let extendedByReturn: number[] | null = null;
  if (versionMinor >= 4 && bytes.byteLength >= 375) {
    extendedPointCount = Number(view.getBigUint64(247, true));
    extendedByReturn = [];
    for (let r = 0; r < 15; r++) extendedByReturn.push(Number(view.getBigUint64(255 + r * 8, true)));
  }
  const pointCount = versionMinor >= 4 ? (extendedPointCount ?? 0) : legacyPointCount;

  // VLRs, walked from the declared header size.
  const vlrs: SpecVlr[] = [];
  let p = headerSize;
  for (let i = 0; i < vlrCount && p + 54 <= offsetToPointData; i++) {
    const userId = ascii(view, p + 2, 16);
    const recordId = view.getUint16(p + 18, true);
    const len = view.getUint16(p + 20, true);
    vlrs.push({ userId, recordId, bytes: bytes.subarray(p + 54, p + 54 + len) });
    p += 54 + len;
  }

  const recordsAvailable =
    recordLength > 0 ? Math.floor((bytes.byteLength - offsetToPointData) / recordLength) : 0;

  const extended = pointFormat >= 6;
  const n = Math.min(pointCount, Math.max(0, recordsAvailable));
  const gpsOff = SPEC_GPS_OFFSET[pointFormat];
  const rgbOff = SPEC_RGB_OFFSET[pointFormat];

  const pts: SpecPoints = {
    count: n,
    xi: new Int32Array(n), yi: new Int32Array(n), zi: new Int32Array(n),
    x: new Float64Array(n), y: new Float64Array(n), z: new Float64Array(n),
    intensity: new Uint16Array(n),
    returnNumber: new Uint8Array(n),
    returnCount: new Uint8Array(n),
    classification: new Uint8Array(n),
    classFlags: new Uint8Array(n),
    scanAngle: new Float64Array(n),
    userData: new Uint8Array(n),
    pointSourceId: new Uint16Array(n),
    gpsTime: gpsOff !== undefined ? new Float64Array(n) : null,
    rgb16: rgbOff !== undefined ? new Uint16Array(n * 3) : null,
  };

  for (let i = 0; i < n; i++) {
    const b = offsetToPointData + i * recordLength;
    const xi = view.getInt32(b, true);
    const yi = view.getInt32(b + 4, true);
    const zi = view.getInt32(b + 8, true);
    pts.xi[i] = xi; pts.yi[i] = yi; pts.zi[i] = zi;
    pts.x[i] = xi * scale[0] + offset[0];
    pts.y[i] = yi * scale[1] + offset[1];
    pts.z[i] = zi * scale[2] + offset[2];
    pts.intensity[i] = view.getUint16(b + 12, true);
    const rb = view.getUint8(b + 14);
    if (extended) {
      pts.returnNumber[i] = rb & 0x0f;
      pts.returnCount[i] = (rb >> 4) & 0x0f;
      pts.classFlags[i] = view.getUint8(b + 15);
      pts.classification[i] = view.getUint8(b + 16);
      pts.userData[i] = view.getUint8(b + 17);
      // Extended scan angle: int16 in 0.006° units.
      pts.scanAngle[i] = view.getInt16(b + 18, true) * 0.006;
      pts.pointSourceId[i] = view.getUint16(b + 20, true);
    } else {
      pts.returnNumber[i] = rb & 0x07;
      pts.returnCount[i] = (rb >> 3) & 0x07;
      const cb = view.getUint8(b + 15);
      pts.classification[i] = cb & 0x1f;
      pts.classFlags[i] = cb & 0xe0;
      // Legacy scan angle rank: signed byte, whole degrees.
      pts.scanAngle[i] = view.getInt8(b + 16);
      pts.userData[i] = view.getUint8(b + 17);
      pts.pointSourceId[i] = view.getUint16(b + 18, true);
    }
    if (gpsOff !== undefined && pts.gpsTime) pts.gpsTime[i] = view.getFloat64(b + gpsOff, true);
    if (rgbOff !== undefined && pts.rgb16) {
      pts.rgb16[i * 3] = view.getUint16(b + rgbOff, true);
      pts.rgb16[i * 3 + 1] = view.getUint16(b + rgbOff + 2, true);
      pts.rgb16[i * 3 + 2] = view.getUint16(b + rgbOff + 4, true);
    }
  }

  return {
    versionMajor, versionMinor,
    globalEncoding: view.getUint16(6, true),
    systemIdentifier: ascii(view, 26, 32),
    generatingSoftware: ascii(view, 58, 32),
    generatingSoftwareRaw: bytes.subarray(58, 90),
    headerSize, offsetToPointData, vlrCount, pointFormat, recordLength,
    legacyPointCount, legacyByReturn, extendedPointCount, extendedByReturn,
    pointCount, scale, offset, min, max, vlrs, recordsAvailable,
    points: pts,
  };
}

// ── fixture builders ────────────────────────────────────────────────────────

export interface CloudSpec {
  readonly x: number[];
  readonly y: number[];
  readonly z: number[];
  readonly colors?: number[];
  readonly intensity?: number[];
  readonly classification?: number[];
  readonly returnNumber?: number[];
  readonly returnCount?: number[];
  readonly pointSourceId?: number[];
  readonly gpsTime?: number[];
}

/** Build `GlobalPoints` directly, bypassing PointCloud's Float32 storage. */
export function makeGlobal(spec: CloudSpec): GlobalPoints {
  return {
    count: spec.x.length,
    x: Float64Array.from(spec.x),
    y: Float64Array.from(spec.y),
    z: Float64Array.from(spec.z),
    colors: spec.colors ? Uint8Array.from(spec.colors) : undefined,
    intensity: spec.intensity ? Uint16Array.from(spec.intensity) : undefined,
    classification: spec.classification ? Uint8Array.from(spec.classification) : undefined,
    returnNumber: spec.returnNumber ? Uint8Array.from(spec.returnNumber) : undefined,
    returnCount: spec.returnCount ? Uint8Array.from(spec.returnCount) : undefined,
    pointSourceId: spec.pointSourceId ? Uint16Array.from(spec.pointSourceId) : undefined,
    gpsTime: spec.gpsTime ? Float64Array.from(spec.gpsTime) : undefined,
  };
}

/** Max and mean absolute difference between two equal-length sequences. */
export function displacement(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > max) max = d;
    sum += d;
  }
  return { max, mean: a.length > 0 ? sum / a.length : 0 };
}
