/**
 * storedPng.ts: a tiny PNG encoder for tests. RGBA, 8 bits, no filter, and
 * deflate "stored" blocks (no compression), so it needs no zlib.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1, b = 0;
  for (const x of bytes) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

function u32(v: number): number[] { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(u32(crc32(out.subarray(4, 8 + data.length))), 8 + data.length);
  return out;
}

export async function encodeStoredPng(rgba: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const raw = new Uint8Array(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1);
  const nBlocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + nBlocks * 5 + raw.length + 4);
  z[0] = 0x78; z[1] = 0x01;
  let p = 2;
  for (let k = 0; k < nBlocks; k++) {
    const off = k * 65535;
    const len = Math.min(65535, raw.length - off);
    z[p++] = k === nBlocks - 1 ? 1 : 0;
    z[p++] = len & 255; z[p++] = len >> 8; z[p++] = ~len & 255; z[p++] = (~len >> 8) & 255;
    z.set(raw.subarray(off, off + len), p);
    p += len;
  }
  z.set(u32(adler32(raw)), p);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array([...u32(w), ...u32(h), 8, 6, 0, 0, 0])),
    chunk('IDAT', z),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const part of parts) { out.set(part, o); o += part.length; }
  return out;
}
