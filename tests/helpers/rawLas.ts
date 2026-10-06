/**
 * rawLas.ts: a hand-built LAS writer and an independent byte reader for tests.
 *
 * Neither half uses the application's reader or writer, so a test that builds
 * a source with `buildLas`, converts it, and parses the result with `readLas`
 * checks the written bytes against the layout in the ASPRS LAS 1.2 and 1.4 R15
 * specifications rather than against the app's own decoder. Offsets below are
 * the specification's: LAS 1.2 header 227 bytes, LAS 1.4 header 375 bytes,
 * point formats 0 (20 bytes), 3 (34 bytes) and 6 (30 bytes).
 */

export interface RawPoint {
  readonly cls: number;
  /** Extended classification flags (bit 0 synthetic, 1 key-point, 2 withheld, 3 overlap). */
  readonly flags?: number;
  /** Scan angle in degrees. */
  readonly angle?: number;
  readonly channel?: number;
}

export interface BuildOptions {
  readonly version: '1.2' | '1.4';
  /** 0 or 3 for LAS 1.2; 6 for LAS 1.4. */
  readonly pdrf: 0 | 3 | 6;
  readonly points: readonly RawPoint[];
}

const RECORD_LENGTH = { 0: 20, 3: 34, 6: 30 } as const;

export function buildLas(opts: BuildOptions): Uint8Array {
  const v14 = opts.version === '1.4';
  const headerSize = v14 ? 375 : 227;
  const recLen = RECORD_LENGTH[opts.pdrf];
  const n = opts.points.length;
  const out = new Uint8Array(headerSize + n * recLen);
  const dv = new DataView(out.buffer);
  out.set([0x4c, 0x41, 0x53, 0x46], 0);
  out[24] = 1;
  out[25] = v14 ? 4 : 2;
  dv.setUint16(94, headerSize, true);
  dv.setUint32(96, headerSize, true);
  dv.setUint8(104, opts.pdrf);
  dv.setUint16(105, recLen, true);
  if (v14) dv.setUint32(107, 0, true);
  else dv.setUint32(107, n, true);
  if (v14) dv.setBigUint64(247, BigInt(n), true);
  for (let k = 0; k < 3; k++) dv.setFloat64(131 + k * 8, 0.01, true);
  // Bounding box max/min per axis: x 100, y 100, z 10 down to 0.
  const mm = [100, 0, 100, 0, 10, 0];
  for (let k = 0; k < 6; k++) dv.setFloat64(179 + k * 8, mm[k], true);
  opts.points.forEach((p, i) => {
    const o = headerSize + i * recLen;
    dv.setInt32(o, 1000 + i * 100, true);
    dv.setInt32(o + 4, 2000 + i * 100, true);
    dv.setInt32(o + 8, 300 + i, true);
    dv.setUint8(o + 14, opts.pdrf === 6 ? 0x11 : 0x09);
    const angle = p.angle ?? 0;
    if (opts.pdrf === 6) {
      dv.setUint8(o + 15, ((p.flags ?? 0) & 0x0f) | (((p.channel ?? 0) & 0x3) << 4));
      dv.setUint8(o + 16, p.cls);
      dv.setInt16(o + 18, Math.round(angle / 0.006), true);
      dv.setFloat64(o + 22, 1000 + i, true);
    } else {
      const f = p.flags ?? 0;
      dv.setUint8(o + 15, (p.cls & 0x1f) | ((f & 1) << 5) | ((f & 2) << 5) | ((f & 4) << 5));
      dv.setInt8(o + 16, Math.round(angle));
      if (opts.pdrf === 3) dv.setFloat64(o + 20, 1000 + i, true);
    }
  });
  return out;
}

export interface RawVlr {
  readonly userId: string;
  readonly recordId: number;
  readonly description: string;
  readonly data: Uint8Array;
}

export interface RawLas {
  readonly version: string;
  readonly pdrf: number;
  readonly count: number;
  /** Class number per point: bits 0 to 4 for formats 0 to 5, the class byte for 6 and up. */
  readonly cls: number[];
  /** Extended-style flags per point: bit 0 synthetic, 1 key-point, 2 withheld, 3 overlap. */
  readonly flags: number[];
  /** Scan angle per point in degrees. */
  readonly angle: number[];
  /** Scanner channel per point (0 for formats without the field). */
  readonly channel: number[];
  readonly vlrs: RawVlr[];
}

function ascii(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

export function readLas(bytes: Uint8Array): RawLas {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = `${dv.getUint8(24)}.${dv.getUint8(25)}`;
  const headerSize = dv.getUint16(94, true);
  const dataStart = dv.getUint32(96, true);
  const vlrCount = dv.getUint32(100, true);
  const pdrf = dv.getUint8(104);
  const recLen = dv.getUint16(105, true);
  const count =
    version === '1.4' ? Number(dv.getBigUint64(247, true)) : dv.getUint32(107, true);
  const vlrs: RawVlr[] = [];
  let p = headerSize;
  for (let i = 0; i < vlrCount; i++) {
    const len = dv.getUint16(p + 20, true);
    vlrs.push({
      userId: ascii(bytes.subarray(p + 2, p + 18)),
      recordId: dv.getUint16(p + 18, true),
      description: ascii(bytes.subarray(p + 22, p + 54)),
      data: bytes.subarray(p + 54, p + 54 + len),
    });
    p += 54 + len;
  }
  const cls: number[] = [];
  const flags: number[] = [];
  const angle: number[] = [];
  const channel: number[] = [];
  for (let i = 0; i < count; i++) {
    const o = dataStart + i * recLen;
    if (pdrf >= 6) {
      const fb = dv.getUint8(o + 15);
      flags.push(fb & 0x0f);
      channel.push((fb >> 4) & 0x3);
      cls.push(dv.getUint8(o + 16));
      angle.push(dv.getInt16(o + 18, true) * 0.006);
    } else {
      const cb = dv.getUint8(o + 15);
      cls.push(cb & 0x1f);
      flags.push(((cb >> 5) & 1) | (((cb >> 6) & 1) << 1) | (((cb >> 7) & 1) << 2));
      channel.push(0);
      angle.push(dv.getInt8(o + 16));
    }
  }
  return { version, pdrf, count, cls, flags, angle, channel, vlrs };
}
