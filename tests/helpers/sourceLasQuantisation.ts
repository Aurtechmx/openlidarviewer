/**
 * sourceLasQuantisation.ts: a LAS source written by hand with a chosen scale
 * and offset, and a reader for the integer records of any LAS the writers
 * produce. The source is not built with our writer, so a test comparing the
 * two does not compare the writer with itself.
 */

export type Triple = [number, number, number];

export interface SourceLasSpec {
  readonly version: '1.2' | '1.4';
  readonly scale: Triple;
  readonly offset: Triple;
  /** Integer X, Y, Z records, in file order. */
  readonly records: ReadonlyArray<readonly [number, number, number]>;
}

const HEADER_12 = 227;
const HEADER_14 = 375;

/** A LAS 1.2 (point format 0) or LAS 1.4 (point format 6) file holding exactly `records`. */
export function buildSourceLas(spec: SourceLasSpec): ArrayBuffer {
  const is14 = spec.version === '1.4';
  const headerSize = is14 ? HEADER_14 : HEADER_12;
  const recLen = is14 ? 30 : 20;
  const n = spec.records.length;
  const buf = new ArrayBuffer(headerSize + n * recLen);
  const v = new DataView(buf);
  'LASF'.split('').forEach((c, i) => v.setUint8(i, c.charCodeAt(0)));
  v.setUint8(24, 1);
  v.setUint8(25, is14 ? 4 : 2);
  v.setUint16(94, headerSize, true);
  v.setUint32(96, headerSize, true);
  v.setUint8(104, is14 ? 6 : 0);
  v.setUint16(105, recLen, true);
  if (is14) v.setBigUint64(247, BigInt(n), true);
  else v.setUint32(107, n, true);
  for (let a = 0; a < 3; a++) {
    v.setFloat64(131 + a * 8, spec.scale[a], true);
    v.setFloat64(155 + a * 8, spec.offset[a], true);
  }
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const p = headerSize + i * recLen;
    for (let a = 0; a < 3; a++) {
      const q = spec.records[i][a];
      v.setInt32(p + a * 4, q, true);
      const w = q * spec.scale[a] + spec.offset[a];
      lo[a] = Math.min(lo[a], w);
      hi[a] = Math.max(hi[a], w);
    }
    v.setUint16(p + 12, 100 + (i % 50), true);
    // Format 0 carries the class at byte 15; format 6 at byte 16.
    v.setUint8(p + (is14 ? 16 : 15), 2);
    if (is14) v.setUint8(p + 14, 0x11); // return 1 of 1
    else v.setUint8(p + 14, 0x09);
  }
  for (let a = 0; a < 3; a++) {
    v.setFloat64(179 + a * 16, hi[a], true);
    v.setFloat64(187 + a * 16, lo[a], true);
  }
  return buf;
}

export interface ParsedLas {
  readonly scale: Triple;
  readonly offset: Triple;
  readonly min: Triple;
  readonly max: Triple;
  readonly count: number;
  readonly records: Int32Array;
  readonly vlrText: string;
}

/** Read the quantisation, bounds, X/Y/Z integers and Text Area text of a LAS. */
export function parseLasRecords(bytes: Uint8Array): ParsedLas {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const minor = v.getUint8(25);
  const count = minor >= 4 ? Number(v.getBigUint64(247, true)) : v.getUint32(107, true);
  const dataOffset = v.getUint32(96, true);
  const recLen = v.getUint16(105, true);
  const t = (base: number, stride: number): Triple => [0, 1, 2].map((a) => v.getFloat64(base + a * stride, true)) as Triple;
  const records = new Int32Array(count * 3);
  for (let i = 0; i < count; i++) {
    for (let a = 0; a < 3; a++) records[i * 3 + a] = v.getInt32(dataOffset + i * recLen + a * 4, true);
  }
  let text = '';
  let p = v.getUint16(94, true);
  for (let k = 0; k < v.getUint32(100, true); k++) {
    const id = v.getUint16(p + 18, true);
    const len = v.getUint16(p + 20, true);
    if (id === 3) {
      for (let i = 0; i < len - 1; i++) text += String.fromCharCode(bytes[p + 54 + i]);
    }
    p += 54 + len;
  }
  return {
    scale: t(131, 8),
    offset: t(155, 8),
    max: [v.getFloat64(179, true), v.getFloat64(195, true), v.getFloat64(211, true)],
    min: [v.getFloat64(187, true), v.getFloat64(203, true), v.getFloat64(219, true)],
    count,
    records,
    vlrText: text,
  };
}

/** Deterministic records spread over `extent` units per axis, with both extremes present. */
export function spreadRecords(
  n: number,
  extent: number,
  scale: Triple,
  originInt: Triple = [0, 0, 0],
): Array<[number, number, number]> {
  let s = 0x2545f491;
  const rnd = (): number => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
  const out: Array<[number, number, number]> = [];
  for (let i = 0; i < n; i++) {
    const u: Triple = i === 0 ? [0, 0, 0] : i === 1 ? [1, 1, 1] : [rnd(), rnd(), rnd()];
    out.push([0, 1, 2].map((a) => originInt[a] + Math.round((u[a] * extent) / scale[a])) as [number, number, number]);
  }
  return out;
}
