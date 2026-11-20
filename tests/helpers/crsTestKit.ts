/**
 * Shared CRS test helpers: an in-memory override port and GeoKey directory
 * builders and readers.
 */
import type { CrsOverridePort } from '../../src/geo/CrsService';
import type { CrsOverride } from '../../src/geo/CrsOverrideStore';

/** An override port backed by a Map, stamping every record with updatedAt 1. */
export function memoryPort(): CrsOverridePort {
  const entries = new Map<string, CrsOverride>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => { entries.set(key, { ...value, updatedAt: 1 }); },
    clear: (key) => { entries.delete(key); },
  };
}

/** A GeoKeyDirectory payload from [key, value] pairs (all inline shorts). */
export function geoKeyPayload(keys: readonly (readonly [number, number])[]): Uint8Array {
  const u = new Uint16Array(4 + keys.length * 4);
  u.set([1, 1, 0, keys.length]);
  keys.forEach(([k, v], i) => u.set([k, 0, 1, v], 4 + i * 4));
  return new Uint8Array(u.buffer);
}

const GEO_KEY_DIRECTORY = 34735;

/** The GeoKey directory of a little-endian TIFF's first IFD, as a key -> value map. */
export function tiffGeoKeys(bytes: Uint8Array): Map<number, number> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    if (dv.getUint16(p, true) !== GEO_KEY_DIRECTORY) continue;
    const count = dv.getUint32(p + 4, true);
    const off = dv.getUint32(p + 8, true);
    const u16 = Array.from({ length: count }, (_, k) => dv.getUint16(off + k * 2, true));
    const keys = new Map<number, number>();
    for (let k = 0; k < u16[3]; k++) keys.set(u16[4 + k * 4], u16[7 + k * 4]);
    return keys;
  }
  throw new Error('no GeoKey directory');
}
