/**
 * header.ts
 *
 * The fixed 48-byte E57 file header (ASTM E2807). Pure and DOM-free — the
 * whole E57 parser is unit-tested in Node.
 *
 * Every multi-byte field here is an unsigned 64-bit integer read out of a
 * file that may be remote, truncated or damaged, and JavaScript's `number`
 * cannot represent all of them. A value past 2^53 - 1 survives `Number()` as a
 * silently rounded quantity, so each one is range-checked before it leaves
 * this function rather than being trusted downstream.
 */

/** The fields recovered from an E57 file header. */
export interface E57Header {
  versionMajor: number;
  versionMinor: number;
  /** Total file length in bytes, including page checksums. */
  filePhysicalLength: number;
  /** Physical offset of the XML section. */
  xmlPhysicalOffset: number;
  /** Logical (checksum-excluded) length of the XML section. */
  xmlLogicalLength: number;
  /** Page size in bytes; the last 4 bytes of each page are a checksum. */
  pageSize: number;
}

const SIGNATURE = 'ASTM-E57';

/**
 * Page-size bounds. The floor keeps a page large enough to be meaningful at
 * all (the 4-byte checksum plus a usable payload). The ceiling exists because
 * `pageSize` is a declared number that sizes real work: `depage` allocates
 * `pageCount * (pageSize - 4)` bytes, and `physicalToLogical` divides by it.
 * Every E57 in circulation uses 1024 — the value libE57 has always written,
 * and the value both project fixtures carry — so 1 MiB leaves three orders of
 * magnitude of headroom for a hypothetical large-page writer while turning a
 * nonsense declaration into a named refusal instead of a `RangeError` from
 * some allocation deep in the reader.
 */
const MIN_PAGE_SIZE = 64;
const MAX_PAGE_SIZE = 1024 * 1024;

/**
 * Read one of the header's uint64 fields as a JavaScript number, refusing any
 * value that cannot be represented exactly.
 */
function readUint64(view: DataView, offset: number, field: string): number {
  const raw = view.getBigUint64(offset, true);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new Error(
      `E57 file is malformed: ${field} is ${raw}, which is not a value this ` +
        'reader can represent exactly.',
    );
  }
  return value;
}

/**
 * Parse and validate the 48-byte E57 header. Throws on a non-E57 file.
 *
 * `fileBytes` is the length of the file the header came from. It defaults to
 * `buffer.byteLength`, which is what a whole-file caller passes implicitly. The
 * preflight reads the header out of a small HEAD SLICE, where the buffer is
 * shorter than the file by design, so it passes the real file length and the
 * truncation check below keeps its meaning instead of firing on every large
 * file.
 */
export function parseE57Header(buffer: ArrayBuffer, fileBytes = buffer.byteLength): E57Header {
  if (buffer.byteLength < 48) {
    throw new Error('Not an E57 file: shorter than the 48-byte header.');
  }
  const view = new DataView(buffer);
  let signature = '';
  for (let i = 0; i < 8; i++) signature += String.fromCharCode(view.getUint8(i));
  if (signature !== SIGNATURE) {
    throw new Error('Not an E57 file: the "ASTM-E57" signature is missing.');
  }
  const pageSize = readUint64(view, 40, 'the page size');
  if (pageSize < MIN_PAGE_SIZE || pageSize > MAX_PAGE_SIZE) {
    throw new Error(
      `E57 file is malformed: invalid page size ${pageSize} ` +
        `(expected ${MIN_PAGE_SIZE}–${MAX_PAGE_SIZE} bytes).`,
    );
  }

  // The uint64 fields are unsigned on disk, so `readUint64` has already ruled
  // out anything negative; what it cannot rule out is a value larger than the
  // file that declares it. `filePhysicalLength` is the cheapest truncation
  // check this reader has — it is the writer's own statement of how many bytes
  // the file should be, and it counts the paged bytes, checksums and final-page
  // padding included, so a normally padded file matches it exactly. Only a
  // SHORTER-than-declared buffer is refused here: that is unambiguous data
  // loss, whereas trailing extra bytes are left to `depage`, which checksums
  // every page present and will reject junk on its own terms.
  const filePhysicalLength = readUint64(view, 16, 'the file length');
  if (filePhysicalLength > fileBytes) {
    throw new Error(
      `E57 file is truncated: the header declares ${filePhysicalLength} bytes ` +
        `but only ${fileBytes} are present.`,
    );
  }

  return {
    versionMajor: view.getUint32(8, true),
    versionMinor: view.getUint32(12, true),
    filePhysicalLength,
    xmlPhysicalOffset: readUint64(view, 24, 'the XML section offset'),
    xmlLogicalLength: readUint64(view, 32, 'the XML section length'),
    pageSize,
  };
}
