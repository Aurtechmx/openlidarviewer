/**
 * pngTextChunks.ts
 *
 * PNG text-chunk metadata writer + reader — the byte-level foundation of
 * figure provenance. A canvas `toBlob('image/png')` produces a PNG with no
 * metadata at all, which means every figure that leaves the app is anonymous:
 * no build, no CRS, no colour mapping, nothing a reviewer can interrogate
 * six months later. The PNG format's own answer is text chunks — `tEXt`
 * (Latin-1) and `iTXt` (UTF-8) — which exiftool, ImageMagick, Python's PIL,
 * and even `strings` all surface. Embedding provenance there keeps the pixel
 * data untouched and the file valid for every consumer.
 *
 * `encodePngTextChunks` splices the entries as chunks immediately BEFORE the
 * IEND terminator (the spec allows text chunks anywhere between IHDR and
 * IEND; last position means the pixel chunks stay byte-identical and
 * streaming decoders never stall on metadata). Each entry rides `tEXt` when
 * its text fits Latin-1 — the chunk's mandated charset — and upgrades to an
 * uncompressed `iTXt` with UTF-8 text when it does not, so no code point is
 * ever silently mangled to fit.
 *
 * CRC-32 (IEEE 802.3, polynomial 0xEDB88320) over chunk type + data is the
 * same algorithm ZIP uses; the table builder below is a deliberate local
 * copy of the one in `src/convert/zipStore.ts`. Importing across the
 * convert/export boundary for ten lines would create a module edge between
 * two independently lazy-loaded subsystems — the repo's leaf-module pattern
 * (cf. `orthoFraming.ts`) prefers the small duplication.
 *
 * Pure bytes in, bytes out: no DOM, no three.js, no I/O. Deterministic.
 */

/** One text-chunk entry: a registered or `olv:`-prefixed keyword + its text. */
export interface PngTextEntry {
  readonly keyword: string;
  readonly text: string;
}

/** The 8-byte PNG file signature every valid PNG starts with. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const;

// CRC-32 (IEEE 802.3) — table built once at module load. Local copy of the
// builder in `src/convert/zipStore.ts` (see module doc for why it is not
// imported); both reproduce the canonical check value
// crc32("123456789") = 0xCBF43926.
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

/** True when every code point fits the Latin-1 range `tEXt` mandates. */
function isLatin1(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) return false;
  }
  return true;
}

/** Encode a Latin-1 string byte-per-char (caller guarantees the range). */
function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Decode Latin-1 bytes back to a string (exact inverse of latin1Bytes). */
function latin1String(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

/**
 * Validate a chunk keyword against the PNG spec's rules: 1–79 bytes of
 * printable Latin-1 (32–126 or 161–255), no leading/trailing spaces. A bad
 * keyword would produce a chunk strict decoders reject, so it throws loudly
 * at write time instead of shipping a corrupt file.
 */
function assertValidKeyword(keyword: string): void {
  if (keyword.length === 0 || keyword.length > 79) {
    throw new Error(
      `encodePngTextChunks: keyword must be 1-79 characters, got ${keyword.length}`,
    );
  }
  if (keyword.startsWith(' ') || keyword.endsWith(' ')) {
    throw new Error(`encodePngTextChunks: keyword "${keyword}" has a leading/trailing space`);
  }
  for (let i = 0; i < keyword.length; i++) {
    const c = keyword.charCodeAt(i);
    const printable = (c >= 32 && c <= 126) || (c >= 161 && c <= 255);
    if (!printable) {
      throw new Error(
        `encodePngTextChunks: keyword "${keyword}" contains a non-printable or non-Latin-1 character (code ${c})`,
      );
    }
  }
}

/** Frame a chunk: 4-byte big-endian length + type + data + CRC(type+data). */
function frameChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = latin1Bytes(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crcInput = out.subarray(4, 8 + data.length);
  view.setUint32(8 + data.length, crc32(crcInput));
  return out;
}

/** Build the chunk for one entry — `tEXt` when Latin-1 suffices, else `iTXt`. */
function chunkForEntry(entry: PngTextEntry): Uint8Array {
  assertValidKeyword(entry.keyword);
  const keyword = latin1Bytes(entry.keyword);
  if (isLatin1(entry.text)) {
    // tEXt layout: keyword, NUL, Latin-1 text.
    const data = new Uint8Array(keyword.length + 1 + entry.text.length);
    data.set(keyword, 0);
    data.set(latin1Bytes(entry.text), keyword.length + 1);
    return frameChunk('tEXt', data);
  }
  // iTXt layout: keyword, NUL, compression flag (0 = uncompressed),
  // compression method (0), language tag ('' + NUL), translated keyword
  // ('' + NUL), UTF-8 text. Compression is deliberately never used —
  // provenance strings are tiny and an uncompressed chunk stays readable
  // to the widest set of tools.
  const text = new TextEncoder().encode(entry.text);
  const data = new Uint8Array(keyword.length + 5 + text.length);
  data.set(keyword, 0);
  // bytes [keyword.length .. keyword.length+4] are already 0: keyword NUL,
  // compression flag, compression method, empty language NUL, empty
  // translated-keyword NUL.
  data.set(text, keyword.length + 5);
  return frameChunk('iTXt', data);
}

/** Assert the PNG signature and return the byte offset of the IEND chunk. */
function findIend(png: Uint8Array): number {
  if (png.length < 20) throw new Error('pngTextChunks: input too short to be a PNG');
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (png[i] !== PNG_SIGNATURE[i]) {
      throw new Error('pngTextChunks: input does not carry the PNG signature');
    }
  }
  // Walk the chunk list; each iteration trusts only the length field, which
  // is what an actual PNG decoder does. Landing exactly on IEND proves the
  // walk stayed aligned.
  let off = 8;
  while (off + 8 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + off);
    const len = view.getUint32(0);
    const type = latin1String(png.subarray(off + 4, off + 8));
    if (type === 'IEND') return off;
    off += 12 + len;
  }
  throw new Error('pngTextChunks: no IEND chunk found — truncated or corrupt PNG');
}

/**
 * Splice the given text entries as `tEXt` / `iTXt` chunks immediately before
 * the PNG's IEND terminator. Returns a NEW byte array; the input is never
 * mutated. Entries keep their order. An empty entry list returns the input
 * unchanged (no pointless copy — callers can compare identity).
 *
 * @throws when the input is not a PNG, has no IEND, or a keyword violates
 *   the PNG spec — shipping a silently-corrupt figure is worse than failing.
 */
export function encodePngTextChunks(
  png: Uint8Array,
  entries: readonly PngTextEntry[],
): Uint8Array {
  const iend = findIend(png);
  if (entries.length === 0) return png;
  const chunks = entries.map(chunkForEntry);
  let extra = 0;
  for (const c of chunks) extra += c.length;
  const out = new Uint8Array(png.length + extra);
  out.set(png.subarray(0, iend), 0);
  let off = iend;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  out.set(png.subarray(iend), off);
  return out;
}

/**
 * Read every `tEXt` / `iTXt` text entry out of a PNG, in file order — the
 * verification half of the round-trip. Compressed `iTXt` payloads (flag 1)
 * are skipped rather than mis-decoded: this writer never emits them, and
 * inflating third-party chunks is out of scope for a provenance reader.
 *
 * @throws when the input is not a PNG or a text chunk's stored CRC does not
 *   match its bytes — corrupt provenance must surface, not silently return
 *   mangled text.
 */
export function readPngTextChunks(png: Uint8Array): PngTextEntry[] {
  findIend(png); // signature + structure gate — throws on a non-PNG
  const entries: PngTextEntry[] = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + off);
    const len = view.getUint32(0);
    const type = latin1String(png.subarray(off + 4, off + 8));
    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'iTXt') {
      const data = png.subarray(off + 8, off + 8 + len);
      const stored = new DataView(
        png.buffer,
        png.byteOffset + off + 8 + len,
      ).getUint32(0);
      const actual = crc32(png.subarray(off + 4, off + 8 + len));
      if (stored !== actual) {
        throw new Error(
          `readPngTextChunks: ${type} chunk CRC mismatch (stored ${stored.toString(16)}, computed ${actual.toString(16)})`,
        );
      }
      const nul = data.indexOf(0);
      if (nul > 0) {
        const keyword = latin1String(data.subarray(0, nul));
        if (type === 'tEXt') {
          entries.push({ keyword, text: latin1String(data.subarray(nul + 1)) });
        } else {
          const compressionFlag = data[nul + 1];
          if (compressionFlag === 0) {
            // Skip compression method, then the two NUL-terminated fields
            // (language tag, translated keyword) before the UTF-8 text.
            let p = nul + 3;
            while (p < data.length && data[p] !== 0) p++;
            p++; // language NUL
            while (p < data.length && data[p] !== 0) p++;
            p++; // translated-keyword NUL
            entries.push({ keyword, text: new TextDecoder().decode(data.subarray(p)) });
          }
        }
      }
    }
    off += 12 + len;
  }
  return entries;
}
