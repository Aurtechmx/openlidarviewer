/**
 * depage.ts
 *
 * An E57 file stores everything in fixed-size pages; the last 4 bytes of each
 * page are a CRC-32C checksum over that page's preceding `pageSize - 4` bytes.
 * "De-paging" verifies those checksums and strips them into one contiguous
 * logical buffer, so the XML and binary sections can then be read with plain
 * logical offsets. Pure and DOM-free.
 *
 * WHY VERIFY, NOT MERELY STRIP. Every other guard in this reader catches
 * STRUCTURAL breakage — a wrong signature, a section-type byte that isn't 1, a
 * record count that isn't a safe integer, a bytestream too short for the
 * records it claims. None of them can see a single flipped bit inside a
 * Float64 X/Y/Z bytestream: that decodes to a plausible coordinate, and then
 * measures, exports and appears in a survey report as though it were real.
 * E57 is the one format this viewer reads that carries a per-page checksum —
 * the v0.6.0 notes state the contrast honestly for LAZ, which carries none, so
 * plausible-but-wrong LAZ data cannot be detected at all — which is why
 * discarding the one integrity signal that does exist was worth closing.
 * `docs/v0.5.7-plan.md` already called for it ("CRC validation also lets us
 * fail honestly on a genuinely corrupt file rather than mis-reading it"); only
 * the stripping half shipped.
 *
 * CHECKSUM VARIANT AND COVERAGE, exactly. For each page the stored value is
 * CRC-32C (Castagnoli — see `crc32c.ts`) computed over that page's first
 * `pageSize - 4` bytes, and stored in the page's final 4 bytes in BIG-ENDIAN
 * order, most significant byte first. Page 0's covered range includes the
 * 48-byte file header. The byte order is not assumed: it was read off
 * `tests/pumpARowColumnIndexNoInvalidPoints.e57`, a genuine libE57-written
 * file, where all 2536 pages match when the trailing 4 bytes are read
 * big-endian and none match when they are read little-endian. libE57 verifies
 * these checksums when it reads, so a file any mainstream tool can open must
 * already follow libE57's on-disk convention.
 *
 * PARTIAL FINAL PAGE — the decision, and why. A file whose byte length is not
 * a whole number of pages is REFUSED as truncated. It is not exempted from
 * verification, and it is not checksummed over its actual (short) bytes.
 * Neither alternative is honest: the stored value covers exactly
 * `pageSize - 4` bytes and lives in the 4 bytes immediately after them, so on
 * a short page those inputs are partly or wholly absent — a CRC over the
 * surviving bytes would be a checksum of a different range and could never
 * match anything, and skipping the page would smuggle an unverified tail
 * through a function whose purpose is now to vouch for the bytes it returns.
 * ASTM E2807 defines an E57 file as an integral number of pages, so a short
 * page means bytes are missing, which is exactly the condition worth naming.
 *
 * That is a different thing from a file whose CONTENT ends mid-page, which is
 * the ordinary case: writers pad the final page out to `pageSize` and
 * checksum the padding along with the content. Such a file is fully verified
 * and accepted like any other, and both project fixtures end that way.
 */

import { crc32c } from './crc32c';

/** The result of de-paging an E57 file. */
export interface Depaged {
  /** The checksum-verified, checksum-stripped logical bytes. */
  logical: Uint8Array;
  /** Logical bytes carried by each page (`pageSize - 4`). */
  pagePayload: number;
}

/**
 * Verify every page's CRC-32C and strip it into one contiguous logical buffer.
 *
 * Every page is checked; there is no sampling or skip mode. A partially
 * checked file could only ever be described as unverified, which is worth no
 * more than the state this replaces, and the cost does not justify that
 * ambiguity: the pass is one table-driven byte loop (~300 MB/s) over bytes
 * this function already copies.
 *
 * `fileBytes` bounds the run at the length the file's own header declares,
 * defaulting to the whole buffer. Content past that point is not part of the
 * file the header describes, so it is left out of the logical buffer and every
 * offset resolved against it (see `parseE57`).
 *
 * @throws when the file is not a whole number of pages (truncated), or when a
 *   page's stored checksum does not match its bytes. The error names the page
 *   index so a corrupt region can be located in the file.
 */
export function depage(buffer: ArrayBuffer, pageSize: number, fileBytes?: number): Depaged {
  const payload = pageSize - 4;
  const bound = fileBytes ?? buffer.byteLength;
  if (!Number.isSafeInteger(bound) || bound < 0 || bound > buffer.byteLength) {
    throw new Error(
      `E57 file is truncated: the header declares ${bound} bytes but only ` +
        `${buffer.byteLength} are present.`,
    );
  }
  const src = new Uint8Array(buffer, 0, bound);
  if (src.length % pageSize !== 0) {
    throw new Error(
      `E57 file is truncated: ${src.length} bytes is not a whole number of ` +
        `${pageSize}-byte pages (${src.length % pageSize} bytes past the last ` +
        'complete page). A short final page carries no verifiable checksum, ' +
        'so the file is refused rather than read unverified.',
    );
  }
  const pageCount = src.length / pageSize;
  return { logical: depagePages(src, pageSize, 0, pageCount), pagePayload: payload };
}

/**
 * Verify and strip the checksums from a page-aligned RUN of pages, rather than
 * the whole file.
 *
 * `pages` must begin on a page boundary and hold a whole number of pages;
 * `firstPageIndex` is the file page it starts at and `totalPageCount` the file's
 * page total, so a checksum failure still names the page by its position in the
 * FILE and not in the run.
 *
 * This exists for the E57 preflight, which needs only the XML section — a few
 * KB near the end of the file. De-paging the whole file to reach it costs a
 * second full-size copy of the file and a CRC pass over every byte, which is
 * precisely the work the preflight exists to decide whether to do at all.
 * Verification is not weakened: every page this run returns is checked, and the
 * whole-file `depage` still checks every page before any point is decoded.
 */
export function depagePages(
  pages: Uint8Array,
  pageSize: number,
  firstPageIndex: number,
  totalPageCount: number,
): Uint8Array {
  const payload = pageSize - 4;
  if (pages.length % pageSize !== 0) {
    throw new Error(
      `E57 file is truncated: a ${pages.length}-byte page run is not a whole ` +
        `number of ${pageSize}-byte pages.`,
    );
  }
  const runCount = pages.length / pageSize;
  const logical = new Uint8Array(runCount * payload);
  const view = new DataView(pages.buffer, pages.byteOffset, pages.byteLength);
  for (let p = 0; p < runCount; p++) {
    const start = p * pageSize;
    const computed = crc32c(pages, start, start + payload);
    const stored = view.getUint32(start + payload, false);
    if (stored !== computed) {
      throw new Error(
        `E57 file is corrupt: page ${firstPageIndex + p} of ${totalPageCount} ` +
          `failed its CRC-32C checksum (stored 0x${stored.toString(16).padStart(8, '0')}, ` +
          `computed 0x${computed.toString(16).padStart(8, '0')}). ` +
          'Refusing the file rather than reading damaged point data.',
      );
    }
    logical.set(pages.subarray(start, start + payload), p * payload);
  }
  return logical;
}

/**
 * Convert a physical file offset to the equivalent offset into the de-paged
 * logical buffer (each page contributes `pageSize - 4` logical bytes).
 */
export function physicalToLogical(physical: number, pageSize: number): number {
  const payload = pageSize - 4;
  // A physical offset that lands in a page's last 4 bytes points at the CRC-32C
  // trailer, not payload — and the mapping below would alias it onto the next
  // page's first logical byte (e.g. physical 1020 and 1024 both → logical 1020
  // for pageSize 1024). Two file positions collapsing to one logical byte lets
  // a corrupt section offset inside a checksum be read as adjacent-page data, so
  // reject it here rather than resolve the ambiguity silently (M7).
  const withinPage = physical % pageSize;
  if (withinPage >= payload) {
    throw new Error(`E57: physical offset ${physical} points into a page checksum, not payload.`);
  }
  return Math.floor(physical / pageSize) * payload + withinPage;
}
