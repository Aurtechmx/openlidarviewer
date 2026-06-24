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

// ── Format limits of the classic (no-ZIP64) store format ──────────────────────
// Every size / offset field below is 32-bit and the entry count is 16-bit;
// exceeding any of these would silently wrap and corrupt the archive, so we
// refuse rather than emit a broken ZIP.
/** Max bytes in a single entry (32-bit compressed/uncompressed size field). */
export const ZIP_MAX_ENTRY_BYTES = 0xffffffff;
/** Max number of entries (16-bit count in the end-of-central-directory record). */
export const ZIP_MAX_ENTRIES = 0xffff;
/** Max total archive size (32-bit central-directory offset + EOCD fields). */
export const ZIP_MAX_TOTAL_BYTES = 0xffffffff;
/**
 * Memory-safety ceiling for OFFERING a single in-memory ZIP. The whole archive
 * is assembled into one `Uint8Array` while the source outputs are still held, so
 * the peak is ~2× this — kept well under both the 4 GiB format limit and the
 * engine's typed-array maximum. Past this, the caller falls back to per-file
 * downloads instead of building one giant buffer.
 */
export const ZIP_SAFE_TOTAL_BYTES = 1.5 * 1024 * 1024 * 1024;

/** The size + safety verdict for a would-be archive of `entries`. */
export interface ZipAssessment {
  /** True when a single in-memory ZIP is safe to build and offer. */
  readonly ok: boolean;
  readonly entryCount: number;
  /** Estimated built-archive size in bytes. */
  readonly totalBytes: number;
  /** Plain-language reason the ZIP isn't offered (present only when `ok` is false). */
  readonly reason?: string;
}

/** Estimated built size of one store entry (header + name + data + central record). */
function entrySize(e: ZipEntry): number {
  // Name byte length ≈ its UTF-8 length; for the threshold (GiB-scale) the
  // exact figure is immaterial, so the cheap char count is fine.
  return 30 + e.name.length + e.bytes.length + 46 + e.name.length;
}

/**
 * Decide whether a single in-memory ZIP of `entries` is safe to build, and why
 * not when it isn't. Pure and allocation-free — reads only lengths — so it is
 * cheap to call before assembling anything. When `ok` is false the caller should
 * offer the files individually instead of one archive.
 */
export function assessZipDownload(entries: ReadonlyArray<ZipEntry>): ZipAssessment {
  const entryCount = entries.length;
  let totalBytes = 22; // end-of-central-directory record
  let maxEntryBytes = 0;
  for (const e of entries) {
    totalBytes += entrySize(e);
    if (e.bytes.length > maxEntryBytes) maxEntryBytes = e.bytes.length;
  }
  if (entryCount > ZIP_MAX_ENTRIES) {
    return { ok: false, entryCount, totalBytes, reason: `${entryCount.toLocaleString('en-US')} files exceeds the ${ZIP_MAX_ENTRIES.toLocaleString('en-US')}-file ZIP limit` };
  }
  if (maxEntryBytes > ZIP_MAX_ENTRY_BYTES) {
    return { ok: false, entryCount, totalBytes, reason: 'a single file exceeds the 4 GiB ZIP limit' };
  }
  if (totalBytes > ZIP_SAFE_TOTAL_BYTES) {
    return { ok: false, entryCount, totalBytes, reason: `the combined ${(totalBytes / (1024 ** 3)).toFixed(1)} GiB is too large to zip in memory` };
  }
  return { ok: true, entryCount, totalBytes };
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

/**
 * Build a store-only ZIP archive from `entries`. Returns the archive bytes.
 *
 * @throws if the inputs would overflow a 32-bit size/offset field or the 16-bit
 *   entry count — emitting a silently-corrupt archive is worse than failing, so
 *   the limits are enforced here. Callers that face large batches should call
 *   {@link assessZipDownload} first and fall back to per-file downloads.
 */
export function buildZip(entries: ReadonlyArray<ZipEntry>): Uint8Array {
  const LFH = 30; // local file header fixed size
  const CDH = 46; // central directory header fixed size

  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error(
      `Cannot build a ZIP of ${entries.length.toLocaleString('en-US')} files — the format allows at most ${ZIP_MAX_ENTRIES.toLocaleString('en-US')}.`,
    );
  }

  let size = 0;
  const meta = entries.map((e) => {
    if (e.bytes.length > ZIP_MAX_ENTRY_BYTES) {
      throw new Error(`Cannot ZIP "${e.name}": it exceeds the 4 GiB per-file ZIP limit.`);
    }
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
  if (total > ZIP_MAX_TOTAL_BYTES) {
    throw new Error('Cannot build the ZIP: the combined archive would exceed the 4 GiB ZIP limit.');
  }
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
