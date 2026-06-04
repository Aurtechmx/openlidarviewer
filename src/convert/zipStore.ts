/**
 * zipStore.ts — a tiny store-only (no compression) ZIP writer.
 *
 * Bundles several converted files into one archive so a batch downloads as a
 * single `.zip`. "Stored" method keeps this dependency-free and fast; point
 * clouds (LAS binary / large ASCII) compress poorly enough that store is a
 * fair default, and the browser/OS can recompress if the user wants.
 *
 * Pure data — no DOM. Deterministic given its inputs (timestamps are fixed).
 */

/** One entry to place in the archive. */
export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

// CRC-32 (IEEE 802.3) — table built once at module load.
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
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Build a store-only ZIP archive from `entries`. Returns the archive bytes. */
export function buildZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const LFH = 30; // local file header fixed size
  const CDH = 46; // central directory header fixed size

  let size = 0;
  const meta = entries.map((e) => {
    const nameBytes = utf8(e.name);
    const crc = crc32(e.bytes);
    const offset = size;
    size += LFH + nameBytes.length + e.bytes.length;
    return { nameBytes, crc, offset, data: e.bytes };
  });

  const centralStart = size;
  let centralSize = 0;
  for (const m of meta) centralSize += CDH + m.nameBytes.length;

  const total = size + centralSize + 22; // + EOCD
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let p = 0;

  // ── Local file headers + data ──────────────────────────────────────────
  for (const m of meta) {
    view.setUint32(p, 0x04034b50, true); // LFH signature
    view.setUint16(p + 4, 20, true); // version needed
    view.setUint16(p + 6, 0x0800, true); // flags: UTF-8 filename
    view.setUint16(p + 8, 0, true); // method: store
    view.setUint16(p + 10, 0, true); // mod time
    view.setUint16(p + 12, 0x21, true); // mod date (1980-01-01)
    view.setUint32(p + 14, m.crc, true);
    view.setUint32(p + 18, m.data.length, true); // compressed size
    view.setUint32(p + 22, m.data.length, true); // uncompressed size
    view.setUint16(p + 26, m.nameBytes.length, true);
    view.setUint16(p + 28, 0, true); // extra length
    out.set(m.nameBytes, p + 30);
    out.set(m.data, p + 30 + m.nameBytes.length);
    p += LFH + m.nameBytes.length + m.data.length;
  }

  // ── Central directory ──────────────────────────────────────────────────
  for (const m of meta) {
    view.setUint32(p, 0x02014b50, true); // CDH signature
    view.setUint16(p + 4, 20, true); // version made by
    view.setUint16(p + 6, 20, true); // version needed
    view.setUint16(p + 8, 0x0800, true); // flags: UTF-8
    view.setUint16(p + 10, 0, true); // method: store
    view.setUint16(p + 12, 0, true);
    view.setUint16(p + 14, 0x21, true);
    view.setUint32(p + 16, m.crc, true);
    view.setUint32(p + 20, m.data.length, true);
    view.setUint32(p + 24, m.data.length, true);
    view.setUint16(p + 28, m.nameBytes.length, true);
    view.setUint16(p + 30, 0, true); // extra
    view.setUint16(p + 32, 0, true); // comment
    view.setUint16(p + 34, 0, true); // disk number
    view.setUint16(p + 36, 0, true); // internal attrs
    view.setUint32(p + 38, 0, true); // external attrs
    view.setUint32(p + 42, m.offset, true); // offset of LFH
    out.set(m.nameBytes, p + 46);
    p += CDH + m.nameBytes.length;
  }

  // ── End of central directory ───────────────────────────────────────────
  view.setUint32(p, 0x06054b50, true);
  view.setUint16(p + 4, 0, true);
  view.setUint16(p + 6, 0, true);
  view.setUint16(p + 8, meta.length, true);
  view.setUint16(p + 10, meta.length, true);
  view.setUint32(p + 12, centralSize, true);
  view.setUint32(p + 16, centralStart, true);
  view.setUint16(p + 20, 0, true);

  return out;
}
