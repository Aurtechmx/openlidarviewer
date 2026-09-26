/**
 * terrainCorePayload.ts
 *
 * The persisted representation of a {@link TerrainCore}: one byte payload a
 * store can write, digest and read back into a core that is scientifically
 * indistinguishable from the computed one.
 *
 * Layout: a little-endian u32 header length, a UTF-8 JSON header, then every
 * typed array of the core in header order. Nothing else is stored. The header holds the record (the
 * core with each typed array replaced by a marker), the array layout (kind and
 * byte length, in order) and the payload format version. Non-finite numbers
 * cannot ride plain JSON, so they are encoded as markers too; a core carrying
 * anything the codec does not model (a Map, a class instance, a function) is
 * refused rather than approximated, and the caller keeps the core in memory
 * only.
 */
import type { TerrainCore } from './analyseContours';

/**
 * Bumped when the layout, the markers or the core's fields change so older
 * payloads miss. 2: the DTM grid carries verticalDispersion (terrain evidence
 * band 5); a version-1 core lacks it and would export that band as NoData.
 */
export const TERRAIN_CORE_PAYLOAD_VERSION = 2;

type GridKind = 'f32' | 'f64' | 'u8' | 'u8c' | 'u16' | 'u32' | 'i8' | 'i16' | 'i32';

const CTOR: Record<GridKind, new (buffer: ArrayBuffer) => ArrayBufferView> = {
  f32: Float32Array, f64: Float64Array, u8: Uint8Array, u8c: Uint8ClampedArray,
  u16: Uint16Array, u32: Uint32Array, i8: Int8Array, i16: Int16Array, i32: Int32Array,
};

function kindOf(v: ArrayBufferView): GridKind | null {
  if (v instanceof Float32Array) return 'f32';
  if (v instanceof Float64Array) return 'f64';
  if (v instanceof Uint8ClampedArray) return 'u8c';
  if (v instanceof Uint8Array) return 'u8';
  if (v instanceof Uint16Array) return 'u16';
  if (v instanceof Uint32Array) return 'u32';
  if (v instanceof Int8Array) return 'i8';
  if (v instanceof Int16Array) return 'i16';
  if (v instanceof Int32Array) return 'i32';
  return null;
}

interface Layout { readonly kind: GridKind; readonly bytes: number }
interface Header { readonly format: number; readonly layout: Layout[]; readonly record: unknown }

const MARK = '$olvCore';

function nonFiniteMark(n: number): string {
  if (Number.isNaN(n)) return 'nan';
  return n > 0 ? '+inf' : '-inf';
}

/** True for a value JSON can carry as is, or that the markers cover. */
function isPlain(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return typeof v !== 'function' && typeof v !== 'symbol' && typeof v !== 'bigint';
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return true;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Encode a core, or return null when it holds something the codec does not
 * model. Every typed array is copied out in the order the header lists it.
 */
export function encodeTerrainCore(core: TerrainCore): Uint8Array | null {
  const grids: ArrayBufferView[] = [];
  const layout: Layout[] = [];
  let refused = false;
  const record = JSON.stringify(core, function (this: unknown, key: string, value: unknown) {
    // `this[key]` is the raw value before any toJSON; JSON only hands `value`.
    const raw = this !== null && typeof this === 'object' ? (this as Record<string, unknown>)[key] : value;
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      return { [MARK]: nonFiniteMark(raw) };
    }
    if (ArrayBuffer.isView(raw)) {
      const kind = kindOf(raw);
      if (!kind) { refused = true; return undefined; }
      layout.push({ kind, bytes: raw.byteLength });
      grids.push(raw);
      return { [MARK]: 'grid', i: grids.length - 1 };
    }
    if (!isPlain(raw)) { refused = true; return undefined; }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && MARK in (raw as object)) {
      refused = true; // a record that already carries the marker cannot round-trip
      return undefined;
    }
    return value;
  });
  if (refused) return null;
  const header = new TextEncoder().encode(
    JSON.stringify({ format: TERRAIN_CORE_PAYLOAD_VERSION, layout, record: JSON.parse(record) } satisfies Header),
  );
  const total = layout.reduce((n, l) => n + l.bytes, 0);
  const out = new Uint8Array(4 + header.byteLength + total);
  new DataView(out.buffer).setUint32(0, header.byteLength, true);
  out.set(header, 4);
  let o = 4 + header.byteLength;
  for (const g of grids) {
    out.set(new Uint8Array(g.buffer, g.byteOffset, g.byteLength), o);
    o += g.byteLength;
  }
  return out;
}

/** Why a payload did not decode. */
export type DecodeFailure = 'format-mismatch' | 'malformed';

/**
 * Decode a payload written by {@link encodeTerrainCore}. Every typed array is
 * rebuilt on its own fresh buffer, so the restored core owns its memory the
 * way a computed one does.
 */
export function decodeTerrainCore(bytes: Uint8Array): { core: TerrainCore } | { failure: DecodeFailure } {
  try {
    if (bytes.byteLength < 4) return { failure: 'malformed' };
    const hlen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
    if (4 + hlen > bytes.byteLength) return { failure: 'malformed' };
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + hlen))) as Header;
    if (header.format !== TERRAIN_CORE_PAYLOAD_VERSION) return { failure: 'format-mismatch' };
    const grids: ArrayBufferView[] = [];
    let o = 4 + hlen;
    for (const item of header.layout) {
      if (o + item.bytes > bytes.byteLength || !(item.kind in CTOR)) return { failure: 'malformed' };
      const buf = new ArrayBuffer(item.bytes);
      new Uint8Array(buf).set(bytes.subarray(o, o + item.bytes));
      grids.push(new CTOR[item.kind](buf));
      o += item.bytes;
    }
    if (o !== bytes.byteLength) return { failure: 'malformed' };
    let bad = false;
    const core = JSON.parse(JSON.stringify(header.record), (_key, value: unknown) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value) && MARK in (value as object)) {
        const m = (value as { [MARK]: string; i?: number });
        switch (m[MARK]) {
          case 'nan': return Number.NaN;
          case '+inf': return Number.POSITIVE_INFINITY;
          case '-inf': return Number.NEGATIVE_INFINITY;
          case 'grid': {
            const g = typeof m.i === 'number' ? grids[m.i] : undefined;
            if (!g) { bad = true; return null; }
            return g;
          }
          default: bad = true; return null;
        }
      }
      return value;
    }) as TerrainCore;
    return bad ? { failure: 'malformed' } : { core };
  } catch {
    return { failure: 'malformed' };
  }
}
